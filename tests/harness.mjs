// Deterministic harness for pi-model-agency — no model, no network.
// Deterministic tests for extension.ts — no model, no network.
// Run: bash tests/run.sh
import ext, { AgencyError } from "./ext-copy.ts";

const tools = {};
const events = {};
const commands = {};
const sentMessages = []; // captured pi.sendUserMessage calls
const appendedEntries = []; // captured pi.appendEntry calls
const fakePi = {
  on: (ev, h) => (events[ev] = h),
  registerTool: (t) => (tools[t.name] = t),
  registerCommand: (name, opts) => (commands[name] = opts),
  appendEntry: (customType, data) => appendedEntries.push({ customType, data }),
  sendUserMessage: (content, options) => { sentMessages.push({ content, options }); return Promise.resolve(); },
  getThinkingLevel: () => state.thinking,
  setThinkingLevel: (l) => (state.thinking = l),
  setModel: async (m) => {
    state.setModelCalls++;
    if (state.setModelThrows) throw new Error("boom");
    if (state.setModelDeferred) await state.setModelDeferred.promise;
    if (!state.setModelOk) return false;
    if (!state.setModelStale) state.model = m;
    return true;
  },
};

const state = {
  thinking: "medium",
  model: { provider: "halo", id: "gemma-4-26b", contextWindow: 131072, maxTokens: 32768, reasoning: true },
  isIdle: true,
  scoped: [
    { model: { provider: "halo", id: "gemma-4-26b", contextWindow: 131072, maxTokens: 32768, reasoning: true } },
    { model: { provider: "zai", id: "glm-5.3", contextWindow: 200000, maxTokens: 65536, reasoning: true } },
    { model: { provider: "openai-codex", id: "gpt-6-astra", contextWindow: 400000, maxTokens: 128000, reasoning: true } },
  ],
  usage: [{ input: 1200, output: 300, cacheRead: 50, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0 } }],
  usageEstimate: { tokens: 16067, contextWindow: 131072, percent: 12.3 },
  setModelOk: true,
  setModelThrows: false,
  setModelCalls: 0,
  setModelDeferred: null, // when set: setModel awaits this deferred promise before resolving
  setModelStale: false, // when true: setModel returns true WITHOUT updating the ctx.model getter
  hasAuth: true,
  capturedCompact: "NOT-CALLED",
  reloadCtxCalls: [], // captured ctx.reload() calls from the command handler
  branchEntries: null, // when set: overrides getBranch() (persistence/restore fixtures); null = derive from appendedEntries
};

// Fake TUI surface: scripted select() results + a notify() log. selectCalls()
// counts interactions so tests can prove a path never prompted.
const mkUi = (selects = []) => {
  const log = [];
  const queue = [...selects];
  let selectCalls = 0;
  return {
    log,
    selectCalls: () => selectCalls,
    ui: {
      notify: (m, t) => log.push({ m, t }),
      select: async () => {
        selectCalls++;
        return queue.length ? queue.shift() : undefined;
      },
    },
  };
};

const fakeCtx = () => ({
  get model() { return state.model; },
  scopedModels: state.scoped,
  thinkingLevel: state.thinking,
  getContextUsage: () => state.usageEstimate,
  isIdle: () => state.isIdle,
  sessionManager: {
    getEntries: () => [
      ...state.usage.map((u) => ({ message: { usage: u } })),
      ...appendedEntries.map((e) => ({ type: "custom", customType: e.customType, data: e.data })),
    ],
    getBranch: () =>
      state.branchEntries ??
      appendedEntries.map((e) => ({ type: "custom", customType: e.customType, data: e.data })),
  },
  modelRegistry: { hasConfiguredAuth: () => state.hasAuth },
  compact: (opts) => (state.capturedCompact = opts ?? "CALLED-NO-OPTS"),
});
// Command context: the ONLY place the installed runtime exposes reload()
// (ExtensionCommandContext, pi 0.86.1 types.d.ts:291). The tool ctx above has none.
// ui is optional — headless hosts (and the real runtime's print mode) may offer a
// no-op or absent ui; extra merges ctx overrides like { hasUI: false }.
const fakeCmdCtx = (ui, extra = {}) => ({
  ...fakeCtx(),
  ...(ui ? { ui } : {}),
  ...extra,
  reload: () => { state.reloadCtxCalls.push(Date.now()); return Promise.resolve(); },
});

ext(fakePi);
// v0.1.5: tools signal failure by THROWING AgencyError (pi sets isError on a tool
// result ONLY when execute throws — docs/extensions.md "Signaling errors"). run()
// catches the typed error and re-formats the historical "ERROR: ..." text shape so
// existing expectations keep passing; non-agency errors propagate as genuine bugs.
const run = async (name, params) => {
  try {
    return (await tools[name].execute("t1", params, undefined, undefined, fakeCtx())).content[0].text;
  } catch (e) {
    if (e instanceof AgencyError) return `ERROR: ${e.message}`;
    throw e;
  }
};

let fails = 0;
const check = (label, cond) => (cond ? console.log("PASS", label) : (fails++, console.log("FAIL", label)));
const out = async (t, p) => JSON.stringify(await run(t, p));

// status default
let r = await run("agency_status", {});
check("status shows model line", r.includes("halo/gemma-4-26b") && r.includes("131072"));
check("status shows thinking", r.includes("thinking: medium"));
check("status shows context estimate", r.includes("~16067 / 131072") && r.includes("12%"));
check("status scope count", r.includes("3 scoped model(s)"));
check("status compaction idle", r.includes("compaction: none requested"));
// status usage
r = await run("agency_status", { section: "usage" });
check("usage totals + cost", r.includes("input 1.2k") && r.includes("~$0.0300") && r.includes("NOT billing"));
// usage without cost data
state.usage[0].cost = undefined;
r = await run("agency_status", { section: "usage" });
check("usage cost unknown when unreported", r.includes("cost: unknown"));
state.usage[0].cost = { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0 };

// models list + filter + unscoped
r = await run("agency_models", {});
check("models lists all scoped", r.includes("halo/gemma-4-26b") && r.includes("zai/glm-5.3") && r.includes("openai-codex/gpt-6-astra"));
r = await run("agency_models", { filter: "astra" });
check("models filter", r.includes("gpt-6-astra") && !r.includes("glm-5.3"));
const savedScope = state.scoped;
state.scoped = [];
r = await run("agency_models", {});
check("unscoped models explains", r.includes("No model scope"));
r = await run("agency_control", { action: "switch_model", model: "zai/glm-5.3" });
check("unscoped switch refused", r.startsWith("ERROR") && r.includes("no model scope"));
state.scoped = savedScope;

