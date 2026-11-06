// The only module in dsh-client that touches DSH (D79): slot names, the right-sidebar resource
// address, the terminal tab kind and portals. DSH types are local structural copies; there is no
// runtime import of DSH (D65). React and react-dom come from DSH's shared module table.

import * as React from 'react';
import { createPortal } from 'react-dom';
import { createApi, type FetchFn, type RawAgentApi } from '../api.js';
import { SessionStores } from '../session-store.js';
import type { HostActions } from '../ui/actions.js';
import { SessionControls } from '../ui/controls.js';

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
}

interface SidebarRight {
  openResourceIn?(sessionId: string, address: string): void;
  openTabIn?(sessionId: string, kind: string): void;
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
    portal(node) {
      const body = globalThis.document?.body;
      return body ? createPortal(node, body) : node;
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
  const actions = hostActions(ctx);
  ctx.effect?.(() => () => stores.dispose(), 'raw-agent: session stores');
  ctx.slots.inject(CONTROLS_SLOT, () =>
    ctx.slots.register(
      {
        name: CONTROLS_SLOT,
        id: CONTROLS_ENTRY_ID,
        order: 50,
        // A strict session slot passes the session id to `inject` (`P/dsh-client-ui-renderer`, runInject).
        inject: (sessionId: string) => ({ store: stores.get(sessionId), api, actions }),
      },
      SessionControls as React.ComponentType<never>,
    ),
  );
  return stores;
}
