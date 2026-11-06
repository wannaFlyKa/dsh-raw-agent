/* eslint-disable @typescript-eslint/no-explicit-any */
// M6 host-commands (R7.1-R7.4): the `/` menu plan (D36, D52), the side-question desk (D54), the
// runtime's command, MCP and local-output state (D55, D69), and the M6 routes.
import { describe, expect, it } from 'vitest';
import {
  AsyncQueue,
  type AgentBackendFactory,
  type BackendEvent,
  type CommandInfo,
  type SideAnswer,
  type SideExchange,
} from '@dsh-raw-agent/core';
import {
  COMMANDS_ROUTE,
  DSH_KEPT_COMMANDS,
  LOCAL_OUTPUT_ROUTE,
  MCP_AUTH_CALLBACK_ROUTE,
  MCP_ROUTE,
  MCP_TOGGLE_ROUTE,
  SIDE_QUESTION_CANCEL_ROUTE,
  SIDE_QUESTION_ROUTE,
  SessionRuntime,
  SideQuestionDesk,
  TAKEN_NOTE,
  TurnLog,
  channelLine,
  commandRoutes,
  planCommandMenu,
  type HostSessionPort,
  type SideControl,
  type TurnSink,
} from '@dsh-raw-agent/dsh-host';

const MAIN = { kind: 'main' } as const;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('the / menu plan (R7.1, D36, D52)', () => {
  const list: CommandInfo[] = [
    { name: 'compact', description: 'Clear history\n but keep a summary', argumentHint: '<instructions>' },
    { name: 'model', description: 'Set the model' },
    { name: 'export', description: 'Export' },
    { name: 'goal', description: 'Their goal' },
    { name: 'plugin:deploy', description: 'Plugin command', kind: 'custom' },
    { name: 'help', description: 'Help', terminalOnly: true },
    { name: 'btw', description: 'Side question' },
    { name: 'review', kind: 'skill' },
    { name: 'compact', description: 'duplicate' },
  ];

  it('keeps names byte for byte, never shadows DSH /model, and notes taken rows', () => {
    const plan = planCommandMenu([...list, { name: 'mcp', description: 'MCP' }], {
      taken: ['goal'],
      sideQuestionCommand: 'btw',
      mcpCommand: 'mcp',
      displayName: 'Agent',
    });
    const place = Object.fromEntries(plan.rows.map((r) => [r.name, r.menu]));
    // D52 r5: every agent command is offered by the client source; none is a DSH host command.
    expect(place).toEqual({
      compact: 'listed',
      model: 'taken',
      export: 'taken',
      goal: 'taken',
      'plugin:deploy': 'listed',
      help: 'terminal-only',
      btw: 'side-question',
      review: 'listed',
      mcp: 'mcp-panel',
    });
    expect(plan.rows.find((r) => r.name === 'model')!.note).toBe(TAKEN_NOTE);
    expect(plan.rows.find((r) => r.name === 'compact')).toMatchObject({
      description: 'Clear history\n but keep a summary',
      argumentHint: '<instructions>',
    });
    for (const n of ['model', 'permission', 'feedback', 'export', 'file']) expect(DSH_KEPT_COMMANDS).toContain(n);
  });
});

