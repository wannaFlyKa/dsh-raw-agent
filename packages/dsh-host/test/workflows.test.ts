// M4 host-workflows (R6.5; D47, D48, D49, D74): the workflow recorder (native tool-workflow/*
// records in the parent, members naming their child sessions, order guarantees, stop, crash,
// stale records), the driver wiring (events, view, job stop, stop routes) and the task output
// route (own shells and monitors only).

import { describe, expect, it } from 'vitest';
import {
  AsyncQueue,
  type AgentBackendFactory,
  type BackendEvent,
  type BackendEventOf,
  type TaskOutput,
  type WorkflowAgent,
} from '@dsh-raw-agent/core';
import {
  SessionRegistry,
  SessionRuntime,
  TASK_OUTPUT_MAX_CHARS,
  TASK_OUTPUT_ROUTE,
  WORKFLOW_AGENT_STOP_ROUTE,
  WORKFLOW_EVENT_TYPES,
  WORKFLOW_STOP_ROUTE,
  WorkflowRecorder,
  appendWorkflowRecord,
  channelLine,
  lifecycleRoutes,
  memberOutcomeOfState,
  openWorkflowRuns,
  workflowEventData,
  type ChildHandle,
  type HostSessionPort,
  type RegisteredRuntime,
  type WorkflowRecord,
} from '@dsh-raw-agent/dsh-host';

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const row = (index: number, label: string, state: WorkflowAgent['state'], extra: Partial<WorkflowAgent> = {}) =>
  ({ index, label, state, ...extra }) as WorkflowAgent;
const wfStart = (
  taskId = 't1',
  extra: Partial<BackendEventOf<'workflow-start'>> = {},
): BackendEventOf<'workflow-start'> => ({
  type: 'workflow-start',
  taskId,
  name: 'two-phase',
  label: 'Two phase probe',
  runId: 'wf_1',
  callId: 'call_wf',
  at: 1,
  ...extra,
});
const snap = (agents: WorkflowAgent[], taskId = 't1'): BackendEventOf<'workflow-snapshot'> => ({
  type: 'workflow-snapshot',
  taskId,
  phases: [
    { index: 1, title: 'One' },
    { index: 2, title: 'Two' },
  ],
  agents,
  at: 2,
});
const agentStart = (id: string, label: string, callId = 'call_wf'): BackendEventOf<'agent-start'> => ({
  type: 'agent-start',
  ref: { kind: 'child', id },
  parent: { kind: 'main' },
  parentCallId: callId,
  label,
  role: 'workflow-agent',
  background: true,
  taskPrompt: '[Workflow harness — computed task]',
  depth: 1,
  at: 3,
});
const agentEnd = (id: string, status: 'completed' | 'failed' | 'stopped'): BackendEventOf<'agent-end'> => ({
  type: 'agent-end',
  ref: { kind: 'child', id },
  status,
});

function recorder(opts: { childDelay?: Record<string, Promise<string | undefined>> } = {}) {
  const written: WorkflowRecord[] = [];
  const warnings: unknown[] = [];
  const r = new WorkflowRecorder({
    now: () => 100,
    warn: (n, d) => warnings.push([n, d]),
    notify: () => {},
    write: (rec) => void written.push(rec),
    childSession: (id) => opts.childDelay?.[id] ?? Promise.resolve(`child-${id}`),
  });
  return { r, written, warnings };
}

