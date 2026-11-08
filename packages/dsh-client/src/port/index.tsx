// The only module in dsh-client that touches DSH (D79): slot names, the right-sidebar resource
// address, the terminal tab kind and portals. DSH types are local structural copies; there is no
// runtime import of DSH (D65). React and react-dom come from DSH's shared module table.

import * as React from 'react';
import { createPortal } from 'react-dom';
import { wakeTriggerOf, type ChildAddress, type WakeTrigger } from '../agents-model.js';
import { createApi, type FetchFn, type RawAgentApi } from '../api.js';
import { ChildLinks } from '../child-links.js';
import { SessionStores, type SessionControlStore } from '../session-store.js';
import { modePopupOptions, type ModePopupOption } from '../view-model.js';
import { UsageReaders } from '../usage-reader.js';
import type { HostActions } from '../ui/actions.js';
import { AgentsHeader } from '../ui/agents-panel.js';
import { AskPanel } from '../ui/ask-cards.js';
import { SessionControls } from '../ui/controls.js';
import { SideChatTab } from '../ui/side-chat-tab.js';
import { ContextPill } from '../ui/usage-panel.js';
import { WakeTriggerCard } from '../ui/wake-card.js';
import { WorkflowNodeView } from '../ui/workflow-panel.js';
import { RAW_AGENT_CLIENT_SERVICE, type ToolViewPack } from '@dsh-raw-agent/core';
import { createRawAgentClientService } from '../client-service.js';
import { createPluginApi, type PluginApi } from '../plugin-routes.js';
import { GrantsPanel } from '../ui/grants-panel.js';
import { AccessNote } from '../ui/access-note.js';
import { PluginExtras } from '../ui/plugin-extras.js';
import { localCommandOf, messageText, type LocalCommandData } from '../commands-model.js';
import { LocalCommandText, LocalCommandView } from '../ui/local-command.js';
import { commandMarkerOf, type CommandMarker } from '../lifecycle-model.js';
import { CommandMarkerView } from '../ui/command-marker.js';
import { LifecycleBanner } from '../ui/lifecycle-banner.js';
import { agentCommandSource } from './command-source.js';
import { registerToolViews } from './tool-views.js';

/** DSH versions this port was tested against (D79). */
export const TESTED_DSH_VERSIONS: readonly string[] = Object.freeze(['0.2.2-rc.1']);

/** Compact controls at the left of the composer tool row (`P/dsh-client-ui-conversation`, slots.d.ts). */
export const CONTROLS_SLOT = 'conversation.input.left';
export const CONTROLS_ENTRY_ID = 'raw-agent-session-controls';
/**
 * DSH's own permission seat (`P/dsh-client-ui-conversation/lib/client.js:22100`, rendered from
 * `P/dsh-client-ui-permission-presets`). Every slot outlet carries `data-slot="<key>"`
 * (`P/dsh-client-ui-renderer/lib/client.js:1124`, a `display: contents` anchor).
 */
export const NATIVE_PERMISSION_SLOT = 'conversation.input.permission';
/**
 * DSH's own model seat at the right of the composer row (`P/dsh-client-ui-conversation/lib/client.js:22110`,
 * rendered from `P/dsh-client-ui-model-selection`).
 */
export const NATIVE_MODEL_SLOT = 'conversation.input.model';
/** The DSH seats hidden in our sessions, in the order they are looked for. */
export const HIDDEN_NATIVE_SLOTS: readonly string[] = Object.freeze([NATIVE_PERMISSION_SLOT, NATIVE_MODEL_SLOT]);
/** Set on the nearest composer ancestor of our controls that holds a seat; a style rule then hides the seat. */
export const SEAT_HIDDEN_ATTR = 'data-raw-agent-hides-seat';
const SEAT_STYLE_ID = 'raw-agent-hide-native-seat';
/** One rule for every hidden seat, each only under a marked ancestor. */
export const SEAT_HIDING_RULE = `${HIDDEN_NATIVE_SLOTS.map((s) => `[${SEAT_HIDDEN_ATTR}] [data-slot="${s}"]`).join(',')}{display:none !important}`;
/** How far up from our controls the composer row may be. */
const SEAT_SEARCH_DEPTH = 8;

/** The parts of a DOM element and document this uses (structural, so tests need no DOM). */
export interface SeatElement {
  parentElement: SeatElement | null;
  querySelector(selector: string): unknown;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}
export interface SeatDocument {
  getElementById(id: string): unknown;
  createElement(tag: string): { id: string; textContent: string | null };
  head: { appendChild(node: unknown): unknown } | null;
}

/**
 * Hide DSH's permission and model seats in this composer only. Neither acts on our agent:
 * - The permission seat changes DSH's approval policy, which our agent ignores (D38 r3), so in
 *   our sessions it shows a mode that is not applied (M1 verify 2: "Read Only" while Claude wrote
 *   files in Auto).
 * - The model seat saves the DSH profile default (`selectModel`, K1) and cannot pick our provider.
 *   Our model chip is the session's model control (D36).
 * Both are single DSH slots that cannot be replaced per session (K1). For each seat, the nearest
 * ancestor of our controls that holds it gets a marker, and one style rule hides the seats under a
 * marker. The undo removes the markers (a Standard session in the same composer shows the seats
 * again). DOM shape **unverified** on DSH versions other than TESTED_DSH_VERSIONS.
 */
export function hideNativeSeat(
  el: unknown,
  doc: SeatDocument | undefined = globalThis.document as unknown as SeatDocument | undefined,
): { found: boolean; undo(): void } {
  const none = { found: false, undo: () => {} };
  const start = el as SeatElement | null | undefined;
  if (!start || typeof start !== 'object' || !('parentElement' in start)) return none;
  const hosts: SeatElement[] = [];
  for (const slot of HIDDEN_NATIVE_SLOTS) {
    const selector = `[data-slot="${slot}"]`;
    let at = start.parentElement;
    for (let i = 0; at && i < SEAT_SEARCH_DEPTH; i++, at = at.parentElement) {
      if (!at.querySelector(selector)) continue;
      if (!hosts.includes(at)) hosts.push(at);
      break;
    }
  }
  if (hosts.length === 0) return none;
  if (doc) {
    // A style element left by an older build in the same page gets the current rule.
    const old = doc.getElementById(SEAT_STYLE_ID) as { textContent: string | null } | null;
    if (old) {
      if (old.textContent !== SEAT_HIDING_RULE) old.textContent = SEAT_HIDING_RULE;
    } else {
      const style = doc.createElement('style');
      style.id = SEAT_STYLE_ID;
      style.textContent = SEAT_HIDING_RULE;
      doc.head?.appendChild(style);
    }
  }
  for (const host of hosts) host.setAttribute(SEAT_HIDDEN_ATTR, '');
  return { found: true, undo: () => hosts.forEach((host) => host.removeAttribute(SEAT_HIDDEN_ATTR)) };
}

/** The right sidebar's terminal tab kind (`P/dsh-client-ui-sidebar-terminal`). */
export const TERMINAL_TAB_KIND = 'terminal';

/** What this port uses of the client Cordis context (structural, D65). */
export interface ClientContext {
  /** Cordis `ctx.provide(name, value)`: a client service owned by this plugin's fiber. */
  provide?(name: string, value: unknown): unknown;
  slots: {
    inject(key: string, callback: () => (() => void) | Iterable<() => void>): () => void;
    register(options: Record<string, unknown>, component: React.ComponentType<never>): () => void;
  };
  get(name: string): unknown;
  effect?(fn: () => () => void, label?: string): void;
  /** Cordis: run `fn` while the named services exist (optional services). */
  inject?(deps: string[], fn: (scope: ClientContext & Record<string, unknown>) => void): unknown;
}

// --- D77: the tool card an ask is about ---------------------------------------------------------

/**
 * DSH's tool wrappers carry `data-chat-call-id="<id>"` (`P/dsh-client-ui-tool/README.md`,
 * ToolCallTree: "preserves the data-chat-anchor-key and data-chat-call-id DOM contract").
 */
export const TOOL_CALL_ATTR = 'data-chat-call-id';
/** Set on a tool card while its ask waits; one style rule outlines it. */
export const TOOL_WAITING_ATTR = 'data-raw-agent-waiting';
const TOOL_STYLE_ID = 'raw-agent-tool-waiting';

