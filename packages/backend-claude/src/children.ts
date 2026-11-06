// Child agents: subagents, nested subagents and teammates (D45, D46, D50, D68).
//
// What the CLI sends (live, M3 probe `backend-agents`, CLI 2.1.318 with `forwardSubagentText`):
// - The parent's `Agent` tool_use (main stream or a child frame) comes first. Its input holds
//   `description`, `prompt`, `subagent_type`, `run_in_background` and, for a teammate, `name` and
//   `team_name`.
// - `system/task_started` (`task_type: local_agent`) names the child: `task_id` (= the child
//   frames' `agent_id`), `tool_use_id` (= the spawning call), `spawn_depth`, `parent_task_id`
//   (nested only), `is_backgrounded`, `prompt`.
// - Child frames are whole `assistant` / `user` messages, one block each, with
//   `parent_tool_use_id` = the spawning call and `agent_id`; nested children are forwarded too.
//   No stream events, no `message_stop`, placeholder usage. A foreground child's first frame is
//   its prompt as a user text (a background child's is not forwarded).
// - `task_notification` ends it. A finished teammate that gets a `SendMessage` runs again: a new
//   `task_started` with the same `task_id`, `tool_use_id` = the sender's call, and
//   `prompt: <agent-message from="alice">…</agent-message>`; its frames keep the first
//   `parent_tool_use_id`.
//
// Guarantees (as for the main thread, §7.2): an `agent-start` comes before any event of that
// child; every child `step-message` follows a `step-start` of the same child; a child
// `tool-result` comes after the `step-message` that advertises its call; duplicates are dropped.

import type { AgentRef, AgentRole, BackendEvent, ContentBlock, TaskStatus } from '@dsh-raw-agent/core';
import { convertBlock, convertToolResultContent, canonicalModel } from './mapper.js';
import { isObject, num, str, type WireBlock, type WireMessage } from './wire.js';

type Loose = Record<string, unknown>;
type ToolResultEvent = Extract<BackendEvent, { type: 'tool-result' }>;
type AgentStartEvent = Extract<BackendEvent, { type: 'agent-start' }>;

const MAIN: AgentRef = Object.freeze({ kind: 'main' }) as AgentRef;

/** Tool names that start a child agent (`Task` is the older name of `Agent`). */
export const AGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task']);
/** The tool one agent uses to message another (D50). */
export const SEND_MESSAGE_TOOL = 'SendMessage';
/** How many spawning calls are remembered (their input names the child). */
export const CALL_LIMIT = 512;

interface CallInfo {
  owner: AgentRef;
  input: Loose;
}

interface ChildAgent {
  ref: Extract<AgentRef, { kind: 'child' }>;
  parent: AgentRef;
  parentCallId?: string;
  label: string;
  role: AgentRole;
  background: boolean;
  name?: string;
  team?: string;
  agentType?: string;
  depth?: number;
  taskId?: string;
  running: boolean;
  /** The open step: the CLI message id of the last frame (D68). */
  stepId?: string;
  /** The prompt the host writes itself; its forwarded copy is skipped once. */
  pendingPrompt?: string;
  advertised: Set<string>;
  buffered: ToolResultEvent[];
}

export interface ChildAgentsOptions {
  debug?: (note: string, detail: unknown) => void;
}

function inputOf(b: WireBlock): Loose {
  const input = (b as { input?: unknown }).input;
  return isObject(input) ? input : {};
}

/** `<agent-message from="alice">` → 'alice' (the CLI's resume prompt, sdk-surface §7.1). */
export function agentMessageSender(prompt: string): string | undefined {
  const m = /<agent-message\s+from="([^"]*)"/.exec(prompt);
  return m?.[1];
}

/** User text of a frame: a string content, or its text blocks joined. Undefined when none. */
function userText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .filter((b): b is { type: 'text'; text: string } => isObject(b) && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text);
  return texts.length > 0 ? texts.join('\n') : undefined;
}

/** CLI context injected into a child's conversation; the TUI does not show it as a message. */
function isSystemReminder(text: string): boolean {
  return /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/.test(text);
}

function statusOf(s: string | undefined): TaskStatus {
  return s === 'completed' ? 'completed' : s === 'stopped' || s === 'killed' ? 'stopped' : 'failed';
}

export class ChildAgents {
  readonly #debug: (note: string, detail: unknown) => void;
  /** By child id (= task id), and by spawning call under `call:<id>`. */
  readonly #ids = new Map<string, ChildAgent>();
  readonly #calls = new Map<string, CallInfo>();
  readonly #seen = new Set<string>();

  constructor(options: ChildAgentsOptions = {}) {
    this.#debug = options.debug ?? (() => {});
  }

