// Workflow snapshot merge (D48). Pure; no DSH or SDK imports.
//
// Every progress frame of a workflow run carries the full list of phases and agents, so a frame
// replaces the last one. The merge only guards against going backwards:
// - rows are keyed by `index` (one per agent call of the run);
// - an older attempt never replaces a newer one;
// - a settled row (done, error, stopped) never goes back to running or queued in the same
//   attempt; a higher attempt (a retry) replaces it;
// - a row missing from a frame is kept (frames are full lists, so this should not happen);
// - an empty phase list keeps the previous phases.

import type { WorkflowAgent, WorkflowAgentState, WorkflowPhase } from './events.js';

export interface WorkflowSnapshot {
  phases: WorkflowPhase[];
  agents: WorkflowAgent[];
}

export function isSettledWorkflowAgent(state: WorkflowAgentState): boolean {
  return state === 'done' || state === 'error' || state === 'stopped';
}

function mergeAgent(prev: WorkflowAgent, next: WorkflowAgent): WorkflowAgent {
  const prevAttempt = prev.attempt ?? 1;
  const nextAttempt = next.attempt ?? prevAttempt;
  if (nextAttempt < prevAttempt) return prev;
  if (nextAttempt === prevAttempt && isSettledWorkflowAgent(prev.state) && !isSettledWorkflowAgent(next.state)) {
    // Keep the settled state; newer facts that do not undo it (tokens, ids) are taken.
    const merged: WorkflowAgent = { ...prev };
    for (const key of ['agentId', 'tokens', 'toolCalls', 'durationMs', 'resultPreview'] as const)
      if (next[key] !== undefined && merged[key] === undefined)
        (merged as unknown as Record<string, unknown>)[key] = next[key];
    return merged;
  }
  // The same agent id stays, even when a frame omits it.
  if (next.agentId === undefined && prev.agentId !== undefined && nextAttempt === prevAttempt)
    return { ...next, agentId: prev.agentId };
  return next;
}

/** Merge one full frame into the previous merged snapshot (D48). */
export function mergeWorkflowSnapshot(prev: WorkflowSnapshot | undefined, next: WorkflowSnapshot): WorkflowSnapshot {
  if (prev === undefined)
    return { phases: [...next.phases], agents: [...next.agents].sort((a, b) => a.index - b.index) };
  const byIndex = new Map<number, WorkflowAgent>();
  for (const a of prev.agents) byIndex.set(a.index, a);
  for (const a of next.agents) {
    const old = byIndex.get(a.index);
    byIndex.set(a.index, old === undefined ? a : mergeAgent(old, a));
  }
  return {
    phases: next.phases.length > 0 ? [...next.phases] : [...prev.phases],
    agents: [...byIndex.values()].sort((a, b) => a.index - b.index),
  };
}

/**
 * The run ended: rows still queued or running get a final state. A completed run settles open
 * rows as 'done' only when they had started; a run that ended in error (a crash, D74) settles
 * started rows as 'error'; everything else open becomes 'stopped'.
 */
export function settleWorkflowSnapshot(
  snap: WorkflowSnapshot,
  stopReason: 'completed' | 'cancelled' | 'error',
): WorkflowSnapshot {
  return {
    phases: snap.phases,
    agents: snap.agents.map((a) => {
      if (isSettledWorkflowAgent(a.state)) return a;
      let state: WorkflowAgentState = 'stopped';
      if (a.state === 'running' && stopReason === 'completed') state = 'done';
      else if (a.state === 'running' && stopReason === 'error') state = 'error';
      return { ...a, state };
    }),
  };
}
