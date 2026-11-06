// M5 usage, context and limits (R8.1-R8.4; D57-D61, D70): recorded wire replays (fixtures with and
// without the CLI's `model_usage_since_last_result`, `/clear`), the ledger's math on its own, auth
// and cost labels per account type, plan limits from both sources, and the session's controls.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AsyncQueue, SentInputTracker, type BackendEvent, type InteractionHandler } from '@dsh-raw-agent/core';
import {
  ClaudeMessageMapper,
  UsageLedger,
  authFromAccount,
  costLabelFor,
  createClaudeFactory,
  parseContextUsage,
  parseModelUsage,
  parseRateLimitInfo,
  type QueryFn,
} from '@dsh-raw-agent/backend-claude';

type Ev<T extends BackendEvent['type']> = Extract<BackendEvent, { type: T }>;
const of = <T extends BackendEvent['type']>(events: BackendEvent[], t: T): Ev<T>[] =>
  events.filter((e): e is Ev<T> => e.type === t);

function load(name: string): Record<string, unknown>[] {
  const p = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function run(name: string, usage?: UsageLedger): BackendEvent[] {
  const tracker = new SentInputTracker();
  const mapper = new ClaudeMessageMapper(tracker, usage ? { usage } : {});
  let at = 1000;
  return load(name).flatMap((m) => {
    if (m.type === 'command_lifecycle' && m.state === 'queued') tracker.sent(m.command_uuid as string);
    return mapper.map(m, (at += 5));
  });
}

const tokens = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
});

const mu = (input: number, output: number, read: number, write: number, cost: number, extra: object = {}) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadInputTokens: read,
  cacheCreationInputTokens: write,
  webSearchRequests: 0,
  costUSD: cost,
  contextWindow: 1000000,
  maxOutputTokens: 128000,
  ...extra,
});

describe('recorded /clear (fixture usage-clear.jsonl, live M5 probe A)', () => {
  const events = run('usage-clear.jsonl');
  const usage = of(events, 'usage');

  it('turn 1: tokens and cost from the result, one main call, no other tokens (D57, D58)', () => {
    const t1 = usage[0]!;
    expect(t1.turn?.total).toMatchObject(tokens(2, 4, 0, 21450));
    expect(t1.turn?.main).toMatchObject(tokens(2, 4, 0, 21450)); // message_start + message_delta
    expect(t1.turn?.other).toMatchObject(tokens(0, 0, 0, 0));
    expect(t1.turn?.calls).toBe(1);
    expect(t1.turn?.costUsd).toBeCloseTo(0.053669, 6);
    expect(t1.turn?.apiDurationMs).toBe(1862);
    expect(t1.turn?.ttftMs).toBe(1916);
    expect(t1.cumulative.costUsd).toBeCloseTo(0.053669, 6);
    expect(t1.cumulative.models.map((m) => [m.model, m.provider, m.costBasis])).toEqual([
      ['claude-sonnet-5-5', 'bedrock', 'list'],
    ]);
    expect(t1.costLabel.text).toBe('estimate at list price');
    // The usage event comes before the turn end, so the host can attach it to the turn.
    const i = events.indexOf(t1);
    expect(events[i + 1]?.type).toBe('turn-end');
  });

  it('the reset names the id the CLI runs under next, not the frame’s new_conversation_id (D70)', () => {
    const resets = of(events, 'conversation-reset');
    expect(resets).toEqual([
      { type: 'conversation-reset', newSessionId: '00000000-0000-4000-8000-000000000020', trigger: 'clear' },
    ]);
    // The reset comes before the second process conversation's first event.
    const i = events.indexOf(resets[0]!);
    expect(events[i + 1]?.type).toBe('session-info');
  });

  it('after the clear result the totals are zero; turn 2 counts from zero', () => {
    expect(usage[1]?.turn).toBeUndefined();
    expect(usage[1]?.cumulative.costUsd).toBe(0);
    expect(usage[1]?.cumulative.tokens).toMatchObject(tokens(0, 0, 0, 0));
    const t2 = usage[2]!;
    expect(t2.turn?.total).toMatchObject(tokens(2, 3, 13776, 13232));
    expect(t2.turn?.main).toMatchObject(tokens(2, 3, 13776, 13232));
    expect(t2.cumulative.tokens).toMatchObject(tokens(2, 3, 13776, 13232));
    expect(t2.cumulative.costUsd).toBeCloseTo(0.0344916, 7);
    expect(t2.turn?.apiDurationMs).toBe(934);
    expect(usage).toHaveLength(3);
  });

  it('a context event follows each call once the window is known (D59)', () => {
    // Turn 1's window is learnt from its result (the session primes it earlier with getContextUsage).
    expect(of(events, 'context')).toEqual([{ type: 'context', used: 2 + 13776 + 13232, window: 1000000 }]);
  });

  it('no auth claim from the stream alone when the init frame names no key source', () => {
    // The scrubbed init keeps model, mode and version only; the session primes the account.
    expect(of(events, 'auth')).toHaveLength(0);
    expect(of(events, 'limits')).toHaveLength(0);
  });
});

