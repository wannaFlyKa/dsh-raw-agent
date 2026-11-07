// Session controls in the composer row (R1.4, D35-D38): model, effort and permission mode for
// this session only, plus the settings quick-access button (R1.3, D63). Renders nothing in a
// session that is not ours (the Host answers 404). Every choice goes to the plugin's own route,
// never to DSH's `selectModel` (K1).

import * as React from 'react';
import type { SessionChoiceRequest } from '@dsh-raw-agent/core';
import { agentSelect } from '../agents-model.js';
import { SETTINGS, type RawAgentApi } from '../api.js';
import { restoreReturnedDrafts, takePrefill, type DraftTarget } from '../drafts.js';
import type { SessionControlStore, SessionStores } from '../session-store.js';
import {
  START_OPTION,
  effortChip,
  effortSelect,
  modeChip,
  modeSelect,
  modelChip,
  modelSelect,
  statusLine,
  type ChipModel,
  type SelectModel,
} from '../view-model.js';
import type { HostActions } from './actions.js';
import { AskPanel } from './ask-cards.js';
import { SettingsPanel } from './settings-panel.js';
import { latestSide, mcpButtonLabel } from '../commands-model.js';
import { McpPanel } from './mcp-panel.js';
import { SidePanel } from './side-panel.js';
import { exitBanner } from '../lifecycle-model.js';
import { RewindPanel } from './rewind-panel.js';
import { CHIP_CLASS, CHIP_CSS, STATUS_CLASS, css } from './style.js';
import type { PluginApi } from '../plugin-routes.js';

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
  /** R9.2: the plugin routes (the settings dialog shows the plugin access section). */
  plugin?: PluginApi;
  /**
   * DSH's session-slot `useProjection` (standard prop): the `agentPreset` value tells a session
   * that just picked our preset before our route knows it (0.1.1).
   */
  useProjection?: (key: string) => unknown;
  /** Test seam: the status note's fade timers. */
  fadeTimers?: FadeTimers;
}

