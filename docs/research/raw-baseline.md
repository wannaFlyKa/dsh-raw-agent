# Raw baseline: what "raw" means in SDK mode

Phase 1 research note (topic: raw-baseline). Versions: Claude Code CLI 2.1.318, Agent SDK 0.3.318, DSH 0.2.2-rc.1.
Evidence aliases: `CLI 2.1.318 binary` (string dump of the native binary; names are its minified function names), `SDK/sdk.d.ts:N`, `SDK/sdk.mjs fn X`, `P/<dsh package>/lib/...`, `t3code/<path>` (commit 337c5858). Live probes are named by their scratch file (for example `probe p2-leak`). All probes used `claude-sonnet-5-5`, a scratch git repo, and a clean env.

## Answers for the design

1. **Pass the preset explicitly.** If `systemPrompt` is omitted, the SDK sends an **empty** custom prompt, not the Claude Code prompt (`SDK/sdk.mjs fn Jx`: `systemPrompt===undefined → ""`). Use `systemPrompt: {type:'preset', preset:'claude_code'}` with no `append`.
2. **With no append, SDK mode equals plain `claude -p`** in the identity line and the system prompt text (live: `diff-p-vs-warm.txt` shows identity SAME, system prompt SAME). The identity line is `You are a Claude agent, built on Anthropic's Claude Agent SDK.` The TUI line is `You are Claude Code, Anthropic's official CLI for Claude.` That difference is CLI-chosen (non-interactive mode) and cannot be removed without an append, which the raw contract forbids. Accept it, and document it.
3. **Set `canUseTool`.** Without it the session has no `AskUserQuestion`, `EnterPlanMode` or `ExitPlanMode` (21 tools; `claude -p` is the same). With it the wire tool names match the TUI exactly (live: `canuse` and `warm` vs `tui`: "wire tool names: SAME").
4. **Set `toolConfig.askUserQuestion.previewFormat: 'markdown'`. This matches the TUI; it is not forcing.** The TUI picks `markdown` by itself: at startup the CLI sets the preview format to `markdown` for the `cli` client type, and leaves it unset for every `sdk-*` entrypoint (CLI 2.1.318 binary, the client-type block that calls `setQuestionPreviewFormat`). With the option, the SDK tool definition is byte-identical to the TUI's; without it, only the "Preview feature" paragraph is missing (the schema, with its `preview` field, is the same). Two rules: do not set it when the user's env already has `CLAUDE_CODE_QUESTION_PREVIEW_FORMAT` (the SDK would overwrite the user's value, while the TUI honours it), and never pick `html` (Round 2).
5. **The remaining SDK vs TUI differences are CLI-varied and acceptable:** the identity line, one system-prompt bullet about the `!` prefix, Agent/Bash background wording, and the built-in `claude-code-guide` agent (hidden when the entrypoint is `sdk-*`). Do not try to fix them with env flags.
6. **Resume keeps the recorded prompt.** A session started in the TUI and resumed through the SDK sends the same system+tools shape as the TUI (same `shapeHash`, TUI identity line). So identity is fixed by the first request, until compaction.
7. **Strip exactly these host variables** (section 2): `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_HOST_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_SESSION_KIND`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_EXECPATH`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_EFFORT`, `CLAUDE_PID`. Also `AI_AGENT` only when it starts with `claude-code`. Strip `TRACEPARENT`/`TRACESTATE` only when `CLAUDECODE` was present (they then belong to the host). Keep everything else, including all tokens and keys.
8. **Do not use DSH's `scrubbedParentEnv()`** or `ctx.subprocess` defaults for the CLI env. They drop every name matching `/KEY|PASSWORD|SECRET|TOKEN/i` (`P/dsh-subprocess/lib/index.js:32,50-56`), which breaks rule 5. Build the env from `process.env` and apply only our strip list (plus DSH's `DSH_*` convention, see Open questions).
9. **The SDK itself changes the env:** it sets `CLAUDE_CODE_ENTRYPOINT=sdk-ts` and `CLAUDE_AGENT_SDK_VERSION` only when absent, adds `CLAUDE_CODE_SDK_READS_SESSION_STATE=1`, and **deletes `NODE_OPTIONS` and `DEBUG`** (`SDK/sdk.mjs` ProcessTransport spawn and `query()` env block). The `NODE_OPTIONS` loss is an SDK deviation from raw; document it.
10. **TUI-only features:** 21 typed commands answer "`/x` isn't available in this environment" in SDK mode (live: `sdk-commands.jsonl`), and the status line command never runs (live: `probe p2-*`). Each has an SDK control or a DSH-native view as its closest raw equivalent (section 3). No feature needs a hidden prompt or an extra `claude` process.

