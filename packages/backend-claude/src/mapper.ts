// SDK message → BackendEvent mapper (architecture §6, D18, D20, D21, D26, D27, D57, D69, D71, D72,
// D84, D86).
//
// Scope: the main thread (text, thinking, tool_use, tool_result, result, interrupt, synthetic
// messages, whole responses without a stream), background tasks (task_* frames), and child
// agents: subagents, nested subagents and teammates (`parent_tool_use_id` set; D45, D50, D68,
// in `children.ts`). Workflow agents are not on the stream (D49).
//
// Guarantees the DSH writer relies on (§7.2):
// - every `step-message` follows its `step-start`;
// - a `tool-result` is emitted only after the `step-message` that advertises its call;
// - duplicates and re-sends are dropped (W1: by uuid, by tool id, and cumulative re-sent frames);
// - `delta.blockIndex` is the position of that block in the step's `step-message.blocks`
//   (empty signed reasoning blocks are not written, D86, so they take no position);
// - a whole response (no `message_start`, D84) is one step; its further frames with the same
//   `message.id` are further `step-message`s of that step (`final: false`, no new `step-start`);
// - `turn-end.pendingInputs` counts sent inputs not yet consumed.

import type {
  AgentRef,
  BackendEvent,
  ContentBlock,
  SentInputTracker,
  TaskKind,
  ToolResultContent,
  Usage,
} from '@dsh-raw-agent/core';
import { isDeepStrictEqual } from 'node:util';
import {
  isObject,
  num,
  str,
  strArray,
  type WireAssistant,
  type WireBlock,
  type WireMessage,
  type WireResult,
  type WireStreamEvent,
  type WireUser,
} from './wire.js';
import { ChildAgents } from './children.js';

type ToolResultEvent = Extract<BackendEvent, { type: 'tool-result' }>;

const MAIN: AgentRef = Object.freeze({ kind: 'main' }) as AgentRef;

interface Slot {
  /** 'text' | 'reasoning' | 'tool-call' as announced by content_block_start. */
  kind: ContentBlock['type'];
  block?: ContentBlock;
  /** Delta text seen so far; the fallback for an interrupted text or reasoning block. */
  streamed: string;
  /** The CLI message uuid that filled this slot (for tombstones, D84). */
  uuid?: string;
  /** Removed by a tombstone before it was written (D84). */
  dropped?: boolean;
}

/** D86: a reasoning block with no text (a signed, empty `thinking`) is not written. */
function isEmptyReasoning(b: ContentBlock): boolean {
  return b.type === 'reasoning' && b.text === '';
}

/** Whether a slot ends up in the step's blocks (same rule as #closeStep). */
function slotKept(s: Slot): boolean {
  if (s.dropped) return false;
  if (s.block !== undefined) return !isEmptyReasoning(s.block);
  return s.kind !== 'tool-call' && s.streamed !== '';
}

interface OpenStep {
  id: string;
  streamed: boolean;
  slots: Slot[];
  /** API content index → slot index (redacted_thinking has none). */
  positions: Map<number, number>;
  /** Blocks filled from assistant frames, in fill order (cumulative re-send check, W1). */
  filled: ContentBlock[];
  /** Uuids of the CLI messages merged into this step, in order. */
  chain: string[];
  usage?: Usage;
  model?: string;
  lastChainId?: string;
  aborted: boolean;
  toolIds: Set<string>;
}

export interface MapperOptions {
  now?: () => number;
  /** Called for frames the mapper drops on purpose, for debug logs. */
  debug?: (note: string, msg: unknown) => void;
}

/** Shorten provider-specific model ids for display (D61). The inference-profile form is **unverified**. */
export function canonicalModel(model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  let m = model;
  const slash = m.lastIndexOf('/');
  if (m.startsWith('arn:') && slash >= 0) m = m.slice(slash + 1);
  m = m.replace(/^(?:[a-z]{2,4}\.)?anthropic\./, '');
  m = m.replace(/-v\d+(?::\d+)?$/, '');
  return m;
}

function usageFromStart(u: WireMessage['usage'] | undefined): Usage | undefined {
  if (!isObject(u)) return undefined;
  return {
    input: num(u.input_tokens) ?? 0,
    output: 0,
    cacheRead: num(u.cache_read_input_tokens) ?? 0,
    cacheWrite: num(u.cache_creation_input_tokens) ?? 0,
  };
}

