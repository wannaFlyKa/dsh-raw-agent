// R7.3, D54: the side-question panel, like the terminal app's `/btw` panel. It floats over the
// page (a portal), opens by itself for a new side question, shows the answer when it arrives,
// and closes with × or Esc. Nothing here is ever written to the conversation: the Host keeps the
// questions in memory only, and this panel only reads and asks through the plugin's own routes.

import * as React from 'react';
import type { RawAgentApi, SideEntryWire, SideViewWire } from '../api.js';
import { latestSide, sideNote, sideOpen, sideShouldOpen, sideStatusText } from '../commands-model.js';
import type { SessionControlStore } from '../session-store.js';
import type { HostActions } from './actions.js';
import { Markdown } from './markdown.js';
import { css } from './style.js';

const muted = 'var(--raw-agent-muted, var(--dsw-alias-label-secondary, GrayText))';
const border = 'var(--raw-agent-border, var(--dsw-alias-border-l2, rgba(128,128,128,0.35)))';

const styles = {
  panel: {
    // Top right (M6 review: at the bottom it covered the composer's MCP and Settings buttons).
    position: 'fixed',
    right: 16,
    top: 64,
    zIndex: 900,
    width: 'min(440px, 92vw)',
    maxHeight: 'min(60vh, calc(100vh - 220px))',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: 12,
    boxSizing: 'border-box',
    background: 'var(--raw-agent-surface, var(--dsw-alias-bg-layer-1, Canvas))',
    color: 'var(--raw-agent-text, var(--dsw-alias-label-primary, CanvasText))',
    border: `1px solid ${border}`,
    borderRadius: 12,
    boxShadow: '0 6px 24px rgba(0,0,0,0.18)',
    fontSize: 13,
  },
  list: { display: 'flex', flexDirection: 'column', gap: 10, overflow: 'auto', minHeight: 0 },
  entry: { display: 'flex', flexDirection: 'column', gap: 4, borderTop: `1px solid ${border}`, paddingTop: 8 },
  question: { fontWeight: 600, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  status: { fontSize: 12, color: muted },
} satisfies Record<string, React.CSSProperties>;

export interface SidePanelProps {
  store: SessionControlStore;
  api: RawAgentApi;
  actions: HostActions;
  displayName: string;
  /** The side-question command, for the empty-panel hint (`/btw`). */
  command?: string;
  /** Test seam: start open. */
  initiallyOpen?: boolean;
  /** R9.2: text another plugin put into the box; the panel opens with it. */
  prefill?: { text: string; seq: number };
}

function useTick(on: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!on) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

export function SideEntryView(props: {
  entry: SideEntryWire;
  displayName: string;
  now: number;
  onCancel?(): void;
  onStart?(): void;
}): React.ReactElement {
  const { entry: e } = props;
  const status = sideStatusText(e, props.displayName, props.now);
  return (
    <div style={styles.entry} data-raw-agent="side-entry" data-status={e.status}>
      <span style={styles.question}>{e.question}</span>
      {e.answer !== undefined && e.answer !== '' && (
        <div data-raw-agent="side-answer">
          <Markdown text={e.answer} />
        </div>
      )}
      {e.fallback && (
        <span style={styles.status}>
          {e.fallback.fallbackModel} answered after {e.fallback.originalModel} declined.
        </span>
      )}
      {status && (
        <span style={styles.status} role="status">
          {status}
        </span>
      )}
      {sideOpen(e) && (
        <span style={css.row}>
          {e.status === 'waiting' && props.onStart && (
            <button type="button" style={css.button} onClick={props.onStart} data-raw-agent="side-start">
              Start {props.displayName}
            </button>
          )}
          {props.onCancel && (
            <button type="button" style={css.button} onClick={props.onCancel} data-raw-agent="side-cancel">
              Cancel
            </button>
          )}
        </span>
      )}
    </div>
  );
}

/** The panel body (no portal, no auto-open): tests render this directly. */
export function SidePanelBody(props: {
  side: SideViewWire | undefined;
  displayName: string;
  command?: string;
  busy: boolean;
  error?: string;
  now: number;
  onAsk(question: string): void;
  onCancel(id: string): void;
  onStart(): void;
  onClose(): void;
  /** R9.2: text another plugin put into the box (`rawAgentClient.prefill`); taken when `seq` changes. */
  prefill?: { text: string; seq: number };
}): React.ReactElement {
  const [draft, setDraft] = React.useState('');
  const prefillSeq = props.prefill?.seq;
  const prefillText = props.prefill?.text;
  React.useEffect(() => {
    if (prefillSeq === undefined || prefillText === undefined) return;
    setDraft((d) => (d.trim() === '' ? prefillText : `${d}\n${prefillText}`));
  }, [prefillSeq, prefillText]);
  const entries = props.side?.entries ?? [];
  const asking = entries.some(sideOpen);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length, latestSide(props.side)?.status]);
  const submit = () => {
    const q = draft.trim();
    if (q === '' || asking || props.busy) return;
    props.onAsk(q);
    setDraft('');
  };
  return (
    <div
      style={styles.panel}
      role="dialog"
      aria-label="Side question"
      data-raw-agent="side-panel"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          props.onClose();
        }
      }}
    >
      <div style={css.header}>
        <strong>Side question</strong>
        <button type="button" style={css.button} aria-label="Close" onClick={props.onClose} data-raw-agent="side-close">
          ×
        </button>
      </div>
      <span style={styles.status}>{sideNote(props.displayName, props.side?.historySize ?? 0)}</span>
      <div style={styles.list} ref={listRef}>
        {entries.length === 0 && (
          <span style={styles.status}>
            Ask something about the conversation
            {props.command ? `, here or with /${props.command} in the composer` : ''}.
          </span>
        )}
        {entries.map((e) => (
          <SideEntryView
            key={e.id}
            entry={e}
            displayName={props.displayName}
            now={props.now}
            onCancel={() => props.onCancel(e.id)}
            onStart={props.onStart}
          />
        ))}
      </div>
      {props.error && <span style={css.error}>{props.error}</span>}
      <textarea
        style={css.textarea}
        value={draft}
        placeholder={asking ? 'Wait for the answer…' : 'Ask another side question'}
        aria-label="Side question"
        data-raw-agent="side-input"
        onChange={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <span style={css.row}>
        <button
          type="button"
          style={css.button}
          disabled={asking || props.busy || draft.trim() === ''}
          onClick={submit}
          data-raw-agent="side-ask"
        >
          Ask
        </button>
      </span>
    </div>
  );
}

