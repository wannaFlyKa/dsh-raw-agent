// M7: what the DSH log says about a fork's cut and the last host stop (D29, D30, D75). Pure
// functions over DSH session events, so they are tested without a host.
//
// DSH fork seeds (`P/dsh-session/lib/index.js` `buildForkSeed`): the source events up to the
// inclusive cut keep their seqs, then one `session/end-seed {inherited: true}`, then, for a cut
// inside an open turn, synthetic closers whose `turn/end` reason kind is `forked`.

import { TEARDOWN_REASONS } from './jobs.js';
import type { RewindPoint } from '../driver.js';
import type { DshEvent } from './types.js';

/** Where a fork's inherited prefix ends, if this log is a fork. */
export interface ForkCut {
  /** The last inherited source seq (the inclusive cut). */
  boundarySeq: number;
  /** The cut was inside a turn (DSH added `forked` closers). */
  midTurn: boolean;
  /** The kept prefix holds a child agent's own log (`subagent/descriptor`). */
  childPrefix: boolean;
}

export function forkCut(events: readonly DshEvent[]): ForkCut | undefined {
  let marker = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'session/end-seed' && (e.data as { inherited?: unknown }).inherited === true) {
      marker = i;
      break;
    }
  }
  if (marker <= 0) return undefined;
  let midTurn = false;
  for (let i = marker + 1; i < events.length; i++) {
    const e = events[i]!;
    if (e.type === 'turn/start') break; // the fork's own turns
    const reason = (e.data as { reason?: { kind?: unknown } }).reason;
    if (e.type === 'turn/end' && reason?.kind === 'forked') midTurn = true;
  }
  let childPrefix = false;
  for (let i = 0; i < marker; i++) if (events[i]!.type === 'subagent/descriptor') childPrefix = true;
  return { boundarySeq: events[marker - 1]!.seq, midTurn, childPrefix };
}

/**
 * D29: the id of the human message that opened the first source turn past the cut. Undefined when
 * the cut is inside a turn, or that turn opened without a human message (a wake turn).
 */
export function droppedHumanMessage(source: readonly DshEvent[], cut: ForkCut): string | undefined {
  if (cut.midTurn) return undefined;
  let inTurn = false;
  for (const e of source) {
    if (e.seq <= cut.boundarySeq) continue;
    if (e.type === 'turn/start') {
      if (inTurn) return undefined;
      inTurn = true;
      continue;
    }
    if (e.type === 'turn/end' && inTurn) return undefined;
    if (!inTurn || e.type !== 'user/message') continue;
    const m = e.data as { id?: unknown; source?: { kind?: unknown } };
    if (m.source?.kind === 'user' && typeof m.id === 'string') return m.id;
  }
  return undefined;
}

/**
 * D75 (M7): the labels of our background-task jobs that this log shows as still running, or as
 * torn down by the host (its shutdown or an agent dispose), with no later normal end of a job with
 * the same kind and label (a task linked again after an eviction, D87). **Unverified**: which
 * of the two teardown reasons a DSH stop writes, or whether it writes one at all.
 */
export function tasksEndedByStop(events: readonly DshEvent[], kindPrefix = 'raw-agent-'): string[] {
  const ended = new Map<string, string>(); // key → label
  for (const e of events) {
    if (e.type !== 'job/registered' && e.type !== 'job/settled') continue;
    const d = e.data as { jobId?: unknown; kind?: unknown; label?: unknown; detail?: unknown; settleCause?: unknown };
    if (typeof d.jobId !== 'string' || typeof d.kind !== 'string' || !d.kind.startsWith(kindPrefix)) continue;
    const label = typeof d.label === 'string' ? d.label : d.kind;
    const key = `${d.kind}\u0000${label}`;
    if (e.type === 'job/registered') {
      ended.set(key, label); // running until it settles
      continue;
    }
    const teardown =
      d.settleCause === 'teardown' || (typeof d.detail === 'string' && TEARDOWN_REASONS.includes(d.detail));
    if (teardown) ended.set(key, label);
    else ended.delete(key);
  }
  return [...ended.values()];
}

/** The longest message text a rewind point carries. */
export const REWIND_TEXT_MAX = 300;
/** The most recent points the dialog lists. */
export const REWIND_POINTS_MAX = 200;

/**
 * D30 (M7): the turns a human message opened, oldest first, as the terminal app's rewind menu
 * lists the user's prompts. A turn that opened with a step (a wake turn, D26) is no point; a
 * message typed while a turn ran (a steer) is part of that turn. Pure, over the session's log.
 */
export function rewindPoints(events: readonly DshEvent[]): RewindPoint[] {
  let marker = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'session/end-seed' && (e.data as { inherited?: unknown }).inherited === true) {
      marker = e.seq;
      break;
    }
  }
  const out: RewindPoint[] = [];
  let lastEnd: number | undefined;
  let inTurn = false;
  let opened = false;
  for (const e of events) {
    if (e.type === 'turn/start') {
      inTurn = true;
      opened = false;
      continue;
    }
    if (e.type === 'turn/end') {
      inTurn = false;
      lastEnd = e.seq;
      continue;
    }
    if (!inTurn || opened) continue;
    if (e.type === 'step/start') {
      opened = true; // the turn opened without a human message (a wake turn)
      continue;
    }
    if (e.type !== 'user/message') continue;
    opened = true;
    const m = e.data as { id?: unknown; source?: { kind?: unknown }; content?: unknown };
    if (m.source?.kind !== 'user' || typeof m.id !== 'string') continue;
    const blocks = Array.isArray(m.content) ? (m.content as Array<{ type?: unknown; text?: unknown }>) : [];
    const text = blocks
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n')
      .trim();
    const p: RewindPoint = {
      messageId: m.id,
      text: text.length > REWIND_TEXT_MAX ? `${text.slice(0, REWIND_TEXT_MAX)}…` : text,
      at: e.time,
    };
    const other = blocks.filter((b) => b?.type !== 'text').length;
    if (other > 0) p.attachments = other;
    if (lastEnd !== undefined) p.forkSeq = lastEnd;
    if (marker >= 0 && e.seq < marker) p.inherited = true;
    out.push(p);
  }
  return out.slice(-REWIND_POINTS_MAX);
}
