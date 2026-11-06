// M3 host-children unit tests (D45, D46, D47, D50, D68, D74, D26 trigger). No DSH, no processes.

import { describe, expect, it } from 'vitest';
import { AsyncQueue, type AgentBackendFactory, type AgentBackendSession, type BackendEvent } from '@dsh-raw-agent/core';
import {
  ChildHub,
  JOB_LIMIT_CONFIG_KEY,
  SessionRuntime,
  isJobLimitError,
  startJob,
  type ChildHandle,
  type ChildRunner,
  type ChildSpec,
  type HostSessionPort,
  type JobLink,
  type TurnSink,
} from '@dsh-raw-agent/dsh-host';

const MAIN = { kind: 'main' } as const;
const child = (id: string) => ({ kind: 'child', id }) as const;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

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
    delta: () => void ops.push('delta'),
    commit: (m) => {
      has = true;
      const c = m.blocks.filter((b) => b.type === 'tool-call').map((b) => (b as { id: string }).id);
      for (const id of c) calls.set(id, false);
      ops.push(`commit${m.continued ? '+' : ''}${m.usage ? ' usage' : ''}`);
      return { calls: c };
    },
    result: (id) => {
      calls.set(id, true);
      ops.push(`result ${id}`);
    },
    closeStep: () => {
      if (!open) return;
      for (const [id, r] of calls) if (!r) ops.push(`repair ${id}`);
      open = false;
      ops.push('close');
    },
    claim: () => false,
    approvalAsked: (info) => {
      ops.push(`asked ${info.toolName}`);
      return 'audit-1';
    },
    approvalDecided: (_id, outcome) => void ops.push(`decided ${outcome}`),
    trigger: (text) => void ops.push(`trigger ${text}`),
  };
  return { sink, ops };
}

/** A port side that runs each child turn at once with a fresh fake sink. */
function fakeChildren() {
  const made: Array<{
    spec: ChildSpec;
    runner: ChildRunner;
    prompts: string[];
    parent: string;
    sinks: ReturnType<typeof fakeSink>[];
    outcomes: unknown[];
  }> = [];
  const make =
    (parent: string) =>
    async (spec: ChildSpec, runner: ChildRunner): Promise<ChildHandle> => {
      const rec = {
        spec,
        runner,
        prompts: [] as string[],
        parent,
        sinks: [] as ReturnType<typeof fakeSink>[],
        outcomes: [] as unknown[],
      };
      made.push(rec);
      let chain = Promise.resolve();
      return {
        hostSessionId: `host-${spec.ref}`,
        begin(prompt) {
          rec.prompts.push(prompt);
          chain = chain.then(async () => {
            const s = fakeSink();
            rec.sinks.push(s);
            rec.outcomes.push(await runner(s.sink, new AbortController().signal));
          });
        },
        createChild: make(spec.ref),
        dispose: async () => {},
      };
    };
  return { made, root: make('main') };
}

const start = (id: string, over: Partial<Extract<BackendEvent, { type: 'agent-start' }>> = {}): BackendEvent => ({
  type: 'agent-start',
  ref: child(id),
  parent: MAIN,
  label: id,
  role: 'subagent',
  background: false,
  taskId: id,
  taskPrompt: `prompt ${id}`,
  at: 0,
  ...over,
});
const stepStart = (id: string, step: string): BackendEvent => ({
  type: 'step-start',
  agent: child(id),
  stepId: step,
  at: 0,
});
const msg = (id: string, step: string, call?: string): BackendEvent => ({
  type: 'step-message',
  agent: child(id),
  stepId: step,
  blocks: call ? [{ type: 'tool-call', id: call, name: 'Bash', arguments: '{}' }] : [{ type: 'text', text: 't' }],
  final: false,
  // A placeholder the child writer must never write (D68).
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
});
const result = (id: string, call: string): BackendEvent => ({
  type: 'tool-result',
  agent: child(id),
  callId: call,
  isError: false,
  content: [{ type: 'text', text: 'ok' }],
});

