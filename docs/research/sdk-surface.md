# Research: the Claude Agent SDK surface

Topic: which Agent SDK to use, which controls exist, and what the CLI sends on the wire.
Versions checked: Claude Code CLI 2.1.318, Agent SDK 0.3.318 (Node), on Linux, Bedrock auth.

Evidence aliases:
- `SDK/sdk.d.ts:N` is the type file of `@anthropic-ai/claude-agent-sdk` 0.3.318.
- `SDK/sdk.mjs ~N` is the SDK bundle after `prettier` formatting. The line numbers are approximate, but the quoted code is exact.
- `CLI 2.1.318 binary` means a string search in the user's CLI binary.
- `probeN` is a small live script (in the local scratch folder, not published). It drives the user's own CLI on `claude-sonnet-5-5` in a scratch git repo, from a clean env. Round 1 probes cost about $1, round 2 (probe7) about $1 more.
- **Unverified** marks things I inferred but did not check.

---

## Answers for the design

1. **Version.** SDK `0.3.N` pairs with CLI `2.1.N`. The SDK's `package.json` has `"claudeCodeVersion": "2.1.318"`, and the npm registry shows the same pairing for every recent release. Pin a floor (for example `^0.3.318`). Read `system/init.claude_code_version` and `capabilities` at run time. An older CLI answers a control it does not know with the error `Unsupported control request subtype: <x>`, so the plugin must treat every control as optional and degrade.
2. **No platform binaries.** Always pass `pathToClaudeCodeExecutable`. Then the SDK never looks for its bundled binary (`SDK/sdk.mjs ~54265`). The SDK runs fine with no platform package and with no peer packages (live: `pnpm-test`). A plugin package cannot stop pnpm from installing the 230–330 MB optional binary, because only the root project's `overrides` can do that. DSH installs plugins with `pnpm add` into the profile, and the profile's `pnpm-workspace.yaml` is a root file that DSH creates once and never rewrites. So: document an opt-in `overrides` block for that file (verified with pnpm 11: only 5 MB is installed), and otherwise accept the binary as unavoidable. Do not vendor the SDK: its licence is proprietary ("© Anthropic PBC. All rights reserved", `SDK/LICENSE.md`).
3. **Raw start options.** Use `systemPrompt: {type:'preset', preset:'claude_code'}` with no `append`. **Omitting `systemPrompt` is not raw**: the SDK then sends an empty custom system prompt (`SDK/sdk.mjs ~54175`: `if (i === void 0) f = ""`). Pass `settingSources: ['user','project','local']` (omitting it also loads all three, `SDK/sdk.d.ts:2352-2361`, but being explicit is clearer). Pass the user's env (with host Claude Code variables stripped). Do not pass `model`, `effort`, `permissionMode`, `tools`, `settings` or `thinking`. Then the only CLI flags are `--output-format stream-json --verbose --input-format stream-json --permission-prompt-tool=stdio --setting-sources=user,project,local --include-partial-messages` (probe2 A, `ps`).
4. **What the SDK adds by itself.** Env `CLAUDE_CODE_ENTRYPOINT=sdk-ts` (only when it is not already set, so strip a host value first), `CLAUDE_AGENT_SDK_VERSION`, and `CLAUDE_CODE_SDK_READS_SESSION_STATE=1` (probe2 A). It also **sets `process.env.CLAUDE_AGENT_SDK_VERSION` in the host process** (`SDK/sdk.mjs ~54180`; live). DSH child processes then inherit it. This is harmless, but a test should expect it.
5. **Initialize options we need.** `perTaskStopAffordance: true` (Stop spares background agents and workflows), `includePartialMessages: true` (live text), `forwardSubagentText: true` (child text and thinking for the subagent tree), `canUseTool` (approvals and AskUserQuestion), `onElicitation` (without it, MCP elicitations are **declined automatically**, `SDK/sdk.d.ts:1810-1828`). None of these change what the model sees. Leave `promptSuggestions` and `agentProgressSummaries` off by default: they make extra model calls (cheap, on the same process), so they should be user opt-ins.
6. **Every control we need exists and works on 2.1.318.** Live-tested: `interrupt`, `stopTask`, `setPermissionMode`, `setModel`, `applyFlagSettings`, `supportedCommands`, `supportedModels`, `supportedAgents`, `mcpServerStatus`, `toggleMcpServer`, `reconnectMcpServer`, `getContextUsage`, the usage API, `askSideQuestion`, `generateSessionTitle` (works, but see answer 14), `forkSession`, `resume`, `resumeSessionAt`, `accountInfo`, and steering with `priority`. `onElicitation` was tested live in Round 3b (form, decline, URL, interrupt). Not tested live: `backgroundTasks` (Ctrl+B), `rewindFiles`, `rate_limit_event` (Bedrock has no plan limits).
7. **Stop.** `interrupt()` aborts the turn. The process stays alive. Background **Bash** tasks survived an interrupt with and without `perTaskStopAffordance`. A background **subagent** was killed by the interrupt without the flag, and survived and delivered its result with the flag (probe4 N vs P). With the flag, a running **workflow** and two background agents also survived an interrupt during a foreground tool (probe7 S). An interrupt during a foreground tool gives `terminal_reason: aborted_tools`. An idle interrupt returns `{still_queued: []}` and emits **no** `result`, so the plugin must not wait for one. `stopTask` on a workflow or on one background agent stops only that task (and the shells it started), with `task_notification status:"stopped"`; the other tasks keep running (probe7 S).
8. **Background completions.** When a background task finishes while the session is idle, the CLI **starts a turn by itself**: `task_notification`, then `system/init`, `status: requesting` with no `user_message_uuids`, assistant text and a `result` (probe2 B, probe3, probe6 W). The plugin needs an "unprompted turn" path. It must not hold a DSH turn open while waiting for it.
9. **Undocumented but present.** `workflow_progress` (an array of phases and agents on `system/task_progress`), `command_lifecycle` (per-message `queued`/`started`/`completed`), `system/session_state_changed` (on the wire, but the SDK consumes it and does not yield it), and `askSideQuestion`, `generateSessionTitle`, `getSettings`, `getStatus`, `getPlan`, `listPermissionRules`, `getHooksListing` and `getTaskOutput` on `Query` (in the bundle, not in the types). Wrap them in a thin adapter with runtime checks.
10. **Settings-writing controls to avoid.** `updateSettings()` writes the user's settings files on purpose (`SDK/sdk.d.ts:3071-3080`), so it is banned. `toggleMcpServer()` **persists** `disabledMcpServers` for the project in `~/.claude.json` (the CLI state file, not `settings.json`) (live, probe6 M). Treat it like the TUI's `/mcp` toggle (a CLI-owned write) and tell the user it is persistent. `setModel`, `setPermissionMode` and `applyFlagSettings` are session-only. `applyFlagSettings` shows up in `getSettings().effective` but does not touch any file (live: settings mtimes unchanged).
11. **Local commands** (`/context`, `/usage`, `/cost`, `/compact`) do **not** use `local_command_output` on 2.1.318. They arrive as an `assistant` message with `model: "<synthetic>"` and zero usage, followed by a `result` with `local_command: "context"` (and so on), `num_turns: 0` and **zero `usage`** (probe5). A context ring fed from that `usage` drops to 0%. That is the dsh-claude bug, and its cause. Skip `usage` when `local_command` is set, and take the ring from `getContextUsage()`.
12. **Usage numbers.** `result.usage` is per-turn and main-loop only. `result.modelUsage` and `total_cost_usd` are **cumulative** across the process and include subagents, compaction and workflow agents. A resumed session starts from the saved totals (`SDK/sdk.d.ts:6007-6017`). The auth-usage note covers this in depth.
13. **Permission modes.** All six modes switch live with `setPermissionMode`, and each switch emits `system/status {status:null, permissionMode}` (probe7 P). `bypassPermissions` fails ("…the session was not launched with --dangerously-skip-permissions") unless the session can bypass. It can when it was spawned with `allowDangerouslySkipPermissions` (adds the CLI flag `--allow-dangerously-skip-permissions`, the same flag a TUI user types) or when the user's settings set `permissions.defaultMode: "bypassPermissions"` (probe7 B, probe7b). So: never pass the flag by default. Offer it only as an explicit plugin option that mirrors the TUI launch flag, and say that with it plan mode no longer asks before edits (CLI 2.1.318 binary: plan + bypass-available counts as bypass). `auto` fails when the model has no auto support ("auto mode unavailable for this model"; read `supportsAutoMode` from `supportedModels()`), when `disableAutoMode` is set ("auto mode disabled by settings"), and for the other reasons the CLI lists (organization off, managed settings, fast mode on) (probe7a; CLI 2.1.318 binary). A model switch to a model without auto drops the mode to `default` and emits a `status` frame (probe7a).
14. **Session title.** The CLI titles the session by itself on the first turn, on the same process: it writes a transcript entry `{"type":"ai-title","aiTitle":…}`, which `getSessionInfo()` returns as `summary` and `customTitle` (probe7 T). It sends **no** stream message for it (`system/session_title_changed` never arrived). It skips the title when non-essential traffic is off (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`), which this user's settings set (probe7 P: no title entry). So read the title from `getSessionInfo()` after the first `result`, and fall back to the first prompt. Do **not** call `generateSessionTitle`: with `persist:false` it always makes a model call and ignores the user's opt-out.
15. **Side questions (`/btw`).** `askSideQuestion` answers while the main turn streams and while a foreground tool runs, in under a second, with the right context (probe7 P). The CLI keeps no side-question history for SDK hosts (`threadHistory: false`), so the plugin keeps it: pass `history: [{question, response, fallback_notice?}]` with the last 20 main-thread, non-synthetic exchanges, as the TUI does (CLI 2.1.318 binary: `.slice(-20)`, filtered by agent). Live: with history the model recalled the earlier side answer; without it, it did not.
16. **Agent teams.** With the teams flag on (here from the user's settings env), CLI 2.1.318 in SDK mode has no `TeamCreate` tool. Teammates are background `local_agent` tasks started by the `Agent` tool with `name` and `team_name`. `SendMessage` calls from a teammate arrive as forwarded child `tool_use` blocks (`to`, `message`, `recipient_kind:"name"`). A message to a finished teammate resumes it: a new `task_started` with the same `task_id`, a new `run_id`, and `prompt: "<agent-message from=\"alice\">ping</agent-message>"`. Teammate transcripts come from `listSubagents()` / `getSubagentMessages()` (probe7 M). `send_task_message` is **not** a way to message a teammate or agent: 2.1.318 answers "Unsupported control request subtype: send_task_message" (live, probe7 M and S). The user can reach a teammate only by asking the main agent.
17. **Empty results.** After some CLI-started turns, the CLI sends an extra `result` with `num_turns: 0`, `terminal_reason: null`, empty `result` and zero usage (probe7 S, M). The plugin must skip it.
18. **Main-thread agent (R6.4, Round 3).** The SDK `agent: '<name>'` start option adds exactly one CLI flag, `--agent=<name>`, the same flag a TUI user types (`SDK/sdk.mjs ~51357`; probe8 A `ps` args). The agent's prompt then **replaces** the `claude_code` system prompt (1134 → 27 tokens in `getContextUsage`), as `--agent` does in the TUI. So: pass it only when the user picks an agent for a new session, never by default. The user's own settings key `agent` is read by the CLI at start-up with no flag (CLI 2.1.318 binary; not live-tested). `applyFlagSettings({agent})` is the documented session-only switch (`SDK/sdk.d.ts:3038-3064`), but on 2.1.318 it **takes effect only before the first turn**. After the first turn it is accepted, `getSettings()` shows it, a transcript `agent-setting` entry is written, and yet the system prompt does not change (probe8 B, E, F). So "change the agent mid-session" is **not supported by the CLI**. Offer the picker for a new session (spawn option, or `applyFlagSettings` before the first message) and lock it after the first turn. No stream frame reports the agent, and `system/init` has no `agent` field: the plugin must remember the choice itself. See §8.1.
19. **Live workflow-agent output (R6.5, Round 3).** Workflow agents are never forwarded on the stream, even with `forwardSubagentText` (probe6 W, probe8 W: 0 child frames). Their transcripts are written **live, one line per message**, under `<session>/subagents/workflows/<wf runId>/agent-<agentId>.jsonl`. In probe8 W each `tool_use`, `tool_result` and final text appeared in the file within one 500 ms poll. `listSubagents()` lists workflow agents and `getSubagentMessages()` reads them (it returns the user/assistant chain only). Join the `agentId` from `workflow_progress`. The folder comes from the Workflow tool result (`tool_use_result.transcriptDir` and `runId`, a `wf_…` id that differs from `task_started.run_id`). `workflow_progress` is event-driven, not timed: 7 `task_progress` frames for a 2-agent, 18 s run (one per agent start, tool call and finish), each 1.2–1.5 KB with the full list, plus usage-only frames of about 400 bytes. Text arrives as whole messages, not deltas, as for other subagents. See §8.2.
20. **Plan approval with a mode (Round 3b).** ExitPlanMode's `can_use_tool` has no suggestions, so the host builds the TUI's choices: allow with no updates (the CLI restores the pre-plan mode, the TUI's "use auto mode"), or allow + `updatedPermissions: [{type:'setMode', mode, destination:'session'}]` for `acceptEdits` / `default` / `bypassPermissions`. One `status.permissionMode` frame follows; nothing is written to settings. "Keep planning" works when the denial carries the CLI's own rejection text and the user's feedback goes as a normal user message with `priority: 'next'`; a feedback-only denial message was ignored by the model once (Round 3b, probe-r3b C, H).
21. **MCP elicitation (Round 3b).** With `onElicitation` set, the CLI forwards form and URL elicitations (`control_request` subtype `elicitation`; the CLI declares both modes to MCP servers). The callback's `accept` + `content`, `decline` and `cancel` reach the server unchanged. URL completion arrives as `system/elicitation_complete`. An interrupt cancels a pending elicitation (`control_cancel_request`, `signal` aborts) (probe-r3b E, I).

---

## 1. Version choice and install

| Fact | Evidence |
|---|---|
| SDK 0.3.318 declares `"claudeCodeVersion": "2.1.318"`. | `SDK/package.json` |
| The registry pairs them for every recent release: 0.3.310→2.1.310 … 0.3.318→2.1.318. Some numbers are skipped (no 0.3.313). The CLI's `stable` tag lagged at 2.1.311 while `latest` was 2.1.318. | npm registry, `claude-agent-sdk` and `claude-code` documents, fetched 2026-11-05 |
| The SDK does no version check against the CLI. There is no mismatch error string. | `SDK/sdk.mjs` grep for the version and "older than" |
| An older CLI rejects an unknown control with `Unsupported control request subtype: <x>`. Newer CLI features are advertised in `system/init.capabilities` (for example `interrupt_receipt_v1`, `interrupt_cancel_queued_v1`, `interrupt_send_now_v1`, `msg_lifecycle_v1`, `mcp_read_resource_v1`). | CLI 2.1.318 binary; probe5 `init` |
| The user's CLI auto-updates, so the SDK will drift behind the CLI. **Unverified:** how far apart they can be. Some options document a floor, for example `verbatimPrompts` needs 2.1.248 (`SDK/sdk.d.ts:1966`). | — |
| `optionalDependencies` lists 8 platform packages at the same version. Each binary is 320–335 MB (`SDK/manifest.json`). | `SDK/package.json`, `manifest.json` |
| Without `pathToClaudeCodeExecutable` and with no platform package, `query()` **throws synchronously**: "Native CLI binary for linux-x64 not found…". With the path set, the resolver is skipped. | `SDK/sdk.mjs ~54262-54274`; `probe-nopath.mjs` |
| The SDK imports only Node built-ins at run time. It ran `initialize` with no platform package and no peer packages (`@anthropic-ai/sdk`, `@modelcontextprotocol/sdk` and `zod` are peers). | live `pnpm-test` (pnpm 11.28, `autoInstallPeers: false` like a DSH profile) |
| DSH installs plugins with `pnpm add` in the profile folder. It writes the profile's `pnpm-workspace.yaml` once (`nodeLinker: hoisted`, `autoInstallPeers: false`). It later edits only `allowBuilds`, through a YAML document edit that keeps other keys. | `P/dsh-plugin-manager/lib/index.js` (runProfilePnpm), `P/dsh-plugin-manager/lib/types/build-approval.js`, `P/dsh-app-boot/lib/index.js` (PROFILE_PNPM_WORKSPACE) |
| pnpm `overrides` of `"@anthropic-ai/claude-agent-sdk>@anthropic-ai/claude-agent-sdk-<platform>": "-"` in that root file drop the binaries: 5 MB installed instead of about 235 MB. t3code does the same in its own root `pnpm-workspace.yaml`. | live `pnpm-test`; t3code `pnpm-workspace.yaml:137-146` |
| Because `autoInstallPeers: false`, the plugin must list the SDK as a normal `dependency`. A peer would not be installed. | `P/dsh-app-boot/lib/index.js` |

**Recommendation:** depend on `@anthropic-ai/claude-agent-sdk` `^0.3.318` as a normal dependency. Document the optional profile `overrides` block for users who want to save the disk space, because the plugin itself cannot do it. Keep the SDK import inside the Claude backend package only (contract rule 13).

Telemetry: the SDK has an internal feature-event queue (`tengu_feature_ok` etc.), but the sink is never attached in the SDK process, so the events stay in memory, capped at 1000 (`SDK/sdk.mjs ~33876-33896`). The CLI reported `analytics_disabled: true` on this machine because of the user's env. **Unverified:** the SDK makes no other analytics calls. A grep found only the remote-session `fetch` paths.

---

## 2. Start options: raw versus not raw

| Option | Raw choice | Why / evidence |
|---|---|---|
| `pathToClaudeCodeExecutable` | The user's `claude` (configured path, else `PATH`, else `~/.local/bin/claude`). | argv[0] is the user's path (probe2 A). |
| `systemPrompt` | `{type:'preset', preset:'claude_code'}` | Omitted → `""` → `initialize.systemPrompt: [""]` (`SDK/sdk.mjs ~54175`, `~52546`). With the preset, `initialize` carries no `systemPrompt` key, so the CLI default prompt is used (probe2 B wire: `initialize` was only `{"subtype":"initialize","perTaskStopAffordance":true}`). The raw-baseline note compares the actual prompt text. |
| `settingSources` | `['user','project','local']` | Omitted also means all sources (`SDK/sdk.d.ts:2352-2361`). `[]` disables them. |
| `env` | The user's env minus host-session variables | With `env` given, the SDK copies it and adds only the three variables above (`SDK/sdk.mjs ~54276-54286`). |
| `model`, `effort`, `permissionMode`, `thinking`, `tools`, `allowedTools`, `settings`, `agent`, `agents`, `mcpServers` | Omit (`agent` only when the user picks a main-thread agent for a new session, answer 18) | Each one maps to a CLI flag (`SDK/sdk.mjs ~51336-51409`) or to an `initialize` field. Omitted means the user's settings decide. `permissionMode` omitted picks `permissions.defaultMode` like `claude -p` (`SDK/sdk.d.ts:2057-2062`). |
| `canUseTool` | Set | Adds `--permission-prompt-tool=stdio`. Without it the CLI cannot ask. |
| `includePartialMessages` | `true` | Adds `--include-partial-messages` (live stream frames). |
| `perTaskStopAffordance` | `true` | `initialize` field (`SDK/sdk.d.ts:1866-1884`). See §4. |
| `forwardSubagentText` | `true` | Subagent text and thinking are forwarded with `parent_tool_use_id`. Without it, only tool_use/tool_result blocks are sent (`SDK/sdk.d.ts:1940-1946`). Live: child `user` and `assistant` messages carry `parent_tool_use_id`, `agent_id`, `subagent_type` and `task_description` (probe6 W). Child **stream deltas** were not forwarded. Child text arrives as whole messages. |
| `onElicitation` | Set | Missing means auto-decline (`SDK/sdk.d.ts:1810-1828`). Request fields: `serverName`, `message`, `mode` (`form`/`url`), `url`, `elicitationId`, `requestedSchema`, `title`, `displayName`, `description` (`SDK/sdk.d.ts:752-771`). Completion: `system/elicitation_complete`. Not tested live. |
| `onUserDialog` + `supportedDialogKinds` | Optional | CLI-rendered blocking dialogs (for example `refusal_fallback_prompt`). Without a declared kind, the CLI never emits it and uses the no-dialog path (`SDK/sdk.d.ts:1829-1864`). |
| `toolConfig.askUserQuestion.previewFormat` | Set `'markdown'`, unless the user's env already sets `CLAUDE_CODE_QUESTION_PREVIEW_FORMAT` (then pass that through). Never `'html'` | It sets env `CLAUDE_CODE_QUESTION_PREVIEW_FORMAT`, which changes the tool's instructions to the model. `'markdown'` is the TUI's own default, so setting it **matches the TUI**; leaving it unset is the SDK-mode deviation (`raw-baseline` Round 2). With it unset, plain-string previews arrived live (probe6 Q). |
| `verbatimPrompts` | `false` | When true, it skips `@path` expansion, slash commands and the turn-start attachment pass (`SDK/sdk.d.ts:1947-1970`). That is not CLI behaviour. |
| `promptSuggestions`, `agentProgressSummaries` | Off by default; a user opt-in | Extra model calls (`SDK/sdk.d.ts:2140-2165`). |
| `enableFileCheckpointing` | Opt-in (rewind with file restore) | Sets `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true` (`SDK/sdk.mjs ~54280`). **Unverified:** whether the TUI checkpoints by default. If it does, enabling this is the raw match. |
| `spawnClaudeCodeProcess` | Optional | A custom spawner works (all probes used one to tee the wire). It is a clean hook for crash detection, pid tracking and spawning outside a sandbox. |

Thinking text: with this user's settings, thinking blocks arrived with an empty `thinking` string and only a `signature` (probe3). The setting `showThinkingSummaries` (`SDK/sdk.d.ts:9644-9647`) decides that. It was unset here. The raw choice is to leave it to the user's setting. The thinking-token count arrives as `system/thinking_tokens` (estimated) and in `output_tokens_details.thinking_tokens`.

---

## 3. Controls on `Query`

Wire names are the `control_request.request.subtype` values. Declared means the method is in `sdk.d.ts`. Undeclared means it exists only in the bundle.

| Control | Wire subtype | Declared | Live result (2.1.318) | Notes |
|---|---|---|---|---|
| `interrupt(opts?)` | `interrupt` (+`cancel_queued`) | yes (`:2974`), `cancelQueued` undeclared (`SDK/sdk.mjs ~52663`) | During streaming: `result` `error_during_execution`, `terminal_reason: aborted_streaming`, `errors: ['[ede_diagnostic] …']`; process alive (probe3 X/Y, probe4). Idle: `{still_queued: []}` and no result (probe2 B). | The receipt lists queued messages that **will still run** (`SDK/sdk.d.ts:4888-4900`). A Stop that should drop the queue passes `cancelQueued`. Interrupt during a running foreground tool was **not** tested (expect `aborted_tools`, unverified). |
| `stopTask(taskId)` | `stop_task` | yes (`:3344`) | `task_notification status:"stopped"` right away, and the other task kept running (probe3 X). On a `local_workflow`: `task_updated {status:"killed"}`, `stopped`, the running workflow agent shows `state:"error"` in the last `workflow_progress`, and its shell is stopped too. On one background `local_agent`: the same, and the other agent ran on and finished (probe7 S). | Stopping a task can make the CLI start its own follow-up turn (probe7 S: one came about 1.4 s after the second stop). |
| `backgroundTasks(toolUseId?)` | `background_tasks` | yes (`:3359`) | not tested | Ctrl+B equivalent. |
| `setPermissionMode(mode)` | `set_permission_mode` | yes (`:2981`) | Works for all six modes; each change emits `system/status {status:null, permissionMode}` (probe2 B, probe7 P). `bypassPermissions` and `auto` can be refused; see answer 13. | The CLI's own mode changes (for example after `ExitPlanMode`) also emit `status.permissionMode`. After an approved plan, the mode went `plan` → `auto` (the user's default) (probe6 Q). |
| `setModel(model?)` | `set_model` | yes (`:3010`) | `{model}` echoed (probe2 B). | `undefined` = default model. |
| `applyFlagSettings(obj)` | `apply_flag_settings` | yes (`:3065`) | Works; the value shows in `getSettings().effective.effortLevel`; no file written (probe6 W, probe6 M mtimes). | Session-only flag layer. `effortLevel: null` resets. Also `ultracode: true/false`. An effort change without `ultracode` turns ultracode off (`SDK/sdk.d.ts:3038-3064`). |
| `setMaxThinkingTokens` | `set_max_thinking_tokens` | yes, deprecated | not tested | It also sets the thinking display. |
| `updateSettings` | `update_settings` | yes (`:3080`) | **never call** | It writes settings files. |
| `initializationResult()` / `reinitialize()` | `initialize` | yes | `commands`, `models`, `agents`, `account`, output styles; about 470 ms after spawn (probe2 A). | `reinitialize` redelivers pending `can_use_tool` requests after a transport gap. |
| `supportedCommands()` | from init | yes (`:3121`) | 57 entries, the same count as `system/init.slash_commands` (probe2, probe5). Each entry has `name`, `description`, `argumentHint`, `builtin`. | Live updates: `system/commands_changed` (fired 3× during start-up as plugins and MCP loaded). `terminal_slash_commands` in init lists TUI-only ones (`doctor`, `color`, `focus`, `reload-plugins`). |
| `supportedModels()` | from init | yes (`:3127`) | 8 models; each has `value`, `resolvedModel`, `displayName`, `description`, `supportsEffort`, `supportedEffortLevels`. | `resolvedModel` shows what an alias really runs (here `default` → the user's Opus). |
| `supportedAgents()` | from init | yes (`:3133`) | User, project, plugin and built-in agents (probe8 A: a new project agent was listed). | Matches `system/init.agents`. Picking one for the main thread: answer 18. |
| `mcpServerStatus()` | `mcp_status` | yes (`:3139`) | `pending` right after start, then `connected` with `serverInfo`, `config`, `scope`, `source`, `tools` (probe2, probe6 M). | `init.mcp_servers` is always `pending` at start. Poll or re-ask after a `commands_changed`. |
| `toggleMcpServer(name, on)` | `mcp_toggle` | yes (`:3286`) | `disabled` / `connected` (probe6 M). | **Persists** `projects[cwd].disabledMcpServers` in `~/.claude.json` (live). `settings.json` was not touched. |
| `reconnectMcpServer(name)` | `mcp_reconnect` | yes (`:3278`) | Works; an unknown name throws `Server not found: …` (probe6 M). | |
| `mcpAuthenticate`, `mcpClearAuth`, `mcpSubmitOAuthCallbackUrl` | `mcp_authenticate`, … | undeclared (`SDK/sdk.mjs ~53046-53057`) | not tested | Candidate for the "needs auth" button (R7.4). |
| `getContextUsage({detail})` | `get_context_usage` | yes (`:3150`) | `summary` takes about 20 ms, `full` about 210 ms. It has categories (`system_prompt`, `system_tools`, `system_tools_deferred`, `mcp_instructions`, `mcp_tools_deferred`, custom agents, skills, messages, free space, autocompact buffer) with token counts and colours. It works **before the first turn** (probe2 A, at about 500 ms). | Feeds the ring from turn 0 and after local commands. |
| `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors})` | `get_usage` | yes, experimental (`:3170`) | Bedrock: `rate_limits_available: false`, `rate_limits: null`, `subscription_type: null`, plus session cost and `model_usage` (probe2). | Structured `/usage`. The name will change, so wrap it. |
| `accountInfo()` | from init | yes (`:3240`) | `{apiProvider: "bedrock"}` | |
| `askSideQuestion(q, {history?, signal?})` | `side_question` | **undeclared** (`SDK/sdk.mjs ~52880`) | Correct answer about turn 1, about 1.2 s. The transcript line count was unchanged, and no new `claude` process started (probe2 B). Also answers mid-stream and mid-tool (about 0.8 s), and uses `history` (probe7 P). | It returns `{response, synthetic, refusalFallback?}`, or `null`. It emits `system/control_request_progress {status:"started"}`. This is the faithful `/btw`. |
| `generateSessionTitle(desc, {persist})` | `generate_session_title` | **undeclared** (`~52870`) | `persist:false` → the title, with the transcript unchanged and no new process (probe2 B). `persist:true` when the CLI already made a title: returns that title in about 1 ms and appends the same `ai-title` entry again (probe7 T). | `persist:false` always makes a model call. Not needed: the CLI titles the session itself (answer 14). |
| `renameSession(title)` | `rename_session` | the function is declared (`:3382`), the method is not | not tested | |
| `getSettings()` | `get_settings` | undeclared | `{effective, sources, applied}`. Read-only. | Shows the settings layers, so "open settings.json" can show which file set a key. |
| `getStatus()`, `getPlan()`, `listPermissionRules()`, `getHooksListing()` | `get_status`, `get_plan`, `list_permission_rules`, `get_hooks_listing` | undeclared | All answered (probe6 W). `getStatus` is the `/status` panel as sections and rows. `getPlan` is `{exists}`. The rules list includes source and editability. The hooks list has counts per event. | Read-only and useful for panels. |
| `getTaskOutput(taskId)` | `get_task_output` | undeclared | For a workflow it gave: "no shell or Monitor task with that task_id". | Shells and Monitor only. Workflow agent output comes from transcripts (answer 19). |
| `rewindFiles(uuid, {dryRun})` | `rewind_files` | yes (`:3249`) | not tested | Needs `enableFileCheckpointing`. |
| `cancelAsyncMessage(uuid)` | `cancel_async_message` | undeclared | not tested | Withdraws one queued message. |
| `setMcpServers`, `reloadPlugins`, `reloadSkills`, `reloadOutputStyles` | … | yes | not tested | `setMcpServers` adds servers, so it is not for normal use (it would add tools the user did not configure). Reloads are fine on user request. |
| `close()` | kills the process | yes (`:3368`) | The process exits. Background tasks are killed (`task_notification stopped`, probe2 B end). | Use only on session dispose, never on Stop. |

Standalone functions: `forkSession(id, {dir, upToMessageId, title})` copies the transcript with new UUIDs. It is a **pure file operation with no process** (probe2: process count unchanged; 27 messages read back). `getSessionMessages`, `getSubagentMessages`, `listSessions`, `listSubagents`, `getSessionInfo`, `renameSession`, `tagSession` and `deleteSession` are also file operations (`SDK/sdk.d.ts:706-1206`).

Fork and rewind (live, probe6 R):

| Path | Result |
|---|---|
| `resume: id` (new process) | Recalled both code words. This is how a session continues after a DSH restart. |
| `resume` + `resumeSessionAt: <assistant uuid of turn 1>` + `forkSession: true` | Recalled only turn 1's word. Flags: `--resume … --fork-session --resume-session-at <uuid>`. |
| `forkSession(id, {upToMessageId: <same uuid>})` then `resume` | Recalled only turn 1's word. The cost counter starts fresh. |

`resumeDropsTurn: <prompt uuid>` adds a guard. The CLI refuses a truncation whose discarded range holds anything except that turn (`SDK/sdk.d.ts:2185-2235`), for example a task notification that was absorbed mid-turn. A refused rewind must fall back to a plain resume, not retry.

Steering and queueing (live, probe2 B, probe3 X):
- A message sent while a tool runs, with `priority: 'next'`, is folded into the **same** turn. The next request lists both `user_message_uuids`, and the reply obeyed it ("s1 … STEERED").
- `priority: 'now'` aborts the current turn (`result success`, `terminal_reason: aborted_streaming`, with the partial text in `result`). It then runs the new message as a fresh turn ("NOW-READ").
- With no priority, the message is queued: `command_lifecycle queued → started → completed` per message uuid. The `result.queued_turn_count` field counts what is still waiting.
- Each message needs `origin: {kind: 'human'}`. Without it, the message is treated as unattributed and fails strict trust gates (`SDK/sdk.d.ts:5647`).

---

## 4. `perTaskStopAffordance` and Stop (live)

| Case | Without the flag | With the flag |
|---|---|---|
| Background Bash (`run_in_background`) during an interrupt | survived and completed (probe3 Y) | survived and completed (probe3 X) |
| Background subagent (`Agent`, `run_in_background`) during an interrupt | **stopped** at the interrupt (`task_notification stopped`, probe4 N) | survived, finished and handed back "42"; the CLI then ran its own follow-up turn (probe4 P) |
| Workflow during an interrupt | not tested | survived; no `task_notification`, still listed in `background_tasks_changed`; then stopped cleanly by `stopTask` (probe7 S) |
| `close()` | kills everything | kills everything |

The flag also tells the CLI that the host has per-task stop controls (`stop_task`), so the UI must offer them.

---

## 5. Message catalogue

All of these were seen live unless marked. "SDK yields" means the message reaches the `for await` loop. Type lines are in `SDK/sdk.d.ts`.

### Core

| Message | Key fields | Seen | Notes |
|---|---|---|---|
| `system/init` | `tools`, `mcp_servers` (pending), `model`, `permissionMode`, `slash_commands`, `terminal_slash_commands`, `agents`, `skills`, `plugins`, `capabilities`, `claude_code_version`, `output_style`, `apiKeySource`, `fast_mode_state`, `effort`, `user_message_uuids`; undeclared extras: `analytics_disabled`, `messaging_socket_path`, `original_cwd`, `additional_directories`, `per_turn_effort_active`, `ultrathink_available` | yes | Re-sent at the **start of every turn** (7× in a 7-turn session, probe5). It is not a one-time event. (`:6309`) |
| `stream_event` | `event` (Anthropic raw stream events), `parent_tool_use_id`, `ttft_ms` | yes | Main thread only. Child deltas were not seen (probe6 W). `message_delta` may carry `safeguard_results` (undeclared). |
| `assistant` | `message` (BetaMessage), `parent_tool_use_id`, `uuid`, optional `agent_id`, `subagent_type`, `task_description`, `context_usage`, `usage_report` | yes | One message per content block as it completes (text, `tool_use`, `thinking`). Local commands produce `model: "<synthetic>"`. (`:3737`) |
| `user` | `message`, `parent_tool_use_id`, `tool_use_result`, `isSynthetic`, `isReplay` | yes | Carries `tool_result` blocks. After `/compact`, the summary user message and `<local-command-stdout>` arrive as `user` (`isReplay: true`). (`:6655`, `:6757`) |
| `result` | `subtype` (`success` / `error_during_execution` / `error_max_*`), `result`, `usage` (per turn), `modelUsage` and `total_cost_usd` (cumulative), `num_turns`, `terminal_reason`, `local_command`, `user_message_uuids`, `queued_turn_count`, `result_index`, `permission_denials`; undeclared: `subagent_stats`, `safety_stops`, `model_usage_since_last_result` | yes | One per turn, including CLI-started turns after background completions. (`:6070`, `:5999`) |
| `system/status` | `status` (`requesting` / `compacting` / `null`), `permissionMode`, `compact_result`, `user_message_uuids` | yes | The authoritative mode source for the picker. (`:6292`) |
| `command_lifecycle` | `command_uuid`, `state` (`queued` / `started` / `completed` / `cancelled`) | yes, SDK yields it | **Not in `SDKMessage`.** Capability `msg_lifecycle_v1`. Good for queue and steer UI. |
| `system/session_state_changed` | `state` (`idle` / `running` / `requires_action`), `sdk_host_only: true` | on the wire, **not yielded** | Enabled by the SDK's `CLAUDE_CODE_SDK_READS_SESSION_STATE=1`. The SDK consumes it. Busy and idle must be derived from `status` / `result` / `command_lifecycle`. **Unverified:** whether the SDK exposes it another way. (`:6237`) |
| `system/commands_changed` | `commands` | yes | (`:3877`) |
| `system/hook_started` / `hook_response` / `hook_progress` | `hook_name`, `hook_event`, `outcome`, `stdout`, `stderr` | yes (SessionStart) | Other hook events only with `includeHookEvents` (`SDK/sdk.d.ts:1926-1934`). |
| `system/thinking_tokens` | `estimated_tokens`, `estimated_tokens_delta` | yes | (`:6537`) |
| `system/control_request_progress` | `request_id`, `status` | yes (side question) | (`:5299`) |
| `control_request can_use_tool` | `tool_name`, `display_name`, `input`, `description`, `permission_suggestions`, `blocked_path`, `tool_use_id` | yes | The SDK maps this to `canUseTool(name, input, {suggestions, blockedPath, displayName, description, toolUseID, requestId, agentID, decisionReason, title, suppressAlwaysAllowRule, matchedAskRule, requiresUserInteraction, mcpServer})` (`SDK/sdk.d.ts:228-310`). Live suggestions for `rm`: `addRules` → `localSettings`, `addDirectories` → `session`, `setMode acceptEdits` → `session` (probe3 X). "Always allow" = return `updatedPermissions: [suggestion]` (`SDK/sdk.d.ts:2616-2627`). The CLI writes that rule, like the TUI. |
| AskUserQuestion | `can_use_tool` with `tool_name: "AskUserQuestion"`, `requiresUserInteraction: true`; the input has `questions[{question, header, options[{label, description, preview}], multiSelect}]` | yes | Answer with `allow` and `updatedInput: {...input, answers: {[questionText]: label}}` (plus optional `annotations`). Live: the model received "Blue" (probe6 Q; `SDK/sdk-tools.d.ts:2673-2690`). |
| ExitPlanMode | `can_use_tool` with input `{plan, planFilePath}` | yes | `allow` → the plan runs, and the mode returns to the user's default (here `auto`). "Keep planning" = `deny` with a message. Approving with a chosen mode = `updatedPermissions` `setMode` (**unverified** live). |

### Background work

| Message | Key fields | Seen |
|---|---|---|
| `system/task_started` | `task_id`, `run_id`, `tool_use_id`, `description`, `task_type` (`local_bash`, `local_agent`, `local_workflow`; doc also `remote_agent`), `is_backgrounded`, `subagent_type`, `spawn_depth`, `parent_task_id`, `workflow_name`, `prompt` | yes (`:6466`) |
| `system/task_progress` | `task_id`, `description`, `usage {total_tokens, tool_uses, duration_ms}`, `last_tool_name`, `summary`, **`workflow_progress`** (undeclared) | yes (`:6437`) |
| `system/task_updated` | `patch {status, end_time}` (`completed`, `killed`) | yes (`:6511`) |
| `system/task_notification` | `status` (`completed` / `failed` / `stopped`), `output_file`, `summary`, `usage`; undeclared: `handback`, `handback_report {text}` | yes (`:6401`) |
| `system/background_tasks_changed` | `tasks[{task_id, run_id, task_type, description}]` — the full current list | yes (`:3840`) |
| `tool_progress` | `tool_use_id`, `elapsed_time_seconds`, `task_id` | declared (`:6550`), not seen |

Foreground Bash and agents also emit `task_started` / `task_notification` with `is_backgrounded: false` (probe2 B, probe6 W). So the job list must filter, or show them as foreground.

`workflow_progress` sample (probe6 W; each `task_progress` carries the **full** current list):

```json
[{"type":"workflow_phase","index":1,"title":"One"},
 {"type":"workflow_phase","index":2,"title":"Two"},
 {"type":"workflow_agent","index":1,"label":"a1","phaseIndex":1,"phaseTitle":"One",
  "agentId":"a…","model":"claude-sonnet-5-5","state":"done","queuedAt":0,"startedAt":0,
  "attempt":1,"promptPreview":"Reply with exactly the word alpha…","promptFramed":true,
  "lastProgressAt":0,"tokens":14925,"toolCalls":0,"durationMs":876,"resultPreview":"alpha"}]
