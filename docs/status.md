# Status

This page says what works, what was checked live, and what is still open. It is the summary of the phase 5 final
re-check: five live check groups, one fix round, and two rounds of adversarial verification (three verifiers each).

Versions used for every live check: DSH 0.2.2-rc.1, Claude Code CLI 2.1.318, Claude Agent SDK 0.3.318 (pinned
exactly), Linux, Amazon Bedrock auth. Each live group installed the packed plugin tarball into a fresh, throwaway DSH
profile, started DSH from a clean environment, and drove the real DSH web UI with headless Chromium. Evidence was read
from the DSH session log, from Claude Code's own transcript, from the CLI's stdin and stdout (a test-only wrapper that
copies them), and from the process list. Test sessions used a small explicit model (Sonnet) and never changed the
user's settings.

Status values:

- **done**: the row's live check passed.
- **partial**: built and checked, but a named part is missing or could not be checked here.
- **deferred**: moved out on purpose, with a reason.
- **unverified**: built, but not checked live.

The requirement texts and checks are in [requirements.md](requirements.md). Design decisions (D-numbers) are in
[architecture.md](architecture.md).

## 1. Requirements

| Requirement | Status | Evidence summary (what was checked live) | Reason for anything not done |
|---|---|---|---|
| R1.1 Run the user's own `claude` | done | The process list shows the user's own `claude` with `--setting-sources=user,project,local`, run by DSH. A `claude` placed first on `PATH` was the one that ran. With the README's optional `overrides` block, the install has only the SDK package and no platform binary. | The configured-path and the macOS and Windows fallbacks are covered by unit tests only. |
| R1.2 Load user, project and local settings | done | The DSH-run session's `system/init` matched a plain `claude -p` in the same folder: the same skills, agents, plugins, MCP server names, slash commands, output style, model and version. The only differences are the CLI's own: MCP servers still connecting at init, and the SDK-mode tool set (AskUserQuestion and plan tools). The trust question showed before the first start, with no `claude` running while it was asked. Project hooks (a prompt block, a tool refusal, a post-tool note) behaved as in `claude -p`. | — |
| R1.3 Never write settings; quick access to the three files | partial | The settings file times were unchanged after every run. The "Settings files" panel lists all three files with masked previews, reveal, copy path, open in DSH preview, open in terminal, and "which file sets each key". | DSH has no text editor, and the plugin must not write. The preview is read-only, so editing goes through the DSH terminal tab and a copied `cd` (D63). |
| R1.4 UI choices are session only; the default is the user's settings | done | A session with no choice ran the settings model, effort and mode, with no `--model`, `--effort` or `--permission-mode` flag. A model pick went through `setModel` and did not change another session or the DSH profile default. A mode pick changed only its own session. After a fix, the effort picker names the level the CLI reports it applies ("your settings (xhigh; running: medium)"), and it follows a typed `/effort high`. | — |
| R2.1 System prompt is the preset with no append | done | The transcript's prompt snapshot was identical to a plain `claude -p` from the same folder, with no DSH or plugin text. | Note: a model picked before the first message is applied with `setModel` after the start, so the CLI builds the prompt for the settings model. This matches `claude -p`, not `claude --model <picked>`. |
| R2.2 Only typed or attached text reaches the model | done | Every user entry in the transcripts equals text typed in the UI, an attachment, or the CLI's own tool results and texts. A search of every test transcript found no plugin text and no wake notice. | Granted plugin messages (R9.2) reach the CLI on the same path as typed text; this is a documented, user-granted trade-off (maintainer Q2). |
| R2.3 No forced tools, env flags or settings layers | partial | The CLI arguments carry only the SDK's fixed flags and the three setting sources; no `--settings`, model or tools flags. | Two plugin-set env variables restore TUI defaults: question previews in Markdown (D13) and file checkpointing (D16). They wait on maintainer questions Q4 and Q5. |
| R2.4 Env passed through; only host session variables stripped | done | With fake host Claude Code variables and the user's own tokens in DSH's env, the CLI got every user variable (including the user's own `DSH_*` tokens and keys) and none of the host variables. | — |
| R2.5 No extra `claude` processes | done | One `claude` per started session, none before a session starts. No transcripts beyond the sessions' own (no title or probe runs). The only other child is one small orphan-guard watcher per CLI (D75), which is not a `claude` run. | — |
| R3.1 One process per session; resume after a DSH restart | done | After a DSH restart the next message resumed the same Claude session, and Claude remembered a word from turn 1. | — |
| R3.2 Stop only interrupts | done | After Stop, the same CLI process kept running and a background subagent finished; its result arrived in a wake turn. | — |
| R3.3 Background work never holds the turn | done | After Stop with a background agent running, the composer was free and a new message ran and finished as its own turn before the agent ended. | — |
| R3.4 Steer and queue | done | Enter while busy queued a message that ran as the next turn. Ctrl+Enter steered a message that the CLI read at the next step of the same turn. | — |
| R3.5 Fork keeps memory; rewind forgets | done | DSH Branch started a forked CLI that remembered the kept turns. Our rewind ("Restore conversation") dropped a turn, and Claude did not know the dropped word. The rewound message came back into the composer. | — |
| R3.6 No reply lost; crashes reported | done | A SIGKILL of the CLI mid-tool ended the turn with "Claude Code stopped unexpectedly: it was killed (SIGKILL)", a crash banner (also after a page reload), and a working resume. Every CLI `result` text (18 of 18) was in the DSH logs. A fix removed a false "Claude Code has more than this session shows" note after a wake turn; the restart and crash re-checks showed no such note. | — |
| R4.1 Native events; export; plain DSH renders | done | The logs hold native assistant messages, tool calls, tool results, steps, turns and jobs, and pass DSH's real v4 check and stream replay. DSH's "Copy as Markdown" export holds every tool call. With the plugin removed, DSH still rendered and exported the session. | Thinking text is covered by unit tests only: in SDK mode the CLI sent only empty, signed thinking blocks in every live run. |
| R4.2 Text streams live | done | First text on screen about 1.05-1.09 s after Enter, against 0.90-0.98 s for the CLI's own first delta. Text chunks were spread over the whole reply, with no end-of-turn dump. | — |
| R4.3 Images and files reach Claude | done | A pasted image and an attached file (with a space in its name) were described and read in one answer, with no tool call and no approval. | — |
| R5.1 All permission modes; the picker shows the CLI's mode | done | All six modes switched mid-session (bypass only with the plugin's opt-in switch); the picker matched the CLI's reported mode each time and after every plan approval. Without the opt-in, bypass is disabled with its reason. Shift+Tab cycles the CLI's modes. | The picker can trail the CLI by one 4 s poll right after a pick (known, not fixed). |
| R5.2 Approvals with the CLI's choices | done | "Always" wrote the CLI's own rule into the project's local settings (the CLI's write), and the repeat did not ask. Reject with feedback reached Claude, who followed it. Edit asks show the line diff; Bash asks show the whole command. A subagent's ask names the subagent. | DSH's approval record has no "always" outcome, so it records "allowed once"; the rule is in the CLI's own settings write. |
| R5.3 AskUserQuestion | done | Single and multi select, "Other" in both, and Markdown previews; the answers arrived in the CLI's own answer text. | — |
| R5.4 Plan mode | done | The plan is shown in full. Keep planning with feedback, and approve with auto mode, accept edits, manual approval, and (with the opt-in) bypass all worked; the picker followed each. | The TUI's "clear context and …" rows and "approve with feedback" are not offered (D42; no SDK answer shape). |
| R5.5 MCP elicitations | done | A test MCP server got the form values, a decline, and a URL-mode accept; the URL card waited and closed on the server's completion message. | The Cancel button is covered by unit tests only. |
| R6.1 Subagents | done | A nested agent showed under its parent. Stopping one of two children stopped only that one; the other finished in the same CLI process. A subagent's ask is named in the parent and in the child view. | Live child thinking was not seen (the CLI sent none); unit tests cover it. |
| R6.2 Background agents and shells as DSH jobs | done | Two background shells and one background agent became job rows. Each settled with the right status (completed, stopped by DSH's job list, completed after outliving three job waits), and each end came as a wake turn. | — |
| R6.3 Agent teams | partial | The Team tab showed a team of two teammates, their messages to each other, their wakes, and each teammate's transcript. | Messaging a teammate from the UI is not possible: the CLI has no control for it (D50). |
| R6.4 Custom agents | done | The agent picker list equals the SDK's `supportedAgents()` in the same folder. A project agent picked before the first message ran the main thread, and the picker then locked. | — |
| R6.5 Dynamic workflows and ultracode | done | A two-phase workflow showed live phases, agents, status, tokens and output, and its final report came in a wake turn while the session stayed free. "Stop entire workflow" stopped both agents and their processes, in the same CLI process. Ultracode turned on from the picker. After a fix, picking a plain level again turns ultracode off. | Per-agent stop, pause, skip and retry are not offered: the CLI has no SDK control (D48). The typed ultracode keyword is checked only through an SDK probe, not typed in DSH. |
| R7.1 The `/` menu is the CLI's command list | done | 91 menu rows equal the CLI's latest list, in the CLI's order and with the CLI's names; terminal-only and DSH-taken rows carry a note. A skill, a custom command and an MCP prompt ran, and the CLI's stdin got exactly the typed text. | — |
| R7.2 Local command output | done | `/context` shows its categories; `/usage` shows in a monospace box. The DSH log keeps the CLI's text byte for byte. DSH's token meter and cost stayed unchanged around them; our context pill follows the CLI's own `getContextUsage()`. | — |
| R7.3 `/btw` | done | Side questions answered from earlier turns with no tools, with history, during a running turn, and after a page reload, in the same CLI process. Nothing reached the DSH log or the Claude transcript. | A warm cache cannot be measured: the side answers carry no usage. |
| R7.4 MCP status, reconnect, toggle | done | The panel matched each MCP status reply (connected, failed, needs sign-in). Reconnect, disable, enable and sign-in start went through the CLI's own controls. | Completing an MCP sign-in was not checked live. "Clear authentication" is not offered. |
| R7.5 Skill cards name the skill | done | The Skill card showed the skill name, its arguments and the CLI's launch line. | — |
| R8.1 Per-turn tokens, cost, `modelUsage`, subagent tokens | done | Turn and session figures (input, output, cache read, cache write, cost, per-model usage, subagent tokens) equal the CLI's `result` and the sum of the transcript's calls. | — |
| R8.2 Context ring from turn 1; compaction | done | Turn 1's pill equals `/context` in every category, with the auto-compact point. `/compact` showed "Compacting…" and then the CLI's own before and after token counts. | — |
| R8.3 Subscription limits; API key, Bedrock and Vertex cost | partial | Bedrock: cost shown as an estimate at list price, "no plan limits for this account", no fake limit bars. | Only Bedrock auth is available on the test machine. Subscription plan limits are covered by unit tests on recorded frame shapes only; API key and Vertex auth were not tested. |
| R8.4 DSH's own meters fed correct numbers | done | DSH's token meter and cache-hit % equal the log and transcript sums. TTFT is fed for timed steps; DSH's native context ring is hidden. Two fixes keep DSH's speed figures honest: a step with a decode window under 500 ms gets no timing, and a message whose tool-call input is longer than its text and thinking gets no timing (Bedrock sends tool input in bursts, so such steps read 196-354 tok/s against 80-117 tok/s for text). Live: a text step timed at 125.7 tok/s; a turn with three Bash calls, two Write calls and one more Bash call left all its tool steps untimed; DSH showed 126 tok/s; usage equal to the transcript. | A tool-heavy step also gets no TTFT, because DSH reads TTFT and speed from the same stream. |
| R9.1 A sample plugin overrides one view | done | With the sample plugin installed, its pill replaced our context pill and updated live, and its button filled our extra-controls slot. | — |
| R9.2 Documented service API | done | The sample called every client method. Send, steer and side question were refused without a grant, worked with one (logged with a plugin source), and were refused after a revoke. Interrupt stopped a turn in the same CLI process. All of it ran through a reverse proxy. | Grants last for one DSH run: DSH 0.2.2-rc.1 does not save the plugin's config write. |
| R10.1 Proxies and trusted hosts; no open routes; no file reads | done | Every plugin route: 401 without DSH's cookie, 403 for an untrusted Host or a cross-site Origin, our answer through a trusted-host alias and through a reverse proxy with `--public-url`. A full browser session ran through the proxy, also behind a path prefix. Caller-named file paths are refused; only the three settings files are served. | — |
| R10.2 Linux, macOS, Windows | partial | The CI matrix (build, lint, typecheck, tests, pack check) passes on Linux, macOS and Windows. | Live checks ran on Linux only. The nightly job for the next DSH version has not run yet. |
| R10.3 Backend interface; the DSH layer does not import the SDK | done | The import check passes; only the Claude backend package imports the SDK, and the bundle loads it lazily. A stub backend runs beside the Claude backend in tests, and (earlier, live) in one DSH profile. | — |
| R10.4 MIT, no telemetry, declared DSH range | done | The tarball's LICENSE is MIT and equal to the repository's. A search of the packed files found no telemetry, no network modules, and no local paths. The tarball installed and ran on DSH 0.2.2-rc.1, the only published version in the declared range. | — |

## 2. The raw contract

The rules are in the repository's agent instructions (`CLAUDE.md` §2). This is how each one is kept, and how it was
checked.

| Rule | How it is kept | Checked |
|---|---|---|
| 1. The user's own binary | The SDK always gets an explicit executable path: the configured path, else `claude` on `PATH`, else `~/.local/bin/claude` (on Windows also `claude.exe` and the npm shim's target). With a path set, the SDK never looks for its bundled CLI. The README gives an optional `overrides` block that keeps the SDK's platform binary out of the install. | Live process list and a `PATH` shim; install contents. Other OS fallbacks: unit tests. |
| 2. The user's own configuration | The `user`, `project` and `local` setting sources are always loaded. The plugin has no code that writes a file. The settings panel only reads the three files. A permission rule from "always allow" and the trust record are written by the CLI itself, as in the TUI. | Settings file times unchanged after every run; `system/init` equal to `claude -p`. |
| 3. No prompt injection | The system prompt is the `claude_code` preset with no append. Only typed text and attachments are sent. Deny and plan answers re-use the CLI's own texts (maintainer Q1). Wake notices and our status lines stay in DSH and never reach the model. | Prompt snapshot equal to `claude -p`; transcripts searched for plugin text: none. |
| 4. No forced behaviour | The start options carry no model, effort, mode, tools or settings layer. A UI choice is session-only and goes through `setModel`, `setPermissionMode` or `applyFlagSettings`. Two TUI-default restorations (D13, D16) are the known exceptions, waiting on Q4 and Q5. | Live: no flags in the CLI arguments; a no-choice session ran the settings model, effort and mode. |
| 5. A clean environment | The env is built from DSH's own env. Only the verified list of host Claude Code session variables is removed; the user's tokens and keys, including `DSH_*` names, pass through. The list is checked against the installed CLI with `pnpm test:cli-constants`. | Live env diff between DSH and the CLI. |
| 6. Stop only interrupts | Stop calls `interrupt()` (with `perTaskStopAffordance` set at start). The process ends only on an explicit Force stop, or when an exact reset of the session's choices or a main-thread agent pick needs a fresh start; those two refuse while tasks or jobs run. One task is stopped with `stopTask`. | Live: same process before and after Stop; a background agent finished. |
| 7. Never hold a DSH turn for background work | Background agents, shells and workflows are DSH jobs. The turn ends when the CLI's own turn ends; work the CLI starts later comes as a wake turn. | Live: the composer was free during background agents, shells and workflows. |
| 8. Native DSH events first | Prose, thinking, tool calls, tool results, steps and usage are native DSH events. Plugin-only data (for example the usage board and asks) stays in memory or in the Claude transcript; no side store. | Every live log passed DSH's real v4 check and stream replay; plain DSH renders and exports it. |
| 9. No hidden extra processes | One CLI per session, started on the first message or on Start. Titles, models, agents and commands come from the live process and SDK controls; side questions use `askSideQuestion`. The only extra process is a small orphan-guard watcher per CLI (D75). | Live process lists and transcript folders. |
| 10. Full Claude Code coverage | Subagents, teams, workflows, every mode, MCP, skills, plugins, hooks, slash commands, `/btw`, plan mode, AskUserQuestion, images, resume, fork, rewind, interrupt and steer are built. | Live, all groups. The gaps are in section 3; most are CLI limits in SDK mode. |
| 11. Honest usage numbers | Figures come from the CLI's `result`, `modelUsage`, `getContextUsage()` and rate-limit frames, never estimated by us. Cost is labelled "estimate at list price" for API-billed accounts. DSH's meters get only measurable timings. | Live on Bedrock: numbers equal the transcript and `result`. Subscription, API key and Vertex: not live (R8.3). Tool-heavy steps get no speed or TTFT (R8.4). |
| 12. Safe and portable | Every route sits behind DSH's own cookie and trusted-host checks; there is no localhost gate and no route that reads a caller-named file. No telemetry. CI runs on Linux, macOS and Windows. | Live route probes (401 and 403), proxy and prefix sessions; tarball search; CI. |
| 13. Multi-CLI ready | Claude code lives in one backend package behind the backend interface; the DSH layers import only the core package. `scripts/check-imports.mjs` enforces it. | Import check; a stub backend beside Claude in tests. |