describe('the side-question desk (R7.3, D54)', () => {
  function desk(state: { control: SideControl }) {
    let notes = 0;
    const d = new SideQuestionDesk({
      displayName: 'Agent',
      control: () => state.control,
      notify: () => notes++,
      now: () => 5,
    });
    return { d, notes: () => notes };
  }
  const ready = (answers: Array<SideAnswer | null | Error>, seen: SideExchange[][] = []): SideControl => ({
    kind: 'ready',
    ask: async (_q, history) => {
      seen.push(history);
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return a ?? null;
    },
  });

  it('sends the earlier non-synthetic exchanges and keeps synthetic answers out of them', async () => {
    const seen: SideExchange[][] = [];
    const state = {
      control: ready(
        [
          { text: 'A1', synthetic: false },
          { text: 'No answer possible', synthetic: true },
          {
            text: 'A3',
            synthetic: false,
            fallback: { originalModel: 'm1', fallbackModel: 'm2', content: 'fell back' },
          },
          { text: 'A4', synthetic: false },
        ],
        seen,
      ),
    };
    const { d } = desk(state);
    expect((await d.ask('  Q1  ')).ok).toBe(true);
    await d.ask('Q2');
    await d.ask('Q3');
    await d.ask('Q4');
    expect(seen[0]).toEqual([]);
    expect(seen[2]).toEqual([{ question: 'Q1', answer: 'A1' }]);
    expect(seen[3]).toEqual([
      { question: 'Q1', answer: 'A1' },
      { question: 'Q3', answer: 'A3', fallbackNotice: 'fell back' },
    ]);
    const v = d.view();
    expect(v.entries.map((e) => [e.question, e.status, e.synthetic ?? false])).toEqual([
      ['Q1', 'answered', false],
      ['Q2', 'answered', true],
      ['Q3', 'answered', false],
      ['Q4', 'answered', false],
    ]);
    expect(v.historySize).toBe(3);
    d.clear(); // D70
    expect(d.view()).toEqual({ entries: [], historySize: 0 });
  });

  it('refuses empty, too long, busy and unsupported questions; a failure is shown, not kept', async () => {
    const state: { control: SideControl } = { control: { kind: 'unsupported' } };
    const { d } = desk(state);
    expect(await d.ask(' ')).toMatchObject({ ok: false, code: 'empty' });
    expect(await d.ask('x'.repeat(20_001))).toMatchObject({ ok: false, code: 'too-long' });
    expect(await d.ask('q')).toMatchObject({ ok: false, code: 'unsupported' });
    let release: (a: SideAnswer) => void = () => {};
    state.control = { kind: 'ready', ask: () => new Promise((r) => (release = r)) };
    const first = d.ask('slow');
    await tick();
    expect(d.busy).toBe(true);
    expect(await d.ask('second')).toMatchObject({ ok: false, code: 'busy' });
    release({ text: 'done', synthetic: false });
    expect((await first).ok).toBe(true);
    state.control = ready([new Error('boom')]);
    const failed = await d.ask('fails');
    expect(failed.ok && failed.entry).toMatchObject({ status: 'failed', error: 'boom' });
    expect(d.view().historySize).toBe(1);
  });

  it('keeps a question typed before the start and asks it after the start (D4); cancel works', async () => {
    const state: { control: SideControl } = { control: { kind: 'not-running' } };
    const { d } = desk(state);
    const r = await d.ask('before start');
    expect(r.ok && r.entry.status).toBe('waiting');
    expect(await d.ask('another')).toMatchObject({ code: 'busy' });
    state.control = ready([{ text: 'after', synthetic: false }]);
    d.resume();
    await tick();
    expect(d.view().entries[0]).toMatchObject({ status: 'answered', answer: 'after' });
    let aborted = false;
    state.control = {
      kind: 'ready',
      ask: (_q, _h, signal) =>
        new Promise((resolve) =>
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve(null);
          }),
        ),
    };
    const p = d.ask('cancel me');
    await tick();
    const id = d.view().entries.at(-1)!.id;
    expect(d.cancel(id)).toBe(true);
    await p;
    expect(aborted).toBe(true);
    expect(d.view().entries.at(-1)!.status).toBe('cancelled');
    expect(d.cancel(id)).toBe(false);
  });

  it('clear() drops a late answer of a backend that ignores the abort (D70)', async () => {
    let release: (a: SideAnswer) => void = () => {};
    const state: { control: SideControl } = {
      control: { kind: 'ready', ask: () => new Promise<SideAnswer>((r) => (release = r)) },
    };
    const { d } = desk(state);
    const p = d.ask('old question');
    await tick();
    d.clear();
    release({ text: 'late', synthetic: false });
    const r = await p;
    expect(r.ok && r.entry.status).toBe('cancelled');
    expect(d.view()).toEqual({ entries: [], historySize: 0 });
  });

  it('a failed start fails the waiting question, so a later one is not busy', async () => {
    const state: { control: SideControl } = { control: { kind: 'not-running' } };
    const { d } = desk(state);
    await d.ask('waits');
    d.startFailed('no binary');
    expect(d.view().entries[0]).toMatchObject({ status: 'failed', error: 'Agent did not start: no binary' });
    expect((await d.ask('next')).ok).toBe(true);
  });
});

