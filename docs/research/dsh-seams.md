# DSH seams: how a plugin can own a session's turns

Research note for the design phase. Topic: the places in DeepSeek Harness (DSH) where a plugin can take over a session, write the transcript as native events, and show background work.

- **Versions checked:** DSH 0.2.2-rc.1 (all `@deepseek-ai/*` packages at that version), Claude Code CLI 2.1.318, Claude Agent SDK 0.3.318. The brief names DSH 0.2.1-rc.5. The same probe gave the same results on both versions.
- **Path aliases:** `P/<package>/...` is a file in the installed `@deepseek-ai/<package>` package. Line numbers are for 0.2.2-rc.1. `aio/...` is `cocofhu/dsh-aio-agent` at commit `d1681bf`. `dshc/...` is the recovered dsh-claude 0.1.67 source.
- **Probes** (private scratch, named so the design phase can re-run them):
  - `roundtrip.mjs`: runs the installed DSH agent loop in-process with the real JSONL persistence. A test driver writes native events. The probe then reloads the session from disk (the same read path as a DSH restart) and runs DSH's v4 relationship check. It makes no model calls.
  - `jobs-awaited.mjs`: checks the job registry's `awaited` flag.
  - `bg-probe.mjs` and `interrupt-probe.mjs`: tiny SDK sessions on Sonnet that use the user's own `claude`.
  - Round 2 (see the "Round 2" section at the end):
    - `r2.mjs`: in-process DSH probes in the same harness (child sessions, steer timing, DSH `/compact`, workflow events, CLI death, host crash).
    - `r2-sdk.mjs`: SDK probes on Sonnet (CLI killed mid-turn, fork while the source is live, images and `@path` files).
    - `seams2-probe`: a throwaway plugin with a scripted driver preset (no CLI), run in an isolated DSH web profile and driven by headless Chromium. It checks what the Web UI shows and what the driver receives.

## Answers for the design

1. **Use an `agent/pre-step` driver, mounted by an agent preset.** This is the dsh-aio-agent pattern. The driver runs the whole turn in the CLI, writes the native events itself, and returns `{kind:'enter', messages: []}`, so DSH never calls a model. The other two seams are worse:
   - **LLM adapter (dsh-claude):** the DSH loop executes every tool-call block it sees in a model response. It also writes a DSH system prompt and a `request/header`, and that header turns on DSH compaction and DSH titles for the session.
   - **AgentFactory:** there is one factory for the whole profile. Replacing it means reimplementing DSH's `Agent` class for every session.
2. **Native events are safe if we keep five rules.** Every rule is checked only when the log is **loaded**. A live append never checks them. That is exactly how issue #57 happened: the session worked live, then could not be reopened.
   - (a) `assistant/message` and `tool/call` only inside an open `step/start`…`step/end`.
   - (b) Each `tool/call` follows an `assistant/message` in the same step whose content holds a `tool-call` block with the same id, an identical `name`, and a byte-identical `arguments` string.
   - (c) Every advertised call has a `tool/result` before `step/end`.
   - (d) Every `assistant/message` carries a `stream`. Build `content` from the same chunks.
   - (e) Use only known event types, or `plugin:` records (marked ignorable). An unknown type makes the session refuse to open.
   - Reasoning blocks, two `assistant/message` events in one step, and extra binding fields in `message.source` and `replayState` all pass the check and survive a reload.
3. **Two hazards in the driver pattern. We must handle both.**
   - **Host listeners.** Host plugins that are mounted in web profiles (for example `dsh-time-context`) add context *after* the driver returns. The loop then makes a real DSH model request, and it writes a second `step 1`. That log fails to reopen. The fix is an agent-scoped `agent/pre-step` listener registered with `prepend: true`. It forces `messages: []` on the way out (verified with the real `dsh-time-context`).
   - **Queued follow-ups.** A follow-up typed during a turn stays queued after the turn ends. The loop does not pick it up by itself. On `agent/status: idle`, re-send it with `agent.send(msg, target, true)`. This is what dsh-aio-agent does (verified).
4. **Background work with no turn open:**
   - **Jobs.** `job/registered` and `job/settled` may be written outside a turn. Show Claude's background tasks through `ctx.jobs.start(...)`. Keep a `ctx.jobs.wait()` pending on each job. Otherwise DSH's `tool-jobs` plugin wakes our session with a synthetic "job finished" message (verified: a pending wait sets `awaited: true`, and `tool-jobs` then stays silent).
   - **Autonomous CLI turns.** The CLI starts a turn by itself when a background task finishes (verified on 2.1.318). Its output must go in a turn, because `assistant/message` outside a step breaks the log. So open a DSH turn with `agent.followup(<non-user notice>)`, and do not write the notice as a `user/message`. The log still keeps the notice text inside `agent/inbox/spliced`.
5. **Fork, rewind, export and search all read the native log.**
   - **Fork** copies an exact event prefix into a new session through the same preset. DSH has no in-place rewind: rewind is a fork at an earlier `atSeq`. The fork header has `isSeeded: true` but **no `parentSession`**. So the driver must find its Claude binding (Claude session id and message uuid) in the inherited prefix, and compare the DSH session id stored with it. Then it calls the SDK's `forkSession` + `resumeSessionAt`.
   - **Export** keeps `user/message` only when `source.kind === 'user'`. It keeps assistant text, `tool/call` and `tool/result`, and it drops reasoning.
   - **Search** indexes user text, assistant text, tool names and arguments, tool results, todos and turn errors. It skips reasoning and `plugin:` records.
