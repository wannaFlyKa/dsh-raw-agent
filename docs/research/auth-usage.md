# Research: usage, cost and limits for each auth type

Topic 6 of Phase 1 ("auth-usage"). Versions: Claude Code CLI 2.1.318, Agent SDK 0.3.318, DSH 0.2.2-rc.1.

Evidence aliases:
- `SDK/sdk.d.ts:N` is the Agent SDK 0.3.318 type file.
- `P/<pkg>/...` is a DSH package in the DSH install.
- `CLI 2.1.318 binary` is a string search in the CLI executable.
- **Probe A** is a live SDK probe on this machine (Bedrock auth, model `claude-sonnet-5-5`, one streaming-input process). Steps: controls before any turn; T1 "reply ok"; T2 one Bash call (2 API calls); T3 one tiny subagent; then `/usage`, `/context`, `/cost`; then controls; then a second process resumed from the same session with no turn. Total cost about $0.14.
- **Docs** means the Claude Code docs pages on code.claude.com (snapshot of 2026-11-05): `agent-sdk/cost-tracking`, `costs`, `statusline`, `google-vertex-ai`.

Only Bedrock could be tested live. Subscription, API key, Vertex and gateway facts come from the SDK types, the docs and the CLI binary. They are marked as such.

## Answers for the design

1. **Detect the auth type from the live process. Spawn nothing extra.**
   - `initializationResult().account` and `accountInfo()` give `apiProvider` (`firstParty`, `bedrock`, `vertex`, `foundry`, `anthropicAws`, `anthropicGoogleCloud`, `mantle`, `gateway`). For a claude.ai login they also give `email`, `organization` and `subscriptionType` (`SDK/sdk.d.ts:23-33`, `4809-4820`).
   - `system/init.apiKeySource` tells an API key apart from a login: `ANTHROPIC_API_KEY`, `apiKeyHelper`, `/login managed key`, or `none` (`SDK/sdk.d.ts:133-135`, `6316`).
   - Probe A (Bedrock): `account = {apiProvider: "bedrock"}` and `apiKeySource: "none"`.
   - `claude auth status` gives the same data (`authMethod: "third_party"`, `apiProvider: "bedrock"`), but it starts another process. Do not use it (rule 9).
2. **Per-call tokens: one sample per main-thread API call.**
   - Input and cache counts are on `stream_event` `message_start`. The final output count is on `message_delta`.
   - The `assistant` message's `usage.output_tokens` is a placeholder. Probe A: the T2 tool call shows 16 on the assistant message and 74 on `message_delta`. The transcript keeps 74. See also `SDK/sdk.d.ts:3735` and the docs (cost-tracking, "per-step output_tokens is a placeholder").
   - Count each `message.id` once. One API call can produce several assistant messages (`SDK/sdk.d.ts:3735`).
   - This maps exactly onto DSH `TokenUsage` (disjoint `inputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`, `reasoningTokens`; `P/dsh-llm/lib/types/types.d.ts:160-181`). It works when each Claude API call is one DSH `assistant/message` step carrying its own `usage` (`P/dsh-session/lib/types/types.d.ts:329-346`). Then DSH's meter sums real numbers.
3. **Per-turn totals: take differences of the cumulative `modelUsage` and `total_cost_usd`.**
   - `result.usage` covers the main loop only, for this turn only (`SDK/sdk.d.ts:6012-6014`).
   - `result.modelUsage` and `total_cost_usd` are running totals for the process. They include subagents, compaction and workflow agents (`SDK/sdk.d.ts:6008-6018`).
   - So: turn tokens and cost = this result's `modelUsage` minus the previous one. "Other" tokens (subagents, compaction) = that difference minus the sum of the main-thread calls. Probe A T3: the turn delta was 17,780 cache write, of which the main thread wrote 752. The other 17,028 were the subagent.