function hub(over: Partial<ConstructorParameters<typeof ChildHub>[0]> = {}) {
  const f = fakeChildren();
  const warnings: unknown[] = [];
  const stopped: string[] = [];
  const h = new ChildHub({
    now: Date.now,
    warn: (n, d) => void warnings.push([n, d]),
    notify: () => {},
    createRootChild: f.root,
    stopTask: async (id) => void stopped.push(id),
    imageText: (m) => `[image ${m}]`,
    ...over,
  });
  return { h, f, warnings, stopped };
}

describe('ChildHub (D45, D68)', () => {
  it('writes a child turn in the D68 shape: one step per message id, no usage, no deltas', async () => {
    const { h, f } = hub();
    h.handle(start('a'));
    for (const e of [
      stepStart('a', 's1'),
      msg('a', 's1'),
      { type: 'delta', agent: child('a'), stepId: 's1', kind: 'text', blockIndex: 0, text: 'x', at: 0 } as BackendEvent,
      msg('a', 's1', 'c1'),
      result('a', 'c1'),
      stepStart('a', 's2'),
      msg('a', 's2'),
      { type: 'agent-end', ref: child('a'), status: 'completed' } as BackendEvent,
    ])
      h.handle(e);
    await tick(20);
    expect(f.made[0]!.prompts).toEqual(['prompt a']);
    expect(f.made[0]!.sinks[0]!.ops).toEqual([
      'open',
      'commit',
      'commit+',
      'result c1',
      'close',
      'open',
      'commit',
      'close',
    ]);
    expect(f.made[0]!.outcomes).toEqual([{ kind: 'completed' }]);
    expect(h.views()[0]).toMatchObject({ id: 'a', status: 'completed', hostSessionId: 'host-a' });
  });

  it('a new step waits until every call of the open step has its result', async () => {
    const { h, f } = hub();
    h.handle(start('a'));
    for (const e of [
      stepStart('a', 's1'),
      msg('a', 's1', 'c1'),
      stepStart('a', 's2'),
      msg('a', 's2'),
      result('a', 'c1'),
    ])
      h.handle(e);
    h.handle({ type: 'agent-end', ref: child('a'), status: 'completed' });
    await tick(20);
    expect(f.made[0]!.sinks[0]!.ops).toEqual(['open', 'commit', 'result c1', 'close', 'open', 'commit', 'close']);
  });

  it('an end with an open call writes the repair result (D74)', async () => {
    const { h, f } = hub();
    h.handle(start('a'));
    h.handle(stepStart('a', 's1'));
    h.handle(msg('a', 's1', 'c1'));
    h.endAll('failed', 'the agent died');
    await tick(20);
    expect(f.made[0]!.sinks[0]!.ops).toEqual(['open', 'commit', 'repair c1', 'close']);
    expect(f.made[0]!.outcomes).toEqual([{ kind: 'error', message: 'the agent died' }]);
  });

  it('nests by parent: the inner child is created under the outer one', async () => {
    const { h, f } = hub();
    h.handle(start('outer'));
    h.handle(start('inner', { parent: child('outer'), depth: 2 }));
    await tick(20);
    expect(f.made.map((m) => [m.spec.ref, m.parent, m.spec.depth])).toEqual([
      ['outer', 'main', 1],
      ['inner', 'outer', 2],
    ]);
    expect(h.views().map((v) => v.parent)).toEqual(['main', 'outer']);
  });

  it('a woken teammate runs a second turn in the same child; roster and messages', async () => {
    const { h, f } = hub({ teamMessaging: () => false });
    h.handle(start('alice', { role: 'teammate', team: 't', name: 'alice', background: true }));
    h.handle({ type: 'team-message', from: 'alice', to: 'bob', text: 'ping', agent: child('alice') });
    h.handle({ type: 'agent-end', ref: child('alice'), status: 'completed' });
    await tick(20);
    h.handle(
      start('alice', {
        role: 'teammate',
        team: 't',
        resumed: true,
        wokenBy: 'bob',
        taskPrompt: '<agent-message from="bob">',
      }),
    );
    h.handle({ type: 'agent-end', ref: child('alice'), status: 'completed' });
    await tick(20);
    expect(f.made).toHaveLength(1); // one child session, never a second catalog row
    expect(f.made[0]!.prompts).toEqual(['prompt alice', '<agent-message from="bob">']);
    expect(h.views()[0]).toMatchObject({ wakes: 1, wokenBy: 'bob', status: 'completed' });
    expect(h.team()).toMatchObject({ teams: [{ name: 't', members: ['alice'] }], messaging: false });
    expect(h.team()!.messages[0]).toMatchObject({ from: 'alice', to: 'bob', text: 'ping', sender: 'alice' });
  });

  it('endForeground ends foreground children only; background and teammates keep running', () => {
    const { h } = hub();
    h.handle(start('fg'));
    h.handle(start('bg', { background: true }));
    h.handle(start('tm', { role: 'teammate' }));
    h.endForeground();
    expect(h.views().map((v) => v.status)).toEqual(['stopped', 'running', 'running']);
  });

  it('per-child stop calls stopTask and waits for the end, else reports stopping (D46)', async () => {
    const { h, stopped } = hub();
    h.handle(start('a'));
    h.handle(start('b'));
    const p = h.stop('a', 500);
    await tick();
    h.handle({ type: 'agent-end', ref: child('a'), status: 'stopped' });
    expect(await p).toEqual({ ok: true, status: 'stopped' });
    expect(await h.stop('b', 10)).toEqual({ ok: true, status: 'stopping' });
    expect(stopped).toEqual(['a', 'b']);
    expect(h.views()[1]!.stopping).toBe(true);
    expect(await h.stop('zzz')).toMatchObject({ ok: false, status: 'unknown' });
  });

  it('a stopped child turn reports the user as its cause', async () => {
    const { h, f } = hub();
    h.handle(start('a'));
    await tick(10);
    const p = h.stop('a', 100);
    h.handle({ type: 'agent-end', ref: child('a'), status: 'stopped' });
    await p;
    await tick(10);
    expect(f.made[0]!.outcomes).toEqual([{ kind: 'stopped', cause: 'user' }]);
  });

  it('task progress fills tokens and tool counts; images become text', async () => {
    const { h, f } = hub();
    h.handle(start('a'));
    expect(h.progress('a', { tokens: 10, toolUses: 2 })).toBe(true);
    expect(h.progress('other', { tokens: 1 })).toBe(false);
    expect(h.views()[0]).toMatchObject({ tokens: 10, toolUses: 2 });
    h.handle(stepStart('a', 's'));
    h.handle(msg('a', 's', 'c'));
    h.handle({
      ...result('a', 'c'),
      content: [{ type: 'image', mediaType: 'image/png', base64: 'AA' }],
    } as BackendEvent);
    h.handle({ type: 'agent-end', ref: child('a'), status: 'completed' });
    await tick(20);
    expect(f.made[0]!.sinks[0]!.ops).toContain('result c');
  });

  it('a child with no host session drops its events and says why', async () => {
    const { h, warnings } = hub({ createRootChild: () => Promise.reject(new Error('no registry')) });
    h.handle(start('a'));
    h.handle(stepStart('a', 's'));
    await tick(10);
    expect(h.views()[0]!.noSession).toBe(true);
    expect(String((warnings[0] as unknown[])[1])).toMatch(/no registry/);
  });
});

