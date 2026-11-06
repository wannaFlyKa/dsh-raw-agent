// Dynamic workflow runs (R6.5; D47, D48, D49, D74). DSH-neutral: the port writes the native
// workflow records (`tool-workflow/*`, dsh-seams R2.4) into the parent session; this file holds
// the run registry and decides what to write and when.
//
// - A run's native record opens when the run starts (after the launching call's result) and
//   closes when the run ends, the process exits, or the session goes away. It holds no turn: the
//   run itself is a host job (D47), so the session stays free (rule 7).
// - Each workflow agent is a one-shot child session made by the live-child registry (D45). Its
//   member record names that child session, so it is written only once the child session exists.
//   Per run, records are written in order: run start, members, member ends, run end.
// - The plugin view (tokens, tool counts, status per agent, "Stop entire workflow") comes from the
//   merged snapshots alone (D48); the native node has none of that.
// - Member seqs come from the agent's own number in the run (`index`), made unique per run.

import type {
  BackendEventOf,
  TaskStatus,
  TaskUsage,
  WorkflowAgent,
  WorkflowAgentState,
  WorkflowPhase,
} from '@dsh-raw-agent/core';
import { isSettledWorkflowAgent } from '@dsh-raw-agent/core';

/** How one workflow member ended, in the host's words. */
export type WorkflowMemberOutcome = 'completed' | 'failed' | 'cancelled';
/** How one run ended, in the host's words. */
export type WorkflowStopReason = 'completed' | 'cancelled' | 'error';

/** One native workflow record for the parent session (the port names the host event types). */
export type WorkflowRecord =
  | { kind: 'run-start'; runId: string; name: string }
  | { kind: 'agent-start'; runId: string; seq: number; label: string; phase?: string; childId: string }
  | { kind: 'agent-end'; runId: string; seq: number; outcome: WorkflowMemberOutcome }
  | { kind: 'run-end'; runId: string; stopReason: WorkflowStopReason };

/** A run record left open in the host log by a process that is gone (read back by the port). */
export interface OpenWorkflowRun {
  runId: string;
  /** Member seqs that have a start and no end. */
  openSeqs: number[];
}

export interface WorkflowDeps {
  now(): number;
  warn(note: string, detail?: unknown): void;
  notify(): void;
  /** Write one record into the parent session. A throw: the record is not written. */
  write(record: WorkflowRecord): void;
  /** The host child session of one agent, once it exists; undefined when it has none. */
  childSession(agentId: string): Promise<string | undefined>;
}

export type WorkflowRunStatus = 'starting' | 'running' | WorkflowStopReason;

/** One agent row of the plugin's workflow view. */
export interface WorkflowAgentView extends WorkflowAgent {
  /** The agent's host child session, once its member record is written. */
  childSessionId?: string;
}

/** One workflow run for the plugin UI (D48). Wire-safe JSON. */
export interface WorkflowView {
  taskId: string;
  /** The id of the native run record. */
  runId: string;
  name: string;
  label?: string;
  status: WorkflowRunStatus;
  /** "Stop entire workflow" was pressed and the run has not ended yet. */
  stopping?: boolean;
  phases: WorkflowPhase[];
  agents: WorkflowAgentView[];
  usage?: TaskUsage;
  /** The main-thread tool call that launched it. */
  callId?: string;
  startedAt: number;
  endedAt?: number;
  summary?: string;
}

/** How many ended runs the plugin view keeps (in memory only). */
export const WORKFLOW_RUNS_KEPT = 20;
/** How long a member record waits for its child session before it is skipped. */
export const WORKFLOW_CHILD_WAIT_MS = 10_000;

interface Member {
  agentId: string;
  seq: number;
  label: string;
  phase?: string;
  /** Its child agent started (the registry makes its child session). */
  announced: boolean;
  startWritten: boolean;
  endQueued: boolean;
  childId?: string;
}

class Run {
  readonly taskId: string;
  runId: string;
  name: string;
  label?: string;
  callId?: string;
  status: WorkflowRunStatus = 'starting';
  stopping = false;
  /** `workflow-start` was seen (or the run was started late, at its end). */
  started = false;
  phases: WorkflowPhase[] = [];
  agents: WorkflowAgent[] = [];
  usage?: TaskUsage;
  summary?: string;
  readonly startedAt: number;
  endedAt?: number;
  readonly members = new Map<string, Member>();
  readonly seqs = new Set<number>();
  /** Writes wait here until the run starts, then run in order. */
  waiting: Array<() => Promise<void> | void> = [];
  chain: Promise<void> = Promise.resolve();
  /** The run-start record could not be written: nothing else of this run is. */
  broken = false;
  written = false;