6. **Filter the inbox.** The driver also receives non-user messages in its claimed batch, for example `tool-jobs` notices and `inject()`ed context. To keep raw rule 3, forward only `source.kind === 'user'` messages, plus their attachments, to Claude.
7. **Free side benefits of the driver route.** Automatic DSH compaction (`compaction-basic`) and the DSH LLM title both need a `request/header`, and the driver never writes one. So neither runs, and there is no hidden DSH model call. In the live web profile, DSH wrote a `session/title` with `source.kind: 'fallback'` (the first prompt text, no model call). To show Claude's title, write `session/title` ourselves, citing the human `user/message` seqs.
8. **Claude subagents and workflow agents can be real DSH child sessions** (round 2, live UI). Create the child with `ctx.agents.create({ parentAgent, meta: { parentSession, origin: 'subagent', delegationDepth, isSeeded: false, cwd, agentPreset } })`, append a one-shot `subagent/descriptor` in the child and a `subagent/catalog` v0 `mode: 'one-shot'` row in the parent. Open one child turn with `child.followup(<task prompt, source.kind 'user'>)` and write the child's steps, tool calls and results natively in the child. The parent keeps only the `Agent` tool call and its result. `dsh-client-ui-subagent` lists the child, opens it (live while it runs), and shows it read-only ("One-shot subagent record"). Both logs reload. Export of the child keeps its tool calls. A fork of the parent does **not** carry the child rows (catalog projections exclude inherited facts).
9. **Steer and queue map cleanly.** DSH composer Enter while a turn runs = queue (`followup` → `inbox.nextTurn`). Ctrl/Cmd+Enter, or "Steer queued message" = steer (`agent.steer` → `inbox.nextStep`). The agent-scoped `agent/inbox/inserted` event fires synchronously while the driver is blocked in `agent/pre-step`, with `inbox.nextStep.length` already updated. So: on `inserted` with the message in `nextStep`, send it to the CLI at once with SDK `priority: 'next'`; claim it (`agent/inbox/spliced` + `user/message`) at the next step boundary. Leave queued (`nextTurn`) messages in DSH and re-wake them after the turn (answer 3). Do not use SDK queueing for them.
10. **Typed Claude slash commands reach the driver as plain prompts.** In the web composer, a `/name …` line that no Host command or client contribution claims falls through `ui-commands` (`matchEnter` returns undefined) to the default sink, so it arrives as an ordinary `user/message` with the exact text. Live: `/context`, `/review`, `/compact`, `/permissions`, `/my-plugin:do-thing arg1`, `/frontend-design:frontend-design make it blue`. No `command/*` record is written. Only names that DSH itself serves in our preset are taken by DSH: `/model`, `/permission`, `/export`, `/feedback` (and the client File action). DSH `/compact`, `/goal` and `/plan` are **not** listed in a session of our preset, so `/compact` goes to Claude.
11. **Workflow nodes work without a DSH workflow tool call.** `tool-workflow/run-start`, `agent-start`, `agent-end` and `run-end` have no v4 relationship rules (known types only). They pass inside a step and outside any turn, survive reload and fork, and `dsh-client-ui-workflow-run` draws the run node with phases and members. A running member whose `childId` is a local child session opens that child.
12. **Attachments:** a DSH `user/message` carries `{type:'image', attachment: ImageAttachmentRef}` (no bytes) and `{type:'file', attachment: FileAttachmentRef}`. Send images as SDK base64 image blocks (bytes from `ctx.attachments.readImage(ref)`). Send files as `@"<fileHostPath(ref)>"` text. The CLI expands `@path` into its own `file` attachment with no tool call and no permission request, even outside the cwd. This matches the TUI.
13. **Failure handling.** If the CLI dies, the SDK iterator throws `Claude Code process terminated by signal SIGKILL` and every control call rejects. The driver **must close its own open step** (repair results with `ToolCallRecovery`, `step/end`, `end` the live frame with `abandoned`) before it rethrows. Then the loop writes `turn/end {kind:'error'}` and the UI shows "This turn failed <message>". If the driver rethrows with the step open, the session cannot be reopened. If DSH itself crashes mid-step, reopening adds `tool/result`, `step/end` and `turn/end {kind:'interrupted'}` by itself.
14. **SDK fork works while the source process is live and mid-tool.** But a fork "at the tip" while the source turn runs drops the in-flight turn: the CLI keeps the user prompt and adds a synthetic "No response requested." Always fork with `resumeSessionAt` at a completed assistant message uuid (DSH forks at a completed boundary by default).
15. **Model selection (R1.4, Round 3).** Register one catalog provider whose first row means "your Claude settings" and whose other rows come from `supportedModels()`. Its `stream()` refuses every request. The rules:
    - **Explicit choice = a `model/selection` event in the session log** (own or inherited) that names our provider. Anything else (no event, or only the DSH default in `AgentOptions`) means "use the user's settings": the driver calls no `setModel` and passes no `--model`.
    - **Apply a choice with `setModel(value)`** on the live process, and **re-apply it after every spawn** (resume after a DSH restart, fork). A resumed process starts on the settings model again (live).
    - **"Back to my settings" is not `setModel(undefined)`.** `setModel(undefined)`, `setModel('default')` and `applyFlagSettings({model: null})` all switch to Claude Code's default model, not the user's `model` setting. `applyFlagSettings({effortLevel: null})` goes to the model's default effort, not the user's `effortLevel` (live). To reset, re-apply the values the process had at spawn (`getSettings().applied`, read before any control call), or respawn.
    - **Hazard: DSH saves every picker choice as the profile default.** `session.selectModel` (composer seat and `/model`) records the session's `model/selection` and also calls `agentDefaultModel.saveSelection()`, which edits the DSH profile patch. After a user picks a Claude model, a new **Standard** DSH session routes to our provider and fails (live). The design must avoid the DSH `selectModel` path for Claude choices (see Round 3).
    - A fork carries the parent's `model/selection` only if the cut is after it. An earlier cut takes the current DSH default (live).

---

## 1. Three seams for owning a session's turns

### 1.1 How the DSH loop runs a turn

`P/dsh-agent-loop/lib/index.js`:

- `turn()` (`:719-832`) appends `turn/start`. Then, for each step, it calls `preStep()` (`:666-717`), which runs the `agent/pre-step` **waterfall** (`:685`).
  - The default handler (`next()` at the bottom) returns the claimed inbox messages plus DSH runtime context.
  - The decision is `{kind:'reject'}` or `{kind:'enter', messages}` (`P/dsh-agent/lib/types/runtime-types.d.ts:117-124`).
- If the first step admits no messages, the loop closes the turn as `completed` with **no model call** (`:752-755`).
- Otherwise `step()` (`:833-976`) does these things, in order:
  - appends `system/message` (the DSH prompt) (`:854`);
  - writes `request/header` (`:1030-1041`);
  - streams from the LLM adapter (`:877`) and appends `assistant/message`;
  - **executes every `tool-call` block with DSH's tool executor** (`:961`).
- Before any of this, `preStep()` needs a model selection: "has no provider/model" (`:671`). So a plugin must still register a provider and model for its sessions. dsh-aio-agent does this with a catalog (`aio/lib/agent.js:36`).

### 1.2 Seam A: `agent/pre-step` driver (recommended)

How dsh-aio-agent wires it:

- An agent preset adds one agent-scoped plugin (`aio/lib/agent.js:37-45`).
- That plugin listens on `agent/pre-step`. It runs the turn in the CLI, writes the steps through its `TurnWriter`, claims steering from `agent.inbox.nextStep` between CLI steps, and returns `{kind:'enter', messages: []}` (`aio/lib/driver.js:428-492`).
- The DSH composer, Stop, queue and transcript keep working.

What the probe showed:

- All happy-path scenarios pass the live append, the v4 check and the disk reload: text, tools, reasoning, interrupt, steer-between-steps and fork (`roundtrip.mjs`, the `text` through `fork` scenarios).
- The loop then writes `turn/end {kind:'completed'}`, or `{kind:'aborted'}` after Stop.
- If the driver throws, the loop writes `turn/end {kind:'error', error:{message, code:'UNKNOWN'}}`, so CLI failures show in the UI (`:807-814`; probe `stray-request-listener`).

