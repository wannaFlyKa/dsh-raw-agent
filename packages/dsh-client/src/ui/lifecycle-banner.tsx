// M7 (R3.6, D29, D30, D75): the lifecycle banner of one of our sessions, in the dock below the
// composer. A crash or an exit of the agent shows its own words and a Restart button (it resumes
// the same conversation, D28); the fork, restore, recovery and restart facts show as short notes.
// Each can be dismissed; a new fact shows again. Renders nothing in a session that is not ours.

import * as React from 'react';
import { exitBanner, lifecycleNotes } from '../lifecycle-model.js';
import type { SessionControlStore } from '../session-store.js';
import { css } from './style.js';

const border = 'var(--raw-agent-border, var(--dsw-alias-border-default, rgba(128,128,128,0.35)))';
const danger = 'var(--raw-agent-danger, var(--dsw-alias-text-danger, #c0392b))';
const warn = 'var(--raw-agent-warning, var(--dsw-alias-border-warning, orange))';

const box = (color: string): React.CSSProperties => ({
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  border: `1px solid ${border}`,
  borderLeft: `3px solid ${color}`,
  borderRadius: 6,
  padding: '6px 8px',
  fontSize: 12,
  margin: '4px 0',
  maxWidth: '100%',
});

const detailStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 11,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 160,
  overflowY: 'auto',
  fontFamily: 'var(--raw-agent-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
};

export interface LifecycleBannerProps {
  store: SessionControlStore;
}

export function LifecycleBanner(props: LifecycleBannerProps): React.ReactElement | null {
  const { store } = props;
  const snap = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [dismissed, setDismissed] = React.useState<ReadonlySet<string>>(() => new Set());
  const dismiss = (id: string) => setDismissed((d) => new Set([...d, id]));
  const info = snap.status === 'ready' ? snap.info : undefined;
  if (!info) return null;
  const exit = exitBanner(info);
  const notes = lifecycleNotes(info).filter((n) => !dismissed.has(n.id));
  const showExit = exit !== undefined && !dismissed.has(exit.key);
  if (!showExit && notes.length === 0) return null;
  return (
    <div
      data-raw-agent="lifecycle"
      style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flexBasis: '100%' }}
    >
      {showExit && exit && (
        <div style={box(exit.level === 'error' ? danger : warn)} role="alert" data-raw-agent="exit-banner">
          <strong>{exit.title}</strong>
          {exit.reply && <span>{exit.reply}</span>}
          {exit.detail && (
            <details>
              <summary style={css.hint}>What it reported</summary>
              <pre style={detailStyle} data-raw-agent="exit-detail">
                {exit.detail}
              </pre>
            </details>
          )}
          <span style={css.row}>
            <button
              type="button"
              style={css.primary}
              disabled={snap.busy}
              data-raw-agent="exit-restart"
              onClick={() => void store.start()}
            >
              {exit.restartLabel}
            </button>
            <button type="button" style={css.button} data-raw-agent="exit-dismiss" onClick={() => dismiss(exit.key)}>
              Dismiss
            </button>
          </span>
        </div>
      )}
      {notes.map((n) => (
        <div
          key={n.id}
          style={{ ...box(n.level === 'warning' ? warn : border), flexDirection: 'row', alignItems: 'center' }}
          data-raw-agent="lifecycle-note"
          role="status"
        >
          <span style={{ flex: '1 1 auto' }}>{n.text}</span>
          <button type="button" style={css.button} aria-label="Dismiss" onClick={() => dismiss(n.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
