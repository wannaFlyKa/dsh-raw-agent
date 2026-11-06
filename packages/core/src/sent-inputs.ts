// Sent-input tracking (D27). Pure logic shared by backends and the DSH layer.
//
// An input is "consumed" once the agent has taken it into a turn. A DSH turn may end only when
// every input sent during it is consumed. Cancelled inputs (D25) leave the map at once.

export class SentInputTracker {
  readonly #pending = new Set<string>();
  readonly #consumed = new Set<string>();
  /** True once the agent has sent any per-input consumption signal in this process. */
  #sawSignal = false;

  /** Record a sent input. A repeat of a known id is ignored. */
  sent(id: string): void {
    if (this.#consumed.has(id)) return;
    this.#pending.add(id);
  }

  /** Mark one input consumed. Returns true only the first time an id that was pending is consumed. */
  consume(id: string): boolean {
    this.#sawSignal = true;
    if (!this.#pending.delete(id)) return false;
    this.#consumed.add(id);
    return true;
  }

  /** Inputs the agent dropped (interrupt with cancelQueued, D25). Returns the ids that were pending. */
  cancel(ids: Iterable<string>): string[] {
    const out: string[] = [];
    for (const id of ids) if (this.#pending.delete(id)) out.push(id);
    return out;
  }

  /**
   * Fallback (D27): if the agent never sent a consumption signal in this process, a turn end
   * with nothing queued marks every pending input consumed. Returns the ids it consumed.
   */
  consumeAllIfNoSignal(): string[] {
    if (this.#sawSignal) return [];
    const ids = [...this.#pending];
    for (const id of ids) {
      this.#pending.delete(id);
      this.#consumed.add(id);
    }
    return ids;
  }

  /** True for an id we sent, pending or consumed. */
  wasSent(id: string): boolean {
    return this.#pending.has(id) || this.#consumed.has(id);
  }

  isPending(id: string): boolean {
    return this.#pending.has(id);
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  get pendingIds(): string[] {
    return [...this.#pending];
  }
}
