# Phase 1 completeness critic (round 2)

This note checks the six Phase 1 research notes against every requirement in `requirements.md` and the raw contract in `CLAUDE.md`. Round 1 found 15 gaps and 3 contradictions. Round 2 re-reads the notes after their "Round 2" sections were added. For each round 1 gap it says **answered** (with the evidence location) or **open**. It ends with the questions the design phase must decide.

Notes checked: `dsh-seams.md`, `dsh-ui-surfaces.md`, `sdk-surface.md`, `raw-baseline.md`, `reference-ux.md`, `auth-usage.md`. Versions in the notes: DSH 0.2.2-rc.1, CLI 2.1.318, Agent SDK 0.3.318.

Evidence locations use the note name and its section, for example `dsh-seams` R2.1 or `sdk-surface` §7.3. Source evidence inside the notes uses the same aliases as the notes (`P/<package>/…`, `SDK/sdk.d.ts:N`, `CLI 2.1.318 binary`). Round 1 spot checks by the critic are marked **(critic check)**.

Legend:
- **Covered**: code or live evidence answers it.
- **Partial**: the mechanism is known, but a key part is unverified.
- **Gap**: no note answers it.
- **Design**: the facts are enough; the rest is a design choice.

---

## 1. Summary

- Round 2 closed 13 of the 15 round 1 gaps with live or code evidence, and resolved all three contradictions. The biggest wins:
  - Claude subagents and workflow agents can be **real DSH child sessions**, written natively and opened in the Web UI (`dsh-seams` answer 8, R2.1). Rule 8 holds with no side store.
  - Idle approvals and questions work with **no turn opened** (`dsh-ui-surfaces` Round 2 Q1). Rule 7 holds.
  - Typed Claude slash commands already reach the driver as plain `user/message` events (`dsh-seams` answer 10, R2.3).
  - Steer, attachments, CLI crash, fork-while-live, workflow nodes, permission modes, teams, titles and side questions are all probed.
- Still **open research**: R9.2 (how a plugin publishes a service for other plugins; never researched), R1.4 (the DSH model picker versus "never pass `--model`"), R6.4 (an agent for the main thread), R5.4 (approve plan with a mode, not run live), and live `onElicitation` with a real MCP server.
- Some round 1 text in `dsh-ui-surfaces`, `sdk-surface` and `reference-ux` is now **stale**. It contradicts the Round 2 findings (§3.4). The design phase must use the Round 2 answers.
- Many items are now design choices, not research. §6 lists them.
- Public-doc hygiene: re-grepped for local path prefixes, uuids, ARNs, 12-digit numbers, emails and tunnel hosts. Nothing found. The probe hosts (`probe.example.test`, loopback ports) are fine.

---

## 2. Round 1 gaps: status

