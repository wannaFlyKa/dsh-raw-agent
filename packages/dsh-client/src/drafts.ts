// Returned drafts (D25): after Stop, a steer the agent did not run comes back to the composer, as
// the TUI puts a queued message back on Esc. The Host keeps the texts until a browser takes them.
//
// The text is only ever inserted at the caret (`insertText`), so a draft the user is typing is
// kept. DSH gives no way to read the draft, so the plugin never calls `setDraft` (it replaces the
// whole draft): when the insert is refused (the composer is busy, or the host has no insert), the
// text is held and offered again, and the UI shows it so it is never lost.

import type { RawAgentApi } from './api.js';

/** The part of DSH's session `inputActions` this needs (structural; the port passes DSH's own). */
export interface DraftTarget {
  setDraft(text: string): void;
  captureInsertion?(): unknown;
  insertText?(text: string, span: never): boolean;
}

export interface RestoreResult {
  /** The text put back at the caret. */
  inserted?: string;
  /** Text that could not be put back yet (kept for the next try and shown to the user). */
  held?: string;
  /** Attachments of the stopped messages that cannot go back into the composer. */
  droppedAttachments: number;
}

function insert(target: DraftTarget, text: string): boolean {
  try {
    if (target.captureInsertion && target.insertText)
      return target.insertText(text, target.captureInsertion() as never) === true;
  } catch {
    return false;
  }
  return false;
}

/**
 * Fetch the returned drafts once and put their text, with any text still held from an earlier
 * try, at the composer caret. Never replaces what the user typed.
 */
export async function restoreReturnedDrafts(
  api: RawAgentApi,
  sessionId: string,
  target: DraftTarget | undefined,
  held?: string,
): Promise<RestoreResult> {
  if (!target) return held ? { held, droppedAttachments: 0 } : { droppedAttachments: 0 };
  const { returnedDrafts } = await api.state(sessionId);
  const parts = returnedDrafts.map((d) => d.text.trim()).filter(Boolean);
  if (held) parts.unshift(held);
  const droppedAttachments = returnedDrafts.reduce((n, d) => n + (d.attachments ?? 0), 0);
  const text = parts.join('\n\n');
  if (text === '') return { droppedAttachments };
  return insert(target, text) ? { inserted: text, droppedAttachments } : { held: text, droppedAttachments };
}