Hazard 1: host listeners decorate the driver's decision.

- Listeners run in registration order (`P/cordis/lib/index.js:810,920`: `push` unless `prepend`). Host plugins registered at startup therefore wrap the preset's driver.
- 13 shipped packages listen on `agent/pre-step`: plan-mode, time-context, tmux-context, agent-instructions, compaction-basic, goal-round-driver, repeat-tool-reminder, session-checkpoint-policy, tool-skill, action-cards, session-reference, workspace and the session controller.
- `dsh-time-context` adds its message after `next()` and does not check for an empty decision (`P/dsh-time-context/lib/index.js:249-275`). It is mounted in the SDK and web profiles (`P/dsh-sdk-app/cordis.patch.yml:61`).
- Probe `real-time-context` loads the real `dsh-time-context`. The result:
  - The loop made a DSH model request (it hit our stub adapter).
  - It wrote a second `step/start {step:1}`, because the loop's own step counter was still 0.
  - The log then failed to reopen: "step/start does not match the open turn and next step".
- Probe `real-time-context-with-guard`: an agent-scoped listener with `{prepend: true}` that awaits `next()` and returns `{kind:'enter', messages: []}` fixes both problems.
- `dsh-agent-instructions` already expects drivers like ours: it leaves step 1 alone when the decision is empty (`P/dsh-agent-instructions/lib/index.js:1484`). dsh-aio-agent has no such guard (`aio/lib/driver.js:428`). How it behaves under `dsh-time-context` in a real profile is **unverified**.
- Side effects inside the guard still run. For example, `dsh-plan-mode` still appends `plan/mode` after `next()` (`P/dsh-plan-mode/lib/index.js:168-183`).

Hazard 2: queued follow-ups stall.

- When step 1 admits nothing, `turn()` returns `false` (`:752-755`) and never reaches its `hasPending` check (`:827`).
- `wakeDriver()` ignores a wake while a turn runs, unless the agent is in maintenance or an abort (`:618-621`).
- Probe `queued-followup-stalls`: after the turn, `inbox.nextTurn` still holds 1 message and the agent is `idle`.
- Probe `queued-followup-rewake` applies dsh-aio-agent's fix (`aio/lib/driver.js:228-244`). On `agent/status: idle`, it splices the message out with `agent/inbox/spliced` and calls `agent.send(message, target, true)`. Turn 2 then runs, and the log is valid.

### 1.3 Seam B: LLM adapter (dsh-claude)

dsh-claude registers an LLM provider whose `stream()` runs one whole Claude turn per DSH model call (`dshc/adapter.ts:319-465`).

Costs:

- The loop executes any `tool-call` block in the response with DSH's own tools (`P/dsh-agent-loop/lib/index.js:957-975`). So the adapter cannot advertise Claude's tool calls. dsh-claude tried writing `tool/call` without an advertised block, and that is issue #57. It then moved tool records to a private sidecar (`dshc/supervisor.ts:2083-2089`).
- The loop writes a DSH `system/message` that Claude never sees (`:854`). It also writes a `request/header` with DSH's tool list (`:1030-1041`).
- That header turns on DSH features we do not want:
  - `compaction-basic` compacts once the token meter crosses a threshold (`P/dsh-compaction-basic/lib/index.js:932-936,949-975`);
  - the LLM title uses the "logged request route" (`P/dsh-session-title-llm/lib/index.js:116-120`).
  - Both send their requests to the adapter, so the adapter must refuse them (`dshc/adapter.ts:350-358`) or answer them with hidden side calls.
- Steering and runtime context arrive as extra messages in every step's request, and the adapter must filter them.

In theory an adapter could advertise each tool call and register "presentation tools" that wait for the CLI's result. That would need one DSH step per CLI model call, and DSH's approval, hook and sandbox policies would run on Claude's tool names. This is **unverified** and fragile. We do not recommend it.

### 1.4 Seam C: AgentFactory

- `AgentRegistry.setFactory()` throws "an agent factory is already registered" (`P/dsh-agent/lib/index.js:558-566`). `AgentLoop` registers itself at startup (`P/dsh-agent-loop/lib/index.js:1344`).
- A replacement would serve every session in the profile, including DSH's own sessions and subagents.
- It would have to reimplement `Agent`: inbox, model selection, status and cancel (the contract is `P/dsh-agent/lib/types/index.d.ts:155-188`). The concrete `Agent` class is not exported (`P/dsh-agent-loop/lib/index.js:1778`).
- Not viable for a plugin that sits beside DSH's own agents.

## 2. Writing native events safely in v4

### 2.1 Where validation happens

- `session.append()` does **not** check relationships. Every negative probe below was "accepted" live.
- The check runs when the log is read: JSONL `finish()` calls `assertReleasedV4Relationships` (`P/dsh-session-persistence-jsonl/lib/index.js:1077`). It throws `SessionPersistenceCorruptionError: stored log is corrupt`, and the session can no longer be opened.
- Unknown event types fail even earlier, in `dsh-session-persistence`: "unknown to this harness and not marked ignorable; refusing to interpret the log" (`P/dsh-session-persistence/lib/index.js:184`).

### 2.2 The rules (`P/dsh-session-format-v3-to-v4/lib/index.js`)

