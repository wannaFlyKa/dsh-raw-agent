// M5 client-usage (R8.1-R8.4; D58-D61, D70): the context pill (in DSH's composer dock, where DSH's
// ring would be), the usage panel (per-turn tokens with cache read/write, cost with its basis,
// per-model usage, subagent and workflow numbers, plan limits with reset times, auth type), the
// usage/context routes, the channel's usage summary, and honest words when a number is missing.

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_PILL_ENTRY_ID,
  CONTEXT_PILL_ORDER,
  CONTEXT_PILL_SLOT,
  ContextPillView,
  SessionControlStore,
  SessionStores,
  UsagePanel,
  UsageReader,
  UsageReaders,
  agentUsageRows,
  categoryColor,
  contextBreakdown,
  contextPill,
  createApi,
  exactCount,
  formatCount,
  formatIn,
  formatUsd,
  limitsModel,
  mountClient,
  parseChannelLine,
  parseUsageAnswer,
  turnRows,
  usagePanelModel,
  type ContextAnswerWire,
  type ContextViewWire,
  type RawAgentApi,
  type SessionInfo,
  type UsageAnswerWire,
  type UsageSummaryWire,
  type UsageViewWire,
} from '@dsh-raw-agent/dsh-client';
import type { TurnUsage } from '@dsh-raw-agent/core';

const flush = () => new Promise((r) => setTimeout(r, 0));

function info(view: Partial<SessionInfo['view']> = {}, over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    backend: { kind: 'k', displayName: 'Agent' },
    permissionModes: [{ id: 'default', label: 'Ask' }],
    efforts: [],
    needsProcess: ['context', 'usage'],
    models: [],
    modelsFrom: 'session',
    view: {
      state: { process: 'running', turn: false, backgroundTasks: 0 },
      live: {},
      choice: { applied: {}, resetPending: false, agentLocked: false },
      ...view,
    },
    ...over,
  } as SessionInfo;
}

const tokens = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
});

const turn = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  main: tokens(3, 40, 15_000, 1200),
  other: tokens(0, 0),
  total: tokens(3, 40, 15_000, 1200),
  calls: 1,
  costUsd: 0.0123,
  apiDurationMs: 1900,
  durationMs: 2400,
  ttftMs: 1916,
  models: [{ model: 'model-a', tokens: tokens(3, 40, 15_000, 1200), costUsd: 0.0123 }],
  costBasis: 'list',
  ...over,
});

const report: ContextViewWire = {
  used: 19_717,
  window: 1_000_000,
  percent: 2,
  autoCompactAt: 967_000,
  autoCompactEnabled: true,
  model: 'model-a',
  source: 'report',
  at: 50,
  categories: [
    { id: 'system_prompt', name: 'System prompt', tokens: 1134, color: 'promptBorder', kind: 'used' },
    { id: 'system_tools', name: 'System tools', tokens: 13_679, color: 'inactive', kind: 'used' },
    { id: 'mcp_tools_deferred', name: 'MCP tools (deferred)', tokens: 150_432, color: 'inactive', kind: 'deferred' },
    { id: 'messages', name: 'Messages', tokens: 132, color: 'purple_FOR_SUBAGENTS_ONLY', kind: 'used' },
    { id: 'autocompact_buffer', name: 'Autocompact buffer', tokens: 33_000, color: 'inactive', kind: 'buffer' },
    { id: 'free_space', name: 'Free space', tokens: 947_283, color: 'promptBorder', kind: 'free' },
  ],
};

const listLabel = { text: 'estimate at list price', primary: true, note: 'Your bill is in your cloud account.' };
const subLabel = { text: 'API-equivalent', primary: false };

