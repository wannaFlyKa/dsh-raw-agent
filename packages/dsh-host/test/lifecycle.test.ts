// Session lifecycle (D4, D6, D8, D25, D27, D47, D75, D87) against a scripted backend. No processes.

import { describe, expect, it } from 'vitest';
import {
  AsyncQueue,
  type AgentBackendFactory,
  type AgentBackendSession,
  type BackendEvent,
  type UserInput,
} from '@dsh-raw-agent/core';
import {
  SessionRegistry,
  SessionRuntime,
  TEARDOWN_REASONS,
  crashMessage,
  lifecycleRoutes,
  startJob,
  type HostSessionPort,
  type RuntimeState,
  type TurnSink,
} from '@dsh-raw-agent/dsh-host';

const MAIN = { kind: 'main' } as const;

interface Fake {
  factory: AgentBackendFactory;
  sessions: Array<{
    q: AsyncQueue<BackendEvent>;
    sent: UserInput[];
    interrupts: unknown[];
    disposed: number;
    forced: number;
  }>;
  push(e: BackendEvent): void;
  cancelled: string[];
}

function fakeFactory(onSend?: (input: UserInput, push: (e: BackendEvent) => void) => void): Fake {
  const f: Fake = {
    sessions: [],
    cancelled: [],
    push: (e) => f.sessions.at(-1)!.q.push(e),
    factory: {
      kind: 'k',
      displayName: 'Agent',
      staticCapabilities: {
        ids: 'agent-chosen',
        resume: true,
        fork: 'none',
        needsProcess: [],
        permissionModes: [],
        mainAgentPicker: 'none',
        steer: 'native',
      },
      async open() {
        const q = new AsyncQueue<BackendEvent>();
        const rec = { q, sent: [] as UserInput[], interrupts: [] as unknown[], disposed: 0, forced: 0 };
        f.sessions.push(rec);
        const end = () => {
          q.push({ type: 'exit' });
          q.end();
        };
        const s: AgentBackendSession = {
          kind: 'k',
          sessionId: `b${f.sessions.length}`,
          startedAs: 'new',
          capabilities: {
            perTaskStop: true,
            sideQuestions: false,
            workflows: false,
            teamMessaging: false,
            cancelQueued: true,
            fileRewind: false,
            planChoices: [],
          },
          events: () => q,
          async send(input) {
            rec.sent.push(input);
            onSend?.(input, (e) => q.push(e));
          },
          async interrupt(opts) {
            rec.interrupts.push(opts);
            return { cancelledInputIds: opts?.cancelQueued ? f.cancelled : [] };
          },
          async forceStop() {
            rec.forced++;
            end();
          },
          async dispose() {
            rec.disposed++;
            end();
          },
          controls: {},
        };
        return s;
      },
    },
  };
  return f;
}

function fakePort(over: Partial<HostSessionPort> = {}) {
  const log = { wakes: 0, warnings: [] as unknown[], drafts: [] as string[], states: [] as RuntimeState[] };
  const port: HostSessionPort = {
    hostSessionId: 'h1',
    cwd: '/w',
    wake: () => void log.wakes++,
    latestBinding: () => undefined,
    startJob: () => undefined,
    warn: (n, d) => void log.warnings.push([n, d]),
    returnDraft: (id) => void log.drafts.push(id),
    notify: (s) => void log.states.push(s),
    ...over,
  };
  return { port, log };
}

function fakeSink() {
  const ops: string[] = [];
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
      const c = m.blocks.filter((b) => b.type === 'tool-call').map((b) => (b as { id: string }).id);
      for (const id of c) calls.set(id, false);
      ops.push(`commit${m.continued ? '+' : ''}`);
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
    claim: (id) => {
      ops.push(`claim ${id}`);
      return true;
    },
  };
  return { sink, ops };
}

