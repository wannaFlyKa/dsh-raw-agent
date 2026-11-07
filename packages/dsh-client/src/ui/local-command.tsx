// R7.2 and the M5 leftovers: how a local command's output step shows in the chat. The command's
// text is the native message, unchanged in the log (D69, rule 8); this node claims that message
// and draws it (D69 r5): plain columns monospaced, Markdown through our own renderer (no `$` math).
// It adds what the text cannot show well: the /context table first (from the Host's display-only
// copy) with the long text folded under it, the usage numbers next to /usage and /cost, the
// "Conversation compacted" marker and the /clear divider (D70) live on the typed command (M7).

import * as React from 'react';
import { parseContextView, type LocalOutputWire, type RawAgentApi } from '../api.js';
import { localRender, localTextFormat, type LocalCommandData } from '../commands-model.js';
import { contextBreakdown, costText, formatCount } from '../usage-model.js';
import type { SessionControlStore } from '../session-store.js';
import { Markdown } from './markdown.js';
import { css } from './style.js';
import { ContextSection } from './usage-panel.js';

const muted = 'var(--raw-agent-muted, var(--dsw-alias-label-secondary, GrayText))';
const border = 'var(--raw-agent-border, var(--dsw-alias-border-l2, rgba(128,128,128,0.35)))';

const styles = {
  divider: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 12,
    color: muted,
    margin: '8px 0',
  },
  line: { flex: '1 1 auto', borderTop: `1px solid ${border}` },
  box: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    border: `1px solid ${border}`,
    borderRadius: 8,
    padding: 8,
    fontSize: 12,
    margin: '4px 0',
  },
  table: { borderCollapse: 'collapse', fontSize: 12 },
  cell: { padding: '1px 8px 1px 0', textAlign: 'left', verticalAlign: 'top' },
  numCell: { padding: '1px 0 1px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: muted },
  pre: {
    margin: '4px 0',
    padding: 8,
    border: `1px solid ${border}`,
    borderRadius: 8,
    fontFamily: 'var(--raw-agent-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
    fontSize: 12,
    whiteSpace: 'pre',
    overflowX: 'auto',
  },
} satisfies Record<string, React.CSSProperties>;

/** The agent's own text of a local command, as written (plain columns stay aligned). */
export function LocalCommandText(props: { text: string }): React.ReactElement | null {
  if (props.text === '') return null;
  if (localTextFormat(props.text) === 'plain')
    return (
      <pre style={styles.pre} data-raw-agent="local-text">
        {props.text}
      </pre>
    );
  return (
    <div data-raw-agent="local-text">
      <Markdown text={props.text} testId="local-markdown" />
    </div>
  );
}

export function Divider(props: { text: string; testId: string }): React.ReactElement {
  return (
    <div style={styles.divider} role="separator" data-raw-agent={props.testId}>
      <span style={styles.line} />
      <span>{props.text}</span>
      <span style={styles.line} />
    </div>
  );
}

interface DetailRow {
  name: string;
  extra?: string;
  tokens: number;
}

