# DSH UI surfaces: what DSH draws, and what a plugin can feed

Phase 1 research note, topic `dsh-ui-surfaces`.

Scope: what the DSH Web UI renders natively, and which slots, services and events a plugin can use to show Claude Code sessions.

Versions: the brief names DSH 0.2.1-rc.5. The install on the test machine is now **0.2.2-rc.1**; every package cited here is 0.2.2-rc.1. Re-check this note when the declared DSH range changes.

Evidence aliases:
- `P/<package>/…` is a file in `@deepseek-ai/<package>` 0.2.2-rc.1, for example `P/dsh-client-ui-tool/README.md:56`.
- **probe r1–r5** are live checks against an isolated DSH (own `DSH_HOME`, clean env, loopback port, `--trusted-host probe.example.test`) with a small probe plugin. The probe registers a client bundle, exact Fetch routes, a raw web route, Host commands, a `/` input source, composer and dock slot entries, and a right-sidebar file open. The probe files, scripts and screenshots are kept in the local research folder (not published).
- **probe r6, r7** (Round 2): idle human interaction live in the browser, and an offline fold of driver-shaped events through the shipped projections. See "Round 2".
- **unverified** marks things read from code or docs but not run.

---

## Answers for the design

| Question | Answer |
|---|---|
| Tool cards | Keyed slot `tool.call.toolview`, keyed by the **wire tool name**. Built-in cards exist for DSH names only (`bash`, `read`, `edit`, `write`, `grep`, `glob`, `web_fetch`, `todo_write`, `ask_user_question`, `subagent`, `workflow`, …). Claude names (`Bash`, `Read`, `Edit`, `Task`, …) get the **generic card** unless a plugin registers a view for each name. Cards read raw `tool/call` and `tool/result` fields; no Host presenter reaches the client. |
| Approvals | Native outcomes are only `allowed-once`, `rejected`, `cancelled`, `unavailable`. There is no "always allow", no feedback text, and no tool arguments in the request. `ctx.approval.request()` **throws outside an open turn** (probe r6). The shared card factory `conversation.approval.card` has an optional `onAlways` button, and a plugin may take over the composer. So "always allow" with the CLI's own suggestions, and any approval while idle, needs a **plugin-owned approval composer** (or `ctx.userQuestions` with three options, see next rows). |
| User questions | Native card: single and multi select, "Other" text, skip, per-question Markdown `detail`, per-option `description`. **No per-option preview.** Claude's option previews must go into `detail` (one per question) or into a plugin view. `ctx.userQuestions.ask()` needs **no open turn**, only the session's live root agent (probe r6). |
| Idle interaction (background agent asks, no DSH turn) | Two proven surfaces, both with **no turn opened and no event written** (probe r6): (a) `ctx.userQuestions.ask({ agent, questions })` with the live root agent shows the native question card in the composer seat and returns the answer; with `intent: 'approval'` it renders as the generic three-option form (Allow once / Always allow / Reject) and returns the chosen label. (b) A plugin pending interaction (`ctx.uiSession.registerPendingInteraction`) plus a `conversation.composer` takeover, fed by a streaming plugin Fetch route and answered by a POST route. `ctx.approval` cannot be used. Nothing reaches the DSH log, so the plugin must keep its own record if one is wanted. |
| MCP elicitation | No native surface. A plugin composer takeover renders `requestedSchema` fields and a URL link and returns `{ action: 'accept' \| 'decline' \| 'cancel', content }`; the probe returned all three shapes and survived a page reload (probe r6). `ctx.userQuestions` can carry only option/free-text answers (no typed fields, no link action). |
| Plan UI | Native `plan-review` card: Approve / Request changes, plan opens in the right sidebar. **No mode choice on approve.** Claude's "approve with mode" needs the generic question flow (several approve options) or a plugin card. |
| Jobs list | Session-header list fed by `ctx.jobs` (registry rows, live output ring, two-press stop). A plugin can start jobs. Owned jobs normally trigger a **model-facing completion notice** from `dsh-tool-jobs`; that must not reach Claude (raw contract rule 3). Fix (verified, `dsh-seams` answer 4, probe `jobs-awaited.mjs`): keep a `ctx.jobs.wait()` pending on each job, so the settlement is `awaited: true` and `dsh-tool-jobs` stays silent. Correction (design review round 3): in the web profile a preset without `tool-jobs` has no job controller, so the design attaches its own scoped controller with `ctx.jobs.attachController()` (the `jobs-awaited.mjs` probe itself did this), and keeps the pending waits only as a second guard (see `dsh-seams` §3). |
| Subagents | Header catalog from `subagent/catalog` facts in the parent log. `mode: 'external'` rows are leaves (no navigation, no status). Navigable rows need a real child DSH Session, and a plugin **can** create one and write the `subagent/catalog` row (`dsh-seams` R2.1, live UI). There is no per-child token/tool tree beyond what the child session shows. |
| Workflow run | Chat node fed by `tool-workflow/run-start`, `agent-start`, `agent-end`, `run-end` events. It shows run, phases, members and status only: **no tokens, no output, no stop control.** Members open only if they are live local child Sessions. A plugin can write these events itself, with no DSH workflow tool call (`dsh-seams` R2.4, live). |
| Agent teams | Experimental package, reads the `agentTeam` projection of DSH's own Team service. Not fed by anything a Claude plugin writes. A plugin needs its own view. |
| Token meter, ring, pills | Ring is hard-wired in the composer and reads `contextPressure` (newest provider usage + `contextWindow` from `request/context`) and the heuristic `contextBreakdown` (system / tools / messages only). The two stat pills (`activity`, `usage`) are **replaceable** `conversation.composer.dock` entries (same id + order, lower priority). New pills can be added. Turn usage rows need exact usage on every attempt. With `request/context` plus per-step usage and **no** `request/header` / `system/message` (probe r7): ring = newest `inputTokens + cacheRead + cacheWrite` (+ heuristic surface growth) / `contextWindow`, correct from turn 1; breakdown shows System 0, Tools 0, all "Messages"; turn usage row shows exact totals; TTFT and tok/s are honest **only if** text deltas carry their real arrival times. Deltas stamped when the whole CLI message arrives give absurd tok/s; a stream with no delta chunks hides TTFT and speed. |
| `/` menu | Host commands (`ctx.commands.register`) appear in the menu and run through `commands/execute`; each run writes `command/run` + `command/done` to the DSH log. Names must be lowercase `[a-z0-9_-]`: **`plugin:cmd`, uppercase and dotted names are refused**, and a name that clashes with a global DSH command (`compact`) is refused globally. That limit applies only to registering Host commands: a typed `/name …` line that no Host command or client source claims **falls through** to the default sink and reaches the session as a plain `user/message` with the exact text, with no `command/*` record (`dsh-seams` R2.3, live, including `/my-plugin:do-thing arg1`). So Claude commands, `plugin:cmd` names and names DSH does not serve in our preset need no Host command and no claim. A client input source can claim any token (for example `/btw`) without a Host command and without writing to the log. A Host command with the same name wins over the client claim. |
| Settings pages | Slots `settings.section`, `settings.plugins.tab`, `settings.general.item` and config forms over the Host settings document. Fine for plugin preferences. |
| Open a file | `ctx.sidebarRight.openResource('dsh-resource://file/session/<id>/<abs path>')` opens a **read-only** preview, also for files outside the workspace (probe r3). DSH has **no file editor**. "Open In…" native apps are hidden over SSH. Editing needs a terminal tab, a plugin editor, or the user's own editor. |
| Plugin routes | `ctx.connection.fetch.register({ path: '/api/…' })` routes use DSH's own cookie auth and Host/Origin fence: 401 without cookie, 403 for an untrusted host or origin, 200 through a `--trusted-host` proxy host with the cookie, streaming responses work (probes r1, r4). Client code must call them with a **relative** URL (`api/…`) so `--public-url` prefixes work. `connection.rpc.handle` and `rpc.intercept('/api')` are not usable by plugins (see §8). |