const input = (id: string): UserInput => ({ id, parts: [{ type: 'text', text: id }] });
const tick = () => new Promise((r) => setTimeout(r, 5));
const turn = (text = 'x'): BackendEvent[] => [
  { type: 'turn-start', origin: 'user' },
  { type: 'step-start', agent: MAIN, stepId: 's', at: 0 },
  { type: 'step-message', agent: MAIN, stepId: 's', blocks: [{ type: 'text', text }], final: true },
  { type: 'turn-end', agent: MAIN, outcome: 'completed', pendingInputs: 0 },
];

describe('spawn rule (D4)', () => {
  it('opens no process until a message or start()', async () => {
    const f = fakeFactory();
    const { port, log } = fakePort();
    const rt = new SessionRuntime(f.factory, port, { env: {} });
    expect(rt.state().process).toBe('none');
    expect(
      (await rt.runTurn(fakeSink().sink, { userInputs: [], wake: false }, new AbortController().signal)).kind,
    ).toBe('nothing');
    expect(f.sessions).toHaveLength(0);
    await rt.start();
    expect(f.sessions).toHaveLength(1);
    expect(f.sessions[0]!.sent).toHaveLength(0);
    expect(rt.state().process).toBe('running');
    expect(log.states.at(-1)?.process).toBe('running');
    await rt.dispose();
  });
});

describe('steer and queue (D27)', () => {
  it('sends a steer at once, claims it after consumption, and ends the turn only when nothing is pending', async () => {
    const f = fakeFactory((i, push) => {
      if (i.id === 'u1')
        for (const e of [
          { type: 'turn-start', origin: 'user' },
          { type: 'step-start', agent: MAIN, stepId: 's1', at: 0 },
          {
            type: 'step-message',
            agent: MAIN,
            stepId: 's1',
            blocks: [{ type: 'tool-call', id: 't', name: 'Bash', arguments: '{}' }],
            final: true,
          },
        ] as BackendEvent[])
          push(e);
    });
    const { port } = fakePort();
    const rt = new SessionRuntime(f.factory, port, { env: {} });
    expect(rt.steer('m0', input('early'))).toBe(false); // no turn of ours: DSH claims it later
    const { sink, ops } = fakeSink();
    const done = rt.runTurn(sink, { userInputs: [input('u1')], wake: false }, new AbortController().signal);
    await tick();
    expect(rt.steer('m2', input('u2'))).toBe(true);
    expect(rt.steer('m2', input('u2'))).toBe(true); // a repeat is not sent twice
    await tick();
    expect(f.sessions[0]!.sent.map((i) => i.id)).toEqual(['u1', 'u2']);
    f.push({ type: 'tool-result', agent: MAIN, callId: 't', isError: false, content: [] });
    f.push({ type: 'input-consumed', inputId: 'u2' }); // between steps: claimed at once
    f.push({ type: 'turn-end', agent: MAIN, outcome: 'completed', pendingInputs: 1 }); // a further CLI turn follows
    for (const e of turn('steered')) f.push(e);
    expect((await done).kind).toBe('completed');
    expect(ops).toEqual(['open', 'commit', 'result t', 'close', 'claim m2', 'open', 'commit', 'close']);
    await rt.dispose();
  });

  it('a steer sent while the process starts goes out after the turn input', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = fakeFactory((i, push) => {
      if (i.id === 'u2') for (const e of turn()) push(e);
    });
    const open = f.factory.open.bind(f.factory);
    f.factory.open = async (o) => {
      await gate;
      return open(o);
    };
    const rt = new SessionRuntime(f.factory, fakePort().port, { env: {} });
    const done = rt.runTurn(fakeSink().sink, { userInputs: [input('u1')], wake: false }, new AbortController().signal);
    await tick();
    expect(rt.steer('m2', input('u2'))).toBe(true);
    release();
    await done;
    expect(f.sessions[0]!.sent.map((i) => i.id)).toEqual(['u1', 'u2']);
    await rt.dispose();
  });
});

