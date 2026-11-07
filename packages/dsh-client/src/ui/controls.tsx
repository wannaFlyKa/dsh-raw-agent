// Session controls in the composer row (R1.4, D35-D38): model, effort and permission mode for
// this session only, plus the settings quick-access button (R1.3, D63). Renders nothing in a
// session that is not ours (the Host answers 404). Every choice goes to the plugin's own route,
// never to DSH's `selectModel` (K1).

import * as React from 'react';
import type { SessionChoiceRequest } from '@dsh-raw-agent/core';
import { agentSelect } from '../agents-model.js';
import { SETTINGS, type RawAgentApi } from '../api.js';
import { restoreReturnedDrafts, type DraftTarget } from '../drafts.js';
import type { SessionControlStore, SessionStores } from '../session-store.js';
import { START_OPTION, effortSelect, modeSelect, modelSelect, statusLine, type SelectModel } from '../view-model.js';
import type { HostActions } from './actions.js';
import { AskPanel } from './ask-cards.js';
import { SettingsPanel } from './settings-panel.js';
import { mcpButtonLabel } from '../commands-model.js';
import { McpPanel } from './mcp-panel.js';
import { SidePanel } from './side-panel.js';
import { exitBanner } from '../lifecycle-model.js';
import { RewindPanel } from './rewind-panel.js';
import { css } from './style.js';

export interface ControlsProps {
  store: SessionControlStore;
  api: RawAgentApi;
  actions: HostActions;
  /** DSH's session-slot `inputActions` (standard prop of a session slot component). */
  inputActions?: DraftTarget;
  /** Test seam: the draft poll interval. */
  draftPollMs?: number;
  /**
   * The asks show as cards in DSH's composer (the port's takeover, D39). Without that seam the
   * cards show here, in the controls row.
   */
  asksInComposer?: boolean | (() => boolean);
  /** All session stores: a new rewind branch's store takes a note (M7). */
  stores?: SessionStores;
}

