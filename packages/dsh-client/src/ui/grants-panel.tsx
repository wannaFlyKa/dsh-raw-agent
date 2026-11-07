// The plugin access panel (R9.2, D66): the user lets one other plugin send messages to the agent
// without a keypress. Off by default: no grant exists until the user creates one here. The token
// shows once, for pasting into that plugin's config; the Host keeps only its hash.

import * as React from 'react';
import type { GrantWire, PluginApi } from '../plugin-routes.js';
import { css } from './style.js';

export interface GrantsPanelProps {
  plugin: PluginApi;
  copy(text: string): Promise<boolean>;
  /** The agent's name for the labels; a generic name when no session is known. */
  displayName?: string;
}

type Load = { kind: 'loading' } | { kind: 'ok'; grants: GrantWire[] } | { kind: 'error'; message: string };

const msg = (e: unknown) => String((e as Error)?.message ?? e);

export function grantNote(g: GrantWire): string {
  const parts = [`created ${new Date(g.created).toLocaleString()}`];
  if (g.uses > 0) parts.push(`used ${g.uses === 1 ? 'once' : `${g.uses} times`} in this run`);
  if (!g.saved) parts.push('kept until DSH restarts (not saved to a file)');
  return parts.join(' · ');
}

export function GrantsPanel(props: GrantsPanelProps): React.ReactElement {
  const { plugin } = props;
  const name = props.displayName ?? 'the agent';
  const [state, setState] = React.useState<Load>({ kind: 'loading' });
  const [label, setLabel] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>();
  const [fresh, setFresh] = React.useState<{ label: string; token: string; copied?: boolean } | undefined>();
  React.useEffect(() => {
    let live = true;
    plugin.grants().then(
      (grants) => live && setState({ kind: 'ok', grants }),
      (e) => live && setState({ kind: 'error', message: msg(e) }),
    );
    return () => {
      live = false;
    };
  }, [plugin]);
  const create = () => {
    if (busy || label.trim() === '') return;
    setBusy(true);
    setError(undefined);
    plugin.createGrant(label).then(
      (r) => {
        setBusy(false);
        setLabel('');
        setFresh({ label: r.grant.label, token: r.token });
        setState({ kind: 'ok', grants: r.grants });
      },
      (e) => {
        setBusy(false);
        setError(msg(e));
      },
    );
  };
  const revoke = (id: string) => {
    setBusy(true);
    setError(undefined);
    plugin.revokeGrant(id).then(
      (r) => {
        setBusy(false);
        setState({ kind: 'ok', grants: r.grants });
        if (!r.saved)
          setError('Revoked for this DSH run. The stored list could not be updated; revoke it again after a restart.');
      },
      (e) => {
        setBusy(false);
        setError(msg(e));
      },
    );
  };
  return (
    <div data-raw-agent="grants-panel" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <strong>Plugin access</strong>
      <p style={css.hint}>
        Other plugins can always read the session state and put text into the composer for you to send. To let one
        plugin send messages and side questions to {name} without asking, create a grant for it and paste the token into
        that plugin&apos;s config. Messages it sends are marked with the grant&apos;s name in the session log.
      </p>
      <p style={css.hint}>
        This is a consent switch between plugins you installed, not a security boundary: every DSH plugin runs in the
        same process and could read your config.
      </p>
      {state.kind === 'loading' && <p style={css.hint}>Loading…</p>}
      {state.kind === 'error' && <p style={css.error}>{state.message}</p>}
      {state.kind === 'ok' && state.grants.length === 0 && (
        <p style={css.hint} data-raw-agent="grants-empty">
          No plugin may send messages without asking.
        </p>
      )}
      {state.kind === 'ok' &&
        state.grants.map((g) => (
          <div key={g.id} data-raw-agent="grant-row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ flex: '1 1 auto' }}>
              Let <strong>{g.label}</strong> send messages without asking
              <br />
              <span style={css.hint}>{grantNote(g)}</span>
            </span>
            <button
              type="button"
              style={css.button}
              disabled={busy}
              data-raw-agent="grant-revoke"
              onClick={() => revoke(g.id)}
            >
              Revoke
            </button>
          </div>
        ))}
      {fresh && (
        <div data-raw-agent="grant-token" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span>
            Token for <strong>{fresh.label}</strong>. Copy it now: it is not shown again.
          </span>
          <code style={css.pre}>{fresh.token}</code>
          <span style={{ display: 'flex', gap: 4 }}>
            <button
              type="button"
              style={css.button}
              data-raw-agent="grant-copy"
              onClick={() => void props.copy(fresh.token).then((ok) => ok && setFresh({ ...fresh, copied: true }))}
            >
              {fresh.copied ? 'Copied' : 'Copy token'}
            </button>
            <button type="button" style={css.button} onClick={() => setFresh(undefined)}>
              Done
            </button>
          </span>
        </div>
      )}
      <span style={{ display: 'flex', gap: 4 }}>
        <input
          aria-label="Plugin name for a new grant"
          placeholder="Plugin name, for example my-reminders"
          value={label}
          maxLength={80}
          data-raw-agent="grant-label"
          style={{ ...css.select, maxWidth: 'none', flex: '1 1 auto' }}
          onChange={(e) => setLabel(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') create();
          }}
        />
        <button
          type="button"
          style={css.button}
          disabled={busy || label.trim() === ''}
          data-raw-agent="grant-create"
          onClick={create}
        >
          Create grant
        </button>
      </span>
      {error && <p style={css.error}>{error}</p>}
    </div>
  );
}
