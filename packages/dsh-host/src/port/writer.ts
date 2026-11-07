// The native event writer (D17, D18, D20, D21, D74). The only code that appends transcript events.
//
// Each method asserts the v4 rule it could break *before* it appends, and refuses the append by
// throwing WriterAssertError (DSH checks these rules only when a log is loaded, so a bad append is
// silent until the session no longer opens: dsh-claude issue #57). The rules, from
// `P/dsh-session-format-v3-to-v4/lib/index.js` (see docs/research/dsh-seams.md §2.2):
//   (a) assistant/message and tool/call only inside an open step of the open turn;
//   (b) a tool/call only for a tool-call block advertised in this step, same id, identical name
//       and byte-identical arguments, once;
//   (c) every advertised call has a tool/result before step/end;
//   (d, f) every assistant/message has a stream that alone reproduces content, usage and
//       replayState (the generation check, `P/dsh-session-persistence-jsonl/lib/index.js:1838`);
//   (e) known event types only; never a `plugin:` type (D17 e);
//   (h) every driver-written agent/inbox/spliced is valid against the current inbox projection
//       (`start`/`removedCount` in range, no duplicate pending id; `P/dsh-agent-loop/lib/index.js:33-58`).
// Steps are numbered by the writer; the loop opened the turn and writes turn/end itself.

import { randomUUID } from 'node:crypto';
import { PLUGIN_SOURCE_KIND } from '@dsh-raw-agent/core';
import { StreamRecorder, deepEqual, replayStream } from './stream.js';
import type { DshBlock, DshChunk, DshInbox, DshSession, DshStreamRecord, DshUsage, DshUserMessage } from './types.js';

export class WriterAssertError extends Error {
  override readonly name = 'WriterAssertError';
}

/** Model-visible wording of DSH's own repair result for a started call (`P/dsh-session/lib/index.js:730-733`). */
export const REPAIR_STARTED_TEXT =
  'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.';

/** The event types this writer may append (rule e). */
export const WRITER_EVENT_TYPES: readonly string[] = Object.freeze([
  'user/message',
  'step/start',
  'assistant/message',
  'assistant/attempt',
  'tool/call',
  'tool/result',
  'step/end',
  'agent/inbox/spliced',
  // D44: DSH's log-only approval audit pair (`P/dsh-user-approval/lib/types/types.d.ts:25-52`).
  'approval/asked',
  'approval/decided',
  // D26 (M3): the visible trigger of a wake turn, a native step event that is never sent to the agent.
  'developer/message',
]);

/** DSH's closed approval outcomes that this writer records (D44). */
export type ApprovalAuditOutcome = 'allowed-once' | 'rejected' | 'cancelled';

/** One driver-written inbox splice (D3, D25, D27). Never carries an `outcome`. */
export interface InboxSplice {
  target: 'next-turn' | 'next-step';
  start: number;
  removedCount?: number;
  inserted: DshUserMessage[];
}

/**
 * Append a driver-owned `agent/inbox/spliced` after asserting D17 (h) against the live inbox
 * projection. DSH folds the event into `nextTurn`/`nextStep` itself; an invalid splice would make
 * the log unloadable (`invalid persisted inbox splice`), so it is refused before the append.
 */
export function spliceInbox(session: DshSession, inbox: DshInbox, splice: InboxSplice): number {
  const list =
    splice.target === 'next-turn' ? inbox.nextTurn : splice.target === 'next-step' ? inbox.nextStep : undefined;
  if (list === undefined)
    throw new WriterAssertError(`refused inbox splice: unknown target ${String(splice.target)} (rule h)`);
  const removed = splice.removedCount ?? 0;
  if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > list.length)
    throw new WriterAssertError(`refused inbox splice: start ${splice.start} out of range (rule h)`);
  if (!Number.isSafeInteger(removed) || removed < 0 || splice.start + removed > list.length)
    throw new WriterAssertError(`refused inbox splice: removedCount ${removed} out of range (rule h)`);
  const next = list.toSpliced(splice.start, removed, ...splice.inserted);
  const other = splice.target === 'next-turn' ? inbox.nextStep : inbox.nextTurn;
  const ids = new Set<string>();
  for (const m of [...next, ...other]) {
    if (ids.has(m.id)) throw new WriterAssertError(`refused inbox splice: message ${m.id} is already pending (rule h)`);
    ids.add(m.id);
  }
  const data: Record<string, unknown> = { target: splice.target, start: splice.start, inserted: splice.inserted };
  if (removed > 0) data.removedCount = removed;
  return session.append('agent/inbox/spliced', data).seq;
}

