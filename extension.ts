// SPDX-License-Identifier: GPL-3.0-only
// pi-model-agency — on-demand model/context awareness and session-local control.
// Canonical source: ~/agent/projects/pi-model-agency/extension.ts (symlinked here).
// Design + audit evidence: projects/pi-model-agency/DESIGN.md.
// Principles: pull-not-push (no recurring prompt telemetry), scoped-set-is-the-boundary,
// honest receipts (requested != applied), unknown stays unknown.
import type { ContextUsage, ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Mutable scheduling/receipt state (compactState, reloadState, pendingCompact,
// compactInFlight, pendingReload) and its two renderers (compactLine/reloadLine) are
// declared INSIDE the default-export factory (v0.1.5) so every module instance owns
// its own — the loader can hold more than one instance of this module across a
// reload while old call frames finish, and shared module globals would cross-
// contaminate receipts between instances. Pure helpers stay module-level.

// Feature toggles, two layers (v0.2):
//   1. env-only kill switches — immutable, ALWAYS win (checked at ACTION time:
//      tools stay registered and answer with a disabled error instead of
//      vanishing, so the caller learns why):
//   PI_AGENCY_DISABLE_SWITCH=1    — disable agency_control switch_model
//   PI_AGENCY_DISABLE_COMPACT=1   — disable agency_control compact
//   PI_AGENCY_DISABLE_RELOAD=1    — disable agency_control reload + /agency reload
//   PI_AGENCY_DISABLE_THINKING=1  — disable agency_control set_thinking
//   PI_AGENCY_DISABLE_STATUS=1    — disable agency_status (action-time error)
//   PI_AGENCY_DISABLE_MODELS=1    — disable agency_models (action-time error)
//   PI_AGENCY_DISABLE_USAGE=1     — disable agency_status section='usage' ONLY
//   PI_AGENCY_READ_ONLY=1         — block ALL mutations (every agency_control
//                                   action + the /agency reload command)
//   (env-only; pi 0.86.1's extension CLI flags consume the following argument,
//   so --flags break `pi -p` runs — no CLI flags by design.)
//   2. session-local toggles via the single public `/agency` command
//      (`/agency enable|disable <feature>`, `/agency config`) — factory-scoped
//      state persisted with pi.appendEntry("agency-config", {version:1,
//      disabled:[...], readOnly}) and restored from the session BRANCH on
//      session_start (startup/new/resume/fork/reload; last valid entry wins,
//      corrupt data skipped). A session toggle can add a disable but can NEVER
//      lift an env kill switch; guards check the effective state at BOTH
//      schedule and fire time.
// agency_status always reports the effective toggle states (even in its own
// disabled error). Awareness reads are never blocked by read_only.
const envFlag = (name: string): boolean => /^(1|true|yes)$/i.test(process.env[name] ?? "");

function togglesLine(): string {
  const st = (name: string) => `${name}=${envFlag(name) ? "on" : "off"}`;
  return `toggles: ${[
    st("PI_AGENCY_DISABLE_SWITCH"),
    st("PI_AGENCY_DISABLE_COMPACT"),
    st("PI_AGENCY_DISABLE_RELOAD"),
    st("PI_AGENCY_DISABLE_THINKING"),
    st("PI_AGENCY_DISABLE_STATUS"),
    st("PI_AGENCY_DISABLE_MODELS"),
    st("PI_AGENCY_DISABLE_USAGE"),
    st("PI_AGENCY_READ_ONLY"),
  ].join(" ")}`;
}

// Toggleable feature registry — the /agency enable|disable surface. Each maps to
// its immutable env kill switch; "read_only" is special (its enable = block
// mutations) and is persisted as a separate boolean, never inside disabled[].
const FEATURE_NAMES = ["status", "models", "usage", "switch", "thinking", "compact", "reload", "read_only"] as const;
type FeatureName = (typeof FEATURE_NAMES)[number];
const ENV_BY_FEATURE: Record<FeatureName, string> = {
  status: "PI_AGENCY_DISABLE_STATUS",
  models: "PI_AGENCY_DISABLE_MODELS",
  usage: "PI_AGENCY_DISABLE_USAGE",
  switch: "PI_AGENCY_DISABLE_SWITCH",
  thinking: "PI_AGENCY_DISABLE_THINKING",
  compact: "PI_AGENCY_DISABLE_COMPACT",
  reload: "PI_AGENCY_DISABLE_RELOAD",
  read_only: "PI_AGENCY_READ_ONLY",
};
const isFeatureName = (v: string): v is FeatureName => (FEATURE_NAMES as readonly string[]).includes(v);
// Validate an agency-config entry's data (untrusted — it rides in a session file):
// exact version 1, disabled must be an array filtered to known non-read_only
// feature names (deduped, non-strings dropped), readOnly strictly true. Anything
// corrupt returns null and is skipped on restore — the last VALID entry wins.
function parseConfigEntry(data: unknown): { disabled: FeatureName[]; readOnly: boolean } | null {
  if (data === null || typeof data !== "object") return null;
  const d = data as { version?: unknown; disabled?: unknown; readOnly?: unknown };
  if (d.version !== 1 || !Array.isArray(d.disabled)) return null;
  const disabled: FeatureName[] = [];
  for (const v of d.disabled)
    if (typeof v === "string" && isFeatureName(v) && v !== "read_only" && !disabled.includes(v)) disabled.push(v);
  return { disabled, readOnly: d.readOnly === true };
}

// Runtime-valid thinking levels — mirrors pi-agent-core's ThinkingLevel union
// ("off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"; the package does not
// re-export the type, so it is mirrored here and validated at runtime).
// isThinkingLevel narrows to that union, so pi.setThinkingLevel receives a
// typed level — no arbitrary cast (v0.1.4).
const THINKING_LEVELS = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const isThinkingLevel = (v: string): v is "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" =>
  THINKING_LEVELS.has(v);

// Handoff notes ride inside the compaction summary request; keep them bounded
// so a bloated note cannot bloat the compact payload (v0.1.4).
const HANDOFF_MAX_BYTES = 8192;

const ctxText = (u: ContextUsage | undefined): string => {
  if (!u) return "unknown (no estimate yet — right after startup/compaction)";
  const pct = u.percent === null || u.percent === undefined ? "unknown" : `${u.percent.toFixed(0)}%`;
  const tok = u.tokens === null || u.tokens === undefined ? "unknown" : `${u.tokens}`;
  return `~${tok} / ${u.contextWindow} tokens (~${pct}) — Pi estimate, not exact`;
};

// Untrusted-input echo bound (v0.1.5): any caller-supplied value echoed into tool
// output — error receipts especially — is clipped to ECHO_MAX chars so secrets or
// unbounded payloads never ride back out to the LLM or logs.
const ECHO_MAX = 100;
const clip = (s: string): string => (s.length > ECHO_MAX ? `${s.slice(0, ECHO_MAX)}…(clipped from ${s.length} chars)` : s);

const modelLine = (m: any): string =>
  m
    ? `${clip(String(m.provider ?? "?"))}/${clip(String(m.id ?? "?"))} (ctx ${m.contextWindow ?? "?"}, maxTokens ${m.maxTokens ?? "?"}, reasoning ${m.reasoning ? "yes" : "no"})`
    : "none";

// Session token/cost totals from session entries (provider-reported usage).
// Covers this session file/branch; not billing; cost only when providers report it.
function usageText(ctx: ExtensionContext): string {
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, hasCost: false, msgs: 0 };
  for (const e of ctx.sessionManager.getEntries()) {
    const u = (e as any).message?.usage ?? ((e as any).type === "usage" ? (e as any).usage : undefined);
    if (!u) continue;
    t.input += u.input ?? 0;
    t.output += u.output ?? 0;
    t.cacheRead += u.cacheRead ?? 0;
    t.cacheWrite += u.cacheWrite ?? 0;
    if (u.cost) {
      t.hasCost = true;
      t.cost += (u.cost.input ?? 0) + (u.cost.output ?? 0) + (u.cost.cacheRead ?? 0) + (u.cost.cacheWrite ?? 0);
    }
    t.msgs++;
  }
  const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`);
  return [
    `input ${k(t.input)} · output ${k(t.output)} · cacheRead ${k(t.cacheRead)} · cacheWrite ${k(t.cacheWrite)} (over ${t.msgs} usage-bearing entries)`,
    `cost: ${t.hasCost ? `~$${t.cost.toFixed(4)} (provider-reported estimate — NOT billing; subscription/local models ≈ $0)` : "unknown (no provider-reported cost in this session)"}`,
  ].join("\n");
}

export default function (pi: ExtensionAPI): void {
  type CompactState = { status: "idle" | "pending" | "ok" | "native" | "failed"; at?: string; note?: string };
  const compactState: CompactState = { status: "idle" };

  // Reload state (v0.1.3). Same honest-receipts discipline: scheduled != fired != completed.
  // State is WIPED by reload itself (fresh module instances: reload() →
  // clearExtensionCache(), verified against pi 0.86.1 loader.js) — and being factory-
  // scoped, a second live instance never sees it either. No durability entry is
  // written before reloading — a persistent session receipt could be confused with a
  // stale attempt on a later, different reload. Instead, session_start(reason "reload")
  // on the fresh instance records "completed" with the CURRENT timestamp: the runtime
  // emitting that event IS the completion evidence. The initiator (agency-scheduled vs
  // manual) is not tracked.
  type ReloadState = { status: "idle" | "scheduled" | "fired" | "completed" | "failed"; at?: string; note?: string };
  const reloadState: ReloadState = { status: "idle" };

  // Deferred compaction (v0.1.2). ctx.compact() maps to AgentSession.compact(), whose
  // first statement is `await this.abort()` — by design it aborts the ACTIVE agent
  // turn: sibling tool calls in the same parallel batch that have not started finalize
  // as isError "Operation aborted", the run's remaining turns are cancelled ("manual
  // compaction never retries or continues the interrupted agent turn"), and the TUI
  // prints a red "Error: operation aborted" right before the compaction itself
  // succeeds. Calling it from inside a tool therefore aborts the very turn that
  // requested it. Fix: schedule here, fire at agent_settled — the first boundary
  // where the session is idle and abort() is a no-op (pi 0.86.1 agent-session.js
  // compact(): `await this.abort()` first; abort(): waitForIdle()).
  let pendingCompact: { handoff?: string } | null = null;
  // True between an agency-fired ctx.compact() and its completion event — lets
  // session_compact attribute the completion honestly (v0.1.4): ours → ok,
  // native-beats-our-schedule → failed/unverified, native with no request → native.
  let compactInFlight = false;

  // Deferred reload (v0.1.3). ctx.reload() exists ONLY on ExtensionCommandContext —
  // tools and event handlers get ExtensionContext (pi 0.86.1 types.d.ts:291), so the
  // documented path is: tool queues a registered command as a user message; the command
  // handler awaits ctx.reload(). But pi 0.86.1's prompt() dispatches extension commands
  // IMMEDIATELY when expandPromptTemplates is set — even mid-stream — and dispatches happen
  // before queueing, while queueing a raw "/cmd" as followUp text THROWS
  // (_throwIfExtensionCommand). So a tool calling sendUserMessage mid-run would fire
  // ctx.reload() inside the active agent run; reload's teardown aborts it (same class of
  // mid-turn abort as the v0.1.2 compact bug). Fix: schedule here, fire at agent_settled —
  // the session is idle, the command dispatches immediately with no LLM turn, and the
  // reload aborts nothing. sendUserMessage is NOT awaited inside agent_settled: the
  // dispatch of /agency reload starts synchronously inside this handler (prompt() runs
  // _tryExecuteExtensionCommand before anything else), then ctx.reload() proceeds
  // asynchronously and tears down the old extension runner — which may still be finishing
  // this very event dispatch. No claim of race-freeness: that overlap is pi's documented
  // reload shape (the running command handler continues in its old call frame; old
  // in-memory state is invalid afterwards), and the command handler treats reload as
  // terminal. Status honestly stays "fired" if no reload follows.
  let pendingReload = false;

  // In-flight switch_model guard (single-flight). pi can execute sibling tool
  // calls in parallel within one run; two racing setModel calls would interleave
  // their receipts and neither could honestly say which model the session ended
  // up on. Set right before the setModel await; released in finally on EVERY
  // exit (accepted, returned false, thrown) so a rejected or failed switch
  // never wedges the tool. Factory-scoped like the other pending flags.
  let pendingSwitch = false;

  // Session-local feature config (v0.2): defaults per instance, restored from the
  // session branch on session_start. Factory-scoped like every other mutable —
  // reload swaps module instances, and the fresh instance re-restores from the
  // branch, which is exactly how toggles survive a runtime reload. read_only is
  // tracked separately: "disable read_only" is the safe default, "enable
  // read_only" blocks every agency mutation session-locally.
  const sessionDisabled = new Set<FeatureName>();
  let sessionReadOnly = false;
  const envOff = (f: FeatureName): boolean => envFlag(ENV_BY_FEATURE[f]);
  const featureOff = (f: FeatureName): boolean => envOff(f) || sessionDisabled.has(f);
  const readOnlyOn = (): boolean => envFlag("PI_AGENCY_READ_ONLY") || sessionReadOnly;
  // Guard messages keep the historical env-flag text when env is the cause, so
  // operators keep seeing WHICH immutable flag fired; the session-local branches
  // name the exact /agency command that flips the state back.
  const featureErr = (label: string, f: FeatureName): string =>
    envOff(f) ? `${label} is disabled (${ENV_BY_FEATURE[f]})` : `${label} is disabled for this session — /agency enable ${f} re-enables`;
  const featureNote = (label: string, f: FeatureName, site: string): string =>
    envOff(f) ? `${label} disabled (${ENV_BY_FEATURE[f]}) ${site}` : `${label} disabled for this session (/agency enable ${f}) ${site}`;
  const readonlyErr = (detail: string): string =>
    envFlag("PI_AGENCY_READ_ONLY") ? `read-only mode (PI_AGENCY_READ_ONLY) — ${detail}` : `read-only mode (/agency read_only enabled this session; /agency disable read_only clears it) — ${detail}`;
  const readonlyNote = (site: string): string =>
    envFlag("PI_AGENCY_READ_ONLY") ? `read-only mode (PI_AGENCY_READ_ONLY) — ${site}` : `read-only mode (/agency read_only enabled this session) — ${site}`;
  const sessionConfigLine = (): string =>
    `session config: disabled [${sessionDisabled.size ? [...sessionDisabled].sort().join(", ") : "none"}] · read_only: ${readOnlyOn() ? "on" : "off"} · env kill switches are immutable and always take priority (/agency config)`;
  const persistSessionConfig = (): void => {
    // Full-state snapshot per toggle (append-only): the LAST valid agency-config
    // entry on the branch is the truth restored later — no deltas to replay.
    pi.appendEntry("agency-config", { version: 1, disabled: [...sessionDisabled].sort(), readOnly: sessionReadOnly });
  };
  const restoreSessionConfig = (ctx: ExtensionContext): void => {
    let restored: { disabled: FeatureName[]; readOnly: boolean } | null = null;
    for (const entry of ctx.sessionManager.getBranch()) {
      const e = entry as { type?: string; customType?: string; data?: unknown };
      if (e?.type !== "custom" || e.customType !== "agency-config") continue;
      const parsed = parseConfigEntry(e.data);
      if (parsed) restored = parsed; // last VALID entry wins; corrupt/future versions skipped
    }
    sessionDisabled.clear();
    sessionReadOnly = false;
    for (const f of restored?.disabled ?? []) sessionDisabled.add(f);
    sessionReadOnly = restored?.readOnly === true;
  };

  function compactLine(): string {
    switch (compactState.status) {
      case "pending": return `compaction: scheduled${compactState.at ? " at " + compactState.at : ""} — runs at end of current run`;
      case "ok": return `compaction: last succeeded${compactState.at ? " at " + compactState.at : ""}`;
      case "native": return `compaction: native compaction completed${compactState.at ? " at " + compactState.at : ""} — not agency-initiated`;
      case "failed": return `compaction: last FAILED${compactState.at ? " at " + compactState.at : ""}${compactState.note ? " — " + compactState.note : ""}`;
      default: return "compaction: none requested";
    }
  }

  function reloadLine(): string {
    switch (reloadState.status) {
      case "scheduled": return `reload: scheduled${reloadState.at ? " at " + reloadState.at : ""} — fires at end of current run`;
      case "fired": return `reload: dispatched${reloadState.at ? " at " + reloadState.at : ""} — /agency reload invoked, awaiting runtime reload`;
      case "completed": return `reload: completed${reloadState.at ? " at " + reloadState.at : ""}${reloadState.note ? " — " + reloadState.note : ""}`;
      case "failed": return `reload: FAILED${reloadState.at ? " at " + reloadState.at : ""}${reloadState.note ? " — " + reloadState.note : ""}`;
      default: return "reload: none requested";
    }
  }

  // Shared default status view (v0.2): the /agency status command mirrors exactly
  // what agency_status reports, plus the effective config line.
  const statusLines = (ctx: ExtensionContext): string[] => [
    `model: ${modelLine(ctx.model)}`,
    `thinking: ${ctx.thinkingLevel ?? pi.getThinkingLevel() ?? "unknown"}`,
    `context: ${ctxText(ctx.getContextUsage())}`,
    `scope: ${ctx.scopedModels.length} scoped model(s)${ctx.scopedModels.length === 0 ? " (UNSCOPED — all models usable via /model; agent switching requires an explicit scope)" : ""}`,
    compactLine(),
    reloadLine(),
    togglesLine(),
    sessionConfigLine(),
  ];

  // Command output is fire-and-forget via ctx.ui.notify. Headless hosts (and the
  // deterministic harness) may provide NO ctx.ui at all — emit is a no-op there:
  // nothing crashes or blocks, and state changes stay observable via the tools.
  const emit = (ctx: { ui?: ExtensionUIContext }, message: string, type: "info" | "warning" | "error" = "info"): void => {
    ctx.ui?.notify(message, type);
  };

  const helpText = (): string => [
    "/agency — session-local control for the agency tools (agency_status, agency_models, agency_control)",
    "  /agency status                     — model, thinking, context estimate, compaction, reload, effective toggles",
    "  /agency info                       — purpose and limitations",
    "  /agency config                     — interactive feature toggles (TUI/RPC; headless sessions: use enable/disable)",
    "  /agency enable|disable <feature>   — toggle a feature for this session (persisted, restored on reload/resume)",
    "  /agency reload                     — reload extensions/skills/prompts/themes now (refuses while busy)",
    `features: ${FEATURE_NAMES.join(" ")}`,
    "env kill switches (PI_AGENCY_*) are immutable and always take priority over session toggles.",
  ].join("\n");

  const infoText = (): string => [
    "purpose: on-demand runtime awareness (model, thinking, context estimate, session usage) and scoped, honest, session-local control — switch_model within the session's scoped set, set_thinking (runtime-clamped), compact with optional guidance for Pi's summarizer, and deferred runtime reload. Runtime details are requested on demand.",
    "receipts are honest: requested != applied; scheduled != fired != completed; unknown stays unknown — context/usage figures are Pi/provider estimates, never billing.",
    "limitations:",
    "- scoped models are snapshotted at process start; a reload re-scopes nothing",
    "- /agency toggles are session-local: persisted into this session's file, restored from the current branch on startup/reload/resume; env kill switches are immutable and take priority",
    "- compact and reload fire only at the agent_settled idle boundary so no turn is aborted; a busy boundary drops the request with an honest receipt (no retry loop)",
    "- reload completion evidence is the runtime's own session_start(reload) event; nothing is auto-replayed afterwards",
    "- agency_control switch_model refuses known context-overflow targets and concurrent switches; an unscoped session disables agent-initiated switching for safety",
  ].join("\n");

  // Interactive config (TUI/RPC only): pick a feature, then enable/disable. Cancel
  // at either step (or Esc/timeout — select() resolves undefined) changes nothing.
  const runConfig = async (ctx: ExtensionCommandContext): Promise<void> => {
    if (!ctx.ui) return; // no UI surface at all (headless mock): nothing to render on
    if (ctx.hasUI === false) {
      emit(ctx, `interactive config needs a TUI/RPC session — non-interactive: /agency enable|disable <feature>\nfeatures: ${FEATURE_NAMES.join(" ")}`);
      return;
    }
    const rows = FEATURE_NAMES.map((f) => ({
      f,
      label: `${f} — ${f === "read_only" ? (readOnlyOn() ? "on" : "off") : featureOff(f) ? "off" : "on"}${envOff(f) ? " (env-locked)" : ""}`,
    }));
    const pick = await ctx.ui.select("agency: feature to toggle", [...rows.map((row) => row.label), "cancel"]);
    const chosen = rows.find((row) => row.label === pick);
    if (!chosen) {
      emit(ctx, "config: cancelled — nothing changed");
      return;
    }
    const verb = await ctx.ui.select(`${chosen.f}: enable or disable for this session?`, ["enable", "disable", "cancel"]);
    if (verb !== "enable" && verb !== "disable") {
      emit(ctx, `config: cancelled — ${chosen.f} unchanged`);
      return;
    }
    await applyToggle(ctx, verb, chosen.f);
  };

  // Direct toggle — no interaction required (headless-safe). Persists the full
  // config snapshot; env kill switches can never be lifted from here (warned).
  const applyToggle = async (ctx: ExtensionCommandContext, verb: "enable" | "disable", name: string): Promise<void> => {
    if (!isFeatureName(name)) {
      emit(ctx, `unknown feature '${clip(name)}' — valid features: ${FEATURE_NAMES.join(" ")}`, "error");
      return;
    }
    if (name === "read_only") sessionReadOnly = verb === "enable";
    else if (verb === "enable") sessionDisabled.delete(name);
    else sessionDisabled.add(name);
    persistSessionConfig();
    const stateLine = name === "read_only" ? `read_only: ${readOnlyOn() ? "on" : "off"}` : `${name}: ${featureOff(name) ? "off" : "on"}`;
    const lockNote =
      envOff(name) && !(name === "read_only" && verb === "enable")
        ? `\nwarning: env ${ENV_BY_FEATURE[name]} still forces ${name === "read_only" ? "read-only on" : "it off"} — env kill switches are immutable and take priority over session toggles`
        : "";
    emit(ctx, `${verb} ${name}: ${stateLine} (this session)${lockNote}\n${sessionConfigLine()}\npersisted to this session's file — restored on startup/reload/resume; the last valid toggle wins`, lockNote ? "warning" : "info");
  };

  // Reload entrypoint — the internal dispatch target for agency-scheduled reloads
  // AND a directly typed command. ctx.reload() exists only on
  // ExtensionCommandContext, so the tool cannot call it — it schedules,
  // agent_settled dispatches "/agency reload" at the idle boundary. Handler
  // contract: await ctx.reload() is TERMINAL for this handler (pi docs) — nothing
  // may follow it; the old instance's state is invalid afterwards. No entry is
  // appended before reloading (the runtime's own session_start "reload" event is
  // the completion evidence).
  const reloadNow = async (ctx: ExtensionCommandContext): Promise<void> => {
    if (readOnlyOn()) {
      reloadState.status = "failed";
      reloadState.at = new Date().toISOString();
      reloadState.note = readonlyNote("reload refused at command time");
      emit(ctx, `reload refused — ${reloadState.note}`, "error");
      return;
    }
    if (featureOff("reload")) {
      reloadState.status = "failed";
      reloadState.at = new Date().toISOString();
      reloadState.note = featureNote("reload", "reload", "at command time");
      emit(ctx, `reload refused — ${reloadState.note}`, "error");
      return;
    }
    if (!ctx.isIdle()) {
      // Mirrors the TUI's own /reload guards (isStreaming / isCompacting — both
      // covered by isIdle). Never abort an active run to reload — this also covers
      // a user TYPING /agency reload mid-run: it refuses, it does not queue.
      reloadState.status = "failed";
      reloadState.at = new Date().toISOString();
      reloadState.note = "refused — agent run or compaction in flight; re-request when idle";
      emit(ctx, `reload refused — ${reloadState.note}`, "error");
      return;
    }
    reloadState.status = "fired";
    reloadState.at = new Date().toISOString();
    reloadState.note = undefined;
    pendingReload = false;
    pendingCompact = null;
    await ctx.reload();
    return;
  };

  pi.on("session_start", (e, ctx) => {
    // Session-local config restore (v0.2): the LAST valid agency-config entry on
    // the current BRANCH (getBranch — not the whole tree) wins; corrupt or
    // future-version data is skipped. Runs on every session_start — startup/new/
    // resume/fork/reload — an empty branch restores defaults, an inherited branch
    // restores its own last state. Read-only, re-triggers nothing.
    restoreSessionConfig(ctx);
    // A runtime reload just completed — the runtime emitting session_start(reason
    // "reload") on this fresh instance IS the evidence. Record it truthfully with the
    // CURRENT timestamp. The initiator (agency-scheduled vs a manual /reload or
    // /agency reload) is not tracked: nothing is persisted before reloading, so no
    // stale session entry can be confused with the current attempt. Read-only — NEVER
    // re-triggers anything (no auto-replay of the tool action, no reload loop).
    if (e.reason !== "reload") return;
    reloadState.status = "completed";
    reloadState.at = new Date().toISOString();
    reloadState.note = "runtime-confirmed reload (initiator not tracked)";
    pendingCompact = null;
    pendingReload = false;
    compactInFlight = false;
  });
  pi.on("session_compact", (_e) => {
    // Attribution (v0.1.4): a compaction completed — but for WHOM? The old code
    // marked ANY completion "ok" and dropped the pending request, silently
    // crediting a NATIVE (auto/user-initiated) compaction as an agency success.
    // Honest receipts require the split below.
    const at = new Date().toISOString();
    if (compactInFlight) {
      // The agency-fired ctx.compact() completed — this receipt IS ours.
      compactInFlight = false;
      pendingCompact = null;
      compactState.status = "ok";
      compactState.at = at;
      compactState.note = undefined;
      return;
    }
    if (pendingCompact) {
      // A native compaction won the race and supersedes the scheduled request —
      // NOT an agency success: the requested handoff note was never passed to
      // the native compaction, so its inclusion is unverified.
      pendingCompact = null;
      compactState.status = "failed";
      compactState.at = at;
      compactState.note = "superseded by a native compaction — handoff note inclusion unverified, not an agency success";
      return;
    }
    // Native completion with no agency request involved — reported as exactly that.
    compactState.status = "native";
    compactState.at = at;
    compactState.note = undefined;
  });
  pi.on("session_compact_failed", (e) => {
    // Deliberately does NOT clear pendingCompact: a failed auto-compaction must
    // not silently drop an explicitly scheduled request. It still fires once at
    // the boundary; if that also fails, status reports it. No retry loop.
    compactInFlight = false; // if the agency-fired compaction is what failed, its receipt is this event
    compactState.status = "failed";
    compactState.at = new Date().toISOString();
    compactState.note = e.aborted ? "aborted" : (e.errorMessage ?? "unknown error");
  });
  pi.on("agent_settled", (_e, ctx) => {
    // Safe-boundary trigger: agent_settled fires after the run fully settles
    // (retries, auto-compaction, queued continuations drained), so ctx.compact()
    // here aborts nothing. One attempt per request.
    if (pendingReload) {
      // Reload branch — mutually exclusive with the compact branch by construction
      // (scheduling refuses while the other is pending). One attempt per request.
      pendingReload = false;
      if (readOnlyOn()) {
        reloadState.status = "failed";
        reloadState.at = new Date().toISOString();
        reloadState.note = readonlyNote("reload dropped before it could run");
        return;
      }
      if (featureOff("reload")) {
        reloadState.status = "failed";
        reloadState.at = new Date().toISOString();
        reloadState.note = featureNote("reload", "reload", "before it could run");
        return;
      }
      if (!ctx.isIdle()) {
        // Dropped, not deferred — same honesty rule as compact's busy boundary.
        reloadState.status = "failed";
        reloadState.at = new Date().toISOString();
        reloadState.note = "superseded — another operation was in flight at the boundary; request dropped";
        return;
      }
      reloadState.status = "fired";
      reloadState.at = new Date().toISOString();
      reloadState.note = undefined;
      // Idle: prompt() dispatches the command immediately (no LLM turn, no queued
      // "/cmd" text that _throwIfExtensionCommand would reject). Not awaited: the
      // dispatch starts synchronously here, the reload chain then runs asynchronously
      // and unloads the very runtime that is dispatching us (see the deferred-reload
      // note above — no race-freeness claimed). Errors surface via the host's
      // extension error reporting; status honestly stays "fired" if no reload follows.
      pi.sendUserMessage("/agency reload", { expandPromptTemplates: true });
      return;
    }
    if (!pendingCompact) return;
    const request = pendingCompact;
    pendingCompact = null;
    if (readOnlyOn()) {
      compactState.status = "failed";
      compactState.at = new Date().toISOString();
      compactState.note = readonlyNote("compact dropped before it could run");
      return;
    }
    if (featureOff("compact")) {
      compactState.status = "failed";
      compactState.at = new Date().toISOString();
      compactState.note = featureNote("compact", "compact", "before it could run");
      return;
    }
    if (!ctx.isIdle()) {
      // Dropped, not deferred: this agent_settled does not re-fire for the request,
      // and if the in-flight operation was not a compaction (e.g. a branch summary),
      // no session_compact event ever satisfies it — leaving status "pending"
      // would lie forever. Record the drop explicitly.
      compactState.status = "failed";
      compactState.at = new Date().toISOString();
      compactState.note = "superseded — another operation was in flight at the boundary; request dropped";
      return;
    }
    compactState.status = "pending";
    compactState.at = new Date().toISOString();
    compactState.note = undefined;
    compactInFlight = true;
    ctx.compact({ customInstructions: request.handoff?.trim() || undefined });
  });

  // Single public command (v0.2): /agency <subcommand> — subsumes the old separate
  // /agency-reload command. The deferred tool reload dispatches "/agency reload"
  // as its internal target, so the whole public surface is one slash command:
  // help (bare or explicit), status, info, config (interactive), enable/disable
  // <feature> (headless-safe, no interaction), reload (idle-guarded).
  pi.registerCommand("agency", {
    description: "Session-local agency control: help | status | info | config | enable/disable <feature> | reload (idle-only; agency-scheduled reloads fire at a safe idle boundary)",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "";
      switch (sub) {
        case "":
        case "help":
          emit(ctx, helpText());
          return;
        case "status":
          emit(ctx, statusLines(ctx).join("\n"));
          return;
        case "info":
          emit(ctx, infoText());
          return;
        case "config":
          await runConfig(ctx);
          return;
        case "enable":
        case "disable":
          await applyToggle(ctx, sub, parts[1] ?? "");
          return;
        case "reload":
          await reloadNow(ctx);
          return;
        default:
          emit(ctx, `unknown subcommand '${clip(sub)}' — /agency or /agency help lists usage`, "error");
          return;
      }
    },
  });

  pi.registerTool({
    name: "agency_status",
    label: "Agency status",
    description:
      "Inspect this session's runtime. Default view: current model, thinking level, context-window occupancy (estimate), scoped-model count, compaction state, effective feature toggles. Pass section='usage' for session token/cost totals.",
    promptSnippet: "agency_status: current model, thinking, context occupancy, compaction state (section='usage' for token/cost totals)",
    parameters: Type.Object({
      section: Type.Optional(Type.String({ description: "'usage' to add session token/cost totals" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (featureOff("status"))
        // Action-time error, never unregistration — and the effective toggle
        // states are still reported so the operator can see WHY (and flip it).
        return err(`${featureErr("status", "status")} — ${togglesLine()}`);
      if (params.section === "usage" && featureOff("usage"))
        return err(`${featureErr("usage section", "usage")} — the default status view remains available`);
      const lines = statusLines(ctx);
      if (params.section === "usage") lines.push("usage (this session):", usageText(ctx));
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });

  pi.registerTool({
    name: "agency_models",
    label: "Agency models",
    description:
      "List the models this session may switch between (the scoped set, same as /scoped-models): id, context window, max tokens, reasoning support. Use an id verbatim as agency_control's model param.",
    promptSnippet: "agency_models: list switchable (scoped) models",
    parameters: Type.Object({
      filter: Type.Optional(Type.String({ description: "case-insensitive substring filter" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (featureOff("models"))
        return err(featureErr("models", "models"));
      const scoped = ctx.scopedModels;
      if (scoped.length === 0) {
        return {
          content: [{ type: "text", text: "No model scope is configured for this session (unscoped). Agent-initiated switching is disabled for safety; use /model interactively, or start pi with an explicit --models scope." }],
          details: { count: 0 },
        };
      }
      const f = params.filter?.toLowerCase();
      const rows = scoped
        .map((s) => s.model)
        .filter((m) => !f || `${m.provider}/${m.id}`.toLowerCase().includes(f))
        .map((m) => `- ${modelLine(m)}`);
      return { content: [{ type: "text", text: `${rows.length} scoped model(s):\n${rows.join("\n")}` }], details: { count: rows.length } };
    },
  });

  pi.registerTool({
    name: "agency_control",
    label: "Agency control",
    description:
      "Control this Pi session. Actions: switch_model (scoped model), set_thinking (supported level), compact (Pi's native summary; optional focus guidance), reload (refresh runtime resources). Compact and reload run at the next idle boundary, one per boundary. Receipts distinguish scheduled, applied and completed.",
    promptSnippet: "agency_control: switch scoped model, set thinking level, run Pi's native compaction (optional focus guidance), or schedule a runtime reload",
    parameters: Type.Object({
      action: Type.String({ description: "switch_model | set_thinking | compact | reload" }),
      model: Type.Optional(Type.String({ description: "target 'provider/id' for switch_model" })),
      level: Type.Optional(Type.String({ description: "thinking level for set_thinking" })),
      handoff: Type.Optional(Type.String({ description: "optional focus guidance for Pi's native compaction summarizer; normally omit; max 8192 UTF-8 bytes" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        if (readOnlyOn())
          return err(readonlyErr(`'${clip(params.action)}' blocked: every agency_control action is a mutation`));
        if (params.action === "switch_model") {
          if (featureOff("switch"))
            return err(featureErr("switch_model", "switch"));
          const target = params.model ?? "";
          const [provider, ...rest] = target.split("/");
          const id = rest.join("/");
          if (!provider || !id) return err(`model must be 'provider/id', got '${clip(target)}'`);
          const scoped = ctx.scopedModels;
          if (scoped.length === 0) return err("no model scope configured — agent-initiated switching disabled for safety (start pi with an explicit --models scope)");
          const match = scoped.find((s) => s.model.provider === provider && s.model.id === id);
          if (!match) return err(`'${clip(target)}' is not in this session's scoped set — run agency_models for the allowed list`);
          if (!ctx.modelRegistry.hasConfiguredAuth(match.model)) return err(`no configured auth for ${clip(target)}`);
          // Context-fit guard: refuse only when the mismatch is KNOWN — the current
          // token estimate is a finite number AND the target's context window is a
          // finite number smaller than it. An unknown estimate (startup, right after
          // a compaction) never blocks, but the success receipt warns the fit was not
          // checked. Checked BEFORE setModel so a doomed switch never mutates.
          const usage = ctx.getContextUsage();
          const estTokens =
            usage && typeof usage.tokens === "number" && Number.isFinite(usage.tokens) ? usage.tokens : null;
          const targetWin = match.model.contextWindow;
          if (estTokens !== null && typeof targetWin === "number" && Number.isFinite(targetWin) && estTokens > targetWin)
            return err(`switch_model refused: current context (~${estTokens} tokens) would not fit ${clip(target)}'s context window (${targetWin} tokens) — compact first (agency_control compact), then re-try`);
          if (pendingSwitch)
            return err("another switch_model is in flight — wait for its receipt, then re-request (check agency_status)");
          pendingSwitch = true;
          try {
            const ok = await pi.setModel(match.model);
            // Live readback: pi's ExtensionContext.model is a live getter, so after a
            // confirmed switch it normally already reflects the new model. But ok===true
            // is only the runtime's ACCEPTANCE — never claim "now <target>" from the
            // request alone. Claim "now" only when the readback actually reads the
            // target; otherwise report acceptance with the stale/unknown readback and
            // point at agency_status to verify.
            const now = ctx.model;
            if (!ok)
              return err(`switch_model rejected (setModel returned false — likely missing auth for ${clip(target)}); still ${modelLine(now)}`);
            const fitNote =
              estTokens === null ? "\nwarning: context fit not checked — no token estimate available yet" : "";
            if (now && now.provider === match.model.provider && now.id === match.model.id)
              return text(`switch_model: applied — now ${modelLine(now)}${fitNote}`);
            return text(`switch_model: runtime accepted, but live readback still reads ${now ? modelLine(now) : "unknown"} — the switch may take effect on a later turn; verify with agency_status${fitNote}`);
          } finally {
            pendingSwitch = false;
          }
        }
        if (params.action === "set_thinking") {
          if (featureOff("thinking"))
            return err(featureErr("set_thinking", "thinking"));
          const level = (params.level ?? "").trim();
          if (!level) return err("set_thinking requires level");
          if (!isThinkingLevel(level))
            return err(`unknown thinking level '${clip(level)}' — use off | minimal | low | medium | high | xhigh | max`);
          const before = pi.getThinkingLevel();
          pi.setThinkingLevel(level);
          const after = pi.getThinkingLevel();
          return text(`set_thinking: requested '${level}' (was '${before}') → effective '${after}'${after !== level ? " (clamped/normalized to model support)" : ""}`);
        }
        if (params.action === "compact") {
          if (featureOff("compact"))
            return err(featureErr("compact", "compact"));
          const handoff = params.handoff?.trim() || undefined;
          if (handoff !== undefined && Buffer.byteLength(handoff, "utf8") > HANDOFF_MAX_BYTES)
            return err(`handoff too large — ${Buffer.byteLength(handoff, "utf8")} UTF-8 bytes exceeds the ${HANDOFF_MAX_BYTES}-byte limit; distill it to objective/decisions/next steps`);
          if (pendingReload)
            return err("a reload is scheduled for this boundary — a compaction would race it; wait for the reload to complete (check agency_status), then compact");
          if (pendingCompact)
            return text("compact: already scheduled — first handoff retained, this new request (and its handoff) ignored; one request per run boundary; check agency_status for the result");
          pendingCompact = { handoff };
          compactState.status = "pending";
          compactState.at = new Date().toISOString();
          compactState.note = undefined;
          return text(`compact: scheduled${params.handoff ? " with handoff note" : ""} — fires at agent_settled (end of this run) so the active turn is not aborted; check agency_status for the result. Context estimate now: ${ctxText(ctx.getContextUsage())}`);
        }
        if (params.action === "reload") {
          if (featureOff("reload"))
            return err(featureErr("reload", "reload"));
          if (pendingCompact)
            return err("a compaction is scheduled for this boundary — a reload would abort it; wait for the compaction to complete (check agency_status), then re-request reload");
          if (pendingReload)
            return text("reload: already scheduled — this new request ignored; one request per run boundary; check agency_status for the result");
          pendingReload = true;
          reloadState.status = "scheduled";
          reloadState.at = new Date().toISOString();
          reloadState.note = undefined;
          return text("reload: scheduled — fires at agent_settled (end of this run) via the /agency reload command, so the active turn is not aborted and extensions reload only while idle; nothing is auto-replayed afterwards — check agency_status after the run for the completed receipt. Note: scoped models are snapshotted at process start; a reload does not re-scope them");
        }
        return err(`unknown action '${clip(params.action)}' — use switch_model | set_thinking | compact | reload`);
      } catch (e) {
        // Own user-facing refusals (err()/AgencyError) pass through UNWRAPPED — this
        // catch exists only for unexpected failures (model registry, provider,
        // runtime), whose exception text can embed credential URLs, tokens, or stack
        // details. Those get a static bounded message; the exception's own text never
        // reaches tool output.
        if (e instanceof AgencyError) throw e;
        throw err("control failed: unexpected internal error — the action did not complete; details omitted for safety (check provider auth/config and retry)");
      }
    },
  });
}

function text(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}
// Tool failures must THROW (pi docs/extensions.md, "Signaling errors"): returning
// error text never sets isError on the tool result, so the LLM would see "ERROR"
// prose flagged as success. err() throws a typed error carrying the bare message;
// pi's runtime renders a thrown execute() as a failed (isError) result. The test
// harness catches AgencyError and re-formats "ERROR: ..." to keep the historical
// visible shape; a bare (unprefixed) message avoids double prefixes at runtime.
export class AgencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgencyError";
  }
}
function err(text: string): never {
  throw new AgencyError(text);
}