describe('workflow recorder (D48)', () => {
  it('writes run start, members with their child sessions, member ends and run end, in order', async () => {
    const { r, written } = recorder();
    r.taskStarted('t1', 'Two phase probe');
    expect(r.views()[0]).toMatchObject({ status: 'starting', name: 'Two phase probe' });
    // A snapshot and an agent start that come before the run start wait for it.
    r.snapshot(snap([row(1, 'a1', 'running', { agentId: 'x1', phaseIndex: 1, phaseTitle: 'One' })]));
    r.agentStarted(agentStart('x1', 'a1'));
    await tick();
    expect(written).toEqual([]);
    r.start(wfStart());
    await r.flush();
    expect(written.map((w) => w.kind)).toEqual(['run-start', 'agent-start']);
    expect(written[0]).toEqual({ kind: 'run-start', runId: 'wf_1', name: 'two-phase' });
    expect(written[1]).toEqual({
      kind: 'agent-start',
      runId: 'wf_1',
      seq: 1,
      label: 'a1',
      phase: 'One',
      childId: 'child-x1',
    });
    r.snapshot(
      snap([
        row(1, 'a1', 'done', { agentId: 'x1', phaseIndex: 1, phaseTitle: 'One', tokens: 120 }),
        row(2, 'b1', 'running', { agentId: 'x2', phaseIndex: 2, phaseTitle: 'Two' }),
        row(3, 'b2', 'queued', { phaseIndex: 2 }),
      ]),
    );
    r.agentEnded(agentEnd('x1', 'completed')); // the end is written once
    r.agentStarted(agentStart('x2', 'b1'));
    r.agentEnded(agentEnd('x2', 'failed'));
    r.ended({ type: 'workflow-end', taskId: 't1', stopReason: 'completed', summary: 'done' });
    await r.flush();
    expect(written.slice(2)).toEqual([
      { kind: 'agent-end', runId: 'wf_1', seq: 1, outcome: 'completed' },
      { kind: 'agent-start', runId: 'wf_1', seq: 2, label: 'b1', phase: 'Two', childId: 'child-x2' },
      { kind: 'agent-end', runId: 'wf_1', seq: 2, outcome: 'failed' },
      { kind: 'run-end', runId: 'wf_1', stopReason: 'completed' },
    ]);
    const v = r.views()[0]!;
    expect(v).toMatchObject({ taskId: 't1', runId: 'wf_1', status: 'completed', summary: 'done', callId: 'call_wf' });
    expect(v.agents.map((a) => [a.label, a.state, a.childSessionId])).toEqual([
      ['a1', 'done', 'child-x1'],
      ['b1', 'running', 'child-x2'],
      ['b2', 'queued', undefined],
    ]);
    expect(v.agents[0]!.tokens).toBe(120);
  });

  it('a member end waits for its child session; a run end waits for both', async () => {
    let resolve!: (v: string) => void;
    const late = new Promise<string | undefined>((r) => (resolve = r));
    const { r, written } = recorder({ childDelay: { x1: late } });
    r.start(wfStart());
    r.snapshot(snap([row(1, 'a1', 'running', { agentId: 'x1' })]));
    r.agentStarted(agentStart('x1', 'a1'));
    r.agentEnded(agentEnd('x1', 'completed'));
    r.ended({ type: 'workflow-end', taskId: 't1', stopReason: 'completed' });
    await tick();
    expect(written.map((w) => w.kind)).toEqual(['run-start']);
    resolve('child-late');
    await r.flush();
    expect(written.map((w) => w.kind)).toEqual(['run-start', 'agent-start', 'agent-end', 'run-end']);
  });

  it('an agent with no child session gets no member record (never an end without a start)', async () => {
    const { r, written, warnings } = recorder({ childDelay: { x1: Promise.resolve(undefined) } });
    r.start(wfStart());
    r.snapshot(snap([row(1, 'a1', 'running', { agentId: 'x1' })]));
    r.agentStarted(agentStart('x1', 'a1'));
    r.agentEnded(agentEnd('x1', 'completed'));
    r.ended({ type: 'workflow-end', taskId: 't1', stopReason: 'completed' });
    await r.flush();
    expect(written.map((w) => w.kind)).toEqual(['run-start', 'run-end']);
    expect(JSON.stringify(warnings)).toMatch(/no child session/);
  });

  it('a stopped run ends its members cancelled, even when the agent reports an error row', async () => {
    const { r, written } = recorder();
    r.start(wfStart());
    r.snapshot(snap([row(1, 'a1', 'running', { agentId: 'x1' }), row(2, 'a2', 'running', { agentId: 'x2' })]));
    r.agentStarted(agentStart('x1', 'a1'));
    r.agentStarted(agentStart('x2', 'a2'));
    r.noteStop('t1');
    expect(r.views()[0]!.stopping).toBe(true);
    r.snapshot(
      snap([
        row(1, 'a1', 'error', { agentId: 'x1', error: 'Stopped because the workflow was stopped' }),
        row(2, 'a2', 'running', { agentId: 'x2' }),
      ]),
    );
    r.ended({ type: 'workflow-end', taskId: 't1', stopReason: 'cancelled' });
    await r.flush();
    expect(written.slice(1)).toEqual([
      { kind: 'agent-start', runId: 'wf_1', seq: 1, label: 'a1', childId: 'child-x1' },
      { kind: 'agent-start', runId: 'wf_1', seq: 2, label: 'a2', childId: 'child-x2' },
      { kind: 'agent-end', runId: 'wf_1', seq: 1, outcome: 'cancelled' },
      { kind: 'agent-end', runId: 'wf_1', seq: 2, outcome: 'cancelled' },
      { kind: 'run-end', runId: 'wf_1', stopReason: 'cancelled' },
    ]);
    expect(r.views()[0]!.stopping).toBeUndefined();
    expect(memberOutcomeOfState('error', false)).toBe('failed');
    expect(memberOutcomeOfState('done', true)).toBe('completed');
  });

  it('closeAll (crash, D74) ends every live run with error; ended runs stay as they are', async () => {
    const { r, written } = recorder();
    r.start(wfStart());
    r.start(wfStart('t2', { runId: 'wf_2', callId: 'call_2' }));
    r.snapshot(snap([row(1, 'a1', 'running', { agentId: 'x1' })]));
    r.agentStarted(agentStart('x1', 'a1'));
    r.ended({ type: 'workflow-end', taskId: 't2', stopReason: 'completed' });
    r.closeAll('error', 'K ended unexpectedly');
    await r.flush();
    expect(written.filter((w) => w.kind !== 'run-start')).toEqual([
      { kind: 'run-end', runId: 'wf_2', stopReason: 'completed' },
      { kind: 'agent-start', runId: 'wf_1', seq: 1, label: 'a1', childId: 'child-x1' },
      { kind: 'agent-end', runId: 'wf_1', seq: 1, outcome: 'failed' },
      { kind: 'run-end', runId: 'wf_1', stopReason: 'error' },
    ]);
    expect(r.views().map((v) => [v.taskId, v.status, v.summary])).toEqual([
      ['t1', 'error', 'K ended unexpectedly'],
      ['t2', 'completed', undefined],
    ]);
    // Late events of an ended run write nothing.
    r.snapshot(snap([row(1, 'a1', 'running', { agentId: 'x1' })]));
    r.ended({ type: 'workflow-end', taskId: 't1', stopReason: 'completed' });
    await r.flush();
    expect(written).toHaveLength(6);
  });

  it('a run that never reported its start still gets a record at its end (named by its job)', async () => {
    const { r, written } = recorder();
    r.taskStarted('t9', 'Quiet run');
    r.snapshot(snap([row(4, 'q', 'running', { agentId: 'q1' })], 't9'));
    r.agentStarted(agentStart('q1', 'q', 'call_unknown'));
    r.ended({ type: 'workflow-end', taskId: 't9', stopReason: 'error' });
    await r.flush();
    expect(written).toEqual([
      { kind: 'run-start', runId: 't9', name: 'Quiet run' },
      { kind: 'agent-start', runId: 't9', seq: 4, label: 'q', childId: 'child-q1' },
      { kind: 'agent-end', runId: 't9', seq: 4, outcome: 'failed' },
      { kind: 'run-end', runId: 't9', stopReason: 'error' },
    ]);
  });

  it('an agent that starts before any snapshot is matched by its launching call', async () => {
    const { r, written } = recorder();
    r.agentStarted(agentStart('x7', 'early'));
    r.start(wfStart());
    await r.flush();
    expect(written[1]).toMatchObject({ kind: 'agent-start', label: 'early', childId: 'child-x7' });
  });

  it('member seqs are unique per run (a retry with a new agent id on the same row)', async () => {
    const { r, written } = recorder();
    r.start(wfStart());
    r.snapshot(snap([row(1, 'a1', 'error', { agentId: 'x1' })]));
    r.agentStarted(agentStart('x1', 'a1'));
    r.snapshot(snap([row(1, 'a1', 'running', { agentId: 'x1b', attempt: 2 })]));
    r.agentStarted(agentStart('x1b', 'a1'));
    await r.flush();
    const seqs = written.filter((w) => w.kind === 'agent-start').map((w) => (w as { seq: number }).seq);
    expect(seqs).toEqual([1, 2]);
  });

  it('a refused run start writes nothing else of that run', async () => {
    const written: WorkflowRecord[] = [];
    const warnings: unknown[] = [];
    const r = new WorkflowRecorder({
      now: () => 1,
      warn: (n) => warnings.push(n),
      notify: () => {},
      write: (rec) => {
        if (rec.kind === 'run-start') throw new Error('refused');
        written.push(rec);
      },
      childSession: async (id) => `c-${id}`,
    });
    r.start(wfStart());
    r.snapshot(snap([row(1, 'a1', 'running', { agentId: 'x1' })]));
    r.agentStarted(agentStart('x1', 'a1'));
    r.ended({ type: 'workflow-end', taskId: 't1', stopReason: 'completed' });
    await r.flush();
    expect(written).toEqual([]);
    expect(warnings).toContain('could not record workflow run-start');
  });

  it('closeStale closes records a gone process left open; live runs are left alone', async () => {
    const { r, written } = recorder();
    r.start(wfStart());
    await r.flush();
    written.length = 0;
    r.closeStale([
      { runId: 'wf_old', openSeqs: [1, 3] },
      { runId: 'wf_1', openSeqs: [1] },
    ]);
    expect(written).toEqual([
      { kind: 'agent-end', runId: 'wf_old', seq: 1, outcome: 'failed' },
      { kind: 'agent-end', runId: 'wf_old', seq: 3, outcome: 'failed' },
      { kind: 'run-end', runId: 'wf_old', stopReason: 'error' },
    ]);
  });
});