  constructor(taskId: string, at: number) {
    this.taskId = taskId;
    this.runId = taskId;
    this.name = taskId;
    this.startedAt = at;
  }

  get live(): boolean {
    return this.status === 'starting' || this.status === 'running';
  }
}

export function memberOutcomeOfStatus(status: TaskStatus): WorkflowMemberOutcome {
  return status === 'completed' ? 'completed' : status === 'stopped' ? 'cancelled' : 'failed';
}

/** A settled row's outcome; an `error` row of a stopped run was cut by the stop. */
export function memberOutcomeOfState(state: WorkflowAgentState, runStopped: boolean): WorkflowMemberOutcome {
  if (state === 'done') return 'completed';
  if (state === 'stopped') return 'cancelled';
  return runStopped ? 'cancelled' : 'failed';
}

export class WorkflowRecorder {
  readonly #deps: WorkflowDeps;
  readonly #runs = new Map<string, Run>();
  /** Agent id → run task id (from snapshot rows). */
  readonly #agentRuns = new Map<string, string>();
  /** Workflow agents that started before any snapshot named them. */
  readonly #orphans = new Map<string, BackendEventOf<'agent-start'>>();

  constructor(deps: WorkflowDeps) {
    this.#deps = deps;
  }

  get size(): number {
    return this.#runs.size;
  }

  has(taskId: string): boolean {
    return this.#runs.has(taskId);
  }

  isLive(taskId: string): boolean {
    return this.#runs.get(taskId)?.live === true;
  }

  /** The run's job started (D47): a row in the view from the first moment. */
  taskStarted(taskId: string, label: string): void {
    const run = this.#run(taskId);
    run.label ??= label;
    if (!run.started) run.name = label;
  }