// switch_model paths
r = await run("agency_control", { action: "switch_model", model: "zai/glm-5.3" });
check("switch ok receipt", r.includes("applied — now zai/glm-5.3"));
r = await run("agency_control", { action: "switch_model", model: "zai/glm-9.9" });
check("switch non-scoped refused", r.startsWith("ERROR") && r.includes("not in this session's scoped set"));
r = await run("agency_control", { action: "switch_model", model: "badformat" });
check("switch bad format refused", r.startsWith("ERROR") && r.includes("provider/id"));
state.hasAuth = false;
r = await run("agency_control", { action: "switch_model", model: "zai/glm-5.3" });
check("switch no-auth refused", r.startsWith("ERROR") && r.includes("no configured auth"));
state.hasAuth = true;
state.setModelOk = false;
r = await run("agency_control", { action: "switch_model", model: "zai/glm-5.3" });
check("switch false-receipt honest", r.startsWith("ERROR") && r.includes("returned false") && r.includes("still zai/glm-5.3"));
r = await run("agency_control", { action: "switch_model", model: "zai/glm-5.3" });
check("flag cleared after setModel false — retry not stuck", !r.includes("in flight") && r.includes("returned false"));
state.setModelOk = true;
state.setModelThrows = true;
r = await run("agency_control", { action: "switch_model", model: "zai/glm-5.3" });
check("switch unexpected-throw → generic bounded error, exception text never leaks", r.startsWith("ERROR") && r.includes("control failed") && !r.includes("boom") && r.length < 300);
state.setModelThrows = false;
r = await run("agency_control", { action: "switch_model", model: "zai/glm-5.3" });
check("flag cleared after unexpected throw — retry not stuck", !r.includes("in flight") && r.includes("applied"));
state.model = fakePi.setModel ? { provider: "halo", id: "gemma-4-26b", contextWindow: 131072, maxTokens: 32768, reasoning: true } : state.model;

// ==== switch_model safety (fit guard + single-flight + honest readback) ====
const gemmaModel = () => ({ provider: "halo", id: "gemma-4-26b", contextWindow: 131072, maxTokens: 32768, reasoning: true });

// fit KNOWN and over the target window → refused with the numbers, BEFORE setModel
state.scoped.push({ model: { provider: "tiny", id: "small-ctx", contextWindow: 8192, maxTokens: 1024, reasoning: false } });
state.setModelCalls = 0;
r = await run("agency_control", { action: "switch_model", model: "tiny/small-ctx" });
check("fit-known over target window refused with numbers", r.startsWith("ERROR") && r.includes("16067") && r.includes("8192"));
check("fit refusal never reaches setModel", state.setModelCalls === 0 && state.model.id === "gemma-4-26b");

// fit UNKNOWN (no estimate at all) → allowed even into a smaller window, warns unchecked
state.usageEstimate = undefined;
r = await run("agency_control", { action: "switch_model", model: "tiny/small-ctx" });
check("unknown estimate does not block, warns fit not checked", r.includes("applied — now tiny/small-ctx") && r.includes("not checked"));
state.model = gemmaModel();
// tokens: null → still unknown, same allowance + warning
state.usageEstimate = { tokens: null, contextWindow: 131072, percent: null };
r = await run("agency_control", { action: "switch_model", model: "tiny/small-ctx" });
check("null token estimate treated as unknown, warns unchecked", r.includes("applied — now tiny/small-ctx") && r.includes("not checked"));
state.model = gemmaModel();
state.usageEstimate = { tokens: 16067, contextWindow: 131072, percent: 12.3 };
state.scoped.pop(); // drop the tiny-window model

// stale getter: setModel true but ctx.model still reads the old model → no false "now target"
state.setModelStale = true;
r = await run("agency_control", { action: "switch_model", model: "zai/glm-5.3" });
check("stale readback honest: accepted, readback old, verify agency_status", r.includes("accepted") && r.includes("halo/gemma-4-26b") && r.includes("agency_status") && !r.includes("now zai/glm-5.3"));
state.setModelStale = false;

// single-flight: a second concurrent switch is refused while the first awaits setModel
const mkDeferred = () => { let resolve; const promise = new Promise((res) => (resolve = res)); return { promise, resolve }; };
state.setModelDeferred = mkDeferred();
const inFlight = run("agency_control", { action: "switch_model", model: "zai/glm-5.3" });
r = await run("agency_control", { action: "switch_model", model: "openai-codex/gpt-6-astra" });
check("parallel switch refused while first in flight", r.startsWith("ERROR") && r.includes("in flight") && state.model.id === "gemma-4-26b");
state.setModelDeferred.resolve();
r = await inFlight;
check("first switch completes after release, flag cleared", r.includes("applied — now zai/glm-5.3"));
r = await run("agency_control", { action: "switch_model", model: "openai-codex/gpt-6-astra" });
check("flag cleared after success — next switch not stuck", r.includes("applied — now openai-codex/gpt-6-astra"));
state.setModelDeferred = null;
state.model = gemmaModel();

// set_thinking
r = await run("agency_control", { action: "set_thinking", level: "low" });
check("set_thinking receipt", r.includes("requested 'low' (was 'medium') → effective 'low'"));
r = await run("agency_control", { action: "set_thinking" });
check("set_thinking missing level", r.startsWith("ERROR"));
// clamp simulation
state.thinking = "max";
r = await run("agency_control", { action: "set_thinking", level: "high" });
check("set_thinking shows effective", r.includes("effective 'high'"));

// compact — deferred to agent_settled (regression: ctx.compact() fired mid-turn aborted
// the active run by design — sibling tools finalized as isError "Operation aborted",
// TUI printed a false-looking error right before compaction succeeded)
state.capturedCompact = "NOT-CALLED";
state.isIdle = true;
r = await run("agency_control", { action: "compact", handoff: "objective: ship v1; next: run verify" });
check("compact schedules, does NOT fire ctx.compact mid-turn", r.includes("compact: scheduled with handoff note") && state.capturedCompact === "NOT-CALLED");
r = await run("agency_control", { action: "compact", handoff: "late duplicate" });
check("duplicate compact honest receipt", r.includes("already scheduled") && r.includes("first handoff retained") && r.includes("new request") && r.includes("ignored") && state.capturedCompact === "NOT-CALLED");
r = await run("agency_status", {});
check("status shows scheduled compaction", r.includes("compaction: scheduled") && r.includes("end of current run"));
events["agent_settled"]({}, fakeCtx());
check("agent_settled fires compaction with handoff as customInstructions", state.capturedCompact.customInstructions === "objective: ship v1; next: run verify");
events["session_compact"]({});
r = await run("agency_status", {});
check("status shows ok compaction", r.includes("compaction: last succeeded"));
events["session_compact_failed"]({ aborted: false, errorMessage: "quota exceeded" });
r = await run("agency_status", {});
check("status shows failed compaction + reason", r.includes("FAILED") && r.includes("quota exceeded"));