export type LiveFrame =
  | { type: 'start'; attemptId: string; revision: number; turn: number; step: number }
  | { type: 'chunk'; attemptId: string; revision: number; index: number; time: number; chunk: DshChunk }
  | {
      type: 'end';
      attemptId: string;
      revision: number;
      index: number;
      outcome:
        | { kind: 'committed'; eventType: 'assistant/message' | 'assistant/attempt'; seq: number }
        | { kind: 'abandoned' };
    };

/** Per-agent live stream counters (D20: the driver owns attempt ids and revisions). */
export interface LiveChannel {
  emit(frame: LiveFrame): void;
  nextRevision(): number;
  nextAttemptId(): string;
}

/**
 * One `tool/result` content block: text, or DSH's native image block with an attachment ref from
 * `ctx.attachments.saveImages()` (D85, `P/dsh-llm/lib/types/types.d.ts:66-77`). Never base64.
 */
export type ToolResultBlock = { type: 'text'; text: string } | { type: 'image'; attachment: unknown };

/**
 * R8.4: a live delta stamped this long before its step opened means the step was opened late
 * (a buffered wake turn, D26), so DSH's time to first token and speed would be wrong.
 */
export const UNTIMED_SKEW_MS = 250;
/**
 * R8.4: a step whose output over its decode window is above this speed is a burst (the API sent
 * a short answer at once), not a real speed. Such a step keeps its usage but no timing. The
 * ceiling is above any published Claude output speed (**unverified** for future fast modes).
 */
export const MAX_PLAUSIBLE_TOKENS_PER_SECOND = 500;

export interface CommitInput {
  blocks: DshBlock[];
  usage?: DshUsage;
  model?: string;
  interrupted?: boolean;
  /**
   * A further CLI message of the same step (D84 whole responses arrive one block per frame,
   * D68). Several assistant/message events per step are legal; each has its own stream.
   */
  continued?: boolean;
  /** Native-field binding (D21); also the finish chunk's replayState. */
  binding: Record<string, unknown>;
}

interface Call {
  name: string;
  arguments: string;
  seq: number;
  resolved: boolean;
}

export interface WriterOptions {
  provider: string;
  now?: () => number;
  /** Test switch: skip the stream self-check, to prove the harness catches what it would refuse. */
  skipStreamCheck?: boolean;
  /** Where refusals and fallbacks are reported. */
  warn?: (note: string, detail?: unknown) => void;
}

export class TurnLog {
  readonly #session: DshSession;
  readonly #live: LiveChannel;
  readonly #turn: number;
  readonly #opts: WriterOptions;
  readonly #now: () => number;
  #step = 0;
  #stepOpen = false;
  #closed = false;
  #hasMessage = false;
  #calls = new Map<string, Call>();
  #recorder = new StreamRecorder();
  #attemptId = '';
  #frameIndex = 0;
  /** Block indices that already have a block-start chunk in this attempt. */
  #started = new Set<number>();
  /** D44: audit ids asked in this turn without a decision yet. */
  readonly #approvals = new Set<string>();
  #triggered = false;
  /** R8.4: when the open step started (its request), and its first token. */
  #openedAt = 0;
  #firstTokenAt: number | undefined;
  #reasoningStreamed = false;
  /** R8.4: this step's live timing is not real; its durable stream gets no deltas. */
  #untimed = false;
  /** Tool-call blocks that already have their first-token marker in this attempt. */
  #toolMarked = new Set<number>();

