// M4 dynamic workflows (R6.5; D47, D48, D49): replays of live wire recordings from CLI 2.1.318
// (fixtures/workflow-*.jsonl with their transcript folders), the transcript tail, the live poll,
// and the session controls (per-run stop, no per-agent stop, ultracode, task output).
import { mkdtempSync, appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AsyncQueue,
  SentInputTracker,
  type AgentRef,
  type BackendEvent,
  type InteractionHandler,
} from '@dsh-raw-agent/core';
import {
  ClaudeMessageMapper,
  FRAME_COMPUTED_TASK,
  FRAME_USER_REQUEST,
  TranscriptTail,
  WorkflowRuns,
  createClaudeFactory,
  effortFlags,
  insideFolder,
  nodeTailFs,
  parseWorkflowProgress,
  workflowAgentState,
  type QueryFn,
  type TailFs,
  type WorkflowTimers,
} from '@dsh-raw-agent/backend-claude';

type Ev<T extends BackendEvent['type']> = Extract<BackendEvent, { type: T }>;
const of = <T extends BackendEvent['type']>(events: BackendEvent[], t: T): Ev<T>[] =>
  events.filter((e): e is Ev<T> => e.type === t);
const key = (r: AgentRef): string => (r.kind === 'main' ? 'main' : r.id);

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
/** The recorded transcript folder's scrubbed prefix (make-fixture.mjs). */
const RECORDED_PROJECTS = '/home/user/.claude/projects';

