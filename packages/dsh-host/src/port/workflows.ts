// Native workflow records (D48, D79): the DSH side of ../workflows.ts.
//
// DSH's workflow-run Chat node (`P/dsh-client-ui-workflow-run/lib/client.js:718-760`) folds four
// session events by `runId`: `tool-workflow/run-start {runId, name}`, `agent-start {runId, seq,
// label, phase?, childId}`, `agent-end {runId, seq, outcome}`, `run-end {runId, stopReason}`
// (`P/dsh-tool-workflow/lib/types/types.d.ts:10-32`). They have no v4 relationship rule, pass
// inside a step and outside any turn, and survive reload and fork (dsh-seams R2.4, live). The only
// DSH writer is the model-facing workflow tool's recorder (`P/dsh-tool-workflow/lib/index.js:80-130`),
// which appends them with a plain `session.append`, as we do here. A running member whose `childId`
// is a live local child session opens that child.

import type { OpenWorkflowRun, WorkflowRecord } from '../workflows.js';
import type { DshSession } from './types.js';

export const WORKFLOW_EVENT_TYPES = Object.freeze({
  'run-start': 'tool-workflow/run-start',
  'agent-start': 'tool-workflow/agent-start',
  'agent-end': 'tool-workflow/agent-end',
  'run-end': 'tool-workflow/run-end',
} as const);

/** The event data of one record, exactly the fields DSH's types declare. */
export function workflowEventData(r: WorkflowRecord): Record<string, unknown> {
  switch (r.kind) {
    case 'run-start':
      return { runId: r.runId, name: r.name };
    case 'agent-start': {
      const d: Record<string, unknown> = { runId: r.runId, seq: r.seq, label: r.label };
      if (r.phase !== undefined) d.phase = r.phase;
      d.childId = r.childId;
      return d;
    }
    case 'agent-end':
      return { runId: r.runId, seq: r.seq, outcome: r.outcome };
    case 'run-end':
      return { runId: r.runId, stopReason: r.stopReason };
  }
}

/** Append one record to the session (throws when the session refuses it). */
export function appendWorkflowRecord(session: Pick<DshSession, 'append'>, r: WorkflowRecord): void {
  session.append(WORKFLOW_EVENT_TYPES[r.kind], workflowEventData(r));
}

/** Runs in the log with a `run-start` and no `run-end`, with their members that have no end. */
export function openWorkflowRuns(session: Pick<DshSession, 'snapshotEvents'>): OpenWorkflowRun[] {
  const runs = new Map<string, Set<number>>();
  for (const e of session.snapshotEvents()) {
    const runId = typeof e.data?.runId === 'string' ? e.data.runId : undefined;
    if (runId === undefined) continue;
    const seq = typeof e.data.seq === 'number' ? e.data.seq : undefined;
    switch (e.type) {
      case WORKFLOW_EVENT_TYPES['run-start']:
        runs.set(runId, new Set());
        break;
      case WORKFLOW_EVENT_TYPES['agent-start']:
        if (seq !== undefined) runs.get(runId)?.add(seq);
        break;
      case WORKFLOW_EVENT_TYPES['agent-end']:
        if (seq !== undefined) runs.get(runId)?.delete(seq);
        break;
      case WORKFLOW_EVENT_TYPES['run-end']:
        runs.delete(runId);
        break;
    }
  }
  return [...runs].map(([runId, seqs]) => ({ runId, openSeqs: [...seqs] }));
}
