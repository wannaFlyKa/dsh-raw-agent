// M7 (R3.5, R3.6, D29, D30, D70, D75): what the plugin shows about the agent's lifecycle. Pure,
// no React, no DSH. The texts name the agent by the Host's display name (D80).
// - The exit banner: the agent process ended by itself or crashed; Restart resumes it (D28).
// - Lifecycle notes: a fork that has not started yet, "restore code" pending, a branch of a
//   subagent's session, replies read back from the agent's own record, tasks a host stop ended.
// - The rewind dialog: the points (earlier human messages) and what each choice does, as the
//   terminal app's rewind menu offers them.
// - The /clear divider and the /compact marker, found from the typed command in the log.

import type {
  ExitWire,
  FileRewindWire,
  RewindOptionsWire,
  RewindPointWire,
  SessionInfo,
  UsageViewWire,
} from './api.js';

// ---- the exit banner (R3.6, D75) ---------------------------------------------------------------

export interface ExitBanner {
  /** Changes for every new exit, so a dismissed banner comes back for the next one. */
  key: string;
  level: 'error' | 'warning';
  title: string;
  /** The agent's own last words (its error and the end of its error output), as reported. */
  detail?: string;
  /** What happened to the reply that was running, and whether it was read back. */
  reply?: string;
  restartLabel: string;
}

/** "SIGKILL" → "killed (SIGKILL)", exit code 3 → "exit code 3". */
function howItEnded(e: ExitWire): string | undefined {
  if (e.signal !== undefined) return e.signal === 'SIGKILL' ? 'killed (SIGKILL)' : `ended by ${e.signal}`;
  if (e.code !== undefined && e.code !== 0) return `exit code ${e.code}`;
  return undefined;
}

/**
 * The banner for the last unexpected end of the process, while no process runs. An end the user
 * asked for (Force stop) or the host did (dispose) shows nothing.
 */
export function exitBanner(info: SessionInfo): ExitBanner | undefined {
  const v = info.view;
  const e = v.state.lastExit;
  if (!e || v.state.process !== 'none') return undefined;
  if (e.reason === 'disposed' || e.reason === 'force-stopped') return undefined;
  const name = info.backend.displayName;
  const how = howItEnded(e);
  const ended = e.reason === 'ended';
  const title = ended
    ? `${name} ended by itself${e.duringTurn ? ' during a reply' : ''}.`
    : `${name} ${e.duringTurn ? 'crashed during a reply' : 'stopped unexpectedly'}${how ? ` (${how})` : ''}.`;
  const b: ExitBanner = {
    key: `exit-${e.at}`,
    level: ended ? 'warning' : 'error',
    title,
    restartLabel: `Restart ${name}`,
  };
  if (e.error !== undefined && e.error.trim() !== '') b.detail = e.error.trim();
  if (e.duringTurn) {
    const r = v.lifecycle?.recovered;
    b.reply =
      r && r.why === 'crash' && r.at >= e.at && r.steps > 0
        ? `What ${name} wrote before it stopped was read back from its own record (${r.steps} ${r.steps === 1 ? 'step' : 'steps'}).`
        : `The reply that was running ended here. Restart ${name}, or send a message, to go on: it resumes the same conversation.`;
  } else b.reply = `Restart ${name}, or send a message: it resumes the same conversation.`;
  return b;
}

// ---- lifecycle notes (D29, D30, D75, R3.6) -------------------------------------------------------

export interface LifecycleNote {
  /** Stable per fact and time, so a dismissed note stays dismissed until the fact changes. */
  id: string;
  level: 'info' | 'warning';
  text: string;
}

function filesText(r: FileRewindWire): string {
  const n = r.filesChanged.length;
  const lines =
    r.insertions !== undefined || r.deletions !== undefined
      ? ` (+${r.insertions ?? 0} −${r.deletions ?? 0} lines)`
      : '';
  const links = r.skippedLinks ? `; ${r.skippedLinks} left alone (a link sits at the path)` : '';
  return `${n} ${n === 1 ? 'file' : 'files'}${lines}${links}`;
}

/** The outcome of a file restore, in words. */
export function rewindResultText(r: FileRewindWire, name: string): string {
  if (!r.ok) return `${name} did not restore the files: ${r.error ?? 'no reason given'}.`;
  if (r.dryRun)
    return r.filesChanged.length === 0
      ? 'No file changed since this message.'
      : `Restore code would change ${filesText(r)}.`;
  return r.filesChanged.length === 0 ? 'No file needed restoring.' : `Restored ${filesText(r)}.`;
}