function loadFixture(name: string): Record<string, unknown>[] {
  return readFileSync(join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Maps the recorded transcript folder to the fixture folder `<name>.transcripts`. */
function fixtureFs(name: string): TailFs {
  const local = join(FIXTURES, `${name}.transcripts`);
  // The code joins with the OS separator (backslashes on Windows); the recorded paths use '/'.
  const posix = (p: string): string => p.replace(/\\/g, '/');
  const map = (raw: string): string => {
    const p = posix(raw);
    const i = p.indexOf('/subagents/workflows/');
    if (!p.startsWith(RECORDED_PROJECTS) || i < 0) return raw;
    const rest = p
      .slice(i + '/subagents/workflows/'.length)
      .split('/')
      .slice(1)
      .join('/');
    return rest === '' ? local : join(local, rest);
  };
  return {
    realpath: (p) => (posix(p).startsWith(RECORDED_PROJECTS) ? p : nodeTailFs.realpath(p)),
    fileSize: (p) => nodeTailFs.fileSize(map(p)),
    readAt: (p, o, n) => nodeTailFs.readAt(map(p), o, n),
  };
}

function replay(
  name: string,
  before?: (m: Record<string, unknown>, mapper: ClaudeMessageMapper) => void,
): { events: BackendEvent[]; mapper: ClaudeMessageMapper } {
  const tracker = new SentInputTracker();
  let at = 1000;
  const mapper = new ClaudeMessageMapper(tracker, {
    now: () => at,
    workflows: { projectsDir: () => RECORDED_PROJECTS, fs: fixtureFs(name.replace(/\.jsonl$/, '')) },
  });
  const events: BackendEvent[] = [];
  for (const m of loadFixture(name)) {
    if (m.type === 'command_lifecycle' && m.state === 'queued') tracker.sent(m.command_uuid as string);
    at = typeof m._t === 'number' ? 1000 + m._t : at + 10;
    before?.(m, mapper);
    events.push(...mapper.map(m, at));
  }
  return { events, mapper };
}

/** Child guarantees (§7.2, D68) for the workflow agents, and the run order (D48). */
function checkWorkflowGuarantees(events: BackendEvent[]): void {
  const running = new Set<string>();
  const steps = new Map<string, string>();
  const advertised = new Set<string>();
  const runs = new Map<string, 'task' | 'started' | 'ended' | 'done'>();
  for (const e of events) {
    if (e.type === 'task-start' && e.kind === 'workflow') runs.set(e.taskId, 'task');
    if (e.type === 'workflow-start') {
      expect(runs.get(e.taskId)).toBe('task');
      runs.set(e.taskId, 'started');
    }
    if (e.type === 'workflow-snapshot') expect(runs.get(e.taskId)).toBe('started');
    if (e.type === 'workflow-end') {
      expect(runs.get(e.taskId)).toBe('started');
      runs.set(e.taskId, 'ended');
    }
    if (e.type === 'task-end' && runs.has(e.taskId)) {
      expect(runs.get(e.taskId)).toBe('ended');
      runs.set(e.taskId, 'done');
    }
    if (e.type === 'agent-start') {
      expect(running.has(key(e.ref))).toBe(false);
      running.add(key(e.ref));
    }
    if (e.type === 'agent-end') {
      expect(running.has(key(e.ref))).toBe(true);
      running.delete(key(e.ref));
    }
    if (e.type === 'agent-input') expect(running.has(key(e.ref))).toBe(true);
    if (
      (e.type === 'step-start' || e.type === 'step-message' || e.type === 'tool-result') &&
      e.agent.kind === 'child'
    ) {
      expect(running.has(e.agent.id)).toBe(true);
      if (e.type === 'step-start') steps.set(e.agent.id, e.stepId);
      if (e.type === 'step-message') {
        expect(steps.get(e.agent.id)).toBe(e.stepId);
        expect(e.usage).toBeUndefined();
        for (const b of e.blocks) if (b.type === 'tool-call') advertised.add(b.id);
      }
      if (e.type === 'tool-result') expect(advertised.has(e.callId)).toBe(true);
    }
  }
  expect(running.size).toBe(0);
}

describe('two-phase workflow (fixture workflow-two-phase.jsonl)', () => {
  const { events, mapper } = replay('workflow-two-phase.jsonl');
  const workflowCall = of(events, 'step-message')
    .filter((e) => e.agent.kind === 'main')
    .flatMap((e) => e.blocks)
    .find((b) => b.type === 'tool-call' && b.name === 'Workflow');

  it('makes the run a job even though task_started has no is_backgrounded (D47)', () => {
    checkWorkflowGuarantees(events);
    const job = of(events, 'task-start').find((e) => e.kind === 'workflow');
    expect(job).toMatchObject({ taskId: 'task_01', label: 'Two phase probe' });
  });

  it('starts the run after the launching tool-result, with run id, call and folders', () => {
    const start = of(events, 'workflow-start');
    expect(start).toHaveLength(1);
    expect(start[0]).toMatchObject({
      taskId: 'task_01',
      name: 'two-phase',
      label: 'Two phase probe',
      runId: 'wf_0001',
    });
    expect(start[0]!.callId).toBe(workflowCall?.type === 'tool-call' ? workflowCall.id : 'none');
    expect(start[0]!.transcriptDir).toMatch(/\/subagents\/workflows\/wf_0001$/);
    expect(start[0]!.scriptPath).toMatch(/two-phase-wf_0001\.js$/);
    const result = events.findIndex((e) => e.type === 'tool-result' && e.callId === start[0]!.callId);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThan(events.indexOf(start[0]!));
  });

  it('sends merged snapshots with two phases and three agents, the last one all done', () => {
    const snaps = of(events, 'workflow-snapshot');
    expect(snaps.length).toBeGreaterThan(2);
    const last = snaps.at(-1)!;
    expect(last.phases).toEqual([
      { index: 1, title: 'One' },
      { index: 2, title: 'Two' },
    ]);
    expect(last.agents.map((a) => [a.label, a.phaseIndex, a.state])).toEqual([
      ['a1', 1, 'done'],
      ['b1', 2, 'done'],
      ['b2', 2, 'done'],
    ]);
    expect(last.agents.find((a) => a.label === 'b1')?.resultPreview).toBe('beta');
    // Each snapshot differs from the one before (no repeats).
    for (let i = 1; i < snaps.length; i++) expect(JSON.stringify(snaps[i])).not.toBe(JSON.stringify(snaps[i - 1]));
    expect(mapper.workflows.snapshot('task_01')?.agents).toHaveLength(3);
  });

  it('gives each workflow agent a child with the CLI framing as its task prompt (D49)', () => {
    const starts = of(events, 'agent-start');
    expect(starts.map((s) => s.label)).toEqual(['a1', 'b1', 'b2']);
    for (const s of starts) {
      expect(s).toMatchObject({ role: 'workflow-agent', background: true, parent: { kind: 'main' }, depth: 1 });
      expect(s.parentCallId).toBe(workflowCall?.type === 'tool-call' ? workflowCall.id : 'none');
      expect(s.taskId).toBeUndefined(); // the run's task is not the agent's (D48)
      expect(s.taskPrompt.startsWith(FRAME_USER_REQUEST)).toBe(true);
      expect(s.taskPrompt).toContain(FRAME_COMPUTED_TASK);
    }
    expect(starts[2]!.taskPrompt).toContain('sleep 25; echo slow');
    // The framing is not repeated as an input.
    expect(of(events, 'agent-input').some((e) => e.text.startsWith('[Workflow harness'))).toBe(false);
  });

  it('writes the agents’ transcript steps in the child shape, never on the main thread', () => {
    const b2 = of(events, 'agent-start')[2]!.ref;
    const msgs = of(events, 'step-message').filter((e) => key(e.agent) === key(b2));
    const calls = msgs.flatMap((m) => m.blocks).filter((b) => b.type === 'tool-call');
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const results = of(events, 'tool-result').filter((e) => key(e.agent) === key(b2));
    expect(results.some((r) => r.content.some((c) => c.type === 'text' && c.text.includes('slow')))).toBe(true);
    expect(msgs.at(-1)!.blocks).toEqual([{ type: 'text', text: 'slow' }]);
    // Main steps carry only main blocks.
    const mainNames = of(events, 'step-message')
      .filter((e) => e.agent.kind === 'main')
      .flatMap((e) => e.blocks)
      .filter((b) => b.type === 'tool-call')
      .map((b) => (b.type === 'tool-call' ? b.name : ''));
    expect(mainNames).toEqual(['Workflow', 'Bash']); // the probe's own foreground Bash
    const childCalls = new Set(calls.map((b) => (b.type === 'tool-call' ? b.id : '')));
    const mainCalls = of(events, 'step-message')
      .filter((e) => e.agent.kind === 'main')
      .flatMap((e) => e.blocks)
      .filter((b) => b.type === 'tool-call' && childCalls.has(b.id));
    expect(mainCalls).toEqual([]);
  });

  it('reports per-agent tokens on the agent id and ends each agent before the run', () => {
    const ids = of(events, 'agent-start').map((s) => key(s.ref));
    const usage = of(events, 'task-progress').filter((e) => ids.includes(e.taskId));
    expect(usage.some((u) => (u.usage?.tokens ?? 0) > 0)).toBe(true);
    const ends = of(events, 'agent-end');
    expect(ends.map((e) => [key(e.ref), e.status])).toEqual(ids.map((id) => [id, 'completed']));
    expect(ends.map((e) => e.summary)).toEqual(['one', 'beta', 'slow']);
    const end = of(events, 'workflow-end');
    expect(end).toEqual([
      expect.objectContaining({
        taskId: 'task_01',
        stopReason: 'completed',
        summary: 'Dynamic workflow "Two phase probe" completed',
      }),
    ]);
    expect(end[0]!.usage?.tokens).toBeGreaterThan(0);
    const taskEnd = of(events, 'task-end').find((e) => e.taskId === 'task_01');
    expect(taskEnd?.status).toBe('completed');
  });

  it('the job progress line names the current phase and agent', () => {
    const lines = of(events, 'task-progress')
      .filter((e) => e.taskId === 'task_01')
      .map((e) => e.summary);
    expect(lines).toContain('Two: b2');
  });
});

describe('stop the whole run (fixture workflow-stop-run.jsonl)', () => {
  // The probe called stopTask(run) at t=128049; the session notes it as `stopTask` does.
  const { events } = replay('workflow-stop-run.jsonl', (m, mapper) => {
    if (typeof m._t === 'number' && m._t >= 128049) mapper.workflows.noteStopRequested('task_01');
  });
  it('ends the agent as stopped, settles the snapshot and cancels the run', () => {
    checkWorkflowGuarantees(events);
    const last = of(events, 'workflow-snapshot').at(-1)!;
    // The CLI reports the agent `error` with its own stop text; it was stopped (live M4: our card
    // said "Failed" while DSH's node said "Cancelled").
    expect(last.agents[0]).toMatchObject({
      label: 's1',
      state: 'stopped',
      rawState: 'error',
      error: 'Stopped because the workflow was stopped',
    });
    expect(of(events, 'agent-end')).toEqual([expect.objectContaining({ status: 'stopped' })]);
    expect(of(events, 'workflow-end')[0]).toMatchObject({ stopReason: 'cancelled' });
    expect(of(events, 'task-end').find((e) => e.taskId === 'task_01')?.status).toBe('stopped');
  });
  it('the agent’s child holds its Bash call', () => {
    const calls = of(events, 'step-message')
      .filter((e) => e.agent.kind === 'child')
      .flatMap((e) => e.blocks)
      .filter((b) => b.type === 'tool-call');
    expect(calls.map((b) => (b.type === 'tool-call' ? b.name : ''))).toContain('Bash');
  });
});

describe('interrupt while a workflow runs (fixture workflow-interrupt.jsonl)', () => {
  const { events } = replay('workflow-interrupt.jsonl');
  it('the interrupted main turn ends; the run goes on and completes (perTaskStopAffordance)', () => {
    checkWorkflowGuarantees(events);
    const interrupted = events.findIndex((e) => e.type === 'turn-end' && e.outcome === 'error');
    const aborted = events.findIndex((e) => e.type === 'turn-end' && e.reason === 'aborted_tools');
    expect(aborted).toBeGreaterThan(0);
    const end = events.findIndex((e) => e.type === 'workflow-end');
    expect(end).toBeGreaterThan(aborted);
    expect(of(events, 'workflow-end')[0]!.stopReason).toBe('completed');
    expect(interrupted === -1 || interrupted === aborted).toBe(true);
    // The agent still running at the interrupt (x1) ends later, with its own result.
    const x1 = of(events, 'agent-start').find((s) => s.label === 'x1')!;
    const x1End = events.findIndex((e) => e.type === 'agent-end' && key(e.ref) === key(x1.ref));
    expect(x1End).toBeGreaterThan(aborted);
    expect(of(events, 'agent-end').map((e) => e.status)).toEqual(['completed', 'completed']);
  });
});

describe('workflow_progress parsing', () => {
  it('maps states and keeps only phases and agents', () => {
    const snap = parseWorkflowProgress([
      { type: 'workflow_phase', index: 1, title: 'P' },
      { type: 'workflow_log', message: 'x' },
      { type: 'workflow_agent', index: 1, label: 'q', state: 'start', queuedAt: 1 },
      { type: 'workflow_agent', index: 2, label: 'r', state: 'start', agentId: 'a1', startedAt: 2 },
      { type: 'workflow_agent', index: 3, label: 's', state: 'weird', attempt: 2 },
      {
        type: 'workflow_agent',
        index: 4,
        label: 't',
        state: 'error',
        error: 'Stopped because the workflow was stopped',
      },
      { type: 'workflow_agent', index: 5, label: 'u', state: 'error', error: 'boom' },
      { type: 'workflow_agent', label: 'no index' },
    ])!;
    expect(snap.phases).toEqual([{ index: 1, title: 'P' }]);
    expect(snap.agents.map((a) => [a.label, a.state, a.rawState])).toEqual([
      ['q', 'queued', 'start'],
      ['r', 'running', 'start'],
      ['s', 'running', 'weird'],
      ['t', 'stopped', 'error'],
      ['u', 'error', undefined],
    ]);
    expect(parseWorkflowProgress(undefined)).toBeUndefined();
    expect(workflowAgentState('done', true)).toBe('done');
    expect(workflowAgentState('error', true)).toBe('error');
  });
});

describe('transcript tail (D49)', () => {
  it('reads complete lines by offset, keeps a partial line, and skips over-long lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'raw-tail-'));
    const file = join(dir, 'agent-a1.jsonl');
    writeFileSync(file, '{"type":"user","n":1}\n{"type":"assi');
    const tail = new TranscriptTail(dir);
    expect(tail.read('a1')).toEqual([{ type: 'user', n: 1 }]);
    expect(tail.read('a1')).toEqual([]);
    appendFileSync(file, 'stant","n":2}\nnot json\n');
    expect(tail.read('a1')).toEqual([{ type: 'assistant', n: 2 }]);
    expect(tail.read('../x')).toEqual([]); // never a path outside the folder
    expect(tail.agentFile('../x')).toBeUndefined();
  });

  it('reads at most one chunk per read; drain catches up', () => {
    const big = 'x'.repeat(300 * 1024);
    const content = [1, 2, 3].map((n) => JSON.stringify({ type: 'user', n, pad: big })).join('\n') + '\n';
    const fs: TailFs = {
      realpath: (p) => p,
      fileSize: () => Buffer.byteLength(content),
      readAt: (_p, o, n) => Buffer.from(content).subarray(o, o + n),
    };
    const sizes: number[] = [];
    const counted: TailFs = { ...fs, readAt: (p, o, n) => (sizes.push(n), fs.readAt(p, o, n)) };
    const tail = new TranscriptTail('/d', counted);
    expect(tail.read('a').length).toBe(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(512 * 1024);
    expect(tail.drain('a').map((l) => (l as { n: number }).n)).toEqual([2, 3]);
  });

  it('only folders under the projects folder are read', () => {
    const root = mkdtempSync(join(tmpdir(), 'raw-proj-'));
    const inside = join(root, 'projects', 's', 'subagents', 'workflows', 'wf_1');
    mkdirSync(inside, { recursive: true });
    expect(insideFolder(inside, join(root, 'projects'), nodeTailFs)).toBe(true);
    expect(insideFolder(root, join(root, 'projects'), nodeTailFs)).toBe(false);
    expect(insideFolder(join(root, 'projects'), join(root, 'projects'), nodeTailFs)).toBe(false);
    expect(insideFolder('/nope/x', join(root, 'projects'), nodeTailFs)).toBe(false);
  });
});

/** A run driven by hand: a growing transcript file, fake timers, a fake clock. */
function liveRun({ makeDir = true }: { makeDir?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'raw-live-'));
  const projects = join(root, 'projects');
  const dir = join(projects, 'slug', 'sid', 'subagents', 'workflows', 'wf_x');
  mkdirSync(makeDir ? dir : projects, { recursive: true });
  let clock = 0;
  const ticks: Array<() => void> = [];
  const timers: WorkflowTimers = {
    set: (fn) => (ticks.push(fn), ticks.length),
    clear: () => void ticks.splice(0),
  };
  const emitted: BackendEvent[] = [];
  const runs = new WorkflowRuns({
    emit: (e) => emitted.push(...e),
    projectsDir: () => projects,
    now: () => clock,
    timers,
  });
  const out: BackendEvent[] = [];
  runs.taskStarted({
    task_id: 'wf1',
    task_type: 'local_workflow',
    workflow_name: 'w',
    description: 'W',
    tool_use_id: 'call1',
  });
  runs.launched({ status: 'async_launched', taskId: 'wf1', runId: 'wf_x', transcriptDir: dir }, 'call1', 0, out);
  const frame = (state: string, extra: Record<string, unknown> = {}) => ({
    task_id: 'wf1',
    workflow_progress: [
      { type: 'workflow_phase', index: 1, title: 'P' },
      {
        type: 'workflow_agent',
        index: 1,
        label: 'w1',
        agentId: 'ag1',
        state,
        startedAt: 1,
        promptPreview: 'Do it',
        ...extra,
      },
    ],
  });
  const line = (o: unknown) => appendFileSync(join(dir, 'agent-ag1.jsonl'), JSON.stringify(o) + '\n');
  return {
    runs,
    out,
    emitted,
    ticks,
    frame,
    line,
    mkdir: () => mkdirSync(dir, { recursive: true }),
    advance: (ms: number) => (clock += ms),
    tick: () => ticks.forEach((t) => t()),
  };
}

describe('live poll (D49)', () => {
  it('announces at the computed-task frame and streams new lines on each poll', () => {
    const r = liveRun();
    expect(r.out.map((e) => e.type)).toEqual(['workflow-start']);
    expect(r.ticks).toHaveLength(1); // the poll runs while the run is live
    r.runs.progress(r.frame('start'), 0, r.out);
    expect(of(r.out, 'agent-start')).toHaveLength(0); // no framing yet, not yet timed out
    r.line({ type: 'user', uuid: 'u1', message: { role: 'user', content: `${FRAME_USER_REQUEST} hi` } });
    r.line({ type: 'attachment', stub: true });
    r.line({ type: 'user', uuid: 'u2', message: { role: 'user', content: `${FRAME_COMPUTED_TASK}\n  Do it` } });
    r.tick();
    expect(of(r.emitted, 'agent-start')).toEqual([
      expect.objectContaining({
        taskPrompt: `${FRAME_USER_REQUEST} hi\n\n${FRAME_COMPUTED_TASK}\n  Do it`,
        parentCallId: 'call1',
      }),
    ]);
    r.line({
      type: 'assistant',
      uuid: 'a1',
      message: {
        id: 'm1',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
      },
    });
    r.tick();
    r.line({
      type: 'user',
      uuid: 'u3',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    });
    r.line({
      type: 'assistant',
      uuid: 'a2',
      message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    });
    r.tick();
    expect(r.emitted.map((e) => e.type)).toEqual([
      'agent-start',
      'step-start',
      'step-message',
      'tool-result',
      'step-start',
      'step-message',
    ]);
    r.runs.progress(r.frame('done', { resultPreview: 'done', tokens: 7 }), 0, r.out);
    r.runs.ended('wf1', 'completed', 'ok', undefined, r.out);
    expect(of(r.out, 'agent-end')).toEqual([expect.objectContaining({ status: 'completed', summary: 'done' })]);
    expect(r.out.at(-1)).toMatchObject({ type: 'workflow-end', stopReason: 'completed' });
    expect(r.ticks).toHaveLength(0); // the poll stopped with the run
  });

  it('a folder the CLI creates after the launch result is read once it exists (live M4 bug)', () => {
    // Live 2026-11-06: the launch result names `subagents/workflows/wf_…` before the CLI creates
    // it, so a guard checked only at launch never read any agent's lines.
    const r = liveRun({ makeDir: false });
    expect(r.ticks).toHaveLength(1); // the poll runs while the folder is pending
    r.runs.progress(r.frame('start'), 0, r.out);
    r.tick();
    expect(of(r.emitted, 'agent-start')).toHaveLength(0);
    r.mkdir();
    r.line({ type: 'user', uuid: 'u1', message: { role: 'user', content: `${FRAME_USER_REQUEST} hi` } });
    r.line({ type: 'user', uuid: 'u2', message: { role: 'user', content: `${FRAME_COMPUTED_TASK}\n  Do it` } });
    r.line({
      type: 'assistant',
      uuid: 'a1',
      message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'working' }] },
    });
    r.tick();
    expect(r.emitted.map((e) => e.type)).toEqual(['agent-start', 'step-start', 'step-message']);
    expect(of(r.emitted, 'agent-start')[0]?.taskPrompt).toBe(
      `${FRAME_USER_REQUEST} hi\n\n${FRAME_COMPUTED_TASK}\n  Do it`,
    );
  });

  it('a settled agent is read for a grace period, so a final line written after the done frame lands (live M4 bug)', () => {
    // Live 2026-11-06: "Reply alpha" agents reached their child session with no text: the CLI
    // wrote the assistant line about 60 ms after the frame that marked the agent done.
    const r = liveRun();
    r.runs.progress(r.frame('start'), 0, r.out);
    r.line({ type: 'user', uuid: 'u1', message: { role: 'user', content: `${FRAME_USER_REQUEST} hi` } });
    r.line({ type: 'user', uuid: 'u2', message: { role: 'user', content: `${FRAME_COMPUTED_TASK}\n  Do it` } });
    r.tick();
    expect(of(r.emitted, 'agent-start')).toHaveLength(1);
    r.runs.progress(r.frame('done', { resultPreview: 'alpha', tokens: 5 }), 0, r.out);
    expect(of(r.out, 'agent-end')).toHaveLength(0); // not yet: the last line may still come
    r.line({
      type: 'assistant',
      uuid: 'a1',
      message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'alpha' }] },
    });
    r.advance(1000);
    r.tick();
    expect(r.emitted.map((e) => e.type)).toEqual(['agent-start', 'step-start', 'step-message', 'agent-end']);
    expect(of(r.emitted, 'agent-end')[0]).toMatchObject({ status: 'completed', summary: 'alpha' });
    r.runs.ended('wf1', 'completed', 'ok', undefined, r.out);
    expect([...of(r.out, 'agent-end'), ...of(r.emitted, 'agent-end')]).toHaveLength(1);
  });

  it('running agents show live tokens from their transcript; the CLI count wins once settled (M5)', () => {
    const r = liveRun();
    r.runs.progress(r.frame('start'), 0, r.out);
    r.line({ type: 'user', uuid: 'u1', message: { role: 'user', content: `${FRAME_USER_REQUEST} hi` } });
    r.line({ type: 'user', uuid: 'u2', message: { role: 'user', content: `${FRAME_COMPUTED_TASK}\n  Do it` } });
    // Live M4 run W shape: the CLI's done row said 17,348 = 2 + 2,368 + 14,975 + 3 (last call).
    const usage = (input: number, write: number, read: number, output: number) => ({
      input_tokens: input,
      cache_creation_input_tokens: write,
      cache_read_input_tokens: read,
      output_tokens: output,
    });
    r.line({
      type: 'assistant',
      uuid: 'a1',
      message: {
        id: 'm1',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
        usage: usage(2, 14975, 0, 49),
      },
    });
    r.tick();
    const rows = () => of(r.emitted, 'workflow-snapshot').map((e) => e.agents[0]?.tokens);
    expect(rows().at(-1)).toBe(15026);
    expect(of(r.emitted, 'task-progress').at(-1)).toMatchObject({ taskId: 'ag1', usage: { tokens: 15026 } });
    // The snapshot comes before the agent's own events (agent-start follows the first snapshot).
    const types = r.emitted.map((e) => e.type);
    expect(types.indexOf('agent-start')).toBeLessThan(types.indexOf('step-message'));
    r.line({
      type: 'assistant',
      uuid: 'a2',
      message: {
        id: 'm2',
        role: 'assistant',
        content: [{ type: 'text', text: 'one' }],
        usage: usage(2, 2368, 14975, 3),
      },
    });
    r.tick();
    expect(rows().at(-1)).toBe(17348);
    const before = of(r.emitted, 'workflow-snapshot').length;
    r.tick(); // nothing new: no new snapshot
    expect(of(r.emitted, 'workflow-snapshot')).toHaveLength(before);
    r.runs.progress(r.frame('done', { resultPreview: 'one', tokens: 17350 }), 0, r.out);
    expect(of(r.out, 'workflow-snapshot').at(-1)?.agents[0]?.tokens).toBe(17350);
  });

  it('falls back to the prompt preview when no framing shows in time', () => {
    const r = liveRun();
    r.runs.progress(r.frame('start'), 0, r.out);
    r.advance(1600);
    r.tick();
    expect(of(r.emitted, 'agent-start')[0]?.taskPrompt).toBe('Do it');
  });

  it('a folder outside the projects folder is never read; the agent still gets a child', () => {
    const runs = new WorkflowRuns({ projectsDir: () => '/somewhere/else' });
    const out: BackendEvent[] = [];
    runs.taskStarted({ task_id: 'wf2', task_type: 'local_workflow', workflow_name: 'w' });
    runs.launched({ status: 'async_launched', taskId: 'wf2', transcriptDir: tmpdir() }, undefined, 0, out);
    runs.progress(
      {
        task_id: 'wf2',
        workflow_progress: [
          { type: 'workflow_agent', index: 1, label: 'z', agentId: 'z1', state: 'done', promptPreview: 'p' },
        ],
      },
      0,
      out,
    );
    expect(out.map((e) => e.type)).toEqual(['workflow-start', 'workflow-snapshot', 'agent-start', 'agent-end']);
    runs.exit(out, 'gone');
    expect(out.at(-1)).toMatchObject({ type: 'workflow-end', stopReason: 'error' });
  });

  it('the CLI exit ends running agents and the run', () => {
    const r = liveRun();
    r.runs.progress(r.frame('progress'), 0, r.out);
    r.advance(2000);
    r.tick();
    r.runs.exit(r.out, 'Claude Code ended');
    expect(of(r.out, 'agent-end')).toEqual([expect.objectContaining({ status: 'failed' })]);
    expect(of(r.out, 'workflow-end')[0]).toMatchObject({ stopReason: 'error', summary: 'Claude Code ended' });
  });

  it('a snapshot that comes before the launch result is held until it (D48 order)', () => {
    const runs = new WorkflowRuns();
    const out: BackendEvent[] = [];
    runs.taskStarted({ task_id: 'wf3', task_type: 'local_workflow', workflow_name: 'w' });
    runs.progress({ task_id: 'wf3', workflow_progress: [{ type: 'workflow_phase', index: 1, title: 'P' }] }, 0, out);
    expect(out).toEqual([]);
    runs.launched({ status: 'async_launched', taskId: 'wf3', runId: 'wf_3' }, 'c', 0, out);
    expect(out.map((e) => e.type)).toEqual(['workflow-start', 'workflow-snapshot']);
  });
});