describe('workflow records in the host log (port, dsh-seams R2.4)', () => {
  it('writes the exact DSH event types and fields', () => {
    const appended: Array<[string, unknown]> = [];
    const session = { append: (t: string, d: unknown) => (appended.push([t, d]), { seq: appended.length }) };
    appendWorkflowRecord(session, { kind: 'run-start', runId: 'wf_1', name: 'n' });
    appendWorkflowRecord(session, { kind: 'agent-start', runId: 'wf_1', seq: 1, label: 'a', childId: 's1' });
    appendWorkflowRecord(session, {
      kind: 'agent-start',
      runId: 'wf_1',
      seq: 2,
      label: 'b',
      phase: 'P',
      childId: 's2',
    });
    appendWorkflowRecord(session, { kind: 'agent-end', runId: 'wf_1', seq: 1, outcome: 'completed' });
    appendWorkflowRecord(session, { kind: 'run-end', runId: 'wf_1', stopReason: 'cancelled' });
    expect(appended).toEqual([
      ['tool-workflow/run-start', { runId: 'wf_1', name: 'n' }],
      ['tool-workflow/agent-start', { runId: 'wf_1', seq: 1, label: 'a', childId: 's1' }],
      ['tool-workflow/agent-start', { runId: 'wf_1', seq: 2, label: 'b', phase: 'P', childId: 's2' }],
      ['tool-workflow/agent-end', { runId: 'wf_1', seq: 1, outcome: 'completed' }],
      ['tool-workflow/run-end', { runId: 'wf_1', stopReason: 'cancelled' }],
    ]);
    expect(Object.values(WORKFLOW_EVENT_TYPES)).toHaveLength(4);
    expect(workflowEventData({ kind: 'run-end', runId: 'r', stopReason: 'error' })).toEqual({
      runId: 'r',
      stopReason: 'error',
    });
  });

  it('finds runs left open and their open members', () => {
    const ev = (type: string, data: Record<string, unknown>, seq: number) => ({ type, data, seq, time: 0 });
    const events = [
      ev(WORKFLOW_EVENT_TYPES['run-start'], { runId: 'a', name: 'a' }, 1),
      ev(WORKFLOW_EVENT_TYPES['agent-start'], { runId: 'a', seq: 1, label: 'x', childId: 'c' }, 2),
      ev(WORKFLOW_EVENT_TYPES['agent-start'], { runId: 'a', seq: 2, label: 'y', childId: 'd' }, 3),
      ev(WORKFLOW_EVENT_TYPES['agent-end'], { runId: 'a', seq: 1, outcome: 'completed' }, 4),
      ev(WORKFLOW_EVENT_TYPES['run-start'], { runId: 'b', name: 'b' }, 5),
      ev(WORKFLOW_EVENT_TYPES['run-end'], { runId: 'b', stopReason: 'completed' }, 6),
      ev('turn/end', { reason: { kind: 'completed' } }, 7),
    ];
    expect(openWorkflowRuns({ snapshotEvents: () => events })).toEqual([{ runId: 'a', openSeqs: [2] }]);
  });
});

