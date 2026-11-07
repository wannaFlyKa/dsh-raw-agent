// M7 (R3.5, R3.6, D28-D30, D75): fork hint and restore code, a fork that already ran, replies
// read back from the agent's record, restart notices, exit reasons, rewind routes. No processes.

import { describe, expect, it } from 'vitest';
import {
  AsyncQueue,
  type AgentBackendFactory,
  type AgentBackendSession,
  type BackendEvent,
  type FileRewindResult,
  type OpenSessionOptions,
  type SessionTail,
  type UserInput,
} from '@dsh-raw-agent/core';
import {
  SessionRegistry,
  SessionRuntime,
  droppedHumanMessage,
  forkCut,
  lifecycleRoutes,
  planCommandMenu,
  recoveryItems,
  rewindPoints,
  tasksEndedByStop,
  REWIND_TEXT_MAX,
  type HostBinding,
  type HostSessionPort,
  type TurnSink,
} from '@dsh-raw-agent/dsh-host';

const MAIN = { kind: 'main' } as const;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

interface Opts {
  tail?: SessionTail;
  exists?: (id: string) => boolean;
  rewind?: (inputId: string, o?: { dryRun?: boolean }) => Promise<FileRewindResult>;
  fileRewind?: boolean;
  /** send() answers nothing (a turn that keeps running). */
  hold?: boolean;
}

function fakeFactory(o: Opts = {}) {
  const opened: OpenSessionOptions[] = [];
  const queues: AsyncQueue<BackendEvent>[] = [];
  const tailReads: Array<[string, string]> = [];
  const factory = {
    kind: 'k',
    displayName: 'Agent',
    staticCapabilities: {
      ids: 'host-chosen',
      resume: true,
      fork: 'at-chain-point',
      needsProcess: [],
      permissionModes: [],
      mainAgentPicker: 'none',
      steer: 'native',
    },
    sessionIdFor: (h: string) => `derived-${h}`,
    inputIdFor: (m: string) => `in-${m}`,
    sessionExists: async (id: string) => o.exists?.(id) ?? false,
    fileRewindAvailable: async () => true,
    ...(o.tail
      ? {
          readSessionTail: async (id: string, _cwd: string, after: string) => {
            tailReads.push([id, after]);
            return o.tail!;
          },
        }
      : {}),
    async open(opts: OpenSessionOptions) {
      opened.push(opts);
      const q = new AsyncQueue<BackendEvent>();
      queues.push(q);
      const s: AgentBackendSession = {
        kind: 'k',
        sessionId: 'live-1',
        startedAs: 'new',
        capabilities: {
          perTaskStop: true,
          sideQuestions: false,
          workflows: false,
          teamMessaging: false,
          cancelQueued: false,
          fileRewind: o.fileRewind === true,
          planChoices: [],
        },
        events: () => q,
        async send() {
          if (o.hold) return;
          for (const e of [
            { type: 'step-start', agent: MAIN, stepId: 'n', at: 0 },
            { type: 'step-message', agent: MAIN, stepId: 'n', blocks: [{ type: 'text', text: 'new' }], final: true },
            { type: 'turn-end', agent: MAIN, outcome: 'completed', pendingInputs: 0 },
          ] as BackendEvent[])
            q.push(e);
        },
        interrupt: async () => ({ cancelledInputIds: [] }),
        forceStop: async () => {
          q.push({ type: 'exit', reason: 'force-stopped' });
          q.end();
        },
        dispose: async () => {
          q.push({ type: 'exit', reason: 'disposed' });
          q.end();
        },
        controls: o.rewind ? { rewindFiles: o.rewind } : {},
      };
      return s;
    },
  } as unknown as AgentBackendFactory;
  return { factory, opened, queues, tailReads };
}

function fakePort(binding: HostBinding | undefined, over: Partial<HostSessionPort> = {}) {
  const log = { wakes: [] as string[], warnings: [] as unknown[] };
  const port: HostSessionPort = {
    hostSessionId: 'h2',
    cwd: '/w',
    wake: (t) => void log.wakes.push(t),
    latestBinding: () => binding,
    startJob: () => undefined,
    warn: (n, d) => void log.warnings.push([n, d]),
    ...over,
  };
  return { port, log };
}