// session_compact supersedes a scheduled request (auto-compaction won the race).
// v0.1.4: that is a NATIVE completion — the scheduled request's handoff was never
// passed to it, so the receipt is FAILED/superseded/unverified, NOT agency success.
state.capturedCompact = "NOT-CALLED";
await run("agency_control", { action: "compact", handoff: "h2" });
events["session_compact"]({});
r = await run("agency_status", {});
check("native compaction superseding scheduled request → FAILED/unverified, not agency success", r.includes("FAILED") && r.includes("superseded by a native compaction") && r.includes("unverified") && !r.includes("compaction: last succeeded"));
events["agent_settled"]({}, fakeCtx());
check("superseded request never double-fires", state.capturedCompact === "NOT-CALLED");

// failed compaction does NOT clear a scheduled request — it still fires once
state.capturedCompact = "NOT-CALLED";
await run("agency_control", { action: "compact", handoff: "h3" });
events["session_compact_failed"]({ aborted: true });
events["agent_settled"]({}, fakeCtx());
check("failed compaction leaves scheduled request firing once", state.capturedCompact.customInstructions === "h3");
events["session_compact"]({}); // settle state

// busy boundary: an in-flight compaction supersedes (dropped, never double-fires)
state.capturedCompact = "NOT-CALLED";
await run("agency_control", { action: "compact" });
state.isIdle = false;
events["agent_settled"]({}, fakeCtx());
state.isIdle = true;
events["agent_settled"]({}, fakeCtx());
check("busy boundary defers to in-flight compaction", state.capturedCompact === "NOT-CALLED");
// regression (2026-10-13): the drop used to leave compactState "pending" forever when the
// in-flight operation was a branch summary (no session_compact ever satisfies the request)
r = await run("agency_status", {});
check("busy-boundary drop is FAILED/superseded, never lingering pending", r.includes("FAILED") && r.includes("superseded") && r.includes("dropped") && !r.includes("compaction: scheduled"));
events["session_compact"]({}); // settle state

// kill switch at fire time drops the scheduled request, honestly
state.capturedCompact = "NOT-CALLED";
await run("agency_control", { action: "compact" });
process.env.PI_AGENCY_DISABLE_COMPACT = "1";
events["agent_settled"]({}, fakeCtx());
delete process.env.PI_AGENCY_DISABLE_COMPACT;
r = await run("agency_status", {});
check("kill switch at fire time drops request + honest status", state.capturedCompact === "NOT-CALLED" && r.includes("FAILED") && r.includes("before it could run"));
events["session_compact"]({}); // settle state

// compact without handoff
state.capturedCompact = "NOT-CALLED";
r = await run("agency_control", { action: "compact" });
check("compact without handoff ok", r.includes("compact: scheduled —"));
events["agent_settled"]({}, fakeCtx());
check("compact without handoff passes undefined customInstructions", state.capturedCompact.customInstructions === undefined);
events["session_compact"]({}); // settle state

// flags: kill switches disable control actions, not awareness
process.env.PI_AGENCY_DISABLE_SWITCH = "1";
r = await run("agency_control", { action: "switch_model", model: "zai/glm-5.3" });
check("env disables switch", r.startsWith("ERROR") && r.includes("PI_AGENCY_DISABLE_SWITCH"));
r = await run("agency_models", {});
check("env leaves models tool working", r.includes("zai/glm-5.3"));
r = await run("agency_status", {});
check("env leaves status working", r.includes("model:"));
delete process.env.PI_AGENCY_DISABLE_SWITCH;
process.env.PI_AGENCY_DISABLE_COMPACT = "1";
state.capturedCompact = "NOT-CALLED";
r = await run("agency_control", { action: "compact" });
check("env disables compact", r.startsWith("ERROR") && r.includes("PI_AGENCY_DISABLE_COMPACT"));
delete process.env.PI_AGENCY_DISABLE_COMPACT;
events["agent_settled"]({}, fakeCtx());
check("env-disabled compact never schedules", state.capturedCompact === "NOT-CALLED");

// unknown action
r = await run("agency_control", { action: "self_destruct" });
check("unknown action refused", r.startsWith("ERROR") && r.includes("unknown action"));

// ==== reload (v0.1.3) — deferred to agent_settled via the /agency-reload command ====
// Regression class: sendUserMessage with a registered "/cmd" dispatches the command
// IMMEDIATELY in pi 0.86.1 (even mid-stream), and queueing raw "/cmd" followUp text
// THROWS — so the tool must not send anything mid-run; it schedules, the boundary fires.

// status shows reload idle by default
r = await run("agency_status", {});
check("status shows reload idle", r.includes("reload: none requested"));

// reload schedules; NOTHING is sent mid-run
sentMessages.length = 0;
state.reloadCtxCalls.length = 0;
r = await run("agency_control", { action: "reload" });
check("reload schedules, sends nothing mid-run", r.includes("reload: scheduled") && r.includes("end of this run") && sentMessages.length === 0 && state.reloadCtxCalls.length === 0);
r = await run("agency_status", {});
check("status shows reload scheduled", r.includes("reload: scheduled") && r.includes("end of current run"));

// duplicate reload — honest receipt, single request
r = await run("agency_control", { action: "reload" });
check("duplicate reload honest receipt", r.includes("reload: already scheduled") && r.includes("ignored") && sentMessages.length === 0);

// compact refused while reload pending (mutual exclusion, compact direction)
r = await run("agency_control", { action: "compact" });
check("compact refused while reload scheduled", r.startsWith("ERROR") && r.includes("race") && state.capturedCompact === "NOT-CALLED");

// agent_settled (idle) dispatches the command as an expandPromptTemplates user message
state.isIdle = true;
events["agent_settled"]({}, fakeCtx());
check("agent_settled dispatches /agency reload with expandPromptTemplates", sentMessages.length === 1 && sentMessages[0].content === "/agency reload" && sentMessages[0].options?.expandPromptTemplates === true);
r = await run("agency_status", {});
check("status shows reload fired", r.includes("reload: dispatched") && r.includes("awaiting runtime reload"));

