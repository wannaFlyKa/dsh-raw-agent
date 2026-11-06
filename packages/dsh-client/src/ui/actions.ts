// What the UI may ask of DSH. Implemented by ./port (D79); fakes in tests.

import type * as React from 'react';
import type { ChildAddress } from '../agents-model.js';

export interface HostActions {
  /** Open a file read-only in DSH's preview sidebar (unmasked; the user's explicit click). */
  openPreview(sessionId: string, path: string): boolean;
  /** Open a DSH terminal tab for the session (it starts in the session folder). */
  openTerminal(sessionId: string): boolean;
  copy(text: string): Promise<boolean>;
  /** Render an overlay outside the composer (fixed overlays must portal, DSH slot rule). */
  portal(node: React.ReactNode): React.ReactNode;
  /**
   * Hide DSH's own permission control next to our controls (`el` is our controls element). That
   * control sets DSH's approval policy, which this agent never uses, so it would show a safety
   * level that does not apply (M1 verify 2). Returns the undo, and whether a control was found.
   */
  hideNativeSeat?(el: unknown): { found: boolean; undo(): void };
  /**
   * D77: mark the tool card of `callId` as waiting for the user while its ask is open, and
   * return the undo. `found` is false while DSH has not drawn the card yet.
   */
  markToolCall?(callId: string, label: string): { found: boolean; undo(): void };
  /** Scroll the tool card of `callId` into view. False when it is not on the page. */
  revealToolCall?(callId: string): boolean;
  /**
   * Stop the session's running turn, exactly as DSH's own Stop button does (rule 6: the agent
   * gets an interrupt, nothing more). The ask takeover hides DSH's Stop button, so the card
   * offers it while a turn runs. False when DSH offers no way to stop from here.
   */
  stopTurn?(sessionId: string): boolean;
  /** R6.1: open a child agent's session in the main view (DSH's own child navigation). */
  openChild?(address: ChildAddress): boolean;
  /** R6.1: open a child agent's session beside this one, in the right sidebar. */
  openChildAside?(address: ChildAddress): boolean;
}