describe('number formats', () => {
  it('formats counts, money and times', () => {
    expect(formatCount(950)).toBe('950');
    expect(formatCount(19_717)).toBe('19.7k');
    expect(formatCount(200_000)).toBe('200k');
    expect(formatCount(1_000_000)).toBe('1M');
    expect(formatCount(undefined)).toBe('—');
    expect(exactCount(1234567)).toBe('1,234,567');
    expect(formatUsd(0.0042)).toBe('$0.0042');
    expect(formatUsd(1.5)).toBe('$1.50');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.0123)).toBe('$0.0123');
    expect(formatUsd(0.05)).toBe('$0.05');
    expect(formatIn(7_500_000)).toBe('in 2 h 5 min');
    expect(formatIn(-1)).toBe('now');
  });
});

describe('context pill (D59)', () => {
  it('says the context is not known before the agent reports it, and offers Start with no process', () => {
    const none = contextPill(info({ state: { process: 'none', turn: false, backgroundTasks: 0 } }));
    expect(none).toMatchObject({ text: 'Context —', level: 'unknown', startable: true });
    expect(none.title).toMatch(/No Agent process runs/);
    const running = contextPill(info());
    expect(running).toMatchObject({ text: 'Context —', startable: false });
    expect(running.title).toMatch(/has not reported its context yet/);
  });

  it('shows the newer of the call figure and the agent report, with its source', () => {
    const usage: UsageSummaryWire = {
      compacting: false,
      context: { used: 20_000, window: 200_000, percent: 10, source: 'call', at: 10 },
    };
    const call = contextPill(info({ usage }));
    expect(call.text).toBe('Context 10% · 20k/200k');
    expect(call.title).toMatch(/last model call/);
    const rep = contextPill(info({ usage }), report);
    expect(rep.text).toBe('Context 2% · 19.7k/1M');
    expect(rep.title).toMatch(/own context report/);
    expect(rep.title).toMatch(/Auto-compact at 967,000/);
  });

  it('turns amber and red near the auto-compact point, and shows compaction', () => {
    const at = (used: number) =>
      contextPill(
        info({
          usage: {
            compacting: false,
            context: { used, window: 200_000, percent: used / 2000, autoCompactAt: 160_000, source: 'call', at: 1 },
          },
        }),
      ).level;
    expect(at(10_000)).toBe('ok');
    expect(at(125_000)).toBe('warn');
    expect(at(150_000)).toBe('high');
    expect(contextPill(info({ usage: { compacting: true } })).text).toBe('Compacting…');
  });

  it('shows the plan window for subscriptions and the cost for pay-per-use, never both', () => {
    const ctx = { used: 1000, window: 200_000, percent: 0.5, source: 'call' as const, at: 1 };
    const sub = contextPill(
      info({
        usage: {
          compacting: false,
          context: ctx,
          costUsd: 0.4,
          costLabel: subLabel,
          limitsAvailable: true,
          limit: { id: 'five_hour', label: '5-hour', percent: 23, resetsAt: 10_000 },
        },
      }),
      undefined,
      0,
    );
    expect(sub.extras).toEqual(['5-hour 23%']);
    expect(sub.title).toMatch(/API-equivalent/);
    const key = contextPill(info({ usage: { compacting: false, context: ctx, costUsd: 0.4, costLabel: listLabel } }));
    expect(key.extras).toEqual(['$0.40']);
    const blocked = contextPill(info({ usage: { compacting: false, context: ctx, blocked: true } }));
    expect(blocked.extras).toEqual(['Limit reached']);
  });

  it('keeps showing during background tasks, and names retries', () => {
    const p = contextPill(
      info({
        state: { process: 'running', turn: false, backgroundTasks: 2 },
        usage: { compacting: false, retry: { attempt: 2, maxRetries: 10, error: 'overloaded', at: 1 } },
      }),
    );
    expect(p.extras).toEqual(['Retrying 2/10', '2 in background']);
    expect(p.background).toBe(2);
    expect(p.title).toMatch(/2 background tasks still run/);
  });

  it('renders a button with the reading and extras', () => {
    const html = renderToStaticMarkup(
      React.createElement(ContextPillView, {
        model: contextPill(
          info({
            usage: {
              compacting: false,
              context: { used: 20_000, window: 200_000, percent: 10, source: 'call', at: 1 },
            },
          }),
        ),
      }),
    );
    expect(html).toContain('data-raw-agent="context-pill"');
    expect(html).toContain('Context 10% · 20k/200k');
    expect(html).toContain('<circle');
  });
});

