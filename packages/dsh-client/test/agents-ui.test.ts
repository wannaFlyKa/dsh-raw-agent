// M3 client-agents (R6.1-R6.4): the child tree and rows, the team roster, the task list, the
// main-thread agent picker, the wake trigger card and Definition, the child session's link to its
// parent, and a child's ask shown on the child's own session.

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  AgentsPanel,
  ChildLinkStore,
  SessionControlStore,
  SessionControls,
  SessionStores,
  START_OPTION,
  WAKE_NODE_KIND,
  WakeNode,
  WakeTriggerCard,
  agentCounts,
  agentSelect,
  agentsButtonText,
  childAddress,
  childChatAddress,
  childLastLine,
  childStats,
  childTree,
  createApi,
  formatDuration,
  formatTokens,
  hostActions,
  parseChannelLine,
  publishAsks,
  RouteError,
  rosterModel,
  selectAsk,
  wakeDefinition,
  wakeHeading,
  wakeTriggerOf,
  type AskInteraction,
  type AskWire,
  type ChannelLine,
  type ChildWire,
  type HostActions,
  type RawAgentApi,
  type SessionInfo,
  type TimerApi,
} from '@dsh-raw-agent/dsh-client';

const child = (over: Partial<ChildWire> & { id: string }): ChildWire => ({
  parent: 'main',
  label: over.id,
  role: 'subagent',
  status: 'running',
  background: false,
  depth: 1,
  startedAt: 1000,
  wakes: 0,
  inputs: 0,
  ...over,
});

function info(view: Partial<SessionInfo['view']> = {}, over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    backend: { kind: 'k', displayName: 'Agent' },
    permissionModes: [{ id: 'default', label: 'Ask' }],
    efforts: [],
    needsProcess: [],
    models: [],
    modelsFrom: 'session',
    mainAgentPicker: 'new-session-only',
    agents: [],
    agentsFrom: 'none',
    view: {
      state: { process: 'running', turn: false, backgroundTasks: 0 },
      live: {},
      choice: { applied: {}, resetPending: false, agentLocked: false },
      ...view,
    },
    ...over,
  } as SessionInfo;
}

