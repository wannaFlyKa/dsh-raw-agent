// Dynamic workflows (R6.5; D47, D48, D49). Claude Code's wire, as seen live (CLI 2.1.318, M4
// probe `backend-workflows`, fixtures `workflow-*.jsonl`):
// - The model calls the `Workflow` tool. `system/task_started` comes with `task_type:
//   local_workflow`, `workflow_name`, `description` (the run label) and `tool_use_id` (the call),
//   but with NO `is_backgrounded` field: a workflow always runs in the background.
// - The call's main-thread `tool_result` frame carries `tool_use_result {status:'async_launched',
//   taskId, taskType:'local_workflow', workflowName, runId:'wf_…', summary, transcriptDir,
//   scriptPath}`. It can arrive before the step's `message_stop` (it is then held, D18).
// - `system/task_progress` frames of the run carry the undeclared `workflow_progress`: the FULL
//   list of `workflow_phase {index, title}` and `workflow_agent {index, label, phaseIndex,
//   phaseTitle, agentId (once started), state, attempt, tokens, toolCalls, lastToolName,
//   lastToolSummary, startedAt, durationMs, promptPreview, resultPreview, error, …}` entries,
//   and possibly `workflow_log` entries (ignored). Frames come on events, not on a timer; some
//   carry only `usage` (ignored here, D48). States seen: `start` (queued: no `startedAt`;
//   running: with it), `progress`, `done`, `error` ("Stopped because the workflow was stopped").
// - Workflow agents are never on the stream. Their transcripts are appended live under
//   `transcriptDir` (`agent-<agentId>.jsonl`); the first two user lines are the CLI's framing
//   ("[Workflow harness — user request] …", "[Workflow harness — computed task] …").
// - `task_notification` of the run ends it (`completed`, or `stopped` after `stopTask(run)`).
// - `stopTask(<workflow agent id>)` is accepted and does nothing (probe X): there is no control
//   to stop one workflow agent (the terminal app's "skip" is internal). An `interrupt()` with
//   `perTaskStopAffordance` spares a running workflow (probe X, sdk-surface §7.3).
//
// Events (D48, D49): `workflow-start` after the launching call's `tool-result`; a merged
// `workflow-snapshot` when a frame changes it; per agent `agent-start` (role 'workflow-agent',
// task prompt = the CLI's two framing texts, else the agent's prompt preview), its transcript
// steps in the D68 child shape, `task-progress {taskId: agentId}` for its row, `agent-end` when
// its row settles (after a last read of its file); at the run end the agents' ends, a final
// settled snapshot and `workflow-end`, before the job's `task-end` (the mapper's).

import type {
  AgentRef,
  BackendEvent,
  TaskStatus,
  TaskUsage,
  WorkflowAgent,
  WorkflowAgentState,
} from '@dsh-raw-agent/core';
import { mergeWorkflowSnapshot, settleWorkflowSnapshot, type WorkflowSnapshot } from '@dsh-raw-agent/core';
import { ChildAgents } from './children.js';
import { isObject, num, str, type WireMessage } from './wire.js';
import { insideFolder, nodeTailFs, TranscriptTail, type TailFs } from './workflow-tail.js';

type Loose = Record<string, unknown>;

const MAIN: AgentRef = Object.freeze({ kind: 'main' }) as AgentRef;
/** The live poll (D49): about every 500 ms while a run is live. */
export const WORKFLOW_POLL_MS = 500;
/** An agent whose framing lines did not show yet is announced with its prompt preview after this. */
export const ANNOUNCE_AFTER_MS = 1500;
/**
 * The CLI marks an agent done in `workflow_progress` before it has written that agent's last
 * transcript line (live 2026-11-06: about 60 ms later). While the live poll runs, a settled agent
 * is read for this long more before it ends, so its final text reaches its child session.
 */
export const SETTLE_GRACE_MS = 1000;
/** The CLI's framing of a workflow agent's task (CLI 2.1.318 binary). */
export const FRAME_USER_REQUEST = '[Workflow harness \u2014 user request]';
export const FRAME_COMPUTED_TASK = '[Workflow harness \u2014 computed task]';