  constructor(session: DshSession, live: LiveChannel, turn: number, opts: WriterOptions) {
    this.#session = session;
    this.#live = live;
    this.#turn = turn;
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
  }

  get turn(): number {
    return this.#turn;
  }
  get step(): number {
    return this.#step;
  }
  get stepOpen(): boolean {
    return this.#stepOpen;
  }
  get hasMessage(): boolean {
    return this.#hasMessage;
  }
  /** Written calls without a result in the open step. */
  get openCallIds(): string[] {
    return [...this.#calls].filter(([, c]) => !c.resolved).map(([id]) => id);
  }
  hasCall(callId: string): boolean {
    return this.#calls.has(callId);
  }

  #append(type: string, data: unknown, options?: { surfaceOp?: 'append'; sourceEventSeqs?: number[] }): number {
    if (!WRITER_EVENT_TYPES.includes(type) || type.startsWith('plugin:'))
      throw new WriterAssertError(`refused unknown event type ${type} (rule e)`);
    if (this.#closed) throw new WriterAssertError(`refused ${type}: the turn is closed`);
    return this.#session.append(type, data, options).seq;
  }

  /**
   * The human message, unchanged (D22). Only between steps. A granted plugin message (D66,
   * `source.kind: 'raw-agent-plugin'`, admitted by the caller) is written unchanged too, so the log
   * shows who sent it.
   */
  writeUser(message: DshUserMessage): void {
    if (this.#stepOpen) throw new WriterAssertError('refused user/message inside an open step');
    if (message.source.kind !== 'user' && message.source.kind !== PLUGIN_SOURCE_KIND)
      throw new WriterAssertError('refused a non-human user/message');
    this.#append('user/message', message, { surfaceOp: 'append' });
  }

  /**
   * Open a step. `startedAt`: when the agent really began it (its request, or its response when
   * no request was seen). A step opened well after that has no real timing (R8.4).
   */
  openStep(startedAt?: number): void {
    if (this.#stepOpen) throw new WriterAssertError('refused step/start: a step is already open');
    this.#step += 1;
    this.#append('step/start', { turn: this.#turn, step: this.#step });
    this.#stepOpen = true;
    this.#hasMessage = false;
    this.#calls = new Map();
    this.#openedAt = this.#now();
    this.#untimed = startedAt !== undefined && this.#openedAt - startedAt > UNTIMED_SKEW_MS;
    this.#beginAttempt();
  }

  /** R8.4: whether the open step's timing reaches DSH (tests and diagnostics). */
  get stepTimed(): boolean {
    return this.#stepOpen && !this.#untimed;
  }

  #beginAttempt(): void {
    this.#recorder = new StreamRecorder();
    this.#started = new Set();
    this.#toolMarked = new Set();
    this.#firstTokenAt = undefined;
    this.#reasoningStreamed = false;
    this.#frameIndex = 0;
    this.#attemptId = this.#live.nextAttemptId();
    // D20: `start` right after step/start, before any other append.
    this.#live.emit({
      type: 'start',
      attemptId: this.#attemptId,
      revision: this.#live.nextRevision(),
      turn: this.#turn,
      step: this.#step,
    });
  }

