# Reference UX: how t3code shows and controls Claude Code

Phase 1 research note. Topic: which t3code UX patterns we should adopt in DSH, and which we must not copy.

**Versions.** t3code at commit `337c5858` (it pins Agent SDK `^0.3.316`). Our SDK is 0.3.318, which matches the user's CLI 2.1.318. DSH is 0.2.2-rc.1.

**Method.** A static read of t3code's Claude adapter, its contracts and its web UI. I checked SDK facts against the SDK types and checked a few strings in the CLI binary. I ran no live probes, so no `claude` processes were started and the cost was $0.

**Path aliases.**

| Alias | Meaning |
|---|---|
| `t3code/…` | A path in the t3code repo |
| `A2` | `t3code/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` (12,327 lines) |
| `web/…` | `t3code/apps/web/src/components/chat/…` |
| `SDK/…` | The installed `@anthropic-ai/claude-agent-sdk` 0.3.318 package |
| `P/…` | The installed DSH packages (`@deepseek-ai/*`) |
| CLI 2.1.318 binary | A string found in the user's `claude` executable |

**Unverified** marks anything I inferred but did not check.

---

## Answers for the design

1. **Workflow data comes from three places.** The `task_started` frame tags the task as a workflow (`task_type: "local_workflow"`, `workflow_name`). The Workflow tool result is the only frame that holds `runId`, `transcriptDir` and `scriptPath`. Each `task_progress` frame holds a **full snapshot** in the undeclared `workflow_progress` array of phases and agents. Progress frames carry no `task_type`, so you must remember the tag from `task_started` (`t3code/…/claudeWorkflowProgress.ts:85-96,118`; `A2:9465-9484`).
2. **Merge each snapshot by agent index.** Map the CLI states `queued/start/done/error` to `queued/running/completed/failed`. Treat any unknown state as running. Keep only the newest `attempt`, and never let a settled agent go back to running (`claudeWorkflowProgress.ts:19-24,51-83,119-181`). We can reuse this logic almost as it is.
3. **Live workflow-agent output is not in the SDK stream.** t3code tails `<transcriptDir>/agent-<agentId>.jsonl`. It reads only regular files under `<config>/projects`, caps each read at 512 KiB, and waits 500 ms after an agent settles for the last transcript flush. It falls back to `resultPreview` ("Partial answer from workflow progress") (`t3code/apps/server/src/orchestration-v2/workflowAgentTranscript.ts:14-87`; `workflowFileRead.ts:15-65`; `A2:345,6298-6610`).
4. **The only workflow stop is "stop the whole run"** (`stopTask(taskId)`). There is no per-agent stop in t3code or the SDK (`web/ThreadLineageWorkflowRow.tsx:151-176`; `A2:11917-11945`).
5. **Subagent routing:** `task_started.tool_use_id` gives the task id, and `parent_tool_use_id` on later frames points back to it. Nesting is `spawn_depth > 1` (`A2:8716-8722,8762-8775`). t3code does **not** set `forwardSubagentText`. The SDK says that by default only the child's `tool_use`/`tool_result` blocks are sent (`SDK/sdk.d.ts:1941-1946`). So t3code child threads show tools live, but not prose. We should set `forwardSubagentText: true`. It changes only what the CLI streams to us (**unverified** that it changes nothing the model sees).
6. **Per-subagent stop** is `stopTask(taskId)`. t3code then waits up to 2 s for the CLI's own `task_notification` before it shows "stopped" (`A2:11981-12040`; `web/ThreadRelationshipsControl.tsx:890-912`).
7. **Background work keeps the session free.** The `background_tasks_changed` frame is a full "replace" list. t3code reads only its `local_bash` entries (commands and Monitors). Subagents and workflows come from the task lifecycle frames. The list is updated even when no turn is open (`A2:3165-3169,8611-8660`).
8. **Completions: copy t3code's continuation turn.** When a background task ends, the CLI starts its own reaction turn. t3code spots these frames when no app turn is open. It then opens a "continuation" turn that sends **no prompt** and only drains the CLI's output (`A2:8540-8590,10743-10750,3980-3984`). This is the raw-safe way to deliver background results.
9. **Do not copy t3code's Stop.** t3code calls `interrupt()` and then `close()`, which ends the CLI process (`A2:11419-11420`). It never sets `perTaskStopAffordance`. Its docs say "Stop on a thread also stops the subagents it delegated to" (`t3code/docs/user/thread-sidebar.md:270`). Our rule 6 needs `interrupt()` only, with `perTaskStopAffordance: true` (`SDK/sdk.d.ts:1866-1884`). The "Stopping… / Force stop after 10 s" banner is still a good UI idea (`web/ThreadActivityBanners.tsx:115-153`).
10. **Approvals belong to the tool card.** The approval's parent is the tool call node, keyed by `toolUseID`. A child's approval also shows in the parent as "Approval needed from <child title>" (`A2:10216-10470`; `web/ChildThreadApprovals.tsx:15-76`). t3code offers Decline, Approve and "Always allow this session". The last one **rewrites every CLI suggestion to `destination: "session"`** (`A2:3778-3797`). We should show the CLI's own suggestions with their real destinations. That is allowed by the charter (the CLI writes the rule, as the TUI does). Note that DSH's native approval has only a one-shot grant: "`'allowed-once'` is the only grant" (`P/dsh-user-approval/lib/types/index.d.ts:134`).
11. **Questions, plans, MCP.** t3code parses AskUserQuestion `multiSelect` and `preview`, but its web panel never draws previews (`A2:4573-4620`; no "preview" in `web/ComposerPendingUserInputPanel.tsx`). For plans, it **always denies `ExitPlanMode` with its own sentence**, which the model reads (`A2:10342-10360`). MCP elicitations are consent-only, and URL mode is declined (`A2:3851-3880,10484-10502`). We must not copy any of these three.
12. **Usage.** Context = `input + cache_read + cache_creation` of the last call, against the model's window, with a tick at the auto-compact point (`A2:266-310`; `web/ThreadDetailsUsage.tsx:86-139`). Per-turn growth comes from the delta of the `result.modelUsage` ledger (`A2:10987-11000`). Plan limits come from `rate_limit_event` plus the experimental `get_usage` control. They show as "Session" and "Weekly" rows with % left, reset time and pace. Accounts with no plan limits (API key, Bedrock) get the text "This account has no subscription limits." (`t3code/apps/server/src/provider/claudeUsageLimits.ts:22-30,155-215`; `t3code/packages/shared/src/usageLimits.ts:617-666`). t3code **ignores `total_cost_usd`**. Instead it prices transcripts with its own price table. We should show the CLI's numbers.
13. **Live switches.** For model and effort, t3code calls `setModel`, then `applyFlagSettings({effortLevel, fastMode, ultracode: value ?? null})`. "Ultracode" is an effort level that sends `xhigh` plus `ultracode: true`, and sends `null` to clear it (`A2:1676-1684,10764-10778`; `t3code/apps/server/src/claudeModelOptions.ts:47`). A permission-mode change **respawns the CLI** (`supportsRuntimeModeSwitchInSession: false`, `A2:403`). We should use `setPermissionMode` instead.
14. **Env and binary.** t3code strips 12 host-session variables (`t3code/apps/server/src/provider/Drivers/ClaudeHome.ts:48-63`). It also forces `CLAUDE_CODE_ENTRYPOINT=t3-code` (`:74-77`), which we should not copy. It removes all 8 SDK platform packages with pnpm overrides (`t3code/pnpm-workspace.yaml:138-146`). It passes the user's `claude` as `pathToClaudeCodeExecutable` (`A2:1876-1878`).
15. **Raw-contract breaks we must not copy.** System-prompt append, the `t3-code` MCP server, a `SubagentStart` hook that adds context, forced thinking summaries, a forced model and permission mode, an `Ultrathink:` message prefix, model-facing deny texts, restart "continue" prompts, side-chat digests, extra `claude` processes for probes and titles, telemetry on by default, and closing the process on Stop, fork and rewind. Details are in §11.