function recSink() {
  const ops: string[] = [];
  const bindings: Array<Record<string, unknown>> = [];
  const triggers: Array<[string, readonly string[] | undefined]> = [];
  let open = false;
  let has = false;
  const calls = new Map<string, boolean>();
  const sink: TurnSink = {
    get stepOpen() {
      return open;
    },
    get hasMessage() {
      return has;
    },
    get openCallIds() {
      return [...calls].filter(([, r]) => !r).map(([id]) => id);
    },
    hasCall: (id) => calls.has(id),
    openStep: () => {
      open = true;
      has = false;
      calls.clear();
      ops.push('open');
    },
    delta: () => {},
    commit: (m) => {
      has = true;
      bindings.push(m.binding);
      const c = m.blocks.filter((b) => b.type === 'tool-call').map((b) => (b as { id: string }).id);
      for (const id of c) calls.set(id, false);
      ops.push(`commit ${m.blocks.map((b) => (b.type === 'text' ? b.text : b.type)).join(',')}`);
      return { calls: c };
    },
    result: (id) => {
      calls.set(id, true);
      ops.push(`result ${id}`);
    },
    closeStep: () => {
      if (!open) return;
      open = false;
      ops.push('close');
    },
    claim: () => true,
    trigger: (t, items) => void triggers.push([t, items]),
  };
  return { sink, ops, bindings, triggers };
}

const input = (id: string): UserInput => ({ id, parts: [{ type: 'text', text: id }] });
const signal = () => new AbortController().signal;

const recoveredTail: SessionTail = {
  status: 'found',
  events: [
    { type: 'step-start', agent: MAIN, stepId: 'm2', at: 0 },
    {
      type: 'step-message',
      agent: MAIN,
      stepId: 'm2',
      blocks: [
        { type: 'text', text: 'late reply' },
        { type: 'tool-call', id: 't2', name: 'Bash', arguments: '{}' },
      ],
      final: true,
      lastChainId: 'a2',
    },
    {
      type: 'tool-result',
      agent: MAIN,
      callId: 't2',
      isError: false,
      content: [{ type: 'text', text: 'ok' }],
      chainId: 'r2',
    },
  ],
  prompts: [],
  notes: ['a background task reported back'],
  orphanResults: 1,
  lastChainId: 'r2',
};