function toolArguments(input: unknown): string {
  // The CLI's final input, serialised once (D21). The streamed partial JSON never decides it.
  return JSON.stringify(input ?? {});
}

/** Convert one Claude content block. `undefined` means "not written" (D86: redacted_thinking). */
export function convertBlock(b: WireBlock): ContentBlock | undefined {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: str((b as { text?: unknown }).text) ?? '' };
    case 'thinking':
      // D86: exactly {type, text}; the signature stays in the CLI's own transcript.
      return { type: 'reasoning', text: str((b as { thinking?: unknown }).thinking) ?? '' };
    case 'tool_use': {
      const t = b as { id?: unknown; name?: unknown; input?: unknown };
      const id = str(t.id);
      const name = str(t.name);
      if (id === undefined || name === undefined) return undefined;
      return { type: 'tool-call', id, name, arguments: toolArguments(t.input) };
    }
    default:
      return undefined;
  }
}

function slotKind(b: WireBlock | undefined): ContentBlock['type'] | undefined {
  if (b === undefined) return undefined;
  if (b.type === 'text') return 'text';
  if (b.type === 'thinking') return 'reasoning';
  if (b.type === 'tool_use') return 'tool-call';
  return undefined;
}

export function convertToolResultContent(content: unknown): ToolResultContent[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return content === undefined ? [] : [{ type: 'other', value: content }];
  return content.map((c): ToolResultContent => {
    if (isObject(c) && c.type === 'text' && typeof c.text === 'string') return { type: 'text', text: c.text };
    if (isObject(c) && c.type === 'image' && isObject(c.source) && c.source.type === 'base64') {
      const mediaType = str(c.source.media_type);
      const data = str(c.source.data);
      if (mediaType !== undefined && data !== undefined) return { type: 'image', mediaType, base64: data };
    }
    return { type: 'other', value: c };
  });
}

function taskKind(taskType: string | undefined): TaskKind {
  switch (taskType) {
    case 'local_agent':
    case 'remote_agent':
      return 'agent';
    case 'local_workflow':
      return 'workflow';
    case 'local_bash':
      return 'shell';
    default:
      return taskType !== undefined && /monitor/i.test(taskType) ? 'monitor' : 'shell';
  }
}

export class ClaudeMessageMapper {
  readonly #tracker: SentInputTracker;
  readonly #now: () => number;
  readonly #debug: (note: string, msg: unknown) => void;

  #turnOpen = false;
  /** An input of ours was consumed while no CLI turn was open (lifecycle `started` precedes `status`). */
  #consumedWhileIdle = false;
  #interruptRequested = false;
  #step: OpenStep | undefined;
  readonly #seenUuids = new Set<string>();
  /** Tool ids advertised in an emitted step-message. */
  readonly #advertised = new Set<string>();
  /** tool-result events waiting for their call to be advertised, in arrival order. */
  #buffered: ToolResultEvent[] = [];
  /** The open whole-response step (D84): its message id, and whether its usage was sent. */
  #whole: { id: string; usageSent: boolean } | undefined;
  readonly #background = new Map<string, TaskKind>();
  readonly #children: ChildAgents;

  constructor(tracker: SentInputTracker, options: MapperOptions = {}) {
    this.#tracker = tracker;
    this.#now = options.now ?? Date.now;
    this.#debug = options.debug ?? (() => {});
    this.#children = new ChildAgents({ debug: this.#debug });
  }

  /** Child agents seen on this stream (labels for asks, D77). */
  get children(): ChildAgents {
    return this.#children;
  }

