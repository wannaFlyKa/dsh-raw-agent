// Live child agents (D45, D46, D50, D68, D74). DSH-neutral: the port creates the host child
// sessions and runs each child turn through `ChildRunner`; this file holds the live-child registry,
// the per-child event buffer and the child writer logic (the D68 step shape).
//
// A child never spawns or sends anything (D45): its writer only writes what the parent's process
// reported for it. Child steps carry no usage and no live deltas (D68), so DSH can never compute a
// tok/s for them; per-child tokens and tool counts come from task progress (D46) and show in the
// plugin's child rows.

import type { AgentRef, AgentRole, BackendEvent, BackendEventOf, ContentBlock, TaskStatus } from '@dsh-raw-agent/core';
import type { SinkResultContent, TurnSink } from './driver.js';

/** What the port needs to create one host child session (D45). */
export interface ChildSpec {
  /** The agent's child id (Claude: the task id, so `stopTask(ref)` stops it, D46). */
  ref: string;
  label: string;
  role: AgentRole;
  background: boolean;
  /** 1 for a child of the main agent, 2 for its child, and so on. */
  depth: number;
  agentType?: string;
  name?: string;
  team?: string;
  /** The parent's tool call that started the child (Claude: the `Agent` call), D77. */
  callId?: string;
}

/** How one child turn ended, as the port tells the host loop. */
export type ChildOutcome =
  { kind: 'completed' } | { kind: 'stopped'; cause: 'user' | 'parent' } | { kind: 'error'; message: string };

/**
 * Run one child turn. The port calls it from the child session's own pre-step (the child writer),
 * after it wrote the turn's first message. It resolves when the child ends or this turn's events
 * are written.
 */
export type ChildRunner = (sink: TurnSink, signal: AbortSignal) => Promise<ChildOutcome>;

/** One host child session, made by the port. */
export interface ChildHandle {
  readonly hostSessionId: string;
  /** Open one child turn on this text (the task prompt, or the message that woke a teammate). */
  begin(prompt: string): void;
  /** Create a nested child under this child (nesting follows the agent's spawn depth). */
  createChild(spec: ChildSpec, runner: ChildRunner): Promise<ChildHandle>;
  dispose(): Promise<void>;
}

export type ChildStatus = 'starting' | 'running' | TaskStatus;

/** One child row for the plugin UI (tree, roster, per-child stop). Wire-safe JSON. */
export interface ChildView {
  id: string;
  /** `'main'` or the parent child's id. */
  parent: string;
  label: string;
  role: AgentRole;
  status: ChildStatus;
  background: boolean;
  depth: number;
  agentType?: string;
  name?: string;
  team?: string;
  /** The host child session, once it exists. */
  hostSessionId?: string;
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
  startedAt: number;
  endedAt?: number;
  summary?: string;
  /** How often a finished teammate was woken again (D50). */
  wakes: number;
  /** Who sent the message that woke it last. */
  wokenBy?: string;
  /** Texts the agent delivered to the running child (not tool results; never human text). */
  inputs: number;
  /** A per-child stop is on its way (D46). */
  stopping?: boolean;
  /** The host has no child session for it (creation failed or no agent registry). */
  noSession?: boolean;
  /** The parent's tool call that started the child (D77: "a subagent is waiting" on that card). */
  callId?: string;
  /**
   * The child's latest output, one line (R6.1 live child output in the plugin row): its last
   * text, reasoning, or the name of the tool it called. Plain text, at most CHILD_LAST_CHARS.
   */
  last?: { kind: 'text' | 'reasoning' | 'tool'; text: string; at: number };
}

/** How long the `last` line of a child row may be. */
export const CHILD_LAST_CHARS = 160;

/** The latest output line of one child message (the last block that has something to show). */
export function lastOutput(
  blocks: readonly ContentBlock[],
  at: number,
): { kind: 'text' | 'reasoning' | 'tool'; text: string; at: number } | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.type === 'tool-call') return { kind: 'tool', text: b.name.slice(0, CHILD_LAST_CHARS), at };
    const text = b.text.replace(/\s+/g, ' ').trim();
    if (text === '') continue;
    const clipped = text.length > CHILD_LAST_CHARS ? `…${text.slice(-(CHILD_LAST_CHARS - 1))}` : text;
    return { kind: b.type === 'reasoning' ? 'reasoning' : 'text', text: clipped, at };
  }
  return undefined;
}

export interface TeamMessageView {
  from: string;
  to: string;
  text: string;
  summary?: string;
  /** The sender: `'main'` or a child id. */
  sender: string;
  at: number;
}

