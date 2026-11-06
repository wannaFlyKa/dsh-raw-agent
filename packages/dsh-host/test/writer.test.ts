/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { TurnLog, WriterAssertError, replayStream, StreamRecorder, type LiveFrame } from '@dsh-raw-agent/dsh-host';

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
  const frames: LiveFrame[] = [];
  let rev = 0;
  let att = 0;
  const log = new TurnLog(
    s.session,
    { emit: (f) => frames.push(f), nextRevision: () => ++rev, nextAttemptId: () => `a${++att}` },
    1,
    { provider: 'p', now: () => 1000 },
  );
  return { log, frames, events: s.events };
}

const binding = { backend: 'p', sessionId: 'x' };

describe('native writer asserts (D17)', () => {
  it('refuses an assistant message outside a step and a result with no written call', () => {
    const { log } = writer();
    expect(() => log.commit({ blocks: [{ type: 'text', text: 'x' }], binding })).toThrow(WriterAssertError);
    log.openStep();
    expect(() => log.result('nope', [], false)).toThrow(/no tool\/call/);
  });

  it('refuses an interrupted message that keeps a tool call, and a second result', () => {
    const { log } = writer();
    log.openStep();
    expect(() =>
      log.commit({ blocks: [{ type: 'tool-call', id: 't', name: 'B', arguments: '{}' }], interrupted: true, binding }),
    ).toThrow(/keeps a tool call/);
    log.commit({ blocks: [{ type: 'tool-call', id: 't', name: 'B', arguments: '{}' }], binding });
    log.result('t', [{ type: 'text', text: 'ok' }], false);
    expect(() => log.result('t', [], false)).toThrow(/second/);
  });

  it('closes a step with the exact repair result for an open call, and refuses writes after close', () => {
    const { log, events } = writer();
    log.openStep();
    log.commit({ blocks: [{ type: 'tool-call', id: 't', name: 'B', arguments: '{}' }], binding });
    log.close();
    expect(events.map((e) => e.type)).toEqual([
      'step/start',
      'assistant/message',
      'tool/call',
      'tool/result',
      'step/end',
    ]);
    expect(events[3]!.data.error.code).toBe('TOOL_OUTCOME_UNKNOWN');
    expect(() => log.openStep()).toThrow(/closed/);
  });

  it('keeps block order when an earlier block had no deltas (empty reasoning, tool call)', () => {
    const { log, events, frames } = writer();
    log.openStep();
    log.delta('text', 1, 'Hi', 1001);
    log.commit({
      blocks: [
        { type: 'reasoning', text: '' },
        { type: 'text', text: 'Hi' },
      ],
      usage: { inputTokens: 1, outputTokens: 1 },
      binding,
    });
    const msg = events[1]!.data;
    const r = replayStream(msg.stream);
    expect(r.blocks).toEqual(msg.message.content);
    expect(r.usage).toEqual(msg.usage);
    expect(r.replayState).toEqual(msg.message.source.replayState);
    expect(frames[0]!.type).toBe('start');
    expect(frames.at(-1)).toMatchObject({ type: 'end', outcome: { kind: 'committed', seq: 1 } });
  });

  it('falls back to a delta-free stream when live deltas do not reproduce the blocks', () => {
    const warns: string[] = [];
    const s = fakeSession();
    const log = new TurnLog(s.session, { emit() {}, nextRevision: () => 1, nextAttemptId: () => 'a' }, 1, {
      provider: 'p',
      warn: (n) => warns.push(n),
    });
    log.openStep();
    log.delta('text', 1, 'a tail slot the mapper dropped', 5);
    log.commit({ blocks: [{ type: 'text', text: 'Kept' }], binding });
    expect(warns[0]).toMatch(/fallback/);
    expect(s.events[1]!.data.message.content).toEqual([{ type: 'text', text: 'Kept' }]);
  });

  it('records compact runs like DSH', () => {
    const r = new StreamRecorder();
    r.push(1, { type: 'text-delta', index: 0, text: 'a' });
    r.push(3, { type: 'text-delta', index: 0, text: 'b' });
    expect(r.snapshot()).toEqual([{ type: 'text-chunks', time0: 1, index: 0, dt: [2], texts: ['a', 'b'] }]);
  });
});