Main design consequences:
1. Register a `tool.call.toolview` view for each Claude tool name, or accept the generic card. Mapping Claude tools onto DSH names (`Bash`→`bash`) would reuse built-in cards, but those cards parse DSH argument and result shapes, so a mismatch falls back to generic text (**unverified** per tool).
2. Approvals, plan approval and option previews need plugin-owned composer takeovers if we want CLI parity (R5.2, R5.3, R5.4).
3. Workflows (R6.5) and teams (R6.3) need plugin Chat nodes or panels; the native nodes cannot show tokens, live output or stop.
4. Typed Claude slash commands need no Host command and no claim: unclaimed lines fall through as plain user prompts (`dsh-seams` R2.3). Only `/btw` needs a client input source (it must not reach the log as a user turn). Names DSH serves in our preset (`/model`, `/permission`, `/export`, `/feedback`) stay DSH's.
5. Background work as DSH jobs must avoid the `dsh-tool-jobs` completion notice, which is a model-visible user message. Keep a `ctx.jobs.wait()` pending per job (`dsh-seams` answer 4).
6. Every `can_use_tool` and `onElicitation` request goes through one plugin "interaction channel" (pending interaction + composer takeover + streaming Fetch route). It works with or without an open turn, so rule 7 holds. Plain AskUserQuestion may use `ctx.userQuestions` instead (native card, no turn needed).
7. The driver should write text/reasoning deltas with their real arrival time (SDK partial `stream_event`s) so TTFT and tok/s are honest; otherwise write blocks only (no deltas) so those stats hide, or replace the `activity` pill.

---

## 1. Tool cards and presenters

- `ui-conversation` sends each `tool-call` node to `ui-tool`; `ui-tool` renders the root tree and dispatches each atomic call through the keyed slot `tool.call.toolview`. "Unregistered Tool names use the generic card." (`P/dsh-client-ui-tool/README.md:12`).
- Registration: `ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: '<wire tool name>' }, View))` (`P/dsh-client-ui-tool/README.md:38-46`). "Register with `key: '<tool name>'`; a typo never renders. Occupied keys replace the view" (`P/dsh-client-ui-tool/lib/types/client/contract/slots.d.ts:10-20`).
- View props (`ToolCallOwnerProps`): `callId`, `toolName`, `phase` (`preparing` | `start` | `result`) with its `block`, `cwd`, `home`, `openFile`, `loadImage`, `inspect`, `useDisclosure` (`slots.d.ts:51-81`). The same `callId` is kept across all three phases (`README.md:76`).
- Built-in keys registered in `P/dsh-client-ui-tool/lib/client.js` (grep of `key: "…"`): `apply_patch`, `ask_user_question`, `bash`, `edit`, `glob`, `grep`, `read`, `read_image`, `write`, `web_fetch`, `web_search`, `todo_write`, `subagent`, `workflow`, `job_*`, `terminal_*`, `schedule_*`, goal tools, team tools, `lsp`, and others. None is a Claude Code tool name.
- "Structured cards derive directly from first-party raw event fields; Host `presentCall` and `presentResult` values never enter the Client." (`README.md:56`). So a Host-side presenter cannot restyle a card; only a client view can.
- `ui-skill` is the example of a business package owning a view (key `skill`) (`README.md:56`). Claude's `Skill` tool would need its own key (R7.5).
- An auto-review denial takes precedence over keyed views (`README.md:92`); not relevant to Claude.
- Images in results go through `tool.call.images` (single slot, one declaring entry) (`slots.d.ts:21-38`).