const childAsk = (over: Partial<AskWire> = {}): AskWire => ({
  id: 'a1',
  kind: 'permission',
  agent: 'child',
  agentId: 'c1',
  agentLabel: 'helper',
  title: 'helper: Bash wants to run',
  choices: [{ id: 'yes', label: 'Yes' }],
  stopChoice: 'no',
  at: 5,
  ...over,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

function manualTimers() {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  const timers: TimerApi = {
    set: (fn, ms) => {
      const t = { fn, ms };
      pending.push(t);
      return t;
    },
    clear: (h) => {
      const i = pending.indexOf(h as never);
      if (i >= 0) pending.splice(i, 1);
    },
  };
  return { timers, pending };
}

const noActions: HostActions = {
  openPreview: () => false,
  openTerminal: () => false,
  copy: async () => false,
  portal: (n) => n,
};

function fakeApi(base: SessionInfo, over: Partial<RawAgentApi> = {}): RawAgentApi {
  return {
    ...createApi(async () => ({ status: 500, ok: false, json: async () => ({}) })),
    session: async () => base,
    ...over,
  };
}

describe('child tree and rows (R6.1)', () => {
  it('nests children under their parent child, in start order; unknown parents go on top', () => {
    const rows = childTree([
      child({ id: 'b', startedAt: 3 }),
      child({ id: 'inner', parent: 'a', startedAt: 4, depth: 2 }),
      child({ id: 'a', startedAt: 1 }),
      child({ id: 'orphan', parent: 'gone', startedAt: 2 }),
    ]);
    expect(rows.map((r) => [r.child.id, r.level, r.hasChildren])).toEqual([
      ['a', 0, true],
      ['inner', 1, false],
      ['orphan', 0, false],
      ['b', 0, false],
    ]);
    // A cycle still shows every child once.
    expect(childTree([child({ id: 'x', parent: 'y' }), child({ id: 'y', parent: 'x' })])).toHaveLength(2);
  });

  it('formats tokens, time and the latest output', () => {
    expect(formatTokens(950)).toBe('950 tokens');
    expect(formatTokens(12_345)).toBe('12k tokens');
    expect(formatTokens(1_234)).toBe('1.2k tokens');
    expect(formatTokens(2_500_000)).toBe('2.5M tokens');
    expect(formatTokens(undefined)).toBeUndefined();
    expect(formatDuration(42_000)).toBe('42 s');
    expect(formatDuration(185_000)).toBe('3 min 5 s');
    expect(formatDuration(3_720_000)).toBe('1 h 2 min');
    expect(childStats(child({ id: 'c', tokens: 21773, toolUses: 2 }), 61_000)).toBe('22k tokens · 2 tool uses · 1 min');
    expect(childStats(child({ id: 'c', status: 'completed', durationMs: 5000 }), 9e9)).toBe('5 s');
    // A stale CLI run time (from an early progress frame) never hides the real wall time.
    expect(childStats(child({ id: 'c', status: 'completed', durationMs: 1700, endedAt: 31_000 }), 9e9)).toBe('30 s');
    expect(childLastLine(child({ id: 'c', last: { kind: 'tool', text: 'Bash', at: 1 } }))).toBe('Calling Bash');
    expect(childLastLine(child({ id: 'c', last: { kind: 'reasoning', text: 'hmm', at: 1 } }))).toBe('Thinking: hmm');
  });

  it('counts running children, waiting child asks and tasks for the header button', () => {
    const view = info({
      children: [child({ id: 'c1' }), child({ id: 'c2', status: 'completed' })],
      asks: [childAsk(), { ...childAsk({ id: 'm', agent: 'main' }) }],
      tasks: [{ taskId: 't', kind: 'shell', label: 'x', status: 'running', job: true }],
    }).view;
    const counts = agentCounts(view);
    expect(counts).toMatchObject({ children: 2, running: 1, waiting: 1, tasks: 1, tasksRunning: 1 });
    expect(agentsButtonText(counts)).toBe('Agents 2 · 1 running · 1 waiting · 1 task');
    expect(agentsButtonText(agentCounts(info({ tasks: view.tasks! }).view))).toBe('Tasks 1 · 1 running');
  });

  it('a child address names the main session, or the parent child session for a nested agent', () => {
    const outer = child({ id: 'o', hostSessionId: 'host-o' });
    const inner = child({ id: 'i', parent: 'o', hostSessionId: 'host-i' });
    expect(childAddress('main-s', [outer, inner], outer)).toEqual({
      parentSessionId: 'main-s',
      childSessionId: 'host-o',
      mode: 'one-shot',
    });
    expect(childAddress('main-s', [outer, inner], inner)?.parentSessionId).toBe('host-o');
    expect(childAddress('main-s', [outer], child({ id: 'n' }))).toBeUndefined();
    expect(childChatAddress({ parentSessionId: 'p', childSessionId: 'c 1', mode: 'one-shot' })).toBe(
      'dsh-resource://subagentchat/session/c%201?parent=p&mode=one-shot',
    );
  });

  it('the panel shows status, numbers, output, the waiting ask, Open and a per-child Stop', () => {
    const base = info({
      children: [
        child({
          id: 'c1',
          label: 'echo helper',
          tokens: 1500,
          toolUses: 1,
          hostSessionId: 'hc1',
          last: { kind: 'text', text: 'Reading', at: 2 },
        }),
        child({ id: 'c2', parent: 'c1', status: 'completed', hostSessionId: 'hc2' }),
      ],
      asks: [childAsk()],
    });
    const store = new SessionControlStore('s1', fakeApi(base));
    // Seed the snapshot as a read would.
    (store as unknown as { refresh(): Promise<void> }).refresh();
    return flush().then(() => {
      const html = renderToStaticMarkup(
        React.createElement(AgentsPanel, {
          store,
          actions: { ...noActions, openChild: () => true, openChildAside: () => true },
        }),
      );
      expect(html).toContain('echo helper');
      expect(html).toContain('1.5k tokens');
      expect(html).toContain('Reading');
      expect(html).toContain('Waiting for your approval');
      expect(html).toContain('data-raw-agent="child-stop"');
      expect((html.match(/data-raw-agent="child-stop"/g) ?? []).length).toBe(1); // only the running one
      expect(html).toContain('Open beside');
      expect(html).toContain('padding-left:16px'); // the nested child is indented
      store.dispose();
    });
  });

  it('Stop calls the child route, tracks the click and shows a refusal', async () => {
    const calls: string[] = [];
    let ok = true;
    const api = fakeApi(info({ children: [child({ id: 'c1' })] }), {
      stopChild: async (_s, id) => {
        calls.push(id);
        return ok ? { ok: true, status: 'stopped' } : { ok: false, error: 'cannot stop' };
      },
    });
    const store = new SessionControlStore('s1', api);
    expect(await store.stopChild('c1')).toBe(true);
    expect(calls).toEqual(['c1']);
    expect(store.getSnapshot().stopping).toEqual([]);
    ok = false;
    expect(await store.stopChild('c1')).toBe(false);
    expect(store.getSnapshot().stopError).toEqual({ id: 'c1', text: 'cannot stop' });
    store.dispose();
  });

  it('the API posts child-stop and task-stop with ids, and child-of answers a link or nothing', async () => {
    const seen: Array<[string, string | undefined]> = [];
    const api = createApi(async (url, init) => {
      seen.push([url, init?.method]);
      if (url.startsWith('api/raw-agent/child-of')) {
        if (url.includes('miss')) return { status: 404, ok: false, json: async () => ({}) };
        return { status: 200, ok: true, json: async () => ({ parentSession: 'p', childId: 'c' }) };
      }
      return { status: 200, ok: true, json: async () => ({ ok: true }) };
    });
    expect(await api.stopChild('s 1', 'task/1')).toEqual({ ok: true });
    expect(await api.stopTask('s', 't1')).toEqual({ ok: true });
    expect(await api.childOf('hit')).toEqual({ parentSession: 'p', childId: 'c' });
    expect(await api.childOf('miss')).toBeUndefined();
    expect(seen.slice(0, 2)).toEqual([
      ['api/raw-agent/child-stop?session=s%201&child=task%2F1', 'POST'],
      ['api/raw-agent/task-stop?session=s&task=t1', 'POST'],
    ]);
  });
});

describe('agent rows on the interaction channel', () => {
  it('parses the rows, and the store applies them at once', async () => {
    const line = parseChannelLine(
      JSON.stringify({
        type: 'asks',
        asks: [],
        children: [{ id: 'c1', label: 'x' }, { bad: 1 }],
        team: null,
        tasks: [],
      }),
    );
    expect(line).toMatchObject({ type: 'asks', agents: { children: [{ id: 'c1', label: 'x' }], tasks: [] } });
    expect(parseChannelLine('{"type":"asks","asks":[]}')).not.toHaveProperty('agents');

    let emit: ((l: ChannelLine) => void) | undefined;
    const api = fakeApi(info({ children: [child({ id: 'old' })] }), {
      interactions: (_s, signal, onLine) =>
        new Promise<void>((resolve) => {
          emit = onLine;
          signal.addEventListener('abort', () => resolve());
        }),
    });
    const { timers } = manualTimers();
    const store = new SessionControlStore('s1', api, timers);
    const off = store.subscribe(() => {});
    await flush();
    await flush();
    emit?.({ type: 'asks', asks: [], agents: { children: [child({ id: 'new' })], tasks: [] } });
    expect(store.getSnapshot().info?.view.children?.map((c) => c.id)).toEqual(['new']);
    emit?.({ type: 'asks', asks: [], agents: { children: [], tasks: [] } });
    expect(store.getSnapshot().info?.view.children).toBeUndefined();
    off();
  });
});

describe('team roster (R6.3, D50)', () => {
  it('groups teammates, names senders and explains the disabled message box', () => {
    const view = info({
      children: [
        child({ id: 'tA', role: 'teammate', name: 'alice', team: 'crew' }),
        child({
          id: 'tB',
          role: 'teammate',
          name: 'bob',
          team: 'crew',
          wakes: 2,
          wokenBy: 'alice',
          hostSessionId: 'hb',
        }),
      ],
      team: {
        teams: [{ name: 'crew', members: ['tA', 'tB'] }],
        messages: [
          { from: 'alice', to: 'bob', text: 'hi bob', sender: 'tA', at: 1 },
          { from: '', to: 'alice', text: 'start', sender: 'main', at: 2 },
        ],
        messaging: false,
      },
    }).view;
    const r = rosterModel(view, 'Agent')!;
    expect(r.teams).toEqual([{ name: 'crew', members: [view.children![0], view.children![1]] }]);
    expect(r.messages.map((m) => m.from)).toEqual(['alice', 'Agent (main)']);
    expect(r.messaging).toBe(false);
    expect(r.messagingNote).toContain('does not take a message');
    expect(rosterModel(info().view, 'Agent')).toBeUndefined();
  });

  it('the Team tab lists members with Open transcript, the messages, and a disabled box', async () => {
    const base = info({
      children: [
        child({
          id: 'tB',
          role: 'teammate',
          name: 'bob',
          team: 'crew',
          wakes: 1,
          wokenBy: 'alice',
          hostSessionId: 'hb',
        }),
      ],
      team: {
        teams: [{ name: 'crew', members: ['tB'] }],
        messages: [{ from: 'alice', to: 'bob', text: 'hi bob', sender: 'x', at: 1 }],
        messaging: false,
      },
    });
    const store = new SessionControlStore('s1', fakeApi(base));
    await store.refresh();
    const html = renderToStaticMarkup(
      React.createElement(AgentsPanel, { store, actions: { ...noActions, openChild: () => true }, initialTab: 'team' }),
    );
    expect(html).toContain('data-raw-agent="team-roster"');
    expect(html).toContain('Open transcript');
    expect(html).toContain('woken once, last by alice');
    expect(html).toContain('alice → bob');
    expect(html).toMatch(/<textarea[^>]*disabled/);
    store.dispose();
  });
});

describe('main-thread agent picker (R6.4)', () => {
  it('lists the agents with "none" first, and offers Start before a process runs', () => {
    const m = agentSelect(
      info({}, { agents: [{ name: 'pirate', description: 'Arr', model: 'sonnet' }], agentsFrom: 'session' }),
    )!;
    expect(m.options.map((o) => o.value)).toEqual(['settings', 'pirate']);
    expect(m.options[1]!.hint).toBe('Arr Model: sonnet');
    expect(m.locked).toBe(false);
    const cold = agentSelect(
      info({ state: { process: 'none', turn: false, backgroundTasks: 0 } }, { agents: [], agentsFrom: 'none' }),
    )!;
    expect(cold.options.at(-1)).toEqual({ value: START_OPTION, label: 'Start Agent to list agents' });
    const recent = agentSelect(info({}, { agents: [{ name: 'x' }], agentsFrom: 'recent' }))!;
    expect(recent.title).toContain('may differ');
  });

  it('after the first turn it shows the seated agent read-only, or nothing', () => {
    const locked = agentSelect(
      info({ live: { agent: 'pirate' }, choice: { applied: {}, resetPending: false, agentLocked: true } }),
    )!;
    expect(locked).toMatchObject({ value: 'pirate', locked: true });
    expect(locked.options).toEqual([{ value: 'pirate', label: 'Agent: pirate' }]);
    expect(agentSelect(info({ choice: { applied: {}, resetPending: false, agentLocked: true } }))).toBeUndefined();
    expect(agentSelect(info({}, { mainAgentPicker: 'none' }))).toBeUndefined();
  });

  it('the controls row renders the picker; a locked picker is disabled', async () => {
    const base = info({ live: { agent: 'pirate' }, choice: { applied: {}, resetPending: false, agentLocked: true } });
    const store = new SessionControlStore('s1', fakeApi(base));
    await store.refresh();
    const html = renderToStaticMarkup(
      React.createElement(SessionControls, { store, api: fakeApi(base), actions: noActions }),
    );
    expect(html).toMatch(/<select[^>]*disabled=""[^>]*data-raw-agent="agent"/);
    store.dispose();
  });
});

describe('wake trigger (D26)', () => {
  const event = (source: Record<string, unknown>, text = 'Agent continued on its own after: a; b') => ({
    type: 'developer/message',
    seq: 12,
    time: 1_700_000_000_000,
    data: { turn: 3, step: 1, message: { id: 'm1', role: 'developer', content: [{ type: 'text', text }], source } },
  });

  it('reads the Host trigger, and nothing else', () => {
    const t = wakeTriggerOf(event({ kind: 'raw-agent-wake', form: 'notice', items: ['a', 'b', 3] }))!;
    expect(t).toEqual({
      seq: 12,
      time: 1_700_000_000_000,
      text: 'Agent continued on its own after: a; b',
      items: ['a', 'b'],
    });
    expect(wakeHeading(t)).toBe('Agent continued on its own');
    expect(wakeTriggerOf(event({ kind: 'other' }))).toBeNull();
    expect(wakeTriggerOf({ type: 'user/message', seq: 1, time: 1, data: {} })).toBeNull();
  });

  it('the Definition claims only the trigger and builds one visible input-group node', () => {
    const def = wakeDefinition() as {
      target: string;
      match(e: unknown): unknown;
      start(c: unknown, m: { event: unknown }): unknown;
      buildViewNode(c: unknown): Record<string, unknown> | null;
    };
    expect(def.target).toBe('chat');
    const ev = event({ kind: 'raw-agent-wake', form: 'notice' });
    expect(def.match(ev)).toEqual({ id: 'm1', role: 'start', exclusive: true });
    expect(def.match(event({ kind: 'plugin-x', form: 'notice' }))).toBeNull();
    expect(def.match({ type: 'assistant/message', seq: 1, time: 1, data: {} })).toBeNull();
    const state = def.start({}, { event: ev });
    const node = def.buildViewNode({ key: 'k', id: 'm1', state, start: { location: { kind: 'step' } }, matches: [] })!;
    expect(node).toMatchObject({
      kind: WAKE_NODE_KIND,
      target: 'chat',
      groupTree: 'input',
      visibility: 'visible',
      anchorSeq: 12,
    });
    expect(def.buildViewNode({ key: 'k', id: 'm1', matches: [] })).toBeNull();
  });

  it('the card names what woke the agent and that nothing was sent to it', () => {
    const one = renderToStaticMarkup(
      React.createElement(WakeTriggerCard, {
        trigger: { seq: 1, time: 0, text: 'Agent continued on its own after: x', items: ['x'] },
      }),
    );
    expect(one).toContain('Agent continued on its own');
    expect(one).toContain('after: x');
    expect(one).toContain('not sent to it');
    const many = renderToStaticMarkup(
      React.createElement(WakeNode, { node: { data: { seq: 1, time: 0, text: 't after: a; b', items: ['a', 'b'] } } }),
    );
    expect(many).toContain('After 2 background tasks ended');
  });
});

describe('a child session of ours (R6.1, D45, D77)', () => {
  it('the link store retries a quick miss, then finds the parent', async () => {
    let n = 0;
    const api = fakeApi(info(), {
      childOf: async () => (++n < 2 ? undefined : { parentSession: 'p', childId: 'c' }),
    });
    const { timers, pending } = manualTimers();
    const link = new ChildLinkStore('host-child', api, timers, [10]);
    link.subscribe(() => {});
    await flush();
    expect(link.getSnapshot().status).toBe('loading');
    pending.shift()!.fn();
    await flush();
    expect(link.getSnapshot()).toEqual({ status: 'found', link: { parentSession: 'p', childId: 'c' } });
  });

  it('the link store gives up after its retries (a session that is not our child)', async () => {
    const { timers, pending } = manualTimers();
    const link = new ChildLinkStore('x', fakeApi(info(), { childOf: async () => undefined }), timers, [10]);
    link.subscribe(() => {});
    await flush();
    pending.shift()!.fn();
    await flush();
    expect(link.getSnapshot().status).toBe('none');
    expect(pending).toHaveLength(0);
  });

  it("a child's ask is also published on the child's own session, read from the parent store", async () => {
    const base = info({ children: [child({ id: 'c1', hostSessionId: 'host-c1' })], asks: [childAsk()] });
    const stores = new SessionStores(fakeApi(base));
    const published: AskInteraction[] = [];
    const removed: string[] = [];
    const off = publishAsks(stores, (i) => {
      published.push(i);
      return () => removed.push(i.key);
    });
    await stores.get('parent').refresh();
    expect(published.map((p) => [p.sessionId, p.storeSessionId, p.askId])).toEqual([
      ['host-c1', 'parent', 'a1'],
      ['parent', undefined, 'a1'],
    ]);
    // The child's composer elects it; the parent's composer elects its own copy.
    expect(selectAsk({ sessionId: 'host-c1', pendingInteraction: published[0] })).toBe(published[0]);
    off();
    expect(removed.sort()).toEqual(['a1', 'a1@child']);
    stores.dispose();
  });

  it("the child session's own (absent) store never removes the ask its parent published on it", async () => {
    const base = info({ children: [child({ id: 'c1', hostSessionId: 'host-c1' })], asks: [childAsk()] });
    const stores = new SessionStores(
      fakeApi(base, {
        session: async (id: string) => {
          if (id === 'host-c1') throw new RouteError(404, 'not ours');
          return base;
        },
      }),
    );
    const removed: string[] = [];
    const off = publishAsks(stores, (i) => () => removed.push(i.key));
    await stores.get('parent').refresh();
    // Seen live: the child view's own store sync removed the child copy on every poll.
    await stores.get('host-c1').refresh();
    expect(stores.get('host-c1').getSnapshot().status).toBe('absent');
    expect(removed).toEqual([]);
    off();
    stores.dispose();
  });

  it('hostActions open a child through DSH workspace navigation or the right sidebar', () => {
    const opened: unknown[] = [];
    const services: Record<string, unknown> = {
      uiWorkspace: { openSession: (a: unknown) => opened.push(['main', a]) },
      sidebarRight: { openResource: (addr: string, o: unknown) => opened.push(['aside', addr, o]) },
    };
    const actions = hostActions({ get: (n: string) => services[n], slots: {} as never });
    const address = { parentSessionId: 'p', childSessionId: 'c', mode: 'one-shot' as const };
    expect(actions.openChild?.(address)).toBe(true);
    expect(actions.openChildAside?.(address)).toBe(true);
    expect(opened).toEqual([
      ['main', address],
      [
        'aside',
        'dsh-resource://subagentchat/session/c?parent=p&mode=one-shot',
        { kind: 'subagentchat', preferNewPane: true },
      ],
    ]);
    expect(hostActions({ get: () => undefined, slots: {} as never }).openChild?.(address)).toBe(false);
  });
});
