// D30 (M7): the rewind dialog's actions that span two sessions. No React, no DSH: the fork itself
// is DSH's (`HostActions.forkSession`), the restore request is our route.

import type { RawAgentApi } from './api.js';

export interface RestoreRetry {
  /** How many times to ask (the new branch's agent is adopted by the Host a moment after it opens). */
  attempts?: number;
  delayMs?: number;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Ask a new branch to restore the files at its first start ("Restore code and conversation").
 * The branch's runtime exists only once DSH opened it, so a 404 (not ours yet) or a 409 (its
 * host session is not attached yet) is asked again. Nothing starts a process (D4).
 */
export async function requestRestoreAtStart(
  api: RawAgentApi,
  forkSessionId: string,
  retry: RestoreRetry = {},
): Promise<{ ok: boolean; error?: string }> {
  if (!api.rewindRestore) return { ok: false, error: 'this plugin version cannot restore code at a branch start' };
  const attempts = Math.max(1, retry.attempts ?? 20);
  const sleep = retry.sleep ?? wait;
  let last: string | undefined;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(retry.delayMs ?? 500);
    try {
      const r = await api.rewindRestore(forkSessionId, true);
      if (r.ok) return { ok: true };
      last = r.error ?? `request failed (${r.status})`;
      if (r.status !== 404 && r.status !== 409) break;
    } catch (e) {
      last = String((e as Error)?.message ?? e);
    }
  }
  return { ok: false, error: last ?? 'no answer' };
}

/** What `handBackDraft` needs of a session store (structural; `SessionControlStore` has both). */
export interface DraftReceiver {
  requestPrefill(text: string, target: 'composer'): void;
  showNote(text: string): void;
}

/**
 * M8 polish: after "Restore conversation" the rewound message goes back to the new branch's
 * composer, as the TUI's rewind puts it back in its draft. Asked on the branch's store before DSH
 * opens it, so its controls take it when they mount (at the caret; nothing is sent). What cannot go
 * back (attachments, a very long text) is said in a note on the branch.
 */
export function handBackDraft(branch: DraftReceiver | undefined, draft: { text?: string; note?: string }): void {
  if (!branch) return;
  if (draft.text !== undefined) branch.requestPrefill(draft.text, 'composer');
  if (draft.note !== undefined) branch.showNote(draft.note);
}