// command handler happy path: idle → reload once, NO durability entry appended
// (v0.1.3 removed entry attribution — no session receipt can be confused with a
// stale attempt; the runtime's session_start "reload" event is the evidence)
await commands["agency"].handler("reload", fakeCmdCtx());
check("agency reload command reloads once, appends NO durability entry", state.reloadCtxCalls.length === 1 && appendedEntries.length === 0);

// session_start(reload) reports completed with the CURRENT timestamp, runtime-confirmed;
// persistent old agency-reload entries (stale attempts / pre-v0.1.3 versions) are
// irrelevant — no attribution, no stale timestamp reuse
appendedEntries.push({ customType: "agency-reload", data: { at: "2001-01-01T00:00:00.000Z" } });
const beforeStart = Date.now();
events["session_start"]({ reason: "reload" }, fakeCtx());
r = await run("agency_status", {});
const atMatch = r.match(/reload: completed at (\S+)/);
const reportedAt = atMatch ? Date.parse(atMatch[1]) : NaN;
check("session_start reload reports completed, runtime-confirmed, initiator not tracked", r.includes("reload: completed") && r.includes("runtime-confirmed reload (initiator not tracked)"));
check("persistent old entries are irrelevant — current timestamp, no agency attribution", !Number.isNaN(reportedAt) && reportedAt >= beforeStart && !r.includes("2001-01-01") && !r.includes("agency-initiated"));

// scheduled request is cleared after reload — no reload loop
sentMessages.length = 0;
events["agent_settled"]({}, fakeCtx());
check("no reload loop after completion", sentMessages.length === 0);

// manual reload: a plain /reload (pi's own command) reaches session_start the same
// way — reported truthfully as completed/runtime-confirmed, no agency attribution,
// and the superseded scheduled request is never auto-replayed
await run("agency_control", { action: "reload" });
sentMessages.length = 0;
events["session_start"]({ reason: "reload" }, fakeCtx()); // manual /reload beat the boundary
r = await run("agency_status", {});
check("manual reload reported actual, no agency attribution", r.includes("reload: completed") && r.includes("runtime-confirmed reload (initiator not tracked)"));
events["agent_settled"]({}, fakeCtx());
check("superseded scheduled request is not auto-replayed after manual reload", sentMessages.length === 0);

// busy boundary: reload dropped with honest FAILED/superseded status
state.capturedCompact = "NOT-CALLED";
await run("agency_control", { action: "reload" });
state.isIdle = false;
sentMessages.length = 0;
events["agent_settled"]({}, fakeCtx());
state.isIdle = true;
events["agent_settled"]({}, fakeCtx());
check("busy boundary drops reload, never sends", sentMessages.length === 0);
r = await run("agency_status", {});
check("busy-boundary drop is FAILED/superseded", r.includes("reload: FAILED") && r.includes("superseded") && r.includes("dropped"));

// reload refused while compact pending (mutual exclusion, reload direction)
state.capturedCompact = "NOT-CALLED";
await run("agency_control", { action: "compact", handoff: "h-r" });
r = await run("agency_control", { action: "reload" });
check("reload refused while compact scheduled", r.startsWith("ERROR") && r.includes("would abort it") && sentMessages.length === 0);
events["agent_settled"]({}, fakeCtx()); // compact fires, reload was never scheduled
check("compact still fires when reload was refused", state.capturedCompact.customInstructions === "h-r");
events["session_compact"]({}); // settle state

// kill switch at schedule time
process.env.PI_AGENCY_DISABLE_RELOAD = "1";
r = await run("agency_control", { action: "reload" });
check("env disables reload at schedule", r.startsWith("ERROR") && r.includes("PI_AGENCY_DISABLE_RELOAD"));
delete process.env.PI_AGENCY_DISABLE_RELOAD;

// kill switch at boundary fire time — dropped honestly, command never sent
await run("agency_control", { action: "reload" });
process.env.PI_AGENCY_DISABLE_RELOAD = "1";
sentMessages.length = 0;
events["agent_settled"]({}, fakeCtx());
delete process.env.PI_AGENCY_DISABLE_RELOAD;
check("kill switch at fire time drops request, never sends", sentMessages.length === 0);
r = await run("agency_status", {});
check("fire-time kill switch honest status", r.includes("reload: FAILED") && r.includes("before it could run"));

// kill switch at command time — no reload (and still no entry)
await run("agency_control", { action: "reload" });
events["agent_settled"]({}, fakeCtx());
appendedEntries.length = 0;
state.reloadCtxCalls.length = 0;
process.env.PI_AGENCY_DISABLE_RELOAD = "1";
await commands["agency"].handler("reload", fakeCmdCtx());
delete process.env.PI_AGENCY_DISABLE_RELOAD;
check("kill switch at command time: no reload, no entry", appendedEntries.length === 0 && state.reloadCtxCalls.length === 0);
r = await run("agency_status", {});
check("command-time kill switch honest status", r.includes("reload: FAILED") && r.includes("at command time"));

// command handler refuses when not idle (mirrors TUI /reload guards) — this is
// also the "typed directly while busy" refusal for the single /agency command
state.reloadCtxCalls.length = 0;
state.isIdle = false;
await commands["agency"].handler("reload", fakeCmdCtx());
state.isIdle = true;
check("command refuses while busy, no reload", state.reloadCtxCalls.length === 0);
r = await run("agency_status", {});
check("busy command refusal honest status", r.includes("reload: FAILED") && r.includes("in flight"));

// no auto-replay: after a completed reload cycle nothing is ever re-queued
// (session_start only restores state; the settled handler only fires on pending)
sentMessages.length = 0;
events["session_start"]({ reason: "reload" }, fakeCtx());
events["agent_settled"]({}, fakeCtx());
events["session_start"]({ reason: "startup" }, fakeCtx());
events["agent_settled"]({}, fakeCtx());
check("no auto-replay after reload completion", sentMessages.length === 0);

// single public command is registered; the old separate /agency-reload is gone
check("single /agency command registered", !!commands["agency"] && commands["agency-reload"] === undefined);

// ==== feature toggles + safety validation (v0.1.4) ====
// Every toggle: SWITCH/COMPACT/RELOAD covered above; THINKING/STATUS/MODELS/USAGE/
// READ_ONLY here. All are action-time checks — tools stay registered.