/** The parts of a document the tool-card marker uses (structural, so tests need no DOM). */
export interface MarkDocument extends SeatDocument {
  querySelector(selector: string): unknown;
}
interface MarkElement {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute?(name: string): string | null;
  scrollIntoView?(options?: unknown): void;
}

const cssString = (v: string) => `"${v.replace(/["\\]/g, (c) => `\\${c}`)}"`;

/** The tool card of one call on the page, if DSH has drawn it. */
export function findToolCard(
  callId: string,
  doc: MarkDocument | undefined = globalThis.document as unknown as MarkDocument | undefined,
): MarkElement | undefined {
  const el = doc?.querySelector(`[${TOOL_CALL_ATTR}=${cssString(callId)}]`) as MarkElement | null | undefined;
  return el && typeof el.setAttribute === 'function' ? el : undefined;
}

/**
 * Mark the tool card of `callId` as waiting for the user (D77). The card itself lives in the
 * composer; this outline and its label tie it to the tool card. Undo removes the mark.
 */
export function markToolCard(
  callId: string,
  label: string,
  doc: MarkDocument | undefined = globalThis.document as unknown as MarkDocument | undefined,
): { found: boolean; undo(): void } {
  const el = findToolCard(callId, doc);
  if (!el) return { found: false, undo: () => {} };
  if (doc && !doc.getElementById(TOOL_STYLE_ID)) {
    const style = doc.createElement('style');
    style.id = TOOL_STYLE_ID;
    style.textContent =
      `[${TOOL_WAITING_ATTR}]{outline:2px solid var(--raw-agent-ask-border, var(--dsw-alias-state-warn-primary, orange));` +
      `outline-offset:2px;border-radius:8px}`;
    doc.head?.appendChild(style);
  }
  el.setAttribute(TOOL_WAITING_ATTR, label);
  return { found: true, undo: () => el.removeAttribute(TOOL_WAITING_ATTR) };
}

// --- D39: the pending interaction and the composer takeover --------------------------------------

/** Our pending-interaction kind (`SessionPendingInteractionBase.kind`, P/dsh-client-ui-session). */
export const ASK_INTERACTION_KIND = 'raw-agent-ask';
/**
 * Precedence among pending-interaction domains (larger wins). DSH's approvals use 0, its
 * questions 1 and plan reviews 2 (`P/dsh-client-ui-approval`, `P/dsh-client-ui-user-questions`);
 * none of those come from our agent, so the value only orders us against them.
 */
export const ASK_INTERACTION_PRECEDENCE = 1;

export interface AskInteraction {
  readonly key: string;
  readonly kind: typeof ASK_INTERACTION_KIND;
  readonly sessionId: string;
  readonly askId: string;
  /**
   * The session whose store holds the ask, when it differs from `sessionId`: a subagent's ask is
   * also published on the subagent's own child session (R6.1), but it lives in the parent's store.
   */
  readonly storeSessionId?: string;
}

/**
 * Our `conversation.composer` chain priority. DSH tries chain entries in ASCENDING priority order
 * (the slot catalog: "Entries are tried in ascending order; the first non-null result wins").
 * ui-subagent's read-only one-shot composer sits at -10 and matches every one-shot child view,
 * so with a larger value our card never took over a child's composer (seen live, M3). Our
 * selector matches only our own interaction kind, so going first changes nothing else.
 */
export const ASK_COMPOSER_PRIORITY = -20;

export type PublishInteraction = (interaction: AskInteraction, delegate: () => Promise<void>) => () => void;

/**
 * Publish each session's oldest open ask as a DSH pending interaction, so DSH's composer chain
 * elects our card (and its session status shows the wait). One per session; a new key for a new
 * ask, as DSH requires. Watches stores without making them poll (`observe`).
 */
export function publishAsks(stores: SessionStores, publish: PublishInteraction): () => void {
  const live = new Map<string, { key: string; remove(): void }>();
  /**
   * Child-session publications, apart from `live`: a child session has its own (absent) store, and
   * its sync must not remove the ask its parent's store published on it (seen live: it churned).
   */
  const childLive = new Map<string, { key: string; remove(): void }>();
  const offs: Array<() => void> = [];
  /** Child sessions with a published ask, per parent store (R6.1: the ask shows on the child). */
  const childKeys = new Map<string, Set<string>>();
  const syncChildren = (store: SessionControlStore) => {
    const snap = store.getSnapshot();
    if (snap.status === 'error' || snap.status === 'loading') return;
    const view = snap.status === 'ready' ? snap.info?.view : undefined;
    const wanted = new Map<string, { key: string; askId: string }>();
    const asks = [...(view?.asks ?? [])].sort((a, b) => a.at - b.at);
    for (const a of asks) {
      if (a.agent !== 'child' || a.agentId === undefined) continue;
      const host = view?.children?.find((c) => c.id === a.agentId)?.hostSessionId;
      if (host === undefined || wanted.has(host)) continue;
      wanted.set(host, { key: `${a.id}${a.state === 'waiting' ? ':waiting' : ''}@child`, askId: a.id });
    }
    const mine = childKeys.get(store.sessionId) ?? new Set<string>();
    for (const host of [...mine]) {
      const cur = childLive.get(host);
      if (wanted.get(host)?.key === cur?.key) continue;
      cur?.remove();
      childLive.delete(host);
      mine.delete(host);
    }
    for (const [host, w] of wanted) {
      if (childLive.has(host)) continue;
      try {
        const remove = publish(
          { key: w.key, kind: ASK_INTERACTION_KIND, sessionId: host, askId: w.askId, storeSessionId: store.sessionId },
          async () => {},
        );
        childLive.set(host, { key: w.key, remove });
        mine.add(host);
      } catch {
        // A DSH without this seam: the child's header strip offers the card.
      }
    }
    childKeys.set(store.sessionId, mine);
  };
  const sync = (store: SessionControlStore) => {
    syncChildren(store);
    const snap = store.getSnapshot();
    const id = store.sessionId;
    // Keep the card through a failed read; drop it when the session has no asks or is not ours.
    if (snap.status === 'error' || snap.status === 'loading') return;
    const asks = [...(snap.info?.view.asks ?? [])].sort((a, b) => a.at - b.at);
    const first = snap.status === 'ready' ? asks[0] : undefined;
    const key = first ? `${first.id}${first.state === 'waiting' ? ':waiting' : ''}` : undefined;
    const cur = live.get(id);
    if (cur?.key === key) return;
    cur?.remove();
    live.delete(id);
    if (!first || key === undefined) return;
    try {
      const remove = publish({ key, kind: ASK_INTERACTION_KIND, sessionId: id, askId: first.id }, async () => {
        // Plugin teardown: the ask stays open on the Host; a reloaded client shows it again.
      });
      live.set(id, { key, remove });
    } catch {
      // A DSH without this seam: the controls row shows the card.
    }
  };
  offs.push(
    stores.each((store) => {
      offs.push(store.observe(() => sync(store)));
      sync(store);
    }),
  );
  return () => {
    for (const off of offs.splice(0)) off();
    for (const p of [...live.values(), ...childLive.values()]) p.remove();
    live.clear();
    childLive.clear();
  };
}

/** The composer chain's owner currency (`P/dsh-client-ui-conversation/README.md`, ComposerChainProps). */
export interface ComposerOwner {
  sessionId?: string;
  pendingInteraction?: { kind?: string } | undefined;
}

export function selectAsk(owner: ComposerOwner): AskInteraction | null {
  const p = owner.pendingInteraction as AskInteraction | undefined;
  return p?.kind === ASK_INTERACTION_KIND && (owner.sessionId === undefined || p.sessionId === owner.sessionId)
    ? p
    : null;
}

/** The composer takeover: the session's asks as cards, in place of the input (D39). */
export function AskComposer(props: {
  matched: AskInteraction;
  stores: SessionStores;
  actions: HostActions;
}): React.ReactElement {
  return (
    <div data-raw-agent="ask-composer" style={{ padding: '4px 0' }}>
      <AskPanel
        store={props.stores.get(props.matched.storeSessionId ?? props.matched.sessionId)}
        actions={props.actions}
        askId={props.matched.askId}
        {...(props.matched.storeSessionId !== undefined
          ? { only: (a: { id: string }) => a.id === props.matched.askId }
          : {})}
      />
    </div>
  );
}

