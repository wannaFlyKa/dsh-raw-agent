// One store per host session for the plugin's session controls (R1.4). It polls the Host's
// session route while a component is subscribed, and only then (no work for sessions nobody
// looks at). A 404 means "not a session of this plugin": the controls render nothing.

import type { SessionChoiceRequest } from '@dsh-raw-agent/core';
import { RouteError, type RawAgentApi, type SessionInfo } from './api.js';

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
      if (this.#listeners.size === 0) this.#stop();
    };
  };

  #set(next: Partial<SessionSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...next };
    for (const l of [...this.#listeners]) l();
  }

  #stop(): void {
    if (this.#timer !== undefined) this.#timers.clear(this.#timer);
    this.#timer = undefined;
  }

  #schedule(): void {
    this.#stop();
    if (this.#listeners.size === 0) return;
    const s = this.#snapshot;
    const v = s.info?.view;
    const active = v !== undefined && (v.state.turn || v.state.process === 'starting' || (v.asks?.length ?? 0) > 0);
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

  /** The user's answer to one pending ask (a click; nothing is answered without one). */
  async answer(askId: string, choiceId: string): Promise<void> {
    this.#set({ error: undefined });
    try {
      const r = await this.#api.answer(this.sessionId, askId, choiceId);
      ++this.#generation;
      const next: Partial<SessionSnapshot> = {};
      if (r.session) next.info = r.session;
      if (!r.ok) next.error = r.error ?? 'that question is no longer open';
      this.#set(next);
    } catch (e) {
      this.#set({ error: String((e as Error)?.message ?? e) });
    }
  }

  /** "Start <displayName>" (D4): spawn without a message, for controls that need a process. */
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
    this.#stop();
  }
}

/** One store per session id, created on first use. */
export class SessionStores {
  readonly #api: RawAgentApi;
  readonly #timers: TimerApi | undefined;
  readonly #stores = new Map<string, SessionControlStore>();
  constructor(api: RawAgentApi, timers?: TimerApi) {
    this.#api = api;
    this.#timers = timers;
  }
  get(sessionId: string): SessionControlStore {
    let s = this.#stores.get(sessionId);
    if (!s) {
      s = new SessionControlStore(sessionId, this.#api, this.#timers);
      this.#stores.set(sessionId, s);
    }
    return s;
  }
  dispose(): void {
    for (const s of this.#stores.values()) s.dispose();
    this.#stores.clear();
  }
}