// ---- driver wiring ----

function setup(opts: { agentStop?: boolean; open?: Array<{ runId: string; openSeqs: number[] }> } = {}) {
  const q = new AsyncQueue<BackendEvent>();
  const stops: string[] = [];
  const records: WorkflowRecord[] = [];
  const jobs: Array<{ taskId: string; kind: string; stop: () => void; ended?: string }> = [];
  const children: string[] = [];
  let outputs: Record<string, TaskOutput> = {};
  let failStop = false;
  const factory = {
    kind: 'k',
    displayName: 'K',
    staticCapabilities: {
      ids: 'derived',
      resume: true,
      fork: 'none',
      permissionModes: [{ id: 'default', label: 'Ask' }],
      steer: 'native',
    },
    async open() {
      return {
        kind: 'k',
        sessionId: 'x',
        startedAs: 'new',
        capabilities: { workflows: true, workflowAgentStop: opts.agentStop === true },
        events: () => q,
        send: async () => {},
        interrupt: async () => ({ cancelledInputIds: [] }),
        forceStop: async () => {
          q.push({ type: 'exit' });
          q.end();
        },
        dispose: async () => {
          q.push({ type: 'exit' });
          q.end();
        },
        controls: {
          stopTask: async (id: string) => {
            if (failStop) throw new Error('no such task');
            stops.push(id);
          },
          taskOutput: async (id: string) => {
            const o = outputs[id];
            if (!o) throw new Error('no shell or Monitor task with that task_id');
            return o;
          },
        },
      };
    },
  } as unknown as AgentBackendFactory;
  const port: HostSessionPort = {
    hostSessionId: 'h1',
    cwd: '/w',
    wake: () => {},
    latestBinding: () => undefined,
    startJob: (task, stop) => {
      const j: (typeof jobs)[number] = { taskId: task.taskId, kind: task.kind, stop };
      jobs.push(j);
      return { progress: () => {}, end: (s) => void (j.ended = s) };
    },
    createChild: async (spec) => {
      children.push(spec.ref);
      return {
        hostSessionId: `child-${spec.ref}`,
        begin: () => {},
        createChild: () => Promise.reject(new Error('no nesting here')),
        dispose: async () => {},
      } satisfies ChildHandle;
    },
    recordWorkflow: (r) => void records.push(r),
    openWorkflowRuns: () => opts.open ?? [],
    warn: () => {},
  };
  const rt = new SessionRuntime(factory, port, { env: {} });
  return {
    rt,
    q,
    stops,
    records,
    jobs,
    children,
    setOutputs: (o: Record<string, TaskOutput>) => (outputs = o),
    failStop: () => (failStop = true),
  };
}