## 3. Known gaps against the Claude Code TUI

These are differences a Claude Code user may notice. None of them breaks a requirement row as written, except where the
table above says partial.

### Limits of the CLI in SDK mode (no SDK control)

- **Messaging a teammate** from the UI: the CLI rejects the message control (D50).
- **Workflow agent controls:** only the whole run can be stopped. Per-agent stop, pause, skip and retry are TUI-only
  (D48).
- **TUI dialogs:** `/skills`, `/memory`, `/status`, `/hooks`, `/permissions`, `/plugin`, `/resume`, `/help`, `/login`,
  `/add-dir` and similar commands answer "isn't available in this environment". Turns end at once; no hang. The SDK's
  dialog hook is not used, because its shapes are not documented (D78).
- **No `!` shell mode.** A line that starts with `!` goes to the model as text, so the model may run Bash for it. Use
  DSH's terminal tab instead.
- **Plan card:** the TUI's "clear context and …" rows and "approve with feedback" are not offered (D42).
- **Thinking text:** in SDK mode the CLI sends empty thinking blocks unless a display is set explicitly; it does not
  read the user's `showThinkingSummaries`. So a user who sees thinking summaries in the TUI sees none here. Passing that
  setting would be a TUI-default restoration and needs a maintainer decision.
- **`/btw` warm cache** cannot be measured (side answers carry no usage). `/btw` answers do not stream.
- **"Summarize from here"** is not offered on rewind (no SDK control).

