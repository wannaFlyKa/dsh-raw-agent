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

Hand-built (shapes from the CLI 2.1.318 binary and the SDK types; not yet seen on a real wire):

- `resend-tool-use.jsonl`: a re-sent `tool_use` frame before `message_stop` and a cumulative text
  frame (W1).
- `whole-response-tools.jsonl`: a stream that stops after one delta, then the non-streaming
  fallback response, one block per frame, with a tool call (D84 1).
- `tombstone.jsonl`: an abandoned attempt whose tool use and early result are tombstoned, then the
  retry (D84 2). Whether the SDK forwards `tombstone` frames is **unverified** (S1).