// --- R1.4 leftover: DSH's `/permission` popup -----------------------------------------------------

/** The command name DSH's preset popup decorates (`P/dsh-client-ui-permission-presets/lib/client.js:1034`). */
export const PRESET_DECORATION = 'permission';

interface DecorationLike {
  available(session: { sessionId?: string }): boolean;
}

/** The popup DSH's command runtime draws for a decoration (`PopupSelectSpec`, ui-commands contract). */
export interface ModePopupSpec {
  kind: 'popupSelect';
  searchLabels?(): { placeholder: string; empty: string; noResults: string };
  options(session: { sessionId?: string }, signal?: unknown): Promise<readonly ModePopupOption[]>;
  onSelect(option: { id: string }, session: { sessionId?: string }): void | Promise<void>;
}

/**
 * 0.1.1: the `/permission` popup of our sessions: the agent's own modes only, and a pick goes the
 * mode chip's way (`choose`, `setPermissionMode`, this session only). A blocked mode is not sent;
 * the status line says why.
 */
export function modePopup(stores: SessionStores): ModePopupSpec {
  const infoOf = async (sessionId: string) => {
    const store = stores.get(sessionId);
    if (store.getSnapshot().info === undefined) await store.refresh();
    return store.getSnapshot().info;
  };
  return {
    kind: 'popupSelect',
    searchLabels: () => ({
      placeholder: 'Search permission modes',
      empty: 'The agent has not listed its permission modes yet.',
      noResults: 'No permission mode matches.',
    }),
    async options(session) {
      const info = typeof session?.sessionId === 'string' ? await infoOf(session.sessionId) : undefined;
      if (!info) throw new Error('the agent is not attached to this session yet; try again in a moment');
      return modePopupOptions(info);
    },
    async onSelect(option, session) {
      if (typeof session?.sessionId !== 'string') return;
      const store = stores.get(session.sessionId);
      const info = store.getSnapshot().info;
      const row = info ? modePopupOptions(info).find((o) => o.id === option.id) : undefined;
      if (row?.blocked !== undefined) {
        store.showNote(`${row.label}: ${row.blocked} Nothing changed.`);
        return;
      }
      if (row?.active) return;
      await store.choose({ mode: option.id });
    },
  };
}

/**
 * Keep DSH's preset popup out of our sessions (R1.4 leftover, CLAUDE.md §4).
 *
 * DSH's client hangs a popup on the host command `permission` (`command.decorate`, one per name;
 * a second one throws, `P/dsh-client-ui-commands/lib/client.js:1424`). In our sessions the host
 * command is our own (the Host shadows it per agent), but the popup still opened on a bare
 * `/permission` or a menu pick and offered DSH presets ("Workspace Write", "Full access"), levels
 * the agent never applies. The command runtime reads the decoration through `live.decorations.get`
 * (lines 1521, 1602), asks `available(session)` and then reads `ui` on the same object, in one
 * synchronous step. For our sessions only, the decoration we hand back is available and its `ui`
 * is `ours` (0.1.1: a popup of the agent's own modes; without it, no popup and `/permission` is a
 * plain host command with an argument). Other sessions keep DSH's popup. A typed argument
 * (`/permission plan`) still goes to our host command.
 *
 * This reads a DSH internal (`commandUi.live.decorations`, a `Map`). If the shape is not there,
 * nothing changes and the caller is told (returns `undefined`).
 */
export function guardPresetDecoration(
  commandUi: unknown,
  isOurs: (sessionId: string) => boolean,
  ours?: ModePopupSpec,
): (() => void) | undefined {
  const map = (commandUi as { live?: { decorations?: unknown } } | undefined)?.live?.decorations;
  if (!(map instanceof Map)) return undefined;
  const base = map.get as (key: unknown) => unknown;
  const isOur = (session: { sessionId?: string } | undefined) =>
    typeof session?.sessionId === 'string' && isOurs(session.sessionId);
  const get = function (this: Map<unknown, unknown>, key: unknown): unknown {
    const found = base.call(this, key) as (DecorationLike & { ui?: unknown }) | undefined;
    if (key !== PRESET_DECORATION || typeof found?.available !== 'function') return found;
    // A fresh wrapper per read keeps the `available` answer and the `ui` read together.
    let asked: { sessionId?: string } | undefined;
    return {
      ...found,
      available: (session: { sessionId?: string }) => {
        asked = session;
        if (isOur(session)) return ours !== undefined;
        return found.available(session);
      },
      get ui() {
        return ours !== undefined && isOur(asked) ? ours : found.ui;
      },
    };
  };
  Object.defineProperty(map, 'get', { value: get, configurable: true, writable: true });
  return () => {
    if ((map as { get: unknown }).get === get) delete (map as { get?: unknown }).get;
  };
}

// --- M6 leftover: DSH's `/model` popup ----------------------------------------------------------

/** The command DSH's model popup contributes (`P/dsh-client-ui-model-selection/lib/client.js:2030`). */
export const MODEL_CONTRIBUTION = 'model';

interface ContributionLike {
  available(session: { sessionId?: string }): boolean;
  ui: unknown;
}

/**
 * `/model` + Enter (or the menu's "Model" row) in one of our sessions opens our own model picker,
 * as the terminal app's `/model` opens its picker (M8 polish, M6 leftover).
 *
 * DSH's model-selection plugin contributes `/model` as a popup over DSH's model catalog
 * (`command.register`, kind `popupSelect`). Our catalog lists no model rows (CLAUDE.md §4), so in
 * our sessions it opened "No models available." and a pick there would save DSH's profile default,
 * not the agent's model. The command runtime reads the contribution through
 * `live.contributions.get` on Enter and on a menu pick (`P/dsh-client-ui-commands/lib/client.js`
 * 1511, 1586). For our sessions only, the contribution we hand back is an `action` that removes the
 * typed token and calls `open(sessionId)`; other sessions keep DSH's popup. The menu row itself
 * (read through `values()`) stays as DSH draws it.
 *
 * This reads a DSH internal (`commandUi.live.contributions`, a `Map`), like the `/permission` guard.
 * If the shape is not there, nothing changes (returns `undefined`).
 */
export function guardModelContribution(
  commandUi: unknown,
  isOurs: (sessionId: string) => boolean,
  open: (sessionId: string) => void,
): (() => void) | undefined {
  const map = (commandUi as { live?: { contributions?: unknown } } | undefined)?.live?.contributions;
  if (!(map instanceof Map)) return undefined;
  const base = map.get as (key: unknown) => unknown;
  const ours = (session: { sessionId?: string } | undefined): session is { sessionId: string } =>
    typeof session?.sessionId === 'string' && isOurs(session.sessionId);
  const action = {
    kind: 'action' as const,
    run: (session: { sessionId?: string }) => {
      if (ours(session)) open(session.sessionId);
    },
  };
  const get = function (this: Map<unknown, unknown>, key: unknown): unknown {
    const found = base.call(this, key) as ContributionLike | undefined;
    if (key !== MODEL_CONTRIBUTION || typeof found?.available !== 'function') return found;
    // The runtime asks `available(session)` and then reads `ui` on the same object, in one
    // synchronous step (lines 1512-1513, 1587-1590). A fresh wrapper per read keeps that pair together.
    let asked: { sessionId?: string } | undefined;
    return {
      ...found,
      available: (session: { sessionId?: string }) => {
        asked = session;
        return ours(session) || found.available(session);
      },
      get ui() {
        return ours(asked) ? action : found.ui;
      },
    };
  };
  Object.defineProperty(map, 'get', { value: get, configurable: true, writable: true });
  return () => {
    if ((map as { get: unknown }).get === get) delete (map as { get?: unknown }).get;
  };
}

/** A session is ours once our route answered for it (the controls store is `ready`). */
export function isOurSession(stores: SessionStores, sessionId: string): boolean {
  const store = stores.peek(sessionId);
  const snap = store?.getSnapshot();
  return (snap?.info !== undefined && snap.status !== 'absent') || store?.presetOurs === true;
}

/** Our preset ids (`raw-agent-<kind>`, D81; dsh-host `presetIdFor`). */
export const OUR_PRESET_PREFIX = 'raw-agent-';
export const isOurPreset = (preset: unknown): boolean =>
  typeof preset === 'string' && preset.startsWith(OUR_PRESET_PREFIX);

