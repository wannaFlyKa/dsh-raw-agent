// D45: a host child session (a subagent or teammate) belongs to one of our sessions. Its own view
// asks the Host which one, once, so it can show its row, its Stop and its asks (R6.1).

import type { ChildLinkWire, RawAgentApi } from './api.js';
import type { TimerApi } from './session-store.js';

export interface ChildLinkSnapshot {
  status: 'loading' | 'none' | 'found';
  link?: ChildLinkWire;
}

/**
 * Retry delays after "not a child of ours": the Host learns a child's session id a moment after
 * DSH shows the child, so a quick first miss is retried; then the lookup stops (a Standard
 * session costs three small reads).
 */
export const CHILD_LINK_RETRY_MS: readonly number[] = [1500, 6000];

const defaultTimers: TimerApi = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class ChildLinkStore {
  readonly sessionId: string;
  readonly #api: RawAgentApi;
  readonly #timers: TimerApi;
  readonly #retry: readonly number[];
  #snapshot: ChildLinkSnapshot = { status: 'loading' };
  readonly #listeners = new Set<() => void>();
  #started = false;
  #tries = 0;
  #timer: unknown;
  #disposed = false;

  constructor(sessionId: string, api: RawAgentApi, timers: TimerApi = defaultTimers, retry = CHILD_LINK_RETRY_MS) {
    this.sessionId = sessionId;
    this.#api = api;
    this.#timers = timers;
    this.#retry = retry;
  }

  getSnapshot = (): ChildLinkSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    if (!this.#started) {
      this.#started = true;
      void this.#look();
    }
    return () => this.#listeners.delete(listener);
  };

  async #look(): Promise<void> {
    if (this.#disposed) return;
    let link: ChildLinkWire | undefined;
    try {
      link = await this.#api.childOf(this.sessionId);
    } catch {
      link = undefined;
    }
    if (this.#disposed) return;
    if (link) {
      this.#set({ status: 'found', link });
      return;
    }
    const wait = this.#retry[this.#tries++];
    if (wait === undefined) {
      this.#set({ status: 'none' });
      return;
    }
    this.#timer = this.#timers.set(() => {
      this.#timer = undefined;
      void this.#look();
    }, wait);
  }

  #set(next: ChildLinkSnapshot): void {
    this.#snapshot = next;
    for (const l of [...this.#listeners]) l();
  }

  dispose(): void {
    this.#disposed = true;
    this.#listeners.clear();
    if (this.#timer !== undefined) this.#timers.clear(this.#timer);
  }
}

export class ChildLinks {
  readonly #api: RawAgentApi;
  readonly #timers: TimerApi | undefined;
  readonly #links = new Map<string, ChildLinkStore>();
  constructor(api: RawAgentApi, timers?: TimerApi) {
    this.#api = api;
    this.#timers = timers;
  }
  get(sessionId: string): ChildLinkStore {
    let l = this.#links.get(sessionId);
    if (!l) {
      l = new ChildLinkStore(sessionId, this.#api, this.#timers);
      this.#links.set(sessionId, l);
    }
    return l;
  }
  dispose(): void {
    for (const l of this.#links.values()) l.dispose();
    this.#links.clear();
  }
}
