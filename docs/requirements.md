# Requirements

Each requirement has an id, the rule, and a **check** (how to prove it in a live DSH session). The build is done when every row passes its check, or a row is explicitly deferred in `docs/architecture.md` with a reason.

Definitions:
- **The CLI** means the user's own `claude` binary.
- **Raw** means "as the Claude Code CLI does it", with no change by this plugin.

## R1. Your binary and your configuration

| Id | Requirement | Check |
|---|---|---|
| R1.1 | Run the user's own `claude`: a configured path, else `PATH`, else `~/.local/bin/claude` on every OS. Never run the SDK-bundled CLI, and avoid installing the SDK's platform binaries. | `ps` shows the user's path. The install has no `claude-agent-sdk-<platform>` package, or the plugin docs say why it is unavoidable. |
| R1.2 | Load `user`, `project` and `local` settings, so CLAUDE.md, memory, skills, plugins, hooks, MCP, agents and output styles behave as in the CLI. | `system/init` lists the same tools, skills, agents, MCP servers and slash commands as `claude -p` in the same folder. |
| R1.3 | The plugin never writes the user's Claude Code settings files. It offers quick access to open `~/.claude/settings.json`, `<project>/.claude/settings.json` and `<project>/.claude/settings.local.json`. | The file mtimes are unchanged after a full test run. A visible control opens each file for editing. |
| R1.4 | Model, effort and permission-mode choices in the UI apply to the current session only, through SDK controls. The default comes from the user's settings. | A new session with no choice runs the user's `model` / `effortLevel` / `defaultMode` (check `ps` args and the transcript). |

## R2. Nothing hidden (raw contract)

| Id | Requirement | Check |
|---|---|---|
| R2.1 | The system prompt is the `claude_code` preset with **no append**. | The transcript's `prompt_snapshot` equals a plain `claude -p` snapshot from the same folder (aside from sections the CLI itself varies). |
| R2.2 | Only text the user typed or attached reaches the model: no synthetic user turns, no rewritten tool results, no helper prompts. | grep the transcript for any user or tool text not typed by the tester: none. |
| R2.3 | No forced tools, env flags or settings layers. | `ps` args and `/proc/<pid>/environ` contain no plugin-added flags or variables, except documented ones the user opted into. |
| R2.4 | The env is passed through. Only host Claude Code session variables are stripped (list verified and documented). | Compare the env diff between the DSH process and the CLI process. |
| R2.5 | No extra `claude` processes the user did not ask for. | `pgrep` during a session shows only the session processes. No new transcripts appear in `~/.claude/projects` beyond the session's own. |

## R3. Session lifecycle

| Id | Requirement | Check |
|---|---|---|
| R3.1 | One persistent CLI process per active session. Resume by Claude session id after a DSH restart. | Restart DSH, ask a follow-up, and Claude remembers. |
| R3.2 | Stop = `interrupt()`. The process and its background tasks keep running. | Start a background agent, press Stop: the agent finishes and its result arrives. |
| R3.3 | Background work never holds the DSH turn. The session stays free, and completions arrive the way the CLI delivers them. | During a background agent the composer is idle and a new message starts a new turn. |
| R3.4 | Steer and queue mid-turn, like the CLI. | Type during a long turn: the message is read at the next step (steer) or queued, as the user chooses. |
| R3.5 | DSH fork keeps Claude's memory (SDK `forkSession` or `--fork-session`). Rewind truncates Claude's memory (`resumeSessionAt`). | Fork, then ask about an earlier turn: Claude knows. Rewind, then ask about a dropped turn: Claude does not. |
| R3.6 | No reply is ever lost. Crashes and exits are reported clearly. | Kill the CLI mid-turn: the UI says so. Every CLI `result` has its text in the UI. |

## R4. Transcript in DSH

| Id | Requirement | Check |
|---|---|---|
| R4.1 | Prose, thinking, tool calls and tool results are native DSH events, so DSH tool cards, export, search and fork work. | The DSH session log has the native types. DSH's export contains the tool calls. Opening the session in plain DSH renders it. |
| R4.2 | Text streams live. | First-token time in the UI matches the CLI (no end-of-turn dump). |
| R4.3 | Images and file attachments reach Claude as in the CLI. | Paste an image: Claude describes it. Attach a file: Claude reads it without an extra approval. |

## R5. Permissions and interaction