```

Agent `state` went `start` → `done`. The CLI also tracks other states in its own UI code (**unverified** list). The CLI drops `task_progress` frames that have neither `summary` nor `workflow_progress` before writing them (CLI 2.1.318 binary). Workflow agent messages are **not** forwarded on the stream, even with `forwardSubagentText` (probe6 W, probe8 W). Live agent output comes from the agent transcripts, which the CLI writes live (Round 3, §8.2). Agent states seen: `start`, `progress`, `done` (probe8 W), and `error` after a stop (probe7 S).

### Compaction, limits, misc

| Message | Seen | Notes |
|---|---|---|
| `system/compact_boundary` | yes (`/compact`) | `compact_metadata {trigger, pre_tokens, post_tokens, cumulative_dropped_tokens, duration_ms, preserved_segment, preserved_messages}`. It comes after `status: compacting` → `status: null, compact_result: success` (probe5; `:3885`). |
| `system/local_command_output` | **not seen** | Declared (`:5584`). On 2.1.318, `/context`, `/usage` and `/cost` came as a synthetic `assistant` plus a `result.local_command` instead (probe5). Handle both. |
| `rate_limit_event` | not seen (Bedrock) | `rate_limit_info {status, resetsAt, rateLimitType (five_hour / seven_day / …), utilization, overage*}` (`:5959-5997`). The CLI builds it only when there is plan-limit data (CLI binary `type:"rate_limit_event"` builder). |
| `system/api_retry` | not seen | `attempt`, `max_retries`, `retry_delay_ms`, `error_status` (`:3715`) |
| `auth_status` | not seen | (`:3828`) |
| `system/elicitation_complete` | not seen | (`:5454`) |
| `system/notification`, `system/memory_recall`, `system/files_persisted`, `tool_use_summary`, `system/plugin_install`, `system/worker_shutting_down`, `system/model_refusal_fallback` / `_no_fallback`, `system/permission_denied`, `prompt_suggestion`, `system/informational`, `system/conversation_reset`, `system/session_writes_lost`, `mirror_error` | not seen | All in the `SDKMessage` union (`:5644`). The plugin must ignore unknown types safely. |

`claude -p --output-format stream-json --verbose --include-partial-messages` (probe1) gives the same core sequence: `hook_started`, `hook_response`, `init`, `status`, stream events, `assistant`, `user`, `result`. It has no `command_lifecycle` and no `session_state_changed` (those need the SDK-mode env and stream-json input).

---

## 6. Gaps and open questions

- ~~Interrupt during a running foreground tool~~: done in round 2 (`aborted_tools`, probe7 S).
- `onElicitation`, `backgroundTasks`, `rewindFiles`, `mcpAuthenticate` and `cancelAsyncMessage` were not run live.
- ~~Workflow agents' live output~~: answered in Round 3 (§8.2): tail `<transcriptDir>/agent-<agentId>.jsonl` (written live), as t3code does (`reference-ux` answer 3); `getSubagentMessages()` also works for workflow agents.
- Main-thread agent mid-session: `applyFlagSettings({agent})` after the first turn is accepted but has no effect on 2.1.318 (Round 3, §8.1). A later CLI may fix it; re-test with the `getContextUsage` check in §8.1.
- `session_state_changed` is hidden by the SDK. Confirm that `status` / `result` / `command_lifecycle` are enough to drive busy and idle, including CLI-started turns.
- How far the user's CLI can drift ahead of, or behind, the pinned SDK before a control breaks.
- ~~`send_task_message`~~: unsupported on 2.1.318 (round 2). A later CLI may add it; detect it by trying once and treating the error as "not supported".
- Teams: the `in_process_teammate` task type exists in the binary but did not appear in SDK mode. When it appears (other CLI versions or settings) is **unverified**. A message delivered to a teammate *while it runs* ("queued … at its next tool round") was not seen on the stream; whether it is forwarded is **unverified**.

---

## 7. Round 2 (critic questions)

Probe: `probe7` (sessions P, T, B, S, M), `probe7a` and `probe7b` (no model turns). Same setup as round 1: the user's CLI 2.1.318, `claude-sonnet-5-5`, a scratch git repo, a clean env. The user's settings set `permissions.defaultMode: auto`, `teammateMode: in-process`, and env `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.