describe('recorded turns without the CLI’s per-result delta (fallback: differences of running totals)', () => {
  it('subagent.jsonl: other tokens = the turn total minus the main thread’s calls', () => {
    const events = run('subagent.jsonl');
    const [u] = of(events, 'usage');
    const result = load('subagent.jsonl').find((m) => m.type === 'result')!;
    expect(result.model_usage_since_last_result).toBeUndefined();
    const m = (result.modelUsage as Record<string, Record<string, number>>)['claude-sonnet-5-5']!;
    expect(u?.turn?.total).toMatchObject(
      tokens(m.inputTokens!, m.outputTokens!, m.cacheReadInputTokens!, m.cacheCreationInputTokens!),
    );
    const main = u!.turn!.main;
    const other = u!.turn!.other;
    expect(other.cacheWrite).toBeGreaterThan(0); // the subagent's own calls
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const)
      expect(main[k] + other[k]).toBe(u!.turn!.total[k]);
  });

  it('parallel-tools-thinking.jsonl: the CLI’s per-result delta is used as is, reasoning kept', () => {
    const events = run('parallel-tools-thinking.jsonl');
    const usage = of(events, 'usage');
    expect(usage).toHaveLength(2);
    expect(usage[1]?.turn?.total).toMatchObject({ ...tokens(10, 541, 117892, 3502), reasoning: 70 });
    expect(usage[1]?.turn?.costUsd).toBeCloseTo(0.0259742, 7);
    expect(usage[1]?.cumulative.tokens).toMatchObject(tokens(14, 715, 153192, 17203));
    expect(usage[1]?.cumulative.costUsd).toBeCloseTo(0.0655047, 7);
  });

  it('bg-interrupt-wake.jsonl: totals never go down; the wake turn is counted', () => {
    const usage = of(run('bg-interrupt-wake.jsonl'), 'usage');
    const costs = usage.map((u) => u.cumulative.costUsd);
    expect(costs).toEqual([...costs].sort((a, b) => a - b));
    expect(costs.at(-1)).toBeCloseTo(0.0457404, 7);
  });
});

