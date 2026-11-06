import { describe, expect, it } from 'vitest';
import { AsyncQueue, SentInputTracker } from '@dsh-raw-agent/core';
import { isUuid, uuidv5 } from '@dsh-raw-agent/core/node';

describe('uuidv5', () => {
  it('matches the RFC 4122 test vector', () => {
    expect(uuidv5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
  });
  it('is deterministic and a valid uuid', () => {
    const a = uuidv5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'session-x');
    expect(a).toBe(uuidv5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'session-x'));
    expect(isUuid(a)).toBe(true);
    expect(a[14]).toBe('5');
  });
  it('rejects a bad namespace', () => {
    expect(() => uuidv5('nope', 'x')).toThrow(/namespace/);
  });
});

describe('SentInputTracker', () => {
  it('counts pending inputs and consumes each once', () => {
    const t = new SentInputTracker();
    t.sent('a');
    t.sent('b');
    expect(t.pendingCount).toBe(2);
    expect(t.consume('a')).toBe(true);
    expect(t.consume('a')).toBe(false);
    expect(t.pendingIds).toEqual(['b']);
  });
  it('ignores a re-send of a consumed id', () => {
    const t = new SentInputTracker();
    t.sent('a');
    t.consume('a');
    t.sent('a');
    expect(t.pendingCount).toBe(0);
  });
  it('falls back to consume-all only when no signal was seen', () => {
    const t = new SentInputTracker();
    t.sent('a');
    expect(t.consumeAllIfNoSignal()).toEqual(['a']);
    const u = new SentInputTracker();
    u.sent('a');
    u.sent('b');
    u.consume('a');
    expect(u.consumeAllIfNoSignal()).toEqual([]);
    expect(u.pendingIds).toEqual(['b']);
  });
  it('cancel removes pending ids', () => {
    const t = new SentInputTracker();
    t.sent('a');
    expect(t.cancel(['a', 'zzz'])).toEqual(['a']);
    expect(t.pendingCount).toBe(0);
  });
});

describe('AsyncQueue', () => {
  it('delivers buffered and later items, then ends', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    const got: number[] = [];
    const done = (async () => {
      for await (const n of q) got.push(n);
    })();
    q.push(2);
    q.end();
    q.push(3);
    await done;
    expect(got).toEqual([1, 2]);
  });
  it('allows one consumer only', () => {
    const q = new AsyncQueue<number>();
    q[Symbol.asyncIterator]();
    expect(() => q[Symbol.asyncIterator]()).toThrow(/one consumer/);
  });
});
