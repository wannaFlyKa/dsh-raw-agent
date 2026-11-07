/* eslint-disable @typescript-eslint/no-explicit-any */
// M5 host-usage: honest DSH timings (R8.4), the usage board, and the usage/context routes (D57-D60).
import { describe, expect, it } from 'vitest';
import {
  AsyncQueue,
  type AgentBackendFactory,
  type BackendEvent,
  type ContextUsage,
  type CostLabel,
  type UsageSnapshot,
  type UsageTotals,
} from '@dsh-raw-agent/core';
import {
  CONTEXT_ROUTE,
  MAX_PLAUSIBLE_TOKENS_PER_SECOND,
  MIN_TIMED_DECODE_MS,
  SessionRuntime,
  TurnLog,
  USAGE_ROUTE,
  UsageBoard,
  replayStream,
  usageRoutes,
  type HostSessionPort,
  type TurnSink,
} from '@dsh-raw-agent/dsh-host';

const MAIN = { kind: 'main' } as const;
const binding = { backend: 'p', sessionId: 'x' };
const usage = (output: number, extra: Record<string, number> = {}) => ({
  inputTokens: 3,
  outputTokens: output,
  cacheReadTokens: 100,
  cacheWriteTokens: 10,
  ...extra,
});

function fakeSession() {
  const events: Array<{ type: string; data: any; seq: number }> = [];
  return {
    events,
    session: {
      id: 's1',
      get seq() {
        return events.length - 1;
      },
      header: {},
      append(type: string, data: unknown) {
        events.push({ type, data, seq: events.length });
        return { seq: events.length - 1 };
      },
      snapshotEvents: () => events as never,
    },
  };
}

function writer() {
  const s = fakeSession();
  const clock = { t: 10_000 };
  const log = new TurnLog(s.session, { emit() {}, nextRevision: () => 1, nextAttemptId: () => 'a' }, 1, {
    provider: 'p',
    now: () => clock.t,
  });
  const message = () => s.events.find((e) => e.type === 'assistant/message')!.data;
  return { log, clock, events: s.events, message };
}

/** DSH's first-token rule (`assistantStreamFirstTokenTime`, P/dsh-llm/lib/index.js:1362-1386). */
function firstTokenTime(stream: any[]): number | undefined {
  for (const r of stream) {
    if (r.type === 'chunk') {
      const c = r.chunk;
      if ((c.type === 'text-delta' || c.type === 'reasoning-delta') && c.text !== '') return r.time;
      if (c.type === 'tool-call-delta' && (c.argumentsDelta !== '' || c.name !== undefined)) return r.time;
      continue;
    }
    if (r.type === 'tool-call-chunks' && r.name !== undefined) return r.time0;
    const members: string[] = r.type === 'tool-call-chunks' ? r.args : r.texts;
    let t = r.time0;
    for (let i = 0; i < members.length; i++) {
      if (i > 0) t += r.dt[i - 1] ?? 0;
      if (members[i] !== '') return t;
    }
  }
  return undefined;
}

