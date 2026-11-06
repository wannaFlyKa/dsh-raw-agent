# Requirements

Each requirement has an id, the rule, and a **check** (how to prove it in a live DSH session). The build is done when every row passes its check, or a row is explicitly deferred in `docs/architecture.md` with a reason.

Definitions:
- **The CLI** means the user's own `claude` binary.
- **Raw** means "as the Claude Code CLI does it", with no change by this plugin.

## R1. Your binary and your configuration

| Id | Requirement | Check | Status |
|---|---|---|---|
| R1.1 | Run the user's own `claude`: a configured path, else `PATH`, else `~/.local/bin/claude` on every OS. Never run the SDK-bundled CLI, and avoid installing the SDK's platform binaries. | `ps` shows the user's path. The install has no `claude-agent-sdk-<platform>` package, or the plugin docs say why it is unavoidable. | done |
| R1.2 | Load `user`, `project` and `local` settings, so CLAUDE.md, memory, skills, plugins, hooks, MCP, agents and output styles behave as in the CLI. | `system/init` lists the same tools, skills, agents, MCP servers and slash commands as `claude -p` in the same folder. | done |
| R1.3 | The plugin never writes the user's Claude Code settings files. It offers quick access to open `~/.claude/settings.json`, `<project>/.claude/settings.json` and `<project>/.claude/settings.local.json`. | The file mtimes are unchanged after a full test run. A visible control opens each file for editing. | partial: DSH has no editor; the preview is read-only, so editing goes through a terminal tab and a copied `cd` |
| R1.4 | Model, effort and permission-mode choices in the UI apply to the current session only, through SDK controls. The default comes from the user's settings. | A new session with no choice runs the user's `model` / `effortLevel` / `defaultMode` (check `ps` args and the transcript). | done |

## R2. Nothing hidden (raw contract)

| Id | Requirement | Check | Status |
|---|---|---|---|
| R2.1 | The system prompt is the `claude_code` preset with **no append**. | The transcript's `prompt_snapshot` equals a plain `claude -p` snapshot from the same folder (aside from sections the CLI itself varies). | done |
| R2.2 | Only text the user typed or attached reaches the model: no synthetic user turns, no rewritten tool results, no helper prompts. | grep the transcript for any user or tool text not typed by the tester: none. | done |
| R2.3 | No forced tools, env flags or settings layers. | `ps` args and `/proc/<pid>/environ` contain no plugin-added flags or variables, except documented ones the user opted into. | partial: two plugin-set env variables (D13, D16) wait on maintainer Q4/Q5 |
| R2.4 | The env is passed through. Only host Claude Code session variables are stripped (list verified and documented). | Compare the env diff between the DSH process and the CLI process. | done |
| R2.5 | No extra `claude` processes the user did not ask for. | `pgrep` during a session shows only the session processes. No new transcripts appear in `~/.claude/projects` beyond the session's own. | done |

## R3. Session lifecycle

| Id | Requirement | Check | Status |
|---|---|---|---|
| R3.1 | One persistent CLI process per active session. Resume by Claude session id after a DSH restart. | Restart DSH, ask a follow-up, and Claude remembers. | done |
| R3.2 | Stop = `interrupt()`. The process and its background tasks keep running. | Start a background agent, press Stop: the agent finishes and its result arrives. | done |
| R3.3 | Background work never holds the DSH turn. The session stays free, and completions arrive the way the CLI delivers them. | During a background agent the composer is idle and a new message starts a new turn. | done |
| R3.4 | Steer and queue mid-turn, like the CLI. | Type during a long turn: the message is read at the next step (steer) or queued, as the user chooses. | done |
| R3.5 | DSH fork keeps Claude's memory (SDK `forkSession` or `--fork-session`). Rewind truncates Claude's memory (`resumeSessionAt`). | Fork, then ask about an earlier turn: Claude knows. Rewind, then ask about a dropped turn: Claude does not. | open |
| R3.6 | No reply is ever lost. Crashes and exits are reported clearly. | Kill the CLI mid-turn: the UI says so. Every CLI `result` has its text in the UI. | open |