| Rule | Code | Probe that breaks it → reload error |
|---|---|---|
| `turn/start` opens the next turn number; `turn/end` needs no open step | `:746-755` | `bad-step-left-open` → "turn/end does not match the open turn with no open step" |
| `step/start` is the next step of the open turn | `:758-761` | `stray-request-listener` → "step/start does not match the open turn and next step" |
| `assistant/message`, `tool/call` and `tool/result` must be inside the open step | `:571-573,623-627` | `bad-assistant-outside-step` → "assistant/message does not match an open turn and step" |
| A `tool/call` needs an earlier advertised `tool-call` block with the same id, an identical `name` and an identical `arguments` string; it may start only once | `:628-645` | `bad-57-unadvertised-tool-call` → "has no advertised tool lifecycle" (**this is issue #57**); `bad-args-mismatch` (name `bash` vs `Bash`) → "does not match one advertised tool call" |
| No ids are repeated across advertised blocks | `:630` | — |
| `step/end` and `turn/end` leave no unresolved call | `:576-579,762-767` | `bad-unresolved-call-at-step-end` → "step/end leaves unresolved tool call" |
| A `tool/result` message has `role:'tool'`, `source:{kind:'tool', callId}`, a matching `toolCallId` and array content; `error` only when `isError` | `:459-480` | — |
| Every message has a non-empty `source.kind` (any value except `plugin`) | `:122-136` | — |
| `assistant/message` needs `turn`, `step` and a `stream` array | `P/dsh-session/lib/index.js:1172` | `bad-no-stream` → "seed assistant/message … has invalid settlement fields" |
| `session/title` from a non-user source must cite earlier human `user/message` seqs | `:837-849` | — |
| Known types only, unless ignorable | `:989`; `P/dsh-session/lib/index.js:79-140` (the list of 60 known types) | `bad-unknown-event-type` (`claude/binding`) → "refusing to interpret the log" |

Allowed (the probe passed the live append, the v4 check and the reload):

- `reasoning` blocks.
- Two `assistant/message` events in one step.
- `user/message` between steps (steering).
- Extra keys in `message.source`, and an opaque `replayState` on `assistant/message` (`binding-in-native-fields`). Unknown source fields are kept ("Native source admission preserves unknown attribution", `:123`), and replay state stays opaque (`:169`).
- Extra `meta` on `tool/result` (`meta-in-tool-result`).
- `plugin:<name>/<path>` records written with `appendPluginRecord` (`plugin-record`). They are marked ignorable, fork and resume carry them, and they never reach the model surface (`P/dsh-session/lib/index.js:1244-1299`).
  - Caveat: DSH calls them "experimental", kept across format migrations only "on a best-effort basis", and allowed only from DSH's `packages/experimental/` inside its own repo (same lines).
  - So the Claude binding is better kept in native fields (`source` / `replayState`), with a plugin record at most as a second copy.

Not checked on load:

- That `content` equals the blocks rebuilt from `stream`. Probe `bad-stream-mismatch` reloads fine.
- Still build both from the same chunks, because the live UI and the stored log should agree. Use `AssistantStreamAccumulator` and `BlockAssembler` from `dsh-llm`, as the loop does through `AssistantStreamAttempt` (`P/dsh-agent-loop/lib/types/assistant-stream.d.ts:6-50`).

### 2.3 The sequence a driver writes (verified)

```
turn/start                                  (the loop)
agent/inbox/spliced                         (the loop: claim)
user/message  source.kind='user'            (the driver: the claimed human message, unchanged)
step/start {turn, step:n}                   (the driver, one per CLI model call)
  frame start → chunk… → assistant/message(+stream, usage) → frame end{committed seq}
  tool/call {callId, name, arguments}       (exactly as advertised)
  tool/result {message:{role:'tool', source:{kind:'tool',callId}, toolCallId, content}}
step/end
[agent/inbox/spliced + user/message]        (steering claimed between CLI steps)
turn/end                                    (the loop)
```

For an interrupt:

- The driver writes an `assistant/message` with `interrupted: true` and content from `interruptedBlocks()`.
- It writes a `tool/result` for each open call. Use the CLI's own result: after `interrupt()`, the CLI emits a `tool_result` for the running tool and a `result` with `error_during_execution` within about 10 ms (`interrupt-probe.mjs`, re-run on 2.1.318). Use `ToolCallRecovery.results()` (`TOOL_OUTCOME_UNKNOWN`) only if the CLI sends no result (`P/dsh-session/lib/types/repair.d.ts:42-62`).
- Then it writes `step/end` and returns. The loop writes `turn/end {kind:'aborted'}` (probes `interrupt`, `interrupt-text`).
- The CLI also emits a user text "[Request interrupted by user for tool use]". That is CLI text, not user text: do not write it as a `user/message`.

After a crash with an open turn, the loop's resume adds `interruptedTurnClosers` (`P/dsh-agent-loop/lib/index.js:1739`; `P/dsh-session/lib/types/repair.d.ts:63-73`), so the log stays loadable. Round 2 probed this (`r2.mjs host-crash-open-step`): see the Round 2 section.

### 2.4 Live streaming frames

- The event is `agent/assistant-stream`, with frames `start` / `chunk` / `end` (`P/dsh-agent/lib/types/runtime-types.d.ts:132-163`).
- The revision increases for each agent. `index` is dense within an attempt. `end` carries `outcome: committed {eventType, seq}` or `abandoned`.
- Order: emit `end` only after the durable `assistant/message` is appended.
- The session controller stamps `start` with `startedAfterSeq = session.seq - 1` (`P/dsh-api-session-controller/lib/index.js:1667-1677`). So emit `start` right after `step/start`, before any other append, so the client places the live block correctly.
- The loop never emits frames on the driver route (it makes no model call). The driver owns its own attempt ids and revision counter for each agent, as dsh-aio-agent does (`aio/lib/driver.js:209-220`).

## 3. Background work when no turn is open

- **The CLI acts on its own.** In streaming-input mode, after a turn's `result`, a finished background task produces `task_notification`, a new `system/init`, an `assistant` message and a second `result`, with no user input (`bg-probe.mjs`, re-run on 2.1.318: background `sleep 6`, second turn at +4 s).
- **Assistant output needs a turn.** `assistant/message` outside a step breaks the log (§2.2). Probe `wake-turn-for-background-output`:
  - `agent.followup(createUserMessage({source:{kind:'<ours>-wake', form:'notice', …}}))` opens turn 2.
  - The driver does not append the notice as a `user/message`. It writes the CLI's step, and the log is valid.
  - The notice is still stored in `agent/inbox/spliced.inserted`. It is log-only: off the model surface, and export does not show it because it is not `source.kind:'user'`.
  - `followup`, `steer`, `inject` and `send` are described in `P/dsh-agent/lib/types/runtime-types.d.ts:203-236`.
- **Events allowed outside a turn.** `job/registered` and `job/settled` (written by `dsh-jobs-local`), and a plain `user/message`, all reload fine (probe `events-outside-turn`).
- **Jobs.**
  - `ctx.jobs.start({kind, label, owner, run})` refuses to start a job unless a controller serves the owner (`P/dsh-jobs/lib/types/index.d.ts:29-50,71,145`). The Host `tool-jobs` controller serves every owner.
  - `kill()` maps to the SDK's `stopTask(taskId)`.
  - **Pitfall:** `tool-jobs` turns every settled job that nobody waited on into a model-facing completion notice. It uses `owner.followup()` when the agent is idle, else `owner.inject()` (`P/dsh-tool-jobs/lib/index.js:320-368`). That would wake our session with a synthetic message.
  - **Fix:** keep `ctx.jobs.wait(id, <long>)` pending for each job we start. `tool-jobs` skips settlements with `awaited: true` (`:366`). Probe `jobs-awaited.mjs`: no waiter → `awaited:false`; pending waiter → `awaited:true`.
- **Inbox filtering.** `inject()`ed context (from `tool-jobs` or `agent-instructions`) waits in the inbox and is claimed with the next user message (`runtime-types.d.ts:228-236`). The driver forwards only `source.kind === 'user'`.

## 4. How fork, export and search use the log

- **Fork** (`P/dsh-api-session-controller/lib/index.js:756-822`):
  - It runs `buildForkSeed(events, atSeq ?? latestCompletedPrefixBoundary)` and creates a new session with `seed`, `inheritedEventCount = boundary + 1` and `meta: {cwd, isSeeded:true, agentPreset}`.
  - It uses the same preset composition, so our driver is mounted in the child. **No `parentSession` is set.**
  - `agentOptions` take DSH's default model. The inherited `model/selection` events then decide the model.
  - A cut inside a turn gets synthetic closers. Probe `fork`, mid-turn at a `tool/call`: `session/end-seed`, `tool/result (TOOL_OUTCOME_UNKNOWN)`, `step/end`, `turn/end {kind:'forked'}`. A cut at a turn end gets only `session/end-seed`. Both children reload.
  - DSH has no in-place rewind, so "rewind" = fork at an earlier seq.
  - To give Claude the same memory, the child's driver reads the binding from the last inherited `assistant/message` (Claude session id plus message uuid). Then, on its first turn, it resumes with `forkSession: true` and `resumeSessionAt: <uuid>`. Detect a fork by `header.isSeeded`, plus a binding whose stored DSH session id differs from the current one.
- **Export** (`formatSessionMarkdown`, `P/dsh-session-log-export/lib/index.js:503-600`):
  - It keeps `user/message` only with `surfaceOp:'append'` and `source.kind === 'user'` (`:550-557`).
  - It keeps assistant text, `tool/call` (name and JSON arguments) and `tool/result`, folded into "N previous messages" (`:559-597`). Reasoning is not exported.
  - Probe `export-md.mjs` on the `tool`, `reasoning` and `wake` logs confirms all of this.
- **Search** (`extractSessionEventText`, `P/dsh-session-query/lib/index.js:546-584`; SQLite FTS5 in `P/dsh-session-query-sqlite/lib/index.js:106,779`):
  - Indexed: user text, assistant text, tool-call blocks and `tool/call` (name and arguments), tool results with error codes, todos, and turn errors.
  - Skipped: reasoning blocks and every other event type, including `plugin:` records.

## 5. Other facts for the design

- **External subagent children.** The v4 format has a `subagent/catalog` v2 entry with `mode: 'external'` (`P/dsh-subagent/lib/types/catalog.d.ts:19-34`). External rows are non-navigable leaves. Round 2 shows a better home: local one-shot child sessions written by our plugin (answer 8, Round 2 R2.1).
- **Subagent messages.** Claude subagent messages (`parent_tool_use_id` set) must not be written into the parent's step as parent assistant messages. A step is one assistant lifecycle, and their tool calls would need advertising in the parent.
- **Tool names are case sensitive.** A `tool/call` name must equal its block name exactly (`bash` vs `Bash` fails). DSH's own cards are keyed by DSH tool names. Mapping Claude tool names to DSH presenters is a UI question (dsh-ui-surfaces).
- **SDK detail.** Closing the SDK input after an interrupted `result` makes the SDK iterator throw "Claude Code returned an error result … stop_reason=tool_use" (`interrupt-probe.mjs`). The driver must treat that as expected (for sdk-surface).

## Open questions

1. Does dsh-aio-agent hit the `dsh-time-context` problem in a live web profile? Our guard makes the question moot for us. Round 2 ran the guarded driver in a full web profile: no DSH model request reached the catalog adapter in 20 turns.
2. Partly answered in round 2: the composer and the turn grouping render driver-written turns, steering inside a turn, and failed turns. The wake turn (`agent/inbox/spliced` notice) was still not seen in the browser.
3. Answered in round 2 (answer 8).
4. The token meter and context ring use `request/header` and model info. With no header, what do they show? (for auth-usage / dsh-ui-surfaces)
5. New: the clash names `/model`, `/export`, `/feedback` (and `/permission`) stay with DSH in our preset. To send Claude's own `/model …` or `/export` to the CLI, the plugin needs an agent-scoped Host command (writes `command/*`) or a client claim that cannot outrank `ui-commands` (registration order, `P/dsh-client-ui-input-trigger/lib/client.js:1280-1288`). A design choice.
6. New: a one-shot child is never resumed for prompts, but its header `agentPreset` decides what a cold resume would mount. Set it to our preset id and also append `agent-preset/selected` in the child (the probe left `standard` and the header label showed "Standard mode").
7. New: how much of a Claude subagent stream to write into the child, given that the SDK gives whole child messages and no child deltas (`sdk-surface`). Live child frames would then be one chunk per message (**unverified** visually).
8. New (Round 3): how to give Claude sessions a model picker that does not call DSH `session.selectModel` (which saves the DSH profile default). The options and what is still **unverified** are in Round 3 §R3.5.

---

## Round 2

Six questions from the completeness critic. Each answer gives its evidence. The answers above (8–14) summarize them for the design.

### R2.1 Claude subagents and workflow agents as DSH child sessions

**Yes. A plugin can create real, navigable DSH child sessions.**

How DSH's own local spawn records a child, which we copy:
- The child header gets `parentSession`, `origin: 'subagent'`, `delegationDepth`, `isSeeded`, `cwd` and `agentPreset` (`childSessionMeta`, `P/dsh-subagent/lib/index.js:345-358`). `ctx.agents.create` accepts exactly these `meta` fields plus `parentAgent` (`P/dsh-agent/lib/types/index.d.ts:49-72`).
- The child log starts with `subagent/descriptor` (version 3; `one-shot` needs only `provider` and an optional `label`; `P/dsh-subagent/lib/index.js:573-660`).
- The parent gets `subagent/catalog` v0 `{childId, childCreatedAt, mode, label}` (`establishCatalogChild`, `:816-825`). `establishCatalogChild` is not exported, so append the event directly.
- The task prompt enters the child as a `user/message` with `source: {kind: 'user'}`, as DSH does (`:1467`).

What we write (probe `r2.mjs child-session`, and `seams2-probe` live):
- Parent step: `assistant/message` with the advertised `Agent` call, `tool/call`, `subagent/catalog`, … `tool/result`, `step/end`.
- Child: `subagent/descriptor`, then a normal turn opened by `child.followup(task)`: `user/message`, `step/start`, `assistant/message` + `tool/call` + `tool/result` (`Bash`), `step/end`, a second step with text, `turn/end completed`.
- Result: parent and child pass the v4 check and reload. Child export keeps the child's tool call and result.

What the Web UI shows (live, port 8791, headless Chromium):
- The parent header shows "N subagents". The tree lists each child as "one-shot · completed", titled from its first prompt.
- Clicking a row opens the child conversation at `{parentSessionId, childSessionId, mode}`: the task prompt, the text, a collapsed tool card, and the footer "One-shot subagent record — One-shot tasks do not accept follow-ups". This matches `P/dsh-client-ui-subagent/README.md` ("Historical one-shot conversations open as read-only records").
- A running child opens live, with its running tool card ("Bash · ls /tmp | wc -l", "Running"). The parent row in the sidebar shows a spinner while a child runs.
- Branching the parent ("Branch into a new conversation") makes a fork with no subagent trigger. The fork log still contains the inherited `subagent/catalog` events, but the projection skips inherited facts (`P/dsh-subagent/lib/index.js:798`).

Notes for the design:
- Use `mode: 'one-shot'`. `continuable` would route child prompts through `subagents/prompt` and DSH's subagent runtime, which our driver does not own.
- The child's own pre-step listener does the writing. A driver mounted by preset on a cold-resumed child must do nothing (check `header.origin === 'subagent'`).
- Set the child's `agentPreset` to our preset and append `agent-preset/selected` (the probe passed the parent's header preset, `standard`, and the child header showed "Standard mode").
- Rule 8 holds: child tool calls are native events in the child session. No side store is needed.