### Limits of DSH 0.2.2-rc.1

- **No editor** for settings files: the preview is read-only, and editing goes through the terminal tab (D63). The
  terminal tab opens only in the session folder.
- **Plugin grants end at a DSH restart**: DSH does not save the plugin's config write.
- **No "always" outcome** in DSH's approval record; it says "allowed once".
- **Attached file names** with both a space and a `"` do not reach Claude Code (DSH stores `"` as `_`).
- **No Branch button on a stopped turn**: a fork right after a Stop goes through our rewind dialog.
- **DSH's token meter** counts the main thread only; our pill and panel include subagent tokens, so the totals differ
  by design (D68).

### Plugin gaps (could be fixed)

- **`/rename`** renames the Claude Code session, but the DSH title stays: the title read (D32) is not wired yet.
- **Hook notices** (a blocked prompt, a post-tool message) show only in the status line and are replaced by the next
  notice; they are not in the chat or the log. A prompt blocked by a hook is not put back in the composer.
- **Menu substitution:** the `/` menu matches by substring and Enter picks the first row, so `/bug` + Enter puts
  `/debug` in the composer (visible, and it needs a second Enter).
- **Pickers lag:** the mode picker can trail the CLI by one 4 s poll after a pick; the "MCP n/m" count can show the
  connect-time count right after a start.