| # | Round 1 gap | Status | Evidence | What is left |
|---|---|---|---|---|
| 1 | Subagent children as DSH child sessions | **Answered** | `dsh-seams` answer 8, R2.1 (probe `r2.mjs child-session`, live `seams2-probe`): `ctx.agents.create` with child `meta`, `subagent/descriptor`, `subagent/catalog` v0 `one-shot`; both logs reload; the UI lists, opens (live) and shows the child read-only. | Child `agentPreset` and `agent-preset/selected` (`dsh-seams` open Q6). Child stream granularity: the SDK gives whole child messages, so a live child shows one chunk per message (**unverified** visually; `dsh-seams` open Q7). One-shot rows have no native per-child stop, so the stop control is the plugin's. A fork of the parent does not carry the child rows. |
| 2 | Approvals and questions with no open turn | **Answered** | `dsh-ui-surfaces` Round 2 Q1 (probe r6, browser): `ctx.approval.request` throws; `ctx.userQuestions.ask` on the live root agent works idle; a plugin pending interaction plus a `conversation.composer` takeover works idle. | No DSH audit event is written by either path. A child agent is refused (`DELEGATED_CALLER`), so ask on the root. How long DSH keeps an idle root agent live is **unverified** (`dsh-ui-surfaces` open Q6). |
| 3 | Steer timing while the CLI runs a tool | **Answered** | `dsh-seams` answer 9, R2.2: `agent/inbox/inserted` fires synchronously during `agent/pre-step` with `nextStep` updated (probe `r2.mjs steer-timing`, live `seams2-probe`). Ctrl/Cmd+Enter = steer, Enter = queue. | — |
| 4 | Slash command path | **Answered** | `dsh-seams` answer 10, R2.3 (live): unclaimed `/name …` lines fall through `ui-commands` to `session.prompt()` as a native `user/message`, with no `command/*` record. `/compact` reaches Claude in our preset. | DSH keeps `/model`, `/permission`, `/export`, `/feedback` in our preset (`dsh-seams` open Q5): design. If a profile mounts DSH compaction for our sessions, it would summarize with another model (`dsh-seams` R2.3): design must prevent it. |
| 5 | AskUserQuestion `previewFormat` | **Answered** | `raw-baseline` answer 4, Round 2: the TUI (`cli` client) defaults to `markdown`; SDK mode leaves it unset; with `'markdown'` the SDK tool text is byte-identical to the TUI's. The model emits previews in both SDK modes. | Do not override a user-set `CLAUDE_CODE_QUESTION_PREVIEW_FORMAT`; never pick `html`. Whether the paragraph changes how often previews appear is **unverified** (small sample). |
| 6 | `tool-workflow/*` with no DSH workflow call | **Answered** | `dsh-seams` answer 11, R2.4: no v4 relationship rules; pass inside a step and outside a turn; survive reload and fork; the Web UI draws run, phases and members, and a running member opens its child. | Export and search skip these events. The native node has no tokens, output or stop (`dsh-ui-surfaces` §4), so R6.5 still needs a plugin node or panel. |
| 7 | Native ring and stats with a driver | **Answered** | `dsh-ui-surfaces` Round 2 Q2 (probe r7, offline fold through the shipped projections): ring correct from `request/context` + per-step usage; turn row exact; TTFT and tok/s honest only when deltas carry real arrival times; blocks only hide them. | Breakdown cannot show Claude's categories (R8.2 needs a plugin panel or a replaced ring). r7 was an offline fold, not a browser render. Whether the pills count background-agent usage outside a turn is **unverified**. |
| 8 | Attachments | **Answered** | `dsh-seams` answer 12, R2.5 (live driver log, `r2-sdk.mjs attach`): images → SDK base64 image blocks from `ctx.attachments.readImage`; files → `@"<fileHostPath>"` text; the CLI attaches with no tool call and no permission request, as the TUI does. | Whether a user `permissions.deny` rule on the DSH attachment folder blocks the `@` read is **unverified**. Do not copy DSH's `fileHandleText` sentence. |
| 9 | Agent teams | **Answered** | `sdk-surface` answer 16, §7.1 (probe7 M): teammates are background `local_agent` tasks started by `Agent` with `name`/`team_name`; `SendMessage` blocks and resume prompts carry the messages; `getSubagentMessages` gives transcripts; `send_task_message` is unsupported on 2.1.318. | "Message a teammate" has no host control: R6.3's optional part is "not supported by the CLI". `in_process_teammate` mode did not appear in SDK mode (**unverified** when it does). A message to a running teammate was not seen on the stream. |
| 10 | `bypassPermissions` and `auto` | **Answered** | `sdk-surface` answer 13, §7.2 (probe7 P, B, 7a, 7b): all six modes switch live; bypass needs `allowDangerouslySkipPermissions` at spawn or a bypass `defaultMode`; `auto` rules and `supportsAutoMode`. | Whether to offer the bypass spawn flag as an opt-in: design (§6). |
| 11 | Workflow stop and interrupt | **Answered** | `sdk-surface` answer 7, §7.3 (probe7 S): with `perTaskStopAffordance`, `interrupt()` spares a running workflow and background agents; `stopTask` stops one workflow or one agent and its shells only. | `stopTask` on a **foreground** subagent is not tested. |
| 12 | MCP elicitation UI | **Answered (UI)**, Partial (CLI) | `dsh-ui-surfaces` Round 2 Q3 (probe r6): a plugin composer takeover renders `requestedSchema` fields and URL mode, returns `accept`/`decline`/`cancel`, and survives a reload. | `onElicitation` itself was never run with a real MCP server (`sdk-surface` §6). |
| 13 | Session title source | **Answered** | `sdk-surface` answer 14, §7.4 (probe7 T, P): the CLI writes an `ai-title` transcript entry on the same process; read it with `getSessionInfo()`; it is skipped when non-essential traffic is off. Do not call `generateSessionTitle`. | When to poll `getSessionInfo()` (after the first `result`, about 1 s later): design. Which model the title call used is **unverified**. |
| 14 | Side question during a turn | **Answered** | `sdk-surface` answer 15, §7.5 (probe7 P): answers while streaming and during a tool; the host must keep `history` (last 20 main-thread exchanges). | — |
| 15 | CLI crash; fork with a live source | **Answered** | `dsh-seams` answers 13–14, R2.6 (`r2.mjs cli-died-*`, live `probe:died`, `r2-sdk.mjs crash`, `forklive`): the driver must close its own step before rethrowing; DSH host crash self-repairs; fork while live works if cut at a completed assistant uuid. | Orphaned tool processes after a CLI SIGKILL (process-group cleanup): design. |