### R2.2 Steer timing, and the composer's queue and steer

Composer to DSH (code and live):
- `session/prompt` maps `mode: 'steer'` to `agent.steer()` and everything else to `agent.followup()` (`P/dsh-api-session-controller/lib/index.js:857-858`).
- A queued item's "Steer" action removes it from `nextTurn` and calls `agent.steer()` while the turn runs (`:932,946-948`).
- Live: Enter while the turn runs queues (the composer shows "Edit / Remove / Steer queued message", and the textbox hint "Cmd/Ctrl+Enter steers all queued messages"). Ctrl+Enter steers.

DSH to the driver:
- The inbox emits `agent/inbox/inserted` for every inserted message (`P/dsh-agent-loop/lib/index.js:200`; declared agent-scoped at `P/dsh-agent/lib/types/runtime-types.d.ts:283-293`).
- Probe `r2.mjs steer-timing`: while the driver awaits a "running tool", `steer()` fires `inserted` synchronously with `nextStep: 1`, status `running`. `followup()` fires it with `nextTurn: 1`. The driver then claims the steer between steps (`agent/inbox/spliced` + `user/message`), and the log is valid.
- Live `seams2-probe`: a Ctrl+Enter steer during an 8 s tool arrived as `inserted {nextStep: 1, status: running}` and rendered inside the same turn ("Steer received: steer me now"). Two Enter-queued messages arrived as `nextStep: 0` and ran as two later turns after the re-wake.

