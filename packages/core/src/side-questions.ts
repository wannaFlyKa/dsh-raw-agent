// D54, R7.3: the side-question (`/btw`) history, kept the way Claude Code's terminal app keeps
// it (CLI 2.1.318 binary, class of `btwHistory`): append only non-synthetic answers, keep the
// last 20 exchanges, and start empty after a conversation reset (D70). In memory only (D24).

import type { SideAnswer, SideExchange } from './backend.js';

/** The terminal app's limit (`.slice(-20)`). */
export const SIDE_HISTORY_LIMIT = 20;

export class SideQuestionHistory {
  readonly #limit: number;
  #exchanges: SideExchange[] = [];

  constructor(limit: number = SIDE_HISTORY_LIMIT) {
    this.#limit = Math.max(0, Math.floor(limit));
  }

  /** Oldest first. A copy: pass it to `askSideQuestion` as is. */
  list(): SideExchange[] {
    return this.#exchanges.map((e) => ({ ...e }));
  }

  get size(): number {
    return this.#exchanges.length;
  }

  /**
   * Record one answered question. A synthetic answer (the agent's own "no answer" text) or a
   * cancelled one (`null`) is not kept. Returns whether it was kept.
   */
  record(question: string, answer: SideAnswer | null): boolean {
    if (answer === null || answer.synthetic) return false;
    const e: SideExchange = { question, answer: answer.text };
    if (answer.fallback !== undefined && answer.fallback.content !== '') e.fallbackNotice = answer.fallback.content;
    this.#exchanges = [...this.#exchanges, e].slice(-this.#limit);
    if (this.#limit === 0) this.#exchanges = [];
    return true;
  }

  /** D70: a conversation reset (`/clear`) starts a new history. */
  clear(): void {
    this.#exchanges = [];
  }
}
