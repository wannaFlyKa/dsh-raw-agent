// Mapper cases from the M1 writer review: W1 re-sends, D18 parallel calls with early results,
// D84 whole responses and tombstones, D86 empty signed reasoning, D69 synthetic API errors.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SentInputTracker, type BackendEvent } from '@dsh-raw-agent/core';
import { ClaudeMessageMapper } from '@dsh-raw-agent/backend-claude';

type Ev<T extends BackendEvent['type']> = Extract<BackendEvent, { type: T }>;

function load(name: string): Record<string, unknown>[] {
  const p = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function run(name: string): BackendEvent[] {
  const tracker = new SentInputTracker();
  const mapper = new ClaudeMessageMapper(tracker);
  let at = 1000;
  return load(name).flatMap((m) => {
    if (m.type === 'command_lifecycle' && m.state === 'queued') tracker.sent(m.command_uuid as string);
    return mapper.map(m, (at += 5));
  });
}

const summary = (events: BackendEvent[]) =>
  events
    .filter((e) => !['delta', 'session-info', 'mode', 'input-consumed'].includes(e.type))
    .map((e) => {
      if (e.type === 'step-start') return `step-start ${e.stepId}${e.synthetic ? ' synthetic' : ''}`;
      if (e.type === 'step-message')
        return `step-message ${e.stepId} [${e.blocks.map((b) => (b.type === 'tool-call' ? b.id : b.type)).join(',')}]${e.final ? '' : ' cont'}${e.usage ? ' usage' : ''}${e.error ? ` error=${e.error}` : ''}`;
      if (e.type === 'tool-result') return `tool-result ${e.callId}`;
      if (e.type === 'turn-end') return `turn-end ${e.outcome} pending=${e.pendingInputs}`;
      if (e.type === 'superseded') return `superseded ${e.chainIds.join(',')}`;
      return e.type;
    });

/** Every tool-result follows the step-message that advertises its call (§7.2 guarantee). */
function resultsAfterCalls(events: BackendEvent[]): void {
  const advertised = new Set<string>();
  for (const e of events) {
    if (e.type === 'step-message') for (const b of e.blocks) if (b.type === 'tool-call') advertised.add(b.id);
    if (e.type === 'tool-result') expect(advertised.has(e.callId)).toBe(true);
  }
}

describe('W1: re-sent frames (hand-built fixture)', () => {
  const events = run('resend-tool-use.jsonl');
  it('writes the re-sent tool_use once and skips a cumulative frame', () => {
    expect(summary(events)).toEqual([
      'turn-start',
      'step-start msg_01',
      'step-message msg_01 [toolu_01] usage',
      'tool-result toolu_01',
      'step-start msg_02',
      'step-message msg_02 [text,text] usage',
      'turn-end completed pending=0',
    ]);
    const second = events.filter((e): e is Ev<'step-message'> => e.type === 'step-message')[1]!;
    expect(second.blocks).toEqual([
      { type: 'text', text: 'One.' },
      { type: 'text', text: ' Two.' },
    ]);
    resultsAfterCalls(events);
  });
});

describe('D18 + D86: parallel calls with early results and empty signed thinking (recorded)', () => {
  const events = run('parallel-tools-thinking.jsonl');
  it('keeps both calls in one step, buffers their results until the step message, drops the empty thinking', () => {
    const s = summary(events);
    const i = s.indexOf('step-message msg_03 [toolu_02,toolu_03] usage');
    expect(i).toBeGreaterThan(0);
    expect(s.slice(i + 1, i + 3)).toEqual(['tool-result toolu_02', 'tool-result toolu_03']);
    expect(s.filter((x) => x.startsWith('turn-end'))).toEqual([
      'turn-end completed pending=0',
      'turn-end completed pending=0',
    ]);
    const blocks = events.filter((e): e is Ev<'step-message'> => e.type === 'step-message').flatMap((e) => e.blocks);
    expect(blocks.some((b) => b.type === 'reasoning')).toBe(false);
    resultsAfterCalls(events);
  });

  it('a text delta after an empty reasoning block takes position 0', () => {
    const tracker = new SentInputTracker();
    const m = new ClaudeMessageMapper(tracker);
    const se = (event: unknown) => ({ type: 'stream_event', event, parent_tool_use_id: null });
    const out = [
      se({ type: 'message_start', message: { id: 'm', usage: { input_tokens: 1 } } }),
      se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } }),
      {
        type: 'assistant',
        uuid: 'a1',
        message: { id: 'm', content: [{ type: 'thinking', thinking: '', signature: 's' }] },
      },
      se({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi' } }),
      { type: 'assistant', uuid: 'a2', message: { id: 'm', content: [{ type: 'text', text: 'Hi' }] } },
      se({ type: 'message_stop' }),
    ].flatMap((x) => m.map(x));
    const delta = out.find((e): e is Ev<'delta'> => e.type === 'delta')!;
    const msg = out.find((e): e is Ev<'step-message'> => e.type === 'step-message')!;
    expect(delta.blockIndex).toBe(0);
    expect(msg.blocks).toEqual([{ type: 'text', text: 'Hi' }]);
  });
});