/** Parse a `workflow_progress` array (D9: every field checked). Undefined when it is not one. */
export function parseWorkflowProgress(raw: unknown): WorkflowSnapshot | undefined {
  if (!Array.isArray(raw)) return undefined;
  const snap: WorkflowSnapshot = { phases: [], agents: [] };
  for (const item of raw) {
    if (!isObject(item)) continue;
    if (item.type === 'workflow_phase') {
      const index = num(item.index);
      if (index !== undefined) snap.phases.push({ index, title: str(item.title) ?? `Phase ${index}` });
    } else if (item.type === 'workflow_agent') {
      const a = parseAgent(item);
      if (a !== undefined) snap.agents.push(a);
    }
  }
  return snap;
}

/** The CLI's state word → ours. Unknown words count as running (D48). */
/** The `error` of a workflow agent the CLI stopped with its run (CLI 2.1.318, live probe S). */
export const WORKFLOW_STOPPED_ERROR = 'Stopped because the workflow was stopped';

export function workflowAgentState(raw: string | undefined, started: boolean): WorkflowAgentState {
  switch (raw) {
    case 'start':
      return started ? 'running' : 'queued';
    case 'queued':
      return 'queued';
    case 'progress':
    case 'running':
      return 'running';
    case 'done':
      return 'done';
    case 'error':
      return 'error';
    default:
      return 'running';
  }
}

function parseAgent(item: Loose): WorkflowAgent | undefined {
  const index = num(item.index);
  if (index === undefined) return undefined;
  const raw = str(item.state);
  const agentId = str(item.agentId);
  const startedAt = num(item.startedAt);
  let state = workflowAgentState(raw, startedAt !== undefined || agentId !== undefined);
  // The CLI marks the agents of a stopped run `error` with its own stop text: they were stopped.
  if (state === 'error' && str(item.error)?.startsWith(WORKFLOW_STOPPED_ERROR) === true) state = 'stopped';
  const a: WorkflowAgent = { index, label: str(item.label) ?? `agent ${index}`, state };
  if (raw !== undefined && raw !== state) a.rawState = raw;
  const n = (k: keyof WorkflowAgent, v: unknown) => {
    const x = num(v);
    if (x !== undefined) (a as unknown as Loose)[k] = x;
  };
  const s = (k: keyof WorkflowAgent, v: unknown) => {
    const x = str(v);
    if (x !== undefined && x !== '') (a as unknown as Loose)[k] = x;
  };
  n('phaseIndex', item.phaseIndex);
  s('phaseTitle', item.phaseTitle);
  s('agentId', agentId);
  n('attempt', item.attempt);
  s('model', item.model);
  s('agentType', item.agentType);
  n('tokens', item.tokens);
  n('toolCalls', item.toolCalls);
  s('lastToolName', item.lastToolName);
  s('lastToolSummary', item.lastToolSummary);
  n('queuedAt', item.queuedAt);
  n('startedAt', startedAt);
  n('lastProgressAt', item.lastProgressAt);
  n('durationMs', item.durationMs);
  s('promptPreview', item.promptPreview);
  s('resultPreview', item.resultPreview);
  s('error', item.error);
  if (item.cached === true) a.cached = true;
  if (item.blocked === true) a.blocked = true;
  return a;
}

/** `usage` of a task frame. */
export function taskUsageOf(raw: unknown): TaskUsage | undefined {
  if (!isObject(raw)) return undefined;
  const usage: TaskUsage = {};
  const tokens = num(raw.total_tokens);
  const toolUses = num(raw.tool_uses);
  const durationMs = num(raw.duration_ms);
  if (tokens !== undefined) usage.tokens = tokens;
  if (toolUses !== undefined) usage.toolUses = toolUses;
  if (durationMs !== undefined) usage.durationMs = durationMs;
  return usage;
}

export function workflowStopReason(status: string | undefined): 'completed' | 'cancelled' | 'error' {
  if (status === 'completed') return 'completed';
  if (status === 'stopped' || status === 'killed') return 'cancelled';
  return 'error';
}

/** A user line that is only text (the framing): its text, else undefined. */
function framingText(line: Loose): string | undefined {
  if (line.type !== 'user' || line.isMeta === true) return undefined;
  const message = isObject(line.message) ? line.message : {};
  const c = message.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c) || c.length === 0) return undefined;
  const texts: string[] = [];
  for (const b of c) {
    if (!isObject(b) || b.type !== 'text' || typeof b.text !== 'string') return undefined;
    texts.push(b.text);
  }
  return texts.join('\n');
}