  /** The run started (after its launching call's result): open its native record. */
  start(e: BackendEventOf<'workflow-start'>): void {
    const run = this.#run(e.taskId);
    if (run.started || !run.live) return;
    if (e.runId !== undefined && e.runId !== '') run.runId = e.runId;
    run.name = e.name || e.label || run.name;
    if (e.label !== undefined) run.label = e.label;
    if (e.callId !== undefined) run.callId = e.callId;
    run.status = 'running';
    this.#open(run);
    for (const [agentId, a] of [...this.#orphans])
      if (a.parentCallId !== undefined && a.parentCallId === run.callId) {
        this.#orphans.delete(agentId);
        this.#agentRuns.set(agentId, run.taskId);
        this.#announce(run, a);
      }
  }

  /** The run's merged snapshot (D48): the plugin view, member names and settled rows. */
  snapshot(e: BackendEventOf<'workflow-snapshot'>): void {
    const run = this.#run(e.taskId);
    if (!run.live) return;
    run.phases = e.phases.map((p) => ({ ...p }));
    run.agents = e.agents.map((a) => ({ ...a }));
    if (e.usage !== undefined) run.usage = { ...e.usage };
    for (const row of e.agents) {
      if (row.agentId === undefined) continue;
      this.#agentRuns.set(row.agentId, run.taskId);
      const m = this.#member(run, row.agentId, row);
      if (!m.startWritten) {
        m.label = row.label || m.label;
        const phase = phaseName(row);
        if (phase !== undefined) m.phase = phase;
      }
      const orphan = this.#orphans.get(row.agentId);
      if (orphan) {
        this.#orphans.delete(row.agentId);
        this.#announce(run, orphan);
      }
      if (m.announced && isSettledWorkflowAgent(row.state))
        this.#endMember(run, m, memberOutcomeOfState(row.state, run.stopping));
    }
  }

  /** A workflow agent's child agent started (its child session is being made, D45). */
  agentStarted(e: BackendEventOf<'agent-start'>): void {
    if (e.role !== 'workflow-agent' || e.ref.kind !== 'child') return;
    const agentId = e.ref.id;
    let taskId = this.#agentRuns.get(agentId);
    if (taskId === undefined && e.parentCallId !== undefined)
      taskId = [...this.#runs.values()].find((r) => r.live && r.callId === e.parentCallId)?.taskId;
    const run = taskId === undefined ? undefined : this.#runs.get(taskId);
    if (!run || !run.live) {
      this.#orphans.set(agentId, e);
      return;
    }
    this.#agentRuns.set(agentId, run.taskId);
    this.#announce(run, e);
  }

  /** A workflow agent's child agent ended. */
  agentEnded(e: BackendEventOf<'agent-end'>): void {
    if (e.ref.kind !== 'child') return;
    this.#orphans.delete(e.ref.id);
    const taskId = this.#agentRuns.get(e.ref.id);
    const run = taskId === undefined ? undefined : this.#runs.get(taskId);
    const m = run?.members.get(e.ref.id);
    if (!run || !m || !m.announced) return;
    this.#endMember(run, m, run.stopping && e.status !== 'completed' ? 'cancelled' : memberOutcomeOfStatus(e.status));
  }

  /** "Stop entire workflow" was pressed (or its job was killed). */
  noteStop(taskId: string): void {
    const run = this.#runs.get(taskId);
    if (!run || !run.live) return;
    run.stopping = true;
    this.#deps.notify();
  }

  /** The stop failed: the run keeps running. */
  clearStop(taskId: string): void {
    const run = this.#runs.get(taskId);
    if (!run || !run.stopping) return;
    run.stopping = false;
    this.#deps.notify();
  }

  /** The run ended: its open members end, then its record closes. */
  ended(e: BackendEventOf<'workflow-end'>): void {
    this.#finish(this.#run(e.taskId), e.stopReason, e.summary, e.usage);
  }

  /** D74: the process exited or the session goes away: every live run ends now. */
  closeAll(stopReason: WorkflowStopReason, summary?: string): void {
    for (const run of this.#runs.values()) if (run.live) this.#finish(run, stopReason, summary);
    this.#orphans.clear();
  }

  /**
   * Records a gone process left open in the host log (a host restart ends the process with it):
   * each open member and each run is closed. Runs this recorder holds live are left alone.
   */
  closeStale(open: readonly OpenWorkflowRun[]): void {
    const live = new Set([...this.#runs.values()].filter((r) => r.live).map((r) => r.runId));
    for (const o of open) {
      if (live.has(o.runId)) continue;
      try {
        for (const seq of o.openSeqs) this.#deps.write({ kind: 'agent-end', runId: o.runId, seq, outcome: 'failed' });
        this.#deps.write({ kind: 'run-end', runId: o.runId, stopReason: 'error' });
      } catch (error) {
        this.#deps.warn('could not close a stale workflow record', String((error as Error)?.message ?? error));
      }
    }
  }

  /** Resolves once every queued record is written (or after `ms`). */
  async flush(ms = 5000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const chains = Promise.all([...this.#runs.values()].map((r) => r.chain)).then(() => undefined);
    await Promise.race([chains, new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
    clearTimeout(timer);
  }

  views(): WorkflowView[] {
    return [...this.#runs.values()].map((run) => {
      const v: WorkflowView = {
        taskId: run.taskId,
        runId: run.runId,
        name: run.name,
        status: run.status,
        phases: run.phases.map((p) => ({ ...p })),
        agents: run.agents.map((a) => {
          const row: WorkflowAgentView = { ...a };
          const child = a.agentId === undefined ? undefined : run.members.get(a.agentId)?.childId;
          if (child !== undefined) row.childSessionId = child;
          return row;
        }),
        startedAt: run.startedAt,
      };
      if (run.label !== undefined) v.label = run.label;
      if (run.stopping && run.live) v.stopping = true;
      if (run.usage !== undefined) v.usage = { ...run.usage };
      if (run.callId !== undefined) v.callId = run.callId;
      if (run.endedAt !== undefined) v.endedAt = run.endedAt;
      if (run.summary !== undefined) v.summary = run.summary;
      return v;
    });
  }

  // ---- internals ----

  #run(taskId: string): Run {
    let run = this.#runs.get(taskId);
    if (!run) {
      run = new Run(taskId, this.#deps.now());
      this.#runs.set(taskId, run);
      this.#prune();
    }
    return run;
  }

  #prune(): void {
    const ended = [...this.#runs.values()].filter((r) => !r.live);
    for (const r of ended.slice(0, Math.max(0, ended.length - WORKFLOW_RUNS_KEPT))) {
      this.#runs.delete(r.taskId);
      for (const id of r.members.keys()) this.#agentRuns.delete(id);
    }
  }

  #member(run: Run, agentId: string, row?: WorkflowAgent): Member {
    let m = run.members.get(agentId);
    if (m) return m;
    let seq = row?.index ?? 1;
    if (run.seqs.has(seq)) seq = Math.max(...run.seqs) + 1;
    run.seqs.add(seq);
    m = { agentId, seq, label: row?.label ?? agentId, announced: false, startWritten: false, endQueued: false };
    const phase = row === undefined ? undefined : phaseName(row);
    if (phase !== undefined) m.phase = phase;
    run.members.set(agentId, m);
    return m;
  }

  /** Queue one write of this run; before the run starts, it waits. */
  #enqueue(run: Run, op: () => Promise<void> | void): void {
    if (!run.started) {
      run.waiting.push(op);
      return;
    }
    run.chain = run.chain
      .then(() => (run.broken ? undefined : op()))
      .catch((error: unknown) =>
        this.#deps.warn('a workflow record failed', String((error as Error)?.message ?? error)),
      );
  }

  #write(run: Run, record: WorkflowRecord): boolean {
    try {
      this.#deps.write(record);
      return true;
    } catch (error) {
      this.#deps.warn(`could not record workflow ${record.kind}`, String((error as Error)?.message ?? error));
      return false;
    }
  }

  #open(run: Run): void {
    run.started = true;
    this.#enqueue(run, () => {
      run.written = this.#write(run, { kind: 'run-start', runId: run.runId, name: run.name });
      if (!run.written) run.broken = true;
    });
    const waiting = run.waiting;
    run.waiting = [];
    for (const op of waiting) this.#enqueue(run, op);
    this.#deps.notify();
  }

  #announce(run: Run, e: BackendEventOf<'agent-start'>): void {
    if (e.ref.kind !== 'child') return;
    const m = this.#member(run, e.ref.id);
    if (m.announced) return; // a second start of the same agent stays in its first member
    m.announced = true;
    if (m.label === m.agentId) m.label = e.label;
    this.#enqueue(run, async () => {
      const childId = await this.#childSession(m.agentId);
      if (childId === undefined) {
        this.#deps.warn('a workflow agent has no child session; its member is not recorded', m.label);
        return;
      }
      const r: WorkflowRecord = { kind: 'agent-start', runId: run.runId, seq: m.seq, label: m.label, childId };
      if (m.phase !== undefined) r.phase = m.phase;
      if (this.#write(run, r)) {
        m.startWritten = true;
        m.childId = childId;
        this.#deps.notify();
      }
    });
    this.#deps.notify();
  }