  /** A display label for an agent id (D77: an ask names its subagent). */
  label(agentId: string): string | undefined {
    return this.#ids.get(agentId)?.label;
  }

  /** Whether a task id is a child agent this mapper knows (its progress is the child's). */
  isAgentTask(taskId: string): boolean {
    return this.#ids.get(taskId)?.taskId === taskId;
  }

  /** The sender name in a `team-message`: 'main' for the main agent. */
  senderName(ref: AgentRef): string {
    if (ref.kind === 'main') return 'main';
    const a = this.#ids.get(ref.id);
    return a?.name ?? a?.label ?? ref.id;
  }

  /** Remember the spawning calls in a frame's blocks, so `task_started` can name the child. */
  noteCalls(content: readonly WireBlock[], owner: AgentRef): void {
    for (const b of content) {
      if (b.type !== 'tool_use') continue;
      const id = str((b as { id?: unknown }).id);
      const name = str((b as { name?: unknown }).name);
      if (id === undefined || name === undefined || !AGENT_TOOLS.has(name)) continue;
      this.#calls.delete(id);
      this.#calls.set(id, { owner, input: inputOf(b) });
      while (this.#calls.size > CALL_LIMIT) {
        const oldest = this.#calls.keys().next();
        if (oldest.done) break;
        this.#calls.delete(oldest.value);
      }
    }
  }