## 1. Prompt snapshot diff: SDK preset vs TUI vs `claude -p`

### Method

Each run was one tiny turn ("say hi") in the same scratch repo. The comparison uses the Claude transcript records `prompt_snapshot`, `api-request-shape` (wire system blocks and tools), the context attachments, and `api-request` params. Script: `analyze.py`. Runs:

| Name | How | Transcript `entrypoint` |
|---|---|---|
| `sdk` | `query()`, preset, no append, string prompt, no `canUseTool` | `sdk-ts` |
| `canuse` | as `sdk` + `canUseTool` | `sdk-ts` |
| `warm` | as `canuse`, streaming input, first prompt after a delay (MCP connected) | `sdk-ts` |
| `p` | `claude -p "say hi" --model claude-sonnet-5-5` | `sdk-cli` |
| `tui` | interactive `claude`, typed "say hi" | `cli` |

### Identity line

| Mode | Wire `system[0]` |
|---|---|
| TUI | `You are Claude Code, Anthropic's official CLI for Claude.` |
| SDK preset, no append | `You are a Claude agent, built on Anthropic's Claude Agent SDK.` |
| `claude -p` | `You are a Claude agent, built on Anthropic's Claude Agent SDK.` |
| SDK preset **with** append (dsh-claude) | `You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.` |

Source: CLI 2.1.318 binary fn `tcr`: Vertex → TUI line; a recorded snapshot → the recorded line; non-interactive → the "running within" line if there is an append, else the "Claude agent" line; otherwise the TUI line. Live: `summary.txt` (wire system blocks for `sdk`, `p`, `tui`).

### System prompt body

- SDK (no append) vs `claude -p`: **identical** (`diff-p-vs-warm.txt`: "system prompt (snapshot parts): SAME").
- SDK vs TUI: one extra bullet in the TUI only: "If you need the user to run a shell command themselves …, suggest they type `! <command>` in the prompt …" (`diff-warm-vs-tui.txt`). This matches the fact that `!` is TUI-only: in SDK mode `!echo bang-probe` reaches the model as plain user text (live: `probe pv`, the transcript user record is the literal text and the model chose to call Bash).

### Tools

| Item | TUI | SDK + `canUseTool` | SDK, no `canUseTool` | `claude -p` |
|---|---|---|---|---|
| Wire tools (13 incl. placeholder) | includes `AskUserQuestion` | same names as TUI | no `AskUserQuestion` | no `AskUserQuestion` |
| Deferred `EnterPlanMode`, `ExitPlanMode` | yes | yes | no | no |
| `system/init.tools` count (MCP not yet connected) | n/a | 24 | 21 | 169 with MCP |
| AskUserQuestion "Preview feature" text | yes (CLI default `markdown` for the `cli` client) | only with `toolConfig.askUserQuestion.previewFormat` (then byte-identical to TUI) | no | no |
| Agent tool | "Subagents run in the background"; no `run_in_background` param | `run_in_background` param, background by default | same as SDK | same as SDK |
| Bash `run_in_background` text | no timeout sentence | "default 1800000" | same | "default 600000" |
| Built-in `claude-code-guide` agent in agent listing | yes | **no** | no | no |

