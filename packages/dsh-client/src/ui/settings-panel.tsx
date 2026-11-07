// Settings quick access (R1.3, D63): the agent's own settings files for this session, read-only.
// Values the backend marks secret (for example under `env`) are masked; a click reveals one value.
// "Copy path", "Open in preview" (DSH's read-only preview, unmasked) and "Open in terminal". The
// plugin never writes these files (rule 2).

import * as React from 'react';
import type { ConfigFileItem, ConfigFilePreviewWire, RawAgentApi } from '../api.js';
import type { SettingsKeySource } from '@dsh-raw-agent/core';
import { cdCommand, keyLayerRows, maskedSegments } from '../view-model.js';
import type { HostActions } from './actions.js';
import { css } from './style.js';
import type { PluginApi } from '../plugin-routes.js';
import { GrantsPanel } from './grants-panel.js';

export interface SettingsPanelProps {
  sessionId: string;
  api: RawAgentApi;
  actions: HostActions;
  displayName: string;
  /** D63: which layer sets each key (from the Host's read-only settings preview). */
  keys?: SettingsKeySource[];
  /** R9.2, D66: the plugin access section (grants for other plugins). */
  plugin?: PluginApi;
  onClose(): void;
}

type Load<T> = { kind: 'loading' } | { kind: 'ok'; value: T } | { kind: 'error'; message: string };

const msg = (e: unknown) => String((e as Error)?.message ?? e);