function fakeLog() {
  const events: Array<{ type: string; data: any; seq: number }> = [];
  const session = {
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
  };
  const log = new TurnLog(session, { emit() {}, nextRevision: () => 1, nextAttemptId: () => 'a' }, 1, {
    provider: 'k',
  });
  const sink: TurnSink = {
    get stepOpen() {
      return log.stepOpen;
    },
    get hasMessage() {
      return log.hasMessage;
    },
    claim: () => {},
    get openCallIds() {
      return log.openCallIds;
    },
    hasCall: (id) => log.hasCall(id),
    get turn() {
      return log.turn;
    },
    openStep: (at) => log.openStep(at),
    delta: () => {},
    commit: (m) => log.commit({ blocks: m.blocks as any, binding: m.binding }),
    result: (id, content, isError) => log.result(id, content as any, isError),
    closeStep: () => log.closeStep(),
  } as unknown as TurnSink;
  return { sink, events };
}

function setup(controls: Record<string, unknown> = {}, capabilities: Record<string, unknown> = {}) {
  let queue: AsyncQueue<BackendEvent> | undefined;
  let onSend: (push: (e: BackendEvent) => void) => void = () => {};
  const factory = {
    kind: 'k',
    displayName: 'K',
    staticCapabilities: {
      ids: 'agent-chosen',
      resume: true,
      fork: 'none',
      needsProcess: ['commands', 'side-question', 'mcp'],
      sideQuestionCommand: 'btw',
      permissionModes: [],
      mainAgentPicker: 'none',
      steer: 'native',
    },
    async open() {
      const q = new AsyncQueue<BackendEvent>();
      queue = q;
      return {
        kind: 'k',
        sessionId: 'x',
        startedAs: 'new',
        capabilities: { sideQuestions: true, ...capabilities },
        events: () => q,
        send: async () => onSend((e) => q.push(e)),
        interrupt: async () => ({ cancelledInputIds: [] }),
        forceStop: async () => q.end(),
        dispose: async () => q.end(),
        controls,
      };
    },
  } as unknown as AgentBackendFactory;
  let changed = 0;
  const port: HostSessionPort = {
    hostSessionId: 'h1',
    cwd: '/w',
    wake: () => {},
    latestBinding: () => undefined,
    startJob: () => undefined,
    warn: () => {},
    commandsChanged: () => changed++,
  };
  const rt = new SessionRuntime(factory, port, { env: {} });
  return {
    rt,
    push: (e: BackendEvent) => queue!.push(e),
    changed: () => changed,
    setSend: (fn: typeof onSend) => (onSend = fn),
  };
}