## 2. Approvals

Host seam (`dsh-user-approval`):
- `ctx.approval.request({ agent, toolName, callId?, reason, displayReason?, signal })` dispatches the `approval/request` waterfall (`P/dsh-user-approval/lib/types/types.d.ts:54-82`).
- Outcomes: `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'` (`types.d.ts:26`).
- "Only one-shot grants exist — the outcome vocabulary has `allowed-once` but no `allow-always`" and "The request carries no tool arguments" (`P/dsh-user-approval/README.md:165-166`).
- A request "requires an open turn: an idle or between-turn caller throws" (`README.md:53`; `P/dsh-user-approval/lib/index.js:155`). Probe r6 confirmed the throw for an idle live root agent. A Claude permission request that arrives for a background agent while no DSH turn is open cannot use this seam (raw contract rule 7). See Round 2 for the surfaces that do work.
- It writes `approval/asked` and `approval/decided` audit events (`types.d.ts:37-51`).
- Its policy switch adds model-visible text in DSH's own agent ("The user changed the approval policy…") (`README.md:129-133`). This text is for DSH's agent loop; a Claude backend must not forward it.

Client (`dsh-client-ui-approval`):
- The built-in client decision type is `'allowed-once' | 'rejected'` (`P/dsh-client-ui-approval/lib/types/client/contract/slots.d.ts:62`).
- The shared factory `conversation.approval.card` takes `title`, `description`, `subject`, `callId`, `allowLabel`, `onAllow`, `onReject` and an optional `onAlways` ("Explicit persistent choice; absent when the caller cannot save permission") (`slots.d.ts:17-29, 127-151`). "When offered, **Always allow** is the highlighted primary button." (`P/dsh-client-ui-approval/README.md:23`).
- The child slot `conversation.approval.detail` renders detail for the correlated `callId` (`slots.d.ts:31-44`); `ui-chat` fills it (`P/dsh-client-ui-chat/lib/client.js:15577`). So a tool card or command preview can sit in the approval.

Questions seam also has an approval shape: intent `{ kind: 'approval', approve, reject, always?, subject?, display? }` (`P/dsh-user-questions/lib/types/types.d.ts:30-58`). No shipped Web renderer for this intent exists; probe r6 showed it as the generic option form (three numbered options, free text, Skip, Submit).

**Can "always allow" exist?** Not through `ctx.approval`. Yes through a plugin-owned composer takeover that renders `conversation.approval.card` with `onAlways`, and returns the user's choice (including the CLI's `updatedPermissions` suggestion) straight to the Claude backend. Reject-with-feedback needs a text field, which the card does not have; the plugin must add it.

## 3. User questions, plan UI, jobs

### User questions
- Service: `ctx.userQuestions.ask()` / `askTimed()`, waterfall `user-questions/request` (`P/dsh-user-questions/lib/types/types.d.ts:146-176`).
- Item: `id`, `question`, `detail?` (Markdown), `header?`, `options?: { label, description? }[]`, `multiSelect?`, `intent?` (`types.d.ts:5-11, 60-76`). Answer: `{ id, selected[], custom? }` (`types.d.ts:77-90`).
- **No option preview field.** dsh-claude dropped previews for the same reason (evaluation, live check).
- The card supports skip, "Other" text, multi select, a countdown for timed waits, and drafts (`P/dsh-client-ui-user-questions/README.md:11-27`).
- "Close is not an answer": closing a request with no tool call rejects it as `ASK_CANCELLED` (`README.md:13`).
- The question projection and reopen button are keyed on the DSH tool name `ask_user_question` (`P/dsh-user-questions/lib/types/projection.d.ts:19-20`). Claude's `AskUserQuestion` tool card will not get the reopen behaviour unless the plugin adds it.

### Plan UI
- `dsh-plan-mode` owns `/plan`, the `exit_plan_mode` tool and plan guidance as a prompt section (`P/dsh-plan-mode/README.md:8-33`). This is DSH's own plan mode; it would inject a prompt section, so the Claude backend must not use it. Claude's plan mode is the CLI's `plan` permission mode.
- The `plan-review` question intent renders a compact card with "View full plan", "Request changes" and "Approve" (`P/dsh-client-ui-user-questions/README.md:19`). `approve` names one option; every other option declines (`P/dsh-user-questions/lib/types/types.d.ts:19-29`). So **one approve choice only**; no "approve and auto-accept edits".
- The plan chip `conversation.input.plan` follows DSH plan state, not Claude's (`P/dsh-client-ui-plan/README.md:11-13`).
- Design: drive Claude's `ExitPlanMode` approval through a plugin composer (or the generic question flow with several approve options), and show the plan in the right sidebar.

