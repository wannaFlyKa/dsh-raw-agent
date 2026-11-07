// R6.5, D48, D49: the plugin's workflow view. One card per dynamic workflow run: its phases, each
// agent with status, tokens, tool calls, run time and latest output, Open (the agent's child
// session), the per-agent Stop where the agent offers one, and "Stop entire workflow". DSH's own
// workflow-run node (drawn from the native `tool-workflow/*` records) stays as it is: this card adds
// what that node lacks (numbers, output, controls). The same card shows in the chat (our
// `conversation.chat.node`) and in the agents panel's Workflows tab.

import * as React from 'react';
import type { SessionInfo, WorkflowAgentWire, WorkflowWire } from '../api.js';
import type { SessionControlStore, SessionSnapshot } from '../session-store.js';
import {
  findWorkflow,
  isLiveWorkflow,
  workflowAgentAddress,
  workflowAgentChild,
  workflowAgentDot,
  workflowAgentLast,
  workflowAgentStats,
  workflowAgentStatusText,
  workflowPhases,
  workflowStatusText,
  workflowSummaryLine,
} from '../workflow-model.js';
import type { HostActions } from './actions.js';
import { css } from './style.js';

const muted = 'var(--raw-agent-muted, var(--dsw-alias-label-secondary, GrayText))';
const border = 'var(--raw-agent-border, var(--dsw-alias-border-l2, rgba(128,128,128,0.35)))';