// baseline: status always reports the effective toggle states, all off by default
r = await run("agency_status", {});
check("status reports toggle line, all off", r.includes("toggles:") && r.includes("PI_AGENCY_DISABLE_SWITCH=off") && r.includes("PI_AGENCY_DISABLE_COMPACT=off") && r.includes("PI_AGENCY_DISABLE_RELOAD=off") && r.includes("PI_AGENCY_DISABLE_THINKING=off") && r.includes("PI_AGENCY_DISABLE_STATUS=off") && r.includes("PI_AGENCY_DISABLE_MODELS=off") && r.includes("PI_AGENCY_DISABLE_USAGE=off") && r.includes("PI_AGENCY_READ_ONLY=off"));

// set_thinking whitelist — true runtime validation incl 'off', no arbitrary cast
state.thinking = "medium";
r = await run("agency_control", { action: "set_thinking", level: "ultra" });
check("set_thinking rejects unknown level, never calls runtime", r.startsWith("ERROR") && r.includes("unknown thinking level") && r.includes("off | minimal") && state.thinking === "medium");
r = await run("agency_control", { action: "set_thinking", level: "HIGH" });
check("set_thinking whitelist is case-sensitive", r.startsWith("ERROR") && r.includes("unknown thinking level") && state.thinking === "medium");
for (const lvl of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
  r = await run("agency_control", { action: "set_thinking", level: lvl });
  check(`set_thinking accepts whitelisted '${lvl}'`, r.includes(`→ effective '${lvl}'`));
}

// PI_AGENCY_DISABLE_THINKING
process.env.PI_AGENCY_DISABLE_THINKING = "1";
state.thinking = "medium";
r = await run("agency_control", { action: "set_thinking", level: "low" });
check("env disables set_thinking", r.startsWith("ERROR") && r.includes("PI_AGENCY_DISABLE_THINKING") && state.thinking === "medium");
r = await run("agency_status", {});
check("status toggle line shows thinking disabled", r.includes("PI_AGENCY_DISABLE_THINKING=on"));
delete process.env.PI_AGENCY_DISABLE_THINKING;

// PI_AGENCY_DISABLE_STATUS — action-time error, tool still registered, toggles still reported
process.env.PI_AGENCY_DISABLE_STATUS = "1";
check("status tool stays registered while disabled", !!tools["agency_status"]);
r = await run("agency_status", {});
check("env disables status with error, not unregistration", r.startsWith("ERROR") && r.includes("status is disabled") && r.includes("PI_AGENCY_DISABLE_STATUS"));
check("disabled status still reports effective toggle states", r.includes("PI_AGENCY_DISABLE_STATUS=on"));
delete process.env.PI_AGENCY_DISABLE_STATUS;

// PI_AGENCY_DISABLE_MODELS
process.env.PI_AGENCY_DISABLE_MODELS = "1";
check("models tool stays registered while disabled", !!tools["agency_models"]);
r = await run("agency_models", {});
check("env disables models with error", r.startsWith("ERROR") && r.includes("models is disabled") && r.includes("PI_AGENCY_DISABLE_MODELS"));
delete process.env.PI_AGENCY_DISABLE_MODELS;

// PI_AGENCY_DISABLE_USAGE — section='usage' ONLY; default view unaffected
process.env.PI_AGENCY_DISABLE_USAGE = "1";
r = await run("agency_status", { section: "usage" });
check("env disables usage section only", r.startsWith("ERROR") && r.includes("PI_AGENCY_DISABLE_USAGE"));
r = await run("agency_status", {});
check("default status view unaffected by usage disable", !r.startsWith("ERROR") && r.includes("model:") && !r.includes("usage (this session)"));
delete process.env.PI_AGENCY_DISABLE_USAGE;

// PI_AGENCY_READ_ONLY — blocks EVERY mutation, leaves every read working
process.env.PI_AGENCY_READ_ONLY = "1";
r = await run("agency_control", { action: "switch_model", model: "zai/glm-5.3" });
check("read-only blocks switch_model", r.startsWith("ERROR") && r.includes("PI_AGENCY_READ_ONLY") && state.model.id === "gemma-4-26b");
r = await run("agency_control", { action: "set_thinking", level: "low" });
check("read-only blocks set_thinking", r.startsWith("ERROR") && r.includes("PI_AGENCY_READ_ONLY") && state.thinking === "medium");
state.capturedCompact = "NOT-CALLED";
r = await run("agency_control", { action: "compact" });
check("read-only blocks compact scheduling", r.startsWith("ERROR") && r.includes("PI_AGENCY_READ_ONLY") && state.capturedCompact === "NOT-CALLED");
r = await run("agency_control", { action: "reload" });
check("read-only blocks reload scheduling", r.startsWith("ERROR") && r.includes("PI_AGENCY_READ_ONLY") && sentMessages.length === 0);
r = await run("agency_control", { action: "self_destruct" });
check("read-only gate covers unknown actions too", r.startsWith("ERROR") && r.includes("PI_AGENCY_READ_ONLY"));
r = await run("agency_status", {});
check("read-only leaves status working + reports read-only on", !r.startsWith("ERROR") && r.includes("model:") && r.includes("PI_AGENCY_READ_ONLY=on"));
r = await run("agency_models", {});
check("read-only leaves models working", r.includes("zai/glm-5.3"));
r = await run("agency_status", { section: "usage" });
check("read-only leaves usage section working", r.includes("usage (this session)"));

// read-only blocks the /agency reload COMMAND (manual dispatch path)
state.reloadCtxCalls.length = 0;
state.isIdle = true;
await commands["agency"].handler("reload", fakeCmdCtx());
check("read-only blocks /agency reload command", state.reloadCtxCalls.length === 0);
r = await run("agency_status", {});
check("read-only command refusal honest status", r.includes("reload: FAILED") && r.includes("PI_AGENCY_READ_ONLY"));