const Chevron = () => (
  <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">
    <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

/**
 * A compact picker chip (0.1.1): the short value, a dot when it comes from the user's settings,
 * and an invisible native `<select>` on top, so the browser's list, the keyboard and `showPicker`
 * work as before. The full text is in the tooltip and the accessible name.
 */
function Picker(props: {
  model: SelectModel;
  chip: ChipModel;
  label: string;
  disabled: boolean;
  onPick(value: string): void;
  testId: string;
  selectRef?: React.Ref<HTMLSelectElement>;
}): React.ReactElement {
  const { model, chip } = props;
  const from = chip.fromSettings ? ', from your settings' : '';
  const tip = `${chip.fromSettings ? 'From your settings: ' : ''}${chip.full}. ${model.title}`;
  return (
    <span
      className={CHIP_CLASS}
      title={tip}
      data-raw-agent={`${props.testId}-chip`}
      {...(chip.risk ? { 'data-risk': chip.risk } : {})}
      {...(chip.fromSettings ? { 'data-from-settings': '' } : {})}
      {...(chip.sessionMode ? { 'data-session-mode': '' } : {})}
      {...(props.disabled ? { 'data-disabled': '' } : {})}
    >
      <span data-chip-text="" aria-hidden="true">
        {chip.text}
      </span>
      {chip.fromSettings && <span data-chip-dot="" aria-hidden="true" />}
      <Chevron />
      <select
        ref={props.selectRef}
        aria-label={`${props.label}: ${chip.full}${from}`}
        title={tip}
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
    </span>
  );
}

export interface FadeTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** How long a status note stays in the row before it fades (errors stay longer). */
export const NOTE_SHOW_MS = 5000;
export const ERROR_SHOW_MS = 12000;
const FADE_MS = 400;

/**
 * 0.1.1: a status note shows, then fades out of the row after a few seconds. It stays in the
 * `role="status"` live region (visually hidden), so screen readers still get it.
 */
// Wrapped: a browser's `setTimeout` called as a method of another object throws "Illegal invocation".
export const FADE_TIMERS: FadeTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function useFade(text: string | undefined, error: boolean, timers: FadeTimers = FADE_TIMERS) {
  const [phase, setPhase] = React.useState<'shown' | 'fading' | 'faded'>('shown');
  React.useEffect(() => {
    setPhase('shown');
    if (text === undefined) return undefined;
    const a = timers.set(() => setPhase('fading'), error ? ERROR_SHOW_MS : NOTE_SHOW_MS);
    const b = timers.set(() => setPhase('faded'), (error ? ERROR_SHOW_MS : NOTE_SHOW_MS) + FADE_MS);
    return () => {
      timers.clear(a);
      timers.clear(b);
    };
  }, [text, error, timers]);
  return phase;
}

/**
 * Focus a picker and open its list where the browser allows it (`showPicker`, which needs the
 * user's key press still active: the Enter that ran `/model`). Else the focus alone shows where it is.
 */
export function openPicker(el: { focus?(): void; showPicker?(): void; disabled?: boolean } | null): boolean {
  if (!el || el.disabled) return false;
  el.focus?.();
  try {
    el.showPicker?.();
    return true;
  } catch {
    return false; // no user activation, or the browser has no picker API: the focus stays
  }
}

export function SessionControls(props: ControlsProps): React.ReactElement | null {
  const { store, api, actions } = props;
  const snap = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [panel, setPanel] = React.useState(false);
  const close = React.useCallback(() => setPanel(false), []);
  const [mcpPanel, setMcpPanel] = React.useState(false);
  const closeMcp = React.useCallback(() => setMcpPanel(false), []);
  const [rewindPanel, setRewindPanel] = React.useState(false);
  const modelRef = React.useRef<HTMLSelectElement | null>(null);
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
      else if (panelName === 'model') openPicker(modelRef.current);
    }
    panelSeen.current = panelSeq;
  }, [panelSeq, panelName]);
  // R7.3: the side panel opens by itself for a new question; the button brings it back.
  const [sideShown, setSideShown] = React.useState(false);
  const [sideWanted, setSideWanted] = React.useState(false);
  const [sideFallback, setSideFallback] = React.useState(false);
  const onSideOpen = React.useCallback((open: boolean) => {
    setSideShown(open);
    if (!open) {
      setSideWanted(false);
      setSideFallback(false); // tabbed: the next open tries the sidebar tab again
    }
  }, []);
  // 0.1.2 (D89): the side chat is a tab of DSH's right sidebar where DSH has that API. The
  // inline box stays for older DSH versions, and for a sidebar that could not open the tab.
  const tabbed = actions.sideChatInSidebar?.() === true;
  const openSide = React.useCallback(
    (quiet?: boolean) => {
      if (tabbed && actions.openSideChat?.(store.sessionId, quiet ? { quiet: true } : {}) === true) return;
      setSideFallback(true);
      setSideWanted(true);
    },
    [tabbed, actions, store],
  );
  const inlineSide = !tabbed || sideFallback;
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
  // R9.2: `rawAgentClient.prefill` text. Composer: at the caret (never replacing the draft);
  // side question: into the side panel's box. Nothing is sent until the user presses Enter.
  const prefillSeq = snap.prefillRequest?.seq ?? 0;
  const prefillSeen = React.useRef(0);
  const [sidePrefill, setSidePrefill] = React.useState<{ text: string; seq: number } | undefined>();
  const [heldPrefill, setHeldPrefill] = React.useState<string | undefined>();
  React.useEffect(() => {
    const done = takePrefill(store.getSnapshot().prefillRequest, prefillSeen.current, inputActions);
    if (!done) return;
    prefillSeen.current = done.seq;
    if (done.kind === 'side') {
      // Tabbed: the tab takes the text from the store (`takeSidePrefill`) when it mounts.
      if (tabbed && actions.openSideChat?.(store.sessionId) === true) return;
      if (tabbed) store.takeSidePrefill();
      setSideFallback(true);
      setSidePrefill({ text: done.text, seq: done.seq });
      setSideWanted(true);
    } else setHeldPrefill(done.kind === 'held' ? done.text : undefined);
  }, [prefillSeq, inputActions, store, tabbed, actions]);
  // 0.1.2: in the tab, a new side question (typed `/btw`, or asked by another plugin) opens the
  // tab, as it opened the inline box. The questions there when the page loaded do not.
  const latestSideId = snap.status === 'ready' ? (latestSide(info?.view.side)?.id ?? null) : undefined;
  const sideBaseline = React.useRef<string | null | undefined>(undefined);
  React.useEffect(() => {
    if (!tabbed || latestSideId === undefined) return;
    if (sideBaseline.current === undefined) {
      sideBaseline.current = latestSideId;
      return;
    }
    if (latestSideId === null || latestSideId === sideBaseline.current) return;
    sideBaseline.current = latestSideId;
    openSide(true);
  }, [tabbed, latestSideId, openSide]);
  // DSH's own permission control does not apply to this agent: hide it while our controls show
  // (only in our sessions; a Standard session renders no controls, so its seat stays).
  // 0.1.1: DSH's `agentPreset` projection says the session is ours before our route does (a new
  // session that just picked our preset): hide the seat at once, and read the route again.
  const barRef = React.useRef<HTMLSpanElement | null>(null);
  const preset = props.useProjection ? props.useProjection('agentPreset') : undefined;
  const presetOurs = actions.isOurPreset?.(preset) === true;
  React.useEffect(() => store.notePreset(presetOurs), [store, presetOurs]);
  const ready = snap.status === 'ready' && info !== undefined;
  const seatOff = ready || (presetOurs && snap.status !== 'error');
  React.useEffect(() => {
    if (!seatOff || !actions.hideNativeSeat) return undefined;
    const hidden = actions.hideNativeSeat(barRef.current);
    return () => hidden.undo();
  }, [seatOff, ready, actions]);
  const draftNote =
    dropped > 0
      ? `The stopped message had ${dropped === 1 ? 'an attachment' : `${dropped} attachments`} that cannot go back into the composer; attach ${dropped === 1 ? 'it' : 'them'} again.`
      : undefined;
  const status = info
    ? (snap.error ?? statusLine(info, { exitShown: exitBanner(info) !== undefined }) ?? draftNote ?? snap.note)
    : undefined;
  // Errors (a refused choice, a warning notice such as a refused `/permission`) stay longer.
  const notice = info?.view.live.notice;
  const statusError =
    status !== undefined && (status === snap.error || (notice?.level === 'warning' && status.endsWith(notice.text)));
  const phase = useFade(status, statusError, props.fadeTimers);
  if (snap.status !== 'ready' || !info)
    return seatOff ? <span data-raw-agent="controls-pending" ref={barRef} style={{ display: 'none' }} /> : null;
  const choose = (c: SessionChoiceRequest) => void store.choose(c);
  const model = modelSelect(info);
  const effort = effortSelect(info);
  const mode = modeSelect(info);
  const agent = agentSelect(info);
  const name = info.backend.displayName;
  const asks = info.view.asks ?? [];
  const inComposer =
    typeof props.asksInComposer === 'function' ? props.asksInComposer() : props.asksInComposer === true;
  return (
    <span style={css.bar} data-raw-agent="controls" ref={barRef}>
      <style data-raw-agent="chip-style">{CHIP_CSS}</style>
      {asks.length > 0 && !inComposer && (
        <span style={css.ask} data-raw-agent="ask-inline">
          <AskPanel store={store} actions={actions} />
        </span>
      )}
      <Picker
        testId="model"
        selectRef={modelRef}
        label={`${name} model for this session`}
        model={model}
        chip={modelChip(info)}
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
          chip={effortChip(info)!}
          disabled={snap.busy}
          onPick={(value) => value !== effort.value && choose({ effort: value === SETTINGS ? null : value })}
        />
      )}
      <Picker
        testId="mode"
        label={`${name} permission mode for this session`}
        model={mode}
        chip={modeChip(info)}
        disabled={snap.busy}
        onPick={(value) => value !== mode.value && choose({ mode: value })}
      />
      {agent && (
        <Picker
          testId="agent"
          label={`${name} main-thread agent for this new session`}
          model={agent}
          chip={{
            text: agent.options.find((o) => o.value === agent.value)?.label ?? agent.value,
            fromSettings: false,
            full: agent.options.find((o) => o.value === agent.value)?.label ?? agent.value,
          }}
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
          className={CHIP_CLASS}
          data-raw-agent="mcp-button"
          title={`${name} MCP servers and commands`}
          onClick={() => setMcpPanel(true)}
        >
          {mcpButtonLabel(info.view.mcp)}
        </button>
      )}
      {api.askSide && tabbed && (
        <button
          type="button"
          className={CHIP_CLASS}
          data-raw-agent="side-button"
          title="Open the side chat in the right sidebar (not part of the conversation)"
          aria-label={`Side chat with ${name} (not part of the conversation)`}
          onClick={() => openSide()}
        >
          Side chat
        </button>
      )}
      {!tabbed && (info.view.side?.entries.length ?? 0) > 0 && !sideShown && (
        <button
          type="button"
          className={CHIP_CLASS}
          data-raw-agent="side-button"
          title="Show the side questions (not part of the conversation)"
          onClick={() => setSideWanted(true)}
        >
          Side questions
        </button>
      )}
      {api.askSide && inlineSide && (
        <SidePanel
          store={store}
          api={api}
          actions={actions}
          displayName={name}
          open={sideWanted}
          onOpenChange={onSideOpen}
          {...(sidePrefill ? { prefill: sidePrefill } : {})}
        />
      )}
      {api.rewind && (
        <button
          type="button"
          className={CHIP_CLASS}
          data-raw-agent="rewind-button"
          title={`Go back to an earlier message: restore the conversation (a new branch), the code, or both`}
          onClick={() => setRewindPanel(true)}
        >
          Rewind
        </button>
      )}
      <button
        type="button"
        className={CHIP_CLASS}
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
      {heldPrefill !== undefined && (
        <span style={css.status} data-raw-agent="held-prefill">
          Text from another plugin could not go into the composer: “{heldPrefill}”{' '}
          <button
            type="button"
            style={css.button}
            onClick={() =>
              void actions.copy(heldPrefill).then((ok) => {
                if (ok) setHeldPrefill(undefined);
              })
            }
          >
            Copy it
          </button>{' '}
          <button type="button" style={css.button} onClick={() => setHeldPrefill(undefined)}>
            Dismiss
          </button>
        </span>
      )}
      {status && (
        <span
          className={STATUS_CLASS}
          data-raw-agent="status"
          role="status"
          aria-live="polite"
          data-level={statusError ? 'error' : 'info'}
          {...(phase === 'fading' ? { 'data-fading': '' } : {})}
          {...(phase === 'faded' ? { 'data-faded': '' } : {})}
        >
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
            onServers={() => void store.refresh()}
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
            {...(props.plugin ? { plugin: props.plugin } : {})}
            onClose={close}
          />,
        )}
    </span>
  );
}
