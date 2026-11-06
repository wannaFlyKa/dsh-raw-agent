# Wire fixtures

Each file is one SDK message per line, as the Agent SDK yields them to `query()` consumers.

Recorded (Phase 1 probes against Claude Code 2.1.318, scrubbed: fake ids, `/work/…` paths, no
signatures, no account or model ids, `system/init` reduced to model, mode and version; partial tool
JSON replaced by one delta with the final input):

- `foreground-tool.jsonl`: one Bash call and its result.
- `bg-interrupt-wake.jsonl`: a background shell, Stop while text streams, the CLI's wake turn.
- `parallel-tools-thinking.jsonl`: an AskUserQuestion turn, then a plan-mode turn with a signed,
  empty thinking block and two tool calls in one API call whose results arrive before
  `message_stop` (D18, D86).
- `steer-during-tool.jsonl`: a steer sent with `priority: 'next'` during a foreground tool, folded
  into the same CLI turn (`command_lifecycle started`, `status.user_message_uuids`; D27).
- `whole-response-api-error.jsonl`: a run without partial messages (every assistant frame is a
  whole response, D84), a signed empty thinking frame, then a `<synthetic>` API-error message with
  `error: invalid_request` and an `is_error` result (D69). Tool text replaced by neutral text.

Recorded in M3 (CLI 2.1.318, the plugin's own start options: `perTaskStopAffordance`,
`forwardSubagentText`, partial messages; same scrubbing, task and agent ids renumbered `task_NN`):

- `subagent.jsonl`: a foreground subagent that runs one Bash call (D45, D68).
- `nested-subagent.jsonl`: a subagent that starts its own subagent (`spawn_depth` 2,
  `parent_task_id`); both are forwarded on the stream.
- `background-agent-shell.jsonl`: two background shells and a background agent in one call; one
  shell is stopped with `stopTask`; the CLI's wake turns (D47, D26).
- `team.jsonl`: two teammates (`Agent` with `name`, `team_name`) exchanging ping/pong with
  `SendMessage`; each is woken again by the other's message (same task id, D50).
- `main-agent.jsonl`: a session started with `agent: 'pirate'` (a project agent). The stream
  carries no agent field (D15).

Hand-built (shapes from the CLI 2.1.318 binary and the SDK types; not yet seen on a real wire):

- `resend-tool-use.jsonl`: a re-sent `tool_use` frame before `message_stop` and a cumulative text
  frame (W1).
- `whole-response-tools.jsonl`: a stream that stops after one delta, then the non-streaming
  fallback response, one block per frame, with a tool call (D84 1).
- `tombstone.jsonl`: an abandoned attempt whose tool use and early result are tombstoned, then the
  retry (D84 2). Whether the SDK forwards `tombstone` frames is **unverified** (S1).

Recorded in M4 (CLI 2.1.318, the plugin's own start options, `claude-sonnet-5-5`, effort low; probe
`backend-workflows`). Each has a `<name>.transcripts/` folder: the run's transcript folder
(`agent-<id>.jsonl`, `*.meta.json`, `journal.jsonl`), scrubbed with the same id maps by
`make-fixture.mjs --transcripts`. Agent files keep their user/assistant lines; every other line
is a stub of the same type. `_t` is the probe's receive time in ms.

- `workflow-two-phase.jsonl`: a 2-phase workflow (phase One: one agent with a Bash call; phase
  Two: two parallel agents, one starts a background shell); `task_started local_workflow` has no
  `is_backgrounded`; the Workflow tool result with `runId`, `transcriptDir`, `scriptPath`;
  `workflow_progress` snapshots; a main-thread foreground Bash interrupted after the run ended;
  the CLI's wake turn.
- `workflow-interrupt.jsonl`: two parallel agents; `stopTask(<one agent id>)` (accepted, no
  effect); an interrupt during a main foreground tool while the run goes on; the run completes.
- `workflow-stop-run.jsonl`: `stopTask(<run>)` while the only agent runs a long shell: the agent
  row turns `error` ("Stopped because the workflow was stopped"), `task_notification stopped`.