Mapping to the SDK:
- DSH steer → on `inserted`, if the message is in `nextStep`, send it to the CLI now with `priority: 'next'`. The CLI folds it into its next request (`sdk-surface`). Write the `user/message` at the next step boundary. Do not use `'now'`: it aborts the CLI turn.
- DSH queue → keep it in DSH. Re-wake it after `turn/end` (answer 3). Plain SDK queueing is not needed.
- dsh-aio-agent instead aborts its ACP turn when a steer arrives (`aio/lib/driver.js:247-249`). With the SDK we do not need that.

### R2.3 Typed Claude slash commands, and DSH `/compact`

The path, from code:
- The input machine sends every draft that starts with `/` to adjudication (`P/dsh-client-ui-conversation/lib/client.js:5383-5390`).
- `ui-commands.matchEnter` resolves the name against the session's Host command directory. An unknown name returns `undefined` (`P/dsh-client-ui-commands/lib/client.js:1596-1598`).
- With no claim, `onAdjudicated` calls `send(attempt)`: the line goes to the default sink, `session.prompt()` (`P/dsh-client-ui-conversation/lib/client.js:5407`, `:4833`). The Host `prompt` has no slash check (`P/dsh-api-session-controller/lib/index.js:831-873`).
- So the `dsh-commands` README line "unknown commands are rejected" is not what the web composer does in 0.2.2-rc.1.

Live (`seams2-probe`, driver log): `/context`, `/compact`, `/review`, `/permissions`, `/my-plugin:do-thing arg1` and `/frontend-design:frontend-design make it blue` each arrived as one `user/message` with `source.kind: 'user'` and the exact text. The log has no `command/*` events. The API is therefore "do nothing": the composer's default sink already sends the line as a native user turn, and the driver forwards it as text (the SDK runs it as a slash command, `auth-usage` §7).

What DSH keeps:
- The `/` menu of a session in our preset lists only File, Feedback, Permission, Model and Export. These win over Claude's same-named commands (`/model`, `/export`, `/feedback`).
- DSH `/compact`, `/goal` and `/plan` are not listed in our preset's sessions. So `/compact` goes to Claude.

What DSH `/compact` would do if a profile mounts it for our sessions (`r2.mjs dsh-compact`, with `compaction-basic` + `command-compact`):
- `compactNow` needs no request header (`P/dsh-compaction-basic/lib/index.js:1002-1030`). It picks a range and calls `summarizeWithLlm`.
- The target is the configured `summarizationProvider`, else the latest request header, else the agent's own provider and model (`:292-303`). With no config it called our catalog adapter with `purpose: 'compaction'`.
- Our adapter threw. Result: `compaction/start`, `compaction/end`, `command/done {kind:'error', text:'Compaction could not produce a useful summary…'}`. The log stays valid.
- Hazard: if a profile sets `summarizationProvider`, DSH would send the transcript to that model and shadow DSH history, while the CLI's context stays unchanged. Our catalog adapter must keep refusing every request, and the design should make sure DSH compaction is not mounted for our sessions.

### R2.4 `tool-workflow/*` with no DSH workflow tool call

- The four types are only listed as known types (`P/dsh-session/lib/index.js:128-131`; `P/dsh-session-format-v3-to-v4/lib/index.js:1282-1285`). The v4 relationship check has no rule for them.
- The only writer is `dsh-tool-workflow`'s recorder, and it does not link them to a call id (`P/dsh-tool-workflow/lib/index.js:80-130`). Payloads: `run-start {runId, name}`, `agent-start {runId, seq, label, phase?, childId}`, `agent-end {runId, seq, outcome}`, `run-end {runId, stopReason}` (`P/dsh-tool-workflow/lib/types/types.d.ts:10-32`).
- Reader: `dsh-client-ui-workflow-run` folds events by `runId`, needs `run-start` first, and anchors the node at it (`P/dsh-client-ui-workflow-run/lib/client.js:718-760`). A run with no `run-end` shows "interrupted" only when its turn closed as `interrupted` or `forked` (`:658-662`).
- Probe `r2.mjs workflow-events`: run-start and agent-start inside the tool step, agent-end and run-end after the turn closed, and a second run with no end, outside any turn. v4 check ok, reload ok. A fork cut mid-turn keeps the workflow events and adds the usual closers (`turn/end forked`). Export and search skip these events (they are not in `formatSessionMarkdown` or `extractSessionEventText`).
- Live: the node "audit (Claude workflow) · 2 members · Running", phase "Read · Running 1", members "reader-a Running" (a link) and "reader-b Completed" rendered under the generic "Workflow" tool card. Clicking the running member opened its live child session.

### R2.5 Images and files