function DetailTable(props: { title: string; rows: readonly DetailRow[] }): React.ReactElement | null {
  if (props.rows.length === 0) return null;
  const rows = [...props.rows].sort((a, b) => b.tokens - a.tokens);
  return (
    <details data-raw-agent="local-context-detail">
      <summary>
        {props.title} ({rows.length})
      </summary>
      <table style={styles.table}>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td style={styles.cell}>{r.name}</td>
              <td style={{ ...styles.cell, color: muted }}>{r.extra ?? ''}</td>
              <td style={styles.numCell}>{formatCount(r.tokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

const arr = (v: unknown): Array<Record<string, unknown>> =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null) : [];
const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The /context twin: the agent's categories, then its per-item tables. */
export function LocalContextView(props: { output: LocalOutputWire; displayName: string }): React.ReactElement | null {
  const c = props.output.context;
  const view = parseContextView({ ...c, source: 'report', at: 0 });
  const d = (c.details ?? {}) as Record<string, unknown>;
  return (
    <div style={styles.box} data-raw-agent="local-context">
      {view ? (
        <ContextSection breakdown={contextBreakdown(view, props.displayName)} />
      ) : (
        <span style={css.hint}>The report has no figures.</span>
      )}
      <DetailTable
        title="MCP tools"
        rows={arr(d.mcpTools).map((r) => ({ name: s(r.name), extra: s(r.server), tokens: n(r.tokens) }))}
      />
      <DetailTable
        title="Memory files"
        rows={arr(d.memoryFiles).map((r) => ({ name: s(r.path), extra: s(r.type), tokens: n(r.tokens) }))}
      />
      <DetailTable
        title="Agents"
        rows={arr(d.agents).map((r) => ({ name: s(r.name), extra: s(r.source), tokens: n(r.tokens) }))}
      />
      <DetailTable
        title="Skills"
        rows={arr(d.skills).map((r) => ({
          name: s(r.name),
          extra: [s(r.source), s(r.plugin)].filter((x) => x !== '').join(' · '),
          tokens: n(r.tokens),
        }))}
      />
    </div>
  );
}

function ContextOutput(props: {
  data: LocalCommandData;
  sessionId: string;
  api: RawAgentApi;
  displayName: string;
}): React.ReactElement | null {
  const { data, api, sessionId } = props;
  const [state, setState] = React.useState<{ output?: LocalOutputWire; gone?: boolean; error?: string }>({});
  React.useEffect(() => {
    if (!data.outputId || !api.localOutput) return undefined;
    let live = true;
    api.localOutput(sessionId, data.outputId).then(
      (output) => live && setState(output ? { output } : { gone: true }),
      (e: unknown) => live && setState({ error: String((e as Error)?.message ?? e) }),
    );
    return () => {
      live = false;
    };
  }, [api, sessionId, data.outputId]);
  if (!data.outputId) return null;
  if (state.output) return <LocalContextView output={state.output} displayName={props.displayName} />;
  if (state.gone)
    return (
      <span style={css.hint} data-raw-agent="local-context-gone">
        The table of this report is no longer kept (DSH restarted); its full text is below.
      </span>
    );
  if (state.error) return <span style={css.error}>{state.error}</span>;
  return null;
}

/** /usage and /cost: the plugin's own numbers beside the agent's text (the command gives text only). */
function UsageOutput(props: { store: SessionControlStore }): React.ReactElement | null {
  const snap = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot);
  const u = snap.info?.view.usage;
  if (!u || (u.tokens === undefined && u.costUsd === undefined)) return null;
  const parts: string[] = [];
  if (u.tokens !== undefined) parts.push(`${formatCount(u.tokens)} tokens`);
  if (u.costUsd !== undefined) parts.push(costText(u.costUsd, u.costLabel));
  if (u.limit?.percent !== undefined) parts.push(`${u.limit.label}: ${Math.round(u.limit.percent)}% used`);
  return (
    <div style={{ ...css.hint, margin: '2px 0' }} data-raw-agent="local-usage">
      This conversation so far: {parts.join(' · ')}. The context pill below the composer opens the full usage panel.
    </div>
  );
}

export interface LocalCommandNodeProps {
  data: LocalCommandData;
  sessionId: string;
  store: SessionControlStore;
  api: RawAgentApi;
}

export function LocalCommandView(props: LocalCommandNodeProps): React.ReactElement | null {
  const snap = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot);
  const displayName = snap.info?.backend.displayName ?? 'The agent';
  const text = <LocalCommandText text={props.data.text ?? ''} />;
  switch (localRender(props.data)) {
    case 'cleared':
    case 'compacted':
      // M7: the divider and the marker sit on the typed command (port `commandMarkerDefinition`),
      // which every run has; drawing them here too would show them twice.
      return text;
    case 'context':
      // The categories first; the agent's long text (its full tables) folded below.
      return (
        <>
          <ContextOutput data={props.data} sessionId={props.sessionId} api={props.api} displayName={displayName} />
          {props.data.text && props.data.outputId ? (
            <details data-raw-agent="local-context-text">
              <summary style={css.hint}>{displayName}'s full /context text</summary>
              {text}
            </details>
          ) : (
            text
          )}
        </>
      );
    case 'usage':
      return (
        <>
          {text}
          <UsageOutput store={props.store} />
        </>
      );
    default:
      return text;
  }
}