/** The team roster model (D50): teammates grouped by team, and the messages between agents. */
export interface TeamView {
  teams: Array<{ name: string; members: string[] }>;
  messages: TeamMessageView[];
  /** The agent accepts messages from the user to a teammate (D50); else the box is disabled. */
  messaging: boolean;
}

export interface ChildHubDeps {
  now(): number;
  warn(note: string, detail?: unknown): void;
  notify(): void;
  /** Create a child of the main session. Undefined or a throw: the child has no host session. */
  createRootChild?(spec: ChildSpec, runner: ChildRunner): Promise<ChildHandle>;
  /** The live process's per-task stop (D46). */
  stopTask?(taskId: string): Promise<void>;
  teamMessaging?(): boolean;
  /** The text a child result image becomes when it is not stored (D85). */
  imageText(mediaType: string): string;
}

/** How long a per-child stop waits for the agent's own end before it reports "stopping" (D46). */
export const CHILD_STOP_WAIT_MS = 2000;
/** How many team messages the roster keeps (in memory only, D24). */
export const TEAM_MESSAGES_KEPT = 200;

type ChildItem = BackendEvent | { type: 'child-end'; status: TaskStatus; summary?: string } | { type: 'child-abort' };

class ChildEntry {
  readonly spec: ChildSpec;
  readonly parent: AgentRef;
  readonly view: ChildView;
  taskId: string | undefined;
  handle: ChildHandle | undefined;
  ready: Promise<ChildHandle | undefined> = Promise.resolve(undefined);
  readonly prompts: string[] = [];
  queue: ChildItem[] = [];
  #waiter: ((i: ChildItem) => void) | undefined;
  turnOpen = false;
  beginPending = false;
  /** The child turn was cut by the host (Stop in the child view); later events are not written. */
  detached = false;
  stopCause: 'user' | 'parent' | undefined;
  sink: TurnSink | undefined;
  readonly endWaiters: Array<() => void> = [];

  constructor(spec: ChildSpec, parent: AgentRef, at: number) {
    this.spec = spec;
    this.parent = parent;
    this.view = {
      id: spec.ref,
      parent: parent.kind === 'main' ? 'main' : parent.id,
      label: spec.label,
      role: spec.role,
      status: 'starting',
      background: spec.background,
      depth: spec.depth,
      startedAt: at,
      wakes: 0,
      inputs: 0,
    };
    if (spec.agentType !== undefined) this.view.agentType = spec.agentType;
    if (spec.name !== undefined) this.view.name = spec.name;
    if (spec.team !== undefined) this.view.team = spec.team;
    if (spec.callId !== undefined) this.view.callId = spec.callId;
  }

  get live(): boolean {
    return this.view.status === 'starting' || this.view.status === 'running';
  }

  push(i: ChildItem): void {
    if ((this.detached || this.view.noSession) && i.type !== 'child-abort') return;
    const w = this.#waiter;
    if (w) {
      this.#waiter = undefined;
      w(i);
    } else this.queue.push(i);
  }

