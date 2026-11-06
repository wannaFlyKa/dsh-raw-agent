/* eslint-disable @typescript-eslint/no-explicit-any */
// Writer fixes from the spike review: W1 (tool ids checked before any append), W2 / D17 (h) (the
// asserting inbox splice and the steer claim), D84 (several messages in one step).

import { describe, expect, it } from 'vitest';
import { TurnLog, WriterAssertError, spliceInbox } from '@dsh-raw-agent/dsh-host';

function fakeSession() {
  const events: Array<{ type: string; data: any; seq: number }> = [];
  return {
    events,
    session: {
      id: 's1',
      get seq() {
        return events.length - 1;
      },
      header: {},
      append(type: string, data: unknown) {
        events.push({ type, data, seq: events.length });
        return { seq: events.length - 1 };
      },
      snapshotEvents: () => events as never,
    },
  };
}

function writer() {
  const s = fakeSession();
  const warnings: unknown[] = [];
  const log = new TurnLog(s.session, { emit: () => {}, nextRevision: () => 1, nextAttemptId: () => 'a' }, 1, {
    provider: 'p',
    now: () => 1000,
    warn: (n, d) => warnings.push([n, d]),
  });
  return { log, events: s.events, session: s.session, warnings };
}

const binding = { backend: 'p', sessionId: 'x' };
const call = (id: string, args = '{}') => ({ type: 'tool-call' as const, id, name: 'Bash', arguments: args });

describe('W1: duplicate tool-call ids are checked before anything is appended', () => {
  it('drops an exact repeat inside one message and writes one tool/call', () => {
    const w = writer();
    w.log.openStep();
    const { calls } = w.log.commit({ blocks: [call('t1'), call('t1')], binding });
    expect(calls).toEqual(['t1']);
    const msg = w.events.find((e) => e.type === 'assistant/message')!;
    expect(msg.data.message.content).toEqual([call('t1')]);
    expect(w.events.filter((e) => e.type === 'tool/call')).toHaveLength(1);
    expect(w.warnings).toHaveLength(1);
  });

  it('refuses a conflicting repeat with nothing appended', () => {
    const w = writer();
    w.log.openStep();
    const before = w.events.length;
    expect(() => w.log.commit({ blocks: [call('t1', '{"a":1}'), call('t1', '{"a":2}')], binding })).toThrow(
      WriterAssertError,
    );
    expect(w.events.length).toBe(before);
  });
});

describe('D84: further messages of one step', () => {
  it('writes a continued message with its own stream and skips repeats of written calls', () => {
    const w = writer();
    w.log.openStep();
    w.log.commit({ blocks: [{ type: 'text', text: 'a' }], binding });
    expect(() => w.log.commit({ blocks: [call('t1')], binding })).toThrow(/second/);
    expect(w.log.commit({ blocks: [call('t1')], binding, continued: true }).calls).toEqual(['t1']);
    expect(w.log.commit({ blocks: [call('t1')], binding, continued: true }).calls).toEqual([]);
    const msgs = w.events.filter((e) => e.type === 'assistant/message');
    expect(msgs).toHaveLength(2);
    expect(msgs[1]!.data.stream.length).toBeGreaterThan(0);
  });
});

describe('W2 / D17 (h): the asserting inbox splice', () => {
  const m = (id: string) => ({ id, role: 'user' as const, content: [], source: { kind: 'user' } });

  it('appends a valid splice with no outcome', () => {
    const s = fakeSession();
    spliceInbox(
      s.session,
      { nextTurn: [m('a')], nextStep: [] },
      { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
    );
    expect(s.events[0]).toMatchObject({
      type: 'agent/inbox/spliced',
      data: { target: 'next-turn', start: 0, removedCount: 1 },
    });
    expect(s.events[0]!.data.outcome).toBeUndefined();
  });

  it('refuses an out-of-range start or count and a duplicate pending id', () => {
    const s = fakeSession();
    const inbox = { nextTurn: [m('a')], nextStep: [m('b')] };
    expect(() => spliceInbox(s.session, inbox, { target: 'next-turn', start: 2, inserted: [] })).toThrow(/start/);
    expect(() =>
      spliceInbox(s.session, inbox, { target: 'next-step', start: 0, removedCount: 2, inserted: [] }),
    ).toThrow(/removedCount/);
    expect(() => spliceInbox(s.session, inbox, { target: 'next-turn', start: 1, inserted: [m('b')] })).toThrow(
      /pending/,
    );
    expect(() => spliceInbox(s.session, inbox, { target: 'x' as never, start: 0, inserted: [] })).toThrow(/target/);
    expect(s.events).toHaveLength(0);
  });

  it('claims a pending steer between steps: splice then the unchanged user/message', () => {
    const w = writer();
    const steer = m('s1');
    const inbox = { nextTurn: [], nextStep: [m('x'), steer] };
    expect(w.log.claim('s1', inbox)).toBe(true);
    expect(w.events.map((e) => e.type)).toEqual(['agent/inbox/spliced', 'user/message']);
    expect(w.events[0]!.data).toEqual({ target: 'next-step', start: 1, removedCount: 1, inserted: [] });
    expect(w.events[1]!.data).toBe(steer);
    expect(w.log.claim('nope', inbox)).toBe(false);
    w.log.openStep();
    expect(() => w.log.claim('x', inbox)).toThrow(/open step/);
  });
});