### 7.1 Agent teams and `send_task_message` (probe7 M, S)

| Fact | Evidence |
|---|---|
| `system/init.tools` has `SendMessage`, `ListAgents`, `TaskStop`, `Task`; no `TeamCreate` / `TeamDelete`. The model searched for a team tool, found none, and spawned the teammates with the `Agent` tool and `name`, `team_name`. | probe7 M |
| Teammates are background `local_agent` tasks (`is_backgrounded: true`, `spawn_depth: 1`), not `in_process_teammate`. The teammate name is in the subagent `.meta.json` (`name: "bob"`), not on `task_started`. | probe7 M; transcript folder `subagents/agent-<id>.meta.json` |
| Teammate turns are forwarded like any subagent (with `forwardSubagentText`): `assistant` / `user` frames with `parent_tool_use_id` and `agent_id`. A `SendMessage` call looks like `{to:"bob", message:"ping", summary, recipient:"bob", recipient_kind:"name"}`. Its result says the message is queued for the next tool round, or `Resuming agent alice` with `pin {id, name}`. | probe7 M |
| A message to a finished teammate resumes it: a new `task_started` with the **same** `task_id`, a **new** `run_id`, `tool_use_id` = the sender's `SendMessage` call, and `prompt: "<agent-message from=\"alice\">ping</agent-message>"`. The plugin can draw the exchange from the sender's `SendMessage` block and the receiver's `task_started.prompt`. | probe7 M |
| Teammates end with a `SubagentHandback` call. The main thread gets `task_notification completed` and the CLI runs its own short turn each time. | probe7 M |
| Transcripts: `listSubagents(sessionId)` lists both teammates; `getSubagentMessages(sessionId, agentId)` returns the full teammate transcript, including the inbound `<agent-message>` user turn. | probe7-sub |
| `send_task_message` (sent raw through `Query.request`) fails with `Unsupported control request subtype: send_task_message` for a teammate and for a running background agent. In the binary, its handler always throws that error; one special route exists for a resumed agent the session does not track (a remote context, **unverified**). | live; CLI 2.1.318 binary (control handler table) |

