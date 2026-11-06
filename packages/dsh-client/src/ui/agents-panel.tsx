// R6.1-R6.3: the agents panel. A header button in our sessions opens one panel with three tabs:
// the child agent tree (status, tokens, tool uses, latest output, per-child Stop, open the child
// session, the child's waiting ask), the team roster (teammates, messages between them, open a
// teammate's transcript) and the background task list. DSH's own subagent catalog in the header
// stays: it navigates; this panel adds what it lacks (D46, D50, dsh-ui-surfaces §4).

import * as React from 'react';
import {
  agentCounts,
  agentsButtonText,
  asksForChild,
  childAddress,
  childLastLine,
  childRoleText,
  childStats,
  childStatusText,
  childTree,
  isRunning,
  rosterModel,
  taskStatusText,
  wakeText,
  type RosterModel,
} from '../agents-model.js';
import type { AskWire, ChildWire, SessionInfo, TaskWire } from '../api.js';
import { TaskOutputReader, type TaskOutputSnapshot } from '../task-output.js';
import type { ChildLinkStore } from '../child-links.js';
import type { SessionControlStore, SessionSnapshot } from '../session-store.js';
import type { HostActions } from './actions.js';
import { AskPanel } from './ask-cards.js';
import { css } from './style.js';
import { WorkflowRuns } from './workflow-panel.js';
import { hasTaskOutput, outputCutNote, plainTaskOutput } from '../workflow-model.js';

const muted = 'var(--raw-agent-muted, var(--dsw-alias-text-secondary, GrayText))';
const border = 'var(--raw-agent-border, var(--dsw-alias-border-default, rgba(128,128,128,0.35)))';
const warn = 'var(--raw-agent-ask-border, var(--dsw-alias-border-warning, orange))';