// read-only at FIRE time: a request scheduled before read-only still never mutates
state.capturedCompact = "NOT-CALLED";
await run("agency_control", { action: "compact", handoff: "pre-readonly" });
process.env.PI_AGENCY_READ_ONLY = "1";
events["agent_settled"]({}, fakeCtx());
check("read-only at fire time drops compact, never fires", state.capturedCompact === "NOT-CALLED");
r = await run("agency_status", {});
check("read-only fire-time compact drop honest status", r.includes("FAILED") && r.includes("PI_AGENCY_READ_ONLY") && !r.includes("compaction: scheduled"));
await run("agency_control", { action: "reload" }); // refused (read-only), never scheduled
process.env.PI_AGENCY_READ_ONLY = "0";
delete process.env.PI_AGENCY_READ_ONLY;
await run("agency_control", { action: "reload" }); // schedule while writable
process.env.PI_AGENCY_READ_ONLY = "1";
sentMessages.length = 0;
events["agent_settled"]({}, fakeCtx());
check("read-only at fire time drops reload, never sends", sentMessages.length === 0);
r = await run("agency_status", {});
check("read-only fire-time reload drop honest status", r.includes("reload: FAILED") && r.includes("PI_AGENCY_READ_ONLY"));
delete process.env.PI_AGENCY_READ_ONLY;

// handoff explicit UTF-8 byte limit (8192)
state.capturedCompact = "NOT-CALLED";
r = await run("agency_control", { action: "compact", handoff: "a".repeat(8192) });
check("handoff at exactly 8192 bytes accepted", r.includes("compact: scheduled"));
events["agent_settled"]({}, fakeCtx());
check("8192-byte handoff passed through intact", state.capturedCompact.customInstructions === "a".repeat(8192));
events["session_compact"]({}); // settle (agency-initiated → ok)
r = await run("agency_control", { action: "compact", handoff: "a".repeat(8193) });
check("handoff over 8192 bytes refused", r.startsWith("ERROR") && r.includes("8193 UTF-8 bytes") && r.includes("8192") && !r.includes("compact: scheduled"));
check("oversized handoff never scheduled", (await out("agency_status", {})).includes("compaction: last succeeded"));
r = await run("agency_control", { action: "compact", handoff: "\u00e9".repeat(4097) }); // 4097 chars = 8194 UTF-8 bytes
check("handoff limit counts UTF-8 bytes, not chars", r.startsWith("ERROR") && r.includes("8194 UTF-8 bytes") && !r.includes("compact: scheduled"));

// native session_compact with NO pending request/in-flight → reported separately
// (previously any native completion was reported as agency "last succeeded")
events["session_compact"]({}); // native (e.g. user /compact) with nothing agency-side pending
r = await run("agency_status", {});
check("native completion reported separately, not as agency success", r.includes("compaction: native compaction completed") && r.includes("not agency-initiated") && !r.includes("compaction: last succeeded"));

// ==== v0.1.5: tool failures throw — runtime sets isError only on throw ====
// run() above adapts the visible text shape; these call execute() DIRECTLY and
// assert real rejection, so the pi runtime marks isError on the result.
const direct = async (name, params) => {
  try { return { ok: await tools[name].execute("t1", params, undefined, undefined, fakeCtx()) }; }
  catch (e) { return { err: e }; }
};
let d = await direct("agency_status", {});
check("happy path still resolves (no throw)", d.ok?.content?.[0]?.text?.includes("model:") === true);
d = await direct("agency_control", { action: "switch_model", model: "badformat" });
check("invalid input rejects with typed error → runtime sets isError", d.err instanceof AgencyError && d.err.message.includes("provider/id") && !d.err.message.startsWith("ERROR:"));
d = await direct("agency_control", { action: "self_destruct" });
check("unknown action rejects typed", d.err instanceof AgencyError && d.err.message.includes("unknown action"));
d = await direct("agency_control", { action: "set_thinking", level: "ultra" });
check("bad thinking level rejects typed", d.err instanceof AgencyError && d.err.message.includes("unknown thinking level"));
d = await direct("agency_control", { action: "switch_model", model: "zai/glm-9.9" });
check("non-scoped model rejects typed", d.err instanceof AgencyError && d.err.message.includes("scoped set"));
process.env.PI_AGENCY_DISABLE_STATUS = "1";
d = await direct("agency_status", {});
check("disabled feature rejects typed (status)", d.err instanceof AgencyError && d.err.message.includes("status is disabled"));
delete process.env.PI_AGENCY_DISABLE_STATUS;
process.env.PI_AGENCY_DISABLE_MODELS = "1";
d = await direct("agency_models", {});
check("disabled feature rejects typed (models)", d.err instanceof AgencyError && d.err.message.includes("models is disabled"));
delete process.env.PI_AGENCY_DISABLE_MODELS;
process.env.PI_AGENCY_READ_ONLY = "1";
d = await direct("agency_control", { action: "compact" });
check("read-only mutation rejects typed", d.err instanceof AgencyError && d.err.message.includes("PI_AGENCY_READ_ONLY"));
delete process.env.PI_AGENCY_READ_ONLY;
// unexpected exception → typed, generic bounded message; no message/stack/URL leak
state.setModelThrows = true;
d = await direct("agency_control", { action: "switch_model", model: "zai/glm-5.3" });
check("unexpected exception rejects typed with bounded generic message, no leak", d.err instanceof AgencyError && d.err.message.includes("control failed") && !d.err.message.includes("boom") && !d.err.message.includes("http") && d.err.message.length < 300);
state.setModelThrows = false;

// echoed caller input is clipped to 100 chars — no unbounded echo in errors
const longX = "x".repeat(5000);
d = await direct("agency_control", { action: "switch_model", model: longX });
check("echoed model clipped to 100 chars", d.err instanceof AgencyError && d.err.message.includes("clipped from 5000 chars") && d.err.message.length < 300 && !d.err.message.includes("x".repeat(150)));
d = await direct("agency_control", { action: "set_thinking", level: "l".repeat(300) });
check("echoed level clipped", d.err instanceof AgencyError && d.err.message.includes("clipped from 300 chars") && d.err.message.length < 300);
d = await direct("agency_control", { action: "a".repeat(400) });
check("echoed action clipped", d.err instanceof AgencyError && d.err.message.includes("clipped from 400 chars") && d.err.message.length < 300);
// modelLine clips untrusted provider/id values (scope config is not fully trusted)
state.scoped.push({ model: { provider: "p".repeat(150), id: "m", contextWindow: 1, maxTokens: 1, reasoning: false } });
d = await direct("agency_models", {});
check("modelLine clips long provider/id echo", d.ok?.content?.[0]?.text?.includes("clipped from 150") === true && !d.ok.content[0].text.includes("p".repeat(150)));
state.scoped.pop();

// ==== v0.2: single public /agency command — help/status/info/config/enable/disable ====
// One command, subcommand dispatch, session-local toggles persisted as
// agency-config entries, env kill switches immutable on top, UI optional.