---

## 1. t3code in one paragraph

t3code runs one long-lived SDK `query()` per thread, in streaming-input mode. It always uses the user's binary (`A2:1876-1878`). It sets `includePartialMessages: true` (`A2:1843`). It does not set `settingSources` on the main query, and the SDK default is "all sources are loaded (matches CLI defaults)" (`SDK/sdk.d.ts:2357`). It assigns the Claude session id itself, so the mapping from thread to Claude session is known before `init` arrives. It passes `sessionId` on first start and `resume` after that (`A2:1803-1805`; `SDK/sdk.d.ts:2170-2184`). All Claude-specific code is in `A2`, behind a provider-adapter interface that more than 10 CLIs share.

To learn what the user's settings allow (for example whether bypass mode is available), t3code calls the SDK's read-only `resolveClaudeSettings({cwd, settingSources: ["user","project","local"]})` instead of parsing files itself (`A2:4885-4900,4929`). This is a raw-safe way for us to read the user's `defaultMode` and other defaults (R1.4) without writing any settings file.

---

## 2. Dynamic workflows

### 2.1 What the CLI sends, and how t3code reads it

| Step | Frame | What t3code takes | Evidence |
|---|---|---|---|
| Launch | `system/task_started` with `task_type: "local_workflow"` | It tags the task as a workflow and keeps `workflow_name` and `prompt`. t3code shows that prompt as the workflow script (`subagentRuntime.ts:298-316`) | `A2:9465-9484` |
| Launch ACK | `user` `tool_result` for `Workflow`, whose `tool_use_result` has `taskType: "local_workflow"` | `runId`, `transcriptDir`, `scriptPath`. This is the **only** frame with these handles | `claudeWorkflowProgress.ts:85-96`; `A2:9682-9691` |
| Progress | `system/task_progress` with a `workflow_progress` array | Phases `{type:"workflow_phase", index, title}` and agents `{type:"workflow_agent", index, label, state, agentId, phaseIndex, phaseTitle, model, attempt, tokens, toolCalls, durationMs, queuedAt, startedAt, lastProgressAt, promptPreview, resultPreview}`. It also reads the run totals from `usage` (`total_tokens`, `tool_uses`, `duration_ms`) | `claudeWorkflowProgress.ts:45-83,98-116,177-179`; test fixture `claudeWorkflowProgress.test.ts:5-27`; CLI 2.1.318 binary: `workflow_progress:e.workflowProgress` |
| Progress with no turn | the same frames, arriving after the turn's `result` | Applied to the stored workflow anyway | `A2:8354-8400` |
| End | `system/task_notification` | It settles the run | `A2:9536-9560` |

**Merge rules** (`claudeWorkflowProgress.ts:119-181`):
- Phases and agents are keyed by `index`. A new snapshot overwrites by key, and the result is sorted by index.
- A lower `attempt` than the stored one is ignored. A higher `attempt` is a restart: the old phase fields are kept and the rest is replaced.
- A "regression" is ignored: a settled agent that moves to another state, or a running agent that moves back to queued. In that case the stored values win.
- An unknown state (even `"toString"` or `"__proto__"`) counts as running, never as settled (test at `claudeWorkflowProgress.test.ts:77-90`).
- `completedAt` is set from `lastProgressAt`, but only for completed or failed agents.

### 2.2 Data model

| Level | Fields | Evidence |
|---|---|---|
| Run (`OrchestrationV2SubagentWorkflow`) | `name`, `runHandles {runId, transcriptDir, scriptPath}`, `phases[]`, `agents[]`, `totalTokens`, `toolCalls`, `durationMs` | `t3code/packages/contracts/src/orchestrationV2.ts:802-848` |
| Phase | `index`, `title`. The comment says "Append-only: phases discovered at runtime join when they start" | `orchestrationV2.ts:801-806` |
| Agent | `index`, `label`, `agentId`, `childThreadId`, `state` (`queued/running/completed/failed`), `phaseIndex`, `phaseTitle`, `model`, `effort`, `speed`, `attempt`, `totalTokens`, `toolCalls`, `durationMs`, `queuedAt`, `startedAt`, `completedAt`, `prompt`, `result` | `orchestrationV2.ts:809-830` |
| Run node | The workflow is a `subagent` record with a `workflow` field, so it shares the subagent's status, stop and child-thread plumbing | `orchestrationV2.ts:884-923` |
| UI grouping | Phases are the union of declared phases and the phases the agents name. A phase with no agents yet is `pending`. A phase is `running` if any agent is active, otherwise `done`. `settledCount` counts agents in a final state | `t3code/packages/client-runtime/src/state/subagentRuntime.ts:238-296` |

### 2.3 UI