function Picker(props: {
  model: SelectModel;
  label: string;
  disabled: boolean;
  onPick(value: string): void;
  testId: string;
}): React.ReactElement {
  const { model } = props;
  return (
    <select
      aria-label={props.label}
      title={model.title}
      style={css.select}
      value={model.value}
      disabled={props.disabled}
      data-raw-agent={props.testId}
      onChange={(e) => props.onPick(e.currentTarget.value)}
    >
      {model.options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled} title={o.hint}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function SessionControls(props: ControlsProps): React.ReactElement | null {
  const { store, api, actions } = props;
  const snap = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [panel, setPanel] = React.useState(false);
  const close = React.useCallback(() => setPanel(false), []);
  const [mcpPanel, setMcpPanel] = React.useState(false);
  const closeMcp = React.useCallback(() => setMcpPanel(false), []);
  const [rewindPanel, setRewindPanel] = React.useState(false);
  const closeRewind = React.useCallback(() => setRewindPanel(false), []);
  // D55, D30: a bare `/mcp` or `/rewind` in the composer (our `/` source) opens our panel, like
  // the terminal app opens its own.
  const panelSeq = snap.panelRequest?.seq ?? 0;
  const panelName = snap.panelRequest?.panel;
  const panelSeen = React.useRef(panelSeq); // a request from before this mount does not reopen it
  React.useEffect(() => {
    if (panelSeq > panelSeen.current) {
      if (panelName === 'mcp') setMcpPanel(true);
      else if (panelName === 'rewind') setRewindPanel(true);
    }
    panelSeen.current = panelSeq;
  }, [panelSeq, panelName]);
  // R7.3: the side panel opens by itself for a new question; the button brings it back.
  const [sideShown, setSideShown] = React.useState(false);
  const [sideWanted, setSideWanted] = React.useState(false);
  const onSideOpen = React.useCallback((open: boolean) => {
    setSideShown(open);
    if (!open) setSideWanted(false);
  }, []);
  const info = snap.info;
  const turn = info?.view.state.turn === true;
  // D25: while a turn runs, and once right after it, take back the steers Stop cancelled.
  const { inputActions, draftPollMs } = props;
  const [held, setHeld] = React.useState<string | undefined>();
  const [dropped, setDropped] = React.useState(0);
  const heldRef = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    if (!inputActions) return undefined;
    const take = () =>
      void restoreReturnedDrafts(api, store.sessionId, inputActions, heldRef.current).then(
        (r) => {
          heldRef.current = r.held;
          setHeld(r.held);
          if (r.droppedAttachments > 0) setDropped((n) => n + r.droppedAttachments);
          if (r.inserted !== undefined && r.droppedAttachments === 0) setDropped(0);
        },
        () => undefined,
      );
    if (!turn) {
      take();
      const late = setTimeout(take, 2000);
      return () => clearTimeout(late);
    }
    const timer = setInterval(take, draftPollMs ?? 1500);
    return () => clearInterval(timer);
  }, [turn, api, store, inputActions, draftPollMs]);
  // DSH's own permission control does not apply to this agent: hide it while our controls show
  // (only in our sessions; a Standard session renders no controls, so its seat stays).
  const barRef = React.useRef<HTMLSpanElement | null>(null);
  const ready = snap.status === 'ready' && info !== undefined;
  React.useEffect(() => {
    if (!ready || !actions.hideNativeSeat) return undefined;
    const hidden = actions.hideNativeSeat(barRef.current);
    return () => hidden.undo();
  }, [ready, actions]);
  if (snap.status !== 'ready' || !info) return null;
  const choose = (c: SessionChoiceRequest) => void store.choose(c);
  const model = modelSelect(info);
  const effort = effortSelect(info);
  const mode = modeSelect(info);
  const agent = agentSelect(info);
  const draftNote =
    dropped > 0
      ? `The stopped message had ${dropped === 1 ? 'an attachment' : `${dropped} attachments`} that cannot go back into the composer; attach ${dropped === 1 ? 'it' : 'them'} again.`
      : undefined;
  const status =
    snap.error ?? statusLine(info, { exitShown: exitBanner(info) !== undefined }) ?? draftNote ?? snap.note;
  const name = info.backend.displayName;
  const asks = info.view.asks ?? [];
  const inComposer =
    typeof props.asksInComposer === 'function' ? props.asksInComposer() : props.asksInComposer === true;
  return (
    <span style={css.bar} data-raw-agent="controls" ref={barRef}>
      {asks.length > 0 && !inComposer && (
        <span style={css.ask} data-raw-agent="ask-inline">
          <AskPanel store={store} actions={actions} />
        </span>
      )}
      <Picker
        testId="model"
        label={`${name} model for this session`}
        model={model}
        disabled={snap.busy}
        onPick={(value) => {
          if (value === START_OPTION) void store.start();
          else if (value !== model.value) choose({ model: value });
        }}
      />
      {effort && (
        <Picker
          testId="effort"
          label={`${name} effort for this session`}
          model={effort}
          disabled={snap.busy}
          onPick={(value) => value !== effort.value && choose({ effort: value === SETTINGS ? null : value })}
        />
      )}
      <Picker
        testId="mode"
        label={`${name} permission mode for this session`}
        model={mode}
        disabled={snap.busy}
        onPick={(value) => value !== mode.value && choose({ mode: value })}
      />
      {agent && (
        <Picker
          testId="agent"
          label={`${name} main-thread agent for this new session`}
          model={agent}
          disabled={snap.busy || agent.locked}
          onPick={(value) => {
            if (value === START_OPTION) void store.start();
            else if (value !== agent.value) choose({ agent: value === SETTINGS ? null : value });
          }}
        />
      )}
      {api.mcp && (
        <button
          type="button"
          style={css.button}
          data-raw-agent="mcp-button"
          title={`${name} MCP servers and commands`}
          onClick={() => setMcpPanel(true)}
        >
          {mcpButtonLabel(info.view.mcp)}
        </button>
      )}
      {(info.view.side?.entries.length ?? 0) > 0 && !sideShown && (
        <button
          type="button"
          style={css.button}
          data-raw-agent="side-button"
          title="Show the side questions (not part of the conversation)"
          onClick={() => setSideWanted(true)}
        >
          Side questions
        </button>
      )}
      {api.askSide && (
        <SidePanel
          store={store}
          api={api}
          actions={actions}
          displayName={name}
          open={sideWanted}
          onOpenChange={onSideOpen}
        />
      )}
      {api.rewind && (
        <button
          type="button"
          style={css.button}
          data-raw-agent="rewind-button"
          title={`Go back to an earlier message: restore the conversation (a new branch), the code, or both`}
          onClick={() => setRewindPanel(true)}
        >
          Rewind
        </button>
      )}
      <button
        type="button"
        style={css.button}
        data-raw-agent="settings-button"
        title={`Open your ${name} settings files (read-only)`}
        onClick={() => setPanel(true)}
      >
        Settings files
      </button>
      {held !== undefined && (
        <span style={css.status} data-raw-agent="held-draft">
          Your stopped message could not go back into the composer yet: “{held}”{' '}
          <button
            type="button"
            style={css.button}
            onClick={() =>
              void actions.copy(held).then((ok) => {
                if (!ok) return;
                heldRef.current = undefined;
                setHeld(undefined);
              })
            }
          >
            Copy it
          </button>
        </span>
      )}
      {status && (
        <span style={css.status} data-raw-agent="status" role="status">
          {status}
        </span>
      )}
      {mcpPanel &&
        actions.portal(
          <McpPanel
            sessionId={store.sessionId}
            api={api}
            actions={actions}
            displayName={name}
            onStart={() => void store.start()}
            onClose={closeMcp}
          />,
        )}
      {rewindPanel &&
        actions.portal(
          <RewindPanel
            sessionId={store.sessionId}
            api={api}
            actions={actions}
            store={store}
            {...(props.stores ? { stores: props.stores } : {})}
            onClose={closeRewind}
          />,
        )}
      {panel &&
        actions.portal(
          <SettingsPanel
            sessionId={store.sessionId}
            api={api}
            actions={actions}
            displayName={name}
            {...(info.settings?.keys ? { keys: info.settings.keys } : {})}
            onClose={close}
          />,
        )}
    </span>
  );
}