## R4. Transcript in DSH

| Id | Requirement | Check | Status |
|---|---|---|---|
| R4.1 | Prose, thinking, tool calls and tool results are native DSH events, so DSH tool cards, export, search and fork work. | The DSH session log has the native types. DSH's export contains the tool calls. Opening the session in plain DSH renders it. | done |
| R4.2 | Text streams live. | First-token time in the UI matches the CLI (no end-of-turn dump). | done |
| R4.3 | Images and file attachments reach Claude as in the CLI. | Paste an image: Claude describes it. Attach a file: Claude reads it without an extra approval. | done |

## R5. Permissions and interaction

| Id | Requirement | Check | Status |
|---|---|---|---|
| R5.1 | All permission modes: default, acceptEdits, plan, auto, dontAsk, bypassPermissions. The user can switch mid-session. The picker always shows the CLI's real mode (`status.permissionMode`). | Switch modes during a session. After a plan approval, the picker matches the CLI. | done |
| R5.2 | Approvals offer the CLI's choices: allow once, always allow (the CLI's own suggestions), and reject with feedback. They show a diff or command preview, are attached to the tool card, and name the asking subagent. | Approve "always" once: the repeat does not ask. Reject with feedback: Claude reads it. | done |
| R5.3 | AskUserQuestion: single and multi select, "Other", option previews. | Previews render. Answers arrive. | done |
| R5.4 | Plan mode: the plan is shown; approve with a mode choice, or keep planning with feedback. | All three outcomes work. | done |
| R5.5 | MCP elicitations (forms, auth URLs) are shown to the user, not auto-declined. | An MCP server that asks for input gets it. | done |

## R6. Agents

| Id | Requirement | Check | Status |
|---|---|---|---|
| R6.1 | Subagents: a tree view, live child output (text, thinking, tools), per-child stop, approvals that name the subagent. | A nested agent shows under its parent. Stop one child: the others continue. | done |
| R6.2 | Background agents and shells appear in DSH's job list with live status. | Job rows appear and settle with the right status. | done |
| R6.3 | Agent teams: roster, messages between teammates, teammate transcripts. Messaging a teammate if the CLI supports it. | Two named agents exchange `SendMessage`, and the UI shows it. | partial: no messaging a teammate from the UI; the CLI has no control for it (D50) |
| R6.4 | Custom agents (user, project, plugin) are listed, and can be picked for the main thread if the CLI allows it. | The list matches `supportedAgents()`. | done |
| R6.5 | Dynamic workflows: run row, phases, agents with status and tokens, live agent output, stop whole run, final report. Ultracode effort and keyword work. | A 2-phase workflow shows its phases and agents live. Stop ends it cleanly. | done (per-agent stop, restart and pause: not offered, the CLI has no control for them, D48; the typed ultracode keyword is checked only through an SDK probe, not typed in DSH) |

## R7. Commands, skills, MCP

| Id | Requirement | Check | Status |
|---|---|---|---|
| R7.1 | The `/` menu is the CLI's `supportedCommands()`: built-ins, skills, plugin and custom commands, MCP prompts. Original names are kept; DSH name clashes are handled visibly. | The menu matches `system/init.slash_commands`. | open |
| R7.2 | Local command output (`/context`, `/usage`, `/cost`, …) renders well, structured where the CLI gives structure. Local commands do not corrupt usage displays. | `/context` shows its categories. The ring is unchanged afterwards. | open |
| R7.3 | `/btw` works like the TUI: full context, no tools, nothing written to the transcript, warm cache, a side panel with history (`askSideQuestion`). | Ask about an earlier turn: correct answer. The transcript and DSH log are unchanged. | open |
| R7.4 | MCP server status (connected, failed, needs auth), reconnect and toggle. | It matches `mcpServerStatus()`. | open |
| R7.5 | Skill tool cards name the skill. | Visual check. | open |

## R8. Usage, from any account type