- **Ultracode** shows as its own picker entry, which hides the level under it.
- **Workflows:** no live token count for running workflow agents, no script `log()` lines, no large-workflow warning.
  Agents stopped with the whole workflow show too short a run time afterwards (cosmetic).
- **Rewind:** "Restore code" needs a running process; no rewind before the first message; attachments of a rewound
  message are named in a note, not put back. The per-row change figures count all later changes, not one turn.
- **MCP:** "clear authentication" is not offered; completing a sign-in was not checked live.
- **Usage panel:** a turn under one second shows "took 0 s" (cosmetic). The near-limit warning is not prominent, and
  there is no live elapsed-time or token counter during a turn.
- **The `/` menu** shows the CLI's commands in a separate group from DSH's own, and very long MCP prompt names are cut
  in the row title (the full name stays beside it).
- **Workflow transcript guard** checks the folder, not each file, so it would follow a symlinked agent file inside the
  CLI's own projects folder (low risk: it needs write access to that folder).

### Not checked live

- macOS and Windows (CI only), subscription accounts, API key and Vertex auth.
- The typed ultracode keyword in DSH (SDK probe only); child thinking text (unit tests only).
- A natural (not forced) refusal of a one-turn rewind.

## 4. Open maintainer questions

These five questions touch the raw contract ([architecture.md](architecture.md) §12.2). The plugin ships with the
default shown until the maintainer answers.