  /**
   * `task_started` of a `local_agent` / `remote_agent` task. Emits `agent-start` for a new child or
   * a woken one. Returns the child's ref, for the background task's `task-start`.
   */
  taskStarted(msg: WireMessage, at: number, out: BackendEvent[]): AgentRef | undefined {
    const taskId = str(msg.task_id);
    if (taskId === undefined) return undefined;
    const callId = str(msg.tool_use_id);
    const prompt = str(msg.prompt) ?? '';
    const background = msg.is_backgrounded === true;
    let agent = this.#ids.get(taskId);
    if (agent === undefined && callId !== undefined) {
      // A child first seen through its frames (no agent_id there) is adopted by its spawning call.
      const byCall = this.#ids.get(`call:${callId}`);
      if (byCall !== undefined && byCall.taskId === undefined) agent = byCall;
    }
    if (agent !== undefined) {
      this.#ids.set(taskId, agent);
      agent.taskId = taskId;
      if (agent.running) {
        // Already announced (frames came first, or a repeated frame): keep it, learn the facts.
        if (background) agent.background = true;
        return agent.ref;
      }
      // D50: a finished teammate woken by a message (same task id, the sender's call id).
      agent.running = true;
      agent.background = background;
      delete agent.stepId;
      agent.pendingPrompt = prompt;
      const e = this.#startEvent(agent, prompt, at);
      e.resumed = true;
      const from = agentMessageSender(prompt);
      if (from !== undefined) e.wokenBy = from;
      out.push(e);
      return agent.ref;
    }
    const call = callId === undefined ? undefined : this.#calls.get(callId);
    const input = call?.input ?? {};
    const parentTask = str(msg.parent_task_id);
    const parentAgent = parentTask === undefined ? undefined : this.#ids.get(parentTask);
    const created = this.#create(taskId, {
      parent: parentAgent?.ref ?? call?.owner ?? MAIN,
      parentCallId: callId,
      input,
      description: str(msg.description),
      agentType: str(msg.subagent_type),
      background,
      depth: num(msg.spawn_depth),
      prompt: prompt !== '' ? prompt : (str(input.prompt) ?? ''),
    });
    created.taskId = taskId;
    out.push(this.#startEvent(created, created.pendingPrompt ?? '', at));
    return created.ref;
  }

  /** `task_notification` of a child agent task. */
  taskEnded(taskId: string, status: string | undefined, summary: string | undefined, out: BackendEvent[]): void {
    const agent = this.#ids.get(taskId);
    if (agent === undefined || !agent.running) return;
    this.#end(agent, statusOf(status), summary, out);
  }

  /**
   * The main turn ended. A foreground child cannot outlive the main turn that runs it; after an
   * interrupt or an error the CLI may send no notification for it (**inferred**), so it ends here.
   */
  mainTurnEnded(outcome: 'completed' | 'interrupted' | 'error' | 'deferred', out: BackendEvent[]): void {
    if (outcome === 'completed') return;
    for (const agent of this.#unique())
      if (agent.running && !agent.background)
        this.#end(agent, outcome === 'interrupted' ? 'stopped' : 'failed', undefined, out);
  }

  /** The CLI ended: every running child ends with it (D74). */
  exit(out: BackendEvent[], reason: string): void {
    for (const agent of this.#unique()) if (agent.running) this.#end(agent, 'failed', reason, out);
  }

  /** A child `assistant` frame (D68: one CLI message → one `step-message`, no usage). */
  assistant(msg: WireMessage, at: number, out: BackendEvent[]): void {
    const uuid = str(msg.uuid);
    if (uuid !== undefined) {
      if (this.#seen.has(uuid)) return;
      this.#seen.add(uuid);
    }
    const message = isObject(msg.message) ? (msg.message as Loose) : {};
    const content = (Array.isArray(message.content) ? message.content : []) as WireBlock[];
    const agent = this.#resolve(msg, at, out);
    if (agent === undefined) return;
    this.noteCalls(content, agent.ref);
    const blocks: ContentBlock[] = [];
    for (const raw of content) {
      const b = convertBlock(raw);
      if (b === undefined) continue;
      if (b.type === 'reasoning' && b.text === '') continue; // D86: signed, empty thinking
      if (b.type === 'tool-call' && agent.advertised.has(b.id)) {
        this.#debug('re-sent child tool_use block', b);
        continue;
      }
      blocks.push(b);
    }
    if (blocks.length === 0) return;
    const stepId = str(message.id) ?? uuid ?? `${agent.ref.id}-${at}`;
    if (agent.stepId !== stepId) {
      agent.stepId = stepId;
      out.push({ type: 'step-start', agent: agent.ref, stepId, at });
    }
    const e: Extract<BackendEvent, { type: 'step-message' }> = {
      type: 'step-message',
      agent: agent.ref,
      stepId,
      blocks,
      final: false,
    };
    const model = canonicalModel(str(message.model));
    if (model !== undefined && model !== '<synthetic>') e.model = model;
    if (uuid !== undefined) e.lastChainId = uuid;
    out.push(e);
    for (const b of blocks) if (b.type === 'tool-call') agent.advertised.add(b.id);
    this.#flush(agent, out);
    this.teamMessages(blocks, agent.ref, out);
  }

  /** A child `user` frame: tool results, or text the CLI delivered to the child. */
  user(msg: WireMessage, at: number, out: BackendEvent[]): void {
    const uuid = str(msg.uuid);
    if (uuid !== undefined) {
      if (this.#seen.has(uuid)) return;
      this.#seen.add(uuid);
    }
    const message = isObject(msg.message) ? (msg.message as Loose) : {};
    const agent = this.#resolve(msg, at, out);
    if (agent === undefined) return;
    const content = message.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (!isObject(b) || b.type !== 'tool_result') continue;
        const callId = str(b.tool_use_id);
        if (callId === undefined) continue;
        const e: ToolResultEvent = {
          type: 'tool-result',
          agent: agent.ref,
          callId,
          isError: b.is_error === true,
          content: convertToolResultContent(b.content),
        };
        if (uuid !== undefined) e.chainId = uuid;
        if (agent.advertised.has(callId)) out.push(e);
        else agent.buffered.push(e);
      }
    }
    const text = userText(content);
    if (text === undefined || text.trim() === '' || isSystemReminder(text)) return;
    if (agent.pendingPrompt !== undefined && text.trim() === agent.pendingPrompt.trim()) {
      delete agent.pendingPrompt; // the host writes the prompt itself (agent-start.taskPrompt)
      return;
    }
    out.push({ type: 'agent-input', ref: agent.ref, text, at });
  }

  /** D50: each `SendMessage` call in a written step-message is one team message. */
  teamMessages(blocks: readonly ContentBlock[], sender: AgentRef, out: BackendEvent[]): void {
    for (const b of blocks) {
      if (b.type !== 'tool-call' || b.name !== SEND_MESSAGE_TOOL) continue;
      let input: Loose = {};
      try {
        const parsed: unknown = JSON.parse(b.arguments);
        if (isObject(parsed)) input = parsed;
      } catch {
        continue;
      }
      const to = str(input.to) ?? str(input.recipient);
      const body = input.message ?? input.content;
      if (to === undefined || body === undefined) continue;
      const e: Extract<BackendEvent, { type: 'team-message' }> = {
        type: 'team-message',
        from: this.senderName(sender),
        to,
        text: typeof body === 'string' ? body : JSON.stringify(body),
        agent: sender,
        callId: b.id,
      };
      const summary = str(input.summary);
      if (summary !== undefined) e.summary = summary;
      out.push(e);
    }
  }

  /**
   * Adopt a child known from elsewhere (a transcript read, D49), so its frames map without an
   * `agent-start`. The pending prompt is not set: its first user text is an `agent-input`.
   */
  adopt(id: string, label: string): void {
    const agent = this.#create(id, { parent: MAIN, input: {}, background: false, prompt: '' });
    agent.label = label;
    delete agent.pendingPrompt;
  }

  // ---- internals ----

  #unique(): ChildAgent[] {
    return [...new Set(this.#ids.values())];
  }

  #create(
    id: string,
    o: {
      parent: AgentRef;
      parentCallId?: string | undefined;
      input: Loose;
      description?: string | undefined;
      agentType?: string | undefined;
      background: boolean;
      depth?: number | undefined;
      prompt: string;
    },
  ): ChildAgent {
    const name = str(o.input.name);
    const team = str(o.input.team_name);
    const agentType = o.agentType ?? str(o.input.subagent_type);
    const agent: ChildAgent = {
      ref: { kind: 'child', id },
      parent: o.parent,
      label: name ?? o.description ?? str(o.input.description) ?? agentType ?? 'subagent',
      // D50: a teammate is a child started with a name or a team (it is addressable by name).
      role: name !== undefined || team !== undefined ? 'teammate' : 'subagent',
      background: o.background,
      running: true,
      advertised: new Set(),
      buffered: [],
    };
    if (o.parentCallId !== undefined) agent.parentCallId = o.parentCallId;
    if (name !== undefined) agent.name = name;
    if (team !== undefined) agent.team = team;
    if (agentType !== undefined) agent.agentType = agentType;
    if (o.depth !== undefined) agent.depth = o.depth;
    else if (o.parent.kind === 'main') agent.depth = 1;
    else {
      const parentDepth = this.#ids.get(o.parent.id)?.depth;
      if (parentDepth !== undefined) agent.depth = parentDepth + 1;
    }
    if (o.prompt !== '') agent.pendingPrompt = o.prompt;
    this.#ids.set(id, agent);
    if (o.parentCallId !== undefined) this.#ids.set(`call:${o.parentCallId}`, agent);
    return agent;
  }

  #startEvent(agent: ChildAgent, prompt: string, at: number): AgentStartEvent {
    const e: AgentStartEvent = {
      type: 'agent-start',
      ref: agent.ref,
      parent: agent.parent,
      label: agent.label,
      role: agent.role,
      background: agent.background,
      taskPrompt: prompt,
      at,
    };
    if (agent.parentCallId !== undefined) e.parentCallId = agent.parentCallId;
    if (agent.taskId !== undefined) e.taskId = agent.taskId;
    if (agent.agentType !== undefined) e.agentType = agent.agentType;
    if (agent.name !== undefined) e.name = agent.name;
    if (agent.team !== undefined) e.team = agent.team;
    if (agent.depth !== undefined) e.depth = agent.depth;
    return e;
  }

  /** The child a frame belongs to; an unknown one is announced from its spawning call. */
  #resolve(msg: WireMessage, at: number, out: BackendEvent[]): ChildAgent | undefined {
    const agentId = str(msg.agent_id);
    const callId = str(msg.parent_tool_use_id);
    const known =
      (agentId !== undefined ? this.#ids.get(agentId) : undefined) ??
      (callId !== undefined ? this.#ids.get(`call:${callId}`) : undefined);
    if (known !== undefined) {
      if (!known.running) {
        this.#debug('frame of a finished child dropped', msg);
        return undefined;
      }
      if (agentId !== undefined && !this.#ids.has(agentId)) this.#ids.set(agentId, known);
      return known;
    }
    if (callId === undefined) return undefined;
    // Frames before `task_started` (not seen live; kept safe): announce from the call input.
    const call = this.#calls.get(callId);
    const input = call?.input ?? {};
    const agent = this.#create(agentId ?? `call:${callId}`, {
      parent: call?.owner ?? MAIN,
      parentCallId: callId,
      input,
      description: str(msg.task_description),
      agentType: str(msg.subagent_type),
      background: input.run_in_background === true,
      prompt: str(input.prompt) ?? '',
    });
    out.push(this.#startEvent(agent, agent.pendingPrompt ?? '', at));
    return agent;
  }

  #flush(agent: ChildAgent, out: BackendEvent[]): void {
    const keep: ToolResultEvent[] = [];
    for (const r of agent.buffered) (agent.advertised.has(r.callId) ? out : keep).push(r);
    agent.buffered = keep;
  }

  #end(agent: ChildAgent, status: TaskStatus, summary: string | undefined, out: BackendEvent[]): void {
    agent.running = false;
    delete agent.stepId;
    delete agent.pendingPrompt;
    if (agent.buffered.length > 0) {
      this.#debug('dropping child tool results with no advertised call', agent.buffered);
      agent.buffered = [];
    }
    const e: Extract<BackendEvent, { type: 'agent-end' }> = { type: 'agent-end', ref: agent.ref, status };
    if (summary !== undefined) e.summary = summary;
    out.push(e);
  }
}