describe('context breakdown (like /context)', () => {
  it('keeps the agent order, splits deferred categories off, and maps theme colours', () => {
    const b = contextBreakdown(report, 'Agent');
    expect(b.head).toBe('19.7k / 1M tokens (2%)');
    expect(b.rows.map((r) => r.name)).toEqual([
      'System prompt',
      'System tools',
      'Messages',
      'Autocompact buffer',
      'Free space',
    ]);
    expect(b.rows.map((r) => r.kind)).toEqual(['used', 'used', 'used', 'buffer', 'free']);
    expect(b.deferred.map((r) => r.name)).toEqual(['MCP tools (deferred)']);
    expect(b.rows[4]?.color).toBe('transparent');
    expect(b.rows[2]?.color).toBe(categoryColor('purple', 0));
    expect(b.autoCompact).toBe('Auto-compact at 967k (97%)');
    expect(categoryColor('nonsense', 1)).toMatch(/^#/);
  });

  it('says why there is no breakdown for a call figure', () => {
    const b = contextBreakdown({ used: 10, window: 100, percent: 10, source: 'call', at: 1 }, 'Agent');
    expect(b.rows).toEqual([]);
    expect(b.note).toMatch(/reported only a total/);
    expect(contextBreakdown({ ...report, autoCompactEnabled: false }, 'Agent').autoCompact).toBe('Auto-compact is off');
  });
});

describe('usage panel model (R8.1, R8.3)', () => {
  const view = (over: Partial<UsageViewWire> = {}): UsageViewWire => ({
    turns: [],
    compacting: false,
    compactions: [],
    retries: [],
    resets: [],
    ...over,
  });

  it('shows per-turn tokens with cache read/write, other tokens, cost basis and missing times', () => {
    const rows = turnRows(
      [
        { hostTurn: 2, usage: turn(), at: 1 },
        { usage: turn({ other: tokens(10, 5, 100, 20), ttftMs: undefined, durationMs: undefined }), at: 2 },
      ],
      listLabel,
    );
    expect(rows[0]?.label).toBe('Background'); // newest first; it ran outside a host turn
    expect(rows[0]?.other).toMatch(/^135 tokens/);
    expect(rows[0]?.facts).toContain('first-token time not reported');
    expect(rows[0]?.facts).toContain('duration not reported');
    expect(rows[1]?.label).toBe('Turn 2');
    expect(rows[1]?.main).toEqual(
      expect.arrayContaining([
        { label: 'Cache read', value: '15,000' },
        { label: 'Cache write', value: '1,200' },
        { label: 'Output', value: '40' },
      ]),
    );
    expect(rows[1]?.cost).toBe('$0.0123 · estimate at list price');
    expect(rows[1]?.other).toBeUndefined();
  });

  it('builds totals, per-model rows, account and cost notes', () => {
    const u: UsageAnswerWire = {
      running: true,
      usage: view({
        totals: {
          tokens: tokens(10, 400, 30_000, 2000),
          costUsd: 0.05,
          apiDurationMs: 4000,
          models: [
            {
              model: 'model-a',
              tokens: tokens(10, 400, 30_000, 2000),
              costUsd: 0.05,
              contextWindow: 200_000,
              costBasis: 'managed',
              provider: 'bedrock',
            },
          ],
          costBasis: 'managed',
        },
        costLabel: listLabel,
        auth: { kind: 'bedrock', label: 'Amazon Bedrock', provider: 'bedrock' },
        limits: { available: false, limits: [], note: 'No plan limits for this account (Amazon Bedrock).' },
      }),
    };
    const m = usagePanelModel(info(), u, undefined);
    expect(m.totals?.total).toBe('32,410 tokens');
    expect(m.totals?.cost).toBe('$0.05 · estimate at list price');
    expect(m.models[0]?.details).toEqual(
      expect.arrayContaining(['context window 200k', 'managed price', 'served by bedrock']),
    );
    expect(m.account.lines).toEqual(expect.arrayContaining([{ label: 'Type', value: 'Amazon Bedrock' }]));
    expect(m.account.costNote).toContain('Your bill is in your cloud account.');
    expect(m.limits).toEqual({ rows: [], note: 'No plan limits for this account (Amazon Bedrock).' });
    expect(m.contextNote).toMatch(/has not reported its context/);
  });

  it('shows plan limits with reset times for subscriptions, and no bar for an unreported window', () => {
    const l = limitsModel(
      view({
        auth: { kind: 'subscription', label: 'Max plan', subscriptionType: 'max' },
        limits: {
          available: true,
          limits: [
            {
              id: 'five_hour',
              label: '5-hour',
              percent: 23,
              resetsAt: 7_500_000,
              status: 'allowed',
              source: 'event',
              at: 1,
            },
            { id: 'seven_day', label: 'Weekly', percent: 104, status: 'rejected', source: 'usage-api', at: 1 },
            { id: 'seven_day_opus', label: 'Weekly (big model)', source: 'usage-api', at: 1 },
          ],
          blocked: { resetsAt: 7_500_000 },
        },
      }),
      true,
      'Agent',
      0,
    );
    expect(l.rows[0]).toMatchObject({ value: '23% used', bar: 23 });
    expect(l.rows[0]?.reset).toMatch(/^resets in 2 h 5 min/);
    expect(l.rows[1]).toMatchObject({ value: '104% used', bar: 100, status: 'limit reached' });
    expect(l.rows[2]).toMatchObject({ value: 'not reported' });
    expect(l.rows[2]?.bar).toBeUndefined();
    expect(l.blocked).toMatch(/refused until the limit resets \(resets in 2 h 5 min/);
  });

  it('says the limits are not known yet instead of a 0 %', () => {
    expect(limitsModel(undefined, true, 'Agent').note).toMatch(/has not said yet/);
    expect(limitsModel(undefined, false, 'Agent').note).toMatch(/Start Agent/);
    expect(limitsModel(view({ limits: { available: true, limits: [] } }), true, 'Agent').note).toMatch(
      /not reported a plan window/,
    );
  });

  it('subscription cost is API-equivalent and secondary', () => {
    const m = usagePanelModel(
      info(),
      { running: true, usage: view({ costLabel: subLabel, auth: { kind: 'subscription', label: 'Pro plan' } }) },
      undefined,
    );
    expect(m.account.costNote[0]).toMatch(/API-equivalent: what the same use would cost with an API key/);
  });

  it('lists subagent and workflow numbers with the agent counting rule', () => {
    const rows = agentUsageRows(
      [
        {
          id: 'c1',
          parent: 'main',
          label: 'Explore',
          role: 'subagent',
          status: 'completed',
          background: false,
          depth: 1,
          startedAt: 1,
          wakes: 0,
          inputs: 0,
          tokens: 12_345,
          toolUses: 3,
          durationMs: 4000,
        },
        {
          id: 'w1a',
          parent: 'main',
          label: 'wf agent',
          role: 'workflow-agent',
          status: 'running',
          background: true,
          depth: 1,
          startedAt: 1,
          wakes: 0,
          inputs: 0,
        },
        {
          id: 't1',
          parent: 'main',
          label: 'mate',
          name: 'alice',
          role: 'teammate',
          status: 'running',
          background: true,
          depth: 1,
          startedAt: 1,
          wakes: 0,
          inputs: 0,
        },
      ],
      [
        {
          taskId: 'wt',
          runId: 'wf_1',
          name: 'audit',
          status: 'running',
          phases: [],
          agents: [
            { index: 1, label: 'a1', state: 'done', tokens: 17_348 },
            { index: 2, label: 'a2', state: 'running' },
          ],
          startedAt: 1,
        },
      ],
    );
    expect(rows.map((r) => [r.kind, r.label, r.tokens])).toEqual([
      ['subagent', 'Explore', '12.3k tokens'],
      ['teammate', 'alice', 'tokens not reported yet'],
      ['workflow', 'audit', '17.3k tokens'],
      ['workflow-agent', 'a1', '17.3k tokens'],
      ['workflow-agent', 'a2', 'not reported yet'],
    ]);
    expect(rows[0]?.facts).toEqual(['completed', '3 tool uses', '4 s']);
  });

  it('lists compactions, resets and retries, and the background note', () => {
    const m = usagePanelModel(
      info({ state: { process: 'running', turn: false, backgroundTasks: 1 } }),
      {
        running: true,
        usage: view({
          compactions: [{ phase: 'end', trigger: 'auto', preTokens: 160_000, postTokens: 12_000, at: 5 }],
          resets: [{ trigger: 'clear', at: 6 }],
          retries: [{ attempt: 1, maxRetries: 10, error: 'overloaded', httpStatus: 529, at: 7 }],
        }),
        error: 'timeout',
      },
      undefined,
    );
    expect(m.events[0]).toMatch(/^Auto-compacted from 160k to 12k tokens/);
    expect(m.events[1]).toMatch(/^Conversation cleared \(clear\) · totals restart at 0/);
    expect(m.events[2]).toBe('Retry 1/10: overloaded (HTTP 529)');
    expect(m.background).toMatch(/1 background task runs/);
    expect(m.error).toMatch(/could not be read: timeout/);
  });

  it('renders every tab without crashing, and offers Start with no process', () => {
    const base = info({ state: { process: 'none', turn: false, backgroundTasks: 0 } });
    const m = usagePanelModel(
      base,
      { running: false, usage: view({ context: report, turns: [{ hostTurn: 1, usage: turn(), at: 1 }] }) },
      undefined,
    );
    for (const tab of ['context', 'session', 'turns', 'agents', 'limits'] as const) {
      const html = renderToStaticMarkup(
        React.createElement(UsagePanel, { model: m, initialTab: tab, onStart: () => {} }),
      );
      expect(html).toContain('data-raw-agent="usage-panel"');
      expect(html).toContain('Start Agent');
    }
    const ctx = renderToStaticMarkup(React.createElement(UsagePanel, { model: m, initialTab: 'context' }));
    expect(ctx).toContain('System prompt');
    expect(ctx).toContain('Deferred');
    const turns = renderToStaticMarkup(React.createElement(UsagePanel, { model: m, initialTab: 'turns' }));
    expect(turns).toContain('Cache write');
    expect(turns).toContain('Turn 1');
  });
});

describe('usage routes and channel (D62)', () => {
  it('reads the usage and context routes with GET, never a start', async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const api = createApi(async (url, init) => {
      calls.push({ url, ...(init?.method ? { method: init.method } : {}) });
      if (url.startsWith('api/raw-agent/usage'))
        return {
          status: 200,
          ok: true,
          json: async () => ({ running: true, usage: { turns: [{ usage: turn(), at: 1 }, 'junk'] } }),
        };
      return { status: 200, ok: true, json: async () => ({ running: false, reason: 'not-running', context: report }) };
    });
    const u = await api.usage('s 1');
    expect(u.usage.turns).toHaveLength(1);
    expect(u.usage.compactions).toEqual([]);
    const c = await api.context('s 1', 'full');
    expect(c).toMatchObject({ running: false, reason: 'not-running', context: { used: 19_717, source: 'report' } });
    expect(calls).toEqual([
      { url: 'api/raw-agent/usage?session=s%201' },
      { url: 'api/raw-agent/context?session=s%201&detail=full' },
    ]);
  });

  it('drops an unusable context figure instead of showing 0', () => {
    expect(
      parseUsageAnswer({ running: true, usage: { context: { used: 0, window: 0 } } as never }).usage.context,
    ).toBeUndefined();
  });

  it('carries the usage summary on the channel; null clears it, absent keeps it', async () => {
    const line = parseChannelLine(JSON.stringify({ type: 'asks', asks: [], usage: { compacting: false, tokens: 9 } }));
    expect(line).toMatchObject({ usage: { tokens: 9 } });
    expect(parseChannelLine(JSON.stringify({ type: 'asks', asks: [], usage: null }))).toMatchObject({ usage: null });
    expect(parseChannelLine(JSON.stringify({ type: 'asks', asks: [] }))).not.toHaveProperty('usage');

    const lines: string[] = [JSON.stringify({ type: 'asks', asks: [], usage: { compacting: false, tokens: 42 } })];
    let push: (() => void) | undefined;
    const base = info();
    const api: RawAgentApi = {
      ...createApi(async () => ({ status: 500, ok: false, json: async () => ({}) })),
      session: async () => base,
      async interactions(_id, signal, onLine) {
        push = () => {
          for (const l of lines.splice(0)) onLine(parseChannelLine(l) as never);
        };
        push();
        await new Promise<void>((r) => signal.addEventListener('abort', () => r()));
      },
    };
    const store = new SessionControlStore('s1', api);
    const off = store.subscribe(() => {});
    await flush();
    await flush();
    expect(store.getSnapshot().info?.view.usage).toEqual({ compacting: false, tokens: 42 });
    lines.push(JSON.stringify({ type: 'asks', asks: [], usage: null }));
    push?.();
    expect(store.getSnapshot().info?.view.usage).toBeUndefined();
    off();
    store.dispose();
  });
});

describe('usage reader (D59: turn 1, turn end, compaction, reset)', () => {
  const fake = () => {
    const calls: string[] = [];
    let ctxAnswer: ContextAnswerWire = { running: true, context: report };
    const api: RawAgentApi = {
      ...createApi(async () => ({ status: 500, ok: false, json: async () => ({}) })),
      usage: async () => {
        calls.push('usage');
        return { running: true, usage: { turns: [], compacting: false, compactions: [], retries: [], resets: [] } };
      },
      context: async (_id, detail) => {
        calls.push(`context:${detail}`);
        return ctxAnswer;
      },
    };
    return { api, calls, setContext: (c: ContextAnswerWire) => (ctxAnswer = c) };
  };
  const view = (over: Partial<SessionInfo['view']> = {}) => info(over).view;

  it('reads the report when the process is up, after a turn, a compaction and a reset', async () => {
    const f = fake();
    const r = new UsageReader('s1', f.api);
    expect(r.watch(view({ state: { process: 'none', turn: false, backgroundTasks: 0 } }))).toEqual({});
    expect(r.watch(view())).toEqual({ context: 'summary' }); // the process came up: turn 1 reads
    await flush();
    expect(r.report?.categories).toHaveLength(6);
    expect(r.watch(view({ state: { process: 'running', turn: true, backgroundTasks: 0 } }))).toEqual({});
    expect(r.watch(view())).toEqual({ context: 'summary' }); // the turn ended
    r.watch(view({ usage: { compacting: true } }));
    expect(r.watch(view({ usage: { compacting: false } }))).toEqual({ context: 'summary' });
    r.watch(
      view({ usage: { compacting: false, context: { used: 1, window: 10, percent: 10, source: 'call', at: 1 } } }),
    );
    expect(r.watch(view({ usage: { compacting: false } }))).toEqual({ context: 'summary' }); // reset (D70)
    await flush();
    expect(f.calls.every((c) => c === 'context:summary')).toBe(true);
  });

  it('reads the usage and the full breakdown while the panel is open, and keeps the last figure', async () => {
    const f = fake();
    const r = new UsageReader('s1', f.api);
    r.watch(view({ usage: { compacting: false, at: 1 } }));
    await flush();
    f.calls.length = 0;
    r.setOpen(true);
    await flush();
    expect(f.calls.sort()).toEqual(['context:full', 'usage']);
    f.calls.length = 0;
    // A new stamp alone is what the route read itself causes: no read, or the panel loops (M5 live).
    expect(r.watch(view({ usage: { compacting: false, at: 2 } }))).toEqual({});
    expect(
      r.watch(view({ usage: { compacting: false, at: 3, context: { used: 1, window: 10, source: 'report', at: 3 } } })),
    ).toEqual({ usage: true });
    expect(
      r.watch(view({ usage: { compacting: false, at: 4, context: { used: 1, window: 10, source: 'report', at: 4 } } })),
    ).toEqual({});
    expect(
      r.watch(
        view({
          usage: { compacting: false, at: 5, tokens: 7, context: { used: 1, window: 10, source: 'report', at: 5 } },
        }),
      ),
    ).toEqual({ usage: true });
    await flush();
    expect(f.calls).toEqual(['usage', 'usage']);
    f.setContext({ running: false, reason: 'not-running' });
    await r.read({ context: 'summary' });
    expect(r.getSnapshot().context).toMatchObject({ reason: 'not-running', context: { used: 19_717 } });
    r.setOpen(false);
    expect(
      r.watch(
        view({
          usage: { compacting: false, at: 6, tokens: 8, context: { used: 1, window: 10, source: 'report', at: 6 } },
        }),
      ),
    ).toEqual({});
  });

  it('merges reads asked for while one is in flight', async () => {
    let release: (() => void) | undefined;
    let n = 0;
    const api: RawAgentApi = {
      ...createApi(async () => ({ status: 500, ok: false, json: async () => ({}) })),
      context: async () => {
        n++;
        await new Promise<void>((res) => (release = res));
        return { running: true, context: report };
      },
    };
    const r = new UsageReader('s1', api);
    const first = r.read({ context: 'summary' });
    void r.read({ context: 'summary' });
    void r.read({ context: 'full' });
    await flush();
    release?.();
    await flush();
    release?.();
    await first;
    expect(n).toBe(2);
    expect(r.getSnapshot().reads).toBe(2);
  });

  it('a route error is shown, not thrown', async () => {
    const api: RawAgentApi = {
      ...createApi(async () => ({ status: 500, ok: false, json: async () => ({ error: 'boom' }) })),
    };
    const r = new UsageReader('s1', api);
    await r.read({ usage: true });
    expect(r.getSnapshot().error).toBe('boom');
  });

  it('readers watch the store without making it poll', async () => {
    const f = fake();
    const base = info();
    const stores = new SessionStores({ ...f.api, session: async () => base });
    const readers = new UsageReaders(stores, { ...f.api, session: async () => base });
    const r = readers.get('s1');
    expect(readers.get('s1')).toBe(r);
    expect(f.calls).toEqual([]); // the store is not ready yet: nothing read
    await stores.get('s1').refresh();
    await flush();
    expect(f.calls).toEqual(['context:summary']);
    readers.dispose();
    stores.dispose();
  });
});

describe('port: the pill sits in the composer dock (D59)', () => {
  it('registers the pill after DSH token pill, with the session store and reader', () => {
    const registered: Array<{ options: Record<string, unknown> }> = [];
    const ctx = {
      slots: {
        inject: (_key: string, cb: () => (() => void) | Iterable<() => void>) => {
          cb();
          return () => {};
        },
        register: (options: Record<string, unknown>) => {
          registered.push({ options });
          return () => {};
        },
      },
      get: () => undefined,
    };
    const base = info();
    mountClient(ctx, {
      api: {
        ...createApi(async () => ({ status: 404, ok: false, json: async () => ({}) })),
        session: async () => base,
      },
    });
    const pill = registered.find((r) => r.options.id === CONTEXT_PILL_ENTRY_ID);
    expect(pill?.options).toMatchObject({ name: CONTEXT_PILL_SLOT, order: CONTEXT_PILL_ORDER });
    expect(CONTEXT_PILL_SLOT).toBe('conversation.composer.dock');
    const injected = (pill?.options.inject as (id: string) => Record<string, unknown>)('s1');
    expect(injected.store).toBeInstanceOf(SessionControlStore);
    expect(injected.reader).toBeInstanceOf(UsageReader);
  });
});