### Jobs list
- One row per `ctx.jobs` job: status, duration, progress line, expandable live output, two-press stop (`P/dsh-client-ui-jobs/README.md:8-16`). It renders nothing until the session sees a job.
- Visibility: "the session's visible set — its own jobs plus every unowned job" (`P/dsh-api-job-controller/README.md`, "Use this package"). An unowned job would appear in **every** session.
- Owned jobs need an attached controller: "loading `dsh-tool-jobs` attaches one" (`P/dsh-jobs/README.md:19`); the registry also has `attachController(name)` (`P/dsh-jobs/lib/types/index.d.ts:139-145`).
- `dsh-tool-jobs` sends a model-facing completion notice to the owner and can **wake an idle agent with a new turn** (`P/dsh-tool-jobs/README.md:40-42`). For a Claude session this is a synthetic user turn: forbidden by rule 3, and a woken turn breaks rule 7. Round 2 fix (verified, `dsh-seams` §3 and answer 4, probe `jobs-awaited.mjs`): keep a `ctx.jobs.wait(id, <long>)` pending for each job; `tool-jobs` skips settlements with `awaited: true`. Correction (design review round 3): the probe attached its own controller, and in the web profile a preset without `tool-jobs` needs one to start jobs at all (`dsh-seams` §3).
- A human Stop from the list calls `job.kill` → the producer's cancel. The plugin maps that to `stopTask` (rule 6).
- Rings are process-local and lost on DSH restart (`P/dsh-api-job-controller/README.md`, limitations).

## 4. Subagents, child sessions, workflow runs, agent teams

### Subagent catalog
- Header trigger lists direct children, opens nested catalogs on demand, opens a child as a read-only or continuable conversation in the main view or the right sidebar (`P/dsh-client-ui-subagent/README.md:11-17`).
- It reads `subagent/catalog` facts in the parent log: `{ childId, childCreatedAt, version, mode: 'one-shot' | 'continuable' | 'unknown' | 'external', label? }` (`P/dsh-subagent/lib/types/catalog.d.ts:12-42`).
- "External tasks appear as non-navigable leaves without an execution status" (`P/dsh-client-ui-subagent/README.md:8`); "Catalog entries record membership once at creation and carry no execution status" (`P/dsh-subagent/README.md:123`).
- Rows show tokens and duration only for local child Sessions (`P/dsh-client-ui-subagent/README.md:8, 15`).
- Per-child stop exists only for a running continuable child, via `subagents/interruptByParent` (`README.md:17, 27`).
- Writing a new event type is unsafe (see §9). `subagent/catalog` is an existing type. Round 2: a plugin may write it and create its own child sessions; the catalog lists them and opens them (live while they run, read-only after) (`dsh-seams` R2.1, live UI).

### Workflow run node
- Events (`P/dsh-tool-workflow/lib/types/types.d.ts:9-56`): `tool-workflow/run-start {runId, name}`, `agent-start {runId, seq, label, phase?, childId}`, `agent-end {runId, seq, outcome}`, `run-end {runId, stopReason}`. Outcomes: `completed | failed | cancelled`; stop reasons: `completed | cancelled | error` (`P/dsh-workflow/lib/types/types.d.ts:55, 98`).
- "The node shows identities and statuses only; scripts, outputs, errors, logs, usage, topology, and controls remain outside this surface." (`P/dsh-client-ui-workflow-run/README.md:8, 26`).
- A member opens only when member and child are running and the child is a local Session of this parent (`README.md:13`).
- "Only top-level calls through `dsh-tool-workflow` produce these records" (`README.md:23`). That describes DSH's own writer only. Round 2: a plugin can append the four events with no DSH workflow tool call; they pass the v4 check, survive reload and fork, and the node renders with phases and members (`dsh-seams` R2.4, live).
- For R6.5 (phases, agents with status and **tokens**, live output, stop) the native node is not enough. A plugin Chat node is needed (register an event definition with `ctx.uiConversation.events.register()` and a view in `conversation.chat.node`, as the plugin guide says).

### Agent teams
- `dsh-experimental-client-ui-agent-team`: header panel with roster and task board from the Lead's `agentTeam` projection; "No mailbox timeline — … peer messages are not shown"; no lifecycle controls (`P/dsh-experimental-client-ui-agent-team/README.md:8-28`). It is experimental and fed by DSH's own Team service (`agentTeams` Host service). Not usable for Claude teams; R6.3 needs a plugin panel.

## 5. Token meter, context ring and usage pills

- Projections from `dsh-token-meter`: `tokenUsage` (uncached input, output, cache read, cache write over the whole log), `contextPressure` (`pressureTokens` = newest provider prompt size, `projectedTokens`, `contextWindow` from the newest `request/context`), `contextBreakdown` (heuristic `systemTokens`, `toolsTokens`, `messageTokens`) (`P/dsh-token-meter/README.md:23`).
- The ring: `ContextMeter` reads `contextPressure` and `contextBreakdown`; it renders nothing until both used tokens and `contextWindow` exist; percent = `(projectedTokens ?? pressureTokens) / contextWindow` (`P/dsh-client-ui-conversation/lib/client.js:21440-21448, 21525-21560`). It is **hard-wired** in the composer dock, not a slot entry (`client.js:22219`), and hides only while `conversation.input.activity` is active. Its breakdown has three fixed categories, so Claude's `/context` categories cannot appear there.
  - This explains the evaluation's "ring missing on turn 1" and "drops to 0%" (dsh-claude): the ring follows logged usage and `request/context`, not the CLI.
  - To show Claude's numbers in the ring, the backend must log usage and a context window that DSH accepts (**dsh-seams**), or the plugin adds its own meter and leaves `contextWindow` absent so the native ring stays hidden (R8.4).