Evidence: `diff-canuse-vs-tui.txt`, `diff-warm-vs-tui.txt`, `diff-p-vs-warm.txt`; init tool lists in `sdk-*.jsonl` and `claude-p-stream.jsonl`; `probe pv` ("Ask has Preview feature: True"). `claude-code-guide` is pushed only when `CLAUDE_CODE_ENTRYPOINT` is not `sdk-ts`/`sdk-py`/`sdk-cli` (CLI 2.1.318 binary, the agent list builder that pushes `Mpn`). The docs say `AskUserQuestion` goes through `canUseTool` (Agent SDK docs, "Handle approvals and user input").

### Context attachments and params

- Same in all modes: `environment`, `model`, `date`, `skill_listing`, `mcp_instructions_delta` (once MCP is connected).
- `deferred_tools_delta` and `mcp_instructions_delta` differ only by timing: the first SDK request can run while MCP servers are "still connecting" (`diff-canuse-vs-tui.txt`). With MCP connected (`warm`) they equal the TUI. **Design note:** the CLI decides this timing; do not delay the user's first prompt to hide it.
- `session_context` differs only by the git status of the scratch repo.
- Request params: SDK and TUI send `thinking.display: "updates"`; `claude -p` sends `"omitted"`. Effort `medium` in all (from the user's settings).

### Resume keeps the recorded prompt

A TUI session resumed with `query({resume})` (preset, no append) sent its next request with the same `shapeHash` as the TUI request, whose shape has the TUI identity line and the TUI tool texts (live: `sdk-resume.mjs`, `transcript-tui-resumed-by-sdk.jsonl`, records 17 and 40). This follows the snapshot rule in `SDK/sdk.d.ts:4756` ("Record the conversation's system prompt once and reuse it verbatim on every later request and resume … until compaction"). The reverse (SDK session opened in the TUI) is **unverified**, but the same rule applies.

### Check for R2.1

Compare our session's first `prompt_snapshot` with a `claude -p` snapshot from the same folder. Allowed differences: `AskUserQuestion`/`EnterPlanMode`/`ExitPlanMode` (from `canUseTool`), the AskUserQuestion "Preview feature" paragraph (from `previewFormat`, matching the TUI), the Bash background-timeout sentence, `thinking.display`, git status and MCP timing. Anything else is a bug.

## 2. Host Claude Code session variables

### Where they come from

When a Claude Code session runs a command (Bash, hooks, MCP stdio), the CLI adds session markers to that child's env. A DSH started from such a shell inherits them, and so would our `claude` child.

- CLI 2.1.318 binary fn `udt` builds the markers: `CLAUDECODE=1`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION=1`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_PID`, `AI_AGENT` (agent source), `CLAUDE_EFFORT`, `TRACEPARENT` (only when tracing is on).
- fn `TXr` (Bash env) = parent env + `SHELL` + `GIT_EDITOR=true` + overrides + `udt(...)`.
- At startup the CLI sets on its own `process.env`: `NoDefaultCurrentDirectoryInExePath=1`, `COREPACK_ENABLE_AUTO_PIN=0`, `AI_AGENT` (fn `dHr`), and `CLAUDE_CODE_MESSAGING_SOCKET` / `CLAUDE_CODE_MESSAGING_TOKEN` (messaging setup).
- The CLI's spawn-env key list (`BNo`) also names `CLAUDE_CODE_EXECPATH` and `CLAUDE_CODE_INVOKED_SKILLS`.
- The SDK adds `CLAUDE_CODE_ENTRYPOINT=sdk-ts` and `CLAUDE_AGENT_SDK_VERSION` **only if absent** (`SDK/sdk.mjs`, `query()` env block: `if(!gt.CLAUDE_CODE_ENTRYPOINT)…`).

Live (`envprobe-*.out`, a Bash command run by an SDK session): the child saw `CLAUDECODE=1`, `CLAUDE_CODE_ENTRYPOINT=sdk-ts`, `CLAUDE_CODE_CHILD_SESSION=1`, `CLAUDE_CODE_SESSION_ATTENDED=0`, `CLAUDE_EFFORT=medium`, `AI_AGENT=claude-code_2-1-318_agent`, `CLAUDE_AGENT_SDK_VERSION=0.3.318`, `GIT_EDITOR=true`, `COREPACK_ENABLE_AUTO_PIN=0`, `CLAUDE_CODE_SESSION_ID=<uuid>`, `CLAUDE_PID`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_EXECPATH`, plus the user's settings `env` values. The CLI already removes `CLAUDE_CODE_SDK_*` markers and `OTEL_*` from tool children (CLI 2.1.318 binary, the env builder that deletes the `$e` set), so those do not leak.

### What a leaked variable does to our session

| Variable | Effect if inherited | Evidence |
|---|---|---|
| `CLAUDE_CODE_CHILD_SESSION` | The CLI treats itself as a nested child: `gT()` true ("nested session"), `U1()` (attended) false, some features gated off by `vp()`/`RWn()`. | CLI fns `T3i`, `U1`, `gT`, `vp`, `RWn` |
| `CLAUDECODE` | Sets the `claudecode` host flag. | fn `T3i` |
| `CLAUDE_CODE_ENTRYPOINT` | The SDK keeps the host value. Live: a leaked `cli` made the transcript `entrypoint` `sdk-cli` instead of `sdk-ts`. | `probe p2-clean` vs `probe p2-leak`; `SDK/sdk.mjs` env block |
| `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_HOST_SESSION_ID` | Read as lineage: "descendant" detection and the session-refs latch; `hostSessionId` in the session registry. | fns `o()` (descendant), `I8e`, `I_o` |
| `CLAUDE_CODE_SESSION_ATTENDED` | Read as "spawned by an attended session". | fn `T3i` |
| `CLAUDE_CODE_MESSAGING_SOCKET` / `_TOKEN` | Per-process peer-messaging socket. An inherited value points at the host's socket. (The CLI overwrites the socket when it sets up its own inbox; whether it always does in SDK mode is **unverified**.) | messaging setup code; t3code comment |
| `CLAUDE_CODE_SESSION_KIND` | `bg` marks a background session; `U1()` then returns false. Not seen live; only if DSH was started from a `claude --bg` job. | fn `U1`, startup |
| `CLAUDE_AGENT_SDK_VERSION` | The SDK keeps the host value (wrong version reported). | `SDK/sdk.mjs` env block |
| `CLAUDE_EFFORT` | Not an input: a leaked `max` did not change the request effort (`medium`). Strip for cleanliness; the CLI re-sets it for its children. | `probe p2-leak` (`output_config.effort`) |
| `CLAUDE_PID`, `CLAUDE_CODE_EXECPATH` | Point at the host process and binary; the CLI re-sets them for its own children. | fn `udt`, `BNo` |
| `AI_AGENT` | Harmless: the CLI rewrites it when it starts with `claude-code_` or `claude-code/`. Strip only that form, keep a user value. | fn `dHr` |
| `TRACEPARENT`, `TRACESTATE` | Would link our spans to the host trace. The SDK removes them only when it has its own active span. | fn `udt`; `SDK/sdk.mjs` env block |
| `GIT_EDITOR=true`, `COREPACK_ENABLE_AUTO_PIN=0`, `NoDefaultCurrentDirectoryInExePath=1` | No effect: the CLI sets the same values itself. A user may set `GIT_EDITOR` on purpose. **Keep.** | startup code, fn `TXr` |
| Settings `env` values (for example `CLAUDE_CODE_USE_BEDROCK`, `ANTHROPIC_DEFAULT_*_MODEL`) | No effect: the CLI applies settings `env` itself. They may also be the user's shell values. **Keep.** | `envprobe-*.out` |

The `probe p2-leak` run was then blocked by the auto-mode classifier and ended with a model safeguard error. One sample cannot show whether the leak caused this, so it is **not** attributed to the leak.

### Comparison with other hosts

- t3code strips `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_HOST_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_EXECPATH`, `CLAUDE_CODE_DESKTOP_APP_VERSION`, `CLAUDE_EFFORT`, `CLAUDE_PID`, `CLAUDE_AGENT_SDK_VERSION`, and sets `CLAUDE_CODE_ENTRYPOINT=t3-code` (`t3code/apps/server/src/provider/Drivers/ClaudeHome.ts:48-87`). Setting the entrypoint is a forced flag for us (rule 4), so we only delete it.
- `CLAUDE_CODE_DESKTOP_APP_VERSION` is read only when the entrypoint is `claude-desktop`/`local-agent` (CLI fn `gDr`). Once the entrypoint is stripped it has no effect; strip it too for parity with t3code (optional).
- dsh-claude strips none of these (evaluation L2c).
- DSH's own `scrubbedParentEnv()` drops `DSH_*` and every `/KEY|PASSWORD|SECRET|TOKEN/i` name (`P/dsh-subprocess/lib/index.js:32,50-56`). Rule 5 forbids the second part.

### Final list (for `docs/architecture.md`)

Always delete (case-insensitive on Windows): `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_HOST_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_SESSION_KIND`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_EXECPATH`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_DESKTOP_APP_VERSION`, `CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_EFFORT`, `CLAUDE_PID`.
Conditional: `AI_AGENT` if it starts with `claude-code`; `TRACEPARENT`/`TRACESTATE` if `CLAUDECODE` was present.
Never delete anything else. Re-check this list on each CLI upgrade: the names come from minified code.

Acceptance check (R2.4): start the test DSH from inside a Claude Code shell, then compare `/proc/<cli pid>/environ` with the DSH process env. The only differences must be the list above plus the SDK's own additions and its `NODE_OPTIONS`/`DEBUG` removal.

## 3. TUI-only features and the closest raw equivalent

Live (`sdk-commands.jsonl`): these typed commands return "`/x` isn't available in this environment." with zero turns and zero cost: `/btw`, `/tasks`, `/workflows`, `/status`, `/help`, `/theme`, `/hooks`, `/skills`, `/resume`, `/permissions`, `/memory`, `/ide`, `/copy`, `/rewind`, `/statusline`, `/login`, `/plugin`, `/plan`, `/keybindings`, `/terminal-setup`. These work headless and print text: `/config` (usage text; `/config key=value` writes the user's config, so only when the user types it), `/mcp` (summary), `/model` (current model and aliases), `/cost`, `/agents` (removal notice). `supportedCommands()` returned 57 entries, including `context`, `usage`, `compact`, `clear`, `effort`, `model`, `mcp`, `reload-plugins`, `reload-skills` and all skills.

| TUI feature | In SDK mode | Closest raw equivalent |
|---|---|---|
| Status line (`statusLine` command) | Not run. A project-local `statusLine` that writes a marker file never ran in two SDK sessions (live `probe p2-*`). | Show the same facts natively (model, cost, context, limits) from SDK data. Optional: run the user's own `statusLine` command with JSON on stdin built from SDK data. It is the user's own config, not a `claude` process, but the JSON is our reconstruction (**unverified** fidelity); keep it opt-in. |
| Typed `/btw` | "isn't available" (live). | `Query.askSideQuestion(question, {history})` sends the CLI's `side_question` request, the same engine (`SDK/sdk.mjs` fn `askSideQuestion`; `SDK/sdk.d.ts:5297`). Claim `/btw` in the client input so it never becomes a turn. |
| Permission dialogs | No TTY dialog. | `canUseTool` with the CLI's `suggestions` (allow once / always / deny with message). |
| AskUserQuestion dialog | Only with `canUseTool` (section 1). | `canUseTool` returning `updatedInput.answers`; `toolConfig.askUserQuestion.previewFormat: 'markdown'` to get the TUI tool text; render option `preview` strings as Markdown in a monospace box, single-select only, as the TUI does. |
| Plan approval dialog, `/plan` | `/plan` not available. | `canUseTool('ExitPlanMode')`; `setPermissionMode('plan')`. |
| Other blocking dialogs (for example the refusal fallback that offers another model) | Not shown: without `supportedDialogKinds` the flow falls back to the plain error (`SDK/sdk.d.ts:1830-1864`). | `onUserDialog` + `supportedDialogKinds: ['refusal_fallback_prompt']` once the UI can render it. |
| MCP auth / elicitation dialogs, `/mcp` panel | `/mcp` prints a summary. | `onElicitation` (`SDK/sdk.d.ts:1818-1828`); `mcpServerStatus()`, `reconnectMcpServer()`, `toggleMcpServer()`. |
| `/model` picker, `/effort` | `/model <name>` works as text. | `supportedModels()` + `setModel()`; `applyFlagSettings({effortLevel})` (session flag layer, no file write). |
| `/permissions`, `/hooks`, `/memory`, `/config` dialogs | Not available (except `/config key=value`). | Quick-open of the three settings files and CLAUDE.md files (R1.3). Read-only hook view from `hook_started`/`hook_response` events. |
| `/status` | Not available. | `system/init`, `accountInfo()`, `initializationResult()`. |
| `/skills`, `/help` | Not available. | DSH `/` menu from `supportedCommands()`. |
| `/tasks`, `/workflows`, Ctrl+B | Not available. | `system/task_*` events → DSH jobs; `stopTask()`. |
| `/resume` | Not available. | DSH session list; `resume` option; SDK `listSessions()`. |
| `/rewind`, Esc Esc | Not available. | `resumeSessionAt` for the conversation; `rewindFiles()` (needs `enableFileCheckpointing`) for files. |
| `/copy`, `/theme`, `/keybindings`, `/terminal-setup`, `/statusline`, vim mode, `/ide` | Not available. | DSH UI and DSH plugins. No Claude equivalent is needed. |
| `/login` | Not available. | Tell the user to run `claude auth login` in a terminal (a process the user starts). |
| `/plugin` | Not available. | `reloadPlugins()`; install with the `claude plugin` CLI only when the user asks. |
| `!` bash prefix | Goes to the model as text (live `probe pv`). | DSH's own terminal. Note: this differs from the TUI, where the output lands in the conversation. |
| Prompt suggestions (ghost text) | Only when the host sets `promptSuggestions: true`; the user's `promptSuggestionEnabled` setting still applies (`SDK/sdk.d.ts:2149`). | Maintainer decision (see below). |
| Built-in `claude-code-guide` agent | Hidden for `sdk-*` entrypoints. | None without a forced entrypoint. Accept. |

## Open questions

1. ~~`previewFormat`: forcing or matching?~~ Resolved in Round 2: matching. The UI must render previews (R5.3), because the model emits them in both SDK modes.
2. `promptSuggestions: true` makes SDK mode follow the user's `promptSuggestionEnabled`, as the TUI does, but each suggestion is one extra forked request. Recommendation: on, so the user's setting decides; confirm.
3. Should the plugin strip `DSH_*` names, following DSH's convention (`P/dsh-subprocess/lib/index.js:35-44`)? They are not Claude host variables, but a raw TUI started from a normal shell would not see them. Recommendation: strip and document.
4. The SDK deletes `NODE_OPTIONS`. Restoring it needs `spawnClaudeCodeProcess`. Is the loss acceptable? Recommendation: document it, do not work around it in M1.
5. **Unverified:** whether a session started in the SDK keeps the SDK identity when later opened in the TUI, and whether the TUI runs a project-local `statusLine`.

## Round 2: AskUserQuestion `previewFormat`

The critic found a conflict (critic §3.1). This round answers it with code and live probes. Probe script `r2-preview.mjs`; runs `r2-off-*` (no option) and `r2-on-*` (`previewFormat: 'markdown'`); TUI run `r2-transcript-tui` (interactive `claude` in tmux). All on `claude-sonnet-5-5`, clean env, scratch repo.

### What decides the tool text

- The AskUserQuestion description is the base text plus `previews[format]` when a format is set, else nothing (CLI 2.1.318 binary: the tool's `description()` ends `if(format===void 0)return base; return base+previews[format]`; the map has `markdown` and `html` texts).
- At startup the CLI computes the client type, then: if env `CLAUDE_CODE_QUESTION_PREVIEW_FORMAT` is `markdown` or `html`, use it; else, if the client type does not start with `sdk-` and is not `claude-desktop`, `local-agent`, `remote` (or `claude-vscode` in one case), set `markdown` (same binary, client-type block). So **the TUI (`cli`) defaults to `markdown`**; SDK (`sdk-ts`) and `claude -p` (`sdk-cli`) get no preview text.
- The SDK option only sets that env var: `if(toolConfig?.askUserQuestion?.previewFormat) env.CLAUDE_CODE_QUESTION_PREVIEW_FORMAT=…` (`SDK/sdk.mjs`, `query()` env block; type at `SDK/sdk.d.ts:10299`). It overwrites a user-set value.
- The input schema does not depend on the format. Every mode has the option `preview` field, whose own description says "See the tool description for the…" (wire tools in `transcript-sdk-warm` vs `transcript-tui`: schema SAME).

### What is sent (wire tool definition)

| Mode | "Preview feature" paragraph | Rest of description | Schema |
|---|---|---|---|
| TUI | yes (markdown text) | — | has `preview` |
| SDK + `previewFormat: 'markdown'` | yes | byte-identical to TUI (`transcript-pv` vs `transcript-tui`: description and schema equal) | same |
| SDK, no option | no | TUI text minus that paragraph only (diff `transcript-sdk-warm` vs `transcript-tui`) | same |

Each `r2-on-*` transcript contains the paragraph and each `r2-off-*` does not (grep, 4 + 4 runs, entrypoint `sdk-ts`).

### Does the model emit `preview`?

| Prompt | TUI | SDK, no option | SDK + markdown |
|---|---|---|---|
| a: "greet(name) … ask me which implementation style I prefer" | not run | no previews (1/1) | no previews (1/1) |
| b: "login page layout … pick between two layout options" | no previews (TUI showed plain options) | no previews (1/1) | no previews (1/1) |
| c: "show me two alternative implementations of greet(name) … let me pick one with AskUserQuestion" | **previews** (code snippets; the TUI drew the side-by-side box) | **previews** (2/2) | **previews** (2/2) |

The earlier `sdk-surface` "default previews arrived" result came from a prompt that asked for previews by name, so it did not test the default behaviour. With these samples the paragraph made no visible difference: the schema field alone is enough for the model to use previews when the task is a comparison of artifacts. The samples are small; whether the paragraph changes how often previews appear is **unverified**.

### Answer

- Setting `previewFormat: 'markdown'` reproduces the TUI's own default, so it is **matching the TUI**, not forcing (rule 4) and not injection (rule 3): the text is the CLI's, chosen by the CLI for its interactive client. Leaving it unset is the SDK-mode deviation.
- Do not set it when the user's env already has `CLAUDE_CODE_QUESTION_PREVIEW_FORMAT`; pass that through instead (the TUI honours it).
- `html` is not the TUI default; never choose it for the user.
- The UI must render previews in either case (R5.3): render the string as Markdown in a monospace box next to the option list, single-select only, as the TUI does. If there is no preview, show plain options.
- Side note: the paragraph changes the tool block, so the first request has a new cache prefix (on-runs cost about 0.08 USD vs 0.045 on the first pair, then equal). This is the same cost the TUI pays.

