// The context pill and the usage panel (R8.1-R8.4; D58-D61, D67). The pill sits in DSH's composer
// dock, where DSH's own context ring would be (that ring stays hidden in our sessions, D59). A
// click opens the usage panel: context breakdown, session totals and models, per-turn usage,
// subagent and workflow numbers, plan limits and the account type. Nothing here starts a process
// except the user's own "Start" click (D4); nothing writes the DSH log.

import * as React from 'react';
import type { SessionControlStore } from '../session-store.js';
import {
  contextPill,
  usagePanelModel,
  type ContextBreakdown,
  type ContextPillModel,
  type PillLevel,
  type TokenLine,
  type UsagePanelModel,
} from '../usage-model.js';
import type { UsageReader } from '../usage-reader.js';
import type { HostActions } from './actions.js';
import { css } from './style.js';

const v = (name: string, alias: string, fallback: string) =>
  `var(--raw-agent-${name}, var(--dsw-alias-${alias}, ${fallback}))`;
const muted = v('muted', 'text-secondary', 'GrayText');
const border = v('border', 'border-default', 'rgba(128,128,128,0.35)');

const LEVEL_COLOR: Record<PillLevel, string> = {
  unknown: border,
  ok: border,
  warn: v('context-warn', 'border-warning', '#e0a526'),
  high: v('context-high', 'border-danger', '#d9534f'),
  busy: v('context-busy', 'border-accent', '#4a8fe7'),
};

const styles = {
  pill: {
    ...css.button,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontVariantNumeric: 'tabular-nums',
    borderRadius: 999,
    padding: '1px 8px',
  },
  ring: { flex: 'none' },
  extra: { color: muted },
  popover: {
    position: 'fixed',
    bottom: 96,
    right: 16,
    zIndex: 1000,
    width: 'min(620px, 94vw)',
    maxHeight: '76vh',
    overflow: 'auto',
    boxShadow: '0 6px 24px rgba(0,0,0,0.25)',
  },
  tabs: { display: 'flex', gap: 4, flexWrap: 'wrap' },
  tab: { fontWeight: 600 },
  section: { display: 'flex', flexDirection: 'column', gap: 6 },
  heading: { fontWeight: 600, fontSize: 12 },
  dl: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px 12px', margin: 0, fontSize: 12 },
  dt: { color: muted },
  dd: { margin: 0, fontVariantNumeric: 'tabular-nums' },
  bar: {
    display: 'flex',
    height: 10,
    borderRadius: 5,
    overflow: 'hidden',
    border: `1px solid ${border}`,
  },
  swatch: { display: 'inline-block', width: 10, height: 10, borderRadius: 2, marginRight: 6, flex: 'none' },
  catRow: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 },
  catName: { flex: '1 1 auto', minWidth: 0 },
  num: { fontVariantNumeric: 'tabular-nums', color: muted },
  card: { borderTop: `1px solid ${border}`, paddingTop: 6, display: 'flex', flexDirection: 'column', gap: 2 },
  limitBar: { height: 6, borderRadius: 3, background: border, overflow: 'hidden' },
  note: { ...css.hint, margin: 0 },
} satisfies Record<string, React.CSSProperties>;

/** A small ring like DSH's own context meter, filled to `percent` (none when not reported). */
function Ring(props: { percent?: number; level: PillLevel }): React.ReactElement {
  const r = 5.5;
  const len = 2 * Math.PI * r;
  const p = props.percent === undefined ? 0 : Math.max(0, Math.min(100, props.percent));
  return (
    <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden style={styles.ring}>
      <circle cx="7" cy="7" r={r} fill="none" stroke={border} strokeWidth="2" />
      {props.percent !== undefined && (
        <circle
          cx="7"
          cy="7"
          r={r}
          fill="none"
          stroke={props.level === 'ok' ? 'currentColor' : LEVEL_COLOR[props.level]}
          strokeWidth="2"
          strokeDasharray={`${(len * p) / 100} ${len}`}
          transform="rotate(-90 7 7)"
        />
      )}
    </svg>
  );
}