describe('R8.4: DSH timings are real or absent', () => {
  it('keeps live deltas when the step opened at its request and the speed is plausible', () => {
    const w = writer();
    w.log.openStep(9_990);
    w.clock.t = 11_000;
    w.log.delta('text', 0, 'Hello', 11_000);
    w.log.delta('text', 0, ' world', 11_500);
    w.clock.t = 12_000; // 1 s decode for 100 tokens: 100 tok/s
    w.log.commit({ blocks: [{ type: 'text', text: 'Hello world' }], usage: usage(100), binding });
    const m = w.message();
    expect(m.usage).toEqual(usage(100));
    expect(firstTokenTime(m.stream)).toBe(11_000);
    expect(replayStream(m.stream).usage).toEqual(m.usage);
  });

  it('drops the deltas (keeps content and usage) when the step was opened late', () => {
    const w = writer();
    w.log.openStep(5_000); // the request was 5 s before the step opened (a buffered wake turn)
    expect(w.log.stepTimed).toBe(false);
    w.log.delta('text', 0, 'Hi', 10_100);
    w.clock.t = 11_000;
    w.log.commit({ blocks: [{ type: 'text', text: 'Hi' }], usage: usage(50), binding });
    const m = w.message();
    expect(firstTokenTime(m.stream)).toBeUndefined();
    expect(m.message.content).toEqual([{ type: 'text', text: 'Hi' }]);
    expect(m.usage).toEqual(usage(50));
  });

  it('drops the deltas when a delta was stamped long before its step opened', () => {
    const w = writer();
    w.log.openStep();
    w.log.delta('text', 0, 'early', 1_000);
    w.clock.t = 20_000;
    w.log.commit({ blocks: [{ type: 'text', text: 'early' }], usage: usage(2), binding });
    expect(firstTokenTime(w.message().stream)).toBeUndefined();
  });

  it('clamps a small skew so no token comes before its step', () => {
    const w = writer();
    w.log.openStep();
    w.log.delta('text', 0, 'x', 9_900);
    w.clock.t = 12_000;
    w.log.commit({ blocks: [{ type: 'text', text: 'x' }], usage: usage(10), binding });
    expect(firstTokenTime(w.message().stream)).toBe(10_000);
  });

  it('drops a burst whose speed no model reaches', () => {
    const w = writer();
    w.log.openStep(9_990);
    w.log.delta('text', 0, 'ok', 10_000);
    w.clock.t = 10_009; // 4 tokens in 9 ms = 444 tok/s... and 40 tokens is 4444 tok/s
    w.log.commit({ blocks: [{ type: 'text', text: 'ok' }], usage: usage(40), binding });
    const m = w.message();
    expect((40 * 1000) / 9).toBeGreaterThan(MAX_PLAUSIBLE_TOKENS_PER_SECOND);
    expect(firstTokenTime(m.stream)).toBeUndefined();
    expect(m.usage.outputTokens).toBe(40); // the token meter still counts it
  });

  it('drops the timing of a short answer whose decode window cannot be measured (phase 5 fix)', () => {
    const w = writer();
    w.log.openStep(9_300);
    w.log.delta('text', 0, 'Hello there', 10_041);
    w.log.delta('text', 0, ' friend.', 10_097);
    w.clock.t = 10_097; // live g5: 20 tokens over 56 ms read as 357 tok/s
    w.log.commit({ blocks: [{ type: 'text', text: 'Hello there friend.' }], usage: usage(20), binding });
    const m = w.message();
    expect(56).toBeLessThan(MIN_TIMED_DECODE_MS);
    expect(firstTokenTime(m.stream)).toBeUndefined();
    expect(m.usage.outputTokens).toBe(20);
  });

  it('drops the timing when thinking was counted but never streamed', () => {
    const w = writer();
    w.log.openStep(9_990);
    w.log.delta('text', 0, 'answer', 10_000);
    w.clock.t = 15_000;
    w.log.commit({
      blocks: [{ type: 'text', text: 'answer' }],
      usage: usage(300, { reasoningTokens: 280 }),
      binding,
    });
    expect(firstTokenTime(w.message().stream)).toBeUndefined();
  });

  it('marks a tool-only step with a name-only tool-call delta; the block-end decides the call', () => {
    const w = writer();
    w.log.openStep(9_990);
    w.log.delta('tool-input', 0, '{"comm', 10_000, { id: 'toolu_1', name: 'Bash' });
    w.log.delta('tool-input', 0, 'and":"ls"}', 10_400, { id: 'toolu_1', name: 'Bash' });
    w.clock.t = 11_000;
    const call = { type: 'tool-call' as const, id: 'toolu_1', name: 'Bash', arguments: '{"command":"ls"}' };
    const { calls } = w.log.commit({ blocks: [call], usage: usage(60), binding });
    expect(calls).toEqual(['toolu_1']);
    const m = w.message();
    expect(firstTokenTime(m.stream)).toBe(10_000);
    expect(replayStream(m.stream).blocks).toEqual([call]);
    // Only the marker: the streamed input text is never stored (D21).
    const run = m.stream.find((r: any) => r.type === 'tool-call-chunks');
    expect(run).toMatchObject({ id: 'toolu_1', name: 'Bash', args: [''], time0: 10_000 });
    expect(w.events.find((e) => e.type === 'tool/call')!.data.arguments).toBe('{"command":"ls"}');
  });

  it('keeps an interrupted text prefix valid with a tool marker in the stream', () => {
    const w = writer();
    w.log.openStep(9_990);
    w.log.delta('text', 0, 'Let me look', 10_000);
    w.log.delta('tool-input', 1, '{"a', 10_100, { id: 't', name: 'Read' });
    w.clock.t = 10_200;
    w.log.commit({ blocks: [{ type: 'text', text: 'Let me look' }], interrupted: true, binding });
    const m = w.message();
    expect(m.interrupted).toBe(true);
    expect(m.message.content).toEqual([{ type: 'text', text: 'Let me look' }]);
    expect(replayStream(m.stream).interruptedBlocks).toEqual(m.message.content);
  });
});

