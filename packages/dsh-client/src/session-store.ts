// One store per host session for the plugin's session controls (R1.4). It polls the Host's
// session route while a component is subscribed, and only then (no work for sessions nobody
// looks at). A 404 means "not a session of this plugin": the controls render nothing.

import type { SessionChoiceRequest } from '@dsh-raw-agent/core';
import {
  RouteError,
  type AskReplyWire,
  type ChannelLine,
  type RawAgentApi,
  type SessionInfo,
  type TaskOutputWire,
} from './api.js';
import { nextModeFor } from './view-model.js';

export interface SessionSnapshot {
  status: 'loading' | 'absent' | 'ready' | 'error';
  info?: SessionInfo;
  /** A choice or start request is in flight. */
  busy: boolean;
  /** The last choice's note ("applied", "applies when … starts"). */
  note?: string;
  /**
   * The process state the note was given in. A later read with another state (the process
   * started, or ended) drops the note, so "applies when … starts" does not stay once it applied.
   */
  noteProcess?: string;
  error?: string;
  /** The interaction channel (D39) is connected: asks arrive at once, no fast poll needed. */
  channel?: 'open' | 'closed';
  /** The ask whose answer is in flight. */
  answering?: string;
  /** Why the last answer to an ask was refused (the card shows it; the ask stays open). */
  askError?: { id: string; text: string };
  /** Child agents and tasks whose Stop is in flight (D46, D47), by id. */
  stopping?: readonly string[];
  /** Why the last Stop of one child or task failed. */
  stopError?: { id: string; text: string };
  /**
   * A panel the `/` source asked to open (the bare MCP command, D55): the controls open it when
   * `seq` changes. Browser state only; nothing is sent.
   */
  panelRequest?: { panel: 'mcp'; seq: number };
}

export interface PollTimings {
  ready: number;
  /** While a turn runs, the process starts, or an ask waits for the user. */
  active: number;
  absent: number;
  /**
   * The first retry after a 404, doubled each time up to `absent`. A new task's agent is adopted
   * by the Host a moment after the page asks (M1 live: the first read is a 404), so the controls
   * would otherwise stay hidden for a full `absent` interval.
   */
  absentFirst?: number;
  error: number;
}

/** Poll faster while something changes (a process starts, a turn runs). */
export const POLL_MS: PollTimings = { ready: 4000, active: 1500, absent: 20000, absentFirst: 1000, error: 10000 };
/** Wait before the interaction channel connects again after it ended or failed. */
export const CHANNEL_RETRY_MS = 2000;

export interface TimerApi {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultTimers: TimerApi = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class SessionControlStore {
  readonly sessionId: string;
  readonly #api: RawAgentApi;
  readonly #timers: TimerApi;
  readonly #timings: PollTimings;
  #snapshot: SessionSnapshot = { status: 'loading', busy: false };
  readonly #listeners = new Set<() => void>();
  #timer: unknown;
  #generation = 0;
  #inflight: Promise<void> | undefined;
  #absentStreak = 0;
  readonly #observers = new Set<() => void>();
  #channel: AbortController | undefined;
  #channelTimer: unknown;
  #noChannel = false;

  constructor(sessionId: string, api: RawAgentApi, timers: TimerApi = defaultTimers, timings: PollTimings = POLL_MS) {
    this.sessionId = sessionId;
    this.#api = api;
    this.#timers = timers;
    this.#timings = timings;
  }