// ---- runtime integration: jobs (D47), wake trigger (D26), child asks (D44) ----

function fakeFactory(): { factory: AgentBackendFactory; push(e: BackendEvent): void; stopped: string[] } {
  let q: AsyncQueue<BackendEvent> | undefined;
  const stopped: string[] = [];
  return {
    stopped,
    push: (e) => q!.push(e),
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
        q = new AsyncQueue<BackendEvent>();
        const s: AgentBackendSession = {
          kind: 'k',
          sessionId: 'b1',
          startedAs: 'new',
          capabilities: {
            perTaskStop: true,
            sideQuestions: false,
            workflows: false,
            teamMessaging: false,
            cancelQueued: false,
            fileRewind: false,
            planChoices: [],
          },
          events: () => q!,
          async send() {},
          async interrupt() {
            return { cancelledInputIds: [] };
          },
          async forceStop() {
            q!.push({ type: 'exit' });
            q!.end();
          },
          async dispose() {
            q!.push({ type: 'exit' });
            q!.end();
          },
          controls: {
            async stopTask(id) {
              stopped.push(id);
            },
          },
        };
        return s;
      },
    },
  };
}

function port(over: Partial<HostSessionPort> = {}): HostSessionPort {
  return {
    hostSessionId: 'h',
    cwd: '/w',
    wake: () => {},
    latestBinding: () => undefined,
    startJob: () => undefined,
    warn: () => {},
    ...over,
  };
}