// --- D38: Shift+Tab, the agent's "next mode" key -------------------------------------------------

/** The fixed shortcut row (`P/dsh-client-shortcuts`, `registerFixed`). */
export const MODE_SHORTCUT_ID = 'raw-agent.permission-mode.next';

/** One locally arbitrated key press (`ShortcutFixedInput`, P/dsh-client-shortcuts types). */
export type FixedInput =
  | {
      type: 'keydown';
      gesture: {
        code: string;
        control: boolean;
        alt: boolean;
        shift: boolean;
        meta: boolean;
        repeat: boolean;
        composing: boolean;
        defaultPrevented: boolean;
      };
      context: { region: string; modal: string | null; target: { closest(selector: string): unknown } | null };
      consume(): void;
    }
  | { type: 'reset' };

/**
 * Shift+Tab in the composer of one of our sessions switches to the next permission mode, as in
 * the agent's terminal app (Claude: default → accept edits → plan → …). Only plain Shift+Tab that
 * nothing else took (the command menu uses it to close itself), outside modals and terminals.
 * A session that is not ours, or has no mode ring, keeps the browser's own Shift+Tab.
 */
export function modeKeyHandler(stores: SessionStores): (input: FixedInput) => void {
  return (input) => {
    if (input.type !== 'keydown') return;
    const { gesture: g, context } = input;
    if (g.code !== 'Tab' || !g.shift || g.control || g.alt || g.meta) return;
    if (g.repeat || g.composing || g.defaultPrevented) return;
    if (context.modal !== null || context.region === 'terminal' || !context.target) return;
    const occurrence = context.target.closest('[data-conversation-session]') as {
      getAttribute?(n: string): string | null;
      dataset?: Record<string, string | undefined>;
    } | null;
    if (!occurrence || !context.target.closest('[data-conversation-region="composer"]')) return;
    const sessionId = occurrence.dataset?.conversationSession ?? occurrence.getAttribute?.('data-conversation-session');
    if (!sessionId) return;
    const store = stores.peek(sessionId);
    if (store?.cycleMode()) input.consume();
  };
}

interface ShortcutsService {
  registerFixed(command: {
    id: string;
    label: () => string;
    keys: readonly string[];
    bindings: readonly [{ code: string; modifiers: string[] }];
    group: 'input';
  }): () => void;
  observeFixedInput(listener: (input: FixedInput) => void): () => void;
}

interface UiSessionService {
  registerPendingInteraction(precedence: (interaction: AskInteraction) => number): PublishInteraction;
}

interface SidebarRight {
  openResourceIn?(sessionId: string, address: string): void;
  openTabIn?(sessionId: string, kind: string): void;
  openResource?(address: string, options?: { kind?: string; preferNewPane?: boolean }): void;
  /** The session on screen (`ISidebarRight.mounted`). */
  mounted?: { getSnapshot?(): string | undefined };
  /** The on-screen session's active tab (`ISidebarRight.active`). */
  active?(): { id: string; kind: string } | undefined;
  isExpanded?(): boolean;
}

// --- 0.1.2 (D89): the side chat tab in DSH's right sidebar ---------------------------------------

/**
 * Our right-sidebar page type (`ctx.sidebarRightTabs.register`, `P/dsh-client-ui-sidebar-right`
 * README "Extension seats"; the same public two-stage path `dsh-client-ui-schedule` uses for its
 * task tab). The id is the key our body registers under in `sidebar.right.pane.tab`.
 */
export const SIDE_CHAT_TAB_ID = 'dsh-raw-agent/side-chat';
export const SIDE_CHAT_TAB_KIND = 'raw-agent-side-chat';
export const SIDE_CHAT_TAB_SLOT = 'sidebar.right.pane.tab';
export const SIDE_CHAT_TITLE = 'Side chat';

/** What this port uses of `ctx.sidebarRightTabs` (structural, D65). */
export interface SidebarRightTabsService {
  register(definition: {
    id: string;
    kind: string;
    priority?: 'extension' | 'builtin' | 'fallback';
    keepMounted?: boolean;
    title(address: string): string;
  }): () => void;
}

/**
 * The page type. No guide entry: the guide is the same in every session, and the side chat
 * belongs to our sessions only, so it opens from our button and commands. `keepMounted` keeps a
 * half-typed question when the user looks at another tab or session.
 */
export function sideChatTabDefinition(): Parameters<SidebarRightTabsService['register']>[0] {
  return {
    id: SIDE_CHAT_TAB_ID,
    kind: SIDE_CHAT_TAB_KIND,
    priority: 'extension',
    keepMounted: true,
    title: () => SIDE_CHAT_TITLE,
  };
}

/**
 * Whether our tab type is registered (set by `mountClient`, read by the host actions). DSH may
 * provide the sidebar after our controls first render, so the controls listen for the change.
 */
export interface SideChatState {
  on: boolean;
  listeners?: Set<() => void>;
}

function setSideChat(state: SideChatState, on: boolean): void {
  if (state.on === on) return;
  state.on = on;
  for (const fn of [...(state.listeners ?? [])]) fn();
}

/**
 * Open (or reveal) the side chat tab of a session. `quiet`: leave a tab alone that is already
 * the active one in an open sidebar of the on-screen session (the user is typing in it). A
 * failed open (a DSH that refuses it) answers false, so the caller shows the inline box.
 */
export function openSideChatTab(
  sidebar: SidebarRight | undefined,
  state: SideChatState,
  sessionId: string,
  options: { quiet?: boolean } = {},
): boolean {
  if (!state.on || typeof sidebar?.openTabIn !== 'function') return false;
  try {
    if (options.quiet && sidebar.mounted?.getSnapshot?.() === sessionId && sidebar.isExpanded?.() === true) {
      if (sidebar.active?.()?.kind === SIDE_CHAT_TAB_KIND) return true;
    }
    sidebar.openTabIn(sessionId, SIDE_CHAT_TAB_KIND);
    return true;
  } catch (error) {
    console.warn('[raw-agent] could not open the side chat tab', error);
    return false;
  }
}

// --- R6.1: child sessions, DSH's own navigation ---------------------------------------------------

/**
 * The right-sidebar chat address of one child session, exactly as DSH's subagent catalog builds it
 * (`P/dsh-client-ui-subagent/lib/client.js` `subagentChatAddress`, tab kind `subagentchat`).
 */
export const CHILD_CHAT_ADDRESS = 'dsh-resource://subagentchat/session/';
export const CHILD_CHAT_TAB_KIND = 'subagentchat';

export function childChatAddress(address: ChildAddress): string {
  const query = new URLSearchParams({ parent: address.parentSessionId, mode: address.mode });
  return `${CHILD_CHAT_ADDRESS}${encodeURIComponent(address.childSessionId)}?${query.toString()}`;
}

/**
 * M5 (D59): the ambient row below the composer card (`P/dsh-client-ui-conversation`, slots.d.ts
 * `conversation.composer.dock`). DSH renders this list and then its own context ring in the same
 * dock (`P/dsh-client-ui-conversation/lib/client.js:22216-22223`); the ring draws nothing in our
 * sessions because we never write `request/context`, so our pill takes its place. DSH's own stat
 * pills are `activity` (order 0) and `usage` (order 1) (`P/dsh-client-ui-chat/lib/client.js:15561-15575`).
 */
export const CONTEXT_PILL_SLOT = 'conversation.composer.dock';
export const CONTEXT_PILL_ENTRY_ID = 'raw-agent-context';
/** After DSH's token pill, where the ring sat. */
export const CONTEXT_PILL_ORDER = 2;

/**
 * M7: the lifecycle banner. M8 polish: it sits in the card stack above the composer
 * (`conversation.input.dock`, a session list beside DSH's todo 0, goal 10 and queue 20 cards), not in
 * the pill row below it: that row is one flex line, and a full-width banner there squeezed DSH's
 * usage pills ("2 tur…"). Order 30 puts it last, next to the composer.
 */
export const LIFECYCLE_SLOT = 'conversation.input.dock';
export const LIFECYCLE_ENTRY_ID = 'raw-agent-lifecycle';
export const LIFECYCLE_ORDER = 30;

/** Title-adjacent session actions of the session header (`P/dsh-client-ui-conversation` slots). */
export const AGENTS_SLOT = 'conversation.session.header.actions';
export const AGENTS_ENTRY_ID = 'raw-agent-agents';

