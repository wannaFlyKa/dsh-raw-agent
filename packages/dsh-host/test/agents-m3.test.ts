// M3 client-agents, Host side: the main-thread agent picker (R6.4, D15, D51), the child row's
// spawning call and latest output (R6.1, D77), the agent rows on the interaction channel, the
// child-of lookup (D45) and the wake trigger's list (D26).

import { describe, expect, it } from 'vitest';
import {
  AsyncQueue,
  type AgentBackendFactory,
  type AgentInfo,
  type BackendEvent,
  type OpenSessionOptions,
} from '@dsh-raw-agent/core';
import {
  CHILD_LAST_CHARS,
  ChildHub,
  SessionRegistry,
  SessionRuntime,
  channelLine,
  lastOutput,
  lifecycleRoutes,
  parseChoice,
  sessionControlRoutes,
  type HostBinding,
  type HostSessionPort,
  type RegisteredRuntime,
  type TurnSink,
} from '@dsh-raw-agent/dsh-host';

function setup(opts: { binding?: HostBinding; seated?: string; agents?: AgentInfo[]; exists?: boolean } = {}) {
  const opened: OpenSessionOptions[] = [];
  const disposed: number[] = [];
  let binding = opts.binding;
  const factory = {
    kind: 'k',
    displayName: 'K',
    staticCapabilities: {
      ids: 'derived',
      resume: true,
      fork: 'at-chain-point',
      mainAgentPicker: 'new-session-only',
      permissionModes: [{ id: 'default', label: 'Ask' }],
      needsProcess: ['agents'],
      steer: 'native',
    },
    sessionIdFor: (h: string) => `derived-${h}`,
    sessionExists: async () => opts.exists === true,
    sessionMainAgent: async () => opts.seated,
    async open(o: OpenSessionOptions) {
      opened.push(o);
      const n = opened.length;
      const q = new AsyncQueue<BackendEvent>();
      return {
        kind: 'k',
        sessionId: 'x',
        startedAs: 'new',
        capabilities: {},
        events: () => q,
        send: async () => {
          binding = { sessionId: 'x', hostSessionId: 'h2' };
          q.push({ type: 'turn-end', outcome: 'completed', pendingInputs: 0 } as BackendEvent);
        },
        interrupt: async () => ({ cancelledInputIds: [] }),
        forceStop: async () => {},
        dispose: async () => {
          disposed.push(n);
          q.push({ type: 'exit' } as BackendEvent);
          q.end();
        },
        controls: { agents: async () => opts.agents ?? [] },
      };
    },
  } as unknown as AgentBackendFactory;
  const port: HostSessionPort = {
    hostSessionId: 'h2',
    cwd: '/w',
    wake: () => {},
    latestBinding: () => binding,
    startJob: () => undefined,
    warn: () => {},
  };
  const triggers: Array<[string, readonly string[] | undefined]> = [];
  const sink: TurnSink = {
    stepOpen: false,
    hasMessage: false,
    claim: () => false,
    openCallIds: [],
    hasCall: () => false,
    openStep: () => {},
    delta: () => {},
    commit: () => ({ calls: [] }),
    result: () => {},
    closeStep: () => {},
    trigger: (text, items) => void triggers.push([text, items]),
  };
  const rt = new SessionRuntime(factory, port, { env: {} });
  let n = 0;
  const run = () =>
    rt.runTurn(
      sink,
      { userInputs: [{ id: `u${++n}`, parts: [{ type: 'text', text: 'hi' }] }], wake: false },
      new AbortController().signal,
    );
  return { opened, disposed, run, rt, factory, triggers };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('main-thread agent picker (R6.4, D15, D51)', () => {
  it('a pick before the first message is passed at spawn, then the picker locks', async () => {
    const t = setup({ agents: [{ name: 'pirate', description: 'Talks like a pirate' }] });
    expect(t.rt.view().choice).toMatchObject({ agentLocked: false });
    const r = await t.rt.choose({ agent: 'pirate' });
    expect(r).toMatchObject({ ok: true, note: 'applies when K starts' });
    expect(r.view.choice.agent).toBe('pirate');
    await t.run();
    expect(t.opened[0]!.start).toEqual({ kind: 'new', sessionId: 'derived-h2', mainAgent: 'pirate' });
    await flush();
    const v = t.rt.view();
    expect(v.live.agent).toBe('pirate');
    expect(v.agents).toEqual([{ name: 'pirate', description: 'Talks like a pirate' }]);
    expect(v.choice.agentLocked).toBe(true);
    const late = await t.rt.choose({ agent: null });
    expect(late.ok).toBe(false);
    expect(late.error).toMatch(/before the first message/);
    await t.rt.dispose();
  });

  it('"Start" first, then a pick: the idle process ends and the next spawn passes the agent', async () => {
    const t = setup({ agents: [{ name: 'pirate' }] });
    await t.rt.start();
    expect(t.opened[0]!.start).toEqual({ kind: 'new', sessionId: 'derived-h2' });
    await flush();
    expect(t.rt.view().agents?.map((a) => a.name)).toEqual(['pirate']);
    const r = await t.rt.choose({ agent: 'pirate' });
    expect(r.ok).toBe(true);
    expect(r.note).toMatch(/starts again with this agent/);
    expect(t.disposed).toEqual([1]);
    await t.run();
    expect(t.opened[1]!.start).toMatchObject({ mainAgent: 'pirate' });
    await t.rt.dispose();
  });

  it('"none" clears a pick; no agent is passed', async () => {
    const t = setup();
    await t.rt.choose({ agent: 'pirate' });
    await t.rt.choose({ agent: 'settings' });
    expect(t.rt.view().choice.agent).toBeUndefined();
    await t.run();
    expect(t.opened[0]!.start).toEqual({ kind: 'new', sessionId: 'derived-h2' });
    await t.rt.dispose();
  });

  it('a resumed session passes the agent it was started with (read without a process, D83)', async () => {
    const t = setup({ binding: { sessionId: 'own', hostSessionId: 'h2' }, seated: 'pirate' });
    expect(t.rt.view().choice.agentLocked).toBe(true);
    expect((await t.rt.choose({ agent: 'other' })).ok).toBe(false);
    await t.run();
    expect(t.opened[0]!.start).toEqual({ kind: 'resume', sessionId: 'own', mainAgent: 'pirate' });
    expect(t.rt.view().live.agent).toBe('pirate');
    await t.rt.dispose();
  });

  it('a DSH fork keeps the agent CLI restore (no agent passed)', async () => {
    const t = setup({ binding: { sessionId: 'src', hostSessionId: 'h1' }, seated: 'pirate' });
    await t.run();
    expect(t.opened[0]!.start).not.toHaveProperty('mainAgent');
    await t.rt.dispose();
  });

  it('parseChoice takes an agent name or null and refuses anything else', () => {
    expect(parseChoice({ agent: 'plugin:reviewer' })).toEqual({ agent: 'plugin:reviewer' });
    expect(parseChoice({ agent: null })).toEqual({ agent: null });
    expect(parseChoice({ agent: 'a b' })).toBe('bad agent');
    expect(parseChoice({ agent: 3 })).toBe('bad agent');
  });
});

describe('child rows (R6.1, D77)', () => {
  it('lastOutput: the last block with something to show, clipped from the start', () => {
    expect(lastOutput([{ type: 'text', text: '  hello\n  world ' }], 5)).toEqual({
      kind: 'text',
      text: 'hello world',
      at: 5,
    });
    expect(
      lastOutput(
        [
          { type: 'text', text: 'x' },
          { type: 'tool-call', id: 'c', name: 'Bash', arguments: '{}' },
        ],
        1,
      ),
    ).toEqual({ kind: 'tool', text: 'Bash', at: 1 });
    expect(
      lastOutput(
        [
          { type: 'reasoning', text: 'hmm' },
          { type: 'text', text: ' ' },
        ],
        1,
      )?.kind,
    ).toBe('reasoning');
    expect(lastOutput([], 1)).toBeUndefined();
    const long = lastOutput([{ type: 'text', text: 'a'.repeat(500) + 'END' }], 1)!;
    expect(long.text).toHaveLength(CHILD_LAST_CHARS);
    expect(long.text.startsWith('…')).toBe(true);
    expect(long.text.endsWith('END')).toBe(true);
  });

  it('the hub keeps the spawning call and the latest output of each child', () => {
    let notified = 0;
    const hub = new ChildHub({ now: () => 7, warn: () => {}, notify: () => notified++, imageText: () => '' });
    const agent = { kind: 'child' as const, id: 't1' };
    hub.handle({
      type: 'agent-start',
      ref: agent,
      parent: { kind: 'main' },
      parentCallId: 'call-agent-1',
      label: 'helper',
      role: 'subagent',
      background: false,
      taskPrompt: 'do it',
    } as BackendEvent);
    hub.handle({
      type: 'step-message',
      agent,
      stepId: 'm1',
      blocks: [{ type: 'text', text: 'Reading the file' }],
      final: false,
    } as BackendEvent);
    const v = hub.views()[0]!;
    expect(v.callId).toBe('call-agent-1');
    expect(v.last).toEqual({ kind: 'text', text: 'Reading the file', at: 7 });
    expect(notified).toBeGreaterThan(0);
  });
});

describe('agent rows on the channel, child-of and the agents list (D39, D45, D51)', () => {
  it('channelLine carries children, team and tasks', () => {
    const line = JSON.parse(
      channelLine({
        state: { process: 'running', turn: false, backgroundTasks: 0 },
        live: {},
        choice: { applied: {}, resetPending: false, agentLocked: false },
        children: [{ id: 'c1' } as never],
      }),
    );
    expect(line).toMatchObject({ type: 'asks', children: [{ id: 'c1' }], team: null, tasks: [] });
  });

  function fakeRuntime(view: Record<string, unknown>): RegisteredRuntime {
    return { view: () => view } as unknown as RegisteredRuntime;
  }

  it('the registry finds the parent of a child session and a recent agent list for a folder', () => {
    const reg = new SessionRegistry();
    reg.set('p1', 'k', fakeRuntime({ cwd: '/a', children: [{ id: 'task_1', hostSessionId: 'child-host' }] }));
    reg.set('p2', 'k', fakeRuntime({ cwd: '/b', agents: [{ name: 'b-agent' }] }));
    expect(reg.findChild('child-host')).toEqual({ parentSession: 'p1', childId: 'task_1' });
    expect(reg.findChild('other')).toBeUndefined();
    expect(reg.lastAgents('k', '/b')).toEqual([{ name: 'b-agent' }]);
    expect(reg.lastAgents('k', '/a')).toBeUndefined();
    expect(reg.lastAgents('z', '/b')).toBeUndefined();
  });

  it('GET child-of answers the parent, or 404', async () => {
    const reg = new SessionRegistry();
    reg.set('p1', 'k', fakeRuntime({ children: [{ id: 'task_1', hostSessionId: 'ch' }] }));
    const route = lifecycleRoutes(reg).find((r) => r.path === '/api/raw-agent/child-of')!;
    const ok = await route.fetch(new Request('http://x/api/raw-agent/child-of?session=ch'));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ parentSession: 'p1', childId: 'task_1' });
    const miss = await route.fetch(new Request('http://x/api/raw-agent/child-of?session=nope'));
    expect(miss.status).toBe(404);
  });

  it('GET session lists the agents (this process, else recent for the folder) and the picker kind', async () => {
    const t = setup({ agents: [{ name: 'pirate', model: 'inherit' }] });
    const reg = new SessionRegistry();
    reg.set('h2', 'k', t.rt);
    const route = sessionControlRoutes(reg, { factories: [t.factory] }).find(
      (r) => r.path === '/api/raw-agent/session',
    )!;
    const before = (await (await route.fetch(new Request('http://x/api/raw-agent/session?session=h2'))).json()) as {
      agents: unknown[];
      agentsFrom: string;
      mainAgentPicker: string;
    };
    expect(before).toMatchObject({ agents: [], agentsFrom: 'none', mainAgentPicker: 'new-session-only' });
    await t.rt.start();
    await flush();
    const after = (await (await route.fetch(new Request('http://x/api/raw-agent/session?session=h2'))).json()) as {
      agents: unknown[];
      agentsFrom: string;
    };
    expect(after).toMatchObject({ agents: [{ name: 'pirate', model: 'inherit' }], agentsFrom: 'session' });
    await t.rt.dispose();
  });
});