  async #childSession(agentId: string): Promise<string | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.#deps.childSession(agentId),
        new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), WORKFLOW_CHILD_WAIT_MS))),
      ]);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  #endMember(run: Run, m: Member, outcome: WorkflowMemberOutcome): void {
    if (m.endQueued) return;
    m.endQueued = true;
    this.#enqueue(run, () => {
      if (!m.startWritten) return;
      this.#write(run, { kind: 'agent-end', runId: run.runId, seq: m.seq, outcome });
    });
  }

  #finish(run: Run, stopReason: WorkflowStopReason, summary?: string, usage?: TaskUsage): void {
    if (!run.live) return;
    // A run that never reported its start still gets a record, so its members are not lost.
    if (!run.started) this.#open(run);
    const stopped = run.stopping || stopReason === 'cancelled';
    for (const m of run.members.values()) {
      if (!m.announced) continue;
      const row = run.agents.find((a) => a.agentId === m.agentId);
      const outcome: WorkflowMemberOutcome =
        row !== undefined && isSettledWorkflowAgent(row.state)
          ? memberOutcomeOfState(row.state, stopped)
          : stopReason === 'completed'
            ? 'completed'
            : stopReason === 'cancelled'
              ? 'cancelled'
              : 'failed';
      this.#endMember(run, m, outcome);
    }
    run.status = stopReason;
    run.endedAt = this.#deps.now();
    if (summary !== undefined) run.summary = summary;
    if (usage !== undefined) run.usage = { ...usage };
    this.#enqueue(run, () => {
      if (run.written) this.#write(run, { kind: 'run-end', runId: run.runId, stopReason });
    });
    this.#prune();
    this.#deps.notify();
  }
}

function phaseName(row: WorkflowAgent): string | undefined {
  if (row.phaseTitle !== undefined && row.phaseTitle !== '') return row.phaseTitle;
  if (row.phaseIndex !== undefined) return `Phase ${row.phaseIndex}`;
  return undefined;
}