const styles = {
  popover: {
    position: 'fixed',
    top: 56,
    right: 16,
    zIndex: 1000,
    width: 'min(560px, 94vw)',
    maxHeight: '76vh',
    overflow: 'auto',
    boxShadow: '0 6px 24px rgba(0,0,0,0.25)',
  },
  tabs: { display: 'flex', gap: 4, borderBottom: `1px solid ${border}`, paddingBottom: 6 },
  tab: { fontWeight: 600 },
  row: { display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 0', borderTop: `1px solid ${border}` },
  rowHead: { display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' },
  label: { fontWeight: 600, wordBreak: 'break-word' },
  meta: { fontSize: 11, color: muted },
  last: {
    fontSize: 12,
    color: muted,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '100%',
  },
  waiting: { fontSize: 11, color: warn, fontWeight: 600 },
  message: { fontSize: 12, padding: '4px 0', borderTop: `1px solid ${border}`, wordBreak: 'break-word' },
} satisfies Record<string, React.CSSProperties>;

const dot = (status: string): React.CSSProperties => ({
  display: 'inline-block',
  width: 8,
  height: 8,
  borderRadius: 4,
  flex: 'none',
  background:
    status === 'running' || status === 'starting'
      ? 'var(--raw-agent-running, var(--dsw-alias-text-accent, #3b82f6))'
      : status === 'completed'
        ? 'var(--raw-agent-done, var(--dsw-alias-text-success, #22a06b))'
        : status === 'failed'
          ? 'var(--raw-agent-danger, var(--dsw-alias-text-danger, #c0392b))'
          : muted,
});

/** A clock that ticks once a second while `on` (running rows show their time). */
function useNow(on: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!on) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return on ? now : Date.now();
}

/** D77: mark the parent's `Agent` tool card while one of its children waits for the user. */
function useWaitingMarks(children: readonly ChildWire[], asks: readonly AskWire[], actions: HostActions): void {
  const calls = children
    .filter((c) => c.callId !== undefined && asksForChild(asks, c.id).length > 0)
    .map((c) => `${c.callId}\u0000${c.name ?? c.label}`)
    .join('\u0001');
  React.useEffect(() => {
    if (calls === '' || !actions.markToolCall) return undefined;
    const marks = calls.split('\u0001').map((entry) => {
      const [callId, label] = entry.split('\u0000') as [string, string];
      const text = `Subagent “${label}” is waiting for your approval`;
      return { callId, text, mark: actions.markToolCall!(callId, text) };
    });
    // DSH may draw the card later: look again.
    const timer = setInterval(() => {
      for (const m of marks) {
        if (m.mark.found) continue;
        m.mark.undo();
        m.mark = actions.markToolCall!(m.callId, m.text);
      }
    }, 1000);
    return () => {
      clearInterval(timer);
      for (const m of marks) m.mark.undo();
    };
  }, [calls, actions]);
}

/**
 * D48: a workflow agent has its own Stop only where the agent can stop one agent of a workflow
 * (Claude Code cannot: the run's "Stop entire workflow" is the way). Other children always can.
 */
export function canStopChild(c: ChildWire, info: SessionInfo): boolean {
  return isRunning(c) && (c.role !== 'workflow-agent' || info.view.workflowAgentStop === true);
}

export interface ChildRowProps {
  child: ChildWire;
  level: number;
  sessionId: string;
  info: SessionInfo;
  snap: SessionSnapshot;
  store: SessionControlStore;
  actions: HostActions;
  now: number;
  /** Show the Open buttons (not in the child's own view). */
  open?: boolean;
}

/** One child agent: status, numbers, latest output, its waiting ask, Open and Stop (R6.1, D46). */
export function ChildRow(props: ChildRowProps): React.ReactElement {
  const { child: c, info, snap, store, actions, sessionId } = props;
  const [showAsk, setShowAsk] = React.useState(false);
  const children = info.view.children ?? [];
  const asks = asksForChild(info.view.asks, c.id);
  const address = childAddress(sessionId, children, c);
  const last = childLastLine(c);
  const stats = childStats(c, props.now);
  const stopping = (snap.stopping ?? []).includes(c.id) || c.stopping === true;
  const err = snap.stopError?.id === c.id ? snap.stopError.text : undefined;
  return (
    <div style={{ ...styles.row, paddingLeft: props.level * 16 }} data-raw-agent="child-row" data-child-id={c.id}>
      <div style={styles.rowHead}>
        <span style={dot(c.status)} aria-hidden="true" />
        <span style={styles.label}>{c.name ?? c.label}</span>
        <span style={styles.meta}>
          {childRoleText(c)} · {childStatusText(c)}
        </span>
        {asks.length > 0 && (
          <span style={styles.waiting} data-raw-agent="child-waiting">
            Waiting for your approval
          </span>
        )}
      </div>
      {c.name !== undefined && c.label !== c.name && <span style={styles.meta}>{c.label}</span>}
      {stats !== '' && <span style={styles.meta}>{stats}</span>}
      {last !== undefined && (
        <span style={styles.last} title={last} data-raw-agent="child-last">
          {last}
        </span>
      )}
      {c.summary !== undefined && !isRunning(c) && c.summary !== last && <span style={styles.meta}>{c.summary}</span>}
      {c.noSession === true && (
        <span style={styles.meta}>
          The host could not make a child session for this agent, so its steps are not shown.
        </span>
      )}
      <div style={css.row}>
        {props.open !== false && address && actions.openChild && (
          <button type="button" style={css.button} onClick={() => actions.openChild?.(address)}>
            Open
          </button>
        )}
        {props.open !== false && address && actions.openChildAside && (
          <button
            type="button"
            style={css.button}
            title="Open beside this conversation"
            onClick={() => actions.openChildAside?.(address)}
          >
            Open beside
          </button>
        )}
        {asks.length > 0 && (
          <button type="button" style={css.button} data-raw-agent="child-show-ask" onClick={() => setShowAsk(!showAsk)}>
            {showAsk ? 'Hide the question' : 'Answer'}
          </button>
        )}
        {canStopChild(c, info) && (
          <button
            type="button"
            style={css.button}
            data-raw-agent="child-stop"
            disabled={stopping}
            title="Stop this agent only. The others and the main conversation keep running."
            onClick={() => void store.stopChild(c.id)}
          >
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        )}
      </div>
      {isRunning(c) && !canStopChild(c, info) && (
        <span style={styles.meta} data-raw-agent="child-no-stop">
          {info.backend.displayName} cannot stop one agent of a workflow. Use “Stop entire workflow” in the Workflows
          tab or in the chat.
        </span>
      )}
      {err !== undefined && <span style={css.cardError}>{err}</span>}
      {showAsk && asks.length > 0 && (
        <AskPanel store={store} actions={actions} askId={asks[0]!.id} only={(a) => a.agentId === c.id} />
      )}
    </div>
  );
}

/**
 * R6.2: the end of one background shell's or monitor's output, read from the Host while the view is
 * open: again every 2 s while the task runs, once more when it ends. Shown as plain text.
 */
export function TaskOutputView(props: {
  task: TaskWire;
  store: SessionControlStore;
  pollMs?: number;
}): React.ReactElement {
  const { task, store, pollMs } = props;
  const reader = React.useMemo(
    () => new TaskOutputReader(() => store.taskOutput(task.taskId), undefined, pollMs),
    [store, task.taskId, pollMs],
  );
  React.useEffect(() => () => reader.dispose(), [reader]);
  const running = task.status === 'running';
  React.useEffect(() => reader.setRunning(running), [reader, running]);
  const snap = React.useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  return <TaskOutputBody snap={snap} running={running} onRefresh={() => void reader.refresh()} />;
}

/** The output view's body (no reads of its own). */
export function TaskOutputBody(props: {
  snap: TaskOutputSnapshot;
  running: boolean;
  onRefresh?: () => void;
}): React.ReactElement {
  const { snap, running } = props;
  const out = snap.output;
  const text = out ? plainTaskOutput(out.output) : undefined;
  const cut = out ? outputCutNote(out) : undefined;
  return (
    <div data-raw-agent="task-output" style={css.choiceCol}>
      {cut !== undefined && <span style={styles.meta}>{cut}</span>}
      {text !== undefined && (
        <pre style={{ ...css.pre, maxHeight: 260, overflow: 'auto' }} data-raw-agent="task-output-text">
          {text === '' ? (running ? 'No output yet.' : 'No output.') : text}
        </pre>
      )}
      {text === undefined && snap.error === undefined && <span style={styles.meta}>Reading the output…</span>}
      {snap.error !== undefined && <span style={css.cardError}>{snap.error}</span>}
      <div style={css.row}>
        <span style={styles.meta}>{running ? 'Updates while the task runs.' : 'The task has ended.'}</span>
        {!running && props.onRefresh && (
          <button type="button" style={css.button} disabled={snap.reading} onClick={props.onRefresh}>
            Read again
          </button>
        )}
      </div>
    </div>
  );
}

function TaskRow(props: { task: TaskWire; snap: SessionSnapshot; store: SessionControlStore }): React.ReactElement {
  const { task: t, snap, store } = props;
  const [showOutput, setShowOutput] = React.useState(false);
  const stopping = (snap.stopping ?? []).includes(t.taskId);
  const err = snap.stopError?.id === t.taskId ? snap.stopError.text : undefined;
  const output = hasTaskOutput(t);
  return (
    <div style={styles.row} data-raw-agent="task-row" data-task-id={t.taskId}>
      <div style={styles.rowHead}>
        <span style={dot(t.status)} aria-hidden="true" />
        <span style={styles.label}>{t.label}</span>
        <span style={styles.meta}>
          {t.kind} · {taskStatusText(t)}
          {t.job ? ' · in the job list' : ''}
        </span>
      </div>
      {t.progress !== undefined && <span style={styles.last}>{t.progress}</span>}
      {t.note !== undefined && <span style={styles.meta}>{t.note}</span>}
      {(t.status === 'running' || output) && (
        <div style={css.row}>
          {output && (
            <button
              type="button"
              style={css.button}
              data-raw-agent="task-output-toggle"
              aria-expanded={showOutput}
              onClick={() => setShowOutput(!showOutput)}
            >
              {showOutput ? 'Hide output' : 'Show output'}
            </button>
          )}
          {t.status === 'running' && (
            <button
              type="button"
              style={css.button}
              data-raw-agent="task-stop"
              disabled={stopping}
              onClick={() => void store.stopTask(t.taskId)}
            >
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          )}
        </div>
      )}
      {err !== undefined && <span style={css.cardError}>{err}</span>}
      {showOutput && output && <TaskOutputView task={t} store={store} />}
    </div>
  );
}

/** R6.3, D50: teammates by team, the messages between agents, open a teammate's transcript. */
export function TeamRoster(props: {
  roster: RosterModel;
  info: SessionInfo;
  sessionId: string;
  actions: HostActions;
}): React.ReactElement {
  const { roster, info, sessionId, actions } = props;
  const children = info.view.children ?? [];
  return (
    <div data-raw-agent="team-roster" style={css.choiceCol}>
      {roster.teams.map((t) => (
        <div key={t.name}>
          <div style={styles.label}>{t.name}</div>
          {t.members.map((m) => {
            const address = childAddress(sessionId, children, m);
            const woken = wakeText(m);
            return (
              <div key={m.id} style={styles.row} data-raw-agent="team-member" data-child-id={m.id}>
                <div style={styles.rowHead}>
                  <span style={dot(m.status)} aria-hidden="true" />
                  <span style={styles.label}>{m.name ?? m.label}</span>
                  <span style={styles.meta}>
                    {childStatusText(m)}
                    {woken ? ` · ${woken}` : ''}
                  </span>
                </div>
                {address && actions.openChild && (
                  <div style={css.row}>
                    <button type="button" style={css.button} onClick={() => actions.openChild?.(address)}>
                      Open transcript
                    </button>
                    {actions.openChildAside && (
                      <button type="button" style={css.button} onClick={() => actions.openChildAside?.(address)}>
                        Open beside
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
      <div>
        <div style={styles.label}>Messages</div>
        {roster.messages.length === 0 && <div style={styles.meta}>No messages between agents yet.</div>}
        {roster.messages.map((m, i) => (
          <div key={`${m.at}-${i}`} style={styles.message} data-raw-agent="team-message">
            <div style={styles.meta}>
              {m.from} → {m.to}
              {m.summary ? ` · ${m.summary}` : ''}
            </div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
          </div>
        ))}
      </div>
      <div style={css.choiceCol}>
        <textarea
          style={css.textarea}
          disabled={!roster.messaging}
          placeholder="Message a teammate"
          aria-label="Message a teammate"
          data-raw-agent="team-message-box"
        />
        {roster.messagingNote !== undefined && <span style={styles.meta}>{roster.messagingNote}</span>}
      </div>
    </div>
  );
}

type Tab = 'agents' | 'team' | 'workflows' | 'tasks';

/** The panel body: tabs for agents, the team and background tasks. */
export function AgentsPanel(props: {
  store: SessionControlStore;
  actions: HostActions;
  onClose?: () => void;
  initialTab?: Tab;
}): React.ReactElement | null {
  const { store, actions } = props;
  const snap = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const info = snap.info;
  const children = info?.view.children ?? [];
  const now = useNow(children.some(isRunning));
  const [tab, setTab] = React.useState<Tab>(props.initialTab ?? 'agents');
  if (!info) return null;
  const roster = rosterModel(info.view, info.backend.displayName);
  const tasks = info.view.tasks ?? [];
  const tabs: Array<[Tab, string]> = [['agents', `Agents (${children.length})`]];
  if (roster) tabs.push(['team', 'Team']);
  const runs = info.view.workflows ?? [];
  if (runs.length > 0) tabs.push(['workflows', `Workflows (${runs.length})`]);
  if (tasks.length > 0) tabs.push(['tasks', `Background tasks (${tasks.length})`]);
  const shown = tabs.some(([t]) => t === tab) ? tab : 'agents';
  return (
    <div style={{ ...css.card, ...styles.popover }} data-raw-agent="agents-panel" role="dialog" aria-label="Agents">
      <div style={css.header}>
        <div style={styles.tabs} role="tablist">
          {tabs.map(([t, label]) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={shown === t}
              style={shown === t ? { ...css.button, ...styles.tab } : css.button}
              data-raw-agent={`agents-tab-${t}`}
              onClick={() => setTab(t)}
            >
              {label}
            </button>
          ))}
        </div>
        {props.onClose && (
          <button type="button" style={css.button} onClick={props.onClose} aria-label="Close">
            Close
          </button>
        )}
      </div>
      {shown === 'agents' &&
        (children.length === 0 ? (
          <div style={styles.meta}>No subagents in this session yet.</div>
        ) : (
          childTree(children).map((r) => (
            <ChildRow
              key={r.child.id}
              child={r.child}
              level={r.level}
              sessionId={store.sessionId}
              info={info}
              snap={snap}
              store={store}
              actions={actions}
              now={now}
            />
          ))
        ))}
      {shown === 'team' && roster && (
        <TeamRoster roster={roster} info={info} sessionId={store.sessionId} actions={actions} />
      )}
      {shown === 'workflows' && <WorkflowRuns store={store} snap={snap} info={info} actions={actions} />}
      {shown === 'tasks' && tasks.map((t) => <TaskRow key={t.taskId} task={t} snap={snap} store={store} />)}
    </div>
  );
}

export interface AgentsHeaderProps {
  sessionId: string;
  stores: { get(sessionId: string): SessionControlStore };
  links: { get(sessionId: string): ChildLinkStore };
  actions: HostActions;
}

/**
 * The header action of every session: in our sessions, the "Agents" button (only when there is
 * something to show); in a host child session of ours, the child's own strip (ChildStrip).
 */
export function AgentsHeader(props: AgentsHeaderProps): React.ReactElement | null {
  const store = props.stores.get(props.sessionId);
  const snap = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  if (snap.status === 'absent') return <ChildStrip {...props} />;
  if (snap.status !== 'ready' || !snap.info) return null;
  return <AgentsButton store={store} actions={props.actions} />;
}

export function AgentsButton(props: { store: SessionControlStore; actions: HostActions }): React.ReactElement | null {
  const { store, actions } = props;
  const snap = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [open, setOpen] = React.useState(false);
  const info = snap.info;
  useWaitingMarks(info?.view.children ?? [], info?.view.asks ?? [], actions);
  if (!info) return null;
  const counts = agentCounts(info.view);
  if (counts.children === 0 && counts.tasks === 0 && !info.view.team) return null;
  return (
    <>
      <button
        type="button"
        style={counts.waiting > 0 ? { ...css.button, borderColor: warn } : css.button}
        data-raw-agent="agents-button"
        aria-expanded={open}
        title="Subagents, teammates and background tasks of this session"
        onClick={() => setOpen(!open)}
      >
        {agentsButtonText(counts)}
      </button>
      {open && actions.portal(<AgentsPanel store={store} actions={actions} onClose={() => setOpen(false)} />)}
    </>
  );
}

/**
 * The header of a host child session of ours (R6.1): the child's status and numbers, its Stop, and
 * the ask it waits on, named after it ("approvals inside a child shown on that child", D77).
 */
export function ChildStrip(props: AgentsHeaderProps): React.ReactElement | null {
  const link = props.links.get(props.sessionId);
  const l = React.useSyncExternalStore(link.subscribe, link.getSnapshot, link.getSnapshot);
  if (l.status !== 'found' || !l.link) return null;
  return <ChildStripBody {...props} parentSession={l.link.parentSession} childId={l.link.childId} />;
}

function ChildStripBody(
  props: AgentsHeaderProps & { parentSession: string; childId: string },
): React.ReactElement | null {
  const store = props.stores.get(props.parentSession);
  const snap = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [open, setOpen] = React.useState(false);
  const info = snap.info;
  const child = info?.view.children?.find((c) => c.id === props.childId);
  const now = useNow(child !== undefined && isRunning(child));
  if (!info || !child) return null;
  const asks = asksForChild(info.view.asks, child.id);
  const stopping = (snap.stopping ?? []).includes(child.id) || child.stopping === true;
  return (
    <>
      <button
        type="button"
        style={asks.length > 0 ? { ...css.button, borderColor: warn } : css.button}
        data-raw-agent="child-strip"
        aria-expanded={open}
        title={childRoleText(child)}
        onClick={() => setOpen(!open)}
      >
        {childStatusText(child)}
        {asks.length > 0 ? ' · waiting for your approval' : ''}
      </button>
      {canStopChild(child, info) && (
        <button
          type="button"
          style={css.button}
          data-raw-agent="child-strip-stop"
          disabled={stopping}
          title="Stop this agent only. The others and the main conversation keep running."
          onClick={() => void store.stopChild(child.id)}
        >
          {stopping ? 'Stopping…' : 'Stop'}
        </button>
      )}
      {open &&
        props.actions.portal(
          <div style={{ ...css.card, ...styles.popover }} data-raw-agent="child-panel" role="dialog">
            <div style={css.header}>
              <span style={styles.label}>{child.name ?? child.label}</span>
              <button type="button" style={css.button} onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
            <ChildRow
              child={child}
              level={0}
              sessionId={props.parentSession}
              info={info}
              snap={snap}
              store={store}
              actions={props.actions}
              now={now}
              open={false}
            />
          </div>,
        )}
    </>
  );
}