/** The pill itself, from its model (exported for restyling and tests). */
export function ContextPillView(props: {
  model: ContextPillModel;
  open?: boolean;
  onClick?: () => void;
}): React.ReactElement {
  const { model } = props;
  return (
    <button
      type="button"
      style={{ ...styles.pill, borderColor: LEVEL_COLOR[model.level] }}
      data-raw-agent="context-pill"
      data-level={model.level}
      aria-haspopup="dialog"
      aria-expanded={props.open === true}
      aria-label={model.text}
      title={model.title}
      onClick={props.onClick}
    >
      <Ring level={model.level} {...(model.percent !== undefined ? { percent: model.percent } : {})} />
      <span>{model.text}</span>
      {model.extras.map((e) => (
        <span key={e} style={styles.extra}>
          · {e}
        </span>
      ))}
    </button>
  );
}

export interface ContextPillProps {
  store: SessionControlStore;
  reader: UsageReader;
  actions: HostActions;
}

/** The dock entry: renders nothing outside our sessions (the controls route answers 404 there). */
export function ContextPill(props: ContextPillProps): React.ReactElement | null {
  const { store, reader, actions } = props;
  const snap = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const read = React.useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    if (!open) return undefined;
    reader.setOpen(true);
    return () => reader.setOpen(false);
  }, [open, reader]);
  const info = snap.info;
  if (snap.status !== 'ready' || !info) return null;
  const model = contextPill(info, read.context?.context);
  return (
    <>
      <ContextPillView model={model} open={open} onClick={() => setOpen(!open)} />
      {open &&
        actions.portal(
          <UsagePanel
            model={usagePanelModel(info, read.usage, read.context?.context)}
            reading={read.reading}
            {...(read.error !== undefined ? { error: read.error } : {})}
            busy={snap.busy}
            onStart={() => void store.start()}
            onRefresh={() => void reader.read({ usage: true, context: 'full' })}
            onClose={() => setOpen(false)}
          />,
        )}
    </>
  );
}

