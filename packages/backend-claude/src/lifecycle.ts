// Fork, rewind and exit helpers (M7: D29, D30, R3.6). Pure logic; no process, no SDK import.

import type { ExitReason, FileRewindResult } from '@dsh-raw-agent/core';
import { isObject, str } from './wire.js';

/** The CLI's refusal of a validated cut (SDK/sdk.d.ts `resumeDropsTurn`: "starts with …"). */
export const DROPS_TURN_REFUSAL_PREFIX = 'Resume rejected by --resume-drops-turn:';

/** The largest source transcript the D29 turn count reads. A bigger one gets a plain cut. */
export const FORK_SCAN_LIMIT_BYTES = 64 * 1024 * 1024;

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * D29: the refusal text when this frame is the CLI's refusal of `resumeDropsTurn`, else
 * undefined. The CLI sends it as an `error_during_execution` result; the text may be in
 * `errors[]` or in `result`.
 */
export function dropsTurnRefusal(raw: unknown): string | undefined {
  if (!isObject(raw) || raw.type !== 'result') return undefined;
  for (const t of [...strList(raw.errors), str(raw.result) ?? ''])
    if (t.trimStart().startsWith(DROPS_TURN_REFUSAL_PREFIX)) return t.trim();
  return undefined;
}

/** The same refusal inside an error message or stderr text (a CLI that exits with it). */
export function refusalInText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const i = text.indexOf(DROPS_TURN_REFUSAL_PREFIX);
  if (i < 0) return undefined;
  return text.slice(i).split('\n')[0]?.trim();
}

export interface CutCheck {
  /** true: pass `resumeDropsTurn`. */
  validated: boolean;
  /** Why not, for the debug log and tests. */
  reason: string;
}

type Entry = Record<string, unknown>;

function userText(entry: Entry): string {
  const msg = entry.message;
  if (!isObject(msg)) return '';
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .filter((b): b is Entry => isObject(b) && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
}

function onlyToolResults(entry: Entry): boolean {
  const msg = entry.message;
  if (!isObject(msg) || !Array.isArray(msg.content) || msg.content.length === 0) return false;
  return msg.content.every((b) => isObject(b) && b.type === 'tool_result');
}

/**
 * D29 (r3): may the fork pass `resumeDropsTurn: hint`? Only when exactly one user-started CLI
 * turn lies past the cut, and it is the hinted one. Reads the source transcript text (JSONL, the
 * CLI's own file; it may still grow while the source runs, so a cut last line is skipped).
 *
 * Past the cut means: the entries whose parent chain leads back to the cut entry. Kinds that make
 * the range hold more than one turn, so the cut is a plain truncation:
 * - a second prompt (a `user` entry with human or no origin that is not tool results, an
 *   interrupt marker or meta),
 * - a task notification (a wake turn: `origin.kind: 'task-notification'` or the
 *   `<task-notification>` text),
 * - a queued command the CLI absorbed mid-turn (`attachment.type: 'queued_command'`),
 * - a user entry with any other origin (a peer message).
 */
export function checkDropsTurn(transcript: string, cutUuid: string, hint: string): CutCheck {
  const chain = new Set<string>();
  let foundCut = false;
  const prompts: string[] = [];
  for (const line of transcript.split('\n')) {
    if (line.trim() === '') continue;
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // a line the source CLI is still writing
    }
    if (!isObject(e)) continue;
    const uuid = str(e.uuid);
    if (!foundCut) {
      if (uuid === cutUuid) {
        foundCut = true;
        chain.add(cutUuid);
      }
      continue;
    }
    const parent = str(e.parentUuid);
    if (uuid === undefined || parent === undefined || !chain.has(parent)) continue;
    if (e.isSidechain === true) continue;
    chain.add(uuid);
    if (e.type === 'attachment') {
      const a = e.attachment;
      if (isObject(a) && a.type === 'queued_command')
        return { validated: false, reason: 'a queued message lies past the cut' };
      continue;
    }
    if (e.type !== 'user') continue;
    const origin = isObject(e.origin) ? str(e.origin.kind) : undefined;
    const text = userText(e);
    if (origin === 'task-notification' || text.trimStart().startsWith('<task-notification>'))
      return { validated: false, reason: 'a task notification lies past the cut' };
    if (e.isMeta === true || onlyToolResults(e) || text.startsWith('[Request interrupted')) continue;
    if (origin !== undefined && origin !== 'human')
      return { validated: false, reason: `a ${origin} message lies past the cut` };
    prompts.push(uuid);
  }
  if (!foundCut) return { validated: false, reason: 'the cut entry is not in the source transcript' };
  if (prompts.length === 0) return { validated: false, reason: 'no turn lies past the cut' };
  if (prompts.length > 1) return { validated: false, reason: `${prompts.length} turns lie past the cut` };
  if (prompts[0] !== hint) return { validated: false, reason: 'the turn past the cut is not the hinted one' };
  return { validated: true, reason: 'exactly the hinted turn lies past the cut' };
}