describe('agent notices (M1 live)', () => {
  it('keeps the last notice in the view and never writes it to the turn', async () => {
    const f = fakeFactory((i, push) => {
      if (i.id !== 'u1') return;
      push({ type: 'turn-start', origin: 'user' });
      push({ type: 'notice', level: 'notice', text: 'Using claude-opus-5-5 instead.' });
      push({ type: 'turn-end', agent: MAIN, outcome: 'completed', pendingInputs: 0 });
    });
    const { port, log } = fakePort();
    const { sink, ops } = fakeSink();
    const rt = new SessionRuntime(f.factory, port, { env: {} });
    expect(
      (await rt.runTurn(sink, { userInputs: [input('u1')], wake: false }, new AbortController().signal)).kind,
    ).toBe('completed');
    expect(rt.view().live.notice).toMatchObject({ level: 'notice', text: 'Using claude-opus-5-5 instead.' });
    expect(ops.join(' ')).not.toContain('opus');
    expect(log.warnings.length).toBeGreaterThan(0);
    await rt.dispose();
  });
});

describe('Stop (rule 6, D25)', () => {
  it('interrupts with cancelQueued when a steer is queued, and returns its text', async () => {
    const f = fakeFactory((i, push) => {
      if (i.id === 'u1') push({ type: 'turn-start', origin: 'user' });
    });
    f.cancelled = ['u2'];
    const { port, log } = fakePort();
    const rt = new SessionRuntime(f.factory, port, { env: {} });
    const ac = new AbortController();
    const done = rt.runTurn(fakeSink().sink, { userInputs: [input('u1')], wake: false }, ac.signal);
    await tick();
    rt.steer('m2', input('u2'));
    await tick();
    ac.abort();
    await tick();
    f.push({ type: 'turn-end', agent: MAIN, outcome: 'interrupted', pendingInputs: 0 });
    expect((await done).kind).toBe('interrupted');
    expect(f.sessions[0]!.interrupts).toEqual([{ cancelQueued: true }]);
    expect(log.drafts).toEqual(['m2']);
    expect(f.sessions[0]!.disposed).toBe(0);
    await rt.dispose();
  });

  it('a steer the agent cancelled before the receipt goes back and is never claimed (M1 live)', async () => {
    // CLI 2.1.318: `command_lifecycle cancelled` arrives before the interrupt receipt, which then
    // lists nothing; the turn end must not mark the cancelled steer consumed.
    const f = fakeFactory((i, push) => {
      if (i.id === 'u1') push({ type: 'turn-start', origin: 'user' });
    });
    f.cancelled = [];
    const { port, log } = fakePort();
    const { sink, ops } = fakeSink();
    const rt = new SessionRuntime(f.factory, port, { env: {} });
    const ac = new AbortController();
    const done = rt.runTurn(sink, { userInputs: [input('u1')], wake: false }, ac.signal);
    await tick();
    rt.steer('m2', input('u2'));
    await tick();
    ac.abort();
    f.push({ type: 'input-cancelled', inputId: 'u2' });
    await tick();
    f.push({ type: 'turn-end', agent: MAIN, outcome: 'interrupted', pendingInputs: 0 });
    expect((await done).kind).toBe('interrupted');
    expect(f.sessions[0]!.interrupts).toEqual([{ cancelQueued: true }]);
    expect(log.drafts).toEqual(['m2']);
    expect(ops.filter((o) => o.startsWith('claim'))).toEqual([]);
    await rt.dispose();
  });

  it('a plain interrupt with no queued steer; the grace timer returns unconsumed steers', async () => {
    const f = fakeFactory();
    const { port, log } = fakePort();
    const rt = new SessionRuntime(f.factory, port, { env: {}, stopGraceMs: 20 });
    const ac = new AbortController();
    const done = rt.runTurn(fakeSink().sink, { userInputs: [input('u1')], wake: false }, ac.signal);
    await tick();
    ac.abort();
    rt.steer('late', input('u3')); // typed after Stop, never taken by the agent
    expect((await done).kind).toBe('interrupted');
    expect(f.sessions[0]!.interrupts).toEqual([undefined]);
    expect(log.drafts).toEqual(['late']);
    expect(rt.state().process).toBe('running'); // Stop never ends the process
    await rt.dispose();
  });
});