describe('usage board (D58-D60, D70)', () => {
  const totals = (n: number): UsageTotals => ({
    tokens: { input: n, output: n, cacheRead: n, cacheWrite: 0 },
    costUsd: n / 1000,
    apiDurationMs: n,
    models: [],
    costBasis: 'list',
  });
  const label: CostLabel = { text: 'estimate at list price', primary: true };

  it('keeps totals, binds a turn row to its host turn, and empties the context on a reset', () => {
    const b = new UsageBoard(() => 7);
    expect(b.summary()).toBeUndefined();
    b.apply({ type: 'context', used: 50_000, window: 200_000, autoCompactAt: 180_000 });
    b.apply(
      {
        type: 'usage',
        cumulative: totals(10),
        costLabel: label,
        turn: {
          main: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
          other: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          total: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
          calls: 1,
          costUsd: 0.01,
          apiDurationMs: 900,
          models: [],
          costBasis: 'list',
        },
      },
      3,
    );
    const v = b.view();
    expect(v.lastTurn?.hostTurn).toBe(3);
    expect(v.context).toMatchObject({ used: 50_000, percent: 25, autoCompactAt: 180_000, source: 'call' });
    expect(b.summary()).toMatchObject({ tokens: 30, costUsd: 0.01, context: { percent: 25 } });
    b.apply({ type: 'conversation-reset', newSessionId: 'n', trigger: 'clear' }, 4);
    expect(b.view().context).toBeUndefined();
    expect(b.view().resets).toEqual([{ trigger: 'clear', hostTurn: 4, at: 7 }]);
  });

  it('shows a compaction result until the next call, and the agent report with its categories', () => {
    const b = new UsageBoard(() => 1);
    b.apply({ type: 'context', used: 150_000, window: 200_000 });
    b.apply({ type: 'compaction', phase: 'start', trigger: 'auto' });
    expect(b.view().compacting).toBe(true);
    b.apply({ type: 'compaction', phase: 'end', trigger: 'auto', preTokens: 150_000, postTokens: 20_000 });
    expect(b.view().context).toMatchObject({ used: 20_000, percent: 10, source: 'compaction' });
    b.report({
      used: 22_000,
      window: 200_000,
      percent: 11,
      categories: [{ id: 'system', name: 'System prompt', tokens: 3000, kind: 'used' }],
    } as ContextUsage);
    expect(b.view().context).toMatchObject({ used: 22_000, percent: 11, source: 'report' });
    expect(b.view().context?.categories).toHaveLength(1);
  });

  it('never invents numbers: a zero window is ignored, and limits stay as reported', () => {
    const b = new UsageBoard(() => 1);
    expect(b.apply({ type: 'context', used: 5, window: 0 })).toBe(false);
    b.apply({ type: 'limits', limits: { available: false, limits: [], note: 'No plan limits for this account' } });
    expect(b.view().limits).toEqual({ available: false, limits: [], note: 'No plan limits for this account' });
    expect(b.summary()?.limitsAvailable).toBe(false);
    b.apply({ type: 'retry', attempt: 1, maxRetries: 10, error: 'overloaded' });
    expect(b.summary()?.retry).toMatchObject({ attempt: 1, error: 'overloaded' });
    b.apply({ type: 'context', used: 5, window: 10 });
    expect(b.summary()?.retry).toBeUndefined(); // a call got through
  });

  it('client-usage: the summary names the fullest reported plan window and the auth type', () => {
    const b = new UsageBoard(() => 1);
    b.apply({
      type: 'auth',
      auth: { kind: 'subscription', label: 'Max plan', subscriptionType: 'max' },
      costLabel: { text: 'API-equivalent', primary: false },
    });
    b.apply({
      type: 'limits',
      limits: {
        available: true,
        limits: [
          { id: 'five_hour', label: '5-hour', percent: 23, resetsAt: 99, status: 'allowed', source: 'event', at: 1 },
          { id: 'seven_day', label: 'Weekly', percent: 41, source: 'usage-api', at: 1 },
          { id: 'seven_day_opus', label: 'Weekly (big)', source: 'usage-api', at: 1 },
        ],
      },
    });
    expect(b.summary()).toMatchObject({
      auth: { kind: 'subscription', label: 'Max plan' },
      limit: { id: 'seven_day', label: 'Weekly', percent: 41 },
    });
    b.apply({ type: 'limits', limits: { available: true, limits: [{ id: 'x', label: 'X', source: 'event', at: 1 }] } });
    expect(b.summary()?.limit).toBeUndefined(); // no reported percent: no made-up 0 %
  });

  it('client-usage: the channel line carries the usage summary (null when nothing is known)', async () => {
    const { channelLine } = await import('@dsh-raw-agent/dsh-host');
    const base = { state: { process: 'none', turn: false, backgroundTasks: 0 }, live: {}, choice: {} } as any;
    expect(JSON.parse(channelLine(base)).usage).toBeNull();
    expect(JSON.parse(channelLine({ ...base, usage: { compacting: false, tokens: 5 } })).usage).toEqual({
      compacting: false,
      tokens: 5,
    });
  });
});