| Id | Requirement | Check |
|---|---|---|
| R5.1 | All permission modes: default, acceptEdits, plan, auto, dontAsk, bypassPermissions. The user can switch mid-session. The picker always shows the CLI's real mode (`status.permissionMode`). | Switch modes during a session. After a plan approval, the picker matches the CLI. |
| R5.2 | Approvals offer the CLI's choices: allow once, always allow (the CLI's own suggestions), and reject with feedback. They show a diff or command preview, are attached to the tool card, and name the asking subagent. | Approve "always" once: the repeat does not ask. Reject with feedback: Claude reads it. |
| R5.3 | AskUserQuestion: single and multi select, "Other", option previews. | Previews render. Answers arrive. |
| R5.4 | Plan mode: the plan is shown; approve with a mode choice, or keep planning with feedback. | All three outcomes work. |
| R5.5 | MCP elicitations (forms, auth URLs) are shown to the user, not auto-declined. | An MCP server that asks for input gets it. |

## R6. Agents

| Id | Requirement | Check |
|---|---|---|
| R6.1 | Subagents: a tree view, live child output (text, thinking, tools), per-child stop, approvals that name the subagent. | A nested agent shows under its parent. Stop one child: the others continue. |
| R6.2 | Background agents and shells appear in DSH's job list with live status. | Job rows appear and settle with the right status. |
| R6.3 | Agent teams: roster, messages between teammates, teammate transcripts. Messaging a teammate if the CLI supports it. | Two named agents exchange `SendMessage`, and the UI shows it. |
| R6.4 | Custom agents (user, project, plugin) are listed, and can be picked for the main thread if the CLI allows it. | The list matches `supportedAgents()`. |
| R6.5 | Dynamic workflows: run row, phases, agents with status and tokens, live agent output, stop whole run, final report. Ultracode effort and keyword work. | A 2-phase workflow shows its phases and agents live. Stop ends it cleanly. |

## R7. Commands, skills, MCP

| Id | Requirement | Check |
|---|---|---|
| R7.1 | The `/` menu is the CLI's `supportedCommands()`: built-ins, skills, plugin and custom commands, MCP prompts. Original names are kept; DSH name clashes are handled visibly. | The menu matches `system/init.slash_commands`. |
| R7.2 | Local command output (`/context`, `/usage`, `/cost`, …) renders well, structured where the CLI gives structure. Local commands do not corrupt usage displays. | `/context` shows its categories. The ring is unchanged afterwards. |
| R7.3 | `/btw` works like the TUI: full context, no tools, nothing written to the transcript, warm cache, a side panel with history (`askSideQuestion`). | Ask about an earlier turn: correct answer. The transcript and DSH log are unchanged. |
| R7.4 | MCP server status (connected, failed, needs auth), reconnect and toggle. | It matches `mcpServerStatus()`. |
| R7.5 | Skill tool cards name the skill. | Visual check. |

## R8. Usage, from any account type

| Id | Requirement | Check |
|---|---|---|
| R8.1 | Per-turn tokens (input, output, cache read, cache write), cost, per-model `modelUsage`, and subagent/other tokens. | The numbers match the transcript and the `result` message. |
| R8.2 | The context ring is correct from turn 1 (`getContextUsage()` / `modelUsage[*].contextWindow`), with Claude's categories, the auto-compact point, and compaction shown. | Turn 1 shows the ring. The breakdown matches `/context`. |
| R8.3 | Subscription accounts: live 5-hour and weekly limits (`rate_limit_event` + the usage API). API key, Bedrock and Vertex: cost (list price noted) and no fake limits. | Test with each auth type available. |
| R8.4 | DSH's own token meter, cache-hit % and speed stats are fed correct numbers, or are hidden for these sessions. | No impossible values (for example tok/s above model speed). |

## R9. Built for DSH plugins

| Id | Requirement | Check |
|---|---|---|
| R9.1 | Other DSH plugins can restyle or replace the UI (slots, native events, services). | A sample plugin overrides one view. |
| R9.2 | A documented service API for other plugins: send, steer, side question, session info, events. | The sample plugin uses it. |

## R10. Platform and safety

| Id | Requirement | Check |
|---|---|---|
| R10.1 | Works behind DSH `--public-url` / `--trusted-host` and reverse proxies. No unauthenticated routes; no arbitrary file reads. | Plugin requests through a proxy host succeed. A request without DSH auth gets 401/403. |
| R10.2 | Linux, macOS, Windows. | CI matrix or a manual check. |
| R10.3 | A backend interface. The DSH layer does not import the Claude SDK. A second backend (Codex) can be added without touching the DSH layer. | Import graph check. A stub backend passes the core tests. |
| R10.4 | MIT. No telemetry. Works on the DSH version range declared in `package.json`. | License file. A grep for network calls. Install on the declared versions. |
