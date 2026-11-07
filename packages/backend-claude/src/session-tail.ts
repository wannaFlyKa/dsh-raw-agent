// M7 (R3.6): the main-thread record past one chain entry, read from the CLI's own transcript.
// Pure logic; no process, no SDK import. The DSH layer compares it with its log, so a reply the
// CLI wrote but the host never got (the host died mid-turn, or the CLI died before its last
// stdout frames arrived) is shown, not lost.

import type { AgentRef, BackendEvent, ContentBlock, SessionTail } from '@dsh-raw-agent/core';
import { convertBlock, convertToolResultContent } from './mapper.js';
import { canonicalModel } from './model-id.js';
import { isObject, str, type WireBlock } from './wire.js';

const MAIN: AgentRef = Object.freeze({ kind: 'main' }) as AgentRef;

type Entry = Record<string, unknown>;
type StepMessage = Extract<BackendEvent, { type: 'step-message' }>;

/** The text blocks of a user entry, joined (a string content counts as one block). */
function userText(entry: Entry): string {
  const msg = entry.message;
  if (!isObject(msg)) return '';
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .filter((b): b is Entry => isObject(b) && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

/** CLI context the TUI does not show as a message. */
function isReminder(text: string): boolean {
  return /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/.test(text);
}

/** `<summary>…</summary>` of a task notification, if it has one. */
function notificationSummary(text: string): string | undefined {
  const m = /<summary>([\s\S]*?)<\/summary>/.exec(text);
  const s = m?.[1]?.trim();
  return s ? s.slice(0, 200) : undefined;
}

/**
 * The entries past `afterUuid` on its chain (the main thread only), mapped to the events the live
 * stream gives. An entry is on the chain when its `parentUuid` (or, for a compaction boundary, its
 * `logicalParentUuid`) is on it. A line the CLI is still writing is skipped.
 *
 * One CLI message (`message.id`) is one step; its blocks come in one `step-message` with
 * `final: true`. Usage is not carried: the host already counted what it saw, and the CLI's
 * transcript usage for a message it never finished streaming is not a figure we show (rule 11).
 */
export function sessionTail(
  transcript: string,
  afterUuid: string,
  at: number,
): Omit<SessionTail, 'status'> & {
  found: boolean;
} {
  const out: Omit<SessionTail, 'status'> & { found: boolean } = {
    found: false,
    events: [],
    prompts: [],
    notes: [],
    orphanResults: 0,
  };
  const chain = new Set<string>();
  const advertised = new Set<string>();
  let pending: StepMessage | undefined;
  const flush = () => {
    if (!pending) return;
    if (pending.blocks.length > 0) {
      out.events.push({ type: 'step-start', agent: MAIN, stepId: pending.stepId, at });
      out.events.push(pending);
      for (const b of pending.blocks) if (b.type === 'tool-call') advertised.add(b.id);
    }
    pending = undefined;
  };
  for (const line of transcript.split('\n')) {
    if (line.trim() === '') continue;
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(e)) continue;
    const uuid = str(e.uuid);
    if (!out.found) {
      if (uuid !== undefined && uuid === afterUuid) {
        out.found = true;
        chain.add(uuid);
        out.lastChainId = uuid;
      }
      continue;
    }
    if (uuid === undefined || e.isSidechain === true) continue;
    const parent = str(e.parentUuid) ?? (e.subtype === 'compact_boundary' ? str(e.logicalParentUuid) : undefined);
    if (parent === undefined || !chain.has(parent)) continue;
    chain.add(uuid);
    out.lastChainId = uuid;
    if (e.type === 'assistant') {
      const message = isObject(e.message) ? e.message : {};
      const stepId = str(message.id) ?? uuid;
      if (pending && pending.stepId !== stepId) flush();
      const model = canonicalModel(str(message.model));
      if (!pending) {
        pending = { type: 'step-message', agent: MAIN, stepId, blocks: [], final: true };
        if (model === '<synthetic>') pending.synthetic = true;
        else if (model !== undefined) pending.model = model;
      }
      const content = (Array.isArray(message.content) ? message.content : []) as WireBlock[];
      for (const raw of content) {
        const b: ContentBlock | undefined = convertBlock(raw);
        if (b === undefined) continue;
        if (b.type === 'reasoning' && b.text === '') continue; // D86: signed, empty thinking
        if (
          b.type === 'tool-call' &&
          (advertised.has(b.id) || pending.blocks.some((x) => x.type === 'tool-call' && x.id === b.id))
        )
          continue;
        pending.blocks.push(b);
      }
      pending.lastChainId = uuid;
      continue;
    }
    if (e.type === 'attachment') {
      const a = e.attachment;
      if (isObject(a) && a.type === 'queued_command') out.notes.push('a message queued in the agent');
      continue;
    }
    if (e.type !== 'user') continue;
    flush(); // a result or a new prompt follows the message before it
    const message = isObject(e.message) ? e.message : {};
    if (Array.isArray(message.content)) {
      for (const b of message.content) {
        if (!isObject(b) || b.type !== 'tool_result') continue;
        const callId = str(b.tool_use_id);
        if (callId === undefined) continue;
        if (!advertised.has(callId)) {
          out.orphanResults++;
          continue;
        }
        out.events.push({
          type: 'tool-result',
          agent: MAIN,
          callId,
          isError: b.is_error === true,
          content: convertToolResultContent(b.content),
          chainId: uuid,
        });
      }
    }
    const text = userText(e);
    if (text.trim() === '' || e.isMeta === true || isReminder(text) || text.startsWith('[Request interrupted'))
      continue;
    const origin = isObject(e.origin) ? str(e.origin.kind) : undefined;
    if (origin === 'task-notification' || text.trimStart().startsWith('<task-notification>')) {
      const s = notificationSummary(text);
      out.notes.push(s ? `a background task reported back: ${s}` : 'a background task reported back');
      continue;
    }
    if (origin !== undefined && origin !== 'human') {
      out.notes.push(`a ${origin} message`);
      continue;
    }
    out.prompts.push(text);
  }
  flush();
  return out;
}
