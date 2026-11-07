// D30 (M7): the rewind dialog, as the terminal app's rewind menu (its `/rewind`): pick an earlier
// message of yours, then "Restore code and conversation", "Restore conversation", "Restore code"
// or "Never mind". Restoring the conversation makes a DSH branch (a fork before that message);
// this session stays as it is. "Restore code" puts the files back in place, from the agent's own
// checkpoints, after a preview. Nothing here starts a process.

import * as React from 'react';
import type { FileRewindWire, RawAgentApi, RewindOptionsWire, RewindPointWire } from '../api.js';
import {
  REWIND_STATS_MAX,
  REWIND_SUMMARIZE_NOTE,
  pointLabel,
  pointStats,
  rewindChoices,
  rewindDraft,
  rewindResultText,
  type RewindChoiceId,
  type RewindPreview,
} from '../lifecycle-model.js';
import { handBackDraft, requestRestoreAtStart, type RestoreRetry } from '../rewind-actions.js';
import type { SessionControlStore, SessionStores } from '../session-store.js';
import type { HostActions } from './actions.js';
import { css } from './style.js';

export interface RewindPanelProps {
  sessionId: string;
  api: RawAgentApi;
  actions: HostActions;
  store: SessionControlStore;
  /** The branch's store gets the note when "restore code" at its start could not be asked. */
  stores?: SessionStores;
  onClose(): void;
  /** Test seams. */
  initial?: {
    options?: RewindOptionsWire;
    picked?: string;
    preview?: RewindPreview;
    /** Row figures by message id; given, no dry run is asked for the rows. */
    stats?: Record<string, FileRewindWire>;
  };
  retry?: RestoreRetry;
}

type Load = { kind: 'loading' } | { kind: 'ok'; value: RewindOptionsWire } | { kind: 'error'; message: string };

const msg = (e: unknown) => String((e as Error)?.message ?? e);

const listStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  maxHeight: 280,
  overflowY: 'auto',
  margin: '6px 0',
};