| Element | What the user sees | Evidence |
|---|---|---|
| Workflow row (in the thread's related-threads panel) | Title = `workflow_name`, else the description. A chevron expands it. A hover-only square button with the tooltip **"Stop entire workflow"** shows a spinner while stopping | `web/ThreadLineageWorkflowRow.tsx:118-194` |
| Phase sections | A collapsible header per phase with **"settled/total agents"** and elapsed time (from the first start to the last end). A "Failed" tag shows if any agent failed. Running phases are open by default | `web/ThreadLineageWorkflowRow.tsx:24-49,195-243` |
| Agent rows | Status icon, label, live elapsed time. Click opens the agent's child thread. The hover card shows model, effort, speed, elapsed, status and a result or progress preview | `web/ThreadLineageWorkflowRow.tsx:51-116`; `web/SubagentTooltipContent.tsx:33-140` |
| Opening block (in the coordinator's child thread) | "Workflow started", the title, the description, and a live count like "3 agents · 1 working · 2 done". The script is shown folded, as a JavaScript code block | `web/WorkflowOpeningBlock.tsx:29-80`; `subagentRuntime.ts:383-425` |
| Script detection | The coordinator's first user message is the script. The server marks it, and old threads fall back to the regex `export const meta` | `subagentRuntime.ts:298-316` |
| Agent child threads | Read-only. Each starts with the agent's prompt as a "user" message. Its transcript lines are then projected as assistant text, thinking and tool calls | `A2:6236-6248,6298-6610` |

**Gap in t3code:** the data model has per-agent `totalTokens` and `toolCalls`, but no chat component draws them. A grep for `totalTokens` in `t3code/apps/web/src` finds only the Usage page. The TUI's `/workflows` view does show tokens per agent. Our R6.5 needs "agents with status and tokens", so we must go further than t3code here.

### 2.4 Live member output (transcript tail)

- "Workflow members appear only in transcripts, not provider events" (`workflowAgentTranscript.ts:2`).
- The file is `<transcriptDir>/agent-<agentId>.jsonl`. `agentId` must match `^[A-Za-z0-9_-]{1,128}$` (`workflowAgentTranscript.ts:16,61-68`).
- It keeps only `assistant` and `user` lines that have a `uuid`, and it skips `isMeta` lines (`:41-51`).
- Reads are capped at 512 KiB and resume from a byte cursor. The cursor resets if the file shrinks or its inode changes (`:14`; `workflowFileRead.ts:26-30`).
- **Containment:** the real path must sit under `realpath(<CLAUDE_CONFIG_DIR or ~/.claude>/projects)`, must have the expected extension, and must be a regular file. It also checks for inode swaps (`workflowFileRead.ts:15-17,32-80`). This fits our R10.1 rule "no arbitrary file reads".
- A running agent is re-read on each progress frame. A settled agent is read up to 3 more times. After the run ends, it waits out the 500 ms flush window ("Claude Code flushes transcript writes every 100 ms") (`A2:341-345,6352-6358,6555-6566`).

### 2.5 Stop and ultracode

- **"Stop entire workflow"** goes from the web to `ThreadManagementService.stopWorkflow` and then to the adapter's `stopTask`. The adapter accepts only a running workflow task in this thread from the live process (`t3code/apps/server/src/orchestration-v2/ThreadManagementService.ts:1261-1345`; `A2:11917-11945`).
- **When a turn ends as anything but "completed"**, t3code calls `stopTask` on every running workflow that the turn's run started, and marks them cancelled (`A2:7911-7930`). The TUI does not do this: Esc leaves a workflow running (Claude Code workflows doc). **Do not copy.**
- **Ultracode** is an effort level in the model catalog that maps to `xhigh` effort plus `ultracode: true` (`claudeModelOptions.ts:47`; `t3code/apps/server/src/provider/model-manifest.json:213`). A live switch always sends `ultracode: selection.settings.ultracode ?? null`, so switching away clears it (`A2:1676-1684`).
- t3code never stamps `origin: {kind: "human"}` on user messages (grep: 0 hits in `A2`). The docs say the `ultracode` keyword in a prompt works only for human-stamped SDK input, so the keyword probably does nothing in t3code (**unverified**). The SDK has the type (`SDK/sdk.d.ts:5649-5650`).

---

## 3. Subagents and child threads

| Topic | What t3code does | Evidence |
|---|---|---|
| Registering a subagent | On `task_started` it links `tool_use_id` to `task_id`, finds the owner (for nested agents), and inherits the owner's model when no model is given | `A2:9430-9487` |
| Nesting | `spawn_depth > 1` marks a nested task. Nested tasks are not counted as top-level background work | `A2:8762-8775,9450-9457` |
| Child frames | `parent_tool_use_id` leads to the task id and then to the child thread. Child thinking and text go to the child thread, not the parent | `A2:8716-8722,9793-9830` |
| Child prose | `forwardSubagentText` is not set (grep: 0 hits in `apps/` and `packages/`). The SDK default sends only child `tool_use`/`tool_result` blocks, "enough for a heartbeat counter" (`SDK/sdk.d.ts:1941-1946`). So a normal subagent's child thread gets its tool calls live and its prose only from the final result. Workflow agents get full prose from the transcript tail | as cited |
| Parent view | A subagent row in the parent timeline links to the child thread, with an avatar, status and elapsed time. A "Finished / Failed / Stopped" notice row shows when a background child settles | `web/V2LifecycleRow.tsx:147-160,336-395,396-504` |
| Agents panel | Related threads show parents, subagents, side chats and forks. Each running subagent row has a **"Stop subagent"** button | `web/ThreadRelationshipsControl.tsx:636-650,693-705,890-912` |
| Grandchildren | A read-only "Subagent work" dialog lists what a native subagent's own children did. Its subtitle: "Read only. These subagents cannot take messages." | `web/NativeChildWorkDialog.tsx:29-50` |
| Per-child stop | `stopTask(taskId)`, then a wait of up to 2 s for the CLI's own outcome (`task_notification`). It fails if the task is from an earlier process | `A2:11981-12040` |
| Approvals from a child | The approval node hangs under the child's tool call (keyed by `toolUseID`). The parent shows a card: "Approval needed from {child title}", with the same buttons. The "Subagent waiting" banner offers "Open approval" | `A2:10216-10470` (approval artifacts are keyed by `nativeItemId = toolUseID`); `web/ChildThreadApprovals.tsx:15-76`; `web/ThreadActivityBanners.tsx:34-72`; `t3code/docs/user/permission-modes.md:23-25` |
| Feedback to a child | "type a text reply to decline that request and give feedback directly to the agent that asked, including a subagent" | `permission-modes.md:51-52` |
| Messaging a child | Not possible: "Subagent threads started by the agent can't take messages" | `t3code/docs/user/thread-sidebar.md:272-274` |
| Agent teams | No roster. `SendMessage` is a generic tool | `A2:3062` |
| Custom agents | Loaded by the CLI, but there is no list or picker (no `supportedAgents`) | grep: 0 hits |

Note: t3code does not read the SDK's `agentID` option in `canUseTool` (`SDK/sdk.d.ts:296`). It finds the asking child through the tool-call tree instead. Both work, but `agentID` is simpler and covers asks that have no visible tool card (**unverified**).

---

## 4. Background tasks, the free session, and completions

**How the session stays free.**
- When the root turn's `result` arrives, the app turn ends. Background tasks stay in a per-thread "pending background tasks" list (`A2:5145-5165`).
- `background_tasks_changed` is a "replace" level. t3code keeps only `local_bash` entries (as `command`, or `monitor` when a Monitor tool started them). Subagents and workflows come from their lifecycle frames, because "background_tasks_changed can include subagents already counted by their lifecycle" (`A2:3165-3207,3237-3260,8611-8660`).
- The list is updated even with no active turn; the thread status is then `idle` (`A2:8592-8609`).
- Threads that wait on such work move to a folded **"Working"** sidebar section. "A dev server or other process an agent leaves running does not keep a thread there" (`t3code/docs/user/thread-sidebar.md:134-140`).
- The end of the timeline shows a banner such as "Running · <command or label>", with the latest activity line, a ticking elapsed time, "Open" (for one child) and "Stop" (`web/ThreadActivityBanners.tsx:156-246`). Its Stop calls `interruptThreadTurn`, which closes the process (`web/useThreadLifecycle.tsx:419-450`). We need `stopTask` per task instead.

**How completions arrive (the pattern to copy).**
- When a background task ends, the CLI sends `task_notification` and then **starts its own turn** to react. No app turn is open at that point.
- t3code buffers these "wake" frames. When it sees a root-level frame or a `result` with no app turn open, it offers a **continuation request** (`A2:8540-8590`).
- The orchestrator opens a turn marked `createdBy: "agent"`, `creationSource: "provider"` (`A2:3980-3984`). For that turn, the adapter sends **no prompt**: "Continuations drain existing output without prompting" (`A2:10743-10750`). The prompt uuid is `null` (`A2:11048-11050`).
- A guard: if the CLI never starts the wake turn within 2 minutes, the wait is dropped (`A2:339-341,11328-11345`).
- The `t3_background_wait` tool and the "Background work you wait on" system-prompt text are t3code additions (`A2:1733-1740`). We do not need them.

**After a restart (do not copy).** When t3code restarts, it can send a message such as "Note: the T3 server restarted, and this background work was cancelled… resume or restart what you still need" plus a "continue" prompt (`t3code/apps/server/src/orchestration-v2/RestartBackgroundNote.ts:126-133`; `RestartContinuation.ts:300-330`; `t3code/docs/user/updating.md:66-81`). That is prompt injection. We should show a UI notice only.

**Process replacement guard (copy).** t3code refuses to replace a process that still runs background work: "Replacing this thread's process kills its background work" (`A2:10808-10817`).

**Live Bash output.** t3code tails Claude's private task-output files every 250 ms. It notes "The private Claude layout can change" and that this does not work on Windows (`t3code/apps/server/src/orchestration-v2/Adapters/ClaudeTaskOutputTail.ts:7-30`). SDK 0.3.318 has a `get_task_output` control request (`SDK/sdk.d.ts:4396-4410`), which is a better source (**unverified** for live use).

---

## 5. Interrupt, stop and steer

| Action | t3code | Raw contract | Evidence |
|---|---|---|---|
| Stop (turn) | `interrupt()`, then `close()`. It waits up to 10 s for the process to exit. After that, the banner reads "Agent not responding to Stop" with **Force stop** | ❌ It kills the process and all background work | `A2:349-350,11378-11450`; `web/ThreadActivityBanners.tsx:115-153` |
| `perTaskStopAffordance` | Never set | ❌ Without it, "an interrupt kills background tasks" | grep: 0 hits; `SDK/sdk.d.ts:1866-1884` |
| Stop (background banner) | `interruptThreadTurn`, which closes the process | ❌ | `web/useThreadLifecycle.tsx:419-450` |
| Stop one subagent | `stopTask` plus a wait for the outcome | ✅ | `A2:11981-12040` |
| Stop one workflow | `stopTask` | ✅ | `A2:11917-11945` |
| Steer | `priority: "now"`. Before sending, it moves foreground subagents to the background with `backgroundTasks(toolUseId)` and waits up to 5 s. This matches the TUI, where a message sent mid-turn moves running subagents to the background | ✅ | `A2:345-347,11457-11500,11554` |
| Queue or steer | A per-client setting. The opposite action is on `Cmd/Ctrl+Enter`. Queued messages can be edited | ✅ (R3.4) | `t3code/docs/user/composer.md:63-79` |

Our design: Stop calls `interrupt()` only. `perTaskStopAffordance: true` is set at start. A separate, explicit "Force stop" kills the process only when the user asks.

---

## 6. Fork, rewind (rollback) and resume

| Feature | t3code | Adopt? | Evidence |
|---|---|---|---|
| Resume | `resume: <id>` after the first turn, and `sessionId: <id>` on first start | ✅ | `A2:1803-1805` |
| Fork (from any turn) | SDK `forkSession(sessionId, {dir, upToMessageId})`, run in a small worker process. That worker runs Node, not `claude`. The SDK copies the transcript with new uuids and does not copy undo history | ✅ the call. ❌ the source close | `A2:12176-12199`; `t3code/apps/server/src/claudeHistoryWorker.ts:15-35`; `SDK/sdk.d.ts:859-872` |
| Fork closes the source | `closeLiveQueryForNativeThread(sourceNativeThreadId)` before forking | ❌ This kills the source session's background work. Check whether `forkSession` works while the source process is live (**unverified**) | `A2:12187` |
| Rewind ("Edit from here") | It closes the live process, then the next turn starts with `resumeSessionAt: <message uuid>`. Files come back through t3code's own git checkpoints, and only in worktree threads | ✅ `resumeSessionAt`. ⚠️ Closing is needed here (the history changes), but only if no background work runs | `A2:12101-12160`; `t3code/docs/user/composer.md:159-174` |
| Rewind files | Not Claude's `rewindFiles`/`enableFileCheckpointing` | Open: the CLI's own file checkpoints are more raw | grep: 0 hits |
| Fork from a subagent | Not supported | — | `A2:412` |

---

## 7. Approvals, questions, plan mode, MCP elicitation, dialogs

### 7.1 Tool approvals

| Aspect | t3code | Evidence |
|---|---|---|
| Buttons | Default set: Cancel, Decline, **Always allow this session**, Approve. Decline and Approve are primary; the rest sit in a "more" menu | `web/ComposerPendingApprovalActions.tsx:26-47` |
| No standing grant | When the CLI sets `suppressAlwaysAllowRule`, only Decline and Approve show | `A2:3696-3733`; `SDK/sdk.d.ts:287-290` |
| "Always allow" mapping | `updatedPermissions` = the CLI's `suggestions`, with **every `destination` forced to `"session"`**. With no suggestions, it adds `{addRules, toolName, allow, session}` | `A2:3735-3797` |
| Cancel | Deny plus `interrupt: true` | `A2:3762-3775` |
| Reject with feedback | A typed reply becomes the deny `message` | `A2:3762-3770`; `permission-modes.md:51-52` |
| Approval text | The command if present, else the CLI's `title`, `description`, `decisionReason`, or a summary of the tool call. The reason line strips terminal escapes | `A2:10403-10413,3713-3716` |
| Card | A row in the timeline under the tool call. The command or file is in a monospace block, then the reason, "Waiting for approval", and the buttons. If the process is gone: "Provider process is gone. Interrupt or restart the run to respond." | `web/TimelinePendingApprovalRow.tsx:15-121` |
| Diff preview | The approval row does not draw a diff. The file-change tool card has one (`diffStr`). Whether that card shows before approval is **unverified** | `t3code/apps/web/src/lib/toolCallDiff.ts:1-40` |
| Fields not used | `defaultToNo`, `blockedPath`, `displayName`, `agentID` (0 to 1 hits each) | grep `A2`; `SDK/sdk.d.ts:240-318` |
| An ask with no open turn | Denied: "Claude V2 adapter has no active turn for this tool request." | `A2:10220-10228` |
| Bypass-mode rm check | Denied with a long t3code paragraph to the model | `A2:10388-10401` |

What we adopt: attach approvals to the tool card by `toolUseID`. Name the asking subagent (use `agentID`). Honour `suppressAlwaysAllowRule` and `defaultToNo`. Show `title`, `description` and `blockedPath`. Offer the CLI's own suggestions **unchanged** as "always allow" choices. Allow reject with feedback. Never deny an ask only because no DSH turn is open: a background subagent can ask at any time (rule 7).

### 7.2 AskUserQuestion

- The server reads `header`, `question`, `options[{label, description, preview}]` and `multiSelect` (`A2:4573-4620`). Answers go back as `updatedInput: {questions, answers}` (`A2:10272-10340`).
- The web panel supports single and multi select and a free-text answer (`web/ComposerPendingUserInputPanel.tsx:99-132,287`). It **never draws `preview`** (grep: 0 hits).
- The preview format is a tool-config option. Changing it to `html` changes "what the model is instructed to emit" (`SDK/sdk.d.ts:10286-10301`). To stay raw, keep the default (Markdown) and render Markdown previews.

### 7.3 Plan mode

- Plan mode is a hidden legacy setting, off by default (`t3code/packages/contracts/src/settings.ts:468`).
- `ExitPlanMode` is **always denied** with "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn." (`A2:10342-10360`). The plan shows as a card with Copy and Download (`web/ProposedPlanCard.tsx:64-180`).
- "Implement" sends a new user message "PLEASE IMPLEMENT THIS PLAN:\n<plan>" (`t3code/apps/web/src/proposedPlan.ts:54-58`).
- After a denied `ExitPlanMode`, the next turn calls `setPermissionMode` to restore the mode it had before plan (`A2:10788-10800`).
- **Do not copy.** Raw: approve `ExitPlanMode` (with the user's choice of next mode), or deny it with the user's own feedback. Track `status.permissionMode` so the picker matches the CLI. t3code does read it (`A2:10981-10986`).

### 7.4 MCP elicitation and dialogs

- **Elicitation:** form mode only. The card collects consent only, and any schema defaults are removed. The answer is "accept" only when the form can be accepted with no typed fields; otherwise it is "decline". URL mode is always declined (`A2:3816-3880,10484-10520`). **Do not copy.** R5.5 needs real forms and auth URLs.
- **User dialogs:** t3code declares `supportedDialogKinds: ["resume_return"]` and shows the CLI's "resume an old session: compact or keep" dialog as a question (`A2:10603-10660,10889`). The SDK says the CLI sends only the dialog kinds that the host declares (`SDK/sdk.d.ts:1831-1864`). This is the CLI's own dialog, so we could support it in a raw way. Which kinds exist in 2.1.318 is an open question.

---

## 8. Usage, context and limits

| Item | t3code | Adopt? | Evidence |
|---|---|---|---|
| Context used | `input_tokens + cache_creation + cache_read` of the latest call (stream `message_start`/`message_delta`), plus output | ⚠️ Prefer `getContextUsage()` for the categories (R8.2). Use this as the live value between calls | `A2:266-310,5386-5437` |
| Context window | From the model catalog, updated from `result.modelUsage[*].contextWindow` | ✅ | `A2:5395,10994-11000` |
| Auto-compact tick | A tick on the bar at the auto-compact point. t3code assumes the CLI compacts 33,000 tokens before the window ("Claude Code 2.1.305's getContextUsage reports a 150,000 window as a 117,000 threshold") | ✅ the tick. Take the point from `getContextUsage()`, not a constant | `A2:254-264`; `web/ThreadDetailsUsage.tsx:86-139` |
| Prompt-cache expiry | From `cache_creation.ephemeral_1h/5m_input_tokens`, counted from the request start | ✅ a nice extra | `A2:244-252,290-296` |
| Per-turn and subagent tokens | The delta of the `result.modelUsage` ledger between turns. This includes helper models (for example a Haiku model used for web search, seen in a t3code test fixture) | ✅ | `A2:10987-10993` |
| Cost | Its own "API-equivalent" estimate from transcripts. "These estimates are not your subscription bill" | ❌ Show `total_cost_usd` and `modelUsage[*].costUSD` from the CLI (rule 11) | `t3code/docs/user/usage.md:9-13`; grep `total_cost_usd` in `apps/server/src` (non-test): 0 hits |
| Plan limits | `rate_limit_event` (`five_hour`, `seven_day`, `seven_day_overage_included`) live, plus `get_usage` for the first value, the per-model weekly limits and the monthly spend | ✅ | `claudeUsageLimits.ts:22-30,155-215`; `A2:8776-8790` |
| Limit display | Rows "Session" and "Weekly": % left, a bar, "Resets in …", and pace ("Ahead of / On / Under pace", ±5 points against elapsed time) | ✅ | `web/ThreadDetailsUsage.tsx:43-83,141-175`; `usageLimits.ts:637-666` |
| No plan limits | "This account has no subscription limits." (API key, Bedrock, Vertex), or "Could not read limits." when the probe failed | ✅ (R8.3: no fake limits) | `usageLimits.ts:617-625`; `claudeUsageLimits.ts:178-188` |
| Auth label | "Amazon Bedrock" for `apiProvider: "bedrock"`. Any non-first-party provider counts as signed in | ✅ (read it from the live session's `initializationResult().account`) | `t3code/apps/server/src/provider/ClaudeProvider.ts:166-188` |
| Where the data comes from | A **separate probe `query()`** (`persistSession: false`, hooks off, no MCP), not the live session | ❌ Rule 9: use the live session | `ClaudeProvider.ts:197-231,380-416` |
| Composer meter | Legacy and off by default. The thread-details card shows usage and context | — | `settings.ts:469`; `web/ThreadDetailsPanel.tsx:261-265` |
| Compaction | "Compacting context" and then "Context compacted" rows, from `status: "compacting"` and `compact_boundary` | ✅ | `A2:9101,9126-9201` |

---

## 9. `/btw`, the slash menu, and the pickers

| Item | t3code | Adopt? | Evidence |
|---|---|---|---|
| `/side`, `/btw` | Opens a **side chat**: a forked thread with full tools in a right-panel tab. It "starts from a digest" when the parent has no finished run. "Bring back" sends it to the parent | ❌ Not raw `/btw` (tools, a transcript, digest text). Use `askSideQuestion` on the live process (SDK `sdk.mjs`: `askSideQuestion(e,t){… this.request({subtype:"side_question", question:e, …history})`; CLI 2.1.318 binary: `subtype:"side_question"`). ✅ The side-panel **layout** is good | `t3code/docs/user/thread-sidebar.md:293-312`; `t3code/apps/server/src/orchestration-v2/Orchestrator.ts:4527-4537`; `ProviderTurnStartService.ts:1605-1610` |
| Slash menu | t3code's own `/model`, `/plan`, `/default`, `/side`, `/btw`, `/goal`, then provider commands from the probe's `initializationResult().commands`, then skills | ⚠️ Use `supportedCommands()` from the live session (R7.1). There is no live refresh: users must "Restart agent session" after changing skills or MCP | `web/useComposerMenuItems.ts:219-311`; `ClaudeProvider.ts:253-275`; `composer.md:257-259` |
| Local command output | Arrives as an assistant message with `local_command_source`. Shown as text, except `/compact`'s echo, which is hidden | ⚠️ R7.2 wants structure where the CLI gives it | `A2:9848-9864` |
| Model / effort | Live switch with `setModel` and `applyFlagSettings`. A process restart only for a thinking on/off change, or when effort is cleared | ✅ | `A2:1665-1684,10764-10778` |
| Ultracode | An effort level (`xhigh` plus ultracode); cleared with `null` | ✅ | §2.5 |
| Permission modes | Supervised → `default`, Auto-accept edits → `acceptEdits`, Auto → `auto`, Full access → `bypassPermissions`. `dontAsk` only for read-only sandboxes. Plan is a legacy toggle. **New threads default to Full access** | ⚠️ Offer all six and default to the user's `defaultMode` (rule 4, R1.4) | `A2:2800-2846`; `permission-modes.md:8-18` |
| Mode switch | Respawns the CLI. `supportsRuntimeModeSwitchInSession: false` | ❌ Use `setPermissionMode` | `A2:403,10781-10817` |
| `title` option | t3code passes its own title so the CLI skips "Claude's redundant naming request" | Neutral. Raw is to let the CLI name the session | `A2:1835-1836`; `SDK/sdk.d.ts:2520-2531` |

---

## 10. Env handling and binary choice

**Host-session variables t3code strips** (`ClaudeHome.ts:48-63`). The comment says: "A Claude Code session that launched T3 exports these. A claude spawned with them acts as part of that session."

| Variable |
|---|
| `CLAUDECODE` |
| `CLAUDE_CODE_SESSION_ID` |
| `CLAUDE_CODE_HOST_SESSION_ID` |
| `CLAUDE_CODE_CHILD_SESSION` |
| `CLAUDE_CODE_SESSION_ATTENDED` |
| `CLAUDE_CODE_MESSAGING_SOCKET` |
| `CLAUDE_CODE_MESSAGING_TOKEN` |
| `CLAUDE_CODE_EXECPATH` |
| `CLAUDE_CODE_DESKTOP_APP_VERSION` |
| `CLAUDE_EFFORT` |
| `CLAUDE_PID` |
| `CLAUDE_AGENT_SDK_VERSION` |

- It also deletes `ELECTRON_RUN_AS_NODE`, which only matters for its desktop app (`ClaudeHome.ts:79-81`).
- It **sets** `CLAUDE_CODE_ENTRYPOINT=t3-code`, unless the user's settings `env` names one (`ClaudeHome.ts:69-88`). We should not set it. Instead we should strip a host value (for example `cli`), so the SDK sets its default. The SDK sets `CLAUDE_CODE_ENTRYPOINT="sdk-ts"` and `CLAUDE_AGENT_SDK_VERSION` only when they are absent (`SDK/sdk.mjs`: `if(!gt.CLAUDE_CODE_ENTRYPOINT)gt.CLAUDE_CODE_ENTRYPOINT="sdk-ts";if(!gt.CLAUDE_AGENT_SDK_VERSION)…`). The raw-baseline research verifies the final list.
- It passes the rest of the env through. It removes no tokens or keys.

**Binary.**
- The `binaryPath` setting defaults to `claude` on `PATH` (`t3code/packages/contracts/src/settings.ts:716-722`). It has no `~/.local/bin` fallback, which our R1.1 needs.
- On Windows it resolves `.cmd`, `.bat` and `.ps1` shims to the package's `bin/claude.exe` or `cli.js`, because "the SDK skips shell and PATH/PATHEXT lookup" (`t3code/apps/server/src/provider/Drivers/ClaudeExecutable.ts:10-73`). ✅ We need the same for R10.2.
- **Removing SDK binaries.** It uses pnpm `overrides` that map each of the 8 platform packages (`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-arm64-musl`, `linux-x64`, `linux-x64-musl`, `win32-arm64`, `win32-x64`) to `"-"`. The comment: "The SDK always receives the user's Claude executable, so its bundled binaries are unused." (`t3code/pnpm-workspace.yaml:138-146`). For an npm-installed DSH plugin the same goal needs `--omit=optional` or an `overrides` entry. How DSH installs plugin dependencies is a question for packaging.

---

## 11. What t3code does that breaks our raw contract (do not copy)

| # | Behaviour | Rule broken | Evidence |
|---|---|---|---|
| 1 | System-prompt append: `<runtime_info>…you are running in T3 Code…</runtime_info>`, PR-linking text, orchestration instructions, background-wait text, device-tool text, and the user's `--append-system-prompt` folded in | 3 | `A2:1881-1895`; `t3code/packages/provider-core/src/server/runtimeInstructions.ts`; `A2:1733-1740` |
| 2 | Its own HTTP MCP server `t3-code`, pre-approved with `allowedTools` | 3, 4 | `A2:2010-2037` |
| 3 | A `SubagentStart` hook that adds `additionalContext` to every subagent | 3 | `A2:1743-1749,1896-1898` |
| 4 | Forced thinking display: `thinking: {type:"adaptive", display:"summarized"}`, `showThinkingSummaries: true` in flag settings, and `--thinking-display summarized` | 4 | `A2:1796-1802,1857-1867` |
| 5 | `model` is always passed. `permissionMode` is always passed (`"default"` if nothing else), and new threads default to Full access | 4 | `A2:1834,1837-1842`; `permission-modes.md:10` |
| 6 | An `ENABLE_TOOL_SEARCH` env and `autoCompactWindow` in flag settings when configured | 4 | `A2:1814-1830` |
| 7 | The `Ultrathink:` prefix added to the user's text for the "ultrathink" effort | 3 | `t3code/packages/shared/src/model.ts:508-525`; `A2:11100-11103,11549-11552` |
| 8 | Model-facing deny texts: the `ExitPlanMode` capture sentence, the rm-safety paragraph, "no active turn" | 3 | `A2:10220-10228,10354-10358,10396-10399` |
| 9 | The "PLEASE IMPLEMENT THIS PLAN:" message | 3 | `t3code/apps/web/src/proposedPlan.ts:54-58` |
| 10 | Restart notes and "continue" prompts | 3 | `RestartBackgroundNote.ts:126-133`; `RestartContinuation.ts:300-330` |
| 11 | Side-chat digest text in the first message | 3 | `ProviderTurnStartService.ts:1605-1610` |
| 12 | A probe `query()` for commands, models, account and usage, run again on every refresh | 9 | `ClaudeProvider.ts:197-231,380-416` |
| 13 | `claude -p` side runs for thread titles, commit messages and PR text | 9 | `t3code/apps/server/src/textGeneration/ClaudeTextGeneration.ts:188-230` |
| 14 | Idle compaction: it compacts idle threads on its own | 4 | `t3code/docs/user/providers-claude.md:47-79` |
| 15 | Stop = interrupt plus close. No `perTaskStopAffordance` | 6, 7 | `A2:11419-11420` |
| 16 | A cancelled turn stops its own workflows | 6 | `A2:7911-7930` |
| 17 | Fork and rewind close the live process | 6, 7 | `A2:12112,12187` |
| 18 | "Always allow" rewritten to session scope | 2 (spirit: the CLI should decide) | `A2:3778-3797` |
| 19 | MCP URL elicitations and forms with fields are declined | 10 (coverage) | `A2:3851-3880,10484-10502` |
| 20 | `CLAUDE_CODE_ENTRYPOINT=t3-code` | 4, 5 | `ClaudeHome.ts:74-77` |
| 21 | Product telemetry on by default (PostHog through its own endpoint), opt-out by env | 12 | `t3code/docs/user/telemetry.md:3-17` |

---

## 12. Corrections to earlier (local) research

- The earlier evaluation said t3code's interrupt "keeps the session". It keeps the *thread*, but it **closes the CLI process**, so background subagents and workflows stop (`A2:11419-11420`; `thread-sidebar.md:270`).
- The earlier workflow notes said "a cancelled turn stops its running workflows with `stopTask`; it does not kill the process". The `stopTask` part is right (`A2:7911-7930`). But `interruptTurn` then closes the process anyway.
- The earlier subagent notes said child prose "depends on CLI defaults (**unverified**)". The SDK doc settles it: the default sends only `tool_use`/`tool_result` blocks (`SDK/sdk.d.ts:1941-1946`). This is still not run live.
- t3code's workflow UI shows status and elapsed time per agent, **not tokens**. The tokens exist only in its data model.

---

## 13. UX patterns: adopt or not, and where they go in DSH

The DSH mapping column is a best guess from package names and READMEs. All of it is **unverified** until the dsh-seams and dsh-ui-surfaces research confirms it.

| UX pattern | t3code evidence | Adopt? | How it maps to a DSH surface (best guess, **unverified**) |
|---|---|---|---|
| Workflow run row named by `workflow_name`, expandable | `web/ThreadLineageWorkflowRow.tsx:118-194` | Yes | `P/dsh-client-ui-workflow-run` conversation node (run, then phases, then members), if a plugin may write its `tool-workflow/*` events. Its README now says a background run "stays running after its Turn or Step ends" |
| Phase sections with "settled/total agents", elapsed time, Failed tag | `ThreadLineageWorkflowRow.tsx:24-49,195-243` | Yes | Phase groups in the same node |
| Agent rows: status, elapsed time, hover card (model, effort, preview) | `ThreadLineageWorkflowRow.tsx:51-116` | Yes, **plus tokens and tool calls** | Member rows. The README says "identities and statuses only", so tokens may need a plugin slot or our own node |
| Opening block with the folded script and agent counts | `web/WorkflowOpeningBlock.tsx:29-80` | Yes | A tool presenter for the `Workflow` tool card (`P/dsh-agent-tool-presentation`, `P/dsh-client-ui-tool`) |
| Snapshot merge rules (attempts, regressions, unknown = running) | `claudeWorkflowProgress.ts:119-181` | Yes (backend logic) | Inside our Claude backend, not the DSH layer |
| Apply workflow progress with no turn open | `A2:8354-8400` | Yes | Events written outside a turn (see dsh-seams) |
| Live agent output by transcript tail, with containment | `workflowAgentTranscript.ts`; `workflowFileRead.ts` | Yes | A read-only child view in `P/dsh-client-ui-sidebar-right`. The server reads only files under `<config>/projects` |
| "Stop entire workflow" → `stopTask` | `ThreadLineageWorkflowRow.tsx:151-176`; `A2:11917-11945` | Yes | The job row's stop in `P/dsh-client-ui-jobs` (kill → `stopTask`), plus an action on the run node |
| A cancelled turn stops its workflows | `A2:7911-7930` | **No** | — |
| Subagent as a read-only child thread | `A2:6380,6915` (`makeSubagentChildThread`); `thread-sidebar.md:266-274` | Yes | `P/dsh-client-ui-subagent` expects DSH child sessions. Claude children are not DSH sessions, so we may need our own sidebar tab |
| Nested tree (`spawn_depth`, owner link) | `A2:8762-8775,9440-9449` | Yes | A tree in the child catalog, or our own panel |
| Child text and thinking routed by `parent_tool_use_id` | `A2:9793-9830` | Yes, with `forwardSubagentText: true` | The child view |
| Per-subagent Stop that waits for the CLI's outcome | `A2:11981-12040`; `ThreadRelationshipsControl.tsx:890-912` | Yes | Job row kill, and a Stop in the child view |
| Child approval shown in the parent with the child's name | `web/ChildThreadApprovals.tsx:15-76` | Yes | `P/dsh-client-ui-approval` card label (from `agentID`) |
| "Subagent waiting · Open approval" banner | `web/ThreadActivityBanners.tsx:34-72` | Yes | A composer banner or notice slot |
| Background roster from `background_tasks_changed` | `A2:8611-8660` | Yes | `P/dsh-jobs` roster (`job/registered`, `job/settled`) |
| Background banner: "Running · label", activity line, elapsed, Open, Stop | `ThreadActivityBanners.tsx:156-246` | Yes, but Stop = `stopTask` per task | `P/dsh-client-ui-jobs` header list (two-press stop) |
| Continuation turn for the CLI's own wake turn, with no prompt | `A2:8540-8590,10743-10750` | **Yes (key pattern)** | A DSH turn opened by the plugin with no user message. Can a plugin do that? Open question |
| "Finished / Failed / Stopped" link row when a child settles | `web/V2LifecycleRow.tsx:336-395` | Yes | `job/settled` plus a conversation node |
| Restart "continue" prompt | `RestartBackgroundNote.ts:126-133` | **No** | A UI notice only |
| Never replace a process that runs background work | `A2:10808-10817` | Yes | Backend rule |
| "Stopping…" then "Force stop" after 10 s | `ThreadActivityBanners.tsx:115-153` | Yes (UI). Stop itself = `interrupt()` only | The DSH Stop button calls `interrupt()`. A separate Force stop kills the process |
| Steer = `priority: "now"`, after moving foreground subagents to the background | `A2:11457-11500,11554` | Yes | DSH steer (inbox) |
| Queue or steer as the user's choice | `composer.md:63-79` | Yes | DSH composer (R3.4) |
| Fork with `forkSession(upToMessageId)` | `A2:12176-12199` | Yes, without closing the source | The DSH fork hook |
| Rewind with `resumeSessionAt` | `A2:12101-12160` | Yes | DSH rewind or "edit from here", if a plugin can hook it |
| Assign `sessionId` up front | `A2:1803-1805` | Yes | Session mapping in our side store or session metadata |
| Approval attached to the tool card by `toolUseID` | `A2:10216-10470` | Yes | DSH approval `callId` = `toolUseID` |
| Approval text from the CLI's `title`, `description`, `decisionReason` | `A2:10403-10413` | Yes, plus `displayName`, `blockedPath`, `defaultToNo` | Approval card fields |
| "Always allow this session" (destinations rewritten) | `A2:3778-3797` | **No.** Show the CLI's suggestions unchanged | DSH approval has only `allowed-once` (`P/dsh-user-approval/lib/types/index.d.ts:134`), so we may need our own card or an extension |
| Hide "always" when `suppressAlwaysAllowRule` is set | `A2:3696-3733` | Yes | Approval card |
| Typed reply = reject with feedback | `permission-modes.md:51-52` | Yes | DSH reject with a message |
| AskUserQuestion: multi-select and "Other" | `web/ComposerPendingUserInputPanel.tsx` | Yes, **plus previews** | `P/dsh-client-ui-user-questions` (support for previews **unverified**) |
| `ExitPlanMode` always denied, then "PLEASE IMPLEMENT" | `A2:10342-10360`; `proposedPlan.ts:54-58` | **No** | `P/dsh-client-ui-plan` review card: allow `ExitPlanMode` with a mode choice, or deny with the user's feedback |
| Track `status.permissionMode` | `A2:10981-10986` | Yes | Mode picker (`P/dsh-client-ui-permission-presets`) shows the real mode |
| MCP elicitation consent-only; URL declined | `A2:3851-3880` | **No** | A DSH question or form card, and a link for URL mode |
| CLI user dialogs (`resume_return`) as questions | `A2:10603-10660,10889` | Maybe | `P/dsh-client-ui-user-questions` |
| Context bar with an auto-compact tick | `web/ThreadDetailsUsage.tsx:86-139` | Yes (data from `getContextUsage()`) | DSH context ring (`P/dsh-token-meter`) or our own pill |
| Limit rows: % left, reset time, pace | `ThreadDetailsUsage.tsx:141-175` | Yes | A usage pill or settings card |
| "This account has no subscription limits." | `usageLimits.ts:617-625` | Yes | Same place |
| Prompt-cache expiry time | `A2:244-252,290-296` | Yes (extra) | Token meter tooltip |
| Per-turn growth from the `modelUsage` delta | `A2:10987-10993` | Yes | Turn footer or usage pill |
| Its own API-equivalent cost estimate | `usage.md:9-13` | **No.** Use the CLI's `total_cost_usd` and `costUSD` | — |
| Probe process for commands, usage and account | `ClaudeProvider.ts:197-231,380-416` | **No** | Use the live session (`initializationResult`, `supportedCommands`, `get_usage`) |
| Side chat (forked, with tools) for `/btw` | `thread-sidebar.md:293-312` | Layout yes, mechanism no | A `P/dsh-client-ui-sidebar-right` panel backed by `askSideQuestion` |
| Ultracode as an effort level, cleared with `null` | `claudeModelOptions.ts:47`; `A2:1676-1684` | Yes | `P/dsh-client-ui-model-selection` effort list |
| Live model and effort switch | `A2:10764-10778` | Yes | Model picker |
| Mode switch respawns the CLI | `A2:403` | **No.** Use `setPermissionMode` | Mode picker |
| Strip host Claude-session variables | `ClaudeHome.ts:48-63` | Yes (input to raw-baseline) | Backend spawn |
| Force `CLAUDE_CODE_ENTRYPOINT` | `ClaudeHome.ts:74-77` | **No** | — |
| Remove the SDK's platform binaries | `pnpm-workspace.yaml:138-146` | Yes | Packaging (`--omit=optional` or `overrides`) |
| Windows shim → `claude.exe` / `cli.js` | `ClaudeExecutable.ts:39-73` | Yes | Backend binary resolution |

---

## Open questions

1. ~~**Continuation turns.**~~ Answered (`dsh-seams` §3, verified): open the DSH turn with `agent.followup(<non-user notice>)`, do not write the notice as a `user/message`, and write the CLI's own step in that turn.
2. **Workflow node feed.** May a plugin append `tool-workflow/*` events that `P/dsh-client-ui-workflow-run` renders? Can a member row open a view that is not a DSH session? This is for dsh-seams and dsh-ui-surfaces.
3. **Child views without DSH sessions.** `P/dsh-client-ui-subagent` is built on DSH child sessions. Should Claude subagents become DSH child sessions (a native fit, but they cannot take input), or use our own read-only sidebar tab?
4. **"Always allow".** DSH's native approval has only a one-shot grant. How do we offer the CLI's own suggestions: our own card, an extension, or a follow-up control?
5. **Fork with a live source.** Does SDK `forkSession` give a correct copy while the source process is still running and writing? t3code closes the source first, but we must not kill its background work. This needs a live check.
6. ~~**Interrupt on 2.1.318.**~~ Answered (`sdk-surface` answer 7, live): with `perTaskStopAffordance: true`, `interrupt()` spares background agents and a running workflow.
7. **Progress volume.** How often does the CLI send `workflow_progress`, and how large is a frame? This decides whether progress goes into the DSH log or a side store.
8. ~~**Approvals with no open turn.**~~ Answered (`dsh-ui-surfaces` Round 2 Q1, live): `ctx.approval` throws outside a turn, but a plugin composer takeover with a pending interaction works, and so does `ctx.userQuestions.ask()` on the root agent.
9. **`forwardSubagentText`.** Confirm that it changes only what is streamed to the host, not what the model sees or does. Measure how much extra traffic it adds.
10. **Dialog kinds.** Which `request_user_dialog` kinds does CLI 2.1.318 send, and which have a TUI equivalent we should support?
11. ~~**Question previews.**~~ Answered: the DSH question card has no preview field (`dsh-ui-surfaces` §3), so previews need a plugin view. Set `previewFormat: 'markdown'`, the TUI's own default, unless the user's env sets it (`raw-baseline` Round 2), and render previews as Markdown.
12. **Ultracode keyword.** Should typed DSH messages carry `origin: {kind: "human"}`, so the `ultracode` keyword works as in the TUI? The user did type them, but this needs a check against rule 3.