/** The note shown after a refused validated cut (D29). The source process is left alone. */
export function refusalNote(refusal: string): string {
  return `Claude Code refused the exact rewind check (${refusal.slice(DROPS_TURN_REFUSAL_PREFIX.length).trim() || 'no detail'}). The fork goes on with a plain cut at the same point: anything the source took in after that point is left out too.`;
}

/** D30: the SDK's `RewindFilesResult` in our shape. */
export function toFileRewindResult(raw: unknown, dryRun: boolean): FileRewindResult {
  const r = isObject(raw) ? raw : {};
  const out: FileRewindResult = { ok: r.canRewind === true, filesChanged: strList(r.filesChanged) };
  const error = str(r.error);
  if (error !== undefined && error !== '') out.error = error;
  if (typeof r.insertions === 'number') out.insertions = r.insertions;
  if (typeof r.deletions === 'number') out.deletions = r.deletions;
  if (typeof r.skippedLinks === 'number' && r.skippedLinks > 0) out.skippedLinks = r.skippedLinks;
  if (dryRun) out.dryRun = true;
  if (!out.ok && out.error === undefined) out.error = 'Claude Code could not restore the files';
  return out;
}

/**
 * D30 (M7 live, CLI 2.1.318): a real `rewind_files` answers only `{canRewind, skippedLinks}`;
 * the file list comes with the dry run. A restore that names no files takes them from the
 * dry run made just before it, so the user sees what changed, not "no file needed restoring".
 */
export function withPreview(
  real: FileRewindResult,
  rawReal: unknown,
  preview: FileRewindResult | undefined,
): FileRewindResult {
  if (!real.ok || preview === undefined || !preview.ok) return real;
  if (isObject(rawReal) && Array.isArray(rawReal.filesChanged)) return real;
  const out: FileRewindResult = { ...real, filesChanged: preview.filesChanged };
  if (preview.insertions !== undefined) out.insertions = preview.insertions;
  if (preview.deletions !== undefined) out.deletions = preview.deletions;
  return out;
}

/** What the process left behind when it ended (from our spawn hook). */
export interface ProcessExit {
  code: number | null;
  signal: string | null;
  /** The end of its error output. */
  stderr: string;
}

/** The last lines of the CLI's error output, short enough for a notice. */
export function stderrTail(text: string, maxLines = 12, maxChars = 1500): string {
  const lines = text
    .replace(/\r\n/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '');
  let out = lines.slice(-maxLines).join('\n');
  if (out.length > maxChars) out = `…${out.slice(out.length - maxChars)}`;
  return out;
}

export interface ExitDescription {
  reason: ExitReason;
  error?: string;
  code?: number;
  signal?: string;
}

/**
 * R3.6: a clear reason for the end of the process. `asked`: we disposed or force-stopped it.
 * `sdkError`: what the SDK iterator threw, if anything. `proc`: the exit code, signal and the end
 * of stderr, when the spawn hook saw them. `error` is the detail only (the DSH layer words the
 * sentence around it: "<name> stopped unexpectedly: <error>. …").
 */
export function describeExit(input: {
  asked?: 'disposed' | 'force-stopped';
  sdkError?: string;
  proc?: ProcessExit;
}): ExitDescription {
  const proc = input.proc;
  const out: ExitDescription = { reason: input.asked ?? 'crashed' };
  if (proc?.code !== null && proc?.code !== undefined) out.code = proc.code;
  if (proc?.signal !== null && proc?.signal !== undefined) out.signal = proc.signal;
  if (input.asked !== undefined) return out;
  const tail = proc ? stderrTail(proc.stderr) : '';
  const parts: string[] = [];
  if (out.signal !== undefined)
    parts.push(
      out.signal === 'SIGKILL'
        ? 'it was killed (SIGKILL: out of memory, or another program ended it)'
        : `it was ended by the signal ${out.signal}`,
    );
  else if (out.code !== undefined && out.code !== 0) parts.push(`it exited with code ${out.code}`);
  else if (input.sdkError === undefined) {
    out.reason = 'ended';
    parts.push(`it ended by itself${out.code === 0 ? ' (exit code 0)' : ''}`);
  }
  // The SDK's own text adds nothing when it only repeats the exit code or signal.
  const sdk = input.sdkError?.trim();
  if (sdk && !/^Claude Code process (exited with code|terminated by signal)/i.test(sdk) && !tail.includes(sdk))
    parts.push(sdk);
  else if (sdk && parts.length === 0) parts.push(sdk);
  if (tail !== '') parts.push(`its last error output was:\n${tail}`);
  out.error = parts.join('; ');
  return out;
}