| Id | Requirement | Check | Status |
|---|---|---|---|
| R8.1 | Per-turn tokens (input, output, cache read, cache write), cost, per-model `modelUsage`, and subagent/other tokens. | The numbers match the transcript and the `result` message. | done (model time after a local command fixed after verify) |
| R8.2 | The context ring is correct from turn 1 (`getContextUsage()` / `modelUsage[*].contextWindow`), with Claude's categories, the auto-compact point, and compaction shown. | Turn 1 shows the ring. The breakdown matches `/context`. | done |
| R8.3 | Subscription accounts: live 5-hour and weekly limits (`rate_limit_event` + the usage API). API key, Bedrock and Vertex: cost (list price noted) and no fake limits. | Test with each auth type available. | done (Bedrock checked live; subscription plan limits only by unit tests on SDK-shaped `rate_limit_event` and usage-control frames, live **unverified**: no subscription account; API key and Vertex not tested) |
| R8.4 | DSH's own token meter, cache-hit % and speed stats are fed correct numbers, or are hidden for these sessions. | No impossible values (for example tok/s above model speed). | done (token meter and cache-hit % fed; TTFT and tok/s fed with guards, steps without a real timing stay untimed; native context ring hidden) |

## R9. Built for DSH plugins

| Id | Requirement | Check | Status |
|---|---|---|---|
| R9.1 | Other DSH plugins can restyle or replace the UI (slots, native events, services). | A sample plugin overrides one view. | open |
| R9.2 | A documented service API for other plugins: send, steer, side question, session info, events. | The sample plugin uses it. | open |

## R10. Platform and safety

| Id | Requirement | Check | Status |
|---|---|---|---|
| R10.1 | Works behind DSH `--public-url` / `--trusted-host` and reverse proxies. No unauthenticated routes; no arbitrary file reads. | Plugin requests through a proxy host succeed. A request without DSH auth gets 401/403. | open |
| R10.2 | Linux, macOS, Windows. | CI matrix or a manual check. | open |
| R10.3 | A backend interface. The DSH layer does not import the Claude SDK. A second backend (Codex) can be added without touching the DSH layer. | Import graph check. A stub backend passes the core tests. | open |
| R10.4 | MIT. No telemetry. Works on the DSH version range declared in `package.json`. | License file. A grep for network calls. Install on the declared versions. | open |

## Build status

Status values (also in the Status column of each table above): **done** (the live check passed), **partial** (built, with a short reason for what is missing), **deferred** (moved to a later milestone or to `docs/architecture.md`, with a reason), **open** (not built). The table below keeps the evidence notes per row.