describe('jobs polish (D47)', () => {
  it('the per-owner limit gives a plugin-only task row with a Stop that calls stopTask', async () => {
    const f = fakeFactory();
    const rt = new SessionRuntime(
      f.factory,
      port({ startJob: () => ({ refused: 'background job limit reached for this owner (limit: 10)', limit: true }) }),
      { env: {} },
    );
    await rt.start();
    f.push({ type: 'task-start', taskId: 't1', kind: 'shell', label: 'sleep' });
    f.push({ type: 'task-progress', taskId: 't1', summary: 'tick' });
    await tick();
    const row = rt.view().tasks![0]!;
    expect(row).toMatchObject({ taskId: 't1', job: false, status: 'running', progress: 'tick' });
    expect(row.note).toContain(JOB_LIMIT_CONFIG_KEY);
    expect(row.note).not.toMatch(/job_kill/); // DSH's text names its model tool; never shown
    expect(await rt.stopTask('t1')).toEqual({ ok: true });
    expect(f.stopped).toEqual(['t1']);
    expect(await rt.stopTask('nope')).toMatchObject({ ok: false });
    await rt.dispose();
  });

  it('a job dropped on teardown is linked again when the agent attaches (eviction, D87)', async () => {
    const f = fakeFactory();
    const teardowns: Array<() => void> = [];
    let starts = 0;
    const link: JobLink = { progress() {}, end() {} };
    const startJobFn: HostSessionPort['startJob'] = (_t, _s, onTeardown) => {
      starts++;
      if (onTeardown) teardowns.push(onTeardown);
      return link;
    };
    const rt = new SessionRuntime(f.factory, port({ startJob: startJobFn }), { env: {} });
    await rt.start();
    f.push({ type: 'task-start', taskId: 't1', kind: 'shell', label: 'sleep' });
    await tick();
    expect(rt.runningJobs).toBe(1);
    rt.detach();
    teardowns[0]!(); // the host dropped the job with the evicted agent; the task runs on
    expect(rt.runningJobs).toBe(0);
    expect(f.stopped).toEqual([]); // never stopTask on teardown
    rt.attach(port({ startJob: startJobFn }));
    expect(starts).toBe(2);
    expect(rt.runningJobs).toBe(1);
    expect(rt.view().tasks![0]!.job).toBe(true);
    await rt.dispose();
  });

  it('startJob: a limit refusal is reported, and teardown fires the hook but never stops the task', () => {
    expect(isJobLimitError('background job limit reached for this owner (limit: 10); use job_kill …')).toBe(true);
    const refuse = {
      start: () => {
        throw new Error('background job limit reached for this owner (limit: 1)');
      },
      wait: async () => ({ status: 'x' }),
      attachController: () => () => {},
    };
    expect(
      startJob(
        refuse as never,
        'o',
        { taskId: 't', kind: 'shell', label: 'l' },
        () => {},
        () => {},
      ),
    ).toMatchObject({ limit: true });
    let cancel!: (r?: string) => void;
    const jobs = {
      start(spec: { run(h: unknown): { cancel(r?: string): void } }) {
        cancel = spec.run({ id: 'j', append() {}, updateProgress() {} }).cancel;
        return 'j';
      },
      wait: async () => ({ status: 'running' }),
      attachController: () => () => {},
    };
    let stops = 0;
    let torn = 0;
    startJob(
      jobs as never,
      'o',
      { taskId: 't', kind: 'shell', label: 'l' },
      () => void stops++,
      () => {},
      () => void torn++,
    );
    cancel('owner disposed');
    expect([stops, torn]).toEqual([0, 1]);
  });
});