// ---- session controls ----

function fakeQuery(settings?: Record<string, unknown>) {
  const out = new AsyncQueue<unknown>();
  const calls: Array<[string, unknown[]]> = [];
  const q = {
    [Symbol.asyncIterator]: () => out[Symbol.asyncIterator](),
    interrupt: async () => ({ still_queued: [] }),
    stopTask: async (...a: unknown[]) => void calls.push(['stopTask', a]),
    applyFlagSettings: async (...a: unknown[]) => void calls.push(['applyFlagSettings', a]),
    getSettings: async () => settings ?? {},
    getTaskOutput: async (...a: unknown[]) => (
      calls.push(['getTaskOutput', a]),
      { output: 'tick\n', total_bytes: 5, truncated: false }
    ),
    close: () => out.end(),
  };
  const queryFn: QueryFn = () => {
    process.env.CLAUDE_AGENT_SDK_VERSION = '0.3.318';
    return q as never;
  };
  return { out, calls, queryFn };
}

const noInteractions: InteractionHandler = {
  permission: async () => ({ optionId: 'reject' }),
  question: async () => null,
  plan: async () => ({ kind: 'keep-planning' }),
  elicitation: async () => ({ action: 'decline' }),
};

async function openSession(settings?: Record<string, unknown>) {
  const fake = fakeQuery(settings);
  const factory = createClaudeFactory({ queryFn: fake.queryFn });
  const dir = mkdtempSync(join(tmpdir(), 'raw-agent-wf-'));
  const exe = join(dir, 'claude');
  writeFileSync(exe, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const session = await factory.open({
    cwd: '/tmp',
    env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: join(dir, '.claude') },
    start: { kind: 'new', sessionId: factory.sessionIdFor!('wf-session') },
    userConfig: { executablePath: exe, options: {} },
    interactions: noInteractions,
    signal: new AbortController().signal,
  });
  const events: BackendEvent[] = [];
  const reader = (async () => {
    for await (const e of session.events()) events.push(e);
  })();
  return { fake, session, events, reader, home: dir };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

describe.skipIf(process.platform === 'win32')('session controls for workflows and ultracode', () => {
  it('stops a whole run, refuses one workflow agent, and never reads a workflow as task output', async () => {
    const { fake, session, events, reader } = await openSession();
    expect(session.capabilities.workflows).toBe(true);
    expect(session.capabilities.workflowAgentStop).toBe(false);
    fake.out.push({
      type: 'system',
      subtype: 'task_started',
      task_id: 'wf1',
      task_type: 'local_workflow',
      workflow_name: 'w',
      tool_use_id: 'c1',
    });
    fake.out.push({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'wf1',
      workflow_progress: [
        { type: 'workflow_agent', index: 1, label: 'w1', agentId: 'ag1', state: 'start', startedAt: 1 },
      ],
    });
    await flush();
    expect(of(events, 'task-start')[0]).toMatchObject({ taskId: 'wf1', kind: 'workflow' });
    await expect(session.controls.stopTask!('ag1')).rejects.toThrow(/cannot stop one agent of a workflow/);
    await expect(session.controls.taskOutput!('wf1')).rejects.toThrow(/only for background shells/);
    expect(fake.calls.filter((c) => c[0] === 'stopTask' || c[0] === 'getTaskOutput')).toEqual([]);
    await session.controls.stopTask!('wf1');
    expect(fake.calls).toContainEqual(['stopTask', ['wf1']]);
    expect(await session.controls.taskOutput!('shell1')).toEqual({ output: 'tick\n', totalBytes: 5, truncated: false });
    await session.dispose();
    await reader;
  });

  it('ultracode as the terminal app sets it, and the CLI’s own state', async () => {
    const { fake, session, reader } = await openSession({
      applied: { effort: 'high', ultracode: false, ultracodeRequested: true, ultracodeAvailable: true },
    });
    await session.controls.setUltracode!(true);
    await session.controls.setUltracode!(false);
    await session.controls.setEffort!('low');
    await session.controls.setEffort!(null);
    expect(fake.calls.filter((c) => c[0] === 'applyFlagSettings').map((c) => c[1][0])).toEqual([
      { ultracode: true },
      { ultracode: false },
      { effortLevel: 'low' },
      { effortLevel: null, ultracode: null },
    ]);
    expect(await session.controls.effortState!()).toEqual({
      effort: 'high',
      ultracode: false,
      ultracodeRequested: true,
      ultracodeAvailable: true,
    });
    expect(effortFlags('ultracode')).toEqual({ ultracode: true });
    await session.dispose();
    await reader;
  });

  it('tails a live run under the session’s projects folder and pushes its agent output', async () => {
    const { fake, session, events, reader, home } = await openSession();
    const dir = join(home, '.claude', 'projects', 'slug', 'sid', 'subagents', 'workflows', 'wf_9');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'agent-ag9.jsonl'),
      [
        { type: 'user', uuid: 'u1', message: { role: 'user', content: `${FRAME_USER_REQUEST} x` } },
        { type: 'user', uuid: 'u2', message: { role: 'user', content: `${FRAME_COMPUTED_TASK} y` } },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n') + '\n',
    );
    fake.out.push({
      type: 'system',
      subtype: 'task_started',
      task_id: 'wf9',
      task_type: 'local_workflow',
      workflow_name: 'w',
      tool_use_id: 'c9',
    });
    fake.out.push({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } });
    fake.out.push({
      type: 'assistant',
      uuid: 'x1',
      message: { id: 'm1', content: [{ type: 'tool_use', id: 'c9', name: 'Workflow', input: {} }] },
    });
    fake.out.push({ type: 'stream_event', event: { type: 'message_stop' } });
    fake.out.push({
      type: 'user',
      uuid: 'x2',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c9', content: 'launched' }] },
      tool_use_result: {
        status: 'async_launched',
        taskId: 'wf9',
        taskType: 'local_workflow',
        runId: 'wf_9',
        transcriptDir: dir,
      },
    });
    fake.out.push({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'wf9',
      workflow_progress: [
        { type: 'workflow_agent', index: 1, label: 'w9', agentId: 'ag9', state: 'start', startedAt: 1 },
      ],
    });
    await flush();
    expect(of(events, 'workflow-start')[0]).toMatchObject({ runId: 'wf_9', transcriptDir: dir });
    expect(of(events, 'agent-start')[0]).toMatchObject({
      label: 'w9',
      taskPrompt: `${FRAME_USER_REQUEST} x\n\n${FRAME_COMPUTED_TASK} y`,
    });
    appendFileSync(
      join(dir, 'agent-ag9.jsonl'),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        message: { id: 'm9', role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      }) + '\n',
    );
    for (let i = 0; i < 30 && !of(events, 'step-message').some((e) => e.agent.kind === 'child'); i++)
      await new Promise((r) => setTimeout(r, 100));
    const child = of(events, 'step-message').find((e) => e.agent.kind === 'child');
    expect(child?.blocks).toEqual([{ type: 'text', text: 'hello' }]);
    await session.dispose();
    await reader;
    expect(of(events, 'workflow-end')[0]).toMatchObject({ taskId: 'wf9', stopReason: 'error' });
  });
});