export function SettingsPanel(props: SettingsPanelProps): React.ReactElement {
  const { sessionId, api, onClose } = props;
  const [files, setFiles] = React.useState<Load<ConfigFileItem[]>>({ kind: 'loading' });
  React.useEffect(() => {
    let live = true;
    api.configFiles(sessionId).then(
      (r) => live && setFiles({ kind: 'ok', value: r.files }),
      (e) => live && setFiles({ kind: 'error', message: msg(e) }),
    );
    return () => {
      live = false;
    };
  }, [api, sessionId]);
  const dialog = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    // Capture phase: DSH's composer and shortcut handlers see Escape first in the bubble phase and
    // may stop it, so a bubble listener never ran live (M1 verify). Focus moves into the dialog.
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
  const labelOf = (scope: string) =>
    (files.kind === 'ok' ? files.value.find((f) => f.scope === scope)?.label : undefined) ?? scope;
  const rows = keyLayerRows(props.keys, labelOf);

  return (
    <div style={css.backdrop} data-raw-agent="settings-backdrop" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        ref={dialog}
        tabIndex={-1}
        aria-label={`${props.displayName} settings files`}
        style={css.dialog}
        data-raw-agent="settings-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div style={css.header}>
          <strong>{props.displayName} settings files</strong>
          <button type="button" style={css.button} onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>
        <p style={css.hint}>
          Read-only. This plugin never changes these files. Hidden values are masked: click one to show it. To edit a
          file, use your editor or a terminal.
        </p>
        {files.kind === 'loading' && <p style={css.hint}>Loading…</p>}
        {files.kind === 'error' && <p style={css.error}>Could not list the files: {files.message}</p>}
        {files.kind === 'ok' && files.value.map((f) => <FileRow key={f.scope} file={f} {...props} />)}
        {rows.length > 0 && (
          <section style={css.file} data-raw-agent="settings-keys">
            <strong>Which file sets each key</strong>
            <p style={css.hint}>
              The first file named wins; objects and lists set in several files are combined. Read from the files only:
              managed (policy) settings are not shown, and the running session may report other values.
            </p>
            <table>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} data-raw-agent="settings-key">
                    <td>
                      <code>{r.key}</code>
                    </td>
                    <td style={css.hint}>{r.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        {props.plugin && (
          <section style={css.file}>
            <GrantsPanel plugin={props.plugin} copy={props.actions.copy} displayName={props.displayName} />
          </section>
        )}
      </div>
    </div>
  );
}

function FileRow(props: SettingsPanelProps & { file: ConfigFileItem }): React.ReactElement {
  const { file, actions, sessionId, api } = props;
  const [open, setOpen] = React.useState(false);
  const [note, setNote] = React.useState<string | undefined>();
  const flash = (text: string) => setNote(text);
  return (
    <section style={css.file} data-raw-agent="settings-file" data-scope={file.scope}>
      <div style={css.fileHead}>
        <div>
          <div>
            <strong>{file.label}</strong> <span style={css.badge}>{file.exists ? 'exists' : 'not created yet'}</span>
          </div>
          <code style={css.path}>{file.path}</code>
        </div>
      </div>
      <div style={css.row}>
        <button type="button" style={css.button} disabled={!file.exists} onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Preview'}
        </button>
        <button
          type="button"
          style={css.button}
          onClick={() => void actions.copy(file.path).then((ok) => flash(ok ? 'Path copied' : 'Could not copy'))}
        >
          Copy path
        </button>
        <button
          type="button"
          style={css.button}
          disabled={!file.exists}
          title="Opens the file unmasked in the DSH preview"
          onClick={() => flash(actions.openPreview(sessionId, file.path) ? 'Opened in the preview' : 'No preview here')}
        >
          Open in DSH preview
        </button>
        <button
          type="button"
          style={css.button}
          title="Opens a DSH terminal and copies a command that goes to this file's folder"
          onClick={() => {
            // DSH opens terminal tabs in the session folder only; the copied `cd` takes the user to
            // the file's folder with one paste (D63). Nothing is typed or run for the user.
            const opened = actions.openTerminal(sessionId);
            const command = cdCommand(file.path);
            void actions
              .copy(command)
              .then((copied) =>
                flash(
                  opened
                    ? copied
                      ? `Terminal opened. Paste the copied command to go to the file's folder: ${command}`
                      : `Terminal opened in the session folder. To go to the file's folder, run: ${command}`
                    : 'No terminal here',
                ),
              );
          }}
        >
          Open in terminal
        </button>
        {note && <span style={css.hint}>{note}</span>}
      </div>
      {open && <Preview api={api} sessionId={sessionId} scope={file.scope} />}
    </section>
  );
}

function Preview(props: { api: RawAgentApi; sessionId: string; scope: string }): React.ReactElement {
  const { api, sessionId, scope } = props;
  const [state, setState] = React.useState<Load<ConfigFilePreviewWire>>({ kind: 'loading' });
  const [shown, setShown] = React.useState<Record<number, string>>({});
  React.useEffect(() => {
    let live = true;
    api.configFile(sessionId, scope).then(
      (value) => live && setState({ kind: 'ok', value }),
      (e) => live && setState({ kind: 'error', message: msg(e) }),
    );
    return () => {
      live = false;
    };
  }, [api, sessionId, scope]);
  if (state.kind === 'loading') return <p style={css.hint}>Loading…</p>;
  if (state.kind === 'error') return <p style={css.error}>{state.message}</p>;
  const p = state.value;
  if (!p.exists) return <p style={css.hint}>The file does not exist.</p>;
  if (p.tooLarge) return <p style={css.hint}>The file is too large to preview.</p>;
  if (p.error) return <p style={css.error}>{p.error}</p>;
  const segments = maskedSegments(p.masked ?? '', p.secrets ?? []);
  const toggle = (index: number) => {
    if (shown[index] !== undefined) {
      const next = { ...shown };
      delete next[index];
      setShown(next);
      return;
    }
    api.reveal(sessionId, scope, index).then(
      (r) => setShown((s) => ({ ...s, [index]: r.value })),
      (e) => setShown((s) => ({ ...s, [index]: `[could not show: ${msg(e)}]` })),
    );
  };
  return (
    <pre style={css.pre} data-raw-agent="settings-preview">
      {segments.map((s, i) =>
        s.kind === 'text' ? (
          <React.Fragment key={i}>{s.text}</React.Fragment>
        ) : (
          <button
            key={i}
            type="button"
            style={css.secret}
            data-raw-agent="secret"
            title={shown[s.index!] !== undefined ? 'Hide this value' : `Show ${s.key ?? 'this value'}`}
            onClick={() => toggle(s.index!)}
          >
            {shown[s.index!] ?? s.text}
          </button>
        ),
      )}
    </pre>
  );
}