// help — bare and explicit; concise (subcommand list, not an essay)
let ui = mkUi();
await commands["agency"].handler("", fakeCmdCtx(ui.ui));
let cmd = ui.log.map((n) => n.m).join("\n");
check("/agency bare shows concise help", cmd.includes("/agency status") && cmd.includes("/agency info") && cmd.includes("/agency config") && cmd.includes("/agency enable|disable") && cmd.includes("/agency reload") && cmd.split("\n").length <= 10);
ui = mkUi();
await commands["agency"].handler("help", fakeCmdCtx(ui.ui));
check("/agency help shows the same concise help", ui.log[0]?.m === cmd);

// status subcommand mirrors the tool's default view + effective config
ui = mkUi();
await commands["agency"].handler("status", fakeCmdCtx(ui.ui));
cmd = ui.log[0].m;
check("/agency status shows model/thinking/context/compact/reload + config", cmd.includes("model: halo/gemma-4-26b") && cmd.includes("thinking:") && cmd.includes("context:") && cmd.includes("compaction:") && cmd.includes("reload:") && cmd.includes("toggles:") && cmd.includes("session config:"));

// info — purpose + limitations
ui = mkUi();
await commands["agency"].handler("info", fakeCmdCtx(ui.ui));
cmd = ui.log[0].m;
check("/agency info purpose + limitations", cmd.includes("purpose:") && cmd.includes("limitations:"));

// unknown subcommand
ui = mkUi();
await commands["agency"].handler("bogus", fakeCmdCtx(ui.ui));
check("/agency unknown subcommand error", ui.log[0]?.t === "error" && ui.log[0].m.includes("unknown subcommand"));

// headless: no ctx.ui at all — commands must not crash, toggles still apply
await commands["agency"].handler("", fakeCmdCtx());
await commands["agency"].handler("status", fakeCmdCtx());
await commands["agency"].handler("info", fakeCmdCtx());
await commands["agency"].handler("config", fakeCmdCtx());
check("/agency commands work headless with no ctx.ui (no crash)", true);

// enable/disable — no interaction needed; full-state entry persisted
appendedEntries.length = 0;
ui = mkUi();
await commands["agency"].handler("disable models", fakeCmdCtx(ui.ui));
check("/agency disable models receipt", ui.log[0].m.includes("disable models") && ui.log[0].m.includes("models: off"));
const cfg = appendedEntries[appendedEntries.length - 1];
check("agency-config entry shape {version:1,disabled,readOnly}", cfg?.customType === "agency-config" && cfg.data.version === 1 && JSON.stringify(cfg.data.disabled) === '["models"]' && cfg.data.readOnly === false);
r = await run("agency_models", {});
check("session disable blocks models tool at action time", r.startsWith("ERROR") && r.includes("disabled for this session") && r.includes("/agency enable models"));
r = await run("agency_status", {});
check("status shows session config with models disabled", r.includes("session config: disabled [models]") && r.includes("read_only: off"));

// env lock: env still wins even after a session enable (immutable kill switch)
process.env.PI_AGENCY_DISABLE_MODELS = "1";
ui = mkUi();
await commands["agency"].handler("enable models", fakeCmdCtx(ui.ui));
check("session enable warns env kill switch still forces off", ui.log[0].t === "warning" && ui.log[0].m.includes("PI_AGENCY_DISABLE_MODELS"));
r = await run("agency_models", {});
check("env kill switch beats session enable (immutable)", r.startsWith("ERROR") && r.includes("PI_AGENCY_DISABLE_MODELS"));
delete process.env.PI_AGENCY_DISABLE_MODELS;
r = await run("agency_models", {});
check("after env lifted, the session enable stands", !r.startsWith("ERROR") && r.includes("scoped model"));
await commands["agency"].handler("disable models", fakeCmdCtx(mkUi().ui));
await commands["agency"].handler("enable models", fakeCmdCtx(mkUi().ui));
r = await run("agency_models", {});
check("/agency enable models restores the tool", !r.startsWith("ERROR") && r.includes("scoped model"));

// unknown feature
ui = mkUi();
await commands["agency"].handler("enable bogus", fakeCmdCtx(ui.ui));
check("unknown feature refused, valid features listed", ui.log[0].t === "error" && ui.log[0].m.includes("unknown feature") && ui.log[0].m.includes("status") && ui.log[0].m.includes("read_only"));

// config — interactive: two selects (feature, then enable/disable)
appendedEntries.length = 0;
ui = mkUi(["models — on", "disable"]);
await commands["agency"].handler("config", fakeCmdCtx(ui.ui));
r = await run("agency_models", {});
check("/agency config applies via two selects", r.startsWith("ERROR") && r.includes("/agency enable models") && appendedEntries.some((e) => e.customType === "agency-config" && e.data.disabled.includes("models")));
await commands["agency"].handler("enable models", fakeCmdCtx(mkUi().ui));

// config — cancel paths: undefined select (Esc/timeout), explicit cancel at either step
appendedEntries.length = 0;
ui = mkUi([undefined]);
await commands["agency"].handler("config", fakeCmdCtx(ui.ui));
check("config cancel (no selection) changes nothing", ui.log[0].m.includes("cancelled") && appendedEntries.length === 0);
ui = mkUi(["cancel"]);
await commands["agency"].handler("config", fakeCmdCtx(ui.ui));
check("config cancel at feature step changes nothing", ui.log[0].m.includes("cancelled") && appendedEntries.length === 0);
ui = mkUi(["usage — on", "cancel"]);
await commands["agency"].handler("config", fakeCmdCtx(ui.ui));
check("config cancel at verb step changes nothing", ui.log[0].m.includes("cancelled") && appendedEntries.length === 0);

// config — non-TUI (hasUI false): instructions, never a select
ui = mkUi();
await commands["agency"].handler("config", fakeCmdCtx(ui.ui, { hasUI: false }));
check("config non-TUI shows enable/disable instructions, no select", ui.log[0].m.includes("/agency enable|disable") && ui.log[0].m.includes("features:") && ui.selectCalls() === 0);