  getSnapshot = (): SessionSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) void this.refresh();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#stop();
        this.#closeChannel();
      }
    };
  };

  /**
   * Watch the snapshot without starting any reads (the port's pending-interaction publisher):
   * only a `subscribe` makes the store poll and open the interaction channel.
   */
  observe = (listener: () => void): (() => void) => {
    this.#observers.add(listener);
    return () => this.#observers.delete(listener);
  };

  #set(next: Partial<SessionSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...next };
    for (const l of [...this.#listeners]) l();
    for (const l of [...this.#observers]) {
      try {
        l();
      } catch {
        // an observer never breaks the controls
      }
    }
  }

  #stop(): void {
    if (this.#timer !== undefined) this.#timers.clear(this.#timer);
    this.#timer = undefined;
  }

  #closeChannel(): void {
    if (this.#channelTimer !== undefined) this.#timers.clear(this.#channelTimer);
    this.#channelTimer = undefined;
    const c = this.#channel;
    this.#channel = undefined;
    c?.abort();
    if (this.#snapshot.channel === 'open') this.#set({ channel: 'closed' });
  }

  /**
   * D39: while someone looks at this session and it is ours, keep the interaction channel open,
   * so a new ask (or another browser's answer) shows at once. It reconnects after it ends.
   */
  #openChannel(): void {
    if (this.#channel || this.#channelTimer !== undefined) return;
    if (this.#listeners.size === 0 || this.#snapshot.status !== 'ready') return;
    if (typeof this.#api.interactions !== 'function' || this.#noChannel) return;
    const ac = new AbortController();
    this.#channel = ac;
    const onLine = (line: ChannelLine) => {
      if (ac.signal.aborted || line.type !== 'asks') return;
      const info = this.#snapshot.info;
      const next: Partial<SessionSnapshot> = { channel: 'open' };
      if (info) {
        const view = {
          ...info.view,
          asks: line.asks,
          ...(line.state ? { state: line.state } : {}),
          ...(line.live ? { live: line.live } : {}),
        };
        if (line.agents) {
          // R6.1-R6.3: the agent rows ride the channel, so child output shows at once.
          if (line.agents.children.length > 0) view.children = line.agents.children;
          else delete view.children;
          if (line.agents.team) view.team = line.agents.team;
          else delete view.team;
          if (line.agents.tasks.length > 0) view.tasks = line.agents.tasks;
          else delete view.tasks;
        }
        if (line.workflows) {
          // D48: the runs ride the channel too, so a phase or an agent's tokens show at once.
          if (line.workflows.length > 0) view.workflows = line.workflows;
          else delete view.workflows;
        }
        if (line.usage !== undefined) {
          // M5: the pill's summary rides the channel, so the context reading follows each call.
          if (line.usage) view.usage = line.usage;
          else delete view.usage;
        }
        // M6: the side questions (D54), the menu version and the MCP summary ride the channel too.
        for (const key of ['side', 'menu', 'mcp'] as const) {
          const val = line[key];
          if (val === undefined) continue;
          if (val === null) delete view[key];
          else (view as Record<string, unknown>)[key] = val;
        }
        next.info = { ...info, view };
        ++this.#generation; // a poll that started before this line is older
      }
      const err = this.#snapshot.askError;
      if (err && !line.asks.some((a) => a.id === err.id)) next.askError = undefined;
      this.#set(next);
    };
    void this.#api
      .interactions(this.sessionId, ac.signal, onLine)
      .catch((e: unknown) => e)
      .then((e) => {
        if (this.#channel !== ac) return;
        this.#channel = undefined;
        if (this.#snapshot.channel === 'open') this.#set({ channel: 'closed' });
        // 404: not ours (any more); the poll decides what to show. 200 without a body: this
        // fetch cannot stream, so the poll alone carries the asks.
        if (e instanceof RouteError && (e.status === 404 || e.status === 200)) {
          if (e.status === 200) this.#noChannel = true;
          return;
        }
        if (this.#listeners.size === 0) return;
        this.#channelTimer = this.#timers.set(() => {
          this.#channelTimer = undefined;
          this.#openChannel();
        }, CHANNEL_RETRY_MS);
      });
  }

  #schedule(): void {
    this.#stop();
    if (this.#listeners.size === 0) return;
    const s = this.#snapshot;
    const v = s.info?.view;
    const asking = (v?.asks?.length ?? 0) > 0 && s.channel !== 'open';
    // A running child changes its row often; without the channel, poll as during a turn.
    const childRunning =
      s.channel !== 'open' && (v?.children ?? []).some((c) => c.status === 'running' || c.status === 'starting');
    const active = v !== undefined && (v.state.turn || v.state.process === 'starting' || asking || childRunning);
    const ms =
      s.status === 'ready'
        ? active
          ? this.#timings.active
          : this.#timings.ready
        : s.status === 'absent'
          ? this.#absentDelay()
          : this.#timings.error;
    if (s.status !== 'absent') this.#absentStreak = 0;
    this.#timer = this.#timers.set(() => void this.refresh(), ms);
    if (s.status === 'ready') this.#openChannel();
    else if (s.status === 'absent') this.#closeChannel();
  }

  #absentDelay(): number {
    const max = this.#timings.absent;
    const first = Math.min(this.#timings.absentFirst ?? max, max);
    const ms = Math.min(max, first * 2 ** this.#absentStreak);
    this.#absentStreak++;
    return ms;
  }

  /** Read the session now. Concurrent calls share one request. */
  refresh(): Promise<void> {
    this.#inflight ??= (async () => {
      const gen = ++this.#generation;
      try {
        const info = await this.#api.session(this.sessionId);
        if (gen !== this.#generation) return;
        const next: Partial<SessionSnapshot> = { status: 'ready', info, error: undefined };
        const s = this.#snapshot;
        if (s.note !== undefined && s.noteProcess !== info.view.state.process) {
          next.note = undefined;
          next.noteProcess = undefined;
        }
        this.#set(next);
      } catch (e) {
        if (gen !== this.#generation) return;
        if (e instanceof RouteError && e.status === 404) this.#set({ status: 'absent', info: undefined });
        else this.#set({ status: this.#snapshot.info ? 'ready' : 'error', error: String((e as Error)?.message ?? e) });
      }
    })().finally(() => {
      this.#inflight = undefined;
      this.#schedule();
    });
    return this.#inflight;
  }

  /** A session-only choice (D35-D38). The Host answers with the new state. */
  async choose(choice: SessionChoiceRequest): Promise<void> {
    this.#set({ busy: true, error: undefined, note: undefined });
    try {
      const r = await this.#api.choose(this.sessionId, choice);
      ++this.#generation; // a poll that started before this answer is older
      const next: Partial<SessionSnapshot> = { busy: false };
      if (r.session) next.info = r.session;
      if (r.ok) {
        next.note = r.note;
        next.noteProcess = (r.session ?? this.#snapshot.info)?.view.state.process;
      } else next.error = r.error ?? 'the choice was refused';
      this.#set(next);
    } catch (e) {
      this.#set({ busy: false, error: String((e as Error)?.message ?? e) });
    }
  }

  /**
   * The user's answer to one pending ask (a click; nothing is answered without one). `reply` is a
   * bare choice id, or the choice with its feedback or form. A refused answer keeps the ask open
   * and names the reason on its card; an ask another browser answered first is dropped.
   */
  async answer(askId: string, reply: string | AskReplyWire): Promise<boolean> {
    if (this.#snapshot.answering === askId) return false;
    this.#set({ error: undefined, answering: askId, askError: undefined });
    try {
      const r = await this.#api.answer(this.sessionId, askId, reply);
      ++this.#generation;
      const next: Partial<SessionSnapshot> = { answering: undefined };
      if (r.session) next.info = r.session;
      else if (r.ok || r.gone) {
        // Drop the card now; the channel or the next read confirms it.
        const info = this.#snapshot.info;
        if (info)
          next.info = { ...info, view: { ...info.view, asks: (info.view.asks ?? []).filter((a) => a.id !== askId) } };
      }
      if (!r.ok) {
        const text = r.error ?? 'that question is no longer open';
        if (r.gone) next.error = `${text} (answered elsewhere, or withdrawn)`;
        else next.askError = { id: askId, text };
      }
      this.#set(next);
      return r.ok;
    } catch (e) {
      this.#set({ answering: undefined, askError: { id: askId, text: String((e as Error)?.message ?? e) } });
      return false;
    }
  }

  /**
   * The agent's "next mode" key (D38; Claude's Shift+Tab ring). False when the session has no
   * ring, nothing to switch to, a choice is in flight, or an ask waits for the user.
   */
  cycleMode(): boolean {
    const s = this.#snapshot;
    if (s.status !== 'ready' || !s.info || s.busy) return false;
    if ((s.info.view.asks ?? []).length > 0) return false;
    const next = nextModeFor(s.info);
    if (next === undefined) return false;
    void this.choose({ mode: next });
    return true;
  }

  /**
   * D46: stop one child agent (the user's click). The others and the main turn keep running. The
   * Host waits up to 2 s for the agent's own end; a later end arrives with the next read.
   */
  async stopChild(childId: string): Promise<boolean> {
    return this.#stopOne(childId, () => this.#api.stopChild(this.sessionId, childId));
  }

  /** D47: stop one background task from the plugin's task list (the user's click). */
  async stopTask(taskId: string): Promise<boolean> {
    return this.#stopOne(taskId, () => this.#api.stopTask(this.sessionId, taskId));
  }

  /**
   * D48: "Stop entire workflow" (the user's click): the agent's per-task stop on the run. The
   * process, the main turn and other tasks keep running (rule 6).
   */
  async stopWorkflow(taskId: string): Promise<boolean> {
    return this.#stopOne(taskId, () => this.#api.stopWorkflow(this.sessionId, taskId));
  }

  /** D48: stop one workflow agent, only where the agent can (the Host refuses it otherwise). */
  async stopWorkflowAgent(taskId: string, agentId: string): Promise<boolean> {
    return this.#stopOne(agentId, () => this.#api.stopWorkflowAgent(this.sessionId, taskId, agentId));
  }

  /** R6.2: read the end of one background shell's or monitor's output (a read, no state kept). */
  taskOutput(taskId: string): Promise<TaskOutputWire> {
    return this.#api.taskOutput(this.sessionId, taskId);
  }

  async #stopOne(id: string, call: () => Promise<{ ok: boolean; error?: string }>): Promise<boolean> {
    const busy = this.#snapshot.stopping ?? [];
    if (busy.includes(id)) return false;
    this.#set({ stopping: [...busy, id], stopError: undefined });
    let ok = false;
    try {
      const r = await call();
      ok = r.ok;
      if (!r.ok) this.#set({ stopError: { id, text: r.error ?? 'the stop was refused' } });
    } catch (e) {
      this.#set({ stopError: { id, text: String((e as Error)?.message ?? e) } });
    }
    this.#set({ stopping: (this.#snapshot.stopping ?? []).filter((x) => x !== id) });
    await this.refresh();
    return ok;
  }

  /** "Start <displayName>" (D4): spawn without a message, for controls that need a process. */
  /** Ask the controls of this session to open one of our panels (D55: the bare MCP command). */
  requestPanel(panel: 'mcp'): void {
    this.#set({ panelRequest: { panel, seq: (this.#snapshot.panelRequest?.seq ?? 0) + 1 } });
  }

  async start(): Promise<void> {
    this.#set({ busy: true, error: undefined });
    try {
      await this.#api.start(this.sessionId);
      this.#set({ busy: false });
    } catch (e) {
      this.#set({ busy: false, error: String((e as Error)?.message ?? e) });
    }
    await this.refresh();
  }

  dispose(): void {
    this.#listeners.clear();
    this.#observers.clear();
    this.#stop();
    this.#closeChannel();
  }
}

/** One store per session id, created on first use. */
export class SessionStores {
  readonly #api: RawAgentApi;
  readonly #timers: TimerApi | undefined;
  readonly #stores = new Map<string, SessionControlStore>();
  readonly #created = new Set<(store: SessionControlStore) => void>();
  constructor(api: RawAgentApi, timers?: TimerApi) {
    this.#api = api;
    this.#timers = timers;
  }
  get(sessionId: string): SessionControlStore {
    let s = this.#stores.get(sessionId);
    if (!s) {
      s = new SessionControlStore(sessionId, this.#api, this.#timers);
      this.#stores.set(sessionId, s);
      for (const fn of [...this.#created]) fn(s);
    }
    return s;
  }
  /** The store of a session, only if one exists (no store is created). */
  peek(sessionId: string): SessionControlStore | undefined {
    return this.#stores.get(sessionId);
  }
  /** Run `fn` for every store, now and when one is created. */
  each(fn: (store: SessionControlStore) => void): () => void {
    for (const s of this.#stores.values()) fn(s);
    this.#created.add(fn);
    return () => this.#created.delete(fn);
  }
  dispose(): void {
    for (const s of this.#stores.values()) s.dispose();
    this.#stores.clear();
  }
}