## 3. Contradictions

### 3.1 `previewFormat`: resolved

`raw-baseline` Round 2 is the answer: set `'markdown'` unless the user set the env var. The stale text in `sdk-surface` §2 (the `previewFormat` row) and `reference-ux` open Q11 is fixed (§3.4).

### 3.2 Silencing `dsh-tool-jobs`: resolved in practice, partly open

- Verified path: keep a `ctx.jobs.wait()` pending per job, so `tool-jobs` sees `awaited: true` and stays silent (`dsh-seams` answer 4, probe `jobs-awaited.mjs`).
- `dsh-ui-surfaces` §3 and open Q2 now point to the verified path (fixed, §3.4).
- Still not tested: a pending wait across a DSH restart or session close (rings and waits are process-local, `dsh-ui-surfaces` §3), and whether a job-list Stop still reaches our `kill` while a wait is pending.

### 3.3 Session titles: resolved

`sdk-surface` answer 14. `reference-ux` §9 ("Claude's redundant naming request") agrees: let the CLI name the session.

### 3.4 Stale round 1 text that now contradicts Round 2

**Fixed** (topup pass): each line below was edited in its note to agree with Round 2. The `LOCAL_ENV.md` row is a local file and is not part of this pass.

| Note and place | Stale claim | Round 2 answer | Status |
|---|---|---|---|
| `dsh-ui-surfaces` answers table, `/` menu row; §6 Host commands (`README.md:27` quote, R7.1 bullet) | Unknown commands are rejected; `plugin:cmd` and clashes need a client source; a Claude command needs a Host command or claim | Unclaimed lines fall through to a plain user prompt (`dsh-seams` R2.3, live) | Fixed |
| `dsh-ui-surfaces` answers table, Subagents row; §4 Subagent catalog | Navigable rows need a child session; whether a plugin may write them is unverified | A plugin can create them (`dsh-seams` R2.1, live) | Fixed |
| `dsh-ui-surfaces` §4 Workflow run node ("Only top-level calls through `dsh-tool-workflow` produce these records") | Implies a plugin cannot feed the node | A plugin can write the events (`dsh-seams` R2.4, live) | Fixed |
| `dsh-ui-surfaces` open Q1 and Q3 | Open | Answered by `dsh-seams` R2.1, R2.3, R2.4 | Fixed |
| `dsh-ui-surfaces` Jobs row, §3, open Q2 | Use `attachController()` | Use a pending `wait()` (§3.2) | Fixed |
| `sdk-surface` §2, `previewFormat` row | Not raw | Matching the TUI (`raw-baseline` Round 2) | Fixed |
| `sdk-surface` §6, "Workflow agents' live output" | No source found | Workflow agents can be child sessions (`dsh-seams` R2.4), but the **source** of their live output is still open (§4 item 4) | Fixed |
| `reference-ux` open Q1, Q6, Q8, Q11 | Open | Answered by `dsh-seams` §3, `sdk-surface` answer 7, `dsh-ui-surfaces` Q1, `raw-baseline` Round 2 | Fixed |
| `LOCAL_ENV.md` (local) | DSH 0.2.1-rc.5 | Notes cite 0.2.2-rc.1; `dsh-seams` re-ran on both | Open (local file) |

---

## 4. Requirement coverage after round 2

Only rows that changed, or that are still not Covered/Design, are listed. Every other row is as in round 1 and is Covered or Design.