/** A TurnSink over the real writer (as port/loop.ts builds it). */
function logSink() {
  const s = fakeSession();
  const log = new TurnLog(s.session, { emit() {}, nextRevision: () => 1, nextAttemptId: () => 'a' }, 4, {
    provider: 'p',
  });
  const sink: TurnSink = {
    get turn() {
      return log.turn;
    },
    get stepOpen() {
      return log.stepOpen;
    },
    get hasMessage() {
      return log.hasMessage;
    },
    get openCallIds() {
      return log.openCallIds;
    },
    hasCall: (id) => log.hasCall(id),
    claim: () => false,
    openStep: (at) => log.openStep(at),
    delta: (k, i, t, at, tool) => log.delta(k, i, t, at, tool),
    commit: (m) => {
      const input: any = { blocks: m.blocks, binding: m.binding };
      if (m.usage)
        input.usage = {
          inputTokens: m.usage.input,
          outputTokens: m.usage.output,
          cacheReadTokens: m.usage.cacheRead,
          cacheWriteTokens: m.usage.cacheWrite,
        };
      if (m.interrupted) input.interrupted = true;
      if (m.continued) input.continued = true;
      return log.commit(input);
    },
    result: (id, content, isError) => log.result(id, content as any, isError),
    closeStep: () => log.closeStep(),
  };
  return { sink, events: s.events };
}