describe('wake trigger (D26) and child asks (D44)', () => {
  it('a wake turn writes one trigger in its first step, naming what ended in the background', async () => {
    const f = fakeFactory();
    const wakes: string[] = [];
    const rt = new SessionRuntime(f.factory, port({ wake: (s) => void wakes.push(s), startJob: () => undefined }), {
      env: {},
    });
    await rt.start();
    f.push({ type: 'task-start', taskId: 't1', kind: 'shell', label: 'sleep 20' });
    f.push({ type: 'task-end', taskId: 't1', status: 'completed' });
    f.push({ type: 'turn-start', origin: 'self' });
    f.push({ type: 'step-start', agent: MAIN, stepId: 's1', at: 0 });
    await tick();
    expect(wakes).toEqual(['Agent continued on its own after: background shell "sleep 20" finished']);
    const { sink, ops } = fakeSink();
    const done = rt.runTurn(sink, { userInputs: [], wake: true }, new AbortController().signal);
    f.push({ type: 'step-message', agent: MAIN, stepId: 's1', blocks: [{ type: 'text', text: 'done' }], final: true });
    f.push({ type: 'step-start', agent: MAIN, stepId: 's2', at: 0 });
    f.push({ type: 'step-message', agent: MAIN, stepId: 's2', blocks: [{ type: 'text', text: 'more' }], final: true });
    f.push({ type: 'turn-end', agent: MAIN, outcome: 'completed', pendingInputs: 0 });
    expect(await done).toEqual({ kind: 'completed' });
    expect(ops.filter((o) => o.startsWith('trigger'))).toEqual([
      'trigger Agent continued on its own after: background shell "sleep 20" finished',
    ]);
    expect(ops.indexOf('open')).toBeLessThan(ops.findIndex((o) => o.startsWith('trigger')));
    await rt.dispose();
  });

  it('a child agent becomes a child session through the port; per-child stop names it', async () => {
    const f = fakeFactory();
    const kids = fakeChildren();
    const rt = new SessionRuntime(f.factory, port({ createChild: kids.root }), { env: {} });
    await rt.start();
    f.push(start('a', { background: true }));
    f.push(stepStart('a', 's'));
    f.push(msg('a', 's', 'c'));
    await tick(20);
    expect(rt.view().children![0]).toMatchObject({ id: 'a', status: 'running', hostSessionId: 'host-a' });
    const stop = rt.stopChild('a');
    await tick();
    expect(f.stopped).toEqual(['a']);
    f.push({ type: 'agent-end', ref: child('a'), status: 'stopped' });
    expect(await stop).toEqual({ ok: true, status: 'stopped' });
    // The process dies: nothing is left open (D74).
    f.push({ type: 'exit', error: 'boom' });
    await tick(20);
    expect(kids.made[0]!.sinks[0]!.ops).toEqual(['open', 'commit', 'repair c', 'close']);
    await rt.dispose();
  });
});