describe('crash and idle death (D8, D74, D75)', () => {
  it('a crash mid-turn closes the open step and reports clearly', async () => {
    const f = fakeFactory((_, push) => {
      push({ type: 'turn-start', origin: 'user' });
      push({ type: 'step-start', agent: MAIN, stepId: 's', at: 0 });
      push({ type: 'exit', error: 'exit code 137' });
    });
    const { port } = fakePort();
    const rt = new SessionRuntime(f.factory, port, { env: {} });
    const { sink, ops } = fakeSink();
    const out = await rt.runTurn(sink, { userInputs: [input('u1')], wake: false }, new AbortController().signal);
    expect(out).toEqual({ kind: 'error', message: crashMessage('Agent', 'exit code 137') });
    expect(ops).toEqual(['open', 'close']);
    expect(rt.state()).toMatchObject({
      process: 'none',
      turn: false,
      lastExit: { error: 'exit code 137', duringTurn: true },
    });
    await rt.dispose();
  });

  it('an idle death is a notice, not a log event; the next turn spawns again', async () => {
    const f = fakeFactory((_, push) => {
      for (const e of turn()) push(e);
    });
    const { port, log } = fakePort();
    const rt = new SessionRuntime(f.factory, port, { env: {} });
    await rt.start();
    f.push({ type: 'exit', error: 'killed' });
    await tick();
    expect(rt.state().lastExit).toMatchObject({ error: 'killed', duringTurn: false });
    expect(log.warnings.some((w) => String((w as unknown[])[0]).includes('ended while idle'))).toBe(true);
    await rt.runTurn(fakeSink().sink, { userInputs: [input('u1')], wake: false }, new AbortController().signal);
    expect(f.sessions).toHaveLength(2);
    expect(rt.state().lastExit).toBeUndefined();
    await rt.dispose();
  });

  it('force stop ends the process without a crash report', async () => {
    const f = fakeFactory();
    const rt = new SessionRuntime(f.factory, fakePort().port, { env: {} });
    await rt.start();
    await rt.forceStop();
    await tick();
    expect(f.sessions[0]!.forced).toBe(1);
    expect(rt.state()).toEqual({ process: 'none', turn: false, backgroundTasks: 0 });
  });
});

describe('idle reaping (D6) and the registry (D87)', () => {
  it('never reaps with a background task; reaps after the timeout; the next turn opens a new process', async () => {
    let now = 0;
    const f = fakeFactory((_, push) => {
      for (const e of turn()) push(e);
    });
    const rt = new SessionRuntime(f.factory, fakePort().port, { env: {}, now: () => now });
    const reg = new SessionRegistry({ idleReapMs: () => 1000, now: () => now });
    reg.set('h1', 'k', rt);
    await rt.start();
    f.push({ type: 'task-start', taskId: 'bg', kind: 'shell', label: 'sleep' });
    await tick();
    now = 5000;
    expect(await reg.reapIdle()).toEqual([]); // a background task keeps it alive (rules 6, 7)
    f.push({ type: 'task-end', taskId: 'bg', status: 'completed' });
    await tick();
    now = 5500;
    expect(await reg.reapIdle()).toEqual([]); // idle for only 500 ms
    now = 7000;
    expect(await reg.reapIdle()).toEqual(['h1']);
    await tick();
    expect(f.sessions[0]!.disposed).toBe(1);
    expect(rt.state().lastExit).toBeUndefined(); // reaping is not a crash
    await rt.runTurn(fakeSink().sink, { userInputs: [input('u1')], wake: false }, new AbortController().signal);
    expect(f.sessions).toHaveLength(2);
    await reg.disposeAll();
    expect(f.sessions[1]!.disposed).toBe(1);
  });

  it('reaping is off by default', async () => {
    const f = fakeFactory();
    const rt = new SessionRuntime(f.factory, fakePort().port, { env: {}, now: () => 0 });
    const reg = new SessionRegistry({ now: () => 1e12 });
    reg.set('h1', 'k', rt);
    await rt.start();
    expect(await reg.reapIdle()).toEqual([]);
    await reg.disposeAll();
  });

  it('a detached runtime keeps its process; a self-started turn wakes the next attached agent', async () => {
    const f = fakeFactory();
    const first = fakePort();
    const rt = new SessionRuntime(f.factory, first.port, { env: {} });
    await rt.start();
    rt.detach();
    f.push({ type: 'turn-start', origin: 'self' });
    await tick();
    expect(first.log.wakes).toBe(0);
    const second = fakePort();
    rt.attach(second.port);
    expect(second.log.wakes).toBe(1);
    expect(f.sessions[0]!.disposed).toBe(0);
    await rt.dispose();
  });
});

