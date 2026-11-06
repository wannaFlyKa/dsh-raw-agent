// Pure view logic for dynamic workflow runs (R6.5, D48, D49) and background task output (R6.2).
// No React, no DSH. The data comes from the Host's `view.workflows` (one row per run, each frame a
// merged snapshot) and the child rows (live output of each workflow agent, D49).

import { childLastLine, formatDuration, formatTokens, type ChildAddress } from './agents-model.js';
import type { ChildWire, SessionViewWire, TaskWire, WorkflowAgentWire, WorkflowWire } from './api.js';

/** The run is still going (its agents may still change). */
export function isLiveWorkflow(run: Pick<WorkflowWire, 'status'>): boolean {
  return run.status === 'starting' || run.status === 'running';
}

const RUN_STATUS: Record<WorkflowWire['status'], string> = {
  starting: 'Starting',
  running: 'Running',
  completed: 'Completed',
  cancelled: 'Stopped',
  error: 'Failed',
};

export function workflowStatusText(run: WorkflowWire): string {
  if (run.stopping === true && isLiveWorkflow(run)) return 'Stopping…';
  return RUN_STATUS[run.status] ?? run.status;
}

export function isRunningAgent(a: Pick<WorkflowAgentWire, 'state'>): boolean {
  return a.state === 'running';
}

export function isSettledAgent(a: Pick<WorkflowAgentWire, 'state'>): boolean {
  return a.state === 'done' || a.state === 'error' || a.state === 'stopped';
}

/** One agent's state in words. A refused or cached agent says so. */
export function workflowAgentStatusText(a: WorkflowAgentWire): string {
  switch (a.state) {
    case 'queued':
      return a.blocked === true ? 'Blocked' : 'Queued';
    case 'running':
      return 'Running';
    case 'done':
      return a.cached === true ? 'Done (cached)' : 'Done';
    case 'error':
      return a.blocked === true ? 'Blocked' : 'Failed';
    case 'stopped':
      return 'Stopped';
    default:
      return a.rawState ?? String(a.state);
  }
}

/** The child-row status word the status dot understands. */
export function workflowAgentDot(a: WorkflowAgentWire): string {
  if (a.state === 'running') return 'running';
  if (a.state === 'done') return 'completed';
  if (a.state === 'error') return 'failed';
  if (a.state === 'stopped') return 'stopped';
  return 'queued';
}

/**
 * How long one agent has run. A running agent counts from its start (never less than the time the
 * agent itself reports, which lags); a settled one shows the agent's own run time.
 */
export function workflowAgentRunMs(a: WorkflowAgentWire, now: number): number | undefined {
  if (a.state === 'running' && a.startedAt !== undefined) return Math.max(a.durationMs ?? 0, now - a.startedAt);
  if (a.durationMs !== undefined) return a.durationMs;
  if (isSettledAgent(a) && a.startedAt !== undefined && a.lastProgressAt !== undefined)
    return Math.max(0, a.lastProgressAt - a.startedAt);
  return undefined;
}

/** "17.3k tokens · 1 tool call · 4 s" (the agent's own numbers, D48). */
export function workflowAgentStats(a: WorkflowAgentWire, now: number): string {
  const parts: string[] = [];
  const tokens = formatTokens(a.tokens);
  if (tokens) parts.push(tokens);
  if (a.toolCalls !== undefined) parts.push(`${a.toolCalls} ${a.toolCalls === 1 ? 'tool call' : 'tool calls'}`);
  const ms = workflowAgentRunMs(a, now);
  const d = formatDuration(ms === undefined ? undefined : Math.max(0, ms));
  if (d) parts.push(d);
  return parts.join(' · ');
}

/** The child row of one workflow agent (its live output, D49), when the Host has one. */
export function workflowAgentChild(
  a: WorkflowAgentWire,
  children: readonly ChildWire[] | undefined,
): ChildWire | undefined {
  if (a.agentId === undefined) return undefined;
  return (children ?? []).find((c) => c.id === a.agentId);
}

/**
 * The agent's latest output, as the row shows it: while it runs, its newest transcript line (D49)
 * or else its last tool; once it settled, its error or its result preview.
 */
export function workflowAgentLast(a: WorkflowAgentWire, child?: ChildWire): string | undefined {
  if (a.state === 'error' && a.error) return a.error;
  if (isSettledAgent(a) && a.resultPreview) return a.resultPreview;
  const live = child ? childLastLine(child) : undefined;
  if (live !== undefined && !isSettledAgent(a)) return live;
  if (a.lastToolName)
    return a.lastToolSummary ? `Calling ${a.lastToolName}: ${a.lastToolSummary}` : `Calling ${a.lastToolName}`;
  return live;
}

/** The DSH address of one agent's child session (opened like any child, D45). */
export function workflowAgentAddress(
  sessionId: string,
  a: WorkflowAgentWire,
  children?: readonly ChildWire[],
): ChildAddress | undefined {
  const childSessionId = a.childSessionId ?? workflowAgentChild(a, children)?.hostSessionId;
  if (childSessionId === undefined) return undefined;
  return { parentSessionId: sessionId, childSessionId, mode: 'one-shot' };
}

export interface WorkflowPhaseGroup {
  /** The phase number, or undefined for agents the run named no phase for. */
  index?: number;
  title: string;
  agents: WorkflowAgentWire[];
  /** "2 of 3 done", "1 running", "waiting". */
  status: string;
}