| Id | Status | Evidence | Still open |
|---|---|---|---|
| R1.1 | Partial | `sdk-surface` answers 2–3 | macOS and Windows path resolution, including the `~/.local/bin` fallback on Windows. Not tested (CI later). |
| R1.3 | Partial | `dsh-ui-surfaces` §7 | Real `~/.claude/...` path and DSH read policy not tried. Editing is a maintainer decision (§6). |
| R1.4 | **Gap** | `dsh-seams` §1.1 (a provider/model selection is required before `preStep`) | How the plugin's catalog model id, the DSH model picker (`/model`, `conversation.input.model`) and inherited `model/selection` events coexist with "never pass `--model`" and with `setModel` for a per-session choice. Not researched. |
| R2.2 | Partial | `dsh-seams` answer 6 | Whether `origin: {kind:'human'}` on steer has any model-visible effect (it enables the `ultracode` keyword). Not checked. |
| R2.3 | Covered | `sdk-surface` answers 3, 13; `raw-baseline` answer 4 | — |
| R2.5 | Covered | `sdk-surface` answers 14–15; `dsh-seams` answer 7 | `promptSuggestions` and `agentProgressSummaries` make extra calls: design (§6). |
| R3.2 | Covered | `sdk-surface` §7.3 | `stopTask` on a foreground subagent. |
| R3.3 | Partial | `dsh-seams` §3 | The wake turn (non-user notice) has still not been seen in a browser (`dsh-seams` open Q2). Busy and idle without `session_state_changed` (`sdk-surface` §6). |
| R3.4 | Covered | `dsh-seams` R2.2 | — |
| R3.5 | Covered (mechanism), Design | `dsh-seams` answer 5, R2.6 | Rewind is "fork at an earlier point": maintainer decision (§6). |
| R3.6 | Covered | `dsh-seams` answer 13, R2.6 | — |
| R4.1 | Covered | `dsh-seams` R2.1–R2.2 (live UI) | Per-tool card mapping is a design task. |
| R4.2 | Partial | `dsh-seams` §2.4; `dsh-ui-surfaces` Q2 | Live text streaming of driver frames is not called out in a browser check. |
| R4.3 | Covered | `dsh-seams` R2.5 | `permissions.deny` on the attachment folder (**unverified**). |
| R5.1 | Covered | `sdk-surface` §7.2 | — |
| R5.2 | Covered (surface), Design | `dsh-ui-surfaces` Q1 | The card, the "always" suggestions and the feedback field are plugin work. |
| R5.3 | Covered | `raw-baseline` Round 2; `dsh-ui-surfaces` §3 | Previews need a plugin view (native card has no preview field). |
| R5.4 | Partial | `sdk-surface` §5; `dsh-ui-surfaces` §3 | Approve-with-mode through `updatedPermissions: setMode` is still not live-tested. |
| R5.5 | Partial | `dsh-ui-surfaces` Q3 | Live `onElicitation` with a real MCP server. |
| R6.1 | Covered | `dsh-seams` R2.1 | Child stream granularity; per-child stop control. |
| R6.2 | Covered | `dsh-seams` §3 | Pending wait across restart (§3.2). |
| R6.3 | Covered | `sdk-surface` §7.1 | Teammate messaging is not supported by the CLI: record as deferred. |
| R6.4 | **Gap** | `sdk-surface` §3 (`supportedAgents`) | Picking an agent for the main thread: the SDK `agent` start option, whether it adds a flag (rule 4), and whether it can change mid-session. Not researched. |
| R6.5 | Partial | `dsh-seams` R2.4; `sdk-surface` §7.3; `reference-ux` §2 | Source of live workflow-agent output (no stream frames; agent transcripts via `getSubagentMessages`?). Ultracode keyword with `origin: human` not live. `workflow_progress` frame rate and size. |
| R7.1 | Covered | `dsh-seams` R2.3 | DSH-held clash names: design. |
| R7.3 | Covered | `sdk-surface` §7.5; `dsh-ui-surfaces` §6 | — |
| R8.2 | Covered (ring), Design (breakdown) | `dsh-ui-surfaces` Q2 | Plugin panel for Claude's categories. |
| R8.3 | Partial | `auth-usage` | Live subscription check needs a subscription account. |
| R8.4 | Covered | `dsh-ui-surfaces` Q2 | Driver must stamp deltas with real arrival times, or write blocks only. |
| R9.2 | **Gap** | — | How a third-party plugin publishes Host and client services that other plugins depend on (Cordis service declaration, typing, versioning). No note covers it. |
| R10.1 | Partial | `dsh-ui-surfaces` §8 | Real `--public-url` path prefix. |
| R10.2 | Partial | — | macOS and Windows. |

Raw contract rules after round 2: rules 1, 2, 3, 5, 6, 7, 8, 9, 11 and 12 are Covered (12 on Linux only). Rule 4 is Partial (R1.4 model selection, the bypass opt-in, R6.4). Rule 10 is Partial (R5.4, R5.5 live, R6.4, R6.5 live output). Rule 13 is Design.

---

## 5. Unverified claims that still matter