// read_only session toggle
appendedEntries.length = 0;
ui = mkUi();
await commands["agency"].handler("enable read_only", fakeCmdCtx(ui.ui));
check("/agency enable read_only receipt", ui.log[0].m.includes("read_only: on"));
const roCfg = appendedEntries[appendedEntries.length - 1];
check("read_only persisted as separate boolean", roCfg?.customType === "agency-config" && roCfg.data.readOnly === true && !roCfg.data.disabled.includes("read_only"));
r = await run("agency_control", { action: "compact" });
check("session read-only blocks compact at schedule", r.startsWith("ERROR") && r.includes("read-only mode") && r.includes("/agency disable read_only"));
r = await run("agency_control", { action: "switch_model", model: "zai/glm-5.3" });
check("session read-only blocks switch", r.startsWith("ERROR") && r.includes("read-only mode"));
state.reloadCtxCalls.length = 0;
await commands["agency"].handler("reload", fakeCmdCtx());
check("session read-only blocks /agency reload command", state.reloadCtxCalls.length === 0);
r = await run("agency_status", {});
check("awareness reads still work under session read-only", !r.startsWith("ERROR") && r.includes("read_only: on"));
// env lock on read_only: env on + session disable → still read-only, warned
process.env.PI_AGENCY_READ_ONLY = "1";
ui = mkUi();
await commands["agency"].handler("disable read_only", fakeCmdCtx(ui.ui));
check("session disable read_only warns env forces it on", ui.log[0].t === "warning" && ui.log[0].m.includes("PI_AGENCY_READ_ONLY"));
r = await run("agency_control", { action: "compact" });
check("env read-only beats session disable", r.startsWith("ERROR") && r.includes("PI_AGENCY_READ_ONLY"));
delete process.env.PI_AGENCY_READ_ONLY;
await commands["agency"].handler("disable read_only", fakeCmdCtx(mkUi().ui));
r = await run("agency_control", { action: "compact" });
check("mutations restored after read_only disabled", r.includes("compact: scheduled"));
events["agent_settled"]({}, fakeCtx());
events["session_compact"]({}); // settle

// fire-time session guards: schedule while enabled, disable before the boundary
state.capturedCompact = "NOT-CALLED";
await run("agency_control", { action: "compact", handoff: "h-s" });
await commands["agency"].handler("disable compact", fakeCmdCtx(mkUi().ui));
events["agent_settled"]({}, fakeCtx());
check("session disable at fire time drops compact, never fires", state.capturedCompact === "NOT-CALLED");
r = await run("agency_status", {});
check("fire-time session compact drop honest status", r.includes("compaction: last FAILED") && r.includes("/agency enable compact"));
await commands["agency"].handler("enable compact", fakeCmdCtx(mkUi().ui));

await run("agency_control", { action: "reload" });
await commands["agency"].handler("disable reload", fakeCmdCtx(mkUi().ui));
sentMessages.length = 0;
events["agent_settled"]({}, fakeCtx());
check("session disable at fire time drops reload, never sends", sentMessages.length === 0);
r = await run("agency_status", {});
check("fire-time session reload drop honest status", r.includes("reload: FAILED") && r.includes("/agency enable reload"));
await commands["agency"].handler("enable reload", fakeCmdCtx(mkUi().ui));

// persistence: session_start restores the LAST valid agency-config entry from
// the CURRENT BRANCH (getBranch) — reload/resume keep the session-local config
appendedEntries.length = 0;
await commands["agency"].handler("disable usage", fakeCmdCtx(mkUi().ui));
await commands["agency"].handler("enable read_only", fakeCmdCtx(mkUi().ui));
events["session_start"]({ reason: "reload" }, fakeCtx());
r = await run("agency_status", { section: "usage" });
check("config restored across reload — usage still disabled session-locally", r.startsWith("ERROR") && r.includes("/agency enable usage"));
r = await run("agency_control", { action: "set_thinking", level: "low" });
check("config restored across reload — read_only still on", r.startsWith("ERROR") && r.includes("/agency disable read_only"));

// validation: corrupt/unknown entries are skipped; last VALID entry wins
state.branchEntries = [
  { type: "message" },
  { type: "custom", customType: "other-ext", data: { version: 1, disabled: ["status"] } },
  { type: "custom", customType: "agency-config", data: { version: 2, disabled: ["status"], readOnly: true } },
  { type: "custom", customType: "agency-config", data: { version: 1, disabled: ["status", "bogus", 42, "read_only"], readOnly: "yes" } },
  { type: "custom", customType: "agency-config", data: null },
];
events["session_start"]({ reason: "startup" }, fakeCtx());
r = await run("agency_status", {});
check("restore validates: garbage disabled filtered, only status disabled", r.startsWith("ERROR") && r.includes("/agency enable status"));
r = await run("agency_models", {});
check("restore leaves other features enabled", !r.startsWith("ERROR"));
r = await run("agency_control", { action: "set_thinking", level: "low" });
check("restore treats non-boolean readOnly as false — not read-only", !r.startsWith("ERROR") && r.includes("effective 'low'"));
state.thinking = "medium";
state.branchEntries = [];
events["session_start"]({ reason: "resume" }, fakeCtx());
r = await run("agency_models", {});
check("empty branch restores clean defaults", !r.startsWith("ERROR"));
state.branchEntries = null;
events["session_compact"]({}); // restore the native-compaction precondition the per-factory test below asserts on

// ==== v0.1.5: per-factory state — two module instances never share bookkeeping ====
const rt2 = (() => {
  const tools = {}, events = {}, commands = [], sent = [];
  ext({
    on: (ev, h) => (events[ev] = h),
    registerTool: (t) => (tools[t.name] = t),
    registerCommand: (n, o) => (commands[n] = o),
    appendEntry: () => {},
    sendUserMessage: (content, options) => { sent.push({ content, options }); return Promise.resolve(); },
    getThinkingLevel: () => state.thinking,
    setThinkingLevel: (l) => (state.thinking = l),
    setModel: fakePi.setModel,
  });
  return { tools, events, sent };
})();
const run2 = async (name, params) => {
  try { return (await rt2.tools[name].execute("t2", params, undefined, undefined, fakeCtx())).content[0].text; }
  catch (e) { if (e instanceof AgencyError) return `ERROR: ${e.message}`; throw e; }
};
state.capturedCompact = "NOT-CALLED";
const r2 = await run2("agency_control", { action: "compact", handoff: "instance-b" });
check("instance B schedules its own compact", r2.includes("compact: scheduled"));
r = await run("agency_status", {});
check("instance A keeps its own state, untouched by B's scheduling", r.includes("compaction: native") && !r.includes("compaction: scheduled"));
events["agent_settled"]({}, fakeCtx());
check("instance A boundary fires nothing for B's request", state.capturedCompact === "NOT-CALLED");
rt2.events["agent_settled"]({}, fakeCtx());
check("instance B boundary fires its own compact", state.capturedCompact?.customInstructions === "instance-b");
rt2.events["session_compact"]({}); // settle B's state
state.capturedCompact = "NOT-CALLED";

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
