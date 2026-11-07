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

/** Insert text at the composer caret; false when the composer refused it. Never replaces the draft. */
export function insertAtCaret(target: DraftTarget, text: string): boolean {
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
  return insertAtCaret(target, text) ? { inserted: text, droppedAttachments } : { held: text, droppedAttachments };
}

/** What the controls do with one `rawAgentClient.prefill` request (R9.2). */
export type PrefillOutcome =
  | { kind: 'side'; seq: number; text: string }
  | { kind: 'inserted'; seq: number }
  | { kind: 'held'; seq: number; text: string };

/**
 * Take a prefill request newer than `seenSeq`. Side-question text goes to the side panel's box;
 * composer text is inserted at the caret, or held (shown with "Copy it") when the composer
 * refuses it. Undefined: nothing new, or the composer's actions have not arrived yet (wait).
 */
export function takePrefill(
  req: { text: string; target: 'composer' | 'side-question'; seq: number } | undefined,
  seenSeq: number,
  target: DraftTarget | undefined,
): PrefillOutcome | undefined {
  if (!req || req.seq <= seenSeq) return undefined;
  if (req.target === 'side-question') return { kind: 'side', seq: req.seq, text: req.text };
  if (!target) return undefined;
  return insertAtCaret(target, req.text)
    ? { kind: 'inserted', seq: req.seq }
    : { kind: 'held', seq: req.seq, text: req.text };
}