/** Every lifecycle fact worth a line, newest facts last. */
export function lifecycleNotes(info: SessionInfo): LifecycleNote[] {
  const l = info.view.lifecycle;
  if (!l) return [];
  const name = info.backend.displayName;
  const out: LifecycleNote[] = [];
  if (l.unstartedFork)
    out.push({
      id: 'fork',
      level: 'info',
      text: `This is a branch. ${name} remembers the conversation up to the branch point and goes on from there when you send a message.`,
    });
  if (l.restoreCodePending)
    out.push({
      id: 'restore-pending',
      level: 'info',
      text: `When ${name} starts in this branch, it first puts the files back as they were at the branch point.`,
    });
  if (l.forkedFromChild)
    out.push({
      id: 'child-fork',
      level: 'warning',
      text: `This branch was made from a subagent's session. ${name} starts a new conversation here and does not remember the subagent's work.`,
    });
  if (l.endedByStop && l.endedByStop.length > 0)
    out.push({
      id: `ended-by-stop-${l.endedByStop.join('|')}`,
      level: 'warning',
      text: `When DSH last stopped, ${l.endedByStop.join(', ')} ended too. ${name} was not told.`,
    });
  if (l.recovered && l.recovered.why === 'restart' && (l.recovered.steps > 0 || l.recovered.note))
    out.push({
      id: `recovered-${l.recovered.at}`,
      level: 'info',
      text:
        `${name} wrote ${l.recovered.steps > 0 ? `${l.recovered.steps} ${l.recovered.steps === 1 ? 'step' : 'steps'}` : 'more'} while DSH was not looking; read back from its own record.` +
        (l.recovered.note ? ` ${l.recovered.note}.` : ''),
    });
  if (l.recoveryProblem) out.push({ id: `recovery-problem`, level: 'warning', text: l.recoveryProblem });
  if (l.rewind && !l.rewind.result.dryRun)
    out.push({
      id: `rewind-${l.rewind.at}`,
      level: l.rewind.result.ok ? 'info' : 'warning',
      text: rewindResultText(l.rewind.result, name),
    });
  return out;
}

// ---- the rewind dialog (D30, M7) ---------------------------------------------------------------

export type RewindChoiceId = 'both' | 'conversation' | 'code' | 'cancel';

export interface RewindChoice {
  id: RewindChoiceId;
  label: string;
  hint: string;
  disabled?: string;
}

/** What the dialog knows of the picked point's "restore code" preview. */
export interface RewindPreview {
  state: 'none' | 'loading' | 'done' | 'failed';
  result?: FileRewindWire;
  error?: string;
}

/**
 * The terminal app's rewind menu for one picked message: "Restore code and conversation",
 * "Restore conversation", "Restore code", "Never mind". Its "Summarize from here" and
 * "Summarize up to here" have no control outside the terminal app, so they are not offered.
 * Restoring the conversation makes a branch (a DSH fork): this session stays as it is (D30).
 */
export function rewindChoices(opts: RewindOptionsWire, point: RewindPointWire, preview: RewindPreview): RewindChoice[] {
  const name = opts.displayName;
  const forkable = point.forkSeq !== undefined;
  const noFork = forkable ? undefined : 'Nothing comes before the first message: open a new session to start over.';
  const noCheckpoints = opts.fileRewind
    ? undefined
    : `${name} keeps no file checkpoints here (its settings turn them off).`;
  const out: RewindChoice[] = [];
  const both: RewindChoice = {
    id: 'both',
    label: 'Restore code and conversation',
    hint: `A new branch that ends before this message; when ${name} starts there, the files go back as they were before it.`,
  };
  const bothBlocked = noFork ?? noCheckpoints;
  if (bothBlocked) both.disabled = bothBlocked;
  out.push(both);
  const conv: RewindChoice = {
    id: 'conversation',
    label: 'Restore conversation',
    hint: `A new branch that ends before this message. ${name} forgets what came after; the files stay as they are.`,
  };
  if (noFork) conv.disabled = noFork;
  out.push(conv);
  const code: RewindChoice = {
    id: 'code',
    label: 'Restore code',
    hint: `The files go back as they were before this message. The conversation here stays as it is.`,
  };
  if (noCheckpoints) code.disabled = noCheckpoints;
  else if (!opts.running) code.disabled = `Start ${name} first: it restores the files from its checkpoints.`;
  else if (preview.state === 'done' && preview.result?.ok && preview.result.filesChanged.length === 0)
    code.disabled = 'No file changed since this message.';
  else if (preview.state === 'done' && preview.result && !preview.result.ok)
    code.disabled = rewindResultText(preview.result, name);
  out.push(code);
  out.push({ id: 'cancel', label: 'Never mind', hint: 'Close without changes.' });
  return out;
}

