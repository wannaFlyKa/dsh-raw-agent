import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SentInputTracker, type BackendEvent } from '@dsh-raw-agent/core';
import { ClaudeMessageMapper, canonicalModel } from '@dsh-raw-agent/backend-claude';

type Ev<T extends BackendEvent['type']> = Extract<BackendEvent, { type: T }>;

function loadFixture(name: string): Record<string, unknown>[] {
  const p = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/**
 * Replay a recording as the live session would see it: each queued input is "sent" just before
 * the CLI reports it queued, and Stop is pressed just before the first aborted message.
 */
function replay(name: string): BackendEvent[] {
  const tracker = new SentInputTracker();
  const mapper = new ClaudeMessageMapper(tracker);
  const out: BackendEvent[] = [];
  let at = 1000;
  for (const m of loadFixture(name)) {
    if (m.type === 'command_lifecycle' && m.state === 'queued') tracker.sent(m.command_uuid as string);
    if (m.type === 'assistant' && m.aborted === true) mapper.noteInterruptRequested();
    out.push(...mapper.map(m, (at += 10)));
  }
  return out;
}

/** The guarantees of §7.2 that the DSH writer relies on. */
function checkGuarantees(events: BackendEvent[]): void {
  const started = new Set<string>();
  const advertised = new Set<string>();
  const messages = new Map<string, Ev<'step-message'>>();
  let turnOpen = false;
  for (const e of events) {
    if (e.type === 'turn-start') {
      expect(turnOpen).toBe(false);
      turnOpen = true;
    }
    if (e.type === 'turn-end') turnOpen = false;
    if (e.type === 'step-start') {
      expect(turnOpen).toBe(true);
      started.add(e.stepId);
    }
    if (e.type === 'step-message') {
      expect(started.has(e.stepId)).toBe(true);
      expect(messages.has(e.stepId)).toBe(false);
      messages.set(e.stepId, e);
      for (const b of e.blocks)
        if (b.type === 'tool-call') {
          expect(advertised.has(b.id)).toBe(false);
          advertised.add(b.id);
        }
    }
    if (e.type === 'tool-result') expect(advertised.has(e.callId)).toBe(true);
  }
  for (const d of events.filter((e): e is Ev<'delta'> => e.type === 'delta')) {
    const m = messages.get(d.stepId);
    if (m === undefined) continue;
    const block = m.blocks[d.blockIndex];
    expect(block).toBeDefined();
    const kind = { text: 'text', reasoning: 'reasoning', 'tool-input': 'tool-call' }[d.kind];
    expect(block!.type).toBe(kind);
  }
}

const summary = (events: BackendEvent[]) =>
  events
    .filter((e) => e.type !== 'delta')
    .map((e) => {
      switch (e.type) {
        case 'step-message':
          return `step-message ${e.stepId} [${e.blocks.map((b) => b.type).join(',')}]${e.interrupted ? ' interrupted' : ''}`;
        case 'turn-start':
          return `turn-start ${e.origin}`;
        case 'turn-end':
          return `turn-end ${e.outcome} ${e.reason ?? ''} pending=${e.pendingInputs}`;
        case 'tool-result':
          return `tool-result ${e.callId}${e.isError ? ' error' : ''}`;
        case 'task-start':
          return `task-start ${e.taskId} ${e.kind}`;
        case 'task-end':
          return `task-end ${e.taskId} ${e.status}`;
        case 'tasks-snapshot':
          return `tasks-snapshot [${e.taskIds.join(',')}]`;
        case 'step-start':
          return `step-start ${e.stepId}`;
        case 'input-consumed':
          return `input-consumed ${e.inputId.slice(-3)}`;
        default:
          return e.type;
      }
    });

describe('mapper on a recorded foreground tool turn', () => {
  const events = replay('foreground-tool.jsonl');

  it('keeps the writer guarantees', () => checkGuarantees(events));

  it('maps the turn in D18 order', () => {
    expect(summary(events)).toMatchInlineSnapshot(`
      [
        "mode",
        "input-consumed 003",
        "session-info",
        "turn-start user",
        "request-start",
        "step-start msg_01",
        "step-message msg_01 [tool-call]",
        "tool-result toolu_01",
        "request-start",
        "step-start msg_02",
        "step-message msg_02 [text]",
        "usage",
        "turn-end completed completed pending=0",
      ]
    `);
  });

  it('carries usage, model, exact arguments and the binding chain id', () => {
    const m = events.find((e): e is Ev<'step-message'> => e.type === 'step-message')!;
    expect(m.model).toBe('claude-sonnet-5-5');
    expect(m.usage?.output).toBeGreaterThan(0);
    expect(m.usage?.input).toBeGreaterThan(0);
    expect(m.lastChainId).toMatch(/^00000000-/);
    const call = m.blocks[0]!;
    expect(call.type).toBe('tool-call');
    if (call.type === 'tool-call') {
      expect(call.name).toBe('Bash');
      expect(JSON.parse(call.arguments).command).toBe('rm probe-perm.txt');
    }
    const r = events.find((e): e is Ev<'tool-result'> => e.type === 'tool-result')!;
    expect(r.content).toEqual([{ type: 'text', text: '(Bash completed with no output)' }]);
    expect(r.chainId).toMatch(/^00000000-/);
  });

  it('streams text deltas with arrival times', () => {
    const d = events.filter((e): e is Ev<'delta'> => e.type === 'delta');
    expect(d.some((x) => x.kind === 'tool-input')).toBe(true);
    expect(
      d
        .filter((x) => x.kind === 'text')
        .map((x) => x.text)
        .join(''),
    ).toBe('removed.');
    expect(d.every((x) => x.at > 1000)).toBe(true);
  });
});

describe('mapper on a recorded background task, interrupt and wake turn', () => {
  const events = replay('bg-interrupt-wake.jsonl');

  it('keeps the writer guarantees', () => checkGuarantees(events));

  it('maps the whole recording', () => {
    expect(summary(events)).toMatchSnapshot();
  });

  it('turns: user, user (interrupted), then a self-started wake turn', () => {
    expect(events.filter((e): e is Ev<'turn-start'> => e.type === 'turn-start').map((e) => e.origin)).toEqual([
      'user',
      'user',
      'self',
    ]);
    expect(events.filter((e): e is Ev<'turn-end'> => e.type === 'turn-end').map((e) => e.outcome)).toEqual([
      'completed',
      'interrupted',
      'completed',
    ]);
  });

  it('the background shell is a task that ends before the wake turn starts', () => {
    const start = events.findIndex((e) => e.type === 'task-start');
    const end = events.findIndex((e) => e.type === 'task-end');
    const wake = events.findIndex((e) => e.type === 'turn-start' && e.origin === 'self');
    expect(start).toBeGreaterThan(-1);
    expect((events[start] as Ev<'task-start'>).kind).toBe('shell');
    expect((events[end] as Ev<'task-end'>).status).toBe('completed');
    expect((events[end] as Ev<'task-end'>).taskId).toBe((events[start] as Ev<'task-start'>).taskId);
    expect(end).toBeGreaterThan(start);
    expect(wake).toBeGreaterThan(end);
  });

  it('the interrupted step keeps its text prefix and is marked interrupted', () => {
    const m = events.filter((e): e is Ev<'step-message'> => e.type === 'step-message').find((e) => e.interrupted)!;
    expect(m.blocks).toHaveLength(1);
    expect(m.blocks[0]!.type).toBe('text');
    expect((m.blocks[0] as { text: string }).text.startsWith('one\ntwo\n')).toBe(true);
  });

  it('never writes the CLI interrupt text as a message', () => {
    expect(JSON.stringify(events)).not.toContain('[Request interrupted by user]');
  });

  it('drops the signed, empty thinking blocks of this recording and copies no signature (D86)', () => {
    const blocks = events.filter((e): e is Ev<'step-message'> => e.type === 'step-message').flatMap((e) => e.blocks);
    const r = blocks.filter((b) => b.type === 'reasoning');
    for (const b of r) {
      expect(Object.keys(b).sort()).toEqual(['text', 'type']);
      expect((b as { text: string }).text).not.toBe('');
    }
  });
});

describe('mapper edge cases', () => {
  const ids = { session_id: 's' };
  const start = (id: string) => ({
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: {
        id,
        model: 'claude-sonnet-5-5',
        usage: { input_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 },
      },
    },
    parent_tool_use_id: null,
    ...ids,
  });
  const blockStart = (index: number, block: object) => ({
    type: 'stream_event',
    event: { type: 'content_block_start', index, content_block: block },
    parent_tool_use_id: null,
  });
  const assistant = (id: string, uuid: string, block: object, extra: object = {}) => ({
    type: 'assistant',
    uuid,
    parent_tool_use_id: null,
    message: { id, model: 'claude-sonnet-5-5', content: [block], usage: { input_tokens: 5, output_tokens: 1 } },
    ...extra,
  });
  const toolResult = (uuid: string, callId: string, content: unknown = 'ok') => ({
    type: 'user',
    uuid,
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content }] },
  });
  const stop = { type: 'stream_event', event: { type: 'message_stop' }, parent_tool_use_id: null };
  const delta = {
    type: 'stream_event',
    event: { type: 'message_delta', usage: { output_tokens: 42 } },
    parent_tool_use_id: null,
  };
  const result = (extra: object = {}) => ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    result: 'x',
    terminal_reason: 'completed',
    ...extra,
  });

  function run(msgs: object[], setup?: (t: SentInputTracker, m: ClaudeMessageMapper) => void) {
    const t = new SentInputTracker();
    const m = new ClaudeMessageMapper(t);
    setup?.(t, m);
    return msgs.flatMap((x) => m.map(x, 1));
  }

  it('buffers a tool result that arrives between two tool_use blocks of one call (D18)', () => {
    const a = { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a' } };
    const b = { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'b' } };
    const ev = run([
      start('m1'),
      blockStart(0, a),
      assistant('m1', 'u1', a),
      toolResult('u2', 't1'),
      blockStart(1, b),
      assistant('m1', 'u3', b),
      delta,
      stop,
      toolResult('u4', 't2'),
      result(),
    ]);
    checkGuarantees(ev);
    expect(summary(ev)).toEqual([
      'turn-start self',
      'step-start m1',
      'step-message m1 [tool-call,tool-call]',
      'tool-result t1',
      'tool-result t2',
      'turn-end completed completed pending=0',
    ]);
    const m = ev.find((e): e is Ev<'step-message'> => e.type === 'step-message')!;
    expect(m.usage).toEqual({ input: 5, output: 42, cacheRead: 7, cacheWrite: 3 });
    expect(m.lastChainId).toBe('u3');
  });

  it('drops a re-sent assistant message and duplicate uuids (D72)', () => {
    const a = { type: 'tool_use', id: 't1', name: 'Bash', input: {} };
    const ev = run([
      start('m1'),
      blockStart(0, a),
      assistant('m1', 'u1', a),
      stop,
      assistant('m1', 'u9', a),
      toolResult('u2', 't1'),
      toolResult('u2', 't1'),
      result(),
    ]);
    expect(ev.filter((e) => e.type === 'step-message')).toHaveLength(1);
    expect(ev.filter((e) => e.type === 'tool-result')).toHaveLength(1);
  });

  it('gives a synthetic or error message its own step with no usage (D69)', () => {
    const ev = run([
      assistant(
        'm1',
        'u1',
        { type: 'text', text: 'Not logged in' },
        {
          error: 'authentication_failed',
          message: { id: 'm1', model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in' }] },
        },
      ),
      result({ subtype: 'success', is_error: true, result: 'Not logged in' }),
    ]);
    const m = ev.find((e): e is Ev<'step-message'> => e.type === 'step-message')!;
    expect(m.synthetic).toBe(true);
    expect(m.error).toBe('authentication_failed');
    expect(m.usage).toBeUndefined();
    expect((ev[1] as Ev<'step-start'>).synthetic).toBe(true);
    const end = ev.find((e): e is Ev<'turn-end'> => e.type === 'turn-end')!;
    expect(end.outcome).toBe('error');
    expect(end.error).toBe('Not logged in');
  });

  it('maps a whole response with no stream as one step (D84)', () => {
    const a = { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } };
    const ev = run([
      {
        ...assistant('m1', 'u1', a),
        message: { id: 'm1', model: 'claude-sonnet-5-5', content: [a], usage: { input_tokens: 3, output_tokens: 9 } },
      },
      toolResult('u2', 't1'),
      result(),
    ]);
    checkGuarantees(ev);
    expect(summary(ev)).toEqual([
      'turn-start self',
      'step-start m1',
      'step-message m1 [tool-call]',
      'tool-result t1',
      'turn-end completed completed pending=0',
    ]);
  });

  it('skips an empty result outside a turn', () => {
    expect(run([{ type: 'result', subtype: 'success', num_turns: 0, result: '', terminal_reason: null }])).toEqual([]);
  });

  it('ends the turn of a local command with an empty result (/compact, M5 live)', () => {
    // CLI 2.1.318 /compact: lifecycle started, status compacting, compact_boundary, then a result with
    // num_turns 0 and result ''. Before the fix the result was skipped and the DSH turn never ended.
    const ev = run(
      [
        { type: 'command_lifecycle', command_uuid: 'c', state: 'started' },
        { type: 'system', subtype: 'status', status: 'compacting' },
        { type: 'system', subtype: 'status', status: null, compact_result: 'success' },
        {
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: { trigger: 'manual', pre_tokens: 9, post_tokens: 3 },
        },
        {
          type: 'result',
          subtype: 'success',
          num_turns: 0,
          result: '',
          user_message_uuids: ['c'],
          terminal_reason: null,
        },
        { type: 'command_lifecycle', command_uuid: 'c', state: 'completed' },
      ],
      (t) => t.sent('c'),
    );
    const types = ev.map((e) => e.type);
    expect(types.filter((x) => x === 'compaction')).toHaveLength(2); // one start, one end
    expect(types).toContain('input-consumed');
    expect(types.indexOf('turn-start')).toBeLessThan(types.indexOf('turn-end'));
    expect(ev.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed', pendingInputs: 0 });
  });

  it('error results carry the CLI text; interrupted only after Stop (D71)', () => {
    const err = run([start('m1'), result({ subtype: 'error_during_execution', is_error: true, errors: ['boom'] })]);
    expect(err.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'error', error: 'boom' });
    const m = new ClaudeMessageMapper(new SentInputTracker());
    m.map(start('m1'), 1);
    m.noteInterruptRequested();
    expect(m.map(result({ subtype: 'error_during_execution', is_error: true }), 1).at(-1)).toMatchObject({
      type: 'turn-end',
      outcome: 'interrupted',
    });
  });

  it('keeps the DSH turn open while a sent input is not consumed (D27)', () => {
    const ev = run(
      [
        { type: 'system', subtype: 'status', status: 'requesting', user_message_uuids: ['a'] },
        { type: 'command_lifecycle', command_uuid: 'a', state: 'started' },
        result({ queued_turn_count: 0 }),
      ],
      (t) => {
        t.sent('a');
        t.sent('b');
      },
    );
    expect(ev.at(-1)).toMatchObject({ type: 'turn-end', pendingInputs: 1 });
    expect(ev.filter((e) => e.type === 'input-consumed')).toEqual([{ type: 'input-consumed', inputId: 'a' }]);
  });

  it('reports a pending input the CLI cancelled (Stop with a queued steer, D25)', () => {
    const ev = run(
      [
        { type: 'system', subtype: 'status', status: 'requesting', user_message_uuids: ['a'] },
        { type: 'command_lifecycle', command_uuid: 'b', state: 'cancelled' },
        { type: 'command_lifecycle', command_uuid: 'b', state: 'cancelled' }, // a repeat says nothing
      ],
      (t) => {
        t.sent('a');
        t.sent('b');
      },
    );
    expect(ev.filter((e) => e.type === 'input-cancelled')).toEqual([{ type: 'input-cancelled', inputId: 'b' }]);
  });

  it('maps the CLI informational line to a notice (model restricted by settings, M1 live)', () => {
    const text =
      'Model "claude-bogus-0-0" is restricted by your organization\'s settings. Using claude-opus-5-5 instead.';
    expect(run([{ type: 'system', subtype: 'informational', content: text, level: 'notice' }])).toEqual([
      { type: 'notice', level: 'notice', text },
    ]);
    expect(run([{ type: 'system', subtype: 'informational', content: '  ' }])).toEqual([]);
  });

  it('maps child messages only as child events, never into the main turn; no job for a foreground task', () => {
    const ev = run([{ ...assistant('m1', 'u1', { type: 'text', text: 'x' }), parent_tool_use_id: 'toolu_x' }]);
    expect(ev.map((e) => e.type)).toEqual(['agent-start', 'step-start', 'step-message']);
    expect(ev.every((e) => e.type === 'agent-start' || ('agent' in e && e.agent.kind === 'child'))).toBe(true);
    expect(
      run([{ type: 'system', subtype: 'task_started', task_id: 't', task_type: 'local_bash', is_backgrounded: false }]),
    ).toEqual([]);
  });

  it('maps tool-result images and other blocks', () => {
    const a = { type: 'tool_use', id: 't1', name: 'Read', input: {} };
    const content = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: 'hi' },
      { type: 'weird' },
    ];
    const ev = run([start('m1'), blockStart(0, a), assistant('m1', 'u1', a), stop, toolResult('u2', 't1', content)]);
    const r = ev.find((e): e is Ev<'tool-result'> => e.type === 'tool-result')!;
    expect(r.content).toEqual([
      { type: 'image', mediaType: 'image/png', base64: 'AAAA' },
      { type: 'text', text: 'hi' },
      { type: 'other', value: { type: 'weird' } },
    ]);
  });

  it('shortens provider model ids (D61)', () => {
    expect(canonicalModel('claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
    expect(canonicalModel('us.anthropic.claude-sonnet-5-5-v1:0')).toBe('claude-sonnet-5-5');
    expect(
      canonicalModel('arn:aws:bedrock:us-west-2:000000000000:inference-profile/us.anthropic.claude-opus-5-5-v1:0'),
    ).toBe('claude-opus-5-5');
  });
});