4. **Context ring: correct from turn 1, with Claude's own numbers.**
   - Before any turn, `getContextUsage({detail: 'summary'})` answers in about 24 ms, with no model call (Probe A). It returns `maxTokens` (1,000,000 here), the categories, `autoCompactThreshold` (967,000) and `isAutoCompactEnabled`. This gives the window size and Claude's breakdown before the first prompt.
   - After every main-thread call, the live value is `input + cache_read + cache_write` of that call, divided by the window. This is the status line's `used_percentage` formula (docs: statusline, "Context window fields"). Probe A after T3: 2 + 27,370 + 690 = 28,062, and `/context` said "28.3k / 1m (3%)".
   - `result.modelUsage[model].contextWindow` confirms the window on every result.
   - Use `detail: 'summary'` for routine refreshes. `'full'` calls the count-tokens API (`SDK/sdk.d.ts:3143-3153`). It took about 284 ms on Bedrock in Probe A. Whether that call is billed on Bedrock or Vertex is **unverified**.
5. **Cost: show it for every auth type, but label it honestly.**
   - Cost is always a client-side estimate. `modelUsage[*].costBasis` says how it was priced: `list` (built-in list price), `managed` (the org's `modelPricing`) or `unknown` (no price matched, so the figure is a guess) (`SDK/sdk.d.ts:1530-1532`). `provider` says who served the model.
   - Bedrock (Probe A): `provider: "bedrock"`, `costBasis: "list"`. Label it "estimate at list price". The real bill is in the AWS console (docs: costs, "Cloud providers").
   - claude.ai subscribers: the docs say the session cost "isn't relevant for billing purposes" (docs: costs, `/usage`). Show it as an API-equivalent figure, secondary to the plan bars.
   - **DSH has no cost field** (`P/dsh-llm/lib/types/types.d.ts:167-181`). Cost needs a plugin surface, or a side store if it must survive a DSH restart. The CLI itself persists it (point 8).
6. **Plan limits: only for claude.ai subscriptions. Show nothing fake for anyone else.**
   - Live: `rate_limit_event` (`status`, `rateLimitType`, `utilization`, `resetsAt`, overage fields; `SDK/sdk.d.ts:5959-5996`). The CLI builds it from the `anthropic-ratelimit-unified-*` response headers (CLI 2.1.318 binary). Bedrock gave none in Probe A, as expected.
   - On demand: `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors: true})`. It has windows `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_oauth_apps`, `model_scoped[]` and `extra_usage` (`SDK/sdk.d.ts:4433-4527`). It runs in the live process. Probe A: about 1 ms, `subscription_type: null`, `rate_limits_available: false`, `rate_limits: null`.
   - Rule: if `rate_limits_available` is false, hide the plan meter. Say "No plan limits for this account (Bedrock / Vertex / API key)". Never show 0%.
   - Throttling on API key, Bedrock and Vertex shows only as `system/api_retry` with `error: 'rate_limit'` or `'overloaded'` (`SDK/sdk.d.ts:3715-3733`, `3826`). Show those retries inline.
7. **`/usage`, `/cost` and `/context` arrive as synthetic assistant messages with zero usage.**
   - Probe A: each local command came back as an `assistant` message with `message.model: "<synthetic>"`, all usage fields 0, plus `local_command_run`/`local_command_source`. The `result` had `local_command: "usage"` / `"cost"` and zero `usage`. No `system/local_command_output` was sent for these.
   - `/context` carried the structured twin `context_usage` (`SDK/sdk.d.ts:3799`). `/usage` carried no `usage_report`: that twin exists only for claude.ai subscribers (`SDK/sdk.d.ts:3800-3803`).
   - **Never feed these zero samples into DSH usage or the ring.** dsh-claude's ring dropped to 0% after `/context` and `/usage`.
   - `/cost` works headless as an alias of `/usage`, but it is not in `system/init.slash_commands`. `usage`, `context` and `compact` are listed (Probe A).
8. **Totals survive resume.**
   - The CLI writes a `cost-state` line to its transcript (total cost, API time, `modelUsage`) when the process ends (Probe A transcript).
   - A resumed process restored `total_cost_usd` 0.1437 and the per-model tokens before any turn (Probe A resume step). So the first result after a resume already includes the earlier turns (`SDK/sdk.d.ts:6008`).
   - After a resume, `provider`, `canonicalModel` and `costBasis` are absent until the next priced call. Treat that as `list` (`SDK/sdk.d.ts:1530`; Probe A).
   - Read the baseline with the usage API right after spawn, so the first turn's delta is right.
   - `/clear` resets the totals. A crash result may carry zeros (docs: cost-tracking, "Recover totals after a session crash"). Keep the last good totals and never let the shown total go down.
9. **Speed and time.**
   - `result.duration_api_ms` is cumulative per process, not per turn. Probe A: 1,093 → 4,413 → 10,401 ms, and `/usage` said "Total duration (API): 10s". T2's value (4,413) was above its own wall time (3,363). Take differences.
   - `ttft_ms` is per turn.
   - For DSH speed stats, compute per call from stream timing: `message_delta.output_tokens` over the time from the first content delta to `message_stop`. Otherwise hide the stat for these sessions (R8.4). This is **unverified** against DSH's stats code. See the dsh-ui-surfaces note.

### What to show, by auth type

| Auth type | How to detect | Tokens and cost | Context | Plan limits | Errors |
|---|---|---|---|---|---|
| claude.ai subscription (Pro, Max, Ultra, Team, Enterprise) | `apiProvider: firstParty`, `subscriptionType` set, `apiKeySource: none` (types) | Tokens as for all types. Cost as "API-equivalent", secondary. | Same for all types | Live bars from `rate_limit_event` plus the usage API. Server rows from `usage_report.rate_limits.limits[]` (render verbatim: `severity`, `is_active`). An extra-usage row. Warn on `allowed_warning`. Show "resets at" on `rejected`. | `rate_limit` errors; `credential_expires_at` on results (`SDK/sdk.d.ts:6055`) for a "login expires" hint |
| API key (Console, `apiKeyHelper`, `/login` managed key) | `apiProvider: firstParty`, `apiKeySource` is not `none` (types) | Cost at list or managed price | Same | None (`rate_limits_available: false`) | Org TPM limits only as `api_retry` 429s |
| Amazon Bedrock | `apiProvider: bedrock` (**live**) | Cost `costBasis: list` (**live**). `modelUsage` keys may be an inference-profile ARN; use `canonicalModel` for the display name. Do not print the raw key, it can hold an account id. | Same (**live**: 1M window, 967K auto-compact) | None (**live**: no event, `rate_limits_available: false`) | Throttling as `api_retry`; `cloud_credential_error` |
| Google Vertex AI | `apiProvider: vertex` (types) | Same as Bedrock (**unverified** live) | Same | None (types) | Quota as `api_retry`; `cloud_credential_error` |
| Foundry, Anthropic-on-AWS, Mantle | `apiProvider` value (types) | As Bedrock (**unverified**) | Same | None (**unverified**) | As Bedrock |
| Claude apps gateway | `apiProvider: gateway` (types) | Cost may be `managed` | Same | A spend limit exists in the status line (`rate_limits.spend_limit`, docs: statusline). The SDK types have no `spend_limit` field (grep of `SDK/sdk.d.ts` finds none). **Open question.** | Gateway errors |

## Details and evidence

### 1. Auth identity

- `AccountInfo` (`SDK/sdk.d.ts:23-33`) has `email`, `organization`, `subscriptionType`, `tokenSource`, `apiKeySource` and `apiProvider`. The comment says the OAuth fields "only apply when firstParty". For 3P providers "the other fields are absent".
- It is available two ways, both from the live process:
  - `initializationResult().account` (`SDK/sdk.d.ts:4809-4820`);
  - `Query.accountInfo()` (`SDK/sdk.d.ts:3240`). Probe A: 0 ms after init.
- `system/init.apiKeySource` (`SDK/sdk.d.ts:6309-6316`): Probe A got `none` on Bedrock. `none` also covers a claude.ai login, a bearer token and any cloud provider (`SDK/sdk.d.ts:133`). So it can only tell an API key apart from the rest. Use `apiProvider` together with `subscriptionType`.
- `SDKAuthStatusMessage` (`type: 'auth_status'`, `isAuthenticating`, `output[]`, `error`; `SDK/sdk.d.ts:3828-3835`) reports login progress. Show it if it arrives (it did not in Probe A).
- `SDKStartupFailureReason` (`SDK/sdk.d.ts:6286-6288`) names auth-related start failures: `provider_not_allowed`, `org_pin_*`, `gateway_signin_required`, and others. They arrive on a zeroed `error_during_execution` result. Show the reason, not a generic crash (R3.6).

### 2. Per-call usage (main thread)

Probe A stream (main thread; `parent_tool_use_id: null`):

| Call | `message_start` (in / cache write / cache read / out) | `assistant.message.usage.output_tokens` | `message_delta.output_tokens` | Transcript |
|---|---|---|---|---|
| T1 text | 2 / 21,470 / 0 / 4 | 4 | 4 | 4 |
| T2 call 1 (Bash) | 2 / 13,176 / 14,051 / 16 | 16 | **74** | 74 |
| T2 call 2 | 2 / 81 / 27,227 / 3 | 3 | 3 | 3 |
| T3 call 1 (Agent) | 4 / 62 / 27,308 / 16 | 16 | **141** | 141 |
| T3 call 2 | 2 / 690 / 27,370 / 1 | 1 | 6 | 6 |

- The input and cache fields are final at `message_start`. Output is final only at `message_delta`.
- T2 `result.usage` = 4 / 13,257 / 41,278 / 77. That equals the sum of its two calls, using the `message_delta` outputs.
- The usage object also has `output_tokens_details.thinking_tokens` (maps to DSH `reasoningTokens`), `cache_creation.ephemeral_5m/1h_input_tokens`, `server_tool_use`, `service_tier` and `speed` (Probe A result `usage`).
- Probe A saw `stream_event`s for main-thread calls only: 5 `message_start`s for 5 main calls. The subagent's call came as one `assistant` message (`parent_tool_use_id` set, `agent_id` set) with usage 2 / 17,028 / 0 / 24. Whether its output count is final is **unverified**. The subagent transcript file is the final record.

### 3. Per-turn and per-model totals (`result`)

From `SDK/sdk.d.ts:5999-6060` and `6070-6160`:
- `usage`: "MAIN AGENT LOOP ONLY … per-turn in streaming-input sessions. Prefer modelUsage" (`:6012`).
- `modelUsage: Record<model, ModelUsage>`: whole tree, cumulative per process (`:6014-6018`).
  - `ModelUsage` fields (`SDK/sdk.d.ts:1500-1533`): `inputTokens`, `outputTokens`, `thinkingTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, the 5m/1h split, `webSearchRequests`, `costUSD`, `contextWindow`, `maxOutputTokens`, `canonicalModel`, `provider`, `costBasis`.
- `total_cost_usd`: cumulative, "An estimate, not a billing statement" (`:6008-6010`).
- Also: `duration_ms` (per turn), `duration_api_ms` (cumulative, see Answer 9), `ttft_ms`, `num_turns`, `permission_denials`, `local_command`, `credential_expires_at`.

Probe A running totals (one model, so one key):

| After | in | out | cache read | cache write | `costUSD` = `total_cost_usd` | `duration_api_ms` |
|---|---|---|---|---|---|---|
| T1 | 2 | 4 | 0 | 21,470 | 0.0537 | 1,093 |
| T2 | 6 | 81 | 41,278 | 34,727 | 0.0918 | 4,413 |
| T3 | 14 | 282 | 95,956 | 52,507 | 0.1437 | 10,401 |
| `/usage`, `/context`, `/cost` | unchanged | | | | 0.1437 | unchanged |

T3 split:
- turn delta = 8 / 201 / 54,678 / 17,780;
- main loop (`result.usage`) = 6 / 147 / 54,678 / 752;
- other (subagent) = 2 / 54 / 0 / 17,028.

The subagent's `task_progress` and `task_notification` carried `usage.total_tokens` 17,057 → 17,084, plus `tool_uses` and `duration_ms` (`SDK/sdk.d.ts:6401-6460`). That is the per-task figure for job rows.

### 4. Context

- `getContextUsage({detail})` (`SDK/sdk.d.ts:3143-3153`). Response type: `SDK/sdk.d.ts:4099-4227`.
  - Fields: `categories[]` (`id`, `name`, `tokens`, `color`, `kind`: used | free | buffer | deferred), `totalTokens`, `maxTokens`, `rawMaxTokens`, `percentage`, `gridRows`, `memoryFiles`, `mcpTools`, `agents`, `skills`, `messageBreakdown`, `autoCompactThreshold`, `isAutoCompactEnabled`, `apiUsage`.
  - Classify rows on `id` and `kind`, never on the English name (`SDK/sdk.d.ts:4102-4112`).
- Probe A timings: before any turn, `summary` 24 ms and `full` 284 ms, with identical numbers. After T1, `summary` took 15 ms.
- Before T1 the MCP rows were missing (MCP servers were still connecting). They appeared after T1: 2,049 instructions and 150K deferred. So a ring refresh after the first turn is needed for an exact breakdown.
- `totalTokens` is Claude's own estimate. It can differ from the last call's input. Probe A after the commands: `totalTokens` 32,906, but the last call's input was 28,062 and `/context` said 28.3k. Use one source per surface:
  - the ring %: the last main-thread call, the same as the status line;
  - the breakdown panel: `getContextUsage`.
- Compaction: `system/compact_boundary` with `compact_metadata.trigger`, `pre_tokens` and `post_tokens` (`SDK/sdk.d.ts:3885-3893`), and `system/status` with `compact_result` / `compact_error` (`SDK/sdk.d.ts:6292-6300`). Show "compacted 900K → 40K" from these. Refresh with `getContextUsage` afterwards. The status-line docs say `current_usage` is null after `/compact` until the next call.
- DSH auto-compaction (`dsh-compaction-basic`, base composition) may fire before Claude's own threshold. The dsh-claude evaluation found this risk (gap 9, **unverified** live). The design must keep DSH from compacting Claude sessions. That is an open question for dsh-seams.

### 5. Plan limits (subscription only)

- `rate_limit_event` → `SDKRateLimitInfo` (`SDK/sdk.d.ts:5959-5996`):
  - `status`: allowed | allowed_warning | rejected;
  - `rateLimitType`: five_hour | seven_day | seven_day_opus | seven_day_sonnet | seven_day_overage_included | overage;
  - `utilization`, `resetsAt` (epoch), `surpassedThreshold`;
  - overage fields: `overageStatus`, `overageResetsAt`, `overageDisabledReason`, `isUsingOverage`;
  - `limitScope` and `errorCode`.
- The CLI parses `anthropic-ratelimit-unified-5h-*`, `-7d-*` and `-overage-*` response headers (CLI 2.1.318 binary), so these exist only on the first-party claude.ai lane.
- The usage API (`SDK/sdk.d.ts:3155-3172`, response `4433-4527`) is marked EXPERIMENTAL. Wrap it in a capability check and degrade to `rate_limit_event` only.
  - `skipBehaviors: true` skips a scan of 7 days of local transcripts (`SDK/sdk.d.ts:4426-4430`). Use it for meters.
  - The `behaviors` section (what drives usage) is subscriber-only and could feed a "usage insights" panel later.
- `/usage` on a subscriber session carries `usage_report` with `rate_limits.limits[]`: server rows with `kind`, `group`, `percent`, `resets_at`, `scope`, `severity`, `is_active`, and `extra_usage` (`SDK/sdk.d.ts:6583-6640`). The type says to render the rows verbatim. Prefer this shape for a plan card. **Unverified** live (no subscription here).
- Status-line docs: `rate_limits` "appears only for claude.ai Pro, Max, and Ultra subscribers, or behind a Claude apps gateway that sets a spend limit", and "only after the first API response". Each window may be absent. Mirror these rules: no bars before data arrives, and drop a window after its `resets_at`.
- The CLI has an internal `api_error` parameter `rate_limit_info (usage_limit_reached)` with the same shape as `rate_limit_event` (CLI 2.1.318 binary, marked `@internal`). Do not rely on it. Use `rate_limit_event` with `status: rejected`.

### 6. Cost basis and pricing

- `modelPricing` (managed settings only) changes every cost figure to contracted rates (`SDK/sdk.d.ts:7363`; docs: costs). It shows up as `costBasis: managed`.
- `costBasis: unknown` means no price matched and `costUSD` "is a guess at the default model's rate" (`SDK/sdk.d.ts:1530`). Show a warning mark next to the cost.
- Bedrock and Vertex billing goes to the cloud account. Claude Code sends no metrics back (docs: costs, "Cloud providers"). So the plugin can only show the CLI's estimate.
- The dsh-claude evaluation saw `modelUsage` keyed by a Bedrock inference-profile ARN when the user's model setting was such an id. Probe A used a plain model id, so the key was `claude-sonnet-5-5`. Display `canonicalModel` when present, else the key with any ARN shortened. This keeps account ids off the screen (and out of screenshots).

### 7. Local usage commands

Probe A details:
- `/usage` result text: "Total cost: $0.1437 / Total duration (API): 10s / … / Usage by model: claude-sonnet-5-5: 14 input, 282 output, 96.0k cache read, 52.5k cache write ($0.1437) / Prompt cache (main): 5 requests · 73% of input tokens from cache · 1 miss … · warm (5m TTL …)". `/cost` gave the same text.
- `/context` result: a Markdown table, plus the `context_usage` twin (`model`, `total_tokens` 28,327, `raw_max_tokens`, `percentage`, `categories[]`).
- The CLI transcript stores these as `system/local_command` lines. They are not model input, so this stays raw.
- The "Prompt cache (main)" figures (hit ratio, misses, warm/TTL) are exposed in the status line's `prompt_cache` object (docs: statusline, "Prompt cache fields"). They are **not** in any SDK type found. The plugin could compute hit ratio and expiry from per-call cache counts, as t3code does, or show the `/usage` text.

### 8. Persistence

- The transcript stores each main and sidechain API response with its final usage, plus `cost-state` lines (`totalCostUSD`, `totalAPIDuration`, `totalToolDuration`, `modelUsage`, `hasUnknownModelCost`) written at process end (Probe A transcript).
- A resumed process restores them (Probe A). So after a DSH restart the plugin can re-read totals from the CLI (usage API) instead of keeping its own copy. A side store is needed only for per-turn cost history in the DSH timeline. **Open question**: can DSH carry a plugin-defined field or event for this?
- After a crash there is no `cost-state` line, so the restored total may be short. This is **inferred** from the line appearing only at process end. A side store with the last good total covers that.

### 9. Mapping onto DSH (summary; details belong to dsh-seams and dsh-ui-surfaces)

| Claude source | DSH target | Note |
|---|---|---|
| main-thread call usage (`message_start` + `message_delta`) | `assistant/message.usage` (`TokenUsage`) per step | Exact; DSH's totals then match the main loop |
| `thinking_tokens` | `reasoningTokens` | Already inside output |
| `modelUsage.contextWindow`, `getContextUsage().maxTokens` | `request/context.contextWindow` (`P/dsh-session/lib/types/types.d.ts:236-244`) | Known before turn 1 |
| other tokens (subagents, compaction) | no DSH field | Plugin pill, or per-subagent events if subagents become child sessions |
| `total_cost_usd`, `costUSD`, `costBasis` | no DSH field (`P/dsh-llm/lib/types/types.d.ts:167-181`) | Plugin pill / footer |
| plan windows | no DSH field | Plugin meter; hidden when `rate_limits_available` is false |
| synthetic local-command messages | none | Never write a usage sample for them |

## Open questions

1. Can a DSH plugin write per-step `usage` that the token meter folds, without the agent loop's own LLM adapter? This is for dsh-seams.
2. Where does cost live in DSH: a plugin slot pill only, or a side store for history?
3. How to stop DSH's own auto-compaction for Claude sessions (gap 9 from the evaluation).
4. The gateway `spend_limit` has no SDK field. Does it arrive in a `rate_limit_event` behind a gateway? **Unverified**: no gateway here.
5. Live checks still needed on a subscription account: the `rate_limit_event` cadence, the `usage_report` rows, and `accountInfo` fields. Also check that `getContextUsage({detail: 'full'})` costs nothing on Bedrock and Vertex.
