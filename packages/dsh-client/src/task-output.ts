// R6.2: reads one background shell's or monitor's output for the output view. While the task runs
// it reads again every 2 s; when the task ends it reads once more (the final output) and stops. No
// React, no DSH: the view subscribes to it.

import type { TaskOutputWire } from './api.js';
import type { TimerApi } from './session-store.js';
import { TASK_OUTPUT_POLL_MS } from './workflow-model.js';

export interface TaskOutputSnapshot {
  output?: TaskOutputWire;
  error?: string;
  /** A read is in flight. */
  reading: boolean;
  /** How many reads finished (tests, and a "read again" hint). */
  reads: number;
}

const defaultTimers: TimerApi = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class TaskOutputReader {
  readonly #read: () => Promise<TaskOutputWire>;
  readonly #timers: TimerApi;
  readonly #pollMs: number;
  #snapshot: TaskOutputSnapshot = { reading: false, reads: 0 };
  readonly #listeners = new Set<() => void>();
  #running: boolean | undefined;
  #timer: unknown;
  #inflight: Promise<void> | undefined;
  /** A read was asked for while one was in flight: read once more after it. */
  #again = false;
  #disposed = false;

  constructor(read: () => Promise<TaskOutputWire>, timers: TimerApi = defaultTimers, pollMs = TASK_OUTPUT_POLL_MS) {
    this.#read = read;
    this.#timers = timers;
    this.#pollMs = pollMs;
  }

  getSnapshot = (): TaskOutputSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #set(next: Partial<TaskOutputSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...next };
    for (const l of [...this.#listeners]) l();
  }

  /**
   * The task's state from the task row. The first call reads at once. Running: poll. A change to
   * ended: one final read, then no more reads until `refresh()`.
   */
  setRunning(running: boolean): void {
    if (this.#disposed) return;
    const before = this.#running;
    this.#running = running;
    if (before === running) return;
    this.#clearTimer();
    void this.refresh();
  }

  /** Read now (a running task keeps polling after it). */
  refresh(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#inflight) {
      this.#again = true;
      return this.#inflight;
    }
    this.#set({ reading: true });
    this.#inflight = this.#read()
      .then(
        (output) => {
          if (!this.#disposed) this.#set({ output, error: undefined });
        },
        (e: unknown) => {
          if (!this.#disposed) this.#set({ error: String((e as Error)?.message ?? e) });
        },
      )
      .finally(() => {
        this.#inflight = undefined;
        if (this.#disposed) return;
        this.#set({ reading: false, reads: this.#snapshot.reads + 1 });
        if (this.#again) {
          this.#again = false;
          void this.refresh();
          return;
        }
        this.#schedule();
      });
    return this.#inflight;
  }

  #schedule(): void {
    this.#clearTimer();
    if (this.#running !== true || this.#disposed) return;
    this.#timer = this.#timers.set(() => {
      this.#timer = undefined;
      void this.refresh();
    }, this.#pollMs);
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) this.#timers.clear(this.#timer);
    this.#timer = undefined;
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearTimer();
    this.#listeners.clear();
  }
}
