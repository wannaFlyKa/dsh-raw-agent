// Session controls in the composer row (R1.4, D35-D38): model, effort and permission mode for
// this session only, plus the settings quick-access button (R1.3, D63). Renders nothing in a
// session that is not ours (the Host answers 404). Every choice goes to the plugin's own route,
// never to DSH's `selectModel` (K1).

import * as React from 'react';
import type { SessionChoiceRequest } from '@dsh-raw-agent/core';
import { SETTINGS, type RawAgentApi } from '../api.js';
import { restoreReturnedDrafts, type DraftTarget } from '../drafts.js';
import type { SessionControlStore } from '../session-store.js';
import {
  START_OPTION,
  askModels,
  effortSelect,
  modeSelect,
  modelSelect,
  statusLine,
  type SelectModel,
} from '../view-model.js';
import type { HostActions } from './actions.js';
import { SettingsPanel } from './settings-panel.js';
import { css } from './style.js';

export interface ControlsProps {
  store: SessionControlStore;
  api: RawAgentApi;
  actions: HostActions;
  /** DSH's session-slot `inputActions` (standard prop of a session slot component). */
  inputActions?: DraftTarget;
  /** Test seam: the draft poll interval. */
  draftPollMs?: number;
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
        <option key={o.value} value={o.value} disabled={o.disabled}>
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
  const draftNote =
    dropped > 0
      ? `The stopped message had ${dropped === 1 ? 'an attachment' : `${dropped} attachments`} that cannot go back into the composer; attach ${dropped === 1 ? 'it' : 'them'} again.`
      : undefined;
  const status = snap.error ?? statusLine(info) ?? draftNote ?? snap.note;
  const name = info.backend.displayName;
  const asks = askModels(info);
  return (
    <span style={css.bar} data-raw-agent="controls" ref={barRef}>
      {asks.map((a) => (
        <span key={a.id} style={css.ask} data-raw-agent="ask" data-ask={a.id} role="alert">
          <span>{a.heading}</span>
          {a.detail && <code style={css.askDetail}>{a.detail}</code>}
          {a.choices.map((c) => (
            <button
              key={c.id}
              type="button"
              style={css.button}
              data-raw-agent="ask-choice"
              data-choice={c.id}
              onClick={() => void store.answer(a.id, c.id)}
            >
              {c.label}
            </button>
          ))}
        </span>
      ))}
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