const runEvents = (): BackendEvent[] => [
  { type: 'task-start', taskId: 't1', kind: 'workflow', label: 'Two phase probe' },
  wfStart(),
  snap([row(1, 'a1', 'running', { agentId: 'x1', phaseIndex: 1, phaseTitle: 'One' })]),
  agentStart('x1', 'a1'),
  { type: 'task-progress', taskId: 'x1', usage: { tokens: 50, toolUses: 2 } },
];

describe('driver: workflows hold no turn and become jobs (D47, D48)', () => {
  it('writes the run and its member into the parent, makes the child session and a job', async () => {
    const t = setup();
    await t.rt.start();
    for (const e of runEvents()) t.q.push(e);
    await until(() => t.records.length === 2);
    expect(t.records.map((r) => r.kind)).toEqual(['run-start', 'agent-start']);
    expect(t.records[1]).toMatchObject({ childId: 'child-x1', seq: 1, phase: 'One' });
    expect(t.children).toEqual(['x1']);
    expect(t.jobs.map((j) => [j.taskId, j.kind])).toEqual([['t1', 'workflow']]);
    const v = t.rt.view();
    expect(v.state.turn).toBe(false); // the session stays free (rule 7)
    expect(v.workflows).toHaveLength(1);
    expect(v.workflows![0]).toMatchObject({ taskId: 't1', runId: 'wf_1', status: 'running' });
    expect(v.workflows![0]!.agents[0]).toMatchObject({ label: 'a1', childSessionId: 'child-x1' });
    expect(v.workflowAgentStop).toBe(false);
    expect(v.children![0]).toMatchObject({ id: 'x1', role: 'workflow-agent', tokens: 50, toolUses: 2 });
    expect(JSON.parse(channelLine(v)).workflows).toHaveLength(1);

    t.q.push(snap([row(1, 'a1', 'done', { agentId: 'x1', phaseIndex: 1, phaseTitle: 'One' })]));
    t.q.push(agentEnd('x1', 'completed'));
    t.q.push({ type: 'workflow-end', taskId: 't1', stopReason: 'completed' });
    t.q.push({ type: 'task-end', taskId: 't1', status: 'completed' });
    await until(() => t.records.length === 4);
    expect(t.records.slice(2).map((r) => r.kind)).toEqual(['agent-end', 'run-end']);
    expect(t.jobs[0]!.ended).toBe('completed');
    expect(t.rt.view().workflows![0]!.status).toBe('completed');
    await t.rt.dispose();
  });

  it('Stop entire workflow: stopTask on the run, waits for its end (D48)', async () => {
    const t = setup();
    await t.rt.start();
    for (const e of runEvents()) t.q.push(e);
    await until(() => t.records.length === 2);
    const p = t.rt.stopWorkflow('t1', 1000);
    await until(() => t.stops.length === 1);
    expect(t.stops).toEqual(['t1']);
    expect(t.rt.view().workflows![0]!.stopping).toBe(true);
    t.q.push(agentEnd('x1', 'stopped'));
    t.q.push({ type: 'workflow-end', taskId: 't1', stopReason: 'cancelled' });
    expect(await p).toEqual({ ok: true, status: 'cancelled' });
    await until(() => t.records.length === 4);
    expect(t.records[2]).toMatchObject({ kind: 'agent-end', outcome: 'cancelled' });
    expect(await t.rt.stopWorkflow('t1')).toEqual({ ok: true, status: 'cancelled' });
    expect(await t.rt.stopWorkflow('nope')).toMatchObject({ ok: false, status: 'unknown' });
    await t.rt.dispose();
  });

  it('a stop that does not end the run in time reports "stopping"; a failed stop clears it', async () => {
    const t = setup();
    await t.rt.start();
    for (const e of runEvents()) t.q.push(e);
    await until(() => t.records.length === 2);
    expect(await t.rt.stopWorkflow('t1', 30)).toEqual({ ok: true, status: 'stopping' });
    const t2 = setup();
    await t2.rt.start();
    for (const e of runEvents()) t2.q.push(e);
    await until(() => t2.rt.view().workflows !== undefined);
    t2.failStop();
    expect(await t2.rt.stopWorkflow('t1', 30)).toMatchObject({ ok: false, error: 'no such task' });
    expect(t2.rt.view().workflows![0]!.stopping).toBeUndefined();
    await t.rt.dispose();
    await t2.rt.dispose();
  });

  it('the job kill stops the whole run', async () => {
    const t = setup();
    await t.rt.start();
    for (const e of runEvents()) t.q.push(e);
    await until(() => t.jobs.length === 1);
    t.jobs[0]!.stop();
    await until(() => t.stops.length === 1);
    expect(t.stops).toEqual(['t1']);
    expect(t.rt.view().workflows![0]!.stopping).toBe(true);
    await t.rt.dispose();
  });

  it('one agent cannot be stopped when the backend has no such control; nothing is sent', async () => {
    const t = setup();
    await t.rt.start();
    for (const e of runEvents()) t.q.push(e);
    await until(() => t.records.length === 2);
    const r = await t.rt.stopWorkflowAgent('t1', 'x1');
    expect(r).toMatchObject({ ok: false, unsupported: true });
    expect(r.error).toBe('K cannot stop one agent of a workflow. Stop the whole workflow instead.');
    const c = await t.rt.stopChild('x1'); // the agents panel's per-child Stop
    expect(c).toMatchObject({ ok: false, status: 'running' });
    expect(t.stops).toEqual([]);
    expect(await t.rt.stopWorkflowAgent('t1', 'zz')).toMatchObject({ ok: false, status: 'unknown' });
    await t.rt.dispose();
  });

  it('with a per-agent stop the agent alone is stopped', async () => {
    const t = setup({ agentStop: true });
    await t.rt.start();
    for (const e of runEvents()) t.q.push(e);
    await until(() => t.records.length === 2);
    const p = t.rt.stopWorkflowAgent('t1', 'x1');
    await until(() => t.stops.length === 1);
    t.q.push(agentEnd('x1', 'stopped'));
    expect(await p).toMatchObject({ ok: true, status: 'stopped' });
    expect(t.stops).toEqual(['x1']);
    await t.rt.dispose();
  });

  it('a crash ends the run and its members (D74); a dispose cancels live runs', async () => {
    const t = setup();
    await t.rt.start();
    for (const e of runEvents()) t.q.push(e);
    await until(() => t.records.length === 2);
    t.q.push({ type: 'exit', error: 'killed' });
    await until(() => t.records.length === 4);
    expect(t.records.slice(2)).toEqual([
      { kind: 'agent-end', runId: 'wf_1', seq: 1, outcome: 'failed' },
      { kind: 'run-end', runId: 'wf_1', stopReason: 'error' },
    ]);
    expect(t.rt.view().workflows![0]!.status).toBe('error');

    const d = setup();
    await d.rt.start();
    for (const e of runEvents()) d.q.push(e);
    await until(() => d.records.length === 2);
    await d.rt.dispose();
    expect(
      d.records.slice(2).map((r) => [r.kind, 'outcome' in r ? r.outcome : (r as { stopReason?: string }).stopReason]),
    ).toEqual([
      ['agent-end', 'cancelled'],
      ['run-end', 'cancelled'],
    ]);
    await t.rt.dispose();
  });

  it('closes records a gone process left open in the log, once, at the first spawn', async () => {
    const t = setup({ open: [{ runId: 'wf_old', openSeqs: [2] }] });
    await t.rt.start();
    expect(t.records).toEqual([
      { kind: 'agent-end', runId: 'wf_old', seq: 2, outcome: 'failed' },
      { kind: 'run-end', runId: 'wf_old', stopReason: 'error' },
    ]);
    await t.rt.dispose();
  });

  it('records made while detached are written at the next attach (D87)', async () => {
    const t = setup();
    await t.rt.start();
    t.rt.detach();
    for (const e of runEvents().slice(0, 2)) t.q.push(e);
    await until(() => t.rt.view().workflows?.[0]?.status === 'running');
    await tick();
    expect(t.records).toEqual([]);
    const later: WorkflowRecord[] = [];
    t.rt.attach({
      hostSessionId: 'h1',
      cwd: '/w',
      wake: () => {},
      latestBinding: () => undefined,
      startJob: () => undefined,
      recordWorkflow: (r) => void later.push(r),
      warn: () => {},
    });
    expect(later).toEqual([{ kind: 'run-start', runId: 'wf_1', name: 'two-phase' }]);
    await t.rt.dispose();
  });
});