describe('D84 + D69: whole responses and a synthetic API error (recorded)', () => {
  const events = run('whole-response-api-error.jsonl');
  it('maps each whole response as its own step and the API error as a synthetic step', () => {
    expect(summary(events)).toEqual([
      'turn-start',
      'step-start msg_01',
      'step-message msg_01 [toolu_01] cont usage',
      'tool-result toolu_01',
      'step-start msg_03', // the signed empty thinking: a step with nothing to write (assistant/attempt)
      'step-start 00000000-0000-4000-8000-000000000009 synthetic', // a synthetic message's id is a uuid
      'step-message 00000000-0000-4000-8000-000000000009 [text] error=invalid_request',
      'turn-end error pending=0',
    ]);
    const end = events.find((e): e is Ev<'turn-end'> => e.type === 'turn-end')!;
    expect(end.error).toMatch(/^API Error:/);
    const synthetic = events.find((e): e is Ev<'step-message'> => e.type === 'step-message' && e.synthetic === true)!;
    expect(synthetic.usage).toBeUndefined(); // D69: no usage
  });
});

describe('D84 (1): stream failure, then the non-streaming fallback (hand-built)', () => {
  const events = run('whole-response-tools.jsonl');
  it('opens one step for the whole response; its frames continue it; usage once', () => {
    expect(summary(events)).toEqual([
      'turn-start',
      'step-start msg_01',
      'step-start msg_02',
      'step-message msg_02 [text] cont usage',
      'step-message msg_02 [toolu_01] cont',
      'tool-result toolu_01',
      'step-start msg_03',
      'step-message msg_03 [text] usage',
      'turn-end completed pending=0',
    ]);
  });
});

describe('D84 (2): tombstones (hand-built)', () => {
  const events = run('tombstone.jsonl');
  it('drops the tombstoned tool use and its buffered result, and reports the uuids', () => {
    expect(summary(events)).toEqual([
      'turn-start',
      'step-start msg_01',
      'superseded 00000000-0000-4000-9000-000000000001',
      'superseded 00000000-0000-4000-9000-000000000002',
      'step-start msg_02',
      'step-message msg_02 [text] usage',
      'turn-end completed pending=0',
    ]);
  });

  it('a tombstone for a message already written only reports it', () => {
    const m = new ClaudeMessageMapper(new SentInputTracker());
    const out = [
      { type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [{ type: 'text', text: 'x' }] } },
      { type: 'tombstone', message: { uuid: 'a1' } },
      { type: 'tombstone', message: {} },
    ].flatMap((x) => m.map(x));
    expect(out.map((e) => e.type)).toEqual(['turn-start', 'step-start', 'step-message', 'superseded']);
  });
});