describe('the runtime: commands, MCP, side questions and local outputs', () => {
  it('reads the full command rows after a names-only report and tells the port (R7.1)', async () => {
    const full: CommandInfo[] = [{ name: 'compact', description: 'Compact' }, { name: 'model' }];
    let reads = 0;
    const t = setup({
      commands: async () => {
        reads++;
        return full;
      },
    });
    expect((await t.rt.commandsAnswer()).from).toBe('none');
    await t.rt.start();
    t.push({ type: 'commands', list: [{ name: 'compact' }, { name: 'model' }], namesOnly: true });
    await tick(5);
    expect(reads).toBe(1);
    expect(t.changed()).toBe(2); // names, then full rows
    expect(t.rt.commandList()).toMatchObject({ full: true, list: full });
    expect(t.rt.view().menu).toMatchObject({ count: 2, full: true });
    const answer = await t.rt.commandsAnswer();
    expect(reads).toBe(1); // full rows known: no second read
    expect(answer.sideQuestionCommand).toBe('btw');
    expect(answer.displayName).toBeTypeOf('string');
    expect(answer.rows.find((r) => r.name === 'model')!.menu).toBe('taken');
    expect(JSON.parse(channelLine(t.rt.view())).menu.count).toBe(2);
    await t.rt.dispose();
  });

  it('shows the start report, then the live MCP state; actions need a listed name (R7.4, D55)', async () => {
    const calls: unknown[][] = [];
    const t = setup({
      mcpStatus: async () => [{ name: 'srv', status: 'connected', transport: 'stdio' }],
      mcpReconnect: async (n: string) => void calls.push(['reconnect', n]),
      mcpToggle: async (n: string, on: boolean) => {
        calls.push(['toggle', n, on]);
        return { note: 'Saved by the agent.' };
      },
    });
    expect(await t.rt.mcp()).toMatchObject({ running: false, reason: 'not-running', servers: [] });
    expect(await t.rt.mcpAction('reconnect', 'srv')).toMatchObject({ ok: false, code: 'not-running' });
    await t.rt.start();
    t.push({ type: 'mcp-status', servers: [{ name: 'srv', status: 'pending' }] });
    await tick();
    expect(t.rt.view().mcp).toEqual([{ name: 'srv', status: 'pending' }]);
    expect(await t.rt.mcp()).toMatchObject({ from: 'live', servers: [{ name: 'srv', status: 'connected' }] });
    expect(await t.rt.mcpAction('toggle', 'other', { enabled: false })).toMatchObject({ code: 'unknown-server' });
    const r = await t.rt.mcpAction('toggle', 'srv', { enabled: false });
    expect(r).toMatchObject({ ok: true, note: 'Saved by the agent.' });
    expect(await t.rt.mcpAction('authenticate', 'srv')).toMatchObject({ ok: false, code: 'unsupported' });
    await t.rt.mcpAction('reconnect', 'srv');
    expect(calls).toEqual([
      ['toggle', 'srv', false],
      ['reconnect', 'srv'],
    ]);
    await t.rt.dispose();
  });

  it('asks a side question with no log event; a waiting one is asked after Start; /clear resets (D54, D70)', async () => {
    const seen: Array<[string, SideExchange[]]> = [];
    const t = setup({
      askSideQuestion: async (q: string, history: SideExchange[]) => {
        seen.push([q, history]);
        return { text: `answer to ${q}`, synthetic: false };
      },
    });
    const waiting = await t.rt.askSideQuestion('early');
    expect(waiting.ok && waiting.entry.status).toBe('waiting');
    await t.rt.start();
    await tick(5);
    expect(t.rt.sideQuestions().entries[0]).toMatchObject({ status: 'answered', answer: 'answer to early' });
    const second = await t.rt.askSideQuestion('second');
    expect(second.ok && second.entry.answer).toBe('answer to second');
    expect(seen[1]![1]).toEqual([{ question: 'early', answer: 'answer to early' }]);
    expect(JSON.parse(channelLine(t.rt.view())).side.entries).toHaveLength(2);
    t.push({ type: 'conversation-reset', newSessionId: 'y' });
    await tick();
    expect(t.rt.sideQuestions()).toEqual({ entries: [], historySize: 0 });
    await t.rt.dispose();
  });

  it('a process without the control says so', async () => {
    const t = setup({}, { sideQuestions: false });
    await t.rt.start();
    expect(await t.rt.askSideQuestion('q')).toMatchObject({ ok: false, code: 'unsupported' });
    await t.rt.dispose();
  });

  it('a local command step names its command in the binding; the /context twin is display-only (R7.2)', async () => {
    const t = setup();
    const context = { totalTokens: 1200, maxTokens: 200_000, percentage: 0.6 } as any;
    t.setSend((push) => {
      push({ type: 'step-start', agent: MAIN, stepId: 's', at: 1, synthetic: true });
      push({
        type: 'step-message',
        agent: MAIN,
        stepId: 's',
        blocks: [{ type: 'text', text: 'Context usage: 1.2k\nTotal cost: $0.14 ($0.14)' }],
        final: true,
        synthetic: true,
        localCommand: { name: 'context', structured: { kind: 'context', context } },
      });
      push({ type: 'turn-end', agent: MAIN, outcome: 'completed', pendingInputs: 0 });
    });
    const { sink, events } = fakeLog();
    const out = await t.rt.runTurn(
      sink,
      { userInputs: [{ id: 'u1', parts: [{ type: 'text', text: '/context' }] }], wake: false },
      new AbortController().signal,
    );
    expect(out.kind).toBe('completed');
    const msg = events.find((e) => e.type === 'assistant/message')!.data.message;
    expect(msg.usage).toBeUndefined(); // D53, D69: the ring is not touched
    // Rule 8: the native message holds the CLI's own text, byte for byte (the client draws it).
    expect(msg.content).toEqual([{ type: 'text', text: 'Context usage: 1.2k\nTotal cost: $0.14 ($0.14)' }]);
    const lc = msg.source.rawAgent.localCommand;
    expect(lc).toMatchObject({ name: 'context', structured: 'context' });
    expect(t.rt.localOutput(lc.outputId)).toEqual({ kind: 'context', context });
    expect(events.some((e) => e.type.startsWith('plugin:'))).toBe(false);
    await t.rt.dispose();
  });
});