/**
 * The panel of one session. It opens for each new side question; × or Esc hides it until the
 * next one. `onOpenChange` lets the controls row show a "Side questions" button meanwhile.
 */
export function SidePanel(
  props: SidePanelProps & { open?: boolean; onOpenChange?(open: boolean): void },
): React.ReactElement | null {
  const { store, api, actions } = props;
  const snap = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const side = snap.info?.view.side;
  const [dismissed, setDismissed] = React.useState<string | undefined>();
  // The questions already there when the page loaded do not open the panel; a new one does.
  const baseline = React.useRef<string | null | undefined>(props.initiallyOpen ? null : undefined);
  if (baseline.current === undefined && snap.status === 'ready') baseline.current = latestSide(side)?.id ?? null;
  const [forced, setForced] = React.useState(props.initiallyOpen === true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>();
  const open =
    props.open === true ||
    forced ||
    (baseline.current !== undefined && sideShouldOpen(side, dismissed ?? baseline.current ?? undefined));
  const { onOpenChange } = props;
  React.useEffect(() => onOpenChange?.(open), [open, onOpenChange]);
  React.useEffect(() => {
    if (props.open) setForced(true);
  }, [props.open]);
  const prefillSeq = props.prefill?.seq;
  React.useEffect(() => {
    if (prefillSeq !== undefined) setForced(true);
  }, [prefillSeq]);
  const now = useTick(open && (side?.entries ?? []).some((e) => e.status === 'asking'));
  if (!open) return null;
  const close = () => {
    setForced(false);
    setDismissed(latestSide(side)?.id ?? '');
    onOpenChange?.(false);
  };
  const ask = (question: string) => {
    if (!api.askSide) return;
    setBusy(true);
    setError(undefined);
    setForced(true);
    void store.refresh();
    api.askSide(store.sessionId, question).then(
      (r) => {
        setBusy(false);
        if (!r.ok) setError(r.error ?? 'the question was refused');
        void store.refresh();
      },
      (e: unknown) => {
        setBusy(false);
        setError(String((e as Error)?.message ?? e));
      },
    );
    // The Host shows the question as "asking" at once; read it so the panel shows it.
    setTimeout(() => void store.refresh(), 300);
  };
  const cancel = (id: string) => {
    void api.cancelSide?.(store.sessionId, id).then(() => store.refresh());
  };
  return actions.portal(
    <SidePanelBody
      side={side}
      displayName={props.displayName}
      {...(props.command ? { command: props.command } : {})}
      busy={busy}
      {...(error ? { error } : {})}
      now={now}
      onAsk={ask}
      onCancel={cancel}
      onStart={() => void store.start()}
      onClose={close}
      {...(props.prefill ? { prefill: props.prefill } : {})}
    />,
  ) as React.ReactElement;
}