describe('UsageLedger', () => {
  const result = (modelUsage: object, cost: number, apiMs: number, extra: object = {}) => ({
    type: 'result',
    subtype: 'success',
    modelUsage,
    total_cost_usd: cost,
    duration_api_ms: apiMs,
    ...extra,
  });

  it('counts each main call once by message id (D57)', () => {
    const l = new UsageLedger();
    l.mainCall('m1', tokens(1, 2, 3, 4));
    l.mainCall('m1', tokens(1, 2, 3, 4));
    const [u] = l.result(result({ s: mu(1, 2, 3, 4, 0.01) }, 0.01, 10)) as Ev<'usage'>[];
    expect(u?.turn?.calls).toBe(1);
    expect(u?.turn?.main).toMatchObject(tokens(1, 2, 3, 4));
  });

  it('a resumed process without a baseline: no turn figure first, then real deltas (D58)', () => {
    const l = new UsageLedger({ startedAs: 'resumed' });
    const [a] = l.result(result({ s: mu(10, 10, 10, 10, 1) }, 1, 100)) as Ev<'usage'>[];
    expect(a?.turn).toBeUndefined();
    expect(a?.cumulative.costUsd).toBe(1);
    const [b] = l.result(result({ s: mu(12, 11, 20, 10, 1.5) }, 1.5, 150)) as Ev<'usage'>[];
    expect(b?.turn?.total).toMatchObject(tokens(2, 1, 10, 0));
    expect(b?.turn?.costUsd).toBeCloseTo(0.5);
    expect(b?.turn?.apiDurationMs).toBe(50);
  });

  it('a resumed process with the usage control baseline (live probe B2 shape)', () => {
    const l = new UsageLedger({ startedAs: 'resumed' });
    const evs = l.usageControl({
      session: {
        total_cost_usd: 0.0344916,
        total_api_duration_ms: 934,
        model_usage: { 'claude-sonnet-5-5': mu(2, 3, 13776, 13232, 0.0344916) }, // no costBasis after resume
      },
      subscription_type: null,
      rate_limits_available: false,
      rate_limits: null,
    });
    expect(of(evs, 'usage')[0]?.cumulative.costBasis).toBe('list'); // absent → list (SDK)
    const [u] = l.result(result({ 'claude-sonnet-5-5': mu(4, 6, 27552, 13300, 0.04) }, 0.04, 1900)) as Ev<'usage'>[];
    expect(u?.turn?.total).toMatchObject(tokens(2, 3, 13776, 68));
    expect(u?.turn?.apiDurationMs).toBe(966);
    expect(u?.cumulative.costUsd).toBeCloseTo(0.04);
  });

  it('a local command result with duration_api_ms 0 does not restart the model time (M5 verify)', () => {
    const l = new UsageLedger();
    l.result(result({ s: mu(1, 1, 1, 1, 0.1) }, 0.1, 3000));
    l.result(result({ s: mu(1, 1, 1, 1, 0.1) }, 0.1, 0, { local_command: 'context' }));
    const [u] = l.result(result({ s: mu(2, 2, 2, 2, 0.2) }, 0.2, 5000)) as Ev<'usage'>[];
    expect(u?.turn?.apiDurationMs).toBe(2000);
    expect(u?.cumulative.apiDurationMs).toBe(5000);
  });

  it('a zeroed crash result keeps the last good totals', () => {
    const l = new UsageLedger();
    l.result(result({ s: mu(1, 1, 1, 1, 0.2) }, 0.2, 10));
    expect(l.result({ type: 'result', subtype: 'error_during_execution', modelUsage: {}, total_cost_usd: 0 })).toEqual(
      [],
    );
    expect(l.totals().costUsd).toBeCloseTo(0.2);
  });

  it('a local command that counted nothing sends nothing; /compact’s tokens are other tokens', () => {
    const l = new UsageLedger();
    l.result(result({ s: mu(1, 1, 1, 1, 0.2) }, 0.2, 10));
    expect(l.result(result({ s: mu(1, 1, 1, 1, 0.2) }, 0.2, 10, { local_command: 'usage' }))).toEqual([]);
    const [u] = l.result(result({ s: mu(2, 51, 1, 901, 0.3) }, 0.3, 30, { local_command: 'compact' })) as Ev<'usage'>[];
    expect(u?.turn?.other).toMatchObject(tokens(1, 50, 0, 900));
    expect(u?.turn?.main).toMatchObject(tokens(0, 0, 0, 0));
  });

  it('a reset other than /clear zeroes at once; /clear after its own result (D70)', () => {
    const l = new UsageLedger();
    l.result(result({ s: mu(1, 1, 1, 1, 0.2) }, 0.2, 10));
    const [z] = l.conversationReset('plan_mode_exit') as Ev<'usage'>[];
    expect(z?.cumulative.costUsd).toBe(0);
    l.result(result({ s: mu(1, 1, 1, 1, 0.1) }, 0.1, 10));
    expect(l.conversationReset('clear')).toEqual([]);
    expect(l.totals().costUsd).toBeCloseTo(0.1);
    // The clear's own result states calls counted before it (CLI): they still land, then zero.
    const evs = l.result(
      result({}, 0, 0, { local_command: 'clear', model_usage_since_last_result: { s: mu(0, 5, 0, 0, 0.01) } }),
    ) as Ev<'usage'>[];
    expect(evs.map((e) => e.cumulative.costUsd)).toEqual([expect.closeTo(0.11, 6), 0]);
  });

  it('context: window and auto-compact point from getContextUsage; after a compaction too (D59)', () => {
    const l = new UsageLedger();
    expect(l.mainCall('m0', tokens(1, 1, 1, 1))).toEqual([]); // window not known yet
    l.contextReport({ used: 0, window: 200000, autoCompactAt: 167000, model: 'claude-x' });
    expect(l.mainCall('m1', tokens(2, 9, 100, 50), 'claude-x')).toEqual([
      { type: 'context', used: 152, window: 200000, autoCompactAt: 167000 },
    ]);
    expect(l.compacted(4000)).toEqual([{ type: 'context', used: 4000, window: 200000, autoCompactAt: 167000 }]);
  });

  it('Bedrock: no plan limits, with a plain note, never 0 % (D60)', () => {
    const l = new UsageLedger();
    const evs = l.account({ apiProvider: 'bedrock' });
    expect(of(evs, 'auth')[0]?.auth).toEqual({ kind: 'bedrock', label: 'Amazon Bedrock', provider: 'bedrock' });
    expect(of(evs, 'auth')[0]?.costLabel.note).toMatch(/AWS/);
    expect(of(evs, 'limits')[0]?.limits).toEqual({
      available: false,
      limits: [],
      note: 'No plan limits for this account (Amazon Bedrock).',
    });
  });

  it('a subscription: windows from the usage control (percent) and live events (fraction)', () => {
    let now = Date.parse('2026-11-06T10:00:00Z');
    const l = new UsageLedger({ now: () => now });
    const auth = of(l.account({ apiProvider: 'firstParty', subscriptionType: 'max', email: 'x@y' }), 'auth')[0];
    expect(auth?.auth).toEqual({
      kind: 'subscription',
      label: 'Claude Max',
      provider: 'firstParty',
      subscriptionType: 'max',
    });
    expect(auth?.costLabel).toMatchObject({ text: 'API-equivalent', primary: false });
    const evs = l.usageControl({
      session: { total_cost_usd: 0, total_api_duration_ms: 0, model_usage: {} },
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 12, resets_at: '2026-11-06T12:00:00Z' },
        seven_day: { utilization: 40, resets_at: '2026-11-10T00:00:00Z' },
        seven_day_opus: null,
        seven_day_sonnet: { utilization: null, resets_at: null },
        model_scoped: [{ display_name: 'Fable', utilization: 3, resets_at: null }],
        extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
      },
    });
    const limits = of(evs, 'limits').at(-1)!.limits;
    expect(limits.available).toBe(true);
    expect(limits.limits.map((x) => [x.id, x.label, x.percent])).toEqual([
      ['five_hour', '5-hour limit', 12],
      ['seven_day', 'Weekly limit', 40],
      ['model:Fable', 'Weekly limit (Fable)', 3],
    ]);
    // A live event: utilization is a fraction, resetsAt in seconds (CLI binary).
    const live = l.rateLimit({
      status: 'allowed_warning',
      rateLimitType: 'five_hour',
      utilization: 0.81,
      resetsAt: Date.parse('2026-11-06T12:00:00Z') / 1000,
      unifiedWindows: { seven_day: { utilization: 0.42, resetsAt: Date.parse('2026-11-10T00:00:00Z') / 1000 } },
    });
    const after = of(live, 'limits')[0]!.limits.limits;
    expect(after.find((x) => x.id === 'five_hour')).toMatchObject({
      percent: 81,
      status: 'allowed_warning',
      source: 'event',
    });
    expect(after.find((x) => x.id === 'seven_day')?.percent).toBeCloseTo(42);
    // Rejected: blocked until the reset; a window past its reset is dropped.
    const rej = of(
      l.rateLimit({
        status: 'rejected',
        rateLimitType: 'five_hour',
        resetsAt: Date.parse('2026-11-06T12:00:00Z') / 1000,
      }),
      'limits',
    )[0];
    expect(rej?.limits.blocked).toEqual({ resetsAt: Date.parse('2026-11-06T12:00:00Z'), limitId: 'five_hour' });
    now = Date.parse('2026-11-06T13:00:00Z');
    const snap = l.snapshot();
    expect(snap.limits.blocked).toBeUndefined();
    expect(snap.limits.limits.map((x) => x.id)).toEqual(['seven_day', 'model:Fable']);
  });
});