- The stat pills: "two `conversation.composer.dock` list entries: `activity` (order 0 …) and `usage` (order 1 …). Another plugin replaces one control by registering the same id and the same `order` … a lower `priority` picks the replacement" (`P/dsh-client-ui-chat/README.md:79`; registration at `P/dsh-client-ui-chat/lib/client.js:15561-15576`). In probe r4 the replacement and extra pill registered without error, but the dock is not drawn in a blank (not yet started) session, so the visual check is **unverified**.
- Turn usage row: shown only when "every started model attempt reports safe, exact usage" (`P/dsh-client-ui-chat/README.md:75`).
- `sessionStats` (turns, steps, LLM/tool time, TTFT, decode tokens) comes from the log (`P/dsh-session-stats/README.md:18-27`). The speed stat uses `decodeTokens / decodeMs`; one Claude turn logged as one DSH step gives impossible tok/s (seen with dsh-claude). Replace the `activity` pill or feed honest step timing; Round 2 Q2 lists the exact fields.
- The optional Statistics view (`dsh-experimental-client-ui-stats`) is not in the default product (`README.md:25`).

## 6. The `/` menu, input triggers, settings pages

### Host commands (`ctx.commands`)
- `register({ name, description, input?: { hint, attachments? }, handler, definitionId?, recordInput? })`; a lowercase name of letters, digits, `_` or `-`; the same name twice in one scope throws; an agent-scoped registration shadows a global one for that agent (`P/dsh-commands/README.md:13-29`).
- Unknown commands are rejected by the adapter, never sent as a prompt (`README.md:27`). Round 2: the web composer does **not** do this in 0.2.2-rc.1. An unclaimed `/name` line falls through to `session.prompt()` as a plain `user/message` (`dsh-seams` R2.3, code and live).
- Each run is logged: probe r4/r5 session log shows `command/run {commandId, name, args, source:{kind:'user'}}` then `command/done {commandId, kind, text}`.
- Probe r4 (global registration from a Host plugin):

  | Name tried | Result |
  |---|---|
  | `claude-probe` | accepted, in the menu, runs |
  | `mcp__srv__prompt` | accepted (Claude MCP prompt shape is valid) |
  | `btw` | accepted |
  | `plugin:cmd` | refused (absent from `commands/list`) |
  | `Upper` | refused |
  | `a.b` | refused |
  | `compact` | refused (only the DSH `compact` stays listed) |

  Because the probe caught and counted errors without a logger sink, "refused" means "absent from `commands/list`".
- The command result text comes back in the `commands/execute` response (probe r5) and renders as a command row (`conversation.chat.commandview`) in a started session (**unverified** visually: the probe session never started a turn).
- For R7.1 (Round 2, `dsh-seams` R2.3): typed Claude commands need no Host command and no client claim. A line no one claims, including `plugin:name` commands and names that DSH does not serve in our preset (`/compact`, `/goal`, `/plan`), arrives at the driver as a plain `user/message` with the exact text, and no `command/*` record is written. Only `/model`, `/permission`, `/export` and `/feedback` stay DSH's in our preset. Host commands are still an option for listing Claude commands in the `/` menu, but each run would then log `command/*` events.

### Client input sources (`ctx.inputTriggers`)
- A source gives `candidates`, `onPick`, `matchSpace`, `matchEnter`, optional `matchClaim`, `header`, `openReference` (`P/dsh-client-ui-input-trigger/README.md:13-14`).
- Probe r3/r5: a source claiming `/btw` shows a "btw" row and an atomic `/btw` chip; on Enter its `submit` ran a relative `fetch('api/p1-probe/echo')` that reached the Host (200), with **no** `commands/execute` call and **no** new event in the DSH log (`r5-session-log-tail`).
- Probe r4/r5: when a Host command `btw` also exists, the Host command wins and the claim never runs.
- Source registration is global only ("Global source layer only") (`README.md:23`); the source must check the session itself.
- `ctx.commandUi` adds popups or actions to commands and can decorate existing Host commands (`P/dsh-client-ui-commands/README.md:8-13`).

### Settings pages
- `settings.section` pages, `settings.section.icon`, `settings.plugins.tab`, `settings.general.item`, `settings.onboarding`, `settings.launcher` (`P/dsh-client-ui-settings/README.md:19-27`; slot catalog §10).
- `ctx.configForms.get(entryId)` reads and writes a plugin's Host config entry with revision checks (`README.md:14`). Good for plugin options (for example a configured `claude` path). It is **not** a way to edit Claude settings files.

## 7. Opening a file (settings quick access)

- `ctx.sidebarRight.openResource(address)` with `dsh-resource://file/session/<sessionId>/<absolute path>` opens the file preview in the right sidebar. Probe r3: a button in `conversation.input.left` opened a JSON file **outside** the session workspace; the preview showed its full path and contents (Code view, reload button).
- `openResourceIn(address, { destination: 'sidebar' | 'float' })` also exists (`P/dsh-client-ui-open-in-app/README.md:21`).
- "Preview, not editing. The viewers provide no file editing" (`P/dsh-client-ui-sidebar-documentpreview/README.md:11`). Previews do reload on change (`README.md:8`).
- "Open In…" (`dsh-host-open-in-app`) launches a fixed catalog of native apps on the **Host** machine and hides itself when `SSH_CONNECTION` or `SSH_TTY` is set (`P/dsh-host-open-in-app/README.md:34`). It does not help a browser on another machine.
- A sidebar terminal exists (`ctx.remote.terminal`), but `TerminalCreateRequest` has no command field (`P/dsh-api-terminal-controller/lib/types/types.d.ts:55-61`); a plugin would have to type `$EDITOR <path>` into it (**unverified**).
- Reading `~/.claude/settings.json` through the preview was not tried (to avoid exposing secrets in screenshots). The fake file was outside the workspace, so the same path route should work (**unverified** for the real home path and sandbox read policies).
- Options for R1.3: (a) read-only preview plus "copy path"; (b) a terminal tab with the user's editor; (c) a plugin editor tab whose save is an explicit user action. (c) needs a maintainer decision, because rule 2 says the plugin never writes those files.