function phaseStatus(agents: readonly WorkflowAgentWire[]): string {
  if (agents.length === 0) return 'Not started';
  const running = agents.filter(isRunningAgent).length;
  const failed = agents.filter((a) => a.state === 'error').length;
  const done = agents.filter((a) => a.state === 'done').length;
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  parts.push(`${done} of ${agents.length} done`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(' · ');
}

/**
 * The run's agents by phase, in phase order, each phase's agents in their own order. Agents with a
 * phase the run did not declare get their own group; agents with none go last ("Agents").
 */
export function workflowPhases(run: WorkflowWire): WorkflowPhaseGroup[] {
  const phases = [...run.phases].sort((a, b) => a.index - b.index);
  const groups = new Map<string, WorkflowPhaseGroup>();
  const keyOf = (index: number | undefined, title: string | undefined) =>
    index !== undefined ? `i${index}` : title !== undefined ? `t${title}` : 'none';
  for (const p of phases)
    groups.set(keyOf(p.index, undefined), { index: p.index, title: p.title, agents: [], status: '' });
  const agents = [...run.agents].sort((a, b) => a.index - b.index);
  for (const a of agents) {
    let key = keyOf(a.phaseIndex, a.phaseTitle);
    if (a.phaseIndex === undefined && a.phaseTitle !== undefined) {
      const named = phases.find((p) => p.title === a.phaseTitle);
      if (named) key = keyOf(named.index, undefined);
    }
    let g = groups.get(key);
    if (!g) {
      const title = a.phaseTitle ?? (a.phaseIndex !== undefined ? `Phase ${a.phaseIndex}` : 'Agents');
      g = { title, agents: [], status: '' };
      if (a.phaseIndex !== undefined) g.index = a.phaseIndex;
      groups.set(key, g);
    }
    g.agents.push(a);
  }
  const out = [...groups.values()];
  out.sort((a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER));
  for (const g of out) g.status = phaseStatus(g.agents);
  return out;
}

/** The run's total tokens: the agent's own run usage, else the sum of its agents. */
export function workflowTokens(run: WorkflowWire): number | undefined {
  if (run.usage?.tokens !== undefined) return run.usage.tokens;
  const known = run.agents.filter((a) => a.tokens !== undefined);
  return known.length === 0 ? undefined : known.reduce((n, a) => n + (a.tokens ?? 0), 0);
}

/** How long the run has run (never less than the time the agent reports). */
export function workflowRunMs(run: WorkflowWire, now: number): number {
  const end = isLiveWorkflow(run) ? now : (run.endedAt ?? now);
  return Math.max(run.usage?.durationMs ?? 0, end - run.startedAt, 0);
}

/** "2 phases · 3 agents · 1 running · 2 done · 35k tokens · 1 min 4 s". */
export function workflowSummaryLine(run: WorkflowWire, now: number): string {
  const parts: string[] = [];
  if (run.phases.length > 0) parts.push(`${run.phases.length} ${run.phases.length === 1 ? 'phase' : 'phases'}`);
  parts.push(`${run.agents.length} ${run.agents.length === 1 ? 'agent' : 'agents'}`);
  const running = run.agents.filter(isRunningAgent).length;
  if (running > 0) parts.push(`${running} running`);
  const done = run.agents.filter((a) => a.state === 'done').length;
  if (done > 0) parts.push(`${done} done`);
  const failed = run.agents.filter((a) => a.state === 'error').length;
  if (failed > 0) parts.push(`${failed} failed`);
  const tokens = formatTokens(workflowTokens(run));
  if (tokens) parts.push(tokens);
  const d = formatDuration(workflowRunMs(run, now));
  if (d) parts.push(d);
  return parts.join(' · ');
}

/** The run of one native record (`tool-workflow/run-start` `runId`), if this session has it. */
export function findWorkflow(
  view: Pick<SessionViewWire, 'workflows'> | undefined,
  runId: string,
): WorkflowWire | undefined {
  return view?.workflows?.find((w) => w.runId === runId || w.taskId === runId);
}

/** Whether a background task has an output to show (shells and monitors, R6.2). */
export function hasTaskOutput(t: Pick<TaskWire, 'kind'>): boolean {
  return t.kind === 'shell' || t.kind === 'monitor';
}

// CSI (ESC [ … final byte) and OSC (ESC ] … BEL or ESC \) sequences, plus lone two-byte escapes.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/**
 * A command's output as plain text for the output view: terminal escape sequences (colours,
 * cursor moves, titles) removed, carriage-return progress lines reduced to their last state. The
 * text itself is not changed otherwise; it is shown as text, never as markup.
 */
export function plainTaskOutput(text: string): string {
  const noEsc = text.replace(ANSI, '');
  return noEsc
    .split('\n')
    .map((line) => {
      const body = line.endsWith('\r') ? line.slice(0, -1) : line;
      const i = body.lastIndexOf('\r');
      return i >= 0 ? body.slice(i + 1) : body;
    })
    .join('\n');
}

/** "Showing the last 256 KiB of 1.2 MiB." for a cut output, else undefined. */
export function outputCutNote(o: { truncated: boolean; totalBytes: number; output: string }): string | undefined {
  if (!o.truncated) return undefined;
  const size = (n: number) =>
    n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return o.totalBytes > 0
    ? `Showing the end of the output (${size(o.totalBytes)} in all).`
    : 'Showing the end of the output.';
}

/** How often an open output view of a running task reads again. */
export const TASK_OUTPUT_POLL_MS = 2000;