| Question | Rules | Default in use |
|---|---|---|
| Q1. May the plugin re-send the CLI's own reject texts (version-pinned, tested against the binary) as the deny message, as the TUI does? | 3, 10 | Yes, re-send the CLI's texts (D40, D42). An unknown CLI version falls back to the 2.1.318 texts with a warning; `pnpm test:cli-constants` checks them on upgrade. |
| Q2. May another plugin ever send text to the model without a user keypress? | 3 | Only with a per-plugin grant the user creates; the default is prefill only (D66). The grant is a consent switch between trusted plugins, not a security boundary. Granted text reaches the CLI as typed text; only the DSH log shows its plugin source. |
| Q3. Show the TUI's trust question before the first start in an untrusted folder, and pass `workspaceTrust` after the user accepts? | 2, 4, 10 | Yes: the question is shown; accept passes `workspaceTrust` and the CLI writes its own trust record; decline starts no process (D73). |
| Q4. Turn on file checkpointing by default to match the TUI, honouring `fileCheckpointingEnabled: false` from the user's settings? | 4, 10 | Yes (D16). It adds one SDK env variable. Known gap: admin policy delivered only through OS management profiles or remote managed settings is not read. |
| Q5. Set question previews to Markdown by default (the SDK turns this into an env variable), to restore the TUI's preview text? | 4, 10 | Yes, unless the user's env already sets the variable (D13). |

One more decision is open but is not one of the five: whether to pass the user's own `showThinkingSummaries` as the
SDK's thinking display, so thinking summaries show as in the TUI (section 3).