interface AgentState {
  agentId: string;
  index: number;
  label: string;
  announced: boolean;
  ended: boolean;
  firstSeen: number;
  framing: string[];
  framingDone: boolean;
  usageKey?: string;
  /** The row settled while the live poll runs: the agent ends after SETTLE_GRACE_MS. */
  settledAt?: number;
}

interface Run {
  taskId: string;
  name: string;
  label?: string;
  callId?: string;
  runId?: string;
  transcriptDir?: string;
  scriptPath?: string;
  /** workflow-start was emitted. */
  started: boolean;
  /** The user asked to stop the whole run: agents that end now were stopped. */
  stopping?: boolean;
  ended: boolean;
  snap?: WorkflowSnapshot;
  lastSent?: string;
  usage?: TaskUsage;
  tail?: TranscriptTail;
  /**
   * The transcript folder named by the launch result but not created yet: the CLI makes it when
   * its first agent starts. Checked again (D49 guard) at every read until it exists.
   */
  pendingDir?: string;
  agents: Map<string, AgentState>;
}

export interface WorkflowTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface WorkflowRunsOptions {
  /** Where events from the live poll go (the session's event queue). */
  emit?: (events: BackendEvent[]) => void;
  /** The CLI's `projects` folder: transcript folders outside it are never read (D49). */
  projectsDir?: () => string | undefined;
  fs?: TailFs;
  now?: () => number;
  timers?: WorkflowTimers;
  pollMs?: number;
  announceAfterMs?: number;
  settleGraceMs?: number;
  debug?: (note: string, detail: unknown) => void;
}