describe('task output route (R6.2): own shells and monitors only', () => {
  it('reads a shell of this session, refuses others and caps the size', async () => {
    const t = setup();
    await t.rt.start();
    t.q.push({ type: 'task-start', taskId: 'b1', kind: 'shell', label: 'tick' });
    t.q.push({ type: 'task-start', taskId: 't1', kind: 'workflow', label: 'wf' });
    await until(() => (t.rt.view().tasks ?? []).length === 2);
    t.setOutputs({
      b1: { output: 'tick1\ntick2\n', totalBytes: 12, truncated: false },
      big: { output: 'x'.repeat(TASK_OUTPUT_MAX_CHARS + 10), totalBytes: TASK_OUTPUT_MAX_CHARS + 10, truncated: false },
    });
    expect(await t.rt.taskOutput('b1')).toEqual({
      ok: true,
      output: 'tick1\ntick2\n',
      totalBytes: 12,
      truncated: false,
    });
    expect(await t.rt.taskOutput('t1')).toMatchObject({ ok: false, code: 'unsupported' });
    expect(await t.rt.taskOutput('other-session-task')).toMatchObject({ ok: false, code: 'unknown' });
    // An ended shell's output stays readable.
    t.q.push({ type: 'task-end', taskId: 'b1', status: 'completed' });
    t.q.push({ type: 'task-start', taskId: 'big', kind: 'monitor', label: 'm' });
    await until(() => (t.rt.view().tasks ?? []).some((x) => x.taskId === 'big'));
    expect(await t.rt.taskOutput('b1')).toMatchObject({ ok: true });
    // Live M4: the ended shell's row stays in the view, so its "Show output" stays reachable.
    expect(t.rt.view().tasks?.find((x) => x.taskId === 'b1')).toMatchObject({ status: 'completed', job: false });
    t.q.push({ type: 'task-end', taskId: 't1', status: 'completed' });
    await until(() => !(t.rt.view().tasks ?? []).some((x) => x.taskId === 't1'));
    const big = await t.rt.taskOutput('big');
    expect(big.ok && big.output.length).toBe(TASK_OUTPUT_MAX_CHARS);
    expect(big.ok && big.truncated).toBe(true);
    await t.rt.dispose();
  });

  it('the routes: status codes and session scoping', async () => {
    const t = setup();
    await t.rt.start();
    for (const e of runEvents()) t.q.push(e);
    t.q.push({ type: 'task-start', taskId: 'b1', kind: 'shell', label: 'tick' });
    await until(() => t.records.length === 2 && (t.rt.view().tasks ?? []).length === 2);
    t.setOutputs({ b1: { output: 'out', totalBytes: 3, truncated: false } });
    const registry = new SessionRegistry();
    registry.set('h1', 'k', t.rt as unknown as RegisteredRuntime);
    const routes = lifecycleRoutes(registry);
    const route = (p: string) => routes.find((r) => r.path === p)!;
    const call = async (p: string, q: string, method = 'POST') => {
      const res = await route(p).fetch(new Request(`http://x${p}?${q}`, { method }));
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    expect(await call(TASK_OUTPUT_ROUTE, 'session=h1&task=b1', 'GET')).toMatchObject({
      status: 200,
      body: { output: 'out' },
    });
    expect((await call(TASK_OUTPUT_ROUTE, 'session=h1&task=zz', 'GET')).status).toBe(404);
    expect((await call(TASK_OUTPUT_ROUTE, 'session=h1&task=t1', 'GET')).status).toBe(409);
    expect((await call(TASK_OUTPUT_ROUTE, 'session=other&task=b1', 'GET')).status).toBe(404);
    expect((await call(TASK_OUTPUT_ROUTE, 'session=h1', 'GET')).status).toBe(400);
    expect((await call(WORKFLOW_AGENT_STOP_ROUTE, 'session=h1&task=t1&agent=x1')).status).toBe(409);
    expect((await call(WORKFLOW_AGENT_STOP_ROUTE, 'session=h1&task=t1')).status).toBe(400);
    expect((await call(WORKFLOW_STOP_ROUTE, 'session=h1&task=nope')).status).toBe(404);
    const stop = call(WORKFLOW_STOP_ROUTE, 'session=h1&task=t1');
    await until(() => t.stops.length === 1);
    t.q.push({ type: 'workflow-end', taskId: 't1', stopReason: 'cancelled' });
    expect(await stop).toMatchObject({ status: 200, body: { ok: true, status: 'cancelled' } });
    await t.rt.dispose();
  });
});