// --- D26: the wake trigger in the chat ----------------------------------------------------------

/** Our chat node kind (a keyed `conversation.chat.node` entry; no DSH package uses this key). */
export const WAKE_NODE_KIND = 'raw-agent-wake';
export const WAKE_DEFINITION_KIND = 'raw-agent-wake-trigger';

/** What our conversation Definition gets from DSH's assembler (structural, D65). */
interface WakeContext {
  key: string;
  id: string;
  state?: WakeTrigger;
  start?: { location?: unknown };
  matches: Array<{ location?: unknown }>;
}

/**
 * A Chat-target event Definition (`ctx.uiConversation.events.register`, P/dsh-client-ui-conversation
 * README "Definitions"). It claims (`exclusive: true`) only the Host's wake `developer/message`, so
 * DSH's own context row does not draw it twice, and builds one node of our kind in the turn's
 * input group (`groupTree: 'input'`, as DSH's own turn trigger), so it shows outside the turn's
 * process fold. Every other event is left to DSH.
 */
export function wakeDefinition(): Record<string, unknown> {
  return {
    kind: WAKE_DEFINITION_KIND,
    target: 'chat',
    match: (event: { type: string; seq: number; time: number; data: unknown }) => {
      if (event.type !== 'developer/message') return null;
      const t = wakeTriggerOf(event);
      if (!t) return null;
      const id = (event.data as { message?: { id?: unknown } } | undefined)?.message?.id;
      return { id: typeof id === 'string' && id !== '' ? id : `seq-${event.seq}`, role: 'start', exclusive: true };
    },
    start: (_context: unknown, match: { event: { type: string; seq: number; time: number; data: unknown } }) =>
      wakeTriggerOf(match.event) ?? { seq: match.event.seq, time: match.event.time, text: '', items: [] },
    update: (context: WakeContext) => context.state,
    buildViewNode: (context: WakeContext) => {
      if (context.state === undefined) return null;
      return {
        key: context.key,
        kind: WAKE_NODE_KIND,
        id: context.id,
        target: 'chat',
        anchorSeq: context.state.seq,
        location: context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' },
        visibility: 'visible',
        groupTree: 'input',
        data: context.state,
      };
    },
  };
}

/** The keyed chat renderer of our node. */
export function WakeNode(props: { node?: { data?: WakeTrigger } }): React.ReactElement | null {
  const data = props.node?.data;
  if (!data) return null;
  return <WakeTriggerCard trigger={data} />;
}

// --- D48: our workflow card beside DSH's own workflow-run node ------------------------------------

/**
 * DSH's native workflow records (`P/dsh-tool-workflow/lib/types/types.d.ts:10-32`). DSH's own
 * `ui-workflow-run` Definition (`P/dsh-client-ui-workflow-run/lib/client.js:717-760`) folds them
 * into its `workflow-run` node: run, phases, members, status, open a running member. We never
 * claim them (`exclusive` stays unset), so that node is drawn as before.
 */
export const WORKFLOW_RUN_START_EVENT = 'tool-workflow/run-start';
export const WORKFLOW_RUN_END_EVENT = 'tool-workflow/run-end';
/** Our chat node kind (no DSH package uses this key). */
export const WORKFLOW_NODE_KIND = 'raw-agent-workflow';
export const WORKFLOW_DEFINITION_KIND = 'raw-agent-workflow-run';

/** What our node carries: the run's identity; the live numbers come from the session store. */
export interface WorkflowNodeData {
  runId: string;
  name: string;
  /** The run's native end, once the log has it (a run of an earlier process). */
  stopReason?: string;
}

interface WorkflowContext {
  key: string;
  id: string;
  state?: WorkflowNodeData;
  start?: { location?: unknown; event?: { seq: number } };
  matches: Array<{ location?: unknown }>;
}

/**
 * A Chat-target Definition that reads the same `run-start` and `run-end` records as DSH's node
 * (Definitions may share a Match, `P/dsh-client-ui-conversation/README.md` "Conversation
 * assembly") and builds one node of our kind, anchored at the run-start record, so our card sits
 * with DSH's run node. Our renderer draws only runs the session's live process knows.
 */
export function workflowDefinition(): Record<string, unknown> {
  const runIdOf = (data: unknown): string | undefined => {
    const id = (data as { runId?: unknown } | undefined)?.runId;
    return typeof id === 'string' && id !== '' ? id : typeof id === 'number' ? String(id) : undefined;
  };
  return {
    kind: WORKFLOW_DEFINITION_KIND,
    target: 'chat',
    match: (event: { type: string; data: unknown }) => {
      if (event.type !== WORKFLOW_RUN_START_EVENT && event.type !== WORKFLOW_RUN_END_EVENT) return null;
      const id = runIdOf(event.data);
      if (id === undefined) return null;
      return { id, role: event.type === WORKFLOW_RUN_START_EVENT ? 'start' : 'update' };
    },
    start: (_context: unknown, match: { event: { data: unknown } }): WorkflowNodeData => {
      const data = match.event.data as { name?: unknown };
      return { runId: runIdOf(match.event.data) ?? '', name: typeof data?.name === 'string' ? data.name : '' };
    },
    update: (context: WorkflowContext, match: { event: { type: string; data: unknown } }) => {
      if (!context.state) return context.state;
      if (match.event.type !== WORKFLOW_RUN_END_EVENT) return context.state;
      const reason = (match.event.data as { stopReason?: unknown } | undefined)?.stopReason;
      return typeof reason === 'string' ? { ...context.state, stopReason: reason } : context.state;
    },
    buildViewNode: (context: WorkflowContext) => {
      if (context.state === undefined || context.start === undefined) return null;
      return {
        key: context.key,
        kind: WORKFLOW_NODE_KIND,
        id: context.id,
        target: 'chat',
        anchorSeq: context.start.event?.seq ?? 0,
        location: context.start.location ?? context.matches[0]?.location ?? { kind: 'unresolved' },
        visibility: 'visible',
        data: context.state,
      };
    },
  };
}

/** The keyed chat renderer of our workflow node (DSH passes the node and the session id). */
export function WorkflowNode(props: {
  node?: { data?: WorkflowNodeData };
  sessionId?: string;
  stores?: SessionStores;
  actions?: HostActions;
}): React.ReactElement | null {
  const runId = props.node?.data?.runId;
  if (!runId || !props.sessionId || !props.stores || !props.actions) return null;
  return <WorkflowNodeView sessionId={props.sessionId} runId={runId} stores={props.stores} actions={props.actions} />;
}

// --- R7.2, D69, D70: local command outputs in the chat -------------------------------------------

/** DSH's assistant message event (`P/dsh-session-format-v3-to-v4`); its `source` holds our binding. */
export const ASSISTANT_MESSAGE_EVENT = 'assistant/message';
/** Our chat node kind (no DSH package uses this key). */
export const LOCAL_COMMAND_NODE_KIND = 'raw-agent-local-command';
export const LOCAL_COMMAND_DEFINITION_KIND = 'raw-agent-local-command-output';

interface LocalContext {
  key: string;
  id: string;
  state?: LocalCommandData;
  start?: { location?: unknown };
  matches: Array<{ location?: unknown }>;
}

/**
 * A Chat-target Definition for the native `assistant/message` of a local command step (its
 * binding names the command, D21). **(D69 r5)** It claims the event (`exclusive: true`) and our
 * node draws the command's text itself, from the event as written (rule 8: the log holds the
 * CLI's own text). DSH's Markdown would turn the CLI's `$` columns into math and put the long
 * `/context` text above its table; our node draws the plain columns monospaced and the table
 * first. Only events carrying our binding are claimed; every other message is DSH's.
 */
/** R7.2: the chat group-tree position of our local command node (outside the turn's process). */
export const LOCAL_COMMAND_GROUP_TREE = 'turn';