const nodeTimers: WorkflowTimers = {
  set(fn, ms) {
    const h = setInterval(fn, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clear(h) {
    clearInterval(h as ReturnType<typeof setInterval>);
  },
};

export class WorkflowRuns {
  readonly #o: WorkflowRunsOptions;
  readonly #now: () => number;
  readonly #debug: (note: string, detail: unknown) => void;
  readonly #runs = new Map<string, Run>();
  /** Workflow agent id → its run's task id. */
  readonly #agentRuns = new Map<string, string>();
  readonly #kids: ChildAgents;
  #timer: unknown;

  constructor(options: WorkflowRunsOptions = {}) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#debug = options.debug ?? (() => {});
    this.#kids = new ChildAgents({ debug: this.#debug });
  }

  isRun(taskId: string): boolean {
    return this.#runs.has(taskId);
  }

  /** Whether an id is a workflow agent of this session (it cannot be stopped on its own). */
  isAgent(id: string): boolean {
    return this.#agentRuns.has(id);
  }

  /** The workflow run task id that holds an agent. */
  runOfAgent(id: string): string | undefined {
    return this.#agentRuns.get(id);
  }

  label(agentId: string): string | undefined {
    const taskId = this.#agentRuns.get(agentId);
    return taskId === undefined ? undefined : this.#runs.get(taskId)?.agents.get(agentId)?.label;
  }

  /** The run's merged snapshot (for tests and views). */
  snapshot(taskId: string): WorkflowSnapshot | undefined {
    return this.#runs.get(taskId)?.snap;
  }

  /** `task_started` of a `local_workflow` task. */
  taskStarted(msg: WireMessage): void {
    const taskId = str(msg.task_id);
    if (taskId === undefined || this.#runs.has(taskId)) return;
    const run: Run = {
      taskId,
      name: str(msg.workflow_name) ?? str(msg.description) ?? 'workflow',
      started: false,
      ended: false,
      agents: new Map(),
    };
    const label = str(msg.description);
    if (label !== undefined) run.label = label;
    const callId = str(msg.tool_use_id);
    if (callId !== undefined) run.callId = callId;
    this.#runs.set(taskId, run);
  }

  /** The launch result of a Workflow call: `tool_use_result` of a main-thread user frame. */
  static launchInfo(msg: WireMessage): Loose | undefined {
    const r = msg.tool_use_result;
    if (!isObject(r) || r.status !== 'async_launched' || str(r.taskId) === undefined) return undefined;
    if (r.taskType !== undefined && r.taskType !== 'local_workflow') return undefined;
    return r;
  }

  /** The user asked to stop the whole run (`stopTask(run)`): its agents that end now were stopped. */
  noteStopRequested(taskId: string): void {
    const run = this.#runs.get(taskId);
    if (run !== undefined && !run.ended) run.stopping = true;
  }

  /** Emit `workflow-start` (and any snapshot held until now). Call after the call's `tool-result`. */
  launched(info: Loose, callId: string | undefined, at: number, out: BackendEvent[]): void {
    const taskId = str(info.taskId)!;
    let run = this.#runs.get(taskId);
    if (run === undefined) {
      run = { taskId, name: str(info.workflowName) ?? 'workflow', started: false, ended: false, agents: new Map() };
      this.#runs.set(taskId, run);
    }
    if (run.ended) return;
    const name = str(info.workflowName);
    if (name !== undefined) run.name = name;
    const label = str(info.summary);
    if (label !== undefined && run.label === undefined) run.label = label;
    if (callId !== undefined && run.callId === undefined) run.callId = callId;
    const runId = str(info.runId);
    if (runId !== undefined) run.runId = runId;
    const scriptPath = str(info.scriptPath);
    if (scriptPath !== undefined) run.scriptPath = scriptPath;
    const dir = str(info.transcriptDir);
    if (dir !== undefined) {
      run.transcriptDir = dir;
      run.pendingDir = dir;
      this.#openTail(run);
    }
    this.#start(run, at, out);
    if (run.snap !== undefined) this.#publish(run, at, out);
    this.#poll();
  }

  /** `task_progress` of a run. Frames without `workflow_progress` change nothing here (D48). */
  progress(msg: WireMessage, at: number, out: BackendEvent[]): void {
    const taskId = str(msg.task_id);
    const run = taskId === undefined ? undefined : this.#runs.get(taskId);
    if (run === undefined || run.ended) return;
    const frame = parseWorkflowProgress(msg.workflow_progress);
    if (frame === undefined) return;
    run.snap = mergeWorkflowSnapshot(run.snap, frame);
    const usage = taskUsageOf(msg.usage);
    if (usage !== undefined) run.usage = usage;
    this.#syncAgents(run, at); // known at once (a stop of one agent is refused, D48)
    // Held until the launch result names the transcript folder (it comes first in practice).
    if (run.started) this.#publish(run, at, out);
  }

  /** `task_notification` of a run: its agents end, a final snapshot, then `workflow-end`. */
  ended(
    taskId: string,
    status: string | undefined,
    summary: string | undefined,
    usage: TaskUsage | undefined,
    out: BackendEvent[],
  ): void {
    const run = this.#runs.get(taskId);
    if (run === undefined || run.ended) return;
    const stopReason = workflowStopReason(status);
    if (stopReason === 'cancelled') run.stopping = true;
    const at = this.#now();
    if (!run.started) this.#start(run, at, out);
    if (usage !== undefined) run.usage = usage;
    // A last read of every agent's file, and announce the ones not yet announced.
    if (run.snap !== undefined) {
      this.#syncAgents(run, at);
      for (const a of run.agents.values()) this.#readAgent(run, a, at, out, true);
      run.snap = settleWorkflowSnapshot(run.snap, stopReason);
      this.#publish(run, at, out, stopReason);
    }
    for (const a of run.agents.values()) if (a.announced && !a.ended) this.#endAgent(run, a, stopReason, out);
    run.ended = true;
    delete run.tail;
    delete run.pendingDir;
    const e: Extract<BackendEvent, { type: 'workflow-end' }> = { type: 'workflow-end', taskId, stopReason };
    if (summary !== undefined) e.summary = summary;
    if (run.usage !== undefined) e.usage = run.usage;
    out.push(e);
    this.#poll();
  }

  /** The CLI ended: live runs end with it (D74). */
  exit(out: BackendEvent[], reason: string): void {
    for (const run of this.#runs.values()) if (!run.ended) this.ended(run.taskId, 'failed', reason, undefined, out);
    this.dispose();
  }

  dispose(): void {
    if (this.#timer !== undefined) (this.#o.timers ?? nodeTimers).clear(this.#timer);
    this.#timer = undefined;
  }

  /** One live poll (D49). Public for tests; the timer calls it. */
  tick(): BackendEvent[] {
    const out: BackendEvent[] = [];
    const at = this.#now();
    for (const run of this.#runs.values()) {
      if (run.ended || !run.started) continue;
      for (const a of run.agents.values()) {
        const late = a.settledAt !== undefined && at - a.settledAt >= (this.#o.settleGraceMs ?? SETTLE_GRACE_MS);
        this.#readAgent(run, a, at, out, late);
        if (late && a.announced) this.#endAgent(run, a, undefined, out);
      }
    }
    return out;
  }

  // ---- internals ----

  /**
   * D49 guard: read a run's folder only when its real path is under the CLI's `projects` folder.
   * A folder that does not exist yet stays pending (the CLI creates it at the first agent's start);
   * an existing folder outside `projects` is never read.
   */
  #openTail(run: Run): void {
    const dir = run.pendingDir;
    if (dir === undefined || run.tail !== undefined) return;
    const projects = this.#o.projectsDir?.();
    const fs = this.#o.fs ?? nodeTailFs;
    if (projects === undefined) {
      delete run.pendingDir;
      return;
    }
    if (insideFolder(dir, projects, fs)) {
      run.tail = new TranscriptTail(dir, fs);
      delete run.pendingDir;
    } else if (fs.realpath(dir) !== undefined) {
      delete run.pendingDir;
      this.#debug('workflow transcript folder not under the projects folder; not read', { dir, projects });
    }
  }

  #start(run: Run, at: number, out: BackendEvent[]): void {
    if (run.started) return;
    run.started = true;
    const e: Extract<BackendEvent, { type: 'workflow-start' }> = {
      type: 'workflow-start',
      taskId: run.taskId,
      name: run.name,
      at,
    };
    if (run.label !== undefined) e.label = run.label;
    if (run.runId !== undefined) e.runId = run.runId;
    if (run.callId !== undefined) e.callId = run.callId;
    if (run.transcriptDir !== undefined) e.transcriptDir = run.transcriptDir;
    if (run.scriptPath !== undefined) e.scriptPath = run.scriptPath;
    out.push(e);
  }

  /** Snapshot (if changed), new agents, their usage and settled agents. */
  #publish(run: Run, at: number, out: BackendEvent[], stopReason?: 'completed' | 'cancelled' | 'error'): void {
    const snap = run.snap;
    if (snap === undefined) return;
    const key = JSON.stringify(snap);
    if (key !== run.lastSent) {
      run.lastSent = key;
      const e: Extract<BackendEvent, { type: 'workflow-snapshot' }> = {
        type: 'workflow-snapshot',
        taskId: run.taskId,
        phases: snap.phases,
        agents: snap.agents,
        at,
      };
      if (run.usage !== undefined) e.usage = run.usage;
      out.push(e);
    }
    this.#syncAgents(run, at);
    for (const row of snap.agents) {
      if (row.agentId === undefined) continue;
      const a = run.agents.get(row.agentId);
      if (a === undefined || a.ended) continue;
      const settled = row.state === 'done' || row.state === 'error' || row.state === 'stopped';
      this.#readAgent(run, a, at, out, settled);
      if (!a.announced) continue;
      this.#usage(a, row, out);
      if (!settled) continue;
      if (stopReason === undefined && this.#timer !== undefined) a.settledAt ??= at;
      else this.#endAgent(run, a, stopReason, out);
    }
  }

  /** Register the agents a snapshot names for the first time. */
  #syncAgents(run: Run, at: number): void {
    for (const row of run.snap?.agents ?? []) {
      if (row.agentId === undefined || run.agents.has(row.agentId)) continue;
      // A retry with a new id is a new child; a reused id stays the same child.
      run.agents.set(row.agentId, {
        agentId: row.agentId,
        index: row.index,
        label: row.label,
        announced: false,
        ended: false,
        firstSeen: at,
        framing: [],
        framingDone: false,
      });
      this.#agentRuns.set(row.agentId, run.taskId);
    }
  }

  #row(run: Run, a: AgentState): WorkflowAgent | undefined {
    return run.snap?.agents.find((r) => r.agentId === a.agentId) ?? run.snap?.agents.find((r) => r.index === a.index);
  }

  /**
   * Read new lines of an agent's file. Before the agent is announced, its leading user texts are
   * the CLI's framing (its task prompt); the announce happens at the computed-task frame, at the
   * first other chat line, after ANNOUNCE_AFTER_MS, or when `force` (the agent or run settled).
   */
  #readAgent(run: Run, a: AgentState, at: number, out: BackendEvent[], force: boolean): void {
    if (a.ended) return;
    this.#openTail(run);
    const lines = run.tail === undefined ? [] : force ? run.tail.drain(a.agentId) : run.tail.read(a.agentId);
    for (const raw of lines) {
      if (!isObject(raw) || (raw.type !== 'user' && raw.type !== 'assistant')) continue;
      if (!a.announced && !a.framingDone) {
        const text = framingText(raw);
        if (text !== undefined) {
          a.framing.push(text);
          if (text.startsWith(FRAME_COMPUTED_TASK)) {
            a.framingDone = true;
            this.#announce(run, a, at, out);
          }
          continue;
        }
        a.framingDone = true;
      }
      if (!a.announced) this.#announce(run, a, at, out);
      this.#feed(a, raw, at, out);
    }
    if (!a.announced && (force || at - a.firstSeen >= (this.#o.announceAfterMs ?? ANNOUNCE_AFTER_MS)))
      this.#announce(run, a, at, out);
  }

  #announce(run: Run, a: AgentState, at: number, out: BackendEvent[]): void {
    if (a.announced) return;
    a.announced = true;
    const row = this.#row(run, a);
    this.#kids.adopt(a.agentId, a.label);
    const e: Extract<BackendEvent, { type: 'agent-start' }> = {
      type: 'agent-start',
      ref: { kind: 'child', id: a.agentId },
      parent: MAIN,
      label: a.label,
      role: 'workflow-agent',
      background: true,
      // D49: the CLI's own framing texts, as written; else its preview of the prompt.
      taskPrompt: a.framing.length > 0 ? a.framing.join('\n\n') : (row?.promptPreview ?? a.label),
      depth: 1,
      at,
    };
    if (run.callId !== undefined) e.parentCallId = run.callId;
    if (row?.agentType !== undefined) e.agentType = row.agentType;
    out.push(e);
  }

  #feed(a: AgentState, raw: Loose, at: number, out: BackendEvent[]): void {
    const wire: WireMessage = {
      type: raw.type as string,
      message: raw.message,
      parent_tool_use_id: `workflow:${a.agentId}`,
      agent_id: a.agentId,
    };
    const uuid = str(raw.uuid);
    if (uuid !== undefined) wire.uuid = uuid;
    const evs: BackendEvent[] = [];
    if (raw.type === 'assistant') this.#kids.assistant(wire, at, evs);
    else this.#kids.user(wire, at, evs);
    for (const e of evs) if (e.type !== 'agent-start' && e.type !== 'agent-end') out.push(e);
  }

  #usage(a: AgentState, row: WorkflowAgent, out: BackendEvent[]): void {
    const usage: TaskUsage = {};
    if (row.tokens !== undefined) usage.tokens = row.tokens;
    if (row.toolCalls !== undefined) usage.toolUses = row.toolCalls;
    if (row.durationMs !== undefined) usage.durationMs = row.durationMs;
    const key = JSON.stringify(usage);
    if (key === '{}' || key === a.usageKey) return;
    a.usageKey = key;
    out.push({ type: 'task-progress', taskId: a.agentId, usage });
  }

  #endAgent(
    run: Run,
    a: AgentState,
    stopReason: 'completed' | 'cancelled' | 'error' | undefined,
    out: BackendEvent[],
  ): void {
    if (a.ended) return;
    a.ended = true;
    const row = this.#row(run, a);
    if (row !== undefined) this.#usage(a, row, out);
    let status: TaskStatus;
    if (row?.state === 'done') status = 'completed';
    else if (stopReason === 'error') status = 'failed';
    else if (row?.state === 'stopped' || stopReason === 'cancelled' || run.stopping === true) status = 'stopped';
    else status = 'failed';
    const e: Extract<BackendEvent, { type: 'agent-end' }> = {
      type: 'agent-end',
      ref: { kind: 'child', id: a.agentId },
      status,
    };
    const summary = row?.resultPreview ?? row?.error;
    if (summary !== undefined) e.summary = summary;
    out.push(e);
  }

  /** Start or stop the live poll: it runs while a run with a readable folder is live. */
  #poll(): void {
    const live = [...this.#runs.values()].some((r) => !r.ended && (r.tail !== undefined || r.pendingDir !== undefined));
    const timers = this.#o.timers ?? nodeTimers;
    if (live && this.#timer === undefined && this.#o.emit !== undefined) {
      const emit = this.#o.emit;
      this.#timer = timers.set(() => {
        const evs = this.tick();
        if (evs.length > 0) emit(evs);
      }, this.#o.pollMs ?? WORKFLOW_POLL_MS);
    } else if (!live && this.#timer !== undefined) this.dispose();
  }
}