1. The wake turn (non-user notice in `agent/inbox/spliced`) as rendered in the browser.
2. The ring, pills and turn row in a browser (r7 was an offline fold).
3. `forwardSubagentText` changes nothing the model sees.
4. A pending `ctx.jobs.wait()` across a DSH restart or session close, and the job-list Stop reaching `kill`.
5. Idle root agent eviction, which decides whether an idle question can be asked late.
6. `permissions.deny` versus the DSH attachment folder.
7. `stopTask` on a foreground subagent.

Items 1, 2 and 4 belong in the Phase 3 spike. None of them changes the seam choice.

Answered since round 1: the `dsh-time-context` guard in a full web profile (`dsh-seams` open Q1: 20 turns, no DSH model request); plugin-written `tool-workflow/*` and child sessions (`dsh-seams` R2.1, R2.4); crash and fork-while-live (`dsh-seams` R2.6); interrupt sparing a workflow (`sdk-surface` §7.3).

---

## 6. Open questions the design phase must decide

### 6.1 Research still needed (small; can run during design)

1. **R1.4 model selection.** What provider/model the plugin registers so `preStep` runs; how the DSH `/model` command and `conversation.input.model` picker map to `setModel` (session-only) and `supportedModels()`; what the inherited `model/selection` events do on fork; and how a new session shows the user's settings model without passing `--model`.
2. **R9.2 service API.** How a third-party plugin declares and exposes Host and client services (Cordis), and how a sample plugin depends on them.
3. **R6.4 main-thread agent.** The SDK `agent` option: the CLI flag it adds, and whether it can change mid-session.
4. **R6.5 live workflow-agent output.** Where to read it (child transcripts, `getSubagentMessages`, `getTaskOutput`?) and at what rate.
5. **R5.4 and R5.5 live.** Approve plan with `setMode`; one real MCP elicitation through `onElicitation`.

### 6.2 Design choices (facts are enough)

1. **Interaction channel.** One plugin channel (pending interaction + composer takeover + streaming Fetch route) for permissions, plan approval, previews and elicitations, or `ctx.userQuestions` for plain questions. Whether to keep a durable record of idle decisions (a plugin record, documented per rule 8) or none.
2. **Child sessions.** One child session per Claude subagent and workflow agent; how much of the child stream to write; the child's `agentPreset`; the stop control for one-shot children (plugin control → `stopTask`).
3. **Workflow and team views.** Native workflow node plus a plugin node or panel for tokens, output and stop; a team roster panel from `task_started`, meta names and `SendMessage` blocks.
4. **Tool cards.** Register views for Claude tool names, or map to DSH names. Per-tool choice.
5. **Usage display.** Feed the native ring and turn row (real delta times), plus a plugin panel for Claude's `/context` categories, cost and plan limits.
6. **DSH name clashes.** How to reach Claude's own `/model`, `/export`, `/feedback` and `/permission` (agent-scoped Host command with `command/*` records, or accept DSH's).
7. **DSH compaction.** Make sure `compaction-basic` and `command-compact` are not mounted for our sessions, and the catalog adapter refuses every request.
8. **Jobs.** Pending `wait()` per job (verified), not `attachController()`. *(Superseded: the design attaches its own preset-scoped job controller and keeps one pending `wait()` only as a second guard; see `docs/architecture.md` D47.)*
9. **Process lifecycle.** Idle reaping, process limits, and process-group cleanup after a CLI crash (orphaned tool processes).
10. **Busy and idle.** Drive them from `status`, `result` and `command_lifecycle`; skip empty `num_turns: 0` results and `local_command` usage.
11. **Version drift.** Treat every control as optional; detect `Unsupported control request subtype`.
12. **Platform binaries.** Document the opt-in pnpm `overrides` block.

### 6.3 Maintainer decisions (not research)

1. Settings quick access: a plugin editor with an explicit Save, or read-only preview plus a terminal editor? The preview may show secrets from settings `env`.
2. Offer `allowDangerouslySkipPermissions` as an explicit opt-in (mirrors the TUI launch flag; plan mode then stops asking before edits)?
3. `promptSuggestions` and `agentProgressSummaries`: off, or on so the user's own setting decides (each is an extra call on the same process)?
4. Strip `DSH_*` variables from the CLI env?
5. Accept the SDK's `NODE_OPTIONS` removal, or restore it with `spawnClaudeCodeProcess`?
6. Rewind as "fork at an earlier point" (a new DSH session): acceptable for R3.5?
7. Teammate messaging is not supported by CLI 2.1.318: defer that part of R6.3?
8. Subscription checks for R8.3 need a subscription account.