describe('lifecycle routes', () => {
  it('start, state with returned drafts once, force stop; unknown sessions are 404', async () => {
    const f = fakeFactory();
    const rt = new SessionRuntime(f.factory, fakePort().port, { env: {} });
    const reg = new SessionRegistry();
    reg.set('h1', 'k', rt);
    reg.noteDraft('h1', { messageId: 'm', text: 'hi', at: 1 });
    const [start, force, state] = lifecycleRoutes(reg);
    const call = async (r: typeof start, q: string) => {
      const res = await r!.fetch(new Request(`http://x${r!.path}?${q}`, { method: r!.methods[0] }));
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    expect((await call(start, 'session=nope')).status).toBe(404);
    expect((await call(start, '')).status).toBe(400);
    expect((await call(start, 'session=h1')).body).toMatchObject({ state: { process: 'running' } });
    expect((await call(state, 'session=h1')).body.returnedDrafts).toEqual([{ messageId: 'm', text: 'hi', at: 1 }]);
    expect((await call(state, 'session=h1')).body.returnedDrafts).toEqual([]);
    await call(force, 'session=h1');
    expect(f.sessions[0]!.forced).toBe(1);
  });
});

describe('job teardown (D47)', () => {
  it('a DSH teardown settles the job locally and never stops the task; a user kill stops it', async () => {
    const run = (reason: string) => {
      let cancel!: (r?: string) => void;
      let done!: Promise<{ status: string }>;
      let stopped = 0;
      const jobs = {
        start(spec: { run(h: unknown): { cancel(r?: string): void; done: Promise<{ status: string }> } }) {
          const hooks = spec.run({ id: 'j', append() {}, updateProgress() {} });
          cancel = hooks.cancel;
          done = hooks.done;
          return 'j';
        },
        wait: async () => ({ status: 'running' }),
        attachController: () => () => {},
      };
      const link = startJob(
        jobs as never,
        'owner',
        { taskId: 't', kind: 'shell', label: 'l' },
        () => void stopped++,
        () => {},
      );
      cancel(reason);
      return { link, done, stopped: () => stopped };
    };
    for (const reason of TEARDOWN_REASONS) {
      const t = run(reason);
      expect(t.stopped()).toBe(0);
      expect(await t.done).toEqual({ status: 'killed', detail: reason });
    }
    const k = run('killed by user');
    expect(k.stopped()).toBe(1);
    k.link!.end('stopped');
    expect((await k.done).status).toBe('killed');
  });
});

describe('Host config across bundles (D87)', () => {
  it('the registry carries the Host entry user config getter', () => {
    let path = 'a';
    const reg = new SessionRegistry({ userConfig: () => ({ executablePath: path, options: {} }) });
    path = 'b';
    expect(reg.userConfig?.()).toEqual({ executablePath: 'b', options: {} });
  });
});

describe('M1 verify 2 edge cases', () => {
  it('dispose during a running turn ends it as stopped, not with the crash text', async () => {
    const f = fakeFactory((_, push) => {
      push({ type: 'turn-start', origin: 'user' });
      push({ type: 'step-start', agent: MAIN, stepId: 's', at: 0 });
    });
    const { port } = fakePort();
    const rt = new SessionRuntime(f.factory, port, { env: {} });
    const done = rt.runTurn(fakeSink().sink, { userInputs: [input('u1')], wake: false }, new AbortController().signal);
    await tick();
    await rt.dispose();
    expect(await done).toEqual({ kind: 'interrupted' });
    expect(rt.state().lastExit).toBeUndefined();
  });

  it('a send that fails after an earlier input was sent keeps the turn for the sent work, then reports', async () => {
    const f = fakeFactory((i, push) => {
      push({ type: 'input-consumed', inputId: i.id });
      for (const e of turn('done')) push(e);
    });
    const { port } = fakePort();
    const rt = new SessionRuntime(f.factory, port, { env: {} });
    await rt.start();
    const session = f.sessions[0]!;
    const backend = rt.backend!;
    const send = backend.send.bind(backend);
    backend.send = async (u, mode) => {
      if (u.id === 'bad') throw new Error('path holds a quote and a space');
      return send(u, mode);
    };
    const { sink, ops } = fakeSink();
    const out = await rt.runTurn(
      sink,
      { userInputs: [input('good'), input('bad')], wake: false },
      new AbortController().signal,
    );
    expect(out).toEqual({ kind: 'error', message: 'Agent was not sent a message: path holds a quote and a space' });
    expect(session.sent.map((u) => u.id)).toEqual(['good']);
    expect(ops).toEqual(['open', 'commit', 'close']); // the sent message's answer is in this turn
    // Nothing is left waiting: the next turn runs at once and opens no wake turn.
    const next = await rt.runTurn(
      fakeSink().sink,
      { userInputs: [input('u3')], wake: false },
      new AbortController().signal,
    );
    expect(next.kind).toBe('completed');
    await rt.dispose();
  });

  it('a send that fails with nothing sent ends the turn at once with the error', async () => {
    const f = fakeFactory();
    const { port } = fakePort();
    const rt = new SessionRuntime(f.factory, port, { env: {} });
    await rt.start();
    rt.backend!.send = async () => {
      throw new Error('refused');
    };
    const out = await rt.runTurn(
      fakeSink().sink,
      { userInputs: [input('x')], wake: false },
      new AbortController().signal,
    );
    expect(out).toEqual({ kind: 'error', message: 'Agent was not sent a message: refused' });
    await rt.dispose();
  });

  it('events of a stopped turn that arrive after the grace timeout open no extra wake turn', async () => {
    const f = fakeFactory((_, push) => {
      push({ type: 'turn-start', origin: 'user' });
      push({ type: 'step-start', agent: MAIN, stepId: 's', at: 0 });
    });
    const { port, log } = fakePort();
    const rt = new SessionRuntime(f.factory, port, { env: {}, stopGraceMs: 20 });
    const ac = new AbortController();
    const done = rt.runTurn(fakeSink().sink, { userInputs: [input('u1')], wake: false }, ac.signal);
    await tick();
    ac.abort();
    expect((await done).kind).toBe('interrupted');
    f.push({ type: 'tool-result', agent: MAIN, callId: 't', content: [], isError: true });
    f.push({ type: 'turn-end', agent: MAIN, outcome: 'interrupted', pendingInputs: 0 });
    await tick();
    expect(log.wakes).toBe(0);
    // After that late turn end, a turn the agent starts by itself wakes as before (D26).
    for (const e of turn('self')) f.push(e);
    await tick();
    expect(log.wakes).toBe(1);
    await rt.dispose();
  });
});