  #push(chunk: DshChunk, time: number): void {
    const c = this.#recorder.push(time, chunk);
    this.#live.emit({
      type: 'chunk',
      attemptId: this.#attemptId,
      revision: this.#live.nextRevision(),
      index: this.#frameIndex++,
      time,
      chunk: c,
    });
  }

  /** Start blocks up to `index` so DSH's assembler keeps block order (earlier, unseen ones as placeholders). */
  #startUpTo(index: number, blockType: string, time: number): void {
    for (let i = 0; i <= index; i++) {
      if (this.#started.has(i)) continue;
      this.#started.add(i);
      this.#push({ type: 'block-start', index: i, blockType: i === index ? blockType : 'text' }, time);
    }
  }

  /**
   * A live delta (D20), stamped with its real arrival time. Tool-input text is not streamed (D21):
   * a tool call gets one name-only `tool-call-delta` at its first input, as DSH's own providers
   * send at a call's start, so a step with only a tool call still has a real first token (R8.4).
   * The block-end of the call decides its content.
   */
  delta(
    kind: 'text' | 'reasoning' | 'tool-input',
    blockIndex: number,
    text: string,
    at: number,
    tool?: { id: string; name: string },
  ): void {
    if (!this.#stepOpen || this.#hasMessage || text === '') return;
    let time = Math.max(Math.trunc(at), 0);
    if (this.#openedAt - time > UNTIMED_SKEW_MS) this.#untimed = true;
    time = Math.max(time, this.#openedAt); // a small skew: never a token before its step
    if (kind === 'tool-input') {
      if (tool === undefined || tool.id === '' || tool.name === '' || this.#toolMarked.has(blockIndex)) return;
      if (this.#started.has(blockIndex)) return; // the slot already holds another block type
      this.#toolMarked.add(blockIndex);
      this.#startUpTo(blockIndex, 'tool-call', time);
      this.#firstTokenAt ??= time;
      this.#push(
        { type: 'tool-call-delta', index: blockIndex, id: tool.id, name: tool.name, argumentsDelta: '' },
        time,
      );
      return;
    }
    this.#startUpTo(blockIndex, kind, time);
    this.#firstTokenAt ??= time;
    if (kind === 'reasoning') this.#reasoningStreamed = true;
    this.#push({ type: kind === 'text' ? 'text-delta' : 'reasoning-delta', index: blockIndex, text }, time);
  }

  /**
   * R8.4: may this step's live timing reach DSH's TTFT and speed figures? Not when the step was
   * opened late, when its thinking was counted but never streamed (the speed would include the
   * hidden thinking), or when its output came as a burst faster than any model writes.
   */
  #timingHonest(usage: DshUsage | undefined, at: number): boolean {
    if (this.#untimed) return false;
    if (usage === undefined || this.#firstTokenAt === undefined) return true;
    if ((usage.reasoningTokens ?? 0) > 0 && !this.#reasoningStreamed) return false;
    const decodeMs = at - this.#firstTokenAt;
    if (usage.outputTokens <= 0) return true;
    if (decodeMs <= 0) return false;
    return (usage.outputTokens * 1000) / decodeMs <= MAX_PLAUSIBLE_TOKENS_PER_SECOND;
  }

  /**
   * Write the step's assistant/message (with its embedded stream), then a tool/call per kept
   * tool-call block (D18). An interrupted message keeps only its text prefix and no usage or
   * finish; an empty interrupted prefix becomes an assistant/attempt.
   */
  commit(input: CommitInput): { calls: string[] } {
    if (!this.#stepOpen) throw new WriterAssertError('refused assistant/message outside an open step (rule a)');
    if (this.#hasMessage && input.continued !== true)
      throw new WriterAssertError('refused a second main-thread assistant/message in one step');
    const interrupted = input.interrupted === true;
    if (interrupted && input.blocks.some((b) => b.type === 'tool-call'))
      throw new WriterAssertError('refused interrupted assistant/message that keeps a tool call (D17 f)');
    // W1: every tool-call id is checked BEFORE anything is appended. The checker refuses a message
    // that repeats an advertised id (`P/dsh-session-format-v3-to-v4/lib/index.js:630`), so an exact
    // repeat (a re-sent frame) is dropped and a conflicting one refuses the whole message.
    input = { ...input, blocks: this.#uniqueCalls(input.blocks) };
    if (this.#hasMessage) {
      if (input.blocks.length === 0) return { calls: [] };
      this.#beginAttempt(); // a further message of this step gets its own live attempt
    }
    const replayState = { response: input.binding };
    const hasCall = input.blocks.some((b) => b.type === 'tool-call');

    const encodeTail = (time: number) => {
      input.blocks.forEach((block, i) => {
        this.#startUpTo(i, block.type, time);
        this.#push({ type: 'block-end', index: i, block: structuredClone(block) }, time);
      });
      if (!interrupted) {
        if (input.usage !== undefined) this.#push({ type: 'usage', usage: input.usage }, time);
        this.#push({ type: 'finish', reason: { kind: hasCall ? 'tool-calls' : 'stop' }, replayState }, time);
      }
    };
    const expected = interrupted
      ? input.blocks.filter((b) => (b.type === 'text' || b.type === 'reasoning') && b.text.trim() !== '')
      : input.blocks;
    const at = Math.max(this.#now(), this.#firstTokenAt ?? 0);
    // R8.4: a step whose timing is not real keeps its content and usage but no deltas, so DSH
    // counts no first token and no speed for it (its live view already streamed).
    if (!this.#recorder.empty && !this.#timingHonest(interrupted ? undefined : input.usage, at)) {
      this.#recorder = new StreamRecorder();
      this.#started = new Set();
    }
    encodeTail(at);
    let records = this.#recorder.snapshot();
    if (!this.#opts.skipStreamCheck && !deepEqual(this.#content(records, interrupted), expected)) {
      // The live deltas do not assemble to the final blocks (a dropped tail slot, for example).
      // Fall back to a stream with no deltas: block-end per block. Timing is lost, the log stays valid.
      this.#opts.warn?.('stream fallback: live deltas did not reproduce the final blocks', { step: this.#step });
      this.#recorder = new StreamRecorder();
      this.#started = new Set();
      encodeTail(at);
      records = this.#recorder.snapshot();
    }
    const content = this.#content(records, interrupted);

    if (interrupted && content.length === 0) {
      const seq = this.#append('assistant/attempt', { turn: this.#turn, step: this.#step, stream: records });
      this.#endFrame({ kind: 'committed', eventType: 'assistant/attempt', seq });
      this.#hasMessage = true;
      return { calls: [] };
    }

    const source: Record<string, unknown> = {
      kind: 'model',
      provider: this.#opts.provider,
      model: input.model ?? 'settings',
      rawAgent: input.binding,
    };
    if (!interrupted) source.replayState = replayState;
    const message = { id: randomUUID(), role: 'assistant', content, source };
    const data: Record<string, unknown> = { turn: this.#turn, step: this.#step, message, stream: records };
    if (!interrupted && input.usage !== undefined) data.usage = input.usage;
    if (interrupted) data.interrupted = true;
    if (!this.#opts.skipStreamCheck) this.#assertStream(data);

    const seq = this.#append('assistant/message', data, { surfaceOp: 'append' });
    this.#endFrame({ kind: 'committed', eventType: 'assistant/message', seq });
    this.#hasMessage = true;

    const calls: string[] = [];
    for (const b of content) {
      if (b.type !== 'tool-call') continue;
      const callSeq = this.#append('tool/call', {
        turn: this.#turn,
        step: this.#step,
        callId: b.id,
        name: b.name,
        arguments: b.arguments,
      });
      this.#calls.set(b.id, { name: b.name, arguments: b.arguments, seq: callSeq, resolved: false });
      calls.push(b.id);
    }
    return { calls };
  }

  /** Drop exact repeats of a tool call (in this message or written earlier in the step); refuse a conflict. */
  #uniqueCalls(blocks: DshBlock[]): DshBlock[] {
    const seen = new Map<string, { name: string; arguments: string }>();
    for (const [id, c] of this.#calls) seen.set(id, c);
    const out: DshBlock[] = [];
    for (const b of blocks) {
      if (b.type !== 'tool-call') {
        out.push(b);
        continue;
      }
      const prior = seen.get(b.id);
      if (prior === undefined) {
        seen.set(b.id, { name: b.name, arguments: b.arguments });
        out.push(b);
        continue;
      }
      if (prior.name !== b.name || prior.arguments !== b.arguments)
        throw new WriterAssertError(`refused duplicate tool call id ${b.id} with different content (W1)`);
      this.#opts.warn?.('dropped a repeated tool call block (W1)', { callId: b.id, step: this.#step });
    }
    return out;
  }

  #content(records: DshStreamRecord[], interrupted: boolean): DshBlock[] {
    const r = replayStream(records);
    return interrupted ? r.interruptedBlocks : r.blocks;
  }

  /** D17 (f): the embedded stream alone must reproduce the event. */
  #assertStream(data: Record<string, unknown>): void {
    const r = replayStream(data.stream as DshStreamRecord[]);
    if (r.chunkCount === 0) throw new WriterAssertError('refused assistant/message with an empty stream (rule d)');
    const message = data.message as { content: unknown; source: { replayState?: unknown } };
    const content = data.interrupted === true ? r.interruptedBlocks : r.blocks;
    if (!deepEqual(message.content, content)) throw new WriterAssertError('refused: content disagrees with its stream');
    if (!deepEqual(data.usage, r.usage)) throw new WriterAssertError('refused: usage disagrees with its stream');
    if (!deepEqual(message.source.replayState, r.replayState))
      throw new WriterAssertError('refused: replay state disagrees with its stream');
  }

  #endFrame(outcome: Extract<LiveFrame, { type: 'end' }>['outcome']): void {
    this.#live.emit({
      type: 'end',
      attemptId: this.#attemptId,
      revision: this.#live.nextRevision(),
      index: this.#frameIndex,
      outcome,
    });
  }

  /** A tool/result for a call written in this step (rule b, D18 buffering happens in the mapper). */
  result(callId: string, content: ToolResultBlock[], isError: boolean, meta?: Record<string, unknown>): void {
    if (!this.#stepOpen) throw new WriterAssertError(`refused tool/result for ${callId} outside an open step`);
    const call = this.#calls.get(callId);
    if (call === undefined) throw new WriterAssertError(`refused tool/result for ${callId}: no tool/call in this step`);
    if (call.resolved) throw new WriterAssertError(`refused a second tool/result for ${callId}`);
    const message: Record<string, unknown> = {
      id: randomUUID(),
      role: 'tool',
      toolCallId: callId,
      source: { kind: 'tool', callId },
      content: content.length > 0 ? content : [{ type: 'text', text: '' }],
    };
    if (isError) message.isError = true;
    const data: Record<string, unknown> = { turn: this.#turn, step: this.#step, message };
    if (meta !== undefined) data.meta = meta;
    this.#append('tool/result', data, { surfaceOp: 'append', sourceEventSeqs: [call.seq] });
    call.resolved = true;
  }

  /**
   * Claim one pending steer at a step boundary (D27): a driver-owned `agent/inbox/spliced` that
   * removes it from `nextStep` with no `outcome`, then the unchanged `user/message`. Returns false
   * when the message is no longer pending (the user removed it, or DSH already claimed it).
   */
  claim(messageId: string, inbox: DshInbox): boolean {
    if (this.#stepOpen) throw new WriterAssertError('refused a claim inside an open step');
    if (this.#closed) throw new WriterAssertError('refused a claim: the turn is closed');
    const index = inbox.nextStep.findIndex((m) => m.id === messageId);
    if (index < 0) return false;
    const pending = inbox.nextStep[index]!;
    spliceInbox(this.#session, inbox, { target: 'next-step', start: index, removedCount: 1, inserted: [] });
    this.writeUser(pending);
    return true;
  }

  /**
   * Close the open step (D18, D74): an assistant/attempt when nothing was committed, DSH's exact
   * repair result for every unresolved call (rule c), then step/end.
   */
  closeStep(): void {
    if (!this.#stepOpen) return;
    if (!this.#hasMessage) {
      const stream = this.#recorder.snapshot();
      this.#append('assistant/attempt', { turn: this.#turn, step: this.#step, stream });
      this.#endFrame({ kind: 'abandoned' });
      this.#hasMessage = true;
    }
    for (const [callId, call] of this.#calls) {
      if (call.resolved) continue;
      const message = {
        id: `interrupted-tool-result-${callId}-${this.#session.seq + 1}`,
        role: 'tool',
        toolCallId: callId,
        isError: true,
        source: { kind: 'tool', callId },
        content: [{ type: 'text', text: REPAIR_STARTED_TEXT }],
      };
      this.#append(
        'tool/result',
        {
          turn: this.#turn,
          step: this.#step,
          message,
          error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' },
        },
        { surfaceOp: 'append', sourceEventSeqs: [call.seq] },
      );
      call.resolved = true;
    }
    this.#append('step/end', { turn: this.#turn, step: this.#step });
    this.#stepOpen = false;
  }

  /**
   * D26 (M3): the visible trigger of a wake turn: DSH's native `developer/message`, inside the open
   * step (a step event, `P/dsh-session-format-v3-to-v4/lib/index.js:492-496, 742`), with a
   * producer-owned source and the `notice` form, so DSH's chat shows its one-line summary
   * (`P/dsh-client-ui-chat/lib/client.js:5690-5697`). Not a `user/message` (D22, rule 3): the
   * agent is never sent it, and no host model runs in these sessions (D2). Once per turn.
   */
  trigger(text: string, sourceKind: string, items?: readonly string[]): void {
    if (!this.#stepOpen) throw new WriterAssertError('refused developer/message outside an open step');
    if (this.#triggered) return;
    if (text.trim() === '') throw new WriterAssertError('refused an empty wake trigger');
    const message = {
      id: randomUUID(),
      role: 'developer',
      content: [{ type: 'text', text }],
      source: {
        kind: sourceKind,
        form: 'notice',
        summary: text.slice(0, 200),
        // The plugin's trigger card lists what ended (D26); DSH's own row shows the summary.
        ...(items && items.length > 0 ? { items: items.slice(-20).map((i) => i.slice(0, 300)) } : {}),
      },
    };
    this.#append('developer/message', { turn: this.#turn, step: this.#step, message }, { surfaceOp: 'append' });
    this.#triggered = true;
  }

  /**
   * D44: `approval/asked` for an ask shown while this turn is open. Log-only (no surface op), like
   * DSH's own `approval.request()`: it may sit inside or between steps. Returns the audit id.
   */
  approvalAsked(info: { toolName: string; callId?: string; reason?: string }): string {
    if (typeof info.toolName !== 'string' || info.toolName === '')
      throw new WriterAssertError('refused approval/asked without a tool name');
    const id = randomUUID();
    const data: Record<string, unknown> = { id, toolName: info.toolName };
    if (info.callId !== undefined) data.callId = info.callId;
    if (info.reason !== undefined) data.reason = info.reason;
    this.#append('approval/asked', data);
    this.#approvals.add(id);
    return id;
  }

  /** D44: the one `approval/decided` of an asked id. A second decision is ignored. */
  approvalDecided(id: string, outcome: ApprovalAuditOutcome): void {
    if (!this.#approvals.has(id)) return;
    if (outcome !== 'allowed-once' && outcome !== 'rejected' && outcome !== 'cancelled')
      throw new WriterAssertError(`refused approval/decided with outcome ${String(outcome)}`);
    this.#append('approval/decided', { id, outcome });
    this.#approvals.delete(id);
  }

  /** Close everything this writer opened. Later appends are refused (the loop writes turn/end). */
  close(): void {
    this.closeStep();
    // D44, D74: every ask still open when the turn ends is `cancelled` (the pair stays in the turn).
    for (const id of [...this.#approvals]) this.approvalDecided(id, 'cancelled');
    this.#closed = true;
  }
}
