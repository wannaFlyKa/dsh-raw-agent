// What the UI may ask of DSH. Implemented by ./port (D79); fakes in tests.

import type * as React from 'react';

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
}
