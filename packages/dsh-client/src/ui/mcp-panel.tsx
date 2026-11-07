// R7.4, D55 and R7.1: the MCP servers of the live process (state, error text, reconnect,
// enable/disable, sign-in) and the agent's own command list with its place in DSH's `/` menu.
// Every action is the agent's own control through the plugin's routes; the plugin never writes a
// settings file (rule 2). The toggle note is the backend's text, shown as given.

import * as React from 'react';
import type { CommandsAnswerWire, McpActionWire, McpAnswerWire, McpServerWire, RawAgentApi } from '../api.js';
import {
  commandKindLabel,
  commandRowText,
  filterCommands,
  mcpActions,
  mcpDetail,
  mcpLevel,
  mcpStatusLabel,
  signInUrl,
  type McpLevel,
} from '../commands-model.js';
import type { HostActions } from './actions.js';
import { css } from './style.js';

const LEVEL_COLOR: Record<McpLevel, string> = {
  ok: 'var(--raw-agent-done, var(--dsw-alias-text-success, #22a06b))',
  pending: 'var(--raw-agent-running, var(--dsw-alias-text-accent, #3b82f6))',
  warn: 'var(--raw-agent-warn, var(--dsw-alias-text-warning, #d9822b))',
  error: 'var(--raw-agent-danger, var(--dsw-alias-text-danger, #c0392b))',
  off: 'var(--raw-agent-muted, var(--dsw-alias-text-secondary, GrayText))',
};

const styles = {
  server: { borderTop: '1px solid var(--raw-agent-border, rgba(128,128,128,0.35))', padding: '8px 0' },
  name: { fontWeight: 600, wordBreak: 'break-all' },
  errorText: { ...css.error, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  cmd: { display: 'grid', gridTemplateColumns: 'minmax(8em, max-content) 1fr', gap: '2px 12px', fontSize: 12 },
  cmdName: { fontFamily: 'var(--raw-agent-mono, ui-monospace, monospace)', wordBreak: 'break-all' },
} satisfies Record<string, React.CSSProperties>;

function Dot(props: { status: string }): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: 4,
        marginRight: 6,
        background: LEVEL_COLOR[mcpLevel(props.status)],
      }}
    />
  );
}