describe('auth and cost labels per account type (R8.3)', () => {
  it('detects each provider without copying email or organisation', () => {
    expect(authFromAccount({ apiProvider: 'vertex' }).kind).toBe('vertex');
    expect(authFromAccount({ apiProvider: 'foundry' }).kind).toBe('foundry');
    expect(authFromAccount({ apiProvider: 'gateway' }).kind).toBe('gateway');
    expect(authFromAccount({ apiProvider: 'mantle' }).kind).toBe('cloud');
    expect(authFromAccount({ apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' })).toEqual({
      kind: 'api-key',
      label: 'API key',
      provider: 'firstParty',
      apiKeySource: 'ANTHROPIC_API_KEY',
    });
    expect(authFromAccount({}, 'apiKeyHelper').kind).toBe('api-key');
    expect(authFromAccount({}, 'none').kind).toBe('unknown');
    const sub = authFromAccount({
      apiProvider: 'firstParty',
      subscriptionType: 'pro',
      email: 'a@b',
      organization: 'o',
    });
    expect(JSON.stringify(sub)).not.toMatch(/a@b|"o"/);
  });

  it('labels cost by basis, and a subscription as API-equivalent (D58)', () => {
    expect(costLabelFor(authFromAccount({ apiProvider: 'vertex' }), 'list')).toMatchObject({
      text: 'estimate at list price',
      primary: true,
      note: expect.stringMatching(/Google Cloud/),
    });
    expect(costLabelFor(undefined, 'managed').text).toBe('managed price');
    expect(costLabelFor(undefined, 'unknown')).toMatchObject({ text: 'unknown price', warning: expect.any(String) });
    expect(costLabelFor(authFromAccount({}, 'ANTHROPIC_API_KEY'), 'list').note).toMatch(/Console/);
    expect(costLabelFor(authFromAccount({ subscriptionType: 'max' }), 'unknown')).toMatchObject({
      text: 'API-equivalent',
      primary: false,
      warning: expect.any(String),
    });
  });

  it('never shows a raw inference-profile key (D61)', () => {
    const m = parseModelUsage({
      'arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/abc': mu(1, 1, 1, 1, 0.1, {
        canonicalModel: 'claude-sonnet-5-5',
      }),
      'us.anthropic.claude-sonnet-5-5-v1:0': mu(1, 1, 1, 1, 0.1),
    })!;
    expect([...m.keys()]).toEqual(['claude-sonnet-5-5']);
    expect(m.get('claude-sonnet-5-5')?.tokens).toMatchObject(tokens(2, 2, 2, 2));
    expect(JSON.stringify([...m.values()])).not.toMatch(/123456789012/);
  });

  it('a rate-limit event with only a status still says it, without a percent', () => {
    const r = parseRateLimitInfo({ status: 'rejected', rateLimitType: 'seven_day', overageStatus: 'rejected' }, 1);
    expect(r?.limits).toEqual([{ id: 'seven_day', label: 'Weekly limit', status: 'rejected', source: 'event', at: 1 }]);
    expect(r?.overage).toEqual({ status: 'rejected' });
  });

  it('a full SDK-shaped warning event (SDK/sdk.d.ts SDKRateLimitInfo): percent, reset, overage', () => {
    // Every documented field of SDKRateLimitInfo (SDK 0.3.318) on one `allowed_warning` frame.
    const r = parseRateLimitInfo(
      {
        status: 'allowed_warning',
        resetsAt: 1_794_000_000,
        rateLimitType: 'seven_day_opus',
        utilization: 0.83,
        overageStatus: 'allowed',
        overageResetsAt: 1_794_100_000,
        overageDisabledReason: 'out_of_credits',
        isUsingOverage: false,
        overageInUse: false,
        overageEnabled: true,
        surpassedThreshold: 0.8,
      },
      7,
    );
    expect(r?.status).toBe('allowed_warning');
    expect(r?.limits).toHaveLength(1);
    expect(r?.limits[0]).toMatchObject({
      id: 'seven_day_opus',
      status: 'allowed_warning',
      resetsAt: 1_794_000_000_000,
    });
    expect(r?.limits[0]?.percent).toBeCloseTo(83);
    expect(r?.overage).toEqual({
      status: 'allowed',
      resetsAt: 1_794_100_000_000,
      disabledReason: 'out_of_credits',
      inUse: false,
    });
    // `allowed` with no utilization is no window figure at all (never a fake 0 %, D60).
    expect(parseRateLimitInfo({ status: 'allowed', rateLimitType: 'five_hour' }, 1)?.limits).toEqual([]);
  });
});

describe('mapper frames for usage (D59, D60)', () => {
  const map = (frames: Record<string, unknown>[]) => {
    const mapper = new ClaudeMessageMapper(new SentInputTracker());
    return frames.flatMap((f) => mapper.map(f));
  };

  it('compaction start and end with token counts, and a failure', () => {
    expect(
      map([
        { type: 'system', subtype: 'status', status: 'compacting' },
        {
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: { trigger: 'auto', pre_tokens: 900000, post_tokens: 40000 },
        },
        { type: 'system', subtype: 'status', status: null, compact_result: 'success' },
        { type: 'system', subtype: 'status', status: 'compacting' },
        { type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'too short' },
      ]),
    ).toEqual([
      { type: 'compaction', phase: 'start' },
      { type: 'compaction', phase: 'end', trigger: 'auto', preTokens: 900000, postTokens: 40000 },
      { type: 'compaction', phase: 'start' },
      { type: 'compaction', phase: 'end', error: 'too short' },
    ]);
  });

  it('api_retry becomes an inline retry; rate_limit_event becomes limits', () => {
    const evs = map([
      {
        type: 'system',
        subtype: 'api_retry',
        attempt: 2,
        max_retries: 10,
        retry_delay_ms: 1200,
        error_status: 429,
        error: 'rate_limit',
      },
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.1 },
      },
    ]);
    expect(evs[0]).toEqual({
      type: 'retry',
      attempt: 2,
      maxRetries: 10,
      delayMs: 1200,
      error: 'rate_limit',
      httpStatus: 429,
    });
    expect(evs[1]).toMatchObject({
      type: 'limits',
      limits: { available: true, limits: [{ id: 'five_hour', percent: 10 }] },
    });
  });

  it('an API key session: auth from system/init apiKeySource', () => {
    const evs = map([{ type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY', model: 'm' }]);
    expect(of(evs, 'auth')[0]?.auth.kind).toBe('api-key');
    expect(of(evs, 'limits')[0]?.limits.available).toBe(false);
  });
});

describe('session controls (D58-D60)', () => {
  function fakeQuery() {
    const out = new AsyncQueue<unknown>();
    const calls: string[] = [];
    const q = {
      [Symbol.asyncIterator]: () => out[Symbol.asyncIterator](),
      interrupt: async () => ({}),
      close: () => out.end(),
      initializationResult: async () => (calls.push('initializationResult'), { account: { apiProvider: 'bedrock' } }),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (o: unknown) => (
        calls.push(`usage ${JSON.stringify(o)}`),
        {
          session: { total_cost_usd: 0.5, total_api_duration_ms: 900, model_usage: { m: mu(1, 2, 3, 4, 0.5) } },
          subscription_type: null,
          rate_limits_available: false,
          rate_limits: null,
        }
      ),
      getContextUsage: async (o: unknown) => (
        calls.push(`ctx ${JSON.stringify(o)}`),
        {
          totalTokens: 21000,
          maxTokens: 1000000,
          autoCompactThreshold: 967000,
          isAutoCompactEnabled: true,
          percentage: 2,
          categories: [
            { id: 'system_prompt', name: 'System prompt', tokens: 1134, color: 'x', kind: 'used' },
            { id: 'mcp_tools_deferred', name: 'MCP tools (deferred)', tokens: 150432, isDeferred: true },
          ],
        }
      ),
    };
    const queryFn: QueryFn = () => q as never;
    return { out, calls, queryFn };
  }
  const noInteractions: InteractionHandler = {
    permission: async () => ({ optionId: 'reject' }),
    question: async () => null,
    plan: async () => ({ kind: 'keep-planning' }),
    elicitation: async () => ({ action: 'decline' }),
  };

  async function open(
    f: ReturnType<typeof fakeQuery>,
    start: Parameters<ReturnType<typeof createClaudeFactory>['open']>[0]['start'],
  ) {
    const factory = createClaudeFactory({ queryFn: f.queryFn });
    const dir = mkdtempSync(join(tmpdir(), 'raw-agent-usage-'));
    const exe = join(dir, 'claude');
    writeFileSync(exe, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    return factory.open({
      cwd: '/tmp',
      env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: join(dir, '.claude') },
      start,
      userConfig: { executablePath: exe, options: {} },
      interactions: noInteractions,
      signal: new AbortController().signal,
    });
  }

  it('primes auth, the resumed baseline and the window right after spawn; snapshot and context controls', async () => {
    const f = fakeQuery();
    const s = await open(f, { kind: 'resume', sessionId: '11111111-1111-4111-8111-111111111111' });
    const seen: BackendEvent[] = [];
    const pump = (async () => {
      for await (const e of s.events()) seen.push(e);
    })();
    await new Promise((r) => setTimeout(r, 20));
    expect(f.calls).toEqual(['initializationResult', 'usage {"skipBehaviors":true}', 'ctx {"detail":"summary"}']);
    expect(of(seen, 'auth')[0]?.auth.kind).toBe('bedrock');
    expect(of(seen, 'usage')[0]?.cumulative.costUsd).toBe(0.5);
    // The baseline makes the first result after the resume a true per-turn figure.
    f.out.push({
      type: 'result',
      subtype: 'success',
      modelUsage: { m: mu(2, 4, 3, 4, 0.6) },
      total_cost_usd: 0.6,
      duration_api_ms: 1000,
      num_turns: 1,
      result: 'x',
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(of(seen, 'usage').at(-1)?.turn?.total).toMatchObject(tokens(1, 2, 0, 0));
    const snap = await s.controls.usageSnapshot!();
    expect(snap).toMatchObject({
      auth: { kind: 'bedrock' },
      limits: { available: false },
      costLabel: { text: 'estimate at list price' },
    });
    expect(snap.totals.costUsd).toBeCloseTo(0.6);
    const ctx = await s.controls.contextUsage!('summary');
    expect(ctx).toEqual({
      used: 21000,
      window: 1000000,
      autoCompactAt: 967000,
      autoCompactEnabled: true,
      percent: 2,
      categories: [
        { id: 'system_prompt', name: 'System prompt', tokens: 1134, color: 'x', kind: 'used' },
        { id: 'mcp_tools_deferred', name: 'MCP tools (deferred)', tokens: 150432, kind: 'deferred' },
      ],
    });
    expect(parseContextUsage(undefined)).toEqual({ used: 0, window: 0 });
    await s.dispose();
    await pump;
  });

  it('follows the CLI to its new session id after /clear (D70)', async () => {
    const f = fakeQuery();
    const s = await open(f, { kind: 'new', sessionId: '11111111-1111-4111-8111-111111111111' });
    const pump = (async () => {
      for await (const _ of s.events());
    })();
    f.out.push({ type: 'system', subtype: 'init', session_id: '11111111-1111-4111-8111-111111111111' });
    f.out.push({
      type: 'conversation_reset',
      new_conversation_id: 'aaaa',
      trigger: 'clear',
      session_id: '11111111-1111-4111-8111-111111111111',
    });
    f.out.push({ type: 'system', subtype: 'init', session_id: '22222222-2222-4222-8222-222222222222' });
    await new Promise((r) => setTimeout(r, 10));
    expect(s.sessionId).toBe('22222222-2222-4222-8222-222222222222');
    await s.dispose();
    await pump;
  });
});