DSH side (code and live):
- Admitted prompt content is text, `{type:'image', attachment: ImageAttachmentRef}` and `{type:'file', attachment: FileAttachmentRef}` (`P/dsh-attachment/lib/types/types.d.ts:107-122`; `P/dsh-llm/lib/types/types.d.ts:68-90`). No bytes are in the event. `offloaded: true` on an image appears only after DSH image offload, which needs a DSH request (not our route).
- Live driver log for one prompt with a pasted image and a file: `[image {mediaType, width, height, bytes, name}, file {name, bytes}, text]`. `ctx.attachments.imageHostPath(ref)` gave a path with no file extension. `fileHostPath(ref)` gave `…/files/<xx>/<digest>/notes.txt`, which keeps the name.
- DSH's own model route turns a file into a hidden handle sentence ("verbatim read-only copy saved at …", `fileHandleText`, `P/dsh-llm/lib/index.js:614-620`). We must not copy that text: it is DSH prose, not the user's.

CLI side (`r2-sdk.mjs attach`, CLI 2.1.318):
- An SDK user message `[text, image(base64)]` works ("Red"). The CLI adds its own meta line `[Image: source: <its image cache path>]`, as the TUI does. TUI transcripts show the same `[text, image(base64)]` shape, with an `[Image #N]` placeholder in the text the user saw.
- `@/abs/path` and `@"/path with space"` in the text make the CLI attach the file itself: a `file` attachment in the transcript, **no tool call, and no `canUseTool` request**, even for a path outside the cwd. `@/path/red.png` attaches as an image.
- So: images → base64 image blocks from `ctx.attachments.readImage(ref)`; files → `@"<fileHostPath>"` added to the user's text, in the order of the parts. This is the TUI's own mechanism. **Unverified:** whether a user `permissions.deny` rule on the DSH attachment folder blocks the `@` read.

### R2.6 CLI killed mid-turn, and fork while the source is live

SDK (`r2-sdk.mjs crash`): SIGKILL of the `claude` process while a Bash tool ran.
- The iterator threw `Error: Claude Code process terminated by signal SIGKILL` within 30 ms. A later `interrupt()` rejected with "Query closed before response received".
- The running tool's process (`python3 … sleep`) was orphaned and kept running until it ended. Process-group cleanup is a design item.

DSH (`r2.mjs cli-died-*`, and live `probe:died`):
- If the driver rethrows with its step open, the loop writes `turn/end {kind:'error'}` while the step is open. The live append is accepted, but the log no longer opens: "turn/end does not match the open turn with no open step". The loop repairs only the steps it opened itself (`P/dsh-agent-loop/lib/index.js:766-785` vs `:807-829`).
- If the driver first writes repair results (`ToolCallRecovery.results()`), `step/end`, and ends its live frame with `outcome: abandoned`, the log reloads. The UI shows the partial text, "Called tools", and "This turn failed — Claude Code process terminated by signal SIGKILL — UNKNOWN".
- If DSH itself is killed mid-step (open step, unresolved call, open live frame; `r2.mjs host-crash-open-step` kills a child process), reopening appends `tool/result`, `step/end`, `turn/end {kind:'interrupted'}`, and the log passes the v4 check. The open frame is only live state, so it leaves nothing on disk.

Fork while live (`r2-sdk.mjs forklive`):
- The source ran `sleep 12` in a turn. Two forks started meanwhile: `resume + forkSession` at the tip, and with `resumeSessionAt` at the first assistant uuid. Both got new session ids and answered from the shared history ("PAPAYA").
- The source finished its turn normally, answered a later turn, and its transcript still parsed (49 lines, 0 bad).
- The tip fork lost the in-flight turn: its transcript has the user prompt, then a synthetic assistant "No response requested." So fork only at a completed assistant uuid, which is also what DSH's default fork boundary gives.

---

## Round 3

One question from the critic (§6.1 item 1, requirement R1.4): how the plugin's model catalog, the DSH model picker and the inherited `model/selection` events fit with "never pass `--model`", and with `setModel` for a per-session choice.