/** The dialog's list label of one point. */
export function pointLabel(p: RewindPointWire): string {
  const text = p.text.replace(/\s+/g, ' ').trim();
  const att = p.attachments ? ` [+${p.attachments} ${p.attachments === 1 ? 'attachment' : 'attachments'}]` : '';
  return (text === '' ? '(no text)' : text) + att;
}

/** The dialog's note under the list. */
export const REWIND_SUMMARIZE_NOTE =
  "The terminal app's “Summarize from here” and “Summarize up to here” are not available outside it.";

// ---- the /clear divider and the /compact marker (D70, M5 leftover) -------------------------------

/** The agent commands whose run the chat marks. Matches `localRender` (commands-model). */
const CLEAR_NAMES = new Set(['clear', 'reset', 'new']);
const COMPACT_NAME = 'compact';

export interface CommandMarker {
  kind: 'cleared' | 'compacted';
  /** The typed message's seq (the node's anchor) and host time. */
  seq: number;
  time: number;
  args?: string;
}

/**
 * The marker a typed human message asks for. The agent answers `/clear` and `/compact` with no
 * message of its own (CLI 2.1.318 sends their output as a user frame), so the typed line itself,
 * kept in the log as the user wrote it (D22), is the anchor. Only a message that is exactly the
 * command (with `/compact` instructions after it) counts. `text` is the message's only part (the
 * port reads the event).
 */
export function commandMarkerOf(text: string, seq: number, time: number): CommandMarker | undefined {
  const match = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (!match) return undefined;
  const name = match[1]!;
  const args = (match[2] ?? '').trim();
  if (CLEAR_NAMES.has(name) && args === '') return { kind: 'cleared', seq, time };
  if (name === COMPACT_NAME) {
    const out: CommandMarker = { kind: 'compacted', seq, time };
    if (args !== '') out.args = args;
    return out;
  }
  return undefined;
}

/** How long after the typed `/compact` its compaction may start (it may wait for a turn). */
export const COMPACT_MATCH_WINDOW_MS = 30 * 60 * 1000;

export interface CompactOutcome {
  state: 'done' | 'failed' | 'running' | 'unknown';
  preTokens?: number;
  postTokens?: number;
  error?: string;
}

/**
 * The compaction a typed `/compact` at `time` ran: the first manual (or untagged) compaction that
 * starts after it, within {@link COMPACT_MATCH_WINDOW_MS}, and its end. The Host keeps these rows
 * in memory only, so after a DSH restart the outcome is 'unknown'.
 */
export function compactOutcome(
  time: number,
  usage: Pick<UsageViewWire, 'compactions'> | undefined,
  compactingNow: boolean,
): CompactOutcome {
  const rows = [...(usage?.compactions ?? [])].sort((a, b) => a.at - b.at);
  const start = rows.findIndex(
    (r) => r.at >= time && r.at - time <= COMPACT_MATCH_WINDOW_MS && r.trigger !== 'auto' && r.phase === 'start',
  );
  // An end with no start row (the start was cut off the kept list) still counts.
  const from = start >= 0 ? start : -1;
  const end = rows.findIndex(
    (r, i) =>
      i > from && r.phase === 'end' && r.trigger !== 'auto' && r.at >= time && r.at - time <= COMPACT_MATCH_WINDOW_MS,
  );
  if (end >= 0) {
    const r = rows[end]!;
    if (r.error !== undefined) return { state: 'failed', error: r.error };
    const o: CompactOutcome = { state: 'done' };
    if (r.preTokens !== undefined) o.preTokens = r.preTokens;
    if (r.postTokens !== undefined) o.postTokens = r.postTokens;
    return o;
  }
  if (start >= 0 && compactingNow) return { state: 'running' };
  if (start >= 0) return { state: 'unknown' };
  return { state: compactingNow ? 'running' : 'unknown' };
}

/** The marker's words for a `/compact` outcome. */
export function compactMarkerText(o: CompactOutcome, name: string, fmt: (n: number) => string): string {
  switch (o.state) {
    case 'done':
      return o.preTokens !== undefined && o.postTokens !== undefined
        ? `Conversation compacted (${fmt(o.preTokens)} → ${fmt(o.postTokens)} tokens)`
        : 'Conversation compacted';
    case 'failed':
      return `Compaction failed: ${o.error ?? 'no reason given'}`;
    case 'running':
      return `${name} is compacting the conversation…`;
    default:
      return `Compaction requested here (${name}'s result is not known in this view)`;
  }
}