describe('D29, D30: the fork start', () => {
  const inherited: HostBinding = { sessionId: 'src', hostSessionId: 'h1', chainId: 'c9' };

  it('passes the first dropped turn as a hint, and restore code when asked', async () => {
    const f = fakeFactory();
    const { port } = fakePort(inherited, { forkDroppedMessage: async () => 'msg-3' });
    const rt = new SessionRuntime(f.factory, port, { env: {} });
    expect((await rt.rewindOptions()).unstartedFork).toBe(true);
    expect(rt.requestCodeRestore(true)).toEqual({ ok: true });
    expect(rt.view().lifecycle?.restoreCodePending).toBe(true);
    await rt.runTurn(recSink().sink, { userInputs: [input('u1')], wake: false }, signal());
    expect(f.opened[0]!.start).toEqual({
      kind: 'fork',
      fromSessionId: 'src',
      newSessionId: 'derived-h2',
      atChainId: 'c9',
      dropsTurnHint: 'in-msg-3',
      restoreFilesAt: 'in-msg-3',
    });
    expect(rt.view().lifecycle?.restoreCodePending).toBeUndefined();
    expect(rt.requestCodeRestore(true).ok).toBe(false); // started: no longer a fresh fork
    await rt.dispose();
  });

  it('no hint when the source turn is unknown; restore code is then refused with a note', async () => {
    const f = fakeFactory();
    const { port } = fakePort(inherited, { forkDroppedMessage: async () => undefined });
    const rt = new SessionRuntime(f.factory, port, { env: {} });
    rt.requestCodeRestore(true);
    await rt.runTurn(recSink().sink, { userInputs: [input('u1')], wake: false }, signal());
    expect(f.opened[0]!.start).toEqual({
      kind: 'fork',
      fromSessionId: 'src',
      newSessionId: 'derived-h2',
      atChainId: 'c9',
    });
    expect(rt.view().live.notice?.text).toMatch(/files were not restored/);
    await rt.dispose();
  });

  it('a fork whose own record exists already resumes it (a first turn that ended before a reply)', async () => {
    const f = fakeFactory({ exists: (id) => id === 'derived-h2' });
    const { port } = fakePort(inherited, { forkDroppedMessage: async () => 'msg-3' });
    const rt = new SessionRuntime(f.factory, port, { env: {} });
    await rt.runTurn(recSink().sink, { userInputs: [input('u1')], wake: false }, signal());
    expect(f.opened[0]!.start).toEqual({ kind: 'resume', sessionId: 'derived-h2' });
    await rt.dispose();
  });

  it('after /clear and a restart: resumes the conversation that took the last message (D70, M7 live)', async () => {
    const f = fakeFactory();
    const held: Array<[string, string | undefined]> = [];
    (f.factory as { sessionHoldingInput?: unknown }).sessionHoldingInput = async (
      id: string,
      _cwd: string,
      prefer?: string,
    ) => {
      held.push([id, prefer]);
      return id === 'in-m-clear' ? 'cleared-conv' : undefined;
    };
    const point = (messageId: string, forkSeq: number) => ({
      messageId,
      text: '',
      attachments: 0,
      at: 0,
      forkSeq,
      inherited: false,
    });
    const { port } = fakePort(
      { sessionId: 'old-conv', hostSessionId: 'h2', chainId: 'c1' },
      { rewindPoints: () => [point('m-first', 3), point('m-clear', 9), point('m-now', 14)] },
    );
    const rt = new SessionRuntime(f.factory, port, { env: {} });
    await rt.runTurn(recSink().sink, { userInputs: [input('u1')], wake: false }, signal());
    expect(f.opened[0]!.start).toEqual({ kind: 'resume', sessionId: 'cleared-conv' });
    // Newest first, each checked against the bound conversation first; older points not read.
    expect(held).toEqual([
      ['in-m-now', 'old-conv'],
      ['in-m-clear', 'old-conv'],
    ]);
    await rt.dispose();
  });

  it('no record holds the newest messages: the own binding stays', async () => {
    const f = fakeFactory();
    (f.factory as { sessionHoldingInput?: unknown }).sessionHoldingInput = async () => undefined;
    const { port } = fakePort(
      { sessionId: 'old-conv', hostSessionId: 'h2', chainId: 'c1' },
      { rewindPoints: () => [{ messageId: 'm1', text: '', attachments: 0, at: 0, forkSeq: 3, inherited: false }] },
    );
    const rt = new SessionRuntime(f.factory, port, { env: {} });
    await rt.runTurn(recSink().sink, { userInputs: [input('u1')], wake: false }, signal());
    expect(f.opened[0]!.start).toEqual({ kind: 'resume', sessionId: 'old-conv' });
    await rt.dispose();
  });

  it('restore code is refused for a session that is not a fresh fork', async () => {
    const f = fakeFactory();
    const { port } = fakePort({ sessionId: 'own', hostSessionId: 'h2', chainId: 'c1' });
    const rt = new SessionRuntime(f.factory, port, { env: {} });
    expect(rt.requestCodeRestore(true)).toMatchObject({ ok: false });
    expect(rt.requestCodeRestore(false)).toEqual({ ok: true });
    await rt.dispose();
  });
});