Probes (private scratch):
- `m1.mjs`: SDK probes on the user's CLI 2.1.318, from a clean env, in a scratch git repo whose `.claude/settings.local.json` sets `model: claude-sonnet-5-5` and `effortLevel: low` (this stands in for "the user's settings"). No `model` option is passed. Modes: `A` (controls, then one Haiku and one Sonnet turn), `H` + `R` (a Haiku session, then a resume), `S` (the `getSettings().sources` shape). Total cost about $0.05.
- `topup-model-probe`: a throwaway plugin (a catalog-only provider `tm` with rows "Your Claude settings" and "Haiku 5.5", plus a preset whose scripted driver logs `modelSelection`, `agent.model.current()`, `agent.options` and the session's `model/selection` events). Run in an isolated DSH web profile on a loopback port, from a clean env, and driven by headless Chromium. No DeepSeek credentials were set, so only our provider had models.

### R3.1 What DSH needs, and what a new session gets

- `preStep()` throws "has no provider/model" when `agent.model.current()` is undefined (`P/dsh-agent-loop/lib/index.js:671-672`). `current()` returns the latest recorded `model/selection` (pending, else last used), else `AgentOptions.provider/model` (`P/dsh-agent/lib/index.js:181-202`).
- A new session gets `AgentOptions` as live getters on the **DSH profile default** (`dsh-agent-default-model`), whatever the preset (`P/dsh-api-session-controller/lib/index.js:430-452`). An agent preset has no model field (`P/dsh-agent-preset/lib/types/index.d.ts`).
- Live: a fresh session in our preset passed `deepseek-official/deepseek-flash` to the driver, with no `model/selection` event. The composer showed "Select model", because that model was not in any loaded catalog.
- So any provider/model satisfies `preStep`. The driver must not read the DSH default as the user's choice.
- `preStep` also resolves tools and assembles the DSH system prompt with that selection (`:673-683`). Neither makes a model call. The guard (answer 3) drops the result.

### R3.2 What the DSH picker does

- The composer seat (`conversation.input.model`) and `/model` share one per-session directory. Both load the **global** catalog (`session.modelCatalog()`: every registered provider, `P/dsh-api-session-controller/lib/index.js:473-520`) and submit through `session.selectModel` (`P/dsh-client-ui-model-selection/lib/client.js:752,880,2043-2058`). The catalog is not filtered by preset. **Unverified** live: with DeepSeek credentials, DeepSeek groups would also show in a Claude session (code says yes), and our rows would show in Standard sessions.
- `selectModel` checks the model is listed, calls `llm.resolveCallConfig`, appends `model/selection` with `agent.model.select()`, **and saves the choice as the DSH profile default** (`agentDefaultModel.saveSelection`, `:704-721`). That edits the profile patch through the config editor (`P/dsh-agent-default-model/lib/index.js:53-65`). This is a DSH file, not a Claude settings file, so rule 2 is not broken. But it leaks the choice into every new DSH session.
- Live:
  - Picking "Haiku 5.5" wrote `model/selection {provider:'tm', model:'claude-haiku-5-5'}` in the session (no `reasoningEffort`), and added an `agent-default-model` entry with `provider: tm` to the profile patch. The next turn's driver saw `tm/claude-haiku-5-5`.
  - A new **Standard** session then showed "Haiku 5.5 · Default" in its composer. Its first prompt reached our adapter twice (`purpose: conversation` and `purpose: session-title`) and the turn failed with our adapter's error.
- `installModelSelection` (agent-scoped, `P/dsh-agent/lib/index.js:231-243`) adds a model-visible "[model changed: …]" user message when the route differs from the last `request/header`. Our driver writes no header, so `previous` is undefined and no notice is added. The guard would drop it anyway.
- Effort: our rows advertise `reasoning.efforts` with no `defaultEffort`. Then `resolveCallConfig` materializes nothing, the selection carries no effort, and the picker shows "Default" (live). The picker offers only advertised levels (README "No arbitrary effort input").
- Image admission reads `inputModalities` of the current model, and refuses images when it omits `image` (`P/dsh-api-session-controller/lib/index.js:844-849`). Every row we list must advertise `['text','image']`. With a foreign DSH default the check uses DeepSeek's metadata.

### R3.3 Fork, restart and driver-side selection

- `model/selection` is a known type with no v4 relationship rule (`P/dsh-session-format-v3-to-v4/lib/index.js:1260`; `P/dsh-session/lib/index.js:106`).
- Fork (`P/dsh-api-session-controller/lib/index.js:787-800`) creates the child with `agentOptions` = the **current DSH default**, plus the inherited prefix. Live:
  - Cut after the choice: the child inherited the `model/selection` event and the driver saw `tm/claude-haiku-5-5`.
  - Cut before the choice (turn 1), after another session had changed the DSH default: the child had no selection event, and the driver saw the new default `tm/settings`. So the parent's later choice is not carried, and an unrelated session's choice leaks in. This is correct only if "no event" means "settings default", which is the rule below.
- The driver may call `agent.model.select()` itself. Live: called inside a step, it appended `model/selection`. The picker then showed "current Your Claude settings". The profile patch was **unchanged** (`AgentModel.select` does not save the default). The log reloaded after a DSH restart, and the projection still held the selection.

### R3.4 What the CLI does (`m1.mjs`)

| Action (no `model` option at spawn) | Result |
|---|---|
| Spawn | `getStatus()` Model = the settings model (`claude-sonnet-5-5`). `getSettings().applied = {model, effort: 'low', …}`. `system/init` arrives only with a turn, so read the model from `getStatus()` / `getSettings()` before turn 1 (no model call). |
| `setModel('claude-haiku-5-5')` | Status shows Haiku. The next turn's `system/init.model`, assistant `model` and `modelUsage` key are Haiku. `getSettings().effective.model` stays the settings value. The settings file mtime is unchanged. |
| `setModel(undefined)`, `setModel('default')`, `applyFlagSettings({model: null})` | All switch to **Claude Code's default model** (here the `Default` row, a Bedrock inference profile = the account's Opus), **not** the settings model. Matches `SDK/sdk.d.ts:3044-3063` ("`model` to Claude Code's default model (not `ANTHROPIC_MODEL` or `settings.model`)"). |
| `applyFlagSettings({effortLevel: 'high'})`, then `{effortLevel: null}` | `applied.effort` high → **medium** (the model default), while the settings say `low`. Same doc lines. |
| Resume a session whose last turn ran on Haiku (no `model` option) | Status shows the settings model again. A per-session choice lives only in the process. |
| `getSettings().sources` | One entry per layer: `userSettings`, `localSettings`, …, and `flagSettings` once a flag is applied. `setModel` adds nothing there. |
| `initializationResult().models` | 9 rows on this account: `default` (resolves to the account default, here an inference-profile id), then concrete ids with `supportedEffortLevels`. The `default` row is Claude Code's default, not "your settings". |

### R3.5 Answers for R1.4

1. **Catalog.** Register one provider (for example `claude-code`) whose `stream()` refuses every request (as in answer 7). Rows: a first row "Your Claude settings" (id `settings`), then one row per `supportedModels()` entry (`value` as the id, `displayName` as the name, `supportedEffortLevels` as `reasoning.efforts`, no `defaultEffort`, `inputModalities: ['text','image']`). Read the list from a live session process; until one exists, list only `settings`. Do not start a probe process for it (rule 9). Do not add seed aliases (dsh-claude's mistake). Refresh with `llm/models-updated` when a session's `initializationResult()` arrives.
2. **Explicit choice.** The driver reads the session's own and inherited `model/selection` events (`session.snapshotEvents()`), not `agent.model.current()`. The latest event that names our provider is the choice. No such event, an event for another provider, or `model: 'settings'` → no `setModel` call. So a new session runs exactly the user's `model` / `effortLevel`, with no `--model` and no effort flag (R1.4 check).
3. **Applying it.** On a choice, call `setModel(value)`. On an effort, call `applyFlagSettings({effortLevel})` (session flag layer, no file write). Do it on the live process at once if idle, else before the next turn. Re-apply after every spawn (resume, fork, crash respawn), because a new process starts on the settings model.
4. **Reset.** For "Your Claude settings" or effort "Default", do not send `undefined`/`null`. Re-apply the spawn values captured from `getSettings().applied` right after spawn (before any control call), or respawn with `resume`. **Unverified:** behaviour if the user edits the settings file while the session runs (the captured value would be stale; a respawn picks up the new value).
5. **Display.** The "Your Claude settings" row can show the real model as a badge or through the `conversation.input.model.label` slot, from `getStatus()` / `getSettings().applied.model`. Shorten inference-profile ids before display (they can hold account ids; `auth-usage` §6).
6. **Avoid DSH `selectModel` for Claude choices.** It saves the DSH profile default and breaks new Standard sessions (R3.2). Options for the design:
   - (a) A plugin-owned picker in Claude sessions that calls a plugin Fetch route, which calls `agent.model.select()` (session-only, verified not to touch the default) and then `setModel`. Replacing the `conversation.input.model` seat shadows it in **every** session (single slot, `P/dsh-client-ui-renderer/lib/types/client/registry.d.ts:24-31`), and DSH's `ModelSelect` is not exported, so a per-preset replacement needs a way to fall back to the native seat. **Unverified**; this is the main open item. DSH's own `/model` would still call `selectModel` (it stays DSH's in our preset, answer 10).
   - (b) Keep the native picker and accept the default leak. Then our adapter must answer DSH requests in other sessions with a clear error. Not acceptable as is: Standard sessions break.
   - (c) Ask DSH upstream for a "session-only" selection flag on `selectModel`, or a preset-scoped default.
7. **Fork.** Because "no event" means "settings default", a fork cut before the choice correctly runs the settings model, whatever the DSH default is. A fork cut after it re-applies the inherited choice with `setModel` on the child's first spawn.
8. **Cost safety for tests.** Aliases may resolve to expensive models (`CLAUDE.md` §4). The probe confirms the `default` row and `setModel(undefined)` run the account default (here Opus), so tests must pick a concrete small model id.
