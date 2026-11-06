// A single-consumer async queue. Used for streaming input to an agent and for backend events.

export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #waiters: Array<(r: IteratorResult<T>) => void> = [];
  #ended = false;
  #iterated = false;

  push(item: T): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.#items.push(item);
  }

  /** No more items. Pending reads finish once the buffer drains. */
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  get ended(): boolean {
    return this.#ended;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.#iterated) throw new Error('AsyncQueue supports one consumer only');
    this.#iterated = true;
    return {
      next: () => {
        if (this.#items.length > 0) return Promise.resolve({ value: this.#items.shift() as T, done: false });
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
      return: () => {
        this.end();
        this.#items.length = 0;
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