  next(): Promise<ChildItem> {
    const i = this.queue.shift();
    if (i !== undefined) return Promise.resolve(i);
    return new Promise((r) => (this.#waiter = r));
  }
}

export class ChildHub {
  readonly #deps: ChildHubDeps;
  readonly #entries = new Map<string, ChildEntry>();
  readonly #messages: TeamMessageView[] = [];
  #disposed = false;
  #creating: Promise<unknown> = Promise.resolve();

  constructor(deps: ChildHubDeps) {
    this.#deps = deps;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Is this a child of this session (by its agent id)? */
  has(id: string): boolean {
    return this.#entries.has(id);
  }

  /** Route one child event (D45). Returns false when the event is not a child event. */
  handle(e: BackendEvent): boolean {
    switch (e.type) {
      case 'agent-start':
        this.#start(e);
        return true;
      case 'agent-end': {
        const entry = this.#entries.get(refId(e.ref));
        if (entry) this.#end(entry, e.status, e.summary);
        return true;
      }
      case 'agent-input': {
        const entry = this.#entries.get(refId(e.ref));
        if (entry) entry.view.inputs++;
        return true;
      }
      case 'team-message': {
        const m: TeamMessageView = {
          from: e.from,
          to: e.to,
          text: e.text,
          sender: refId(e.agent),
          at: this.#deps.now(),
        };
        if (e.summary !== undefined) m.summary = e.summary;
        this.#messages.push(m);
        if (this.#messages.length > TEAM_MESSAGES_KEPT)
          this.#messages.splice(0, this.#messages.length - TEAM_MESSAGES_KEPT);
        return true;
      }
      case 'step-start':
      case 'delta':
      case 'step-message':
      case 'tool-result': {
        if (e.agent.kind !== 'child') return false;
        const entry = this.#entries.get(e.agent.id);
        if (!entry) {
          this.#deps.warn('dropped an event of an unknown child agent', e.agent.id);
          return true;
        }
        if (e.type === 'step-message') {
          const last = lastOutput(e.blocks, this.#deps.now());
          if (last) {
            entry.view.last = last;
            this.#deps.notify();
          }
        }
        if (e.type !== 'delta') entry.push(e); // D68: children have no live deltas
        return true;
      }
      default:
        return false;
    }
  }

  /** Task progress of a child's task: tokens and tool count for its row (D46, D68). */
  progress(taskId: string, usage: BackendEventOf<'task-progress'>['usage']): boolean {
    for (const entry of this.#entries.values()) {
      if (entry.taskId !== taskId && entry.spec.ref !== taskId) continue;
      if (usage?.tokens !== undefined) entry.view.tokens = usage.tokens;
      if (usage?.toolUses !== undefined) entry.view.toolUses = usage.toolUses;
      if (usage?.durationMs !== undefined) entry.view.durationMs = usage.durationMs;
      return true;
    }
    return false;
  }

  #start(e: BackendEventOf<'agent-start'>): void {
    const id = refId(e.ref);
    const known = this.#entries.get(id);
    if (known) {
      // D50: a finished teammate woken by a message runs a new turn in the same child session.
      if (e.taskId !== undefined) known.taskId = e.taskId;
      if (!known.live) {
        known.view.status = 'running';
        delete known.view.endedAt;
        delete known.view.stopping;
        known.detached = false;
        known.stopCause = undefined;
      }
      if (e.resumed === true) known.view.wakes++;
      if (e.wokenBy !== undefined) known.view.wokenBy = e.wokenBy;
      known.prompts.push(e.taskPrompt);
      this.#beginNext(known);
      this.#deps.notify();
      return;
    }
    const spec: ChildSpec = { ref: id, label: e.label, role: e.role, background: e.background, depth: e.depth ?? 1 };
    if (e.agentType !== undefined) spec.agentType = e.agentType;
    if (e.name !== undefined) spec.name = e.name;
    if (e.team !== undefined) spec.team = e.team;
    if (e.parentCallId !== undefined) spec.callId = e.parentCallId;
    const entry = new ChildEntry(spec, e.parent, this.#deps.now());
    entry.taskId = e.taskId;
    entry.view.status = 'running';
    entry.prompts.push(e.taskPrompt);
    this.#entries.set(id, entry);
    const parent = e.parent.kind === 'child' ? this.#entries.get(e.parent.id) : undefined;
    if (parent) spec.depth = Math.max(spec.depth, parent.spec.depth + 1);
    const runner: ChildRunner = (sink, signal) => this.#run(entry, sink, signal);
    const previous = this.#creating;
    entry.ready = (async () => {
      // One creation at a time, in start order (two concurrent creates were seen to stall).
      await previous;
      let handle: ChildHandle | undefined;
      if (parent) {
        const ph = await parent.ready;
        if (ph) handle = await ph.createChild(spec, runner);
      } else if (this.#deps.createRootChild) handle = await this.#deps.createRootChild(spec, runner);
      if (!handle) throw new Error('the host has no child sessions here');
      if (this.#disposed) {
        await handle.dispose().catch(() => {});
        throw new Error('the session is closed');
      }
      entry.handle = handle;
      entry.view.hostSessionId = handle.hostSessionId;
      this.#beginNext(entry);
      this.#deps.notify();
      return handle;
    })().catch((error: unknown) => {
      entry.view.noSession = true;
      entry.queue = [];
      this.#deps.warn(`could not create a child session for ${spec.label}`, String((error as Error)?.message ?? error));
      this.#deps.notify();
      return undefined;
    });
    this.#creating = entry.ready.then(
      () => undefined,
      () => undefined,
    );
  }

  #beginNext(entry: ChildEntry): void {
    if (!entry.handle || entry.turnOpen || entry.beginPending || this.#disposed) return;
    const prompt = entry.prompts.shift();
    if (prompt === undefined) return;
    entry.beginPending = true;
    try {
      entry.handle.begin(prompt);
    } catch (error) {
      entry.beginPending = false;
      this.#deps.warn('could not open a child turn', String((error as Error)?.message ?? error));
    }
  }

  #end(entry: ChildEntry, status: TaskStatus, summary?: string): void {
    if (!entry.live) return;
    entry.view.status = status;
    entry.view.endedAt = this.#deps.now();
    delete entry.view.stopping;
    if (summary !== undefined) entry.view.summary = summary;
    if (status === 'stopped') entry.stopCause ??= 'parent';
    const item: ChildItem = { type: 'child-end', status };
    if (summary !== undefined) item.summary = summary;
    entry.push(item);
    for (const w of entry.endWaiters.splice(0)) w();
    this.#deps.notify();
  }

  /**
   * D74: the process died, was force-stopped or disposed: every live child ends now, so each child
   * writer closes its open step (repair results, `assistant/attempt`) and ends its turn.
   */
  endAll(status: TaskStatus, summary?: string): void {
    for (const entry of this.#entries.values()) if (entry.live) this.#end(entry, status, summary);
  }

  /**
   * D74: an interrupted main turn ends its foreground children (the agent may send no end for
   * them). Background children and teammates keep running (rule 6).
   */
  endForeground(): void {
    for (const entry of this.#entries.values())
      if (entry.live && !entry.spec.background && entry.spec.role !== 'teammate') this.#end(entry, 'stopped');
  }

  /** Resolve once no child turn is open or about to open, or after `ms`. */
  async quiesce(ms: number): Promise<void> {
    const end = this.#deps.now() + ms;
    const busy = () =>
      [...this.#entries.values()].some((e) => e.turnOpen || (e.beginPending && e.handle !== undefined));
    while (busy() && this.#deps.now() < end) await new Promise((r) => setTimeout(r, 10));
  }

  /**
   * D46: stop one child: the agent's per-task stop, then wait up to 2 s for the agent's own end.
   * The other children keep running.
   */
  async stop(
    id: string,
    waitMs = CHILD_STOP_WAIT_MS,
  ): Promise<{ ok: boolean; status: ChildStatus | 'stopping' | 'unknown'; error?: string }> {
    const entry = this.#entries.get(id);
    if (!entry) return { ok: false, status: 'unknown', error: 'no such child agent in this session' };
    if (!entry.live) return { ok: true, status: entry.view.status };
    if (!this.#deps.stopTask) return { ok: false, status: entry.view.status, error: 'this agent cannot stop one task' };
    entry.view.stopping = true;
    entry.stopCause = 'user';
    this.#deps.notify();
    try {
      await this.#deps.stopTask(entry.taskId ?? entry.spec.ref);
    } catch (error) {
      delete entry.view.stopping;
      entry.stopCause = undefined;
      this.#deps.notify();
      return { ok: false, status: entry.view.status, error: String((error as Error)?.message ?? error) };
    }
    if (entry.live) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve) => {
        entry.endWaiters.push(resolve);
        timer = setTimeout(resolve, waitMs);
      });
      clearTimeout(timer);
    }
    return { ok: true, status: entry.live ? 'stopping' : entry.view.status };
  }

  /**
   * The host child session of one child, once it is made (D48: a workflow member record names
   * it). Undefined when the child is unknown or has no host session.
   */
  async session(id: string): Promise<string | undefined> {
    const entry = this.#entries.get(id);
    if (!entry) return undefined;
    const handle = await entry.ready;
    return handle?.hostSessionId;
  }

  /** The role of one child, if it is known. */
  role(id: string): AgentRole | undefined {
    return this.#entries.get(id)?.spec.role;
  }

  /** The open turn's writer of one child, for its D44 audit pair. */
  openSink(id: string): TurnSink | undefined {
    const entry = this.#entries.get(id);
    return entry?.turnOpen ? entry.sink : undefined;
  }

  label(id: string): string | undefined {
    return this.#entries.get(id)?.view.label;
  }

  views(): ChildView[] {
    return [...this.#entries.values()].map((e) => ({ ...e.view }));
  }

  team(): TeamView | undefined {
    const teams = new Map<string, string[]>();
    for (const e of this.#entries.values()) {
      if (e.spec.role !== 'teammate') continue;
      const name = e.spec.team ?? '';
      teams.set(name, [...(teams.get(name) ?? []), e.spec.ref]);
    }
    if (teams.size === 0 && this.#messages.length === 0) return undefined;
    return {
      teams: [...teams].map(([name, members]) => ({ name, members })),
      messages: this.#messages.map((m) => ({ ...m })),
      messaging: this.#deps.teamMessaging?.() === true,
    };
  }

  /** The runtime ends for good: end every child turn and dispose the host child sessions. */
  async dispose(): Promise<void> {
    this.endAll('stopped');
    await this.quiesce(1000);
    this.#disposed = true;
    const handles = [...this.#entries.values()].map((e) => e.handle).filter((h): h is ChildHandle => h !== undefined);
    await Promise.all(handles.map((h) => h.dispose().catch(() => {})));
  }

  /**
   * The child writer (D68): one step per agent message id, one `assistant/message` per frame, the
   * `tool/call`s, then results. A new step waits until every call of the open step has its result
   * (its events are held back); when the child ends, open calls get the exact repair result (D74).
   */
  async #run(entry: ChildEntry, sink: TurnSink, signal: AbortSignal): Promise<ChildOutcome> {
    entry.turnOpen = true;
    entry.beginPending = false;
    entry.sink = sink;
    const onAbort = () => entry.push({ type: 'child-abort' });
    signal.addEventListener('abort', onAbort, { once: true });
    let held: ChildItem[] | undefined;
    const binding = { backend: 'child', agentId: entry.spec.ref };
    try {
      for (;;) {
        const item = await entry.next();
        if (item.type === 'child-abort') {
          // The host cancelled this child turn. A user's Stop also stops the agent's task (D46).
          const reason = signal.reason as { kind?: unknown } | undefined;
          const byUser = reason?.kind === 'user';
          entry.detached = true;
          entry.queue = [];
          if (byUser && entry.live) void this.stop(entry.spec.ref, 0);
          return { kind: 'stopped', cause: byUser ? 'user' : 'parent' };
        }
        if (item.type === 'child-end') {
          // A step held back for open calls: those calls get repairs, then the step is written.
          const rest = held ?? [];
          held = undefined;
          for (const h of rest) {
            try {
              this.#write(sink, h as BackendEvent, binding, entry, () => {
                sink.closeStep();
                sink.openStep();
              });
            } catch (error) {
              this.#deps.warn(`refused a child ${h.type}`, String((error as Error)?.message ?? error));
            }
          }
          if (item.status === 'completed') return { kind: 'completed' };
          if (item.status === 'stopped') return { kind: 'stopped', cause: entry.stopCause ?? 'parent' };
          return { kind: 'error', message: item.summary ?? `${entry.spec.label} failed` };
        }
        if (held) {
          const r = item.type === 'tool-result' && sink.stepOpen && sink.openCallIds.includes(item.callId);
          if (!r) {
            held.push(item);
            continue;
          }
        }
        try {
          this.#write(sink, item, binding, entry, (h) => (held = h));
        } catch (error) {
          this.#deps.warn(`refused a child ${item.type}`, String((error as Error)?.message ?? error));
        }
        if (held && sink.openCallIds.length === 0) {
          sink.closeStep();
          entry.queue.unshift(...held);
          held = undefined;
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      try {
        sink.closeStep();
      } catch (error) {
        this.#deps.warn('closing a child step failed', String(error));
      }
      entry.turnOpen = false;
      entry.sink = undefined;
      entry.queue = entry.queue.filter((i) => i.type !== 'child-abort');
      this.#beginNext(entry);
      this.#deps.notify();
    }
  }

  #write(
    sink: TurnSink,
    item: BackendEvent,
    binding: Record<string, unknown>,
    entry: ChildEntry,
    hold: (h: ChildItem[]) => void,
  ): void {
    switch (item.type) {
      case 'step-start':
        if (sink.stepOpen) {
          if (sink.openCallIds.length > 0) {
            hold([item]);
            return;
          }
          sink.closeStep();
        }
        sink.openStep();
        return;
      case 'step-message': {
        if (!sink.stepOpen) sink.openStep();
        // D68: never usage (the per-message output count is a placeholder).
        const m: Parameters<TurnSink['commit']>[0] = { blocks: item.blocks, binding };
        if (item.model) m.model = item.model;
        if (sink.hasMessage) m.continued = true;
        sink.commit(m);
        return;
      }
      case 'tool-result': {
        if (!sink.stepOpen || !sink.hasCall(item.callId) || !sink.openCallIds.includes(item.callId)) {
          this.#deps.warn(`dropped a child tool result with no open call (${entry.spec.label})`, item.callId);
          return;
        }
        const content: SinkResultContent[] = item.content.map((c) =>
          c.type === 'image' ? { type: 'text', text: this.#deps.imageText(c.mediaType) } : c,
        );
        sink.result(item.callId, content, item.isError, item.chainId);
        return;
      }
      default:
        return;
    }
  }
}

function refId(ref: AgentRef): string {
  return ref.kind === 'main' ? 'main' : ref.id;
}