function setup(controls: Record<string, unknown> = {}) {
  let opened = 0;
  let script: (push: (e: BackendEvent) => void) => void = () => {};
  const factory = {
    kind: 'k',
    displayName: 'K',
    staticCapabilities: { ids: 'agent-chosen', resume: true, fork: 'none', needsProcess: [] },
    async open() {
      opened++;
      const q = new AsyncQueue<BackendEvent>();
      return {
        kind: 'k',
        sessionId: 'x',
        startedAs: 'new',
        capabilities: {},
        events: () => q,
        send: async () => script((e) => q.push(e)),
        interrupt: async () => ({ cancelledInputIds: [] }),
        forceStop: async () => {},
        dispose: async () => q.end(),
        controls,
      };
    },
  } as unknown as AgentBackendFactory;
  const port: HostSessionPort = {
    hostSessionId: 'h1',
    cwd: '/w',
    wake: () => {},
    latestBinding: () => undefined,
    startJob: () => undefined,
    warn: () => {},
  };
  const rt = new SessionRuntime(factory, port, { env: {} });
  const run = async (events: BackendEvent[]) => {
    script = (push) => {
      for (const e of events) push(e);
    };
    const { sink, events: log } = logSink();
    await rt.runTurn(
      sink,
      { userInputs: [{ id: `u${Math.random()}`, parts: [{ type: 'text', text: 'hi' }] }], wake: false },
      new AbortController().signal,
    );
    return log;
  };
  return { rt, run, opened: () => opened };
}

const turnEnd = { type: 'turn-end', agent: MAIN, outcome: 'completed', pendingInputs: 0 } as BackendEvent;
const now = () => Date.now();

describe('driver: steps open at the request (R8.4), usage state (M5)', () => {
  it('a response joins the step its request opened; a retried request keeps it', async () => {
    const t = setup();
    const log = await t.run([
      { type: 'turn-start', origin: 'user' },
      { type: 'request-start', agent: MAIN, at: now() },
      { type: 'retry', attempt: 1, error: 'overloaded' },
      { type: 'request-start', agent: MAIN, at: now() },
      { type: 'step-start', agent: MAIN, stepId: 'm1', at: now() },
      { type: 'step-message', agent: MAIN, stepId: 'm1', blocks: [{ type: 'text', text: 'hi' }], final: true },
      turnEnd,
    ]);
    expect(log.map((e) => e.type)).toEqual(['step/start', 'assistant/message', 'step/end']);
    expect(log.some((e) => e.type === 'request/context')).toBe(false);
    await t.rt.dispose();
  });

  it('a request after a stale response closes it as an attempt (D18) and opens a new step', async () => {
    const t = setup();
    const log = await t.run([
      { type: 'request-start', agent: MAIN, at: now() },
      { type: 'step-start', agent: MAIN, stepId: 'm1', at: now() },
      { type: 'request-start', agent: MAIN, at: now() },
      { type: 'step-start', agent: MAIN, stepId: 'm2', at: now() },
      { type: 'step-message', agent: MAIN, stepId: 'm2', blocks: [{ type: 'text', text: 'ok' }], final: true },
      turnEnd,
    ]);
    expect(log.map((e) => e.type)).toEqual([
      'step/start',
      'assistant/attempt',
      'step/end',
      'step/start',
      'assistant/message',
      'step/end',
    ]);
    await t.rt.dispose();
  });

  it('a request while calls still wait for results changes nothing', async () => {
    const t = setup();
    const call = { type: 'tool-call' as const, id: 'c1', name: 'Bash', arguments: '{}' };
    const log = await t.run([
      { type: 'request-start', agent: MAIN, at: now() },
      { type: 'step-start', agent: MAIN, stepId: 'm1', at: now() },
      { type: 'step-message', agent: MAIN, stepId: 'm1', blocks: [call], final: true },
      { type: 'request-start', agent: MAIN, at: now() },
      { type: 'tool-result', agent: MAIN, callId: 'c1', content: [{ type: 'text', text: 'x' }], isError: false },
      turnEnd,
    ] as BackendEvent[]);
    expect(log.map((e) => e.type)).toEqual(['step/start', 'assistant/message', 'tool/call', 'tool/result', 'step/end']);
    await t.rt.dispose();
  });

  it('binds the turn usage to the host turn and shows the summary in the session view', async () => {
    const t = setup();
    const cumulative: UsageTotals = {
      tokens: { input: 5, output: 7, cacheRead: 11, cacheWrite: 0 },
      costUsd: 0.02,
      apiDurationMs: 800,
      models: [],
      costBasis: 'list',
    };
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    await t.run([
      { type: 'context', used: 16, window: 200 },
      {
        type: 'usage',
        cumulative,
        costLabel: { text: 'estimate at list price', primary: true },
        turn: {
          main: cumulative.tokens,
          other: zero,
          total: cumulative.tokens,
          calls: 1,
          costUsd: 0.02,
          apiDurationMs: 800,
          models: [],
          costBasis: 'list',
        },
      },
      turnEnd,
    ]);
    const answer = await t.rt.usage();
    expect(answer.running).toBe(true);
    expect(answer.usage.lastTurn?.hostTurn).toBe(4);
    expect(t.rt.view().usage).toMatchObject({ tokens: 23, costUsd: 0.02, context: { used: 16, percent: 8 } });
    await t.rt.dispose();
  });
});