## 8. Authenticated plugin routes behind `--trusted-host` and proxies

Probes r1 and r4 (`route-probe.txt`, `route-probe-4.txt`), DSH started with `--host 127.0.0.1 --trusted-host probe.example.test`:

| Request | Exact Fetch route `/api/p1-probe/echo` | Raw web route `/plugins/p1-probe/raw` with `requestRejection()` |
|---|---|---|
| no cookie, loopback Host | 401 | 401 |
| no cookie, trusted Host | 401 | — |
| untrusted Host `evil.example` | 403 | 403 |
| token exchange at `/?token=` through trusted Host | 303, sets `HttpOnly; SameSite=Strict` cookie | — |
| cookie + trusted Host | 200 | 200 |
| cookie + trusted Host + foreign `Origin` | 403 | — |
| cookie replayed on another authority | 401 (cookie is authority-bound) | — |
| `Sec-Fetch-Site: cross-site` | 403 | — |
| streaming NDJSON response | chunks arrive about 700 ms apart, not buffered | — |
| POST from the page (relative `api/…`) | 200 | — |

- This matches the documented fence: Host must be loopback, the bind IP, or a `trustedHosts` entry; `Origin` must match; cookies bind host and port; 403 for trust failures, 401 for missing auth (`P/dsh-client-connection/README.md:26-30`).
- `ctx.connection.fetch.register` is the right tool: exact paths under `/api`, `GET`/`HEAD`/`POST`, buffered or streaming bodies (`README.md:22`; `P/dsh-client-connection/lib/index.js:732-735`). An exact route "answers 403 to a non-owner Peer" (`README.md:30`).
- `ctx.connection.rpc.intercept('/api', …)` takes the **single** `/api` interceptor slot; the probe's interceptor stopped the Typert Gateway from registering, and the UI broke (`/api/directoryPicker/list` → 404) (probe r2; `P/dsh-client-connection/lib/index.js:871-885`). Never use it.
- `ctx.connection.rpc.handle('/channel', …)` failed to activate from a third-party plugin ("cannot get property webServer without inject", probe r3) even with `webServer` injected; it registers a prefix web route through the connection's own context (`index.js:855-870`). Avoid it.
- Typed `ctx.remote.<ns>` Remote services need build-time generated contributions mounted by `dsh-api-remotes`; "The capability set is fixed by explicit build-time value imports" (`P/dsh-api-remotes/README.md`, limitations). Not available to a third-party plugin without that tooling (**unverified** whether SRC mode helps; it is "a development fallback").
- Host-to-client push: forwarded events are a fixed allowlist (`P/dsh-api-remotes/README.md`, "Forwarded Host events"), so a plugin cannot add its own `$on` event. Use Session projections with `wire.view` (read with `useProjection`), streaming Fetch routes, or client resources (`ctx.resources.register`) (`P/dsh-client-resources/README.md:16-33`).
- `--public-url` with a path prefix: client code must use relative URLs (`api/…`), as the probe did. Absolute `/api/…` would miss a prefix-stripping proxy (**unverified** with a real prefix).
- The plugin guide recommends a Host command run through `ctx.remote.commands.execute()` for UI actions (`dsh-agent-preset` skill `references/user-actions.md`). That path logs `command/*` events; use a Fetch route when the log must stay unchanged (for example `/btw`).

## 9. Notes for the other researchers

- "Do not append session events with a new `type`. Readers accept an unknown stored event only when its envelope carries `ignorable: true`, and live `Session.append()` cannot set that marker, so the Session would refuse to reopen." (`dsh-agent-preset` skill `references/practices.md`, Stability). So every native surface above can only be fed with **existing** event types (`tool/call`, `subagent/catalog`, `tool-workflow/*`, `request/context`, …). Which of these a plugin may write safely is for **dsh-seams** (Round 2: `tool-workflow/*` and `subagent/catalog` are safe, R2.1 and R2.4).
- A client plugin should not import DSH client packages as modules; copy markup and use `--dsw-alias-*` theme tokens (`references/practices.md`, UI). Plugin views therefore cannot reuse `ToolRow` or `DisclosureRow` directly (**unverified** whether the slot props expose them).
- The composer takeover API: `ctx.slots.register({ name: 'conversation.composer', select }, Component)` while a request is pending; first non-null selector wins by priority (`P/dsh-client-ui-conversation/README.md:76-110`). Fixed-position overlays inside composer slots must portal to `document.body` (`README.md:61`).
- Composer controls a Claude plugin may replace: `conversation.input.model`, `conversation.input.permission`, `conversation.input.plan`, `conversation.input.left/right`, `conversation.input.activity` (slot catalog §10). Replacing `conversation.input.permission` lets the picker show Claude's six modes from `status.permissionMode` (R5.1).