export function McpServerRow(props: {
  server: McpServerWire;
  running: boolean;
  busy: boolean;
  onAction(action: 'reconnect' | 'toggle' | 'authenticate', enabled?: boolean): void;
  onCallback(url: string): void;
  auth?: McpActionWire['auth'];
}): React.ReactElement {
  const { server: s } = props;
  const a = mcpActions(s, props.running);
  const [tools, setTools] = React.useState(false);
  const [pasted, setPasted] = React.useState('');
  const url = signInUrl(props.auth?.url);
  const detail = mcpDetail(s);
  return (
    <div style={styles.server} data-raw-agent="mcp-server" data-status={s.status}>
      <div style={css.fileHead}>
        <span>
          <Dot status={s.status} />
          <span style={styles.name}>{s.name}</span>
        </span>
        <span style={css.badge} data-raw-agent="mcp-status">
          {mcpStatusLabel(s.status)}
        </span>
      </div>
      {detail && <div style={css.hint}>{detail}</div>}
      {s.error && (
        <div style={styles.errorText} data-raw-agent="mcp-error">
          {s.error}
        </div>
      )}
      <div style={css.row}>
        {a.reconnect && (
          <button type="button" style={css.button} disabled={props.busy} onClick={() => props.onAction('reconnect')}>
            Reconnect
          </button>
        )}
        <button
          type="button"
          style={css.button}
          disabled={props.busy || !props.running}
          data-raw-agent="mcp-toggle"
          onClick={() => props.onAction('toggle', a.toggle === 'enable')}
        >
          {a.toggle === 'enable' ? 'Enable' : 'Disable'}
        </button>
        {a.signIn && (
          <button type="button" style={css.button} disabled={props.busy} onClick={() => props.onAction('authenticate')}>
            Sign in
          </button>
        )}
        {s.tools && s.tools.length > 0 && (
          <button type="button" style={css.button} onClick={() => setTools(!tools)}>
            {tools ? 'Hide tools' : 'Show tools'}
          </button>
        )}
      </div>
      {tools && s.tools && (
        <ul style={{ ...css.effects, marginTop: 4 }} data-raw-agent="mcp-tools">
          {s.tools.map((t) => (
            <li key={t.name}>
              <code>{t.name}</code>
              {t.description ? ` — ${t.description.split('\n')[0]}` : ''}
              {t.readOnly ? ' (read-only)' : t.destructive ? ' (destructive)' : ''}
            </li>
          ))}
        </ul>
      )}
      {props.auth && (
        <div style={css.choiceCol} data-raw-agent="mcp-auth">
          {url ? (
            <a href={url} target="_blank" rel="noreferrer noopener" style={css.link}>
              Open the sign-in page
            </a>
          ) : (
            !props.auth.needsUserAction && <span style={css.hint}>Nothing to do: already signed in.</span>
          )}
          {props.auth.callbackExpected && (
            <>
              <span style={css.hint}>
                If the sign-in page ends on an address that does not load (it points to the agent&apos;s own machine),
                paste that address here.
              </span>
              <span style={css.row}>
                <input
                  type="url"
                  style={{ ...css.input, minWidth: '18em' }}
                  value={pasted}
                  placeholder="http://localhost:…/callback?code=…"
                  aria-label="Address the sign-in ended on"
                  onChange={(e) => setPasted(e.currentTarget.value)}
                />
                <button
                  type="button"
                  style={css.button}
                  disabled={props.busy || !/^https?:\/\//i.test(pasted.trim())}
                  onClick={() => props.onCallback(pasted.trim())}
                >
                  Finish sign-in
                </button>
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function CommandList(props: {
  answer: CommandsAnswerWire;
  displayName: string;
  actions: HostActions;
}): React.ReactElement {
  const [query, setQuery] = React.useState('');
  const rows = filterCommands(props.answer.rows, query);
  return (
    <div style={css.choiceCol} data-raw-agent="command-list">
      {!props.answer.full && (
        <span style={css.hint}>
          Only the names are known so far; descriptions come once {props.displayName} lists them.
        </span>
      )}
      <input
        type="search"
        style={css.input}
        value={query}
        placeholder="Filter commands"
        aria-label="Filter commands"
        onChange={(e) => setQuery(e.currentTarget.value)}
      />
      <div style={styles.cmd}>
        {rows.map((r) => {
          const t = commandRowText(r, props.displayName);
          const kind = commandKindLabel(r.kind);
          return (
            <React.Fragment key={r.name}>
              <span style={styles.cmdName} data-raw-agent="command-name" data-menu={r.menu}>
                <button
                  type="button"
                  style={{ ...css.button, fontFamily: 'inherit' }}
                  title="Copy the command"
                  onClick={() => void props.actions.copy(`/${r.name} `)}
                >
                  {t.line}
                </button>
              </span>
              <span>
                {r.description}
                {kind ? <span style={css.hint}>{` · ${kind}`}</span> : null}
                {r.aliases && r.aliases.length > 0 ? (
                  <span style={css.hint}>{` · also ${r.aliases.map((a) => `/${a}`).join(', ')}`}</span>
                ) : null}
                {r.menu !== 'listed' ? <span style={css.hint}>{` · ${t.where}`}</span> : null}
              </span>
            </React.Fragment>
          );
        })}
      </div>
      {rows.length === 0 && <span style={css.hint}>No command matches.</span>}
    </div>
  );
}

export interface McpPanelProps {
  sessionId: string;
  api: RawAgentApi;
  actions: HostActions;
  displayName: string;
  onStart(): void;
  onClose(): void;
  /**
   * M8 polish: the panel read a newer server list than the controls hold (the "MCP n/m" button
   * reads the session view, polled): the controls read the view again, so the count does not lag.
   */
  onServers?(): void;
  /** Test seam: the data, skipping the first reads. */
  initial?: { mcp?: McpAnswerWire; commands?: CommandsAnswerWire };
}

export function McpPanel(props: McpPanelProps): React.ReactElement {
  const { api, sessionId, displayName } = props;
  const [tab, setTab] = React.useState<'mcp' | 'commands'>('mcp');
  const [mcp, setMcp] = React.useState<McpAnswerWire | undefined>(props.initial?.mcp);
  const [commands, setCommands] = React.useState<CommandsAnswerWire | undefined>(props.initial?.commands);
  const [busy, setBusy] = React.useState<string | undefined>();
  const [note, setNote] = React.useState<string | undefined>();
  const [error, setError] = React.useState<string | undefined>();
  const [auth, setAuth] = React.useState<Record<string, NonNullable<McpActionWire['auth']>>>({});
  const onServers = React.useRef(props.onServers);
  onServers.current = props.onServers;
  const load = React.useCallback(() => {
    if (api.mcp)
      api.mcp(sessionId).then(
        (m) => {
          setMcp(m);
          if (m.from === 'live') onServers.current?.();
        },
        (e: unknown) => setError(String((e as Error)?.message ?? e)),
      );
    if (api.commands)
      api.commands(sessionId).then(setCommands, (e: unknown) => setError(String((e as Error)?.message ?? e)));
  }, [api, sessionId]);
  React.useEffect(() => {
    if (!props.initial) load();
  }, [load, props.initial]);
  const act = (server: string, run: () => Promise<McpActionWire> | undefined) => {
    const p = run();
    if (!p) return;
    setBusy(server);
    setError(undefined);
    setNote(undefined);
    p.then(
      (r) => {
        setBusy(undefined);
        if (r.mcp) {
          setMcp(r.mcp);
          props.onServers?.();
        }
        if (!r.ok) setError(r.error ?? 'the action failed');
        if (r.note) setNote(r.note);
        if (r.auth) setAuth((all) => ({ ...all, [server]: r.auth! }));
      },
      (e: unknown) => {
        setBusy(undefined);
        setError(String((e as Error)?.message ?? e));
      },
    );
  };
  return (
    <div style={css.backdrop} onClick={props.onClose} data-raw-agent="mcp-backdrop">
      <div
        style={css.dialog}
        role="dialog"
        aria-label={`${displayName} MCP servers and commands`}
        data-raw-agent="mcp-panel"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}
      >
        <div style={css.header}>
          <span style={css.row}>
            <button
              type="button"
              style={{ ...css.button, fontWeight: tab === 'mcp' ? 600 : 400 }}
              onClick={() => setTab('mcp')}
            >
              MCP servers
            </button>
            <button
              type="button"
              style={{ ...css.button, fontWeight: tab === 'commands' ? 600 : 400 }}
              onClick={() => setTab('commands')}
            >
              Commands
            </button>
          </span>
          <span style={css.row}>
            <button type="button" style={css.button} onClick={load}>
              Refresh
            </button>
            <button type="button" style={css.button} aria-label="Close" onClick={props.onClose}>
              ×
            </button>
          </span>
        </div>
        {error && <div style={css.error}>{error}</div>}
        {note && (
          <div style={css.hint} data-raw-agent="mcp-note">
            {note}
          </div>
        )}
        {tab === 'mcp' ? (
          <div data-raw-agent="mcp-list">
            {mcp && !mcp.running && (
              <div style={css.row}>
                <span style={css.hint}>
                  {displayName} is not running. Start it to read the live MCP state
                  {mcp.servers.length > 0 ? '; the list below is from its last start report' : ''}.
                </span>
                <button type="button" style={css.button} onClick={props.onStart}>
                  Start {displayName}
                </button>
              </div>
            )}
            {mcp?.reason && mcp.running && <div style={css.hint}>The live read failed: {mcp.reason}</div>}
            {mcp && mcp.servers.length === 0 && <div style={css.hint}>No MCP servers.</div>}
            {!mcp && <div style={css.hint}>Reading…</div>}
            {mcp?.servers.map((s) => (
              <McpServerRow
                key={s.name}
                server={s}
                running={mcp.running}
                busy={busy !== undefined}
                {...(auth[s.name] ? { auth: auth[s.name] } : {})}
                onAction={(action, enabled) => act(s.name, () => api.mcpAction?.(sessionId, action, s.name, enabled))}
                onCallback={(url) => act(s.name, () => api.mcpAuthCallback?.(sessionId, s.name, url))}
              />
            ))}
          </div>
        ) : commands ? (
          <CommandList answer={commands} displayName={displayName} actions={props.actions} />
        ) : (
          <div style={css.hint}>Reading…</div>
        )}
      </div>
    </div>
  );
}