| Id | Status | Notes |
|---|---|---|
| R1.1 | done | M1 live: `ps` shows the user's own `claude`. A packed install (`npm install` of the tarball) still pulls one `claude-agent-sdk-<platform>` package: the SDK lists them as `optionalDependencies`, and a dependency cannot override that. It is never run. The plugin README says why and gives the opt-in `overrides` block (D11). |
| R1.2 | done | M1 live re-run: a DSH-run session's `system/init` (captured by a test-only PATH shim that copies stdout) matches `claude -p` in the same folder: same agents, skills, plugins, MCP server names and slash commands; tools differ only by the CLI's own SDK-mode set (AskUserQuestion and plan tools vs MCP resource tools). Earlier: `system/init` with the plugin's own start options (a probe that uses `buildStartOptions`) matches `claude -p` in the same folder (agents, skills, plugins, MCP servers, non-MCP commands); the DSH-run `ps` args match. Differences come from the CLI: MCP servers still connecting at init, and `-p` lists no AskUserQuestion / plan tools. M1 fix: in a folder the CLI does not trust, the TUI's trust question is asked before the first spawn (D73); only the user's accept passes `workspaceTrust`; decline does not start the CLI. M1 live: accept starts the CLI and the CLI records trust itself; the project's permission rules then apply; decline starts no process. |
| R1.3 | partial | A "Settings files" button in the composer row of our sessions lists the user, project and local settings files read-only: masked preview (values under `env`, click to reveal one), "Copy path", "Open in DSH preview" (unmasked, read-only), "Open in terminal" (a DSH terminal tab, which DSH opens only in the session folder, plus a copied `cd` to the file's folder), and "Which file sets each key" (read from the files only). Escape closes the panel (capture phase). The plugin writes no settings file (D63). M1 live: all three files open from the panel; settings mtimes unchanged after the run. Open: DSH has no editor, so "opens for editing" means the terminal path (D63, §12.1 row 1); M1 live re-run: key layers, the copied `cd`, and Escape all work. |
| R1.4 | done | Model, effort and mode pickers in our sessions only, through the plugin route and SDK controls: model → `agent.model.select` (session only) + `setModel`; effort → `applyFlagSettings`; mode → `setPermissionMode` (D4, D35-D38). With no choice nothing is passed, so the user's settings apply. Our catalog lists no rows in DSH's global model directory, so DSH's model seat and `/model` cannot pick our provider (K1, S4). M1 live: a session with no choice ran the settings model and mode; a model choice never changed the DSH profile default; a new process of the same run keeps the chosen mode. M2 (live): the mode choice rides in the binding (`source.rawAgent.mode`, written only after a choice) and came back after a DSH restart (the resumed CLI ran it, D24); a DSH branch does not inherit it (it ran the settings mode). Our preset registers its own `/permission`: bare, it shows the Claude mode; `/permission <mode>` switches it for the session; an unknown name changes nothing. A bare `/permission` or its menu row no longer opens DSH's preset popup in our sessions; a Standard session keeps it. Trade-off: this reads a DSH client internal (`commandUi.live.decorations`); an upstream per-session hook would be cleaner. Small issues: the help lists `bypassPermissions` even when the session cannot use it; the effort is only inferred (the CLI reports none). |
| R2.1 | done | M1 live: `prompt_snapshot` identical to a plain `claude -p` run in the same folder. |
| R2.2 | done | M1 live: transcript user turns hold only typed text, attachments, the CLI's own tool results, interrupt markers and notifications. M1 fix: the spike handler that declined every ask (a plugin-made "the user doesn't want to proceed") is gone. Permission, question, plan and elicitation asks now wait for the user's click in the composer row; Stop gives the CLI's Esc answer. M1 live re-run: Allow once, Reject and Stop on a permission ask, and a single-select AskUserQuestion, were all user clicks; the transcript holds only the CLI's own texts for them. |
| R2.3 | partial | M1 live: `ps` args carry only the SDK's fixed flags. The env adds `CLAUDE_CODE_QUESTION_PREVIEW_FORMAT=markdown` (D13) and `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true` (D16). Both come from our own start options (TUI-default restorations), not from the user. They pass only as documented differences under the open maintainer questions §12.2 Q4 and Q5. |
| R2.4 | done | M1 live (S9): DSH started with host `CLAUDECODE` / `CLAUDE_CODE_*` / `CLAUDE_EFFORT` / `CLAUDE_PID` / `AI_AGENT` / `TRACEPARENT`; none reached the `claude` pid; a user variable passed through. |
| R2.5 | done | M1 live: one `claude` per session; no transcripts beyond the sessions' own. |
| R3.1 | done | One process per session, spawned on the first message or "Start" (route `POST /api/raw-agent/start`). Resume by the binding after a restart or a crash. Idle reaping is off by default (D6). With the Host entry's registry an evicted agent keeps its process (D87, live check open). M1 live: restart, follow-up remembered (`--resume`). |
| R3.2 | done | Stop calls `interrupt()` only, with `cancelQueued` when a steer is queued (D25); a DSH job teardown never stops a task (D47). M1 live: a background subagent finished after Stop and its result arrived. Fix: a steer the CLI cancels (`command_lifecycle cancelled`, which arrives before the receipt) is now returned, not claimed; the client puts its text back in the composer. M1 live round 3: a background agent's permission ask stayed open after Stop; the user's later Allow once let the agent finish. |
| R3.3 | done | Background tasks are jobs; self-started CLI turns are wake turns (D26). M1 live: composer idle during a background agent; a new message ran a new turn. |
| R3.4 | done | Steer: a typed message in `nextStep` is sent at once with priority `next` and claimed at the next step boundary (D27). Queue stays in DSH (D3). M1 live: queue, steer during a tool and during final text. DSH's default for Enter while busy is queue (Cmd/Ctrl+Enter steers); the TUI default is steer. A returned steer's text is only inserted at the caret, never over a typed draft. |
| R4.1 | done | Native events, including parallel calls with early results (D18), whole responses and tombstones (D84), synthetic API errors (D69); recorded and hand-built fixtures pass the real DSH checker, reload and stream replay. M1 live: parallel calls, v4 and replay checks, UI export with tool calls, renders and exports with the plugin disabled. |
| R4.2 | done | Live deltas with arrival times (D20); the writer emits each delta at once (no buffering). M1 live: partial text on screen mid-stream (no end-of-turn dump). M1 verify 2 measured first-token time: in the DSH UI (warm process, Enter to the first marker word on screen) 1.2-1.7 s; `claude -p` in the same folder with the same model, 1.6 s after `system/init`. |
| R4.3 | done | Pasted images go as base64 image blocks read from DSH's attachment store; files as the CLI's own `@"<path>"` form, in part order (D23). Tool-result images are stored with `saveImages()` and written as native attachment refs, never base64 (D85). Turn-1 image admission passes against a text-only DSH default (D76, round-trip test). M1 live: image described and file read with no tool call. M1 verify 3 fix: a message that cannot be built (an attached file whose path holds both a space and a `"`) failed but stayed pending in the backend, so every later turn of that process never ended; the message is now built before it is tracked (unit test; no live re-check). |
| R5.1 | done | M2 live: all six modes switched mid-session (with the plugin's bypass option); the picker showed the CLI's reported mode each time and after every plan approval (D38). Without the option, Bypass is greyed out with its reason and the route refuses it (409). dontAsk denies with no ask; bypass runs with no ask. Known lag: after plan to auto the picker can trail the CLI by up to one 4 s poll, because the choice route's answer is built before the CLI's `status` frame. Shift+Tab after a spawn not checked live (unit only). |
| R5.2 | done | M2 live (D39, D40, D77): allow once; "always" (the CLI wrote the rule only into the project's `.claude/settings.local.json`; the repeat did not ask); an edited Bash rule (`ln -s README.md *`) was saved by the CLI and covered the next command; plain reject stops the turn like the TUI; reject with feedback works in the main thread and in a subagent, and Claude followed it. The whole command shows (55-line heredoc); an Edit ask shows the line diff. Subagent asks name the subagent. Number keys, Up/Down and Esc work. Background-agent asks arrive with no DSH turn open, survive a page reload, and Stop does not answer them. Small gaps: after a rule edit the button label and effects line still show the CLI's original rule; the diff has no line numbers; `approval/decided` records "always" as `allowed-once` (DSH has no "always" outcome). |
| R5.3 | done | M2 live (D41): single and multi select, "Other" (single and multi), Markdown previews beside single-select options; the answers reach Claude in the tool's own `answers` field. "Chat about this" sends the CLI's own clarify text. Unverified: the TUI hides "Chat about this" for multi select; we also show it on a card that mixes both kinds. |
| R5.4 | done | M2 live (D42): keep planning with feedback (the CLI's reject text plus the user's words); approve with "use auto mode", "auto-accept edits", "manually approve edits" and (with the bypass option) "switch to bypass"; the picker matched the CLI each time. M2 fixes: a later `init` no longer drops the pre-plan mode; a mode picked before the CLI reported one keeps the settings start mode as the pre-plan mode. Deferred (D42, §13): the TUI's "clear context and …" rows, plan edit, approve with feedback. |
| R5.5 | done | M2 live (D43): a scratch stdio MCP server got the form values (text, email, integer, enum, multi select, boolean); Decline reaches it as `decline`; a URL-mode accept opens the link, the card waits and closes on the server's `elicitation/complete`. Stop never answers an elicitation. Cancel button checked by unit test only. |
| R6.1 | done | M3 host: each subagent is a one-shot DSH child session (D45) with native steps in the D68 shape (no usage, no stream chunks); nested agents are children of their parent child (spawn depth); per-child stop calls `stopTask` and waits 2 s (D46, route `child-stop`); a crash, Force stop, dispose or an interrupted main turn closes every open child step (D74); a subagent's ask is audited in its own child log. Round-trip tests with recorded fixtures pass the real v4 check and reload. M3 client: an "Agents" button in the session header opens the child tree (status, tokens and tool uses from task progress, run time, the latest output line, Open in the main view or beside it through DSH's own child navigation, a per-child Stop, the child's waiting ask named after it); a child session's own header shows its status, Stop and ask, and the child's ask also takes over the child's composer; the parent's `Agent` card is outlined while its child waits (D77). DSH's native subagent catalog stays for navigation. M3 live check (real CLI, real DSH web UI): a nested agent shows under its parent child (spawn depth 2); Stop on one of two parallel foreground children stops only that one (the other finishes, same CLI process); live child rows show the running tool, and the child view shows the live tool row; a subagent's ask names it, shows on its row and in its child session, takes over the child's composer, and is audited in the child log. Fixed live: the composer chain priority (DSH tries entries in ascending order) and a child-ask publication that churned. Child thinking was not seen live (the CLI sent no thinking text); a unit test now proves that non-empty child thinking becomes a reasoning block of the child step (`agents.test.ts`). Known gaps (not part of the check): the parent `Agent` card has no inline progress like the TUI (the numbers are in the Agents panel). |
| R6.2 | done | M3 host: background agents and shells are jobs under our scoped controller with overlapping waits; teardown settles locally with no `stopTask`; a dropped job is linked again when the agent attaches; past the per-owner limit the task gets a plugin-only row (`tasks` in the session view, route `task-stop`) whose note names `maxConcurrentJobsPerOwner` (D47). A wake turn now shows a native visible trigger naming what ended (D26). M3 client: a "Background tasks" tab lists the tasks with progress, note and Stop; the wake trigger is drawn as a plugin card at the start of the wake turn (a Chat-target conversation Definition claims only our `developer/message`), listing what ended. M3 live check: a background agent and two shells became job rows that settled with the right status; a shell outlived three (test-shortened) job waits; DSH's job-list Stop (two presses) stopped only that task; each wake turn showed the trigger card. A DSH restart settles running jobs as teardown (no stale rows). Open: after a DSH SIGKILL the CLI outlived DSH until its background task ended, and ran one wake turn on its own (D75 pid check needed; outside the R6.2 check). Known gap: background shell output is not shown in the UI (`taskOutput` exists but nothing calls it yet). |
| R6.3 | partial | M3 host: teammates are child sessions; a woken teammate runs a new turn in the same child; the session view has a roster model (teams, members, `SendMessage` messages, `messaging: false` while the CLI rejects `send_task_message`, D50). M3 client: a "Team" tab lists teammates by team with status and wakes, "Open transcript" (the teammate's child session), the messages between agents, and a Message box that stays disabled while the CLI has no messaging control (D50). M3 live check: with agent teams on, a lead spawned alice and bob; the roster, the ping/pong `SendMessage` messages, the wakes and each teammate's transcript showed in the UI. Missing: messaging a teammate (CLI limit). |
| R6.4 | done | M3: the main-thread agent picker sits in the composer row of a new session. It lists `supportedAgents()` of the live process (user, project and plugin agents), or a recent list from the same folder, or "Start <name> to list agents" (D4, D51). A pick is a pending, session-only choice passed as the `agent` start option at spawn (D15); a pick after "Start" and before the first message ends the idle process so the next message starts it with the agent. After the first turn the picker locks and shows the seated agent; a resume after a restart passes the agent read from the transcript (`sessionMainAgent`). A DSH fork keeps the CLI's own restore. M3 live check: the picker list equals `supportedAgents()` (user, project and plugin agents); a project agent picked before the first message ran the main thread (CLI `--agent`, transcript `agent-setting`), and the picker then locked. |