## 10. Slot catalog (from `SlotMap` / `SlotFactoryMap` declarations)

Collected by scanning every `lib/types/**/*.d.ts` in the 0.2.2-rc.1 install for `interface SlotMap` and `interface SlotFactoryMap` (119 entries). Most useful for this plugin:

| Area | Slots |
|---|---|
| Chat | `conversation.chat.node` (keyed by node kind), `conversation.chat.commandview`, `conversation.chat.reasoning.body`, `conversation.chat.turnTail`, `conversation.chat.assistant-actions`, `conversation.chat.user.before`, `conversation.chat.flow` |
| Tools | `tool.call.toolview` (keyed), `tool.call.images` |
| Approval | `conversation.approval.detail`; factory `conversation.approval.card` |
| Questions | `conversation.plan-review.actions` |
| Composer | `conversation.composer` (chain), `conversation.composer.bar`, `conversation.composer.dock` (list), `conversation.input.{left,right,model,permission,plan,activity,attachments,dock,overlay}`, `conversation.input.model.label` |
| Header | `conversation.session.header.{actions,corner,lineage,utilities,views.actions}`, `conversation.header`, `conversation.header.leading`, `conversation.view` (extra tabs beside Chat) |
| Sidebar right | `rightbar`, `rightbar.session`, `sidebar.right.pane.tab`, `sidebar.right.tab.*`, `sidebar.chat.conversation` |
| Shell | `shell.overlay`, `shell.bottom`, `shell.leading`, `shell.quota-notice`, `sidebar.*`, `main`, `root` |
| Settings | `settings.section`, `settings.section.icon`, `settings.plugins.tab`, `settings.general.item`, `settings.header`, `settings.action`, `settings.launcher`, `settings.onboarding` |

Live checks: `shell.overlay` (badge), `conversation.input.left` (button), `conversation.composer.dock` (registration accepted) and the `/` source were all exercised in probes r3–r5. The live slot tree (Client `Slots.listSubTree`) was not available because no browser page was attached to the inspect channel.

## 11. Open questions

1. ~~Can a plugin write `tool-workflow/*`, `subagent/catalog` and `request/context` events without breaking DSH readers or fork?~~ Answered: yes for `tool-workflow/*` (`dsh-seams` R2.4) and `subagent/catalog` with child sessions (`dsh-seams` R2.1); `request/context` feeds the ring (Round 2 Q2).
2. ~~Does `ctx.jobs.attachController()` keep `dsh-tool-jobs` notices away?~~ Not needed: a pending `ctx.jobs.wait()` per job keeps `tool-jobs` silent (`dsh-seams` answer 4, verified). Still open: a pending wait across a DSH restart or session close, and whether a job-list Stop still reaches the job's `kill` while a wait is pending.
3. ~~Is a `command/*` record per Claude slash command acceptable, or should every Claude command go through a client claim and a plain user prompt?~~ Answered: unclaimed lines already arrive as plain user prompts with no `command/*` record (`dsh-seams` R2.3).
4. Settings files: is a plugin editor with an explicit Save allowed under rule 2, or only preview plus a terminal editor?
5. Does the native ring need to be hidden for Claude sessions, or fed? Round 2: it can be fed (correct number), but its breakdown cannot show Claude's categories (R8.2 needs a plugin panel or a replaced ring trigger). Omitting `contextWindow` hides it.
6. How long does DSH keep an idle root agent live? Idle asks need `agents.get(id) === agent` and a root. Probe r6 saw it live and `idle` after a command; the eviction rule is **unverified**.
7. Should idle approvals and elicitations leave a durable trace? Neither surface writes a DSH event. A plugin side record (documented, per rule 8) or nothing.

---

## Round 2 (critic questions)

Probes:
- **r6** (live, isolated DSH on a loopback port, clean env, no model calls): a Host command `p1-arm` captures the receiving live root agent; the session then stays idle (status `idle`, no `turn/start`). A Fetch route then asks while idle: `ctx.approval.request`, `ctx.userQuestions.ask` (plain and `intent: 'approval'`), and two MCP-style elicitations through a plugin channel. Headless Chromium answered each card. The session log was read afterwards.
- **r7** (offline): driver-shaped event lists folded through the shipped projection definitions `sessionStats`, `tokenUsage`, `contextPressure`, `contextBreakdown` and the turn-usage fold `deriveTurnTokenUsage` (all imported from the installed 0.2.2-rc.1 packages). Two steps, one turn, `request/context` with `contextWindow: 200000`, per-step `usage`, no `request/header`, no `system/message`. Three stream variants.

### Q1. A background agent asks while no DSH turn is open

| Path | Result (r6) |
|---|---|
| `ctx.approval.request({ agent, … })` | Throws: "approval.request() outside an open turn: the approval/asked + approval/decided audit pair must be turn-enclosed …". |
| `ctx.userQuestions.ask({ agent, questions })` | Works. The native question card takes the composer seat (header, Markdown detail, option descriptions, free text, Skip, Submit). Answer `{ answers: [{ id: 'q1', selected: ['Beta'] }] }` came back. |
| same with `intent: { kind: 'approval', approve, reject, always }` | Works. Rendered as the generic three-option form, not an approval card. Answer `selected: ['Always allow']`. |
| plugin pending interaction + `conversation.composer` takeover | Works (see Q3). |