export function RewindPanel(props: RewindPanelProps): React.ReactElement {
  const { sessionId, api, actions, onClose } = props;
  const [load, setLoad] = React.useState<Load>(
    props.initial?.options ? { kind: 'ok', value: props.initial.options } : { kind: 'loading' },
  );
  const [picked, setPicked] = React.useState<string | undefined>(props.initial?.picked);
  const [preview, setPreview] = React.useState<RewindPreview>(props.initial?.preview ?? { state: 'none' });
  const [busy, setBusy] = React.useState(false);
  const [outcome, setOutcome] = React.useState<{ text: string; error?: boolean } | undefined>();
  React.useEffect(() => {
    if (props.initial?.options || !api.rewind) {
      if (!api.rewind && !props.initial?.options) setLoad({ kind: 'error', message: 'This session cannot rewind.' });
      return undefined;
    }
    let live = true;
    api.rewind(sessionId).then(
      (value) => live && setLoad({ kind: 'ok', value }),
      (e: unknown) => live && setLoad({ kind: 'error', message: msg(e) }),
    );
    return () => {
      live = false;
    };
  }, [api, sessionId, props.initial?.options]);
  const dialog = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    // Capture phase, as the other dialogs: DSH's composer may stop Escape in the bubble phase.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    globalThis.addEventListener?.('keydown', onKey, true);
    dialog.current?.focus?.();
    return () => globalThis.removeEventListener?.('keydown', onKey, true);
  }, [onClose]);

  const opts = load.kind === 'ok' ? load.value : undefined;
  const point: RewindPointWire | undefined = opts?.points.find((p) => p.messageId === picked);
  const name = opts?.displayName ?? 'The agent';

  // M8 polish: the change figure of the newest rows, one dry run at a time on the live process (a
  // control call; no process starts). Rows without one show text only, as before.
  const [stats, setStats] = React.useState<Record<string, FileRewindWire>>(props.initial?.stats ?? {});
  React.useEffect(() => {
    if (!opts || !opts.running || !opts.fileRewind || !api.rewindFiles || props.initial?.stats) return undefined;
    const rewindFiles = api.rewindFiles.bind(api);
    let live = true;
    const ids = [...opts.points]
      .reverse()
      .slice(0, REWIND_STATS_MAX)
      .map((p) => p.messageId);
    void (async () => {
      for (const id of ids) {
        if (!live) return;
        try {
          const r = await rewindFiles(sessionId, id, true);
          if (live && r.result) setStats((all) => ({ ...all, [id]: r.result! }));
        } catch {
          // no figure for this row
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [api, sessionId, opts, props.initial?.stats]);

  // The "Restore code" preview: the agent's own dry run, read when a point is picked.
  React.useEffect(() => {
    if (!opts || !point || !opts.running || !opts.fileRewind || !api.rewindFiles) return undefined;
    if (props.initial?.preview && point.messageId === props.initial.picked) return undefined;
    let live = true;
    setPreview({ state: 'loading' });
    api.rewindFiles(sessionId, point.messageId, true).then(
      (r) =>
        live &&
        setPreview(
          r.result ? { state: 'done', result: r.result } : { state: 'failed', error: r.error ?? 'no preview' },
        ),
      (e: unknown) => live && setPreview({ state: 'failed', error: msg(e) }),
    );
    return () => {
      live = false;
    };
  }, [api, sessionId, opts, point, props.initial?.preview, props.initial?.picked]);

  const branch = async (restoreCode: boolean) => {
    if (!point || point.forkSeq === undefined) return;
    if (!actions.forkSession) {
      setOutcome({ text: 'DSH offers no branch action here.', error: true });
      return;
    }
    setBusy(true);
    try {
      const child = await actions.forkSession(sessionId, point.forkSeq);
      // M8 polish: the rewound message goes back to the branch's composer (at the caret, never
      // sent), as the TUI's rewind puts it back in the draft. Asked before the branch opens, so its
      // controls take it when they mount.
      handBackDraft(props.stores?.get(child), rewindDraft(point));
      actions.openSession?.(child);
      if (restoreCode) {
        // The branch's runtime appears once DSH opens it; ask until it answers (D30).
        void requestRestoreAtStart(api, child, props.retry).then((r) => {
          if (!r.ok)
            props.stores
              ?.get(child)
              .showNote(`The files will not be restored at this branch's start: ${r.error ?? 'no answer'}.`);
        });
      }
      onClose();
    } catch (e) {
      setOutcome({ text: `DSH did not make the branch: ${msg(e)}`, error: true });
    } finally {
      setBusy(false);
    }
  };

  const restoreCode = async () => {
    if (!point || !api.rewindFiles) return;
    setBusy(true);
    try {
      const r = await api.rewindFiles(sessionId, point.messageId, false);
      setOutcome(
        r.result
          ? { text: rewindResultText(r.result, name), error: !r.ok }
          : { text: r.error ?? 'The files were not restored.', error: true },
      );
      void props.store.refresh();
    } catch (e) {
      setOutcome({ text: msg(e), error: true });
    } finally {
      setBusy(false);
    }
  };

  const run = (id: RewindChoiceId) => {
    if (id === 'cancel') onClose();
    else if (id === 'conversation') void branch(false);
    else if (id === 'both') void branch(true);
    else void restoreCode();
  };

  const points = opts ? [...opts.points].reverse() : []; // newest first
  return (
    <div style={css.backdrop} data-raw-agent="rewind-backdrop" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        ref={dialog}
        tabIndex={-1}
        aria-label={`Rewind ${name}`}
        style={css.dialog}
        data-raw-agent="rewind-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div style={css.header}>
          <strong>Rewind</strong>
          <button type="button" style={css.button} onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>
        <p style={css.hint}>
          Pick one of your earlier messages. Restoring the conversation opens a new branch that ends before it; this
          session stays as it is.
        </p>
        {load.kind === 'loading' && <p style={css.hint}>Loading…</p>}
        {load.kind === 'error' && <p style={css.error}>{load.message}</p>}
        {opts && points.length === 0 && (
          <p style={css.hint} data-raw-agent="rewind-empty">
            There is no message of yours to go back to yet.
          </p>
        )}
        {opts && points.length > 0 && (
          <div style={listStyle} role="listbox" aria-label="Your messages" data-raw-agent="rewind-points">
            {points.map((p) => (
              <button
                key={p.messageId}
                type="button"
                role="option"
                aria-selected={p.messageId === picked}
                data-raw-agent="rewind-point"
                style={{
                  ...css.choice,
                  textAlign: 'left',
                  fontWeight: p.messageId === picked ? 600 : undefined,
                }}
                onClick={() => {
                  setPicked(p.messageId);
                  setOutcome(undefined);
                  setPreview({ state: 'none' });
                }}
              >
                {pointLabel(p)}
                {p.inherited ? ' (before this branch)' : ''}
                {pointStats(stats[p.messageId]) !== undefined && (
                  <span style={css.optionDesc} data-raw-agent="rewind-point-stats">
                    {pointStats(stats[p.messageId])}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        {opts && point && (
          <div data-raw-agent="rewind-choices" style={css.choiceCol}>
            {preview.state === 'loading' && <span style={css.hint}>Reading what “Restore code” would change…</span>}
            {preview.state === 'done' && preview.result && (
              <span style={css.hint} data-raw-agent="rewind-preview">
                {rewindResultText(preview.result, name)}
                {preview.result.ok && preview.result.filesChanged.length > 0
                  ? ` ${preview.result.filesChanged.slice(0, 8).join(', ')}${preview.result.filesChanged.length > 8 ? ', …' : ''}`
                  : ''}
              </span>
            )}
            {preview.state === 'failed' && <span style={css.hint}>No preview: {preview.error}</span>}
            {rewindChoices(opts, point, preview).map((c) => (
              <button
                key={c.id}
                type="button"
                style={c.id === 'cancel' ? css.button : css.choice}
                disabled={busy || c.disabled !== undefined}
                title={c.disabled ?? c.hint}
                data-raw-agent={`rewind-${c.id}`}
                onClick={() => run(c.id)}
              >
                {c.label}
                <span style={css.optionDesc}>{c.disabled ?? c.hint}</span>
              </button>
            ))}
          </div>
        )}
        {outcome && (
          <p style={outcome.error ? css.error : css.hint} role="status" data-raw-agent="rewind-outcome">
            {outcome.text}
          </p>
        )}
        <p style={css.hint}>{REWIND_SUMMARIZE_NOTE}</p>
      </div>
    </div>
  );
}