function Lines(props: { lines: readonly TokenLine[] }): React.ReactElement {
  return (
    <dl style={styles.dl}>
      {props.lines.map((l) => (
        <React.Fragment key={l.label}>
          <dt style={styles.dt}>{l.label}</dt>
          <dd style={styles.dd}>{l.value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

/** The context section: the agent's categories as one bar and a list, like its own `/context`. */
export function ContextSection(props: { breakdown: ContextBreakdown }): React.ReactElement {
  const b = props.breakdown;
  const color = (key: string, c: string) => `var(--raw-agent-context-${key.replace(/[^\w-]/g, '_')}, ${c})`;
  return (
    <div style={styles.section} data-raw-agent="usage-context">
      <div style={styles.heading}>
        {b.head}
        {b.model ? ` · ${b.model}` : ''}
      </div>
      {b.rows.length > 0 && (
        <div style={styles.bar} aria-hidden>
          {b.rows
            .filter((r) => r.kind !== 'free' && r.percent > 0)
            .map((r) => (
              <span
                key={r.key}
                title={`${r.name}: ${r.tokens}`}
                style={{
                  width: `${r.percent}%`,
                  background: color(r.key, r.color),
                  opacity: r.kind === 'buffer' ? 0.45 : 1,
                }}
              />
            ))}
        </div>
      )}
      {b.rows.map((r) => (
        <div key={r.key} style={styles.catRow} data-raw-agent="usage-context-row" data-kind={r.kind}>
          <span
            style={{
              ...styles.swatch,
              background: color(r.key, r.color),
              border: r.kind === 'free' ? `1px solid ${border}` : 'none',
              opacity: r.kind === 'buffer' ? 0.45 : 1,
            }}
          />
          <span style={styles.catName}>{r.name}</span>
          <span style={styles.num}>
            {r.tokens.toLocaleString('en-US')} ({r.percent < 10 ? r.percent.toFixed(1) : Math.round(r.percent)}%)
          </span>
        </div>
      ))}
      {b.deferred.length > 0 && (
        <>
          <div style={styles.note}>Deferred (listed, loaded only when used; not in the context):</div>
          {b.deferred.map((r) => (
            <div key={r.key} style={styles.catRow} data-raw-agent="usage-context-row" data-kind="deferred">
              <span style={{ ...styles.swatch, background: 'transparent', border: `1px dashed ${border}` }} />
              <span style={styles.catName}>{r.name}</span>
              <span style={styles.num}>{r.tokens.toLocaleString('en-US')}</span>
            </div>
          ))}
        </>
      )}
      {b.autoCompact && <div style={styles.note}>{b.autoCompact}</div>}
      {b.note && <div style={styles.note}>{b.note}</div>}
      <div style={styles.note}>{b.source}</div>
    </div>
  );
}

type Tab = 'context' | 'session' | 'turns' | 'agents' | 'limits';

export interface UsagePanelProps {
  model: UsagePanelModel;
  reading?: boolean;
  error?: string;
  busy?: boolean;
  initialTab?: Tab;
  onStart?: () => void;
  onRefresh?: () => void;
  onClose?: () => void;
}

/** The usage panel (D59): every figure the agent reported for this session, labelled. */
export function UsagePanel(props: UsagePanelProps): React.ReactElement {
  const m = props.model;
  const [tab, setTab] = React.useState<Tab>(props.initialTab ?? 'context');
  const tabs: Array<[Tab, string]> = [
    ['context', 'Context'],
    ['session', 'Session'],
    ['turns', `Turns (${m.turns.length})`],
    ['agents', `Agents (${m.agents.filter((a) => a.kind !== 'workflow-agent').length})`],
    ['limits', 'Plan & account'],
  ];
  return (
    <div style={{ ...css.card, ...styles.popover }} data-raw-agent="usage-panel" role="dialog" aria-label="Usage">
      <div style={css.header}>
        <div style={styles.tabs} role="tablist">
          {tabs.map(([t, label]) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              style={tab === t ? { ...css.button, ...styles.tab } : css.button}
              data-raw-agent={`usage-tab-${t}`}
              onClick={() => setTab(t)}
            >
              {label}
            </button>
          ))}
        </div>
        <span style={css.row}>
          {props.onRefresh && m.running && (
            <button type="button" style={css.button} disabled={props.reading} onClick={props.onRefresh}>
              {props.reading ? 'Reading…' : 'Refresh'}
            </button>
          )}
          {props.onClose && (
            <button type="button" style={css.button} onClick={props.onClose} aria-label="Close">
              Close
            </button>
          )}
        </span>
      </div>
      {m.startable && (
        <div style={css.row} data-raw-agent="usage-start">
          <span style={styles.note}>No {m.name} process runs. The figures below are the last known ones.</span>
          {props.onStart && (
            <button type="button" style={css.primary} disabled={props.busy} onClick={props.onStart}>
              Start {m.name}
            </button>
          )}
        </div>
      )}
      {m.error && <div style={css.error}>{m.error}</div>}
      {props.error && <div style={css.error}>{props.error}</div>}
      {m.background && (
        <div style={styles.note} data-raw-agent="usage-background">
          {m.background}
        </div>
      )}
      {tab === 'context' &&
        (m.context ? <ContextSection breakdown={m.context} /> : <div style={styles.note}>{m.contextNote}</div>)}
      {tab === 'context' && m.events.length > 0 && (
        <div style={styles.section} data-raw-agent="usage-events">
          {m.events.map((e, i) => (
            <div key={i} style={styles.note}>
              {e}
            </div>
          ))}
        </div>
      )}
      {tab === 'session' && <SessionSection model={m} />}
      {tab === 'turns' && <TurnsSection model={m} />}
      {tab === 'agents' && <AgentsSection model={m} />}
      {tab === 'limits' && <LimitsSection model={m} />}
    </div>
  );
}

function SessionSection({ model: m }: { model: UsagePanelModel }): React.ReactElement {
  if (!m.totals) return <div style={styles.note}>{m.name} has not reported usage for this conversation yet.</div>;
  return (
    <div style={styles.section} data-raw-agent="usage-session">
      <div style={styles.heading}>This conversation: {m.totals.total}</div>
      <Lines
        lines={[
          ...m.totals.tokens,
          { label: 'Cost', value: m.totals.cost },
          ...(m.totals.apiTime ? [{ label: 'Model time', value: m.totals.apiTime }] : []),
        ]}
      />
      {m.account.costNote.map((n) => (
        <div key={n} style={styles.note}>
          {n}
        </div>
      ))}
      <div style={styles.heading}>By model</div>
      {m.models.length === 0 ? (
        <div style={styles.note}>No model use reported yet.</div>
      ) : (
        m.models.map((r) => (
          <div key={r.model} style={styles.card} data-raw-agent="usage-model">
            <div style={styles.catRow}>
              <span style={styles.catName}>{r.model}</span>
              <span style={styles.num}>
                {r.tokens} · {r.cost}
              </span>
            </div>
            {r.details.map((d) => (
              <div key={d} style={styles.note}>
                {d}
              </div>
            ))}
          </div>
        ))
      )}
      <div style={styles.note}>
        Totals cover this conversation, including subagents, workflow agents and compaction. A cleared conversation
        starts again at 0.
      </div>
    </div>
  );
}

function TurnsSection({ model: m }: { model: UsagePanelModel }): React.ReactElement {
  if (m.turns.length === 0) return <div style={styles.note}>No turn finished in this process yet.</div>;
  return (
    <div style={styles.section} data-raw-agent="usage-turns">
      {m.turns.map((t) => (
        <div key={t.key} style={styles.card} data-raw-agent="usage-turn">
          <div style={styles.catRow}>
            <span style={{ ...styles.catName, fontWeight: 600 }}>{t.label}</span>
            <span style={styles.num}>
              {t.total} · {t.cost}
            </span>
          </div>
          <div style={styles.note}>Main thread:</div>
          <Lines lines={t.main} />
          {t.other && <div style={styles.note}>Subagents, workflow agents and compaction: {t.other}</div>}
          <div style={styles.note}>
            {t.facts.join(' · ')} · {t.models}
          </div>
        </div>
      ))}
    </div>
  );
}

function AgentsSection({ model: m }: { model: UsagePanelModel }): React.ReactElement {
  if (m.agents.length === 0) return <div style={styles.note}>No subagents or workflows in this process yet.</div>;
  return (
    <div style={styles.section} data-raw-agent="usage-agents">
      {m.agents.map((a) => (
        <div
          key={a.key}
          style={{ ...styles.catRow, paddingLeft: a.kind === 'workflow-agent' ? 16 : 0 }}
          data-raw-agent="usage-agent"
          data-kind={a.kind}
        >
          <span style={styles.catName}>
            {a.kind === 'workflow' ? 'Workflow · ' : a.kind === 'teammate' ? 'Teammate · ' : ''}
            {a.label}
          </span>
          <span style={styles.num}>
            {a.tokens} · {a.facts.join(' · ')}
          </span>
        </div>
      ))}
      <div style={styles.note}>
        These are {m.name}&apos;s own counts: a child&apos;s figure is its last call&apos;s context plus output, not the
        sum of its calls. What a turn spent on children is in that turn&apos;s &quot;Subagents, workflow agents and
        compaction&quot; line.
      </div>
    </div>
  );
}

function LimitsSection({ model: m }: { model: UsagePanelModel }): React.ReactElement {
  const l = m.limits;
  return (
    <div style={styles.section} data-raw-agent="usage-limits">
      <div style={styles.heading}>Plan limits</div>
      {l.blocked && <div style={css.error}>{l.blocked}</div>}
      {l.note && <div style={styles.note}>{l.note}</div>}
      {l.rows.map((r) => (
        <div key={r.id} style={styles.card} data-raw-agent="usage-limit">
          <div style={styles.catRow}>
            <span style={styles.catName}>{r.label}</span>
            <span style={styles.num}>
              {r.value}
              {r.status ? ` · ${r.status}` : ''}
            </span>
          </div>
          {r.bar !== undefined && (
            <div style={styles.limitBar}>
              <div
                style={{
                  width: `${r.bar}%`,
                  height: '100%',
                  background: r.bar >= 90 ? LEVEL_COLOR.high : r.bar >= 70 ? LEVEL_COLOR.warn : 'currentColor',
                }}
              />
            </div>
          )}
          {r.reset && <div style={styles.note}>{r.reset}</div>}
        </div>
      ))}
      {l.overage && <div style={styles.note}>{l.overage}</div>}
      <div style={styles.heading}>Account</div>
      <Lines lines={m.account.lines} />
    </div>
  );
}