describe('usage and context routes (D59, rule 9)', () => {
  const snapshot: UsageSnapshot = {
    totals: {
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0,
      apiDurationMs: 0,
      models: [],
      costBasis: 'list',
    },
    costLabel: { text: 'API-equivalent', primary: false },
    limits: {
      available: true,
      limits: [{ id: 'five_hour', label: '5-hour', percent: 12, source: 'usage-api', at: 1 }],
    },
    at: 1,
  };

  it('never starts a process: no process answers not-running with what is known', async () => {
    const t = setup({ contextUsage: async () => ({ used: 1, window: 2 }) });
    const routes = usageRoutes({ get: (id: string) => (id === 'h1' ? t.rt : undefined) } as any);
    const ctx = routes.find((r) => r.path === CONTEXT_ROUTE)!;
    const res = await ctx.fetch(new Request(`http://x${CONTEXT_ROUTE}?session=h1`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ running: false, reason: 'not-running' });
    const u = await routes.find((r) => r.path === USAGE_ROUTE)!.fetch(new Request(`http://x${USAGE_ROUTE}?session=h1`));
    expect((await u.json()).running).toBe(false);
    expect(t.opened()).toBe(0);
    const bad = await ctx.fetch(new Request(`http://x${CONTEXT_ROUTE}?session=h1&detail=all`));
    expect(bad.status).toBe(400);
    const other = await ctx.fetch(new Request(`http://x${CONTEXT_ROUTE}?session=nope`));
    expect(other.status).toBe(404);
    await t.rt.dispose();
  });

  it('reads the live process: the context report (shared within a second) and the usage control', async () => {
    let reads = 0;
    const t = setup({
      contextUsage: async (detail: string) => {
        reads++;
        return {
          used: 40_000,
          window: 200_000,
          autoCompactAt: 167_000,
          categories: detail === 'full' ? [{ name: 'Messages', tokens: 30_000 }] : undefined,
        };
      },
      usageSnapshot: async () => snapshot,
    });
    await t.run([turnEnd]); // spawns by a user message
    const a = await t.rt.contextUsage();
    const b = await t.rt.contextUsage();
    expect(reads).toBe(1);
    expect(a).toEqual(b);
    expect(a.context).toMatchObject({ used: 40_000, percent: 20, autoCompactAt: 167_000, source: 'report' });
    const full = await t.rt.contextUsage('full');
    expect(reads).toBe(2);
    expect(full.context?.categories).toEqual([{ name: 'Messages', tokens: 30_000 }]);
    const u = await t.rt.usage();
    expect(u.usage.limits?.limits[0]).toMatchObject({ id: 'five_hour', percent: 12 });
    expect(u.usage.costLabel).toEqual({ text: 'API-equivalent', primary: false });
    expect(t.opened()).toBe(1);
    await t.rt.dispose();
  });

  it('reports a control failure without inventing figures', async () => {
    const t = setup({
      contextUsage: async () => {
        throw new Error('control timed out');
      },
      usageSnapshot: async () => {
        throw new Error('no usage control');
      },
    });
    await t.run([turnEnd]);
    expect(await t.rt.contextUsage()).toEqual({ running: true, reason: 'control timed out' });
    const u = await t.rt.usage();
    expect(u.error).toBe('no usage control');
    expect(u.usage.totals).toBeUndefined();
    await t.rt.dispose();
  });
});