  /** The session calls this right before `interrupt()`, so the next error result maps to `interrupted`. */
  noteInterruptRequested(): void {
    if (this.#turnOpen) this.#interruptRequested = true;
  }

  get turnOpen(): boolean {
    return this.#turnOpen;
  }

  map(raw: unknown, at: number = this.#now()): BackendEvent[] {
    if (!isObject(raw)) return [];
    const msg = raw as WireMessage;
    const out: BackendEvent[] = [];
    switch (msg.type) {
      case 'system':
        this.#system(msg, at, out);
        break;
      case 'command_lifecycle':
        this.#lifecycle(msg, out);
        break;
      case 'stream_event':
        this.#stream(msg as WireStreamEvent, at, out);
        break;
      case 'assistant':
        this.#assistant(msg as WireAssistant, at, out);
        break;
      case 'user':
        if (msg.parent_tool_use_id) this.#children.user(msg, at, out);
        else this.#user(msg as WireUser, out);
        break;
      case 'result':
        this.#result(msg as WireResult, out);
        break;
      case 'tombstone':
        this.#tombstone(msg, out);
        break;
      default:
        this.#debug('ignored message type', msg);
    }
    return out;
  }

  /** The CLI process ended or the iterator threw. Closes what the mapper holds. */
  exit(error?: string): BackendEvent[] {
    const out: BackendEvent[] = [];
    this.#step = undefined;
    this.#whole = undefined;
    this.#buffered = [];
    this.#turnOpen = false;
    this.#children.exit(out, error ?? 'Claude Code ended');
    out.push(error === undefined ? { type: 'exit' } : { type: 'exit', error });
    return out;
  }

  // ---- consumption and turn start ----

  #consume(ids: string[], out: BackendEvent[]): void {
    for (const id of ids) {
      if (!this.#tracker.consume(id)) continue;
      if (!this.#turnOpen) this.#consumedWhileIdle = true;
      out.push({ type: 'input-consumed', inputId: id });
    }
  }

  #maybeTurnStart(msg: WireMessage, out: BackendEvent[]): void {
    const uuids = strArray(msg.user_message_uuids);
    if (!this.#turnOpen) {
      this.#turnOpen = true;
      const ours =
        this.#consumedWhileIdle || uuids.some((id) => this.#tracker.wasSent(id)) || this.#tracker.pendingCount > 0;
      this.#consumedWhileIdle = false;
      out.push({ type: 'turn-start', origin: ours ? 'user' : 'self' });
    }
    this.#consume(uuids, out);
  }

  #lifecycle(msg: WireMessage, out: BackendEvent[]): void {
    const id = str(msg.command_uuid);
    const state = str(msg.state);
    if (id === undefined) return;
    if (state === 'started') this.#consume([id], out);
    // 'cancelled' of a still-pending input: it leaves the map and is never "consumed" (D25).
    // The frame can arrive before the interrupt receipt, which then lists nothing still pending,
    // so the DSH layer hears of it here (M1 live: a cancelled steer was otherwise claimed).
    else if (state === 'cancelled')
      for (const inputId of this.#tracker.cancel([id])) out.push({ type: 'input-cancelled', inputId });
  }

  // ---- system frames ----

  #system(msg: WireMessage, at: number, out: BackendEvent[]): void {
    switch (msg.subtype) {
      case 'init': {
        const e: Extract<BackendEvent, { type: 'session-info' }> = { type: 'session-info' };
        const model = canonicalModel(str(msg.model));
        if (model !== undefined) e.model = model;
        const mode = str(msg.permissionMode);
        if (mode !== undefined) e.mode = mode;
        const version = str(msg.claude_code_version);
        if (version !== undefined) e.version = version;
        out.push(e);
        break;
      }
      case 'status': {
        const mode = str(msg.permissionMode);
        if (mode !== undefined) out.push({ type: 'mode', mode });
        if (msg.status === 'requesting') this.#maybeTurnStart(msg, out);
        else this.#consume(strArray(msg.user_message_uuids), out);
        break;
      }
      case 'task_started': {
        const taskId = str(msg.task_id);
        if (taskId === undefined) break;
        const kind = taskKind(str(msg.task_type));
        // D45: every child agent, foreground or background, gets a child session.
        const agent = kind === 'agent' ? this.#children.taskStarted(msg, at, out) : undefined;
        if (msg.is_backgrounded !== true || this.#background.has(taskId)) break; // foreground tasks are not jobs (D47)
        this.#background.set(taskId, kind);
        const e: Extract<BackendEvent, { type: 'task-start' }> = {
          type: 'task-start',
          taskId,
          kind,
          label: (agent && this.#children.label(taskId)) ?? str(msg.description) ?? taskId,
        };
        if (agent !== undefined) e.agent = agent;
        out.push(e);
        break;
      }
      case 'task_progress': {
        const taskId = str(msg.task_id);
        // Background jobs, and child agents (their rows show tokens and tool uses, D46).
        if (taskId === undefined || (!this.#background.has(taskId) && !this.#children.isAgentTask(taskId))) break;
        const e: Extract<BackendEvent, { type: 'task-progress' }> = { type: 'task-progress', taskId };
        const summary = str(msg.summary) ?? str(msg.description);
        if (summary !== undefined) e.summary = summary;
        const usage = taskUsage(msg.usage);
        if (usage !== undefined) e.usage = usage;
        out.push(e);
        break;
      }
      case 'task_notification': {
        const taskId = str(msg.task_id);
        if (taskId === undefined) break;
        // The notification carries the task's final usage; the last task_progress can be much
        // older (one frame per tool use), so the row would keep stale tokens and run time.
        const finalUsage = taskUsage(msg.usage);
        if (finalUsage !== undefined && (this.#background.has(taskId) || this.#children.isAgentTask(taskId)))
          out.push({ type: 'task-progress', taskId, usage: finalUsage });
        // The child's own end first, then its job (D45, D47).
        if (this.#children.isAgentTask(taskId))
          this.#children.taskEnded(taskId, str(msg.status), str(msg.summary), out);
        if (!this.#background.has(taskId)) break;
        this.#background.delete(taskId);
        const s = str(msg.status);
        const status = s === 'completed' ? 'completed' : s === 'stopped' || s === 'killed' ? 'stopped' : 'failed';
        const e: Extract<BackendEvent, { type: 'task-end' }> = { type: 'task-end', taskId, status };
        const summary = str(msg.summary);
        if (summary !== undefined) e.summary = summary;
        out.push(e);
        break;
      }
      case 'background_tasks_changed': {
        const tasks = Array.isArray(msg.tasks) ? msg.tasks : [];
        out.push({
          type: 'tasks-snapshot',
          taskIds: tasks.map((t) => (isObject(t) ? str(t.task_id) : undefined)).filter((x): x is string => !!x),
        });
        break;
      }
      case 'informational': {
        // The CLI's own user-facing line, e.g. after `set_model` "Model "x" is restricted by your
        // organization's settings. Using y instead." (CLI 2.1.318 `inform`). Shown as is.
        const text = str(msg.content);
        if (text !== undefined && text.trim() !== '')
          out.push({ type: 'notice', level: str(msg.level) ?? 'notice', text });
        break;
      }
      default:
        this.#debug('ignored system subtype', msg);
    }
  }

  // ---- main-thread stream ----

  #stream(msg: WireStreamEvent, at: number, out: BackendEvent[]): void {
    if (msg.parent_tool_use_id) return; // children: later (D68 has no deltas anyway)
    const ev = msg.event;
    if (!isObject(ev)) return;
    switch (ev.type) {
      case 'message_start': {
        this.#maybeTurnStart(msg, out);
        const id = str(ev.message?.id);
        if (id === undefined) return;
        const step: OpenStep = {
          id,
          streamed: true,
          slots: [],
          positions: new Map(),
          filled: [],
          chain: [],
          aborted: false,
          toolIds: new Set(),
        };
        this.#whole = undefined;
        const usage = usageFromStart(ev.message?.usage as WireMessage['usage']);
        if (usage !== undefined) step.usage = usage;
        const model = canonicalModel(str(ev.message?.model));
        if (model !== undefined) step.model = model;
        this.#step = step; // a stale open step is closed by the writer on this step-start (D18)
        out.push({ type: 'step-start', agent: MAIN, stepId: id, at });
        return;
      }
      case 'content_block_start': {
        const step = this.#step;
        const index = num(ev.index);
        const kind = slotKind(ev.content_block);
        if (step === undefined || index === undefined || kind === undefined) return;
        step.positions.set(index, step.slots.length);
        step.slots.push({ kind, streamed: '' });
        return;
      }
      case 'content_block_delta': {
        const step = this.#step;
        const index = num(ev.index);
        if (step === undefined || index === undefined) return;
        const slotIndex = step.positions.get(index);
        const slot = slotIndex === undefined ? undefined : step.slots[slotIndex];
        if (slotIndex === undefined || slot === undefined || slot.dropped) return;
        const d = ev.delta ?? {};
        let kind: 'text' | 'reasoning' | 'tool-input' | undefined;
        let text: string | undefined;
        if (d.type === 'text_delta') [kind, text] = ['text', d.text];
        else if (d.type === 'thinking_delta') [kind, text] = ['reasoning', d.thinking];
        else if (d.type === 'input_json_delta') [kind, text] = ['tool-input', d.partial_json];
        if (kind === undefined || text === undefined || text === '') return;
        slot.streamed += text;
        // The block's position among the blocks that will be written (D86: empty reasoning has none).
        let pos = 0;
        for (let i = 0; i < slotIndex; i++) if (slotKept(step.slots[i]!)) pos++;
        out.push({ type: 'delta', agent: MAIN, stepId: step.id, kind, blockIndex: pos, text, at });
        return;
      }
      case 'message_delta': {
        const step = this.#step;
        const u = ev.usage;
        if (step === undefined || !isObject(u)) return;
        const usage = step.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        usage.output = num(u.output_tokens) ?? usage.output;
        const input = num(u.input_tokens);
        if (input !== undefined) usage.input = input;
        const cacheRead = num(u.cache_read_input_tokens);
        if (cacheRead !== undefined) usage.cacheRead = cacheRead;
        const cacheWrite = num(u.cache_creation_input_tokens);
        if (cacheWrite !== undefined) usage.cacheWrite = cacheWrite;
        const details = u.output_tokens_details;
        const reasoning = isObject(details) ? num(details.thinking_tokens) : undefined;
        if (reasoning !== undefined && reasoning > 0) usage.reasoning = reasoning;
        step.usage = usage;
        return;
      }
      case 'message_stop':
        this.#closeStep(out);
        return;
      default:
        return;
    }
  }

  #assistant(msg: WireAssistant, at: number, out: BackendEvent[]): void {
    if (msg.parent_tool_use_id) {
      this.#children.assistant(msg, at, out); // D68
      return;
    }
    const uuid = str(msg.uuid);
    if (uuid !== undefined) {
      if (this.#seenUuids.has(uuid)) return;
      this.#seenUuids.add(uuid);
    }
    const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
    // `task_started` can come before this step's `message_stop` (live): remember the calls now.
    this.#children.noteCalls(content, MAIN);
    const id = str(msg.message?.id) ?? uuid ?? `msg-${at}`;
    const step = this.#step;
    const inStreamedStep = step !== undefined && step.id === id && step.streamed;
    // A re-sent message whose tool ids are already written is skipped (D72).
    if (
      !inStreamedStep &&
      content.some((b) => b.type === 'tool_use' && typeof b.id === 'string' && this.#advertised.has(b.id))
    ) {
      this.#debug('re-sent assistant message', msg);
      return;
    }
    this.#maybeTurnStart(msg, out);
    const model = str(msg.message?.model);
    const synthetic = model === '<synthetic>';
    const error = msg.error === undefined || msg.error === null ? undefined : String(msg.error);

    if (inStreamedStep) {
      // Streamed step: fill the started slots in order.
      const blocks = content.map(convertBlock).filter((b): b is ContentBlock => b !== undefined);
      // W1: a cumulative frame repeats the blocks already filled; skip that prefix.
      let skip = 0;
      if (blocks.length > 1)
        while (skip < blocks.length && skip < step.filled.length && isDeepStrictEqual(blocks[skip], step.filled[skip]))
          skip++;
      for (const block of blocks.slice(skip)) {
        if (block.type === 'tool-call' && (step.toolIds.has(block.id) || this.#advertised.has(block.id))) {
          this.#debug('re-sent tool_use block (W1)', block); // the checker refuses a repeated id
          continue;
        }
        const slot = step.slots.find((s) => s.block === undefined && !s.dropped && s.kind === block.type);
        const filled: Slot = slot ?? { kind: block.type, streamed: '' };
        filled.block = block;
        if (uuid !== undefined) filled.uuid = uuid;
        if (slot === undefined) step.slots.push(filled);
        step.filled.push(block);
        if (block.type === 'tool-call') step.toolIds.add(block.id);
      }
      if (uuid !== undefined) {
        step.lastChainId = uuid;
        step.chain.push(uuid);
      }
      if (msg.aborted === true) step.aborted = true;
      return;
    }

    // No API stream for this message: synthetic, error, local command, or a whole response (D69, D84).
    // D86: empty signed reasoning is not written; redacted_thinking has no block.
    const blocks = content.map(convertBlock).filter((b): b is ContentBlock => b !== undefined && !isEmptyReasoning(b));
    const special = synthetic || error !== undefined;
    const continues = !special && this.#whole?.id === id;
    if (!continues) {
      // A stale streamed step (no message_stop) is closed by the writer on this step-start (D18).
      this.#step = undefined;
      this.#whole = special ? undefined : { id, usageSent: false };
      const startEvent: Extract<BackendEvent, { type: 'step-start' }> = {
        type: 'step-start',
        agent: MAIN,
        stepId: id,
        at,
      };
      if (special) startEvent.synthetic = true;
      out.push(startEvent);
    }
    if (blocks.length > 0) {
      const e: Extract<BackendEvent, { type: 'step-message' }> = {
        type: 'step-message',
        agent: MAIN,
        stepId: id,
        blocks,
        // A whole response may continue in further frames of the same message id (D84, D68);
        // the step closes on the next step-start, at the turn end, or when its calls resolve.
        final: special,
      };
      if (special) {
        e.synthetic = true;
        if (error !== undefined) e.error = error;
      } else {
        const whole = this.#whole!;
        const usage = usageFromStart(msg.message?.usage as WireMessage['usage']);
        const output = num(msg.message?.usage?.output_tokens);
        // Final usage only (not a stream placeholder), counted once per message id (D57, D84).
        if (usage !== undefined && output !== undefined && output > 0 && !whole.usageSent) {
          usage.output = output;
          e.usage = usage;
          whole.usageSent = true;
        }
        const m = canonicalModel(model);
        if (m !== undefined) e.model = m;
      }
      if (uuid !== undefined) e.lastChainId = uuid;
      out.push(e);
      for (const b of blocks) if (b.type === 'tool-call') this.#advertised.add(b.id);
      this.#children.teamMessages(blocks, MAIN, out);
    }
    this.#flushResults(out);
  }

  /**
   * D84 (2): `tombstone {message}` (CLI 2.1.318: "@internal Emitted when a previously-yielded
   * message is superseded"; whether the SDK stream forwards it is **unverified**, S1). Drops
   * what is not yet written: a buffered tool result, or the step content the message filled.
   * Anything already emitted stays; the DSH layer takes the uuid off its fork points (D72).
   */
  #tombstone(msg: WireMessage, out: BackendEvent[]): void {
    const target = isObject(msg.message) ? msg.message : undefined;
    const uuid = str(target?.uuid);
    if (uuid === undefined) return;
    this.#seenUuids.add(uuid);
    const before = this.#buffered.length;
    this.#buffered = this.#buffered.filter((r) => r.chainId !== uuid);
    const step = this.#step;
    let dropped = 0;
    if (step !== undefined) {
      for (const slot of step.slots) {
        if (slot.uuid !== uuid || slot.dropped) continue;
        slot.dropped = true;
        if (slot.block?.type === 'tool-call') step.toolIds.delete(slot.block.id);
        dropped++;
      }
      step.chain = step.chain.filter((c) => c !== uuid);
      if (step.lastChainId === uuid) {
        const last = step.chain.at(-1);
        if (last === undefined) delete step.lastChainId;
        else step.lastChainId = last;
      }
    }
    this.#debug('tombstone', { uuid, droppedResults: before - this.#buffered.length, droppedBlocks: dropped });
    out.push({ type: 'superseded', chainIds: [uuid] });
  }

  #closeStep(out: BackendEvent[]): void {
    const step = this.#step;
    if (step === undefined) return;
    this.#step = undefined;
    const blocks: ContentBlock[] = [];
    for (const s of step.slots) {
      if (s.dropped) continue;
      if (s.block !== undefined) {
        if (!isEmptyReasoning(s.block)) blocks.push(s.block); // D86
      } else if (s.kind === 'text' && s.streamed !== '') blocks.push({ type: 'text', text: s.streamed });
      else if (s.kind === 'reasoning' && s.streamed !== '') blocks.push({ type: 'reasoning', text: s.streamed });
      // An unclosed tool_use block is left out (§6 interrupt row).
    }
    if (blocks.length === 0) {
      // Nothing visible: the writer records an assistant/attempt for this step (D18).
      return;
    }
    const e: Extract<BackendEvent, { type: 'step-message' }> = {
      type: 'step-message',
      agent: MAIN,
      stepId: step.id,
      blocks,
      final: true,
    };
    if (step.usage !== undefined) e.usage = step.usage;
    if (step.model !== undefined) e.model = step.model;
    if (step.lastChainId !== undefined) e.lastChainId = step.lastChainId;
    const hasCall = blocks.some((b) => b.type === 'tool-call');
    if (step.aborted && !hasCall) e.interrupted = true;
    out.push(e);
    for (const b of blocks) if (b.type === 'tool-call') this.#advertised.add(b.id);
    this.#flushResults(out);
    this.#children.teamMessages(blocks, MAIN, out);
  }

  #flushResults(out: BackendEvent[]): void {
    const keep: ToolResultEvent[] = [];
    for (const r of this.#buffered) (this.#advertised.has(r.callId) ? out : keep).push(r);
    this.#buffered = keep;
  }

  #user(msg: WireUser, out: BackendEvent[]): void {
    const uuid = str(msg.uuid);
    if (uuid !== undefined) {
      if (this.#seenUuids.has(uuid)) return;
      this.#seenUuids.add(uuid);
    }
    const content = msg.message?.content;
    if (!Array.isArray(content)) return; // the CLI's own text (for example "[Request interrupted by user]") is never written (D22)
    for (const b of content) {
      if (b.type !== 'tool_result') continue;
      const callId = str((b as { tool_use_id?: unknown }).tool_use_id);
      if (callId === undefined) continue;
      const e: Extract<BackendEvent, { type: 'tool-result' }> = {
        type: 'tool-result',
        agent: MAIN,
        callId,
        isError: (b as { is_error?: unknown }).is_error === true,
        content: convertToolResultContent((b as { content?: unknown }).content),
      };
      if (uuid !== undefined) e.chainId = uuid;
      if (this.#advertised.has(callId)) out.push(e);
      else this.#buffered.push(e); // D18: results before message_stop are buffered
    }
  }

  // ---- turn end ----

  #result(msg: WireResult, out: BackendEvent[]): void {
    const numTurns = num(msg.num_turns);
    const text = str(msg.result) ?? '';
    if (!this.#turnOpen && numTurns === 0 && text === '') {
      this.#debug('empty result skipped', msg); // sdk-surface answer 17
      return;
    }
    if (!this.#turnOpen) this.#maybeTurnStart(msg, out);
    this.#closeStep(out);
    this.#consume(strArray(msg.user_message_uuids), out);
    const queued = num(msg.queued_turn_count) ?? 0;
    if (queued === 0)
      for (const id of this.#tracker.consumeAllIfNoSignal()) out.push({ type: 'input-consumed', inputId: id });

    if (this.#buffered.length > 0) {
      this.#debug('dropping tool results with no advertised call', this.#buffered);
      this.#buffered = [];
    }

    const reason = str(msg.terminal_reason ?? undefined);
    const subtype = str(msg.subtype);
    let outcome: Extract<BackendEvent, { type: 'turn-end' }>['outcome'];
    let error: string | undefined;
    if (reason === 'tool_deferred' || reason === 'tool_deferred_unavailable') outcome = 'deferred';
    else if (subtype === 'success' && msg.is_error !== true) outcome = 'completed';
    else if (subtype === 'error_during_execution' && this.#interruptRequested) outcome = 'interrupted';
    else {
      outcome = 'error';
      const errors = strArray(msg.errors);
      error = errors.length > 0 ? errors.join('\n') : text || subtype || 'Claude Code reported an error';
    }
    const e: Extract<BackendEvent, { type: 'turn-end' }> = {
      type: 'turn-end',
      agent: MAIN,
      outcome,
      pendingInputs: Math.max(this.#tracker.pendingCount, queued),
    };
    if (reason !== undefined) e.reason = reason;
    if (error !== undefined) e.error = error;
    out.push(e);
    this.#children.mainTurnEnded(outcome, out);
    this.#turnOpen = false;
    this.#interruptRequested = false;
  }
}

/** `usage` of a task_progress or task_notification frame: total tokens, tool uses, run time. */
function taskUsage(raw: unknown): { tokens?: number; toolUses?: number; durationMs?: number } | undefined {
  if (!isObject(raw)) return undefined;
  const usage: { tokens?: number; toolUses?: number; durationMs?: number } = {};
  const tokens = num(raw.total_tokens);
  const toolUses = num(raw.tool_uses);
  const durationMs = num(raw.duration_ms);
  if (tokens !== undefined) usage.tokens = tokens;
  if (toolUses !== undefined) usage.toolUses = toolUses;
  if (durationMs !== undefined) usage.durationMs = durationMs;
  return usage;
}