export function localCommandDefinition(): Record<string, unknown> {
  const dataOf = (event: { type: string; seq: number; data: unknown }): LocalCommandData | undefined => {
    if (event.type !== ASSISTANT_MESSAGE_EVENT) return undefined;
    const source = (event.data as { message?: { source?: unknown } } | undefined)?.message?.source;
    const d = localCommandOf(source, event.seq);
    if (!d) return undefined;
    const text = messageText((event.data as { message?: unknown } | undefined)?.message);
    return text !== '' ? { ...d, text } : d;
  };
  return {
    kind: LOCAL_COMMAND_DEFINITION_KIND,
    target: 'chat',
    match: (event: { type: string; seq: number; data: unknown }) => {
      const d = dataOf(event);
      return d ? { id: `local-${event.seq}`, role: 'start', exclusive: true } : null;
    },
    start: (_context: unknown, match: { event: { type: string; seq: number; data: unknown } }) => dataOf(match.event),
    update: (context: LocalContext) => context.state,
    buildViewNode: (context: LocalContext) => {
      if (context.state === undefined) return null;
      return {
        key: context.key,
        kind: LOCAL_COMMAND_NODE_KIND,
        id: context.id,
        target: 'chat',
        anchorSeq: context.state.seq,
        location: context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' },
        visibility: 'visible',
        // R7.2 (live M6): without a position DSH put the node in a folded "process" group, so the
        // `/context` table stayed hidden. `turn` keeps it in its turn, outside the disclosure,
        // next to DSH's own text of the output (`P/dsh-client-ui-chat` ChatGroupTree).
        groupTree: LOCAL_COMMAND_GROUP_TREE,
        data: context.state,
      };
    },
  };
}

/** The keyed chat renderer of our local command node. */
export function LocalCommandNode(props: {
  node?: { data?: LocalCommandData };
  sessionId?: string;
  stores?: SessionStores;
  api?: RawAgentApi;
}): React.ReactElement | null {
  const data = props.node?.data;
  if (!data) return null;
  // We claimed the event: without our services, still draw the agent's text (never lose it).
  if (!props.sessionId || !props.stores || !props.api) return <LocalCommandText text={data.text ?? ''} />;
  return (
    <LocalCommandView
      data={data}
      sessionId={props.sessionId}
      store={props.stores.get(props.sessionId)}
      api={props.api}
    />
  );
}

// --- D70, M7: the /clear divider and the /compact marker on the typed command -------------------

/** DSH's human message event; our marker reads only its text and never claims it. */
export const USER_MESSAGE_EVENT = 'user/message';
export const COMMAND_MARKER_NODE_KIND = 'raw-agent-command-marker';
export const COMMAND_MARKER_DEFINITION_KIND = 'raw-agent-command-marker';

interface MarkerContext {
  key: string;
  id: string;
  state?: CommandMarker;
  start?: { location?: unknown };
  matches: Array<{ location?: unknown }>;
}

/**
 * A Chat-target Definition on the typed `/clear` (`/reset`, `/new`) and `/compact` messages. The
 * agent answers both with no message of its own (CLI 2.1.318), so the typed line is the anchor.
 * It never claims the event (`exclusive` unset): DSH still draws the user's message. The node
 * draws only in our sessions (the renderer checks our store). Group position `turn`, as the
 * local command node, so the divider is not folded away with the turn's process.
 */
/** The marker of a human `user/message` whose only part is a typed command (structural). */
export function markerOfEvent(event: {
  type: string;
  seq: number;
  time: number;
  data: unknown;
}): CommandMarker | undefined {
  if (event.type !== USER_MESSAGE_EVENT) return undefined;
  const m = event.data as { source?: { kind?: unknown }; content?: unknown } | undefined;
  if (m?.source?.kind !== 'user' || !Array.isArray(m.content) || m.content.length !== 1) return undefined;
  const b = m.content[0] as { type?: unknown; text?: unknown } | undefined;
  if (b?.type !== 'text' || typeof b.text !== 'string') return undefined;
  return commandMarkerOf(b.text, event.seq, event.time);
}

export function commandMarkerDefinition(): Record<string, unknown> {
  return {
    kind: COMMAND_MARKER_DEFINITION_KIND,
    target: 'chat',
    match: (event: { type: string; seq: number; time: number; data: unknown }) => {
      return markerOfEvent(event) ? { id: `marker-${event.seq}`, role: 'start' } : null;
    },
    start: (_context: unknown, match: { event: { type: string; seq: number; time: number; data: unknown } }) =>
      markerOfEvent(match.event),
    update: (context: MarkerContext) => context.state,
    buildViewNode: (context: MarkerContext) => {
      if (context.state === undefined) return null;
      return {
        key: context.key,
        kind: COMMAND_MARKER_NODE_KIND,
        id: context.id,
        target: 'chat',
        anchorSeq: context.state.seq,
        location: context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' },
        visibility: 'visible',
        groupTree: LOCAL_COMMAND_GROUP_TREE,
        data: context.state,
      };
    },
  };
}

/** The keyed chat renderer of our marker node. */
export function CommandMarkerNode(props: {
  node?: { data?: CommandMarker };
  sessionId?: string;
  stores?: SessionStores;
  readers?: UsageReaders;
}): React.ReactElement | null {
  const data = props.node?.data;
  if (!data || !props.sessionId || !props.stores) return null;
  const reader = data.kind === 'compacted' ? props.readers?.get(props.sessionId) : undefined;
  return <CommandMarkerView marker={data} store={props.stores.get(props.sessionId)} {...(reader ? { reader } : {})} />;
}

interface UiConversationService {
  events?: { register(definition: Record<string, unknown>): () => void };
}

interface UiWorkspaceService {
  openSession?(address: ChildAddress): void;
}

/**
 * The read-only preview address of one host file: `dsh-resource://file/session/<id>/` followed by
 * the absolute path, segment-encoded, exactly as the live probe r3 built it (dsh-ui-surfaces §7;
 * for a POSIX path this gives `<id>//home/…`). The Windows form (`<id>/C:/…`) is **unverified**.
 */
