// The only module in dsh-client that touches DSH (D79): slot names, the right-sidebar resource
// address, the terminal tab kind and portals. DSH types are local structural copies; there is no
// runtime import of DSH (D65). React and react-dom come from DSH's shared module table.

import * as React from 'react';
import { createPortal } from 'react-dom';
import { wakeTriggerOf, type ChildAddress, type WakeTrigger } from '../agents-model.js';
import { createApi, type FetchFn, type RawAgentApi } from '../api.js';
import { ChildLinks } from '../child-links.js';
import { SessionStores, type SessionControlStore } from '../session-store.js';
import type { HostActions } from '../ui/actions.js';
import { AgentsHeader } from '../ui/agents-panel.js';
import { AskPanel } from '../ui/ask-cards.js';
import { SessionControls } from '../ui/controls.js';
import { WakeTriggerCard } from '../ui/wake-card.js';
import { WorkflowNodeView } from '../ui/workflow-panel.js';

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
/** Set on the nearest composer ancestor of our controls; a style rule then hides the seat. */
export const SEAT_HIDDEN_ATTR = 'data-raw-agent-hides-seat';
const SEAT_STYLE_ID = 'raw-agent-hide-native-seat';
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
 * Hide DSH's permission seat in this composer only. DSH's seat changes DSH's approval policy,
 * which our agent ignores (D38 r3), so in our sessions it shows a mode that is not applied
 * (M1 verify 2: "Read Only" while Claude wrote files in Auto). The seat is a single DSH slot that
 * cannot be replaced per session (K1), so the nearest ancestor that holds it gets a marker, and
 * one style rule hides the seat under that marker. The undo removes the marker (a Standard
 * session in the same composer shows the seat again). DOM shape **unverified** on DSH versions
 * other than TESTED_DSH_VERSIONS.
 */
export function hideNativeSeat(
  el: unknown,
  doc: SeatDocument | undefined = globalThis.document as unknown as SeatDocument | undefined,
): { found: boolean; undo(): void } {
  const none = { found: false, undo: () => {} };
  const start = el as SeatElement | null | undefined;
  if (!start || typeof start !== 'object' || !('parentElement' in start)) return none;
  const selector = `[data-slot="${NATIVE_PERMISSION_SLOT}"]`;
  let at = start.parentElement;
  for (let i = 0; at && i < SEAT_SEARCH_DEPTH; i++, at = at.parentElement) {
    if (!at.querySelector(selector)) continue;
    if (doc && !doc.getElementById(SEAT_STYLE_ID)) {
      const style = doc.createElement('style');
      style.id = SEAT_STYLE_ID;
      style.textContent = `[${SEAT_HIDDEN_ATTR}] ${selector}{display:none !important}`;
      doc.head?.appendChild(style);
    }
    const host = at;
    host.setAttribute(SEAT_HIDDEN_ATTR, '');
    return { found: true, undo: () => host.removeAttribute(SEAT_HIDDEN_ATTR) };
  }
  return none;
}

/** The right sidebar's terminal tab kind (`P/dsh-client-ui-sidebar-terminal`). */
export const TERMINAL_TAB_KIND = 'terminal';

/** What this port uses of the client Cordis context (structural, D65). */
export interface ClientContext {
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
      `[${TOOL_WAITING_ATTR}]{outline:2px solid var(--raw-agent-ask-border, var(--dsw-alias-border-warning, orange));` +
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

/**
 * Keep DSH's preset popup out of our sessions (R1.4 leftover, CLAUDE.md §4).
 *
 * DSH's client hangs a popup on the host command `permission` (`command.decorate`, one per name;
 * a second one throws, `P/dsh-client-ui-commands/lib/client.js:1424`). In our sessions the host
 * command is our own (the Host shadows it per agent), but the popup still opened on a bare
 * `/permission` or a menu pick and marked a DSH preset ("Workspace Write") as active, a level the
 * agent never applies. The command runtime reads the decoration through `live.decorations.get`
 * (lines 1521, 1602) and asks `available(session)` each time. We answer "not available" for our
 * sessions only; DSH then treats `/permission` as a plain host command with an argument (our
 * command: it shows the agent's mode, or switches it). Other sessions keep DSH's popup.
 *
 * This reads a DSH internal (`commandUi.live.decorations`, a `Map`). If the shape is not there,
 * nothing changes and the caller is told (returns `undefined`).
 */
export function guardPresetDecoration(
  commandUi: unknown,
  isOurs: (sessionId: string) => boolean,
): (() => void) | undefined {
  const map = (commandUi as { live?: { decorations?: unknown } } | undefined)?.live?.decorations;
  if (!(map instanceof Map)) return undefined;
  const base = map.get as (key: unknown) => unknown;
  const wrapped = new WeakMap<object, DecorationLike>();
  const get = function (this: Map<unknown, unknown>, key: unknown): unknown {
    const found = base.call(this, key) as DecorationLike | undefined;
    if (key !== PRESET_DECORATION || typeof found?.available !== 'function') return found;
    let w = wrapped.get(found);
    if (!w) {
      const inner = found;
      w = {
        ...inner,
        available: (session) =>
          !(typeof session?.sessionId === 'string' && isOurs(session.sessionId)) && inner.available(session),
      };
      wrapped.set(found, w);
    }
    return w;
  };
  Object.defineProperty(map, 'get', { value: get, configurable: true, writable: true });
  return () => {
    if ((map as { get: unknown }).get === get) delete (map as { get?: unknown }).get;
  };
}

/** A session is ours once our route answered for it (the controls store is `ready`). */
export function isOurSession(stores: SessionStores, sessionId: string): boolean {
  const snap = stores.peek(sessionId)?.getSnapshot();
  return snap?.info !== undefined && snap.status !== 'absent';
}

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

export function hostActions(ctx: ClientContext): HostActions {
  const sidebar = () => ctx.get('sidebarRight') as SidebarRight | undefined;
  return {
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
  };
}

export interface MountClientOptions {
  fetch?: FetchFn;
  /** Test seam. */
  api?: RawAgentApi;
}

/** Register the session controls. Returns the stores (tests). */
export function mountClient(ctx: ClientContext, options: MountClientOptions = {}): SessionStores {
  const fetchFn: FetchFn =
    options.fetch ??
    ((input, init) => globalThis.fetch(input, { credentials: 'same-origin', ...init }) as ReturnType<FetchFn>);
  const api = options.api ?? createApi(fetchFn);
  const stores = new SessionStores(api);
  const links = new ChildLinks(api);
  const actions = hostActions(ctx);
  ctx.effect?.(
    () => () => {
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
      const undo = guardPresetDecoration(svc, (id) => isOurSession(stores, id));
      if (!undo) console.warn('[raw-agent] DSH command UI has no decoration map; /permission may open DSH presets');
      return undo ?? (() => {});
    }, 'raw-agent: /permission preset popup');
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
  });
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
          // Read at render: the session service may arrive after the controls mount.
          asksInComposer: () => takeover.on,
        }),
      },
      SessionControls as React.ComponentType<never>,
    ),
  );
  return stores;
}