describe('the M6 routes', () => {
  const req = (path: string, init?: RequestInit) => new Request(`http://h${path}`, init);

  it('scope to our sessions, check input, and map results to status codes', async () => {
    const t = setup({
      mcpStatus: async () => [{ name: 'srv', status: 'needs-auth' }],
      mcpToggle: async () => ({ note: 'n' }),
      mcpSubmitAuthCallback: async () => {},
      askSideQuestion: async () => ({ text: 'a', synthetic: false }),
      commands: async () => [{ name: 'compact' }],
    });
    const routes = commandRoutes({ get: (id: string) => (id === 'h1' ? t.rt : undefined) } as any);
    const route = (p: string) => routes.find((r) => r.path === p)!;
    expect((await route(COMMANDS_ROUTE).fetch(req(`${COMMANDS_ROUTE}?session=nope`))).status).toBe(404);
    expect((await route(COMMANDS_ROUTE).fetch(req(COMMANDS_ROUTE))).status).toBe(400);
    expect(await (await route(COMMANDS_ROUTE).fetch(req(`${COMMANDS_ROUTE}?session=h1`))).json()).toMatchObject({
      running: false,
      from: 'none',
    });
    expect((await route(MCP_ROUTE).fetch(req(`${MCP_ROUTE}?session=h1`))).status).toBe(200);
    const toggle = (q: string) => route(MCP_TOGGLE_ROUTE).fetch(req(`${MCP_TOGGLE_ROUTE}?${q}`, { method: 'POST' }));
    expect((await toggle('session=h1&server=srv&enabled=false')).status).toBe(409); // not running
    const ask = (body: string) =>
      route(SIDE_QUESTION_ROUTE).fetch(req(`${SIDE_QUESTION_ROUTE}?session=h1`, { method: 'POST', body }));
    expect((await ask('{"question":"before"}')).status).toBe(202); // waits for Start
    await t.rt.start();
    await tick(5);
    expect((await toggle('session=h1&server=srv&enabled=maybe')).status).toBe(400);
    expect((await toggle('session=h1&server=gone&enabled=true')).status).toBe(404);
    expect(await (await toggle('session=h1&server=srv&enabled=true')).json()).toMatchObject({ ok: true, note: 'n' });
    const cb = (body: unknown) =>
      route(MCP_AUTH_CALLBACK_ROUTE).fetch(
        req(`${MCP_AUTH_CALLBACK_ROUTE}?session=h1`, { method: 'POST', body: JSON.stringify(body) }),
      );
    expect((await cb({ server: 'srv', url: 'file:///etc/passwd' })).status).toBe(400);
    expect((await cb({ server: 'srv', url: 'http://localhost:1234/callback?code=x' })).status).toBe(200);
    expect((await ask('not json')).status).toBe(400);
    expect((await ask(JSON.stringify({ question: 'x'.repeat(200 * 1024) }))).status).toBe(400); // over the limit
    expect((await ask('{"question":""}')).status).toBe(400);
    const answered = await (await ask('{"question":"q"}')).json();
    expect(answered).toMatchObject({ ok: true, entry: { status: 'answered', answer: 'a' } });
    const list = await (await route(SIDE_QUESTION_ROUTE).fetch(req(`${SIDE_QUESTION_ROUTE}?session=h1`))).json();
    expect(list.entries).toHaveLength(2);
    const cancel = await route(SIDE_QUESTION_CANCEL_ROUTE).fetch(
      req(`${SIDE_QUESTION_CANCEL_ROUTE}?session=h1&id=${list.entries[1].id}`, { method: 'POST' }),
    );
    expect(cancel.status).toBe(409); // already answered
    const local = await route(LOCAL_OUTPUT_ROUTE).fetch(req(`${LOCAL_OUTPUT_ROUTE}?session=h1&id=local-x`));
    expect(local.status).toBe(404);
    await t.rt.dispose();
  });
});