export function fileResourceAddress(sessionId: string, path: string): string {
  const enc = (s: string) => encodeURIComponent(s).replace(/%3A/gi, ':');
  const posix = path.replace(/\\/g, '/');
  const parts = posix.split('/').map(enc).join('/');
  return `dsh-resource://file/session/${enc(sessionId)}/${parts}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    const clip = (globalThis.navigator as Navigator | undefined)?.clipboard;
    if (clip?.writeText) {
      await clip.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  try {
    const doc = globalThis.document;
    const area = doc.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    doc.body.appendChild(area);
    area.select();
    const ok = doc.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export function hostActions(ctx: ClientContext, sideChat: SideChatState = { on: false }): HostActions {
  const sidebar = () => ctx.get('sidebarRight') as SidebarRight | undefined;
  return {
    sideChatInSidebar: () => sideChat.on && typeof sidebar()?.openTabIn === 'function',
    onSideChatChange(listener) {
      const set = (sideChat.listeners ??= new Set());
      set.add(listener);
      return () => set.delete(listener);
    },
    openSideChat: (sessionId, options) => openSideChatTab(sidebar(), sideChat, sessionId, options),
    openPreview(sessionId, path) {
      const s = sidebar();
      if (typeof s?.openResourceIn !== 'function') return false;
      s.openResourceIn(sessionId, fileResourceAddress(sessionId, path));
      return true;
    },
    openTerminal(sessionId) {
      const s = sidebar();
      if (typeof s?.openTabIn !== 'function') return false;
      s.openTabIn(sessionId, TERMINAL_TAB_KIND);
      return true;
    },
    copy: copyText,
    hideNativeSeat: (el) => hideNativeSeat(el),
    isOurPreset,
    markToolCall: (callId, label) => markToolCard(callId, label),
    revealToolCall(callId) {
      const el = findToolCard(callId);
      if (!el || typeof el.scrollIntoView !== 'function') return false;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return true;
    },
    stopTurn(sessionId) {
      // DSH's Stop button: `sessions.scope(id).get('conversation').cancel()`
      // (`P/dsh-client-ui-conversation/lib/client.js` `scopedConversation(...).cancel()`).
      const sessions = ctx.get('sessions') as
        { scope?(id: string): { get(name: string): unknown } | undefined } | undefined;
      const conversation = sessions?.scope?.(sessionId)?.get('conversation') as
        { cancel?(): Promise<unknown> } | undefined;
      if (typeof conversation?.cancel !== 'function') return false;
      void conversation.cancel().catch(() => undefined);
      return true;
    },
    portal(node) {
      const body = globalThis.document?.body;
      return body ? createPortal(node, body) : node;
    },
    openChild(address) {
      // DSH's catalog row click (`ctx.uiWorkspace.openSession(address)`, P/dsh-client-ui-subagent).
      const ws = ctx.get('uiWorkspace') as UiWorkspaceService | undefined;
      if (typeof ws?.openSession !== 'function') return false;
      ws.openSession(address);
      return true;
    },
    openChildAside(address) {
      const s = sidebar();
      if (typeof s?.openResource !== 'function') return false;
      s.openResource(childChatAddress(address), { kind: CHILD_CHAT_TAB_KIND, preferNewPane: true });
      return true;
    },
    async forkSession(sessionId, atSeq) {
      // DSH's own Branch action (`P/dsh-client-ui-chat/lib/client.js:15514-15528`): an exact
      // inclusive cut, the title counted up, then the branch opens.
      const sessions = ctx.get('sessions') as
        { fork?(o: { sessionId: string; atSeq?: number; increaseTitle?: boolean }): Promise<string> } | undefined;
      if (typeof sessions?.fork !== 'function') throw new Error('DSH offers no branch action here');
      return sessions.fork({ sessionId, atSeq, increaseTitle: true });
    },
    openSession(sessionId) {
      const ws = ctx.get('uiWorkspace') as { openSession?(id: unknown): void } | undefined;
      if (typeof ws?.openSession !== 'function') return false;
      ws.openSession(sessionId);
      return true;
    },
  };
}

/** R9.2, D66: the plugin access page in DSH's settings panel (a `settings.section` entry). */
export const SETTINGS_SECTION_SLOT = 'settings.section';
export const GRANTS_SECTION_ID = 'raw-agent-plugin-access';

/**
 * R9.1, D67: our own list slot for other plugins, declared by a small entry in the composer row
 * right after our controls. Declaring is claiming: only that entry renders the key
 * (`P/dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts`, `children` declarations;
 * probe svc-a/svc-b in the plugin-service-api research note filled a root-scoped one live). A
 * session-scoped declaration in a session slot is **unverified** live.
 */
export const PLUGIN_EXTRAS_ENTRY_ID = 'raw-agent-plugin-extras';
export const PLUGIN_EXTRAS_SLOT = 'raw-agent.controls.extra';
export const PLUGIN_EXTRAS_ORDER = 51;

export interface MountClientOptions {
  fetch?: FetchFn;
  /** Test seam: the plugin routes. */
  plugin?: PluginApi;
  /** D19, D80: the tool view packs of the backends (the composition root passes them). */
  toolViews?: readonly ToolViewPack[];
  /** Test seam. */
  api?: RawAgentApi;
  /** 0.1.1: the agents' display names, for the note under DSH's access setting. */
  agentNames?: readonly string[];
}

/**
 * 0.1.1: DSH's access row in Settings > General (`P/dsh-client-ui-permission-presets`,
 * `settings.general.item` id `permission`, order -20). Our note sits right after it.
 */
export const SETTINGS_GENERAL_SLOT = 'settings.general.item';
export const ACCESS_NOTE_ID = 'raw-agent-access-note';
export const ACCESS_NOTE_ORDER = -19;

/**
 * Register the side chat tab: the type in `ctx.sidebarRightTabs`, the body in the keyed
 * `sidebar.right.pane.tab` seat under the type's id. Both live as long as the scope. A registry
 * that refuses the type leaves `state.on` false, so the inline box stays.
 */
export function registerSideChat(
  scope: ClientContext,
  registry: unknown,
  state: SideChatState,
  inject: { stores: SessionStores; api: RawAgentApi; agentNames: readonly string[] },
): boolean {
  const tabs = registry as SidebarRightTabsService | undefined;
  if (typeof tabs?.register !== 'function') return false;
  const register = () => {
    let off: () => void;
    try {
      off = tabs.register(sideChatTabDefinition());
    } catch (error) {
      console.warn('[raw-agent] could not register the side chat tab; the inline box stays', error);
      return () => {};
    }
    setSideChat(state, true);
    return () => {
      setSideChat(state, false);
      off();
    };
  };
  if (typeof scope.effect === 'function') scope.effect(register, 'raw-agent: side chat tab type');
  else register();
  scope.slots.inject(SIDE_CHAT_TAB_SLOT, () =>
    scope.slots.register(
      {
        name: SIDE_CHAT_TAB_SLOT,
        key: SIDE_CHAT_TAB_ID,
        inject: (sessionId?: string) => ({
          ...(typeof sessionId === 'string' ? { sessionId } : {}),
          stores: inject.stores,
          api: inject.api,
          agentNames: inject.agentNames,
        }),
      },
      SideChatTab as React.ComponentType<never>,
    ),
  );
  return true;
}

/** Register the session controls. Returns the stores (tests). */
export function mountClient(ctx: ClientContext, options: MountClientOptions = {}): SessionStores {
  const fetchFn: FetchFn =
    options.fetch ??
    ((input, init) => globalThis.fetch(input, { credentials: 'same-origin', ...init }) as ReturnType<FetchFn>);
  const api = options.api ?? createApi(fetchFn);
  const plugin = options.plugin ?? createPluginApi(fetchFn);
  const stores = new SessionStores(api);
  // R9.2, D66: `rawAgentClient` for other browser plugins. A failed provide must not fail the
  // client: the rest of the UI works without it.
  try {
    ctx.provide?.(RAW_AGENT_CLIENT_SERVICE, createRawAgentClientService(stores, plugin));
  } catch (error) {
    console.warn('[raw-agent] could not provide the rawAgentClient service', error);
  }
  const links = new ChildLinks(api);
  const readers = new UsageReaders(stores, api);
  const sideChat: SideChatState = { on: false };
  const actions = hostActions(ctx, sideChat);
  ctx.effect?.(
    () => () => {
      readers.dispose();
      stores.dispose();
      links.dispose();
    },
    'raw-agent: session stores',
  );
  // D39: with DSH's session service, each open ask becomes a pending interaction and its card
  // takes over the composer; without it the cards show in the controls row.
  const takeover = { on: false };
  // `slots` is named too: a Cordis scope may only read the services it injects.
  const withService = (name: string, fn: (svc: unknown, scope: ClientContext) => void) => {
    if (typeof ctx.inject === 'function')
      ctx.inject([name, 'slots'], (scope) => fn(scope[name] ?? scope.get(name), scope));
    else {
      const svc = ctx.get(name);
      if (svc) fn(svc, ctx);
    }
  };
  // R7.1, D52: the agent commands DSH's own `/` menu cannot list (plugin skills, MCP prompts).
  withService('inputTriggers', (svc, scope) => {
    const triggers = svc as { registerSource?: (src: unknown) => () => void } | undefined;
    if (typeof triggers?.registerSource !== 'function') return;
    const source = agentCommandSource(stores, api);
    scope.effect?.(() => triggers.registerSource!(source), 'raw-agent: agent command source');
  });
  withService('uiSession', (svc, scope) => {
    const ui = svc as UiSessionService | undefined;
    if (typeof ui?.registerPendingInteraction !== 'function') return;
    const publish = ui.registerPendingInteraction(() => ASK_INTERACTION_PRECEDENCE);
    takeover.on = true;
    scope.effect?.(() => {
      const off = publishAsks(stores, publish);
      return () => {
        takeover.on = false;
        off();
      };
    }, 'raw-agent: pending asks');
    scope.slots.inject('conversation.composer', () =>
      scope.slots.register(
        {
          name: 'conversation.composer',
          priority: ASK_COMPOSER_PRIORITY,
          select: selectAsk,
          inject: () => ({ stores, actions }),
        },
        AskComposer as React.ComponentType<never>,
      ),
    );
  });
  // R1.4 leftover: no DSH preset popup on `/permission` in our sessions.
  withService('commandUi', (svc, scope) => {
    scope.effect?.(() => {
      const undo = guardPresetDecoration(svc, (id) => isOurSession(stores, id), modePopup(stores));
      if (!undo) console.warn('[raw-agent] DSH command UI has no decoration map; /permission may open DSH presets');
      return undo ?? (() => {});
    }, 'raw-agent: /permission preset popup');
    // M8 polish: `/model` opens our model picker in our sessions, not DSH's empty popup.
    scope.effect?.(() => {
      const undo = guardModelContribution(
        svc,
        (id) => isOurSession(stores, id),
        (id) => stores.get(id).requestPanel('model'),
      );
      if (!undo) console.warn('[raw-agent] DSH command UI has no contribution map; /model opens DSH models');
      return undo ?? (() => {});
    }, 'raw-agent: /model popup');
  });
  // D38: Shift+Tab cycles the mode, where DSH's shortcut service lets a plugin bind it.
  withService('shortcuts', (svc, scope) => {
    const keys = svc as ShortcutsService | undefined;
    if (typeof keys?.observeFixedInput !== 'function' || typeof keys.registerFixed !== 'function') return;
    scope.effect?.(() => {
      let unregister: () => void;
      try {
        unregister = keys.registerFixed({
          id: MODE_SHORTCUT_ID,
          label: () => 'Next permission mode (agent sessions)',
          keys: ['Shift', 'Tab'],
          bindings: [{ code: 'Tab', modifiers: ['shift'] }],
          group: 'input',
        });
      } catch {
        // Another plugin owns Shift+Tab: leave it alone.
        return () => {};
      }
      const unobserve = keys.observeFixedInput(modeKeyHandler(stores));
      return () => {
        unobserve();
        unregister();
      };
    }, 'raw-agent: Shift+Tab mode key');
  });
  // D26: the wake trigger card, where DSH's conversation registry lets a plugin add a Definition.
  withService('uiConversation', (svc, scope) => {
    const conv = svc as UiConversationService | undefined;
    if (typeof conv?.events?.register !== 'function') return;
    const events = conv.events;
    scope.effect?.(() => events.register(wakeDefinition()), 'raw-agent: wake trigger');
    scope.slots.inject('conversation.chat.node', () =>
      scope.slots.register(
        { name: 'conversation.chat.node', key: WAKE_NODE_KIND },
        WakeNode as React.ComponentType<never>,
      ),
    );
    // D48: the workflow card (numbers, output, Stop entire workflow) beside DSH's run node.
    scope.effect?.(() => events.register(workflowDefinition()), 'raw-agent: workflow card');
    scope.slots.inject('conversation.chat.node', () =>
      scope.slots.register(
        { name: 'conversation.chat.node', key: WORKFLOW_NODE_KIND, inject: () => ({ stores, actions }) },
        WorkflowNode as React.ComponentType<never>,
      ),
    );
    // R7.2, D70: local command outputs (the /context table, the /clear divider, the compact marker).
    scope.effect?.(() => events.register(localCommandDefinition()), 'raw-agent: local command outputs');
    scope.slots.inject('conversation.chat.node', () =>
      scope.slots.register(
        { name: 'conversation.chat.node', key: LOCAL_COMMAND_NODE_KIND, inject: () => ({ stores, api }) },
        LocalCommandNode as React.ComponentType<never>,
      ),
    );
    // D70, M7: the /clear divider and the /compact marker on the typed command.
    scope.effect?.(() => events.register(commandMarkerDefinition()), 'raw-agent: command markers');
    scope.slots.inject('conversation.chat.node', () =>
      scope.slots.register(
        { name: 'conversation.chat.node', key: COMMAND_MARKER_NODE_KIND, inject: () => ({ stores, readers }) },
        CommandMarkerNode as React.ComponentType<never>,
      ),
    );
  });
  // 0.1.2 (D89): the side chat as a right-sidebar tab, through DSH's public tab-type registry.
  // Without it (an older DSH) the controls keep the inline side-question box.
  if (typeof ctx.inject === 'function')
    // A block body: a Cordis plugin body that returns a value (here `true`) fails with "Invalid
    // effect" and its scope is disposed at once, silently (0.1.2 live).
    ctx.inject(['sidebarRightTabs', 'sidebarRight', 'slots'], (scope) => {
      registerSideChat(scope, scope.sidebarRightTabs ?? scope.get('sidebarRightTabs'), sideChat, {
        stores,
        api,
        agentNames: options.agentNames ?? [],
      });
    });
  else
    registerSideChat(ctx, ctx.get('sidebarRightTabs'), sideChat, { stores, api, agentNames: options.agentNames ?? [] });
  // D19: the backends' tool views, drawn only in sessions of their backend (and their children).
  if (options.toolViews && options.toolViews.length > 0) registerToolViews(ctx.slots, options.toolViews, stores, links);
  // R6.1-R6.3: the agents button in our sessions' header, and the child strip in a child session.
  ctx.slots.inject(AGENTS_SLOT, () =>
    ctx.slots.register(
      {
        name: AGENTS_SLOT,
        id: AGENTS_ENTRY_ID,
        order: 20,
        inject: (sessionId: string) => ({ sessionId, stores, links, actions }),
      },
      AgentsHeader as React.ComponentType<never>,
    ),
  );
  // M5 (D59): the context pill and usage panel, in the dock where DSH's context ring would be.
  ctx.slots.inject(CONTEXT_PILL_SLOT, () =>
    ctx.slots.register(
      {
        name: CONTEXT_PILL_SLOT,
        id: CONTEXT_PILL_ENTRY_ID,
        order: CONTEXT_PILL_ORDER,
        inject: (sessionId: string) => ({ store: stores.get(sessionId), reader: readers.get(sessionId), actions }),
      },
      ContextPill as React.ComponentType<never>,
    ),
  );
  // M7 (R3.6): the crash or exit banner with Restart, and the fork and recovery notes.
  ctx.slots.inject(LIFECYCLE_SLOT, () =>
    ctx.slots.register(
      {
        name: LIFECYCLE_SLOT,
        id: LIFECYCLE_ENTRY_ID,
        order: LIFECYCLE_ORDER,
        inject: (sessionId: string) => ({ store: stores.get(sessionId) }),
      },
      LifecycleBanner as React.ComponentType<never>,
    ),
  );
  ctx.slots.inject(CONTROLS_SLOT, () =>
    ctx.slots.register(
      {
        name: CONTROLS_SLOT,
        id: CONTROLS_ENTRY_ID,
        order: 50,
        // A strict session slot passes the session id to `inject` (`P/dsh-client-ui-renderer`, runInject).
        inject: (sessionId: string) => ({
          store: stores.get(sessionId),
          api,
          actions,
          stores,
          plugin,
          // Read at render: the session service may arrive after the controls mount.
          asksInComposer: () => takeover.on,
        }),
      },
      SessionControls as React.ComponentType<never>,
    ),
  );
  // R9.2, D66: plugin access (grants) as a page in DSH's settings panel. The settings shell
  // declares the slot (`P/dsh-client-ui-settings` contract `settings.section`); without it the
  // page is in our settings dialog only. Live M8: the page renders.
  ctx.slots.inject(SETTINGS_SECTION_SLOT, () =>
    ctx.slots.register(
      {
        name: SETTINGS_SECTION_SLOT,
        id: GRANTS_SECTION_ID,
        order: 900,
        label: 'Agent plugin access',
        inject: () => ({ plugin, copy: actions.copy }),
      },
      GrantsPanel as React.ComponentType<never>,
    ),
  );
  // 0.1.1: DSH's access setting does not control our agents; say so under it.
  ctx.slots.inject(SETTINGS_GENERAL_SLOT, () =>
    ctx.slots.register(
      {
        name: SETTINGS_GENERAL_SLOT,
        id: ACCESS_NOTE_ID,
        order: ACCESS_NOTE_ORDER,
        inject: () => ({ agentNames: options.agentNames ?? [] }),
      },
      AccessNote as React.ComponentType<never>,
    ),
  );
  // R9.1, D67: a slot of our own for other plugins. A failed declaration (a DSH version whose
  // registry refuses it) must not take the rest of the client down.
  ctx.slots.inject(CONTROLS_SLOT, () => {
    try {
      return ctx.slots.register(
        {
          name: CONTROLS_SLOT,
          id: PLUGIN_EXTRAS_ENTRY_ID,
          order: PLUGIN_EXTRAS_ORDER,
          children: { [PLUGIN_EXTRAS_SLOT]: { kind: 'list', scope: 'session' } },
          inject: (sessionId: string) => ({ store: stores.get(sessionId), slotKey: PLUGIN_EXTRAS_SLOT }),
        },
        PluginExtras as React.ComponentType<never>,
      );
    } catch (error) {
      console.warn('[raw-agent] could not declare the plugin slot', error);
      return () => {};
    }
  });
  return stores;
}