**Design consequence (R6.3):** show a roster from `task_started` plus the meta name, messages from `SendMessage` blocks and resume prompts, transcripts from `getSubagentMessages`. There is no host control to message a teammate on 2.1.318. Mark "message a teammate" as not supported by the CLI, or route it through a normal user turn to the main agent.

### 7.2 Permission modes (probe7 P, B, probe7a, probe7b)

| Step | Result |
|---|---|
| Start (no `permissionMode` option) | `current_permission_mode: auto` (the user's `defaultMode`) |
| `default`, `acceptEdits`, `plan`, `auto`, `dontAsk` | each OK; one `status {status:null, permissionMode:<mode>}` each |
| `bypassPermissions` without the flag | error: "Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions"; no frame |
| `bypassPermissions` with `allowDangerouslySkipPermissions` (spawn arg `--allow-dangerously-skip-permissions`) | OK, frame `bypassPermissions`; the next `init` shows it; the start mode stays the user's own |
| Settings `permissions.defaultMode: "bypassPermissions"` (research-only `--settings` layer), no flag | starts in bypass; switching away and back to bypass works |
| `auto` on a model without auto support | error: "auto mode unavailable for this model" |
| Model switch to that model while in `auto` | mode drops to `default`, `status` frame |
| `auto` after `applyFlagSettings({disableAutoMode:'disable'})` | error: "auto mode disabled by settings"; works again after `null` |
| Same `default` twice | the second call emits no frame |

The binary computes bypass availability as "start mode is bypass, or the allow flag is set", and never when `permissions.disableBypassPermissionsMode: "disable"` is set (CLI 2.1.318 binary). The TUI works the same way: the user launches `claude --allow-dangerously-skip-permissions`, or sets `defaultMode`. So the raw plugin passes the flag only when the user turns on a plugin option that says exactly that. Also, with bypass available, plan mode does not ask before most edits (binary notice: "Session was started with bypass permissions, so plan mode won't ask…"). The binary's other auto-off reasons: organization policy, managed settings, fast mode on, "isn't available in this session". `supportedModels()[].supportsAutoMode` tells the picker which models can use auto.

### 7.3 Workflow and agent stop (probe7 S, `perTaskStopAffordance: true`)

1. One turn started a 2-phase workflow (phase 1 agent runs a 70 s shell), and background agents bgA (50 s shell) and bgB (80 s shell).
2. A foreground Bash, then `interrupt()` after 3 s: `result error_during_execution`, `terminal_reason: aborted_tools`. No `task_notification` for any task; all three stayed in `background_tasks_changed`.
3. `stopTask(workflow)`: at once `task_updated {status:killed}`, `task_notification stopped` for the workflow and for the shell its agent started. The last `workflow_progress` showed agent `slow1` as `state: "error"`. bgA and bgB went on.
4. `stopTask(bgA)`: `stopped` for bgA and its shell. bgB went on.
5. bgB finished (`completed`) about 60 s later, and the CLI ran its own turn to report it.

The workflow agent's shell had no `parent_task_id`, as `SDK/sdk.d.ts:3859` says for agents inside a workflow. After the stops, the CLI ran an unprompted turn that mentioned the stopped work.

### 7.4 Session title (probe7 T, P)

- With non-essential traffic allowed (research-only `--settings` env override), the first turn produced an `ai-title` entry in the transcript about 1 s after the reply. `getSessionInfo()` showed it as `summary` and `customTitle`. No `session_title_changed` frame came. `result.modelUsage` listed only the main model, so the title call's cost is not visible there (**unverified** which model it used).
- With the user's settings (non-essential traffic off), there was no title entry. `getSessionInfo().summary` was the first prompt.
- The binary gates the automatic title on non-essential traffic and `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` (CLI 2.1.318 binary). The headless title path skips a session that already has a title.
- `generateSessionTitle(…, {persist:true})` returned the CLI's title in about 1 ms and appended a second identical `ai-title` entry.

### 7.5 Side questions (probe7 P)

| Case | Timing | Answer |
|---|---|---|
| Idle | 0.8 s | ORCHID (right) |
| While the main turn streamed 400 numbers | asked at the first delta, answered 2.4 s before the turn's `result` | ORCHID |
| While a 15 s foreground Bash ran | answered 13 s before the `tool_result` | ORCHID |
| "Which fruit did you name before?" with `history: [{question, response:"Mango"}]` | 0.8 s | Mango |
| Same, no `history` | 0.8 s | NONE |

None of the side questions reached the transcript. In the binary, the SDK handler runs in the background, uses the live messages, and drops a still-streaming assistant message from the context. The TUI keeps `btwHistory`: the last 20 exchanges, per agent, appending only non-synthetic answers. The SDK path passes `threadHistory: false`, so the host must keep and send that list. Accepted fields: `question`, `response`, optional `fallback_notice` (CLI 2.1.318 binary).

---

## 8. Round 3: main-thread agent and live workflow output

Closes critic §6.1 items 3 (R6.4) and 4 (R6.5). Probe: `probe8` (sessions A–H for agents, W for workflows), in the local scratch folder. Same setup as round 2: the user's CLI 2.1.318, `claude-sonnet-5-5`, a scratch git repo, a clean env. The repo has two project agents, `pirate` ("Start every reply with the word ARRR") and `parrot` ("… SQUAWK"), both `model: inherit`. Total cost about $0.45.

A reply that starts with ARRR is weak evidence after the first turn, because the model can copy its own earlier replies. So the clean signal is the `System prompt` category of `getContextUsage()`: 1134 tokens for the `claude_code` preset, 27 for either test agent. It needs no model call.

### 8.1 Main-thread agent (R6.4)

| Case | Result |
|---|---|
| Start with `agent: 'pirate'` (A, F) | Spawn args gain only `--agent=pirate`. System prompt 27 tokens; reply "ARRR, …". The transcript gets `{"type":"agent-setting","agentSetting":"pirate"}` entries. `system/init` has no agent field; `getSettings()` and `getStatus()` do not show it. |
| No option; `applyFlagSettings({agent:'pirate'})` **before** the first message (C, E) | Works: 1134 → 27 tokens; both replies "ARRR". `applyFlagSettings({agent:null})` before the first message goes back to 1134 (E). |
| No option; switch to `pirate` **after** turn 1 (B) | Accepted, no error, no stream frame. `getSettings().effective.agent` and the flag layer say `pirate`; an `agent-setting pirate` entry is written. But the next replies have no ARRR (turns 2 and 4). |
| No option; switch to `parrot` after turn 1 (E) | Accepted; system prompt stays 1134; reply has no SQUAWK. |
| Started with `pirate`; switch to `parrot` after turn 1 (F) | Accepted; an `agent-setting parrot` entry is written; system prompt stays 27; reply "ARRR", not SQUAWK. |
| Started with `pirate`; `agent:null` after turn 1 (D, F) | Accepted; system prompt stays 27; reply still "ARRR". No `agent-setting` entry is written for the clear. |
| Unknown name (B) | Rejected: `Agent "nope" not found`. |
| `--resume` with no `agent` option (G, H) | A session **started** with an agent keeps an agent-sized prompt (27 tokens; F, C). Session B, whose only agent switch came after turn 1, resumes with the preset (1134), even though its transcript ends with `agent-setting pirate`. Which entry the CLI restores from is **unverified**. |

Code evidence (CLI 2.1.318 binary):
- Start-up reads the main-thread agent from the `--agent` flag, else from the settings key `agent` (the `Settings.agent` field, `SDK/sdk.d.ts:9527`). Seating an agent sets its prompt as the system prompt only when no custom system prompt is set, applies its `model` unless the user named a model, and queues its `initialPrompt` (frontmatter) as a first user turn. With the preset, the SDK sends no `systemPrompt`, so this is the TUI's behaviour.
- The `apply_flag_settings` handler has an "agent switch" path (`requestedAgent`, `preAgentSystemPrompt`, error texts "agent must be a string or null", `Agent "<x>" not found`). It replaces the system prompt only when the session has no system prompt yet, or when the current one is the old agent's prompt. That fits the live result: after the first turn the switch updates the app state and the transcript, but not the prompt. Whether it changes the agent's tool limits or model mid-session was not tested (**unverified**).
- There is no `set_agent` control and no TUI command to switch the main-thread agent (`/agents` is a hidden "(removed)" command). The TUI picks the agent only at launch (`--agent`) or from settings.

**Design consequences (R6.4):**
- List agents from `supportedAgents()` (name, description, model). It includes user, project, plugin and built-in agents.
- Offer "agent for this session" on a **new** session only. Pass `agent` at spawn (it mirrors `claude --agent`), or call `applyFlagSettings({agent})` before the first message. Lock the picker after the first turn and say why ("Claude Code cannot change the main agent mid-session"). Do not offer the switch mid-session even though the control accepts it: it would show a choice that does nothing.
- Default: pass nothing, so the user's settings `agent` (if any) applies, as in the TUI.
- Remember the choice per session (no wire field reports it). On resume, pass the same `agent` again rather than rely on the transcript restore, which is unclear.
- Show that the agent replaces the system prompt and can set the model and an `initialPrompt`. That is the user's own agent file, so it is raw.

### 8.2 Live workflow-agent output (R6.5)

Session W: a 1-phase workflow with two parallel agents: `w1` runs three `sleep 4; echo …` Bash calls one at a time, `w2` replies "beta". `perTaskStopAffordance` and `forwardSubagentText` on. The probe polled `listSubagents()` / `getSubagentMessages()` and the transcript folder every 500 ms.

| Fact | Evidence |
|---|---|
| No workflow-agent `assistant`, `user` or `stream_event` frame reached the SDK stream (0 frames with `parent_tool_use_id`). | W messages |
| The Workflow tool result (`tool_use_result`) has `status: "async_launched"`, `taskId`, `runId` (`wf_…`), `transcriptDir`, `scriptPath`. The `wf_…` run id is **not** the `task_started.run_id`. | W, probe6 W |
| Folder layout: `<projects>/<cwd-slug>/<session>/subagents/workflows/<wf runId>/` with `journal.jsonl` (`launched`, then `started {agentId, label, phase}` and `result {agentId, result}` per agent), `agent-<agentId>.jsonl` and `agent-<agentId>.meta.json` (`agentType: "workflow-subagent"`, `description` = label, `workflowPhase`). | W, probe6 W |
| The agent file is appended **live**, one JSON line per message. Seen per 500 ms poll: first user message at 0.5 s after launch, then each `tool_use`, `tool_result` and the final `text` within one poll of the step. The lines are whole messages (no text deltas). The file also holds bulky non-chat lines (attachments, `prompt_snapshot`, `api-request*`): 155 KB for 9 chat messages. | W poll |
| `listSubagents(sessionId)` includes workflow agents as soon as their file exists. `getSubagentMessages(sessionId, agentId)` returns only the chain: `user`, `assistant` (text, `tool_use`), `user` (`tool_result`). It re-reads the whole file each call. | W poll; offline check on the probe6 session |
| The first two user messages are the CLI's own workflow framing ("[Workflow harness — user request] …", "[Workflow harness — computed task] …"). | W transcript |
| A workflow agent's Bash call also shows on the main stream as `task_started` / `task_notification` with `task_type: "local_bash"`, `is_backgrounded: false`, no `parent_task_id`, and `tool_use_id` = the agent's own `tool_use` id (found only in that agent's file). | W messages + transcript grep |
| `workflow_progress` rate: 7 `task_progress` frames for the workflow in 18.5 s. They come on events (agent start, each tool call, agent done), not on a timer. 5 frames carried the full list (1.2–1.5 KB for 2 agents); 2 carried only `usage` and `summary` (about 400 bytes). Agent fields seen: `state` (`start` → `progress` → `done`), `agentId` (missing until the agent starts), `tokens`, `toolCalls`, `lastToolName`, `lastToolSummary` (here the shell command), `startedAt`, `lastProgressAt`, `durationMs`, `resultPreview`, `promptPreview`. | W messages |
| `task_progress.usage` is cumulative for the whole run (`total_tokens`, `tool_uses`, `duration_ms`). | W messages |

**Design consequences (R6.5):**
- Source of live agent output: tail `<transcriptDir>/agent-<agentId>.jsonl` by byte offset (watch the folder, or poll about every 500 ms while the workflow runs), keep only `user`/`assistant` lines, and write them into the agent's DSH child session. Use `getSubagentMessages()` for a full reload (after a DSH restart, or when the file was missed). Reading these files is a file read by the plugin host, not a new process (rule 9).
- Take `transcriptDir` and the `wf_…` run id from the Workflow tool result. Map `workflow_progress[].agentId` to the file name. `journal.jsonl` gives start and result per agent and survives a restart.
- Drive phases, agent rows, status, tokens and tool counts from `workflow_progress` alone. Its rate is low (one frame per agent event), so no throttling is needed. Each frame carries the full list, so replace, do not merge. Ignore frames with no `workflow_progress`.
- Attach workflow-agent shells (`local_bash` with a `tool_use_id` from an agent file) to that agent, not to the main thread.
- Child text is per message, not per token, as for normal subagents (answer 5).
- Still open: the ultracode keyword with `origin: human` (not tested here).

---

## Round 3b: plan approval and elicitation

Closes critic §6.1 item 5 (R5.4, R5.5). Probe: `probe-r3b` (sessions A–I), in the local scratch folder. Same setup as round 2: the user's CLI 2.1.318, `claude-sonnet-5-5`, a fresh scratch git repo per session, a clean env. Plan sessions enter plan mode with `setPermissionMode('plan')` after start, so the pre-plan mode is the user's `defaultMode` (`auto` here). The user's settings allow `Write` and `Edit` by rule, so a file write never asks in any mode; the sessions use `rm` to show the mode's effect. Total cost about $0.55. This section supersedes the "**unverified** live" note on the ExitPlanMode row in §5 and the `onElicitation` bullet in §6.

### Plan approval (ExitPlanMode)

**What the CLI sends.** `can_use_tool` with `tool_name: "ExitPlanMode"`, `input {plan, planFilePath}`, `requires_user_interaction: true`, and **no** `permission_suggestions` (all 8 plan sessions). The host must build the mode choices itself.

**What the TUI offers** (CLI 2.1.318 binary, the plan-approval dialog "Claude has written up a plan and is ready to execute. Would you like to proceed?"):

| TUI choice | What it returns |
|---|---|
| "Yes, and use auto mode" (shown when the pre-plan mode was `auto` and auto is still allowed) | allow with an **empty** update list; the CLI then restores the pre-plan mode |
| "Yes, auto-accept edits" | allow + `{type:'setMode', mode:'acceptEdits', destination:'session'}` |
| "Yes, manually approve edits" | allow + `setMode default`, `destination: 'session'` |
| bypass variant (only when bypass is available) | allow + `setMode bypassPermissions` |
| "Yes, clear context … and …" variants | only with the `showClearContextOnPlanAccept` setting (default off). Not tested in SDK mode (**unverified**). |
| "No, and tell Claude what to do differently" | reject with feedback (see "Keep planning" below) |

The binary restores the pre-plan mode on plan exit only while the mode is still `plan` (`ExitPlanModeV2Tool`: `if (L.mode === "plan" …) { s = L.prePlanMode ?? "default"; … }`), and falls back to `default` when auto mode is no longer allowed.

**Live results:**

| Session | Reply to ExitPlanMode | `status.permissionMode` after | Next step |
|---|---|---|---|
| D | allow, no updates | `auto` (the user's default, restored) | `rm old.txt` ran with no ask |
| A, F | allow + `setMode acceptEdits` (session) | `acceptEdits`, 3 ms after the reply | F: `rm old.txt` ran with no ask |
| B, G | allow + `setMode default` (session) | `default`, 3 ms after the reply | G: `rm old.txt` asked through `canUseTool`, with suggestions `addRules` (localSettings), `addDirectories` (session), `setMode acceptEdits` (session) |
| C (2nd call) | `setPermissionMode('acceptEdits')` inside the callback, then allow with no updates | `acceptEdits` (the restore was skipped because the mode was no longer `plan`) | write ran |

- Each approval emits exactly one `system/status {status:null, permissionMode}` frame, so the picker follows the CLI with no extra work (R5.1).
- `setMode` with `destination: 'session'` is session-only: `getSettings().effective.permissions.defaultMode` stayed `auto`, the settings file mtimes did not change, and no `.claude/` folder appeared in the project. Never use another destination for a plan choice: `userSettings`, `projectSettings` and `localSettings` are settings files.
- The ExitPlanMode `tool_result` text is the CLI's own ("User has approved your plan. You can now start coding. …", plus the plan path and the plan). It is the same for every mode choice. `tool_result_meta.permission_decision` is `{decision: "accept", source: "user_temporary"}`.
- Prefer `updatedPermissions` over a `setPermissionMode` call inside the callback. Both work, but `updatedPermissions` is the TUI's own path and is applied by the CLI together with the approval.

**Keep planning with feedback:**

| Session | Reply | What the model did |
|---|---|---|
| C (1st call) | `deny` with the user's feedback as `message` ("Keep planning: the file must contain two lines, hi and then bye.") | The CLI put the message verbatim in an error `tool_result` (`tool_result_meta: {decision: "reject", source: "user_reject"}`). The model **ignored** it: "That didn't come from you, so I ignored it and resubmitted the plan unchanged." (n = 1; whether this user's CLAUDE.md made the model suspicious is **unverified**.) |
| H | `deny` with the CLI's own rejection text ("The user doesn't want to proceed with this tool use. The tool use was rejected … STOP what you are doing and wait for the user to tell you how to proceed."), and at the same moment the user's feedback sent as a normal user message (`priority: 'next'`, `origin: {kind:'human'}`) | The feedback was folded into the same turn: `command_lifecycle` `queued` → `started` right after the denial `tool_result`, and the turn's `user_message_uuids` listed both messages. Plan mode stayed on (no `status` frame). The model revised the plan to "hi, then bye" and called ExitPlanMode again; approval with `setMode acceptEdits` gave `hi\nbye`. |

- The rejection text in H is the CLI's own constant. The same text appears for rejected tool uses in this user's own earlier transcripts.
- Which text the TUI sends when the user also **types** feedback on "No" was not found in the binary in the time spent (**unverified**). So the H path is the safe raw choice: the denial text is the CLI's, and the feedback is text the user typed, sent as a user message. A plain "No" with no feedback is the same denial with no extra message.

### MCP elicitation through `onElicitation`

Server: a tiny stdio MCP server (MCP SDK 1.32.2) with two tools, `ask_color` (form mode) and `open_login` (URL mode, then `notifications/elicitation/complete`). It was configured **only** in the probe, through the SDK `mcpServers` option (that adds `--mcp-config <json>` to the spawn args). Nothing was added to any user settings file. The tool calls themselves never reached `canUseTool`: the user's `auto` mode allowed them (`tool_result_meta.permission_decision.reason_type: "classifier"`). The tool permission and the elicitation are separate steps.

| Fact | Evidence |
|---|---|
| CLI 2.1.318 declares MCP client capabilities `elicitation: {form: {}, url: {}}` and `roots: {listChanged: true}`; client name `claude-code`. | server log, session E |
| Wire: `control_request {subtype: "elicitation", mcp_server_name, message, mode: "form", requested_schema, property_order: ["color","note"]}`. URL mode: `mode: "url", url, elicitation_id`. | E wire |
| `onElicitation(req, {signal, requestId})` gets `serverName`, `message`, `mode`, `requestedSchema` (form) or `url`, `elicitationId` (URL). `property_order` is **not** passed to the callback. `requestId` equals the wire `request_id`. | E notes |
| Form accept: the server received exactly `{action: "accept", content: {color: "green", note: "from probe"}}`. Decline: `{action: "decline"}`. URL accept: `{action: "accept"}`. The tool's text reached the model unchanged. The CLI added nothing to the content and did not check it against the schema in this run (**unverified** for invalid content). | E server log, E `tool_result` |
| After the URL accept, the server's completion notice arrived as `system/elicitation_complete {mcp_server_name, elicitation_id}` about 0.5 s later, before the tool's `tool_result`. The SDK yields it. | E messages |
| Round trip with an instant handler: 4–11 ms from the server's request to its result. | E server log |
| Interrupt while an elicitation waits (session I): the CLI sends `control_cancel_request` for the elicitation's `request_id`, and the SDK aborts `signal` (`AbortError`). A reply sent after the abort is still written to the wire. The server got `{action: "cancel"}` (whether from the CLI or from the late reply is **unverified**). The `tool_result` is the CLI's "stopped while running" text, the `result` is `error_during_execution` with `terminal_reason: aborted_tools`, and the message's `command_lifecycle` is `cancelled`. | I wire, I server log |
| On the wire, `session_state_changed` goes to `requires_action` during each elicitation and permission ask, then back to `running`. The SDK does not yield it (§5). | E, G, I wire |
| User `Elicitation` / `ElicitationResult` hooks run around this path and can answer first (`ElicitationHookInput` at `SDK/sdk.d.ts:730`, `ElicitationResultHookInput` at `:782`; `onElicitation` runs only when no hook handles the request, `:1810-1828`). Not tested. | SDK types |

**Design consequences (R5.5):**
- Always pass `onElicitation`. Render `requestedSchema` (form) or `url` (URL mode) in the plugin's interaction surface (`dsh-ui-surfaces` Round 2 Q3), and return the user's `accept` + `content`, `decline` or `cancel` as-is.
- Close the form when `signal` aborts (Stop, interrupt), and do not send a reply after that.
- For URL mode, keep the card open after `accept` until `system/elicitation_complete` with the same `elicitation_id` arrives, or until the tool's result arrives.
- Field order: JS object key order is kept, so `requestedSchema.properties` order is enough. The wire's `property_order` is not exposed.