describe('R3.6: replies read back from the agent record', () => {
  it('after a restart: a log-only turn with no process, bound to the recorded session', async () => {
    const f = fakeFactory({ tail: recoveredTail });
    const { port, log } = fakePort({ sessionId: 'own', hostSessionId: 'h2', chainId: 'a1' });
    const rt = new SessionRuntime(f.factory, port, { env: {} });
    await tick();
    expect(f.tailReads).toEqual([['own', 'a1']]);
    expect(log.wakes).toHaveLength(1);
    expect(log.wakes[0]).toMatch(/Read back from Agent's own record/);
    const s = recSink();
    const out = await rt.runTurn(s.sink, { userInputs: [], wake: true }, signal());
    expect(out).toEqual({ kind: 'completed' });
    expect(f.opened).toHaveLength(0); // no process for a read-back turn (rule 9)
    expect(s.ops).toEqual(['open', 'commit late reply,tool-call', 'result t2', 'close']);
    expect(s.bindings[0]).toMatchObject({ sessionId: 'own', hostSessionId: 'h2', lastChainId: 'a2' });
    expect(s.triggers[0]![1]).toEqual([
      'it took in a background task reported back',
      expect.stringMatching(/^1 tool result came back/),
    ]);
    expect(rt.view().lifecycle?.recovered).toMatchObject({ why: 'restart', steps: 1 });
    await rt.dispose();
  });

  it('a message typed before the read-back turn opens takes the steps first, then runs', async () => {
    const f = fakeFactory({ tail: recoveredTail });
    const { port } = fakePort({ sessionId: 'own', hostSessionId: 'h2', chainId: 'a1' });
    const rt = new SessionRuntime(f.factory, port, { env: {} });
    await tick();
    const s = recSink();
    await rt.runTurn(s.sink, { userInputs: [input('u1')], wake: false }, signal());
    expect(s.ops).toEqual(['open', 'commit late reply,tool-call', 'result t2', 'close', 'open', 'commit new', 'close']);
    expect(s.triggers).toHaveLength(1);
    // The wake that was asked for finds nothing left.
    expect((await rt.runTurn(recSink().sink, { userInputs: [], wake: true }, signal())).kind).toBe('nothing');
    await rt.dispose();
  });

  it('never reads past an inherited (fork) binding', async () => {
    const f = fakeFactory({ tail: recoveredTail });
    const { port, log } = fakePort({ sessionId: 'src', hostSessionId: 'h1', chainId: 'a1' });
    const rt = new SessionRuntime(f.factory, port, { env: {} });
    await tick();
    expect(f.tailReads).toHaveLength(0);
    expect(log.wakes).toHaveLength(0);
    await rt.dispose();
  });

  it('nothing to show as steps: a notice says what the agent has', async () => {
    const f = fakeFactory({ tail: { ...recoveredTail, events: [] } });
    const { port, log } = fakePort({ sessionId: 'own', hostSessionId: 'h2', chainId: 'a1' });
    const rt = new SessionRuntime(f.factory, port, { env: {} });
    await tick();
    expect(log.wakes).toHaveLength(0);
    expect(rt.view().live.notice).toMatchObject({ level: 'warning' });
    expect(rt.view().live.notice?.text).toMatch(/has more than this session shows/);
    await rt.dispose();
  });

  it('a record too large to compare is reported', async () => {
    const f = fakeFactory({ tail: { ...recoveredTail, status: 'too-large', events: [] } });
    const { port } = fakePort({ sessionId: 'own', hostSessionId: 'h2', chainId: 'a1' });
    const rt = new SessionRuntime(f.factory, port, { env: {} });
    await tick();
    expect(rt.view().lifecycle?.recoveryProblem).toMatch(/too large/);
    await rt.dispose();
  });

  it('after a crash mid-turn: the turn ends with the reason, then the read-back turn opens', async () => {
    const bound: { b?: HostBinding } = {};
    const f = fakeFactory({ tail: { ...recoveredTail, notes: [], orphanResults: 0 }, hold: true });
    const { port, log } = fakePort(undefined, { latestBinding: () => bound.b });
    const rt = new SessionRuntime(f.factory, port, { env: {} });
    await tick();
    expect(f.tailReads).toHaveLength(0); // no binding yet
    const s = recSink();
    const running = rt.runTurn(s.sink, { userInputs: [input('u1')], wake: false }, signal());
    await tick();
    bound.b = { sessionId: 'live-1', hostSessionId: 'h2', chainId: 'a1' };
    f.queues[0]!.push({ type: 'exit', error: 'it exited with code 1', reason: 'crashed', code: 1 });
    f.queues[0]!.end();
    const out = await running;
    expect(out.kind).toBe('error');
    expect(rt.state().lastExit).toMatchObject({ reason: 'crashed', code: 1, error: 'it exited with code 1' });
    await tick();
    expect(f.tailReads).toEqual([['live-1', 'a1']]);
    expect(log.wakes).toHaveLength(1);
    expect(rt.view().lifecycle?.recovered?.why).toBe('crash');
    await rt.dispose();
  });
});

describe('D75, R3.6: exit reasons and restart notices', () => {
  it('an exit the backend marks as asked for is not a crash', async () => {
    const f = fakeFactory();
    const { port } = fakePort(undefined);
    const rt = new SessionRuntime(f.factory, port, { env: {} });
    await rt.start();
    f.queues[0]!.push({ type: 'exit', reason: 'disposed' });
    f.queues[0]!.end();
    await tick();
    expect(rt.state().lastExit).toBeUndefined();
    await rt.dispose();
  });

  it('tasks that ended with the last host stop, and a branch of a child session, are told once', async () => {
    const f = fakeFactory();
    const { port } = fakePort(undefined, { tasksEndedByStop: () => ['Wait 20 s'], forkedFromChild: () => true });
    const rt = new SessionRuntime(f.factory, port, { env: {} });
    await tick();
    expect(rt.view().lifecycle).toMatchObject({ endedByStop: ['Wait 20 s'], forkedFromChild: true });
    await rt.dispose();
  });
});

describe('D30: restore code in place', () => {
  it('needs the live process and checkpoints; reports the result', async () => {
    const asked: Array<[string, boolean | undefined]> = [];
    const f = fakeFactory({
      fileRewind: true,
      rewind: async (id, o) => {
        asked.push([id, o?.dryRun]);
        return { ok: true, filesChanged: ['a.txt'], ...(o?.dryRun ? { dryRun: true } : {}) };
      },
    });
    const { port } = fakePort(undefined);
    const rt = new SessionRuntime(f.factory, port, { env: {} });
    expect(await rt.rewindFiles('m1', false)).toMatchObject({ ok: false, code: 'not-running' });
    await rt.start();
    expect(await rt.rewindFiles('m1', true)).toMatchObject({ ok: true, result: { dryRun: true } });
    expect(await rt.rewindFiles('m1', false)).toMatchObject({ ok: true });
    expect(asked).toEqual([
      ['in-m1', true],
      ['in-m1', false],
    ]);
    expect(rt.view().live.notice?.text).toBe('Restored 1 file.');
    expect(rt.view().lifecycle?.rewind).toMatchObject({ inputId: 'in-m1', result: { ok: true } });
    await rt.dispose();
  });

  it('a fork start reports its restore through files-rewound', async () => {
    const f = fakeFactory();
    const { port } = fakePort(undefined);
    const rt = new SessionRuntime(f.factory, port, { env: {} });
    await rt.start();
    f.queues[0]!.push({
      type: 'files-rewound',
      inputId: 'p3',
      result: { ok: false, error: 'no checkpoint', filesChanged: [] },
    });
    await tick();
    expect(rt.view().live.notice).toMatchObject({
      level: 'warning',
      text: 'Agent did not restore the files: no checkpoint',
    });
    await rt.dispose();
  });

  it('the rewind routes', async () => {
    const f = fakeFactory();
    const { port } = fakePort({ sessionId: 'src', hostSessionId: 'h1', chainId: 'c' });
    const rt = new SessionRuntime(f.factory, port, { env: {} });
    const reg = new SessionRegistry();
    reg.set('h2', 'k', rt);
    const routes = lifecycleRoutes(reg);
    const call = async (path: string, query: string, method = 'GET') => {
      const r = routes.find((x) => x.path === path)!;
      const res = await r.fetch(new Request(`http://x${path}?${query}`, { method }));
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    expect(await call('/api/raw-agent/rewind', 'session=h2')).toMatchObject({
      status: 200,
      body: { running: false, fileRewind: true, unstartedFork: true },
    });
    expect((await call('/api/raw-agent/rewind', 'session=zz')).status).toBe(404);
    expect((await call('/api/raw-agent/rewind-restore', 'session=h2&on=1', 'POST')).status).toBe(200);
    expect(rt.view().lifecycle?.restoreCodePending).toBe(true);
    expect((await call('/api/raw-agent/rewind-files', 'session=h2', 'POST')).status).toBe(400);
    expect(await call('/api/raw-agent/rewind-files', 'session=h2&message=m1', 'POST')).toMatchObject({
      status: 409,
      body: { code: 'not-running' },
    });
    await reg.disposeAll();
  });
});

describe('port helpers: fork cut, dropped turn, tasks ended by a stop', () => {
  const ev = (seq: number, type: string, data: Record<string, unknown> = {}) => ({ seq, time: 0, type, data });
  const source = [
    ev(0, 'turn/start', { turn: 1 }),
    ev(1, 'user/message', { id: 'u1', source: { kind: 'user' } }),
    ev(2, 'turn/end', { turn: 1 }),
    ev(3, 'session/title', {}),
    ev(4, 'turn/start', { turn: 2 }),
    ev(5, 'user/message', { id: 'u2', source: { kind: 'user' } }),
    ev(6, 'turn/end', { turn: 2 }),
  ];

  it('finds the cut and the first dropped human message', () => {
    const fork = [...source.slice(0, 3), ev(3, 'session/end-seed', { inherited: true })];
    const cut = forkCut(fork)!;
    expect(cut).toEqual({ boundarySeq: 2, midTurn: false, childPrefix: false });
    expect(droppedHumanMessage(source, cut)).toBe('u2');
    expect(forkCut(source)).toBeUndefined();
  });

  it('a cut inside a turn, a wake turn, and a child prefix give no hint', () => {
    const mid = [
      ...source.slice(0, 2),
      ev(2, 'session/end-seed', { inherited: true }),
      ev(3, 'turn/end', { turn: 1, reason: { kind: 'forked' } }),
    ];
    expect(forkCut(mid)?.midTurn).toBe(true);
    expect(droppedHumanMessage(source, forkCut(mid)!)).toBeUndefined();
    const wake = [
      ev(0, 'turn/start'),
      ev(1, 'turn/end'),
      ev(2, 'turn/start'),
      ev(3, 'step/start'),
      ev(4, 'turn/end'),
      ev(5, 'turn/start'),
      ev(6, 'user/message', { id: 'u9', source: { kind: 'user' } }),
    ];
    expect(droppedHumanMessage(wake, { boundarySeq: 1, midTurn: false, childPrefix: false })).toBeUndefined();
    const child = [ev(0, 'subagent/descriptor'), ev(1, 'turn/end'), ev(2, 'session/end-seed', { inherited: true })];
    expect(forkCut(child)?.childPrefix).toBe(true);
  });

  it('lists jobs still open or torn down, not ones that ended or were linked again', () => {
    const job = (seq: number, type: string, jobId: string, label: string, extra: Record<string, unknown> = {}) =>
      ev(seq, type, { jobId, kind: 'raw-agent-shell', label, ...extra });
    const events = [
      job(0, 'job/registered', 'j1', 'open one'),
      job(1, 'job/registered', 'j2', 'torn'),
      job(2, 'job/settled', 'j2', 'torn', { status: 'killed', detail: 'jobs service disposed' }),
      job(3, 'job/registered', 'j3', 'done'),
      job(4, 'job/settled', 'j3', 'done', { status: 'completed' }),
      job(5, 'job/registered', 'j4', 'relinked'),
      job(6, 'job/settled', 'j4', 'relinked', { status: 'killed', detail: 'owner disposed' }),
      job(7, 'job/registered', 'j5', 'relinked'),
      job(8, 'job/settled', 'j5', 'relinked', { status: 'completed' }),
      ev(9, 'job/registered', { jobId: 'x', kind: 'bash', label: 'not ours' }),
    ];
    expect(tasksEndedByStop(events)).toEqual(['open one', 'torn']);
  });

  it('recovery items name prompts, notes and orphan results', () => {
    expect(recoveryItems({ prompts: ['  hello\n  there '], notes: ['a queued message'], orphanResults: 2 })).toEqual([
      'it took your message "hello there"',
      'it took in a queued message',
      "2 tool results came back for calls shown above as interrupted; they are in the agent's memory",
    ]);
  });
});

// ---- M7 client-lifecycle: what the rewind dialog lists (D30) and the /rewind row --------------

describe('D30: rewind points and the rewind command (client-lifecycle)', () => {
  let seq = 0;
  const ev = (type: string, data: Record<string, unknown> = {}) => ({ type, seq: ++seq, time: seq * 10, data });
  const human = (id: string, text: string, extra: Record<string, unknown>[] = []) =>
    ev('user/message', { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }, ...extra] });

  it('lists the human message that opened each turn, with the previous turn end as the cut', () => {
    seq = 0;
    const events = [
      ev('session/header'),
      ev('turn/start', { turn: 1 }),
      human('m1', 'first'),
      ev('step/start'),
      ev('turn/end'), // seq 5
      ev('turn/start', { turn: 2 }),
      ev('step/start'), // a wake turn: no point
      ev('developer/message'),
      ev('turn/end'), // seq 9
      ev('turn/start', { turn: 3 }),
      human('m3', 'x'.repeat(REWIND_TEXT_MAX + 10), [{ type: 'image' }]),
      human('steer', 'a steer is part of turn 3'),
      ev('turn/end'),
      ev('turn/start', { turn: 4 }),
      ev('user/message', { id: 'other', source: { kind: 'plugin' }, content: [] }),
    ];
    const points = rewindPoints(events);
    expect(points.map((p) => p.messageId)).toEqual(['m1', 'm3']);
    expect(points[0]).toEqual({ messageId: 'm1', text: 'first', at: 30 });
    expect(points[1]!.forkSeq).toBe(9);
    expect(points[1]!.attachments).toBe(1);
    expect(points[1]!.text.length).toBe(REWIND_TEXT_MAX + 1); // cut, with an ellipsis
  });

  it('marks the points of a fork prefix as inherited', () => {
    seq = 0;
    const events = [
      ev('turn/start'),
      human('a', 'kept'),
      ev('turn/end'),
      ev('session/end-seed', { inherited: true }),
      ev('turn/start'),
      human('b', 'mine'),
    ];
    const points = rewindPoints(events);
    expect(points[0]!.inherited).toBe(true);
    expect(points[1]!.inherited).toBeUndefined();
    expect(points[1]!.forkSeq).toBe(3);
  });

  it('the rewind route answer carries the points; the runtime never spawns for it', async () => {
    const f = fakeFactory();
    const { port } = fakePort(undefined, {
      rewindPoints: () => [{ messageId: 'm1', text: 'hi', at: 1 }],
    });
    const rt = new SessionRuntime(f.factory, port, { env: {} });
    const o = await rt.rewindOptions();
    expect(o.points).toEqual([{ messageId: 'm1', text: 'hi', at: 1 }]);
    expect(f.opened).toHaveLength(0);
    const broken = new SessionRuntime(
      f.factory,
      fakePort(undefined, {
        rewindPoints: () => {
          throw new Error('no log');
        },
      }).port,
      { env: {} },
    );
    expect((await broken.rewindOptions()).points).toEqual([]);
    await rt.dispose();
    await broken.dispose();
  });

  it('an unstarted fork says so in the view', async () => {
    const f = fakeFactory();
    const { port } = fakePort({ sessionId: 'src', hostSessionId: 'h1', chainId: 'c9' });
    const rt = new SessionRuntime(f.factory, port, { env: {} });
    expect(rt.view().lifecycle?.unstartedFork).toBe(true);
    await rt.dispose();
  });

  it('places the rewind command as the rewind panel row', () => {
    const plan = planCommandMenu(
      [
        { name: 'rewind', aliases: ['checkpoint', 'undo'], terminalOnly: true },
        { name: 'doctor', terminalOnly: true },
      ],
      { rewindCommand: 'rewind', displayName: 'Agent' },
    );
    expect(plan.rows.map((r) => r.menu)).toEqual(['rewind-panel', 'terminal-only']);
  });
});
