// SDK message → BackendEvent mapper (architecture §6, D18, D20, D21, D26, D27, D57, D69, D71, D72,
// D84, D86).
//
// Scope: the main thread (text, thinking, tool_use, tool_result, result, interrupt, synthetic
// messages, whole responses without a stream), background tasks (task_* frames), and child
// agents: subagents, nested subagents and teammates (`parent_tool_use_id` set; D45, D50, D68,
// in `children.ts`). Workflow agents are not on the stream: their runs, snapshots and live
// transcript tails are in `workflows.ts` (D48, D49).
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
import { WorkflowRuns, taskUsageOf, type WorkflowRunsOptions } from './workflows.js';
import { canonicalModel } from './model-id.js';
import { UsageLedger } from './usage.js';
import { CommandCatalog, localCommandOf, toMcpServerList } from './commands.js';

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
  /** A tool_use slot's id and tool name, from content_block_start (R8.4 first-token marker). */
  toolId?: string;
  toolName?: string;
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
  /** Workflow runs: the live transcript poll's sink, folder guard and test seams (D49). */
  workflows?: Omit<WorkflowRunsOptions, 'now' | 'debug'>;
  /** Usage accounting (D57-D60). Default: a ledger for a new session. */
  usage?: UsageLedger;
}

export { canonicalModel } from './model-id.js';

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
  readonly #workflows: WorkflowRuns;
  /** Workflow launches whose call result is held (D18): emitted after that result. */
  #pendingLaunches = new Map<string, Record<string, unknown>>();
  readonly #usage: UsageLedger;
  /** R7.1: the CLI's command list and skill names (D52). */
  readonly #commands = new CommandCatalog();
  /** The last slash command we sent, to name a local command output that has no name (R7.2). */
  /** The last sent line's slash command; `queued` when it was sent while a turn ran (it answers after that turn). */
  #lastSlash: { name: string; args: string; queued: boolean } | undefined;
  /** The CLI session id of the frames (D70: it changes after a conversation reset). */
  #sessionId: string | undefined;
  /** A `conversation_reset` seen; its event waits for the first frame of the new conversation. */
  #pendingReset: { from: string | undefined; hinted: string | undefined; trigger: string | undefined } | undefined;
  /** A compaction is running (`status: compacting` seen, no end yet). */
  #compacting = false;

  constructor(tracker: SentInputTracker, options: MapperOptions = {}) {
    this.#tracker = tracker;
    this.#now = options.now ?? Date.now;
    this.#debug = options.debug ?? (() => {});
    this.#children = new ChildAgents({ debug: this.#debug });
    this.#workflows = new WorkflowRuns({ ...options.workflows, now: this.#now, debug: this.#debug });
    this.#usage = options.usage ?? new UsageLedger({ now: this.#now });
  }

  /** Usage accounting of this stream (D57-D60). */
  get usage(): UsageLedger {
    return this.#usage;
  }

  /** The command list and skills this stream reported (R7.1, R7.5). */
  get commands(): CommandCatalog {
    return this.#commands;
  }

  /** The session sent a line that starts with `/name` (it went to the CLI as plain text, D52). */
  noteSlashCommand(cmd: { name: string; args: string } | undefined): void {
    // Every sent line replaces it: after a plain prompt no later output is named from an old line
    // (M6 review). A line sent mid-turn waits for the next turn.
    this.#lastSlash = cmd === undefined ? undefined : { name: cmd.name, args: cmd.args, queued: this.#turnOpen };
  }

  /** Workflow runs seen on this stream (D48). */
  get workflows(): WorkflowRuns {
    return this.#workflows;
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
    const sid = str(msg.session_id);
    if (msg.type !== 'conversation_reset') {
      // D70: the reset frame names a conversation id, but the CLI goes on under the id its next
      // frames carry (live M5 probe A: they differ). The first frame with a new id is the start.
      if (this.#pendingReset !== undefined && sid !== undefined && sid !== this.#pendingReset.from)
        this.#flushReset(sid, out);
      if (sid !== undefined) this.#sessionId = sid;
    }
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
        // A turn ended: an unclaimed name belonged to it (drop it); a queued one is the next turn's.
        if (this.#lastSlash?.queued) this.#lastSlash.queued = false;
        else this.#lastSlash = undefined;
        break;
      case 'tombstone':
        this.#tombstone(msg, out);
        break;
      case 'conversation_reset':
        if (this.#pendingReset !== undefined) this.#flushReset(this.#pendingReset.hinted, out);
        this.#pendingReset = {
          from: this.#sessionId ?? sid,
          hinted: str(msg.new_conversation_id),
          trigger: str(msg.trigger),
        };
        break;
      case 'rate_limit_event':
        out.push(...this.#usage.rateLimit(msg.rate_limit_info)); // D60
        break;
      default:
        this.#debug('ignored message type', msg);
    }
    return out;
  }

  /** The sent slash command a local output answers, once. */
  #takeSlash(): { name: string; args?: string } | undefined {
    const s = this.#lastSlash;
    this.#lastSlash = undefined;
    if (s === undefined) return undefined;
    return s.args === '' ? { name: s.name } : { name: s.name, args: s.args };
  }

  /** The CLI process ended or the iterator threw. Closes what the mapper holds. */
  exit(error?: string): BackendEvent[] {
    const out: BackendEvent[] = [];
    this.#step = undefined;
    this.#whole = undefined;
    this.#buffered = [];
    this.#turnOpen = false;
    this.#children.exit(out, error ?? 'Claude Code ended');
    this.#workflows.exit(out, error ?? 'Claude Code ended');
    this.#pendingLaunches.clear();
    out.push(error === undefined ? { type: 'exit' } : { type: 'exit', error });
    return out;
  }

  /** D70: the conversation was reset; `newSessionId` is the id the CLI now runs under. */
  #flushReset(newSessionId: string | undefined, out: BackendEvent[]): void {
    const r = this.#pendingReset;
    this.#pendingReset = undefined;
    if (r === undefined) return;
    const id = newSessionId ?? r.hinted;
    if (id !== undefined) {
      const e: Extract<BackendEvent, { type: 'conversation-reset' }> = { type: 'conversation-reset', newSessionId: id };
      if (r.trigger !== undefined) e.trigger = r.trigger;
      out.push(e);
    }
    out.push(...this.#usage.conversationReset(r.trigger));
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
        out.push(...this.#usage.apiKeySource(str(msg.apiKeySource))); // R8.3
        // R7.1: the init lists names only; full rows come from `commands_changed` or the control.
        const names = this.#commands.init(msg);
        if (names !== undefined) {
          const ev: Extract<BackendEvent, { type: 'commands' }> = { type: 'commands', list: names };
          if (names.every((c) => c.description === undefined)) ev.namesOnly = true;
          out.push(ev);
        }
        // D55: always 'pending' at start (Phase 1 probe2); the panel reads the control for more.
        if (Array.isArray(msg.mcp_servers)) out.push({ type: 'mcp-status', servers: toMcpServerList(msg.mcp_servers) });
        break;
      }
      case 'commands_changed':
        // R7.1: the full list again; replace, do not merge (SDK/sdk.d.ts:3875).
        out.push({ type: 'commands', list: this.#commands.rows(msg.commands) });
        break;
      case 'local_command_output': {
        // Declared (SDK/sdk.d.ts:5584) but not seen on 2.1.318 (probe5); same shape as D69.
        const text = str(msg.content);
        if (text === undefined || text === '') break;
        this.#maybeTurnStart(msg, out);
        const stepId = str(msg.uuid) ?? `local-${at}`;
        this.#step = undefined;
        this.#whole = undefined;
        out.push({ type: 'step-start', agent: MAIN, stepId, at, synthetic: true });
        const e: Extract<BackendEvent, { type: 'step-message' }> = {
          type: 'step-message',
          agent: MAIN,
          stepId,
          blocks: [{ type: 'text', text }],
          final: true,
          synthetic: true,
          localCommand: this.#takeSlash() ?? {},
        };
        const uuid = str(msg.uuid);
        if (uuid !== undefined) e.lastChainId = uuid;
        out.push(e);
        break;
      }
      case 'status': {
        const mode = str(msg.permissionMode);
        if (mode !== undefined) out.push({ type: 'mode', mode });
        if (msg.status === 'requesting') {
          this.#maybeTurnStart(msg, out);
          // R8.4: the main thread's model request starts here (children have no stream, D68).
          if (!msg.parent_tool_use_id) out.push({ type: 'request-start', agent: MAIN, at });
        } else this.#consume(strArray(msg.user_message_uuids), out);
        // D59: compaction start, and its failure (success ends at compact_boundary).
        if (msg.status === 'compacting' && !this.#compacting) {
          this.#compacting = true;
          out.push({ type: 'compaction', phase: 'start' });
        }
        if (msg.compact_result === 'failed') {
          this.#compacting = false;
          const e: Extract<BackendEvent, { type: 'compaction' }> = { type: 'compaction', phase: 'end' };
          e.error = str(msg.compact_error) ?? 'Compaction failed';
          out.push(e);
        }
        // 'success' comes just before compact_boundary (CLI 2.1.318), which ends the compaction:
        // keep the flag, or the boundary would announce a second start (M5 live).
        break;
      }
      case 'compact_boundary': {
        const meta = isObject(msg.compact_metadata) ? msg.compact_metadata : {};
        if (!this.#compacting) out.push({ type: 'compaction', phase: 'start' });
        this.#compacting = false;
        const e: Extract<BackendEvent, { type: 'compaction' }> = { type: 'compaction', phase: 'end' };
        if (meta.trigger === 'manual' || meta.trigger === 'auto') e.trigger = meta.trigger;
        const pre = num(meta.pre_tokens);
        if (pre !== undefined) e.preTokens = pre;
        const post = num(meta.post_tokens);
        if (post !== undefined) e.postTokens = post;
        out.push(e);
        out.push(...this.#usage.compacted(post));
        break;
      }
      case 'api_retry': {
        // D60: retries (throttling on every account type) show inline.
        const e: Extract<BackendEvent, { type: 'retry' }> = {
          type: 'retry',
          attempt: num(msg.attempt) ?? 1,
          error: str(msg.error) ?? 'unknown',
        };
        const max = num(msg.max_retries);
        if (max !== undefined) e.maxRetries = max;
        const delay = num(msg.retry_delay_ms);
        if (delay !== undefined) e.delayMs = delay;
        const status = num(msg.error_status);
        if (status !== undefined) e.httpStatus = status;
        out.push(e);
        break;
      }
      case 'task_started': {
        const taskId = str(msg.task_id);
        if (taskId === undefined) break;
        const kind = taskKind(str(msg.task_type));
        // D45: every child agent, foreground or background, gets a child session.
        const agent = kind === 'agent' ? this.#children.taskStarted(msg, at, out) : undefined;
        if (kind === 'workflow') this.#workflows.taskStarted(msg);
        // Foreground tasks are not jobs (D47). A workflow always runs in the background; its
        // `task_started` has no `is_backgrounded` field (live M4).
        const background = msg.is_backgrounded === true || kind === 'workflow';
        if (!background || this.#background.has(taskId)) break;
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
        // A workflow's `description` is the current "<phase>: <agent>"; its `summary` the run label.
        const isRun = this.#workflows.isRun(taskId);
        const summary = isRun ? (str(msg.description) ?? str(msg.summary)) : (str(msg.summary) ?? str(msg.description));
        if (summary !== undefined) e.summary = summary;
        const usage = taskUsage(msg.usage);
        if (usage !== undefined) e.usage = usage;
        out.push(e);
        if (isRun) this.#workflows.progress(msg, at, out); // D48 snapshot, workflow agents
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
        if (this.#workflows.isRun(taskId))
          this.#workflows.ended(taskId, str(msg.status), str(msg.summary), taskUsageOf(msg.usage), out);
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
        const slot: Slot = { kind, streamed: '' };
        if (kind === 'tool-call') {
          const b = ev.content_block as { id?: unknown; name?: unknown } | undefined;
          const toolId = str(b?.id);
          const toolName = str(b?.name);
          if (toolId !== undefined && toolName !== undefined) [slot.toolId, slot.toolName] = [toolId, toolName];
        }
        step.slots.push(slot);
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
        const delta: Extract<BackendEvent, { type: 'delta' }> = {
          type: 'delta',
          agent: MAIN,
          stepId: step.id,
          kind,
          blockIndex: pos,
          text,
          at,
        };
        if (kind === 'tool-input' && slot.toolId !== undefined && slot.toolName !== undefined) {
          delta.toolCallId = slot.toolId;
          delta.toolName = slot.toolName;
        }
        out.push(delta);
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
        // R7.2, D69: a local command's output (no usage; `/context` with its structured twin).
        const local = localCommandOf(msg);
        if (local !== undefined) {
          const sent = this.#takeSlash();
          if (local.name === undefined && sent !== undefined) {
            local.name = sent.name;
            if (sent.args !== '' && local.args === undefined) local.args = sent.args;
          }
          e.localCommand = local;
        }
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
      if (e.usage !== undefined) out.push(...this.#usage.mainCall(id, e.usage, e.model)); // D57
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
    if (step.usage !== undefined) out.push(...this.#usage.mainCall(step.id, step.usage, step.model)); // D57
    for (const b of blocks) if (b.type === 'tool-call') this.#advertised.add(b.id);
    this.#flushResults(out);
    this.#children.teamMessages(blocks, MAIN, out);
  }

  #flushResults(out: BackendEvent[]): void {
    const keep: ToolResultEvent[] = [];
    for (const r of this.#buffered) {
      if (!this.#advertised.has(r.callId)) {
        keep.push(r);
        continue;
      }
      out.push(r);
      this.#launch(r.callId, out);
    }
    this.#buffered = keep;
  }

  /** A held workflow launch whose call result was just written (D48: start after the result). */
  #launch(callId: string, out: BackendEvent[]): void {
    const info = this.#pendingLaunches.get(callId);
    if (info === undefined) return;
    this.#pendingLaunches.delete(callId);
    this.#workflows.launched(info, callId, this.#now(), out);
  }

  #user(msg: WireUser, out: BackendEvent[]): void {
    const uuid = str(msg.uuid);
    if (uuid !== undefined) {
      if (this.#seenUuids.has(uuid)) return;
      this.#seenUuids.add(uuid);
    }
    const content = msg.message?.content;
    if (!Array.isArray(content)) return; // the CLI's own text (for example "[Request interrupted by user]") is never written (D22)
    // `tool_use_result` belongs to the frame's one tool result (the CLI sends one per frame).
    const single = content.filter((b) => b.type === 'tool_result').length === 1;
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
      const launch = single ? WorkflowRuns.launchInfo(msg) : undefined;
      if (launch !== undefined) this.#pendingLaunches.set(callId, launch);
      if (this.#advertised.has(callId)) {
        out.push(e);
        this.#launch(callId, out);
      } else this.#buffered.push(e); // D18: results before message_stop are buffered
    }
  }

  // ---- turn end ----

  #result(msg: WireResult, out: BackendEvent[]): void {
    const numTurns = num(msg.num_turns);
    const text = str(msg.result) ?? '';
    // D70: a reset whose new conversation sent no other frame first.
    if (this.#pendingReset !== undefined) this.#flushReset(this.#pendingReset.hinted, out);
    // D58: every result moves the usage baseline, a skipped one too (the /clear result, D70).
    const usage = this.#usage.result(msg);
    this.#compacting = false; // a compaction never outlives its command's result
    // An empty result that answers one of our inputs (its `started` lifecycle frame came while no
    // turn was open, e.g. `/compact` or `/clear`) ends that turn; only a stray one is skipped.
    const answersOurs =
      this.#consumedWhileIdle || strArray(msg.user_message_uuids).some((id) => this.#tracker.wasSent(id));
    if (!this.#turnOpen && numTurns === 0 && text === '' && !answersOurs) {
      out.push(...usage);
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
    // A launch whose result was never written still starts its run (no tool-result to follow).
    for (const callId of [...this.#pendingLaunches.keys()]) this.#launch(callId, out);

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
    out.push(...usage); // before the turn's end, so the turn carries its usage (D58)
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
