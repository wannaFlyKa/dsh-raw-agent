// Reads the usage and context routes for one session (M5, D59). No React, no DSH. It watches the
// session store without making it poll (`observe`), and reads the agent's own context report when
// the figure changes for real: the process came up (turn 1 shows a reading, R8.2), a turn ended,
// a compaction ended, or the conversation was reset (D70). While the usage panel is open it also
// reads the usage route on every summary change. The routes never start a process (rule 9).

import type { ContextAnswerWire, ContextViewWire, RawAgentApi, SessionViewWire, UsageAnswerWire } from './api.js';
import type { SessionControlStore, SessionStores } from './session-store.js';

export interface UsageReadSnapshot {
  usage?: UsageAnswerWire;
  context?: ContextAnswerWire;
  /** A read is in flight. */
  reading: boolean;
  error?: string;
  /** Finished reads (tests). */
  reads: number;
}

interface Seen {
  process: SessionViewWire['state']['process'];
  turn: boolean;
  compacting: boolean;
  /** The summary's context figure was present (a reset empties it, D70). */
  hasContext: boolean;
  /**
   * The summary without its `at` stamp. A route read itself moves `at` (the Host re-stamps the board
   * on every usage-control answer), so keying on `at` re-read the route every channel poll while the
   * panel was open, a loop of control calls (M5 live). Only a changed figure triggers a read.
   */
  key?: string;
}

export class UsageReader {
  readonly sessionId: string;
  readonly #api: RawAgentApi;
  #snapshot: UsageReadSnapshot = { reading: false, reads: 0 };
  readonly #listeners = new Set<() => void>();
  #seen: Seen | undefined;
  #open = 0;
  #inflight = 0;
  #pending: { context?: 'summary' | 'full'; usage?: boolean } = {};
  #busy: Promise<void> | undefined;
  #disposed = false;

  constructor(sessionId: string, api: RawAgentApi) {
    this.sessionId = sessionId;
    this.#api = api;
  }

  getSnapshot = (): UsageReadSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #set(next: Partial<UsageReadSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...next };
    for (const l of [...this.#listeners]) l();
  }

  /** The latest context report read from the route (the pill prefers the newer figure). */
  get report(): ContextViewWire | undefined {
    return this.#snapshot.context?.context;
  }

  /**
   * The panel opened (true) or closed (false). Opening reads the usage and the full breakdown;
   * while open, summary changes read the usage again.
   */
  setOpen(open: boolean): void {
    this.#open = Math.max(0, this.#open + (open ? 1 : -1));
    if (open) void this.read({ usage: true, context: 'full' });
  }

  get open(): boolean {
    return this.#open > 0;
  }

  /** Take a new session view; returns what it asked to read (tests). */
  watch(view: SessionViewWire | undefined): { context?: 'summary' | 'full'; usage?: boolean } {
    if (!view || this.#disposed) return {};
    const s = view.usage;
    const now: Seen = {
      process: view.state.process,
      turn: view.state.turn,
      compacting: s?.compacting === true,
      hasContext: s?.context !== undefined,
      ...(s !== undefined ? { key: summaryKey(s) } : {}),
    };
    const was = this.#seen;
    this.#seen = now;
    if (now.process !== 'running') return {};
    const want: { context?: 'summary' | 'full'; usage?: boolean } = {};
    const detail = this.open ? 'full' : 'summary';
    if (was === undefined || was.process !== 'running')
      want.context = detail; // turn 1 and restarts
    else if (was.turn && !now.turn)
      want.context = detail; // a turn ended
    else if (was.compacting && !now.compacting)
      want.context = detail; // a compaction ended
    else if (was.hasContext && !now.hasContext) want.context = detail; // a reset (D70)
    if (this.open && was !== undefined && now.key !== was.key) want.usage = true;
    if (want.context !== undefined || want.usage) void this.read(want);
    return want;
  }

  /** Read now. Requests while a read runs are merged and run once after it. */
  read(what: { context?: 'summary' | 'full'; usage?: boolean }): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (what.usage) this.#pending.usage = true;
    if (what.context === 'full' || (what.context === 'summary' && this.#pending.context === undefined))
      this.#pending.context = what.context;
    this.#busy ??= this.#drain().finally(() => {
      this.#busy = undefined;
    });
    return this.#busy;
  }

  async #drain(): Promise<void> {
    while (!this.#disposed && (this.#pending.usage || this.#pending.context !== undefined)) {
      const job = this.#pending;
      this.#pending = {};
      this.#inflight++;
      this.#set({ reading: true });
      const next: Partial<UsageReadSnapshot> = {};
      const errors: string[] = [];
      await Promise.all([
        job.usage
          ? this.#api.usage(this.sessionId).then(
              (u) => void (next.usage = u),
              (e: unknown) => void errors.push(String((e as Error)?.message ?? e)),
            )
          : undefined,
        job.context !== undefined
          ? this.#api.context(this.sessionId, job.context).then(
              (c) => {
                // Keep a richer figure we already have when the route only repeats the last one.
                const prior = this.#snapshot.context?.context;
                if (!c.context && prior) c = { ...c, context: prior };
                next.context = c;
              },
              (e: unknown) => void errors.push(String((e as Error)?.message ?? e)),
            )
          : undefined,
      ]);
      this.#inflight--;
      if (this.#disposed) return;
      this.#set({
        ...next,
        reading: this.#inflight > 0,
        reads: this.#snapshot.reads + 1,
        error: errors.length > 0 ? errors.join('; ') : undefined,
      });
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#listeners.clear();
  }
}

/** One reader per session, each watching its session store without making it poll. */
export class UsageReaders {
  readonly #api: RawAgentApi;
  readonly #readers = new Map<string, { reader: UsageReader; off: () => void }>();
  readonly #stores: SessionStores;

  constructor(stores: SessionStores, api: RawAgentApi) {
    this.#stores = stores;
    this.#api = api;
  }

  get(sessionId: string): UsageReader {
    const hit = this.#readers.get(sessionId);
    if (hit) return hit.reader;
    const reader = new UsageReader(sessionId, this.#api);
    const store: SessionControlStore = this.#stores.get(sessionId);
    const sync = () => {
      const snap = store.getSnapshot();
      if (snap.status === 'ready') reader.watch(snap.info?.view);
    };
    const off = store.observe(sync);
    sync();
    this.#readers.set(sessionId, { reader, off });
    return reader;
  }

  dispose(): void {
    for (const { reader, off } of this.#readers.values()) {
      off();
      reader.dispose();
    }
    this.#readers.clear();
  }
}

/** The summary's figures without its `at` stamps (its own and the context's), as a comparable string. */
function summaryKey(s: NonNullable<SessionViewWire['usage']>): string {
  return JSON.stringify(s, (key, value: unknown) => (key === 'at' ? undefined : value));
}
