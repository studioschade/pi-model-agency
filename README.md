# pi-model-agency

## Memory is identity. Models are instruments.

An agent’s identity lives in its memory, not in the model answering its next prompt. Its remembered experiences, commitments, relationships, and accumulated lessons form a continuity that no single model owns. A model supplies a way of thinking. Changing that model can change the agent’s capabilities and perspective without requiring it to begin again as someone else.

**Pi Model Agency** turns that philosophy into practical control. Agents can choose from a curated list of models, adjust their thinking level, manage compaction, and reload Pi itself. These become decisions an agent can make in the course of its work, rather than fixed conditions it must work around.

That control enables greater autonomy and a more deliberate form of self-modification. An agent can recognize a limitation, revise its approach, modify its harness with its existing tools, and reload to put those changes into use. Its working environment becomes something it can help develop, not merely something it inhabits.

The aim is more than access to a stronger model. It is an agent that can participate in shaping how it thinks and works, carrying its history forward while changing the instruments it uses.

## Runtime controls

A [Pi](https://github.com/earendil-works/pi) extension for on-demand runtime awareness and session control.

```text
agent asks                         Pi-owned boundary               observed result
──────────                         ─────────────────               ───────────────
agency_models  ────────────────►   this session's scoped models  ──► choices, not the full catalog
agency_control(switch_model) ──►   scope + auth check            ──► applied or refused
agency_control(compact) ──────►   idle run boundary             ──► scheduled → succeeded/failed
agency_control(reload) ───────►   registered Pi command        ──► scheduled → runtime-confirmed
```

### First interaction

After installing, ask your agent: “Run `agency_status`, then list my available models with `agency_models`. Don't change anything.” A default status response looks like:

```text
model: provider/model-name (ctx 131072, maxTokens 32768, reasoning yes)
thinking: medium
context: ~16067 / 131072 tokens (~12%) — Pi estimate, not exact
scope: 3 scoped model(s)
compaction: none requested
reload: none requested
toggles: ...
```

This is illustrative output, **not** a live reading of your session. For reported usage/cost, call `agency_status({"section":"usage"})` separately; cost is provider-reported, not an invoice.

## Install

```bash
pi install npm:pi-model-agency
```

Pi packages run with your account's permissions, so review the source before installing. Requires Node.js 22.19 or later. Tested with `@earendil-works/pi-coding-agent` 0.87.1.

Pi's **explicit session model scope** is the authority for agent-driven switching. With no scope configured, `agency_models` explains that the session is unscoped and `switch_model` refuses; use Pi's interactive `/model` instead or launch with an explicit `--models` scope. A Pi resource reload does **not** update that process-start scope; restart the session to change it.

## One command for people: `/agency`

The agent uses the three tools below; **you** get a single slash-command entry point:

```text
/agency                    show command help
/agency status             current model, context, run state and effective configuration
/agency info               what the extension does and its limits
/agency config             choose a feature and enable/disable it interactively in the TUI
/agency disable switch     stop agent-initiated switching in this session
/agency enable switch      turn it back on in this session
/agency enable read_only   block all agency mutations in this session
/agency disable read_only  clear the session-level read-only setting
/agency reload             refresh Pi resources now, only when idle
```

Features: `status | models | usage | switch | thinking | compact | reload | read_only`. These command settings are **session-local**, saved as non-LLM custom entries in the current session branch and restored on resume or reload. In a headless session, use `/agency enable|disable <feature>` instead of the interactive `/agency config` picker. An environment kill switch always wins: `/agency enable switch` cannot bypass `PI_AGENCY_DISABLE_SWITCH=1`. `/agency status` remains an operator view even if the `agency_status` tool was disabled. Enabling `read_only` is a restriction; disabling it removes only the session setting, not an environment lock.

## Tools

| Tool | What the agent gets |
| --- | --- |
| `agency_status` | Current model and thinking, Pi's estimated context occupancy, scoped-model count, compact/reload state, and effective feature toggles. `section: "usage"` adds session-file token totals and provider-reported cost estimate. |
| `agency_models` | Models in the session's **existing** scope, optionally filtered by a case-insensitive substring. An empty scope is *unscoped*, not “zero models.” |
| `agency_control` | `switch_model`, `set_thinking`, `compact`, or `reload`. The tool reports refusal, effective change, or a **scheduled** operation—not an invented completion. |

**Example control inputs:**

```json
{"action":"switch_model","model":"provider/model-id"}
{"action":"set_thinking","level":"high"}
{"action":"compact"}
{"action":"reload"}
```

- `switch_model` requires the exact `provider/id` returned by `agency_models` and configured authentication. Concurrent switch requests are refused. When Pi provides a token estimate exceeding the destination context window, switching is refused; an unknown estimate produces a warning, not a guarantee of fit. The receipt distinguishes a confirmed live readback from a runtime-accepted switch whose readback is not visible yet. A provider switch can lose a warm prompt cache or fail if an in-flight provider request disappears.
- `set_thinking` accepts `off | minimal | low | medium | high | xhigh | max`. Pi may clamp the requested level for the current model; the receipt shows the effective level.
- `compact` runs Pi's native summarizer after the requesting turn settles. Pi already creates a structured summary, so omit `handoff` by default. For a specific point that needs emphasis, pass brief `handoff` guidance (up to 8,192 UTF-8 bytes) to Pi's summarizer; inclusion is not guaranteed. Check `agency_status` for the outcome.
- `reload` refreshes extensions, skills, prompts, themes and context resources using Pi's supported `/agency reload` command API at a settled boundary. It preserves the session; it does not restart the process or automatically replay work. A status receipt says **completed** only after Pi emits its reload startup event. If this version was just added to an already-running Pi, a single interactive `/reload` loads it first.

A busy boundary drops a pending compact/reload with a failure receipt; it does not silently retry. Headless print/JSON sessions may dispose before a deferred operation finishes: “scheduled” or “dispatched” never means completion.

## Toggle each capability

Use `/agency config` or `/agency enable|disable <feature>` for **session** preferences. For a stronger operator kill switch, set environment variables **before starting Pi** (or change them for the running process before an action; checks happen at action time). Values `1`, `true`, and `yes` are accepted case-insensitively. Env locks take priority over `/agency` session choices. These are *extension policy knobs*, **not a sandbox** against an agent with shell access.

| Environment variable | Effect |
| --- | --- |
| `PI_AGENCY_DISABLE_STATUS=1` | Refuse `agency_status` (the error still explains effective toggles). |
| `PI_AGENCY_DISABLE_MODELS=1` | Refuse `agency_models`. |
| `PI_AGENCY_DISABLE_USAGE=1` | Refuse only `agency_status` with `section: "usage"`; the default view works. |
| `PI_AGENCY_DISABLE_SWITCH=1` | Refuse agent model switching. |
| `PI_AGENCY_DISABLE_THINKING=1` | Refuse thinking changes. |
| `PI_AGENCY_DISABLE_COMPACT=1` | Refuse agency compaction, including a previously scheduled request before it fires. |
| `PI_AGENCY_DISABLE_RELOAD=1` | Refuse agency reload, including the `/agency reload` command. |
| `PI_AGENCY_READ_ONLY=1` | Refuse **all** `agency_control` actions and `/agency reload`, while leaving awareness available unless separately disabled. |

Tools remain registered when disabled, so a caller receives a clear refusal instead of an unexplained missing tool. No extension CLI flags are registered. Example: `PI_AGENCY_READ_ONLY=1 pi`.

## Design boundaries

- **On demand:** model, context and usage details appear when requested.
- **Session scoped:** model choices follow Pi's configured scope and authentication; `/agency` settings apply to the current session.
- **Honest readings:** context and cost figures are estimates. Status distinguishes scheduled work from completed work and failures.

## Development

```bash
npm ci
npm run typecheck        # strict TypeScript validation against Pi's public types
npm test                 # deterministic behavioral checks
npm run test:sdk         # real Pi SDK reload lifecycle; no model/network
npm run pack:check       # verifies the license and the exact package contents
```

Tests use private SDK hooks **only inside the test harness** to drive an idle boundary without inference. The runtime extension uses documented Pi APIs.

## License

[GPL-3.0-only](LICENSE).