Why it works:
- `ask()` checks only that the agent is the registry's exact live instance and a root (`assertLiveRoot`, `P/dsh-user-questions/lib/index.js` near the `ask` method); there is no turn check. A live **child** agent is refused (`DELEGATED_CALLER`), so a Claude subagent's question must be asked on the session's root agent.
- The Web answerer receives it through the allowlisted `user-questions/request` scoped waterfall (`P/dsh-api-remotes/lib/index.js:144`), which needs only a carrier agent.
- The composer chain elects a takeover from `{ sessionId, session, pendingInteraction }` only (`P/dsh-client-ui-conversation/README.md:138-181`). Pending interactions are client-local and independent of the running state (`P/dsh-client-ui-session/lib/types/client/index.d.ts:14-67, 188`). Nothing in the chain needs a turn.
- Neither path wrote any session event (session log tail after r6: only the `command/*` pair of `p1-arm`). So no fake turn, but also no audit record.
- A question with no tool call has no row to reopen it: "closing it rejects the whole wait as `ASK_CANCELLED`" (`P/dsh-client-ui-user-questions/README.md`, Answering). The plugin maps that to a deny/cancel.

Design answer: route every Claude `can_use_tool` (permission, `ExitPlanMode`, and AskUserQuestion when previews are needed) and every `onElicitation` through one plugin interaction channel. It has the CLI's choices (always allow with suggestions, reject with feedback text, approve plan with a mode) and works in and out of turns. Plain AskUserQuestion without previews may use `ctx.userQuestions` on the root agent.

### Q2. Native ring, turn usage row and session stats with a driver

Fields read (code):
- `contextPressure`: `contextWindow` from the newest `request/context`; `pressureTokens = inputTokens + cacheReadTokens + cacheWriteTokens` of the newest usage (`assistant/message.data.usage`, else the stream's last `usage` chunk); `projectedTokens` adds heuristic surface growth since that sample (`P/dsh-token-meter/lib/index.js:368-374, 455-495`). No `request/header` needed.
- `contextBreakdown`: system = last `system/message`, tools = `request/header.tools`, messages = heuristic over the rest (`P/dsh-token-meter/lib/index.js:186-240`).
- `sessionStats`: steps from `step/end`; `llmMs` = `step/start.time` → `assistant/message.time`; first token = first `text-delta` / `reasoning-delta` / name-bearing `tool-call-delta` record time in `assistant/attempt` or `assistant/message` `data.stream` (`assistantStreamFirstTokenTime`, `P/dsh-llm/lib/index.js:1312-1386`); `decodeMs` = `assistant/message.time` − first token, `decodeTokens` = `usage.outputTokens`, only on steps with both (`P/dsh-session-stats/lib/index.js:83-158`). The speed pill shows `decodeTokens / decodeMs` only when `decodeMs > 0` (`P/dsh-client-ui-chat/lib/client.js:9655`).
- Turn usage row: `deriveTurnTokenUsage` needs `turn/start`…`turn/end`, every step with usage, and either `totalTokens` or both cache buckets (`P/dsh-client-ui-chat/lib/client.js:13044-13234`).

Results (r7; real timing: TTFT 1.5 s and 1.0 s, 400 output tokens over 8 s):

| Stream written by the driver | TTFT | Speed pill | Ring | Breakdown | Turn row |
|---|---|---|---|---|---|
| deltas stamped when the full CLI message arrives | 5250 ms (wrong) | **200000 tok/s** | 8% (correct) | System 0, Tools 0, Messages 430 | exact totals |
| deltas stamped as partial events arrive | 1250 ms | 50 tok/s (correct) | 8% | same | exact totals |
| blocks only (no delta chunks) | hidden | hidden | 8% | same | exact totals |

Extra checks: one step without usage hides the whole turn row; no `request/context` (or no `contextWindow`) hides the ring.

Design answer: the native ring and turn row can be fed honestly from `request/context` and per-API-call usage. The breakdown cannot show Claude's `/context` categories. For TTFT and tok/s, write deltas with real times (SDK partial messages), or write blocks only so the figures hide. Background-agent usage outside a turn never appears in a turn row (**unverified** whether the pills count it: they fold whole-log events).

### Q3. MCP elicitation forms and URL auth

- `ctx.userQuestions` items have only options and free text; the README says "richer interaction shapes … have no seam vocabulary yet" (`P/dsh-user-questions/README.md`, Known limitations). No other DSH surface renders a JSON-schema form.
- A plugin can: Host keeps pending requests and pushes them on a streaming Fetch route (NDJSON); the client publishes each as a pending interaction (`kind: 'p1-elicitation'`) and registers a `conversation.composer` takeover that renders the `requestedSchema` properties (string, integer, enum select, boolean, required marks, descriptions) or, in URL mode, a link to `url`. Buttons return `accept` with typed `content`, `decline`, or `cancel` through a POST route.
- r6 results: form → `{ action: 'accept', content: { name: 'Ada', count: 3, color: 'green', agree: true } }`; URL → `{ action: 'decline' }`; the composer came back after each answer; a pending form reappeared after a page reload (the stream replays pending requests on connect).
- This matches the SDK shapes: `ElicitationRequest { serverName, message, mode?: 'form'|'url', url?, elicitationId?, requestedSchema?, title?, displayName?, description? }` and the result is the MCP `ElicitResult` (`SDK/sdk.d.ts:752-777, 1561, 1828`).
- Notes: a streaming Fetch route must declare `requestBody` even for GET (a GET route without it returned 400 in r6). Several browsers each get the push; the first answer wins and the rest must drop the card (the plugin owns this). Pushes are not in the DSH log.