const styles = {
  card: { display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 0' },
  head: { display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' },
  name: { fontWeight: 600, wordBreak: 'break-word' },
  meta: { fontSize: 11, color: muted },
  phase: { borderTop: `1px solid ${border}`, paddingTop: 4, marginTop: 2 },
  phaseHead: { display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 12 },
  agent: { display: 'flex', flexDirection: 'column', gap: 2, padding: '4px 0 4px 12px' },
  last: {
    fontSize: 12,
    color: muted,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '100%',
  },
  detail: { fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '2px 0' },
} satisfies Record<string, React.CSSProperties>;

const dot = (status: string): React.CSSProperties => ({
  display: 'inline-block',
  width: 8,
  height: 8,
  borderRadius: 4,
  flex: 'none',
  background:
    status === 'running' || status === 'starting'
      ? 'var(--raw-agent-running, var(--dsw-alias-state-business-primary, #3b82f6))'
      : status === 'completed'
        ? 'var(--raw-agent-done, var(--dsw-alias-state-success-primary, #22a06b))'
        : status === 'failed' || status === 'error'
          ? 'var(--raw-agent-danger, var(--dsw-alias-state-error-primary, #c0392b))'
          : muted,
});

/** A clock that ticks once a second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!on) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return on ? now : Date.now();
}

export interface WorkflowAgentRowProps {
  run: WorkflowWire;
  agent: WorkflowAgentWire;
  sessionId: string;
  info: SessionInfo;
  snap: SessionSnapshot;
  store: SessionControlStore;
  actions: HostActions;
  now: number;
}

/** One workflow agent: status, numbers, latest output, details, Open and (where offered) Stop. */
export function WorkflowAgentRow(props: WorkflowAgentRowProps): React.ReactElement {
  const { run, agent: a, info, snap, store, actions, sessionId, now } = props;
  const [details, setDetails] = React.useState(false);
  const children = info.view.children;
  const child = workflowAgentChild(a, children);
  const address = workflowAgentAddress(sessionId, a, children);
  const last = workflowAgentLast(a, child);
  const stats = workflowAgentStats(a, now);
  const canStop = info.view.workflowAgentStop === true && a.state === 'running' && a.agentId !== undefined;
  const stopping = a.agentId !== undefined && (snap.stopping ?? []).includes(a.agentId);
  const err = a.agentId !== undefined && snap.stopError?.id === a.agentId ? snap.stopError.text : undefined;
  const hasDetails = a.promptPreview !== undefined || a.resultPreview !== undefined || a.error !== undefined;
  return (
    <div style={styles.agent} data-raw-agent="workflow-agent" data-agent-index={a.index}>
      <div style={styles.head}>
        <span style={dot(workflowAgentDot(a))} aria-hidden="true" />
        <span style={styles.name}>{a.label}</span>
        <span style={styles.meta}>
          {workflowAgentStatusText(a)}
          {a.attempt !== undefined && a.attempt > 1 ? ` · attempt ${a.attempt}` : ''}
          {a.model ? ` · ${a.model}` : ''}
        </span>
      </div>
      {stats !== '' && <span style={styles.meta}>{stats}</span>}
      {last !== undefined && (
        <span style={styles.last} title={last} data-raw-agent="workflow-agent-last">
          {last}
        </span>
      )}
      {details && (
        <div data-raw-agent="workflow-agent-details">
          {a.promptPreview !== undefined && (
            <div style={styles.detail}>
              <span style={styles.meta}>Task: </span>
              {a.promptPreview}
            </div>
          )}
          {a.resultPreview !== undefined && (
            <div style={styles.detail}>
              <span style={styles.meta}>Result: </span>
              {a.resultPreview}
            </div>
          )}
          {a.error !== undefined && <div style={{ ...styles.detail, ...css.cardError }}>{a.error}</div>}
        </div>
      )}
      <div style={css.row}>
        {address && actions.openChild && (
          <button
            type="button"
            style={css.button}
            data-raw-agent="workflow-agent-open"
            title="Open this agent's session (its full output)"
            onClick={() => actions.openChild?.(address)}
          >
            Open
          </button>
        )}
        {address && actions.openChildAside && (
          <button
            type="button"
            style={css.button}
            title="Open beside this conversation"
            onClick={() => actions.openChildAside?.(address)}
          >
            Open beside
          </button>
        )}
        {hasDetails && (
          <button type="button" style={css.button} onClick={() => setDetails(!details)}>
            {details ? 'Hide details' : 'Details'}
          </button>
        )}
        {canStop && (
          <button
            type="button"
            style={css.button}
            data-raw-agent="workflow-agent-stop"
            disabled={stopping}
            title="Stop this agent only. The rest of the workflow keeps running."
            onClick={() => void store.stopWorkflowAgent(run.taskId, a.agentId!)}
          >
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        )}
      </div>
      {err !== undefined && <span style={css.cardError}>{err}</span>}
    </div>
  );
}

export interface WorkflowRunCardProps {
  run: WorkflowWire;
  sessionId: string;
  info: SessionInfo;
  snap: SessionSnapshot;
  store: SessionControlStore;
  actions: HostActions;
  now: number;
}

/** One run: name, status, numbers, "Stop entire workflow", then its phases and agents. */
export function WorkflowRunCard(props: WorkflowRunCardProps): React.ReactElement {
  const { run, info, snap, store, now } = props;
  const live = isLiveWorkflow(run);
  const stopping = run.stopping === true || (snap.stopping ?? []).includes(run.taskId);
  const err = snap.stopError?.id === run.taskId ? snap.stopError.text : undefined;
  const name = info.backend.displayName;
  const groups = workflowPhases(run);
  return (
    <div style={styles.card} data-raw-agent="workflow-run" data-run-id={run.runId} data-task-id={run.taskId}>
      <div style={styles.head}>
        <span
          style={dot(live ? 'running' : run.status === 'completed' ? 'completed' : run.status)}
          aria-hidden="true"
        />
        <span style={styles.name}>{run.name}</span>
        <span style={styles.meta} data-raw-agent="workflow-status">
          Workflow · {workflowStatusText(run)}
        </span>
      </div>
      {run.label !== undefined && run.label !== run.name && <span style={styles.meta}>{run.label}</span>}
      <span style={styles.meta} data-raw-agent="workflow-summary">
        {workflowSummaryLine(run, now)}
      </span>
      {live && (
        <div style={css.row}>
          <button
            type="button"
            style={css.button}
            data-raw-agent="workflow-stop"
            disabled={stopping}
            title={`Stop every agent of this workflow. ${name} and the conversation keep running.`}
            onClick={() => void store.stopWorkflow(run.taskId)}
          >
            {stopping ? 'Stopping…' : 'Stop entire workflow'}
          </button>
          {info.view.workflowAgentStop !== true && (
            <span style={styles.meta} data-raw-agent="workflow-no-agent-stop">
              {name} cannot stop one agent of a workflow; stop the whole workflow instead.
            </span>
          )}
        </div>
      )}
      {err !== undefined && <span style={css.cardError}>{err}</span>}
      {!live && run.summary !== undefined && <span style={styles.meta}>{run.summary}</span>}
      {groups.map((g) => (
        <div key={`${g.index ?? 'x'}-${g.title}`} style={styles.phase} data-raw-agent="workflow-phase">
          <div style={styles.phaseHead}>
            <span style={styles.name}>{g.title}</span>
            <span style={styles.meta}>{g.status}</span>
          </div>
          {g.agents.map((a) => (
            <WorkflowAgentRow key={`${a.index}-${a.attempt ?? 1}`} {...props} agent={a} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Every run of the session, newest first (the agents panel's Workflows tab). */
export function WorkflowRuns(props: {
  store: SessionControlStore;
  snap: SessionSnapshot;
  info: SessionInfo;
  actions: HostActions;
}): React.ReactElement {
  const { store, snap, info, actions } = props;
  const runs = [...(info.view.workflows ?? [])].sort((a, b) => b.startedAt - a.startedAt);
  const now = useNow(runs.some(isLiveWorkflow));
  if (runs.length === 0) return <div style={styles.meta}>No workflows in this session yet.</div>;
  return (
    <div data-raw-agent="workflow-runs">
      {runs.map((run) => (
        <WorkflowRunCard
          key={run.taskId}
          run={run}
          sessionId={store.sessionId}
          info={info}
          snap={snap}
          store={store}
          actions={actions}
          now={now}
        />
      ))}
    </div>
  );
}

export interface WorkflowNodeViewProps {
  sessionId: string;
  /** The native record's run id (`tool-workflow/run-start`). */
  runId: string;
  stores: { get(sessionId: string): SessionControlStore };
  actions: HostActions;
}

/**
 * The chat node beside DSH's own workflow-run node. It shows the live run of this session's
 * process; a run this process does not know (an earlier process, another DSH run) shows nothing,
 * and DSH's node alone tells its outcome.
 */
export function WorkflowNodeView(props: WorkflowNodeViewProps): React.ReactElement | null {
  const store = props.stores.get(props.sessionId);
  const snap = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const info = snap.info;
  const run = findWorkflow(info?.view, props.runId);
  const now = useNow(run !== undefined && isLiveWorkflow(run));
  if (snap.status !== 'ready' || !info || !run) return null;
  return (
    // Leftover M4: the chat card grows with its rows (no inner scroll box that cut off agent rows).
    <div
      style={{ ...css.card, padding: '4px 10px', maxHeight: 'none', overflow: 'visible' }}
      data-raw-agent="workflow-node"
    >
      <WorkflowRunCard
        run={run}
        sessionId={props.sessionId}
        info={info}
        snap={snap}
        store={store}
        actions={props.actions}
        now={now}
      />
    </div>
  );
}
