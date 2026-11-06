// DSH round-trip test (architecture §10.2): BackendEvents → dsh-host driver and writer inside the
// real, in-process DSH agent loop with JSONL persistence. Every log must pass the v4 relationship
// check, a reload from disk and the embedded-stream replay through DSH's real BlockAssembler,
// and its export must keep the tool calls. Skipped when no installed DSH is found (DSH_PKG or a
// `dsh` on PATH).

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SentInputTracker, type BackendEvent } from '@dsh-raw-agent/core';
import { ClaudeMessageMapper } from '@dsh-raw-agent/backend-claude';
import { createRawAgentHost } from '@dsh-raw-agent/dsh-host';
import {
  checkSession,
  createLoop,
  createStubFactory,
  loadDsh,
  realStreamCheck,
  relationshipCheck,
  type LoopRuntime,
  type ScriptStep,
  type StubScript,
} from '@dsh-raw-agent/testkit';

/* eslint-disable @typescript-eslint/no-explicit-any */
const dsh = await loadDsh();
const MAIN = { kind: 'main' } as const;

function fixture(name: string): Record<string, unknown>[] {
  const p = fileURLToPath(new URL(`../../backend-claude/test/fixtures/${name}`, import.meta.url));
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Map a recording with the real mapper; `cut` marks where Stop was pressed. */
function mapFixture(name: string): { events: BackendEvent[]; cut: number } {
  const tracker = new SentInputTracker();
  const mapper = new ClaudeMessageMapper(tracker);
  const events: BackendEvent[] = [];
  let at = Date.now();
  let cut = -1;
  for (const m of fixture(name)) {
    if (m.type === 'command_lifecycle' && m.state === 'queued') tracker.sent(m.command_uuid as string);
    if (m.type === 'assistant' && m.aborted === true && cut < 0) {
      cut = events.length;
      mapper.noteInterruptRequested();
    }
    events.push(...mapper.map(m, (at += 5)));
  }
  return { events, cut };
}

/** Split at turn-end events: [turn1, turn2, ...] (each slice ends with its turn-end). */
function splitTurns(events: BackendEvent[]): BackendEvent[][] {
  const out: BackendEvent[][] = [[]];
  for (const e of events) {
    out.at(-1)!.push(e);
    if (e.type === 'turn-end') out.push([]);
  }
  return out.filter((t) => t.length > 0);
}

const user = (text: string) => ({
  id: randomUUID(),
  role: 'user' as const,
  content: [{ type: 'text', text }],
  source: { kind: 'user', rpcId: randomUUID() },
});

const idle = (agent: any) => new Promise((r) => setTimeout(r, 40)).then(() => agent.whenIdle());

async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

let rt: LoopRuntime | undefined;
afterEach(async () => {
  await rt?.dispose();
  rt = undefined;
});

async function session(script: StubScript, opts: { jobs?: boolean; skipStreamCheck?: boolean } = {}) {
  rt = await createLoop(dsh!, { jobs: opts.jobs === true });
  const { factory, record } = createStubFactory(script, 'raw-test');
  const host = createRawAgentHost({ factories: [factory] });
  const sessionId = `session-${randomUUID()}`;
  const warnings: unknown[] = [];
  const handle = await rt.ctx.agents.create({
    sessionId,
    meta: { cwd: rt.root },
    agentOptions: { provider: 'raw-test', model: 'settings' },
    setup: async (agentCtx: any) => {
      host.applyAgent(
        agentCtx,
        { backend: 'raw-test' },
        {
          stopGraceMs: 300,
          writer: {
            warn: (n: string, d?: unknown) => warnings.push([n, d]),
            ...(opts.skipStreamCheck ? { skipStreamCheck: true } : {}),
          },
        },
      );
    },
  });
  return { handle, agent: handle.agent, record, sessionId, warnings };
}

/** Events from the first turn/start (the inbox logs a splice for the insert before it). */
const fromTurn = (c: { sequence: string[] }) =>
  c.sequence.slice(c.sequence.findIndex((t) => t.startsWith('turn/start')));

function expectValid(c: Awaited<ReturnType<typeof checkSession>>) {
  expect(c.relationships).toBe('ok');
  expect(c.streamCheck).toBe('ok');
  expect(c.reload).toBe('ok');
  // A reload marks the resumed prefix with session/end-seed; a repair would add tool/result, step/end or turn/end.
  expect(c.reloadAddedTail.filter((t) => t !== 'session/end-seed')).toEqual([]);
}

const textTurn = (text: string): ScriptStep[] => [
  { type: 'turn-start', origin: 'user' },
  { type: 'step-start', agent: MAIN, stepId: 'm1', at: Date.now() },
  { type: 'delta', agent: MAIN, stepId: 'm1', kind: 'text', blockIndex: 0, text: text.slice(0, 4), at: Date.now() },
  { type: 'delta', agent: MAIN, stepId: 'm1', kind: 'text', blockIndex: 0, text: text.slice(4), at: Date.now() + 3 },
  {
    type: 'step-message',
    agent: MAIN,
    stepId: 'm1',
    blocks: [{ type: 'text', text }],
    usage: { input: 3, output: 5, cacheRead: 100, cacheWrite: 20 },
    model: 'test-model',
    lastChainId: 'chain-1',
    final: true,
  },
  { type: 'turn-end', agent: MAIN, outcome: 'completed', pendingInputs: 0 },
];

describe.skipIf(dsh === undefined)(`DSH round trip (installed DSH ${dsh?.version})`, () => {
  it('text: one streamed step with usage and the binding in native fields', async () => {
    const s = await session({ onSend: [textTurn('Hello from the agent.')] });
    s.agent.followup(user('hi'));
    await idle(s.agent);
    const c = await checkSession(dsh!, rt!, s.handle, s.sessionId);
    expectValid(c);
    expect(rt!.stray).toEqual([]);
    expect(fromTurn(c)).toEqual([
      'turn/start 1',
      'agent/inbox/spliced',
      'user/message',
      'step/start 1',
      'assistant/message',
      'step/end 1',
      'turn/end "completed"',
    ]);
    const msg = c.events.find((e: any) => e.type === 'assistant/message');
    expect(msg.data.usage).toEqual({ inputTokens: 3, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20 });
    expect(msg.data.message.source.rawAgent).toMatchObject({
      backend: 'raw-test',
      sessionId: 'stub-session-1',
      lastChainId: 'chain-1',
    });
    expect(msg.data.message.source.replayState).toEqual({ response: msg.data.message.source.rawAgent });
    expect(s.record.sent).toHaveLength(1);
    expect(c.exportMarkdown).toContain('Hello from the agent.');
  });

  it('one tool call and result (recorded fixture through the real mapper)', async () => {
    const turns = splitTurns(mapFixture('foreground-tool.jsonl').events);
    expect(turns).toHaveLength(1);
    const s = await session({ onSend: [turns[0]!] });
    s.agent.followup(user('run a command'));
    await idle(s.agent);
    const c = await checkSession(dsh!, rt!, s.handle, s.sessionId);
    expectValid(c);
    expect(rt!.stray).toEqual([]);
    expect(fromTurn(c)).toEqual([
      'turn/start 1',
      'agent/inbox/spliced',
      'user/message',
      'step/start 1',
      'assistant/message',
      'tool/call',
      'tool/result',
      'step/end 1',
      'step/start 2',
      'assistant/message',
      'step/end 2',
      'turn/end "completed"',
    ]);
    const call = c.events.find((e: any) => e.type === 'tool/call');
    expect(call.data.name).toBe('Bash');
    expect(c.exportMarkdown).toContain('Bash');
    expect(s.warnings).toEqual([]);
  });

  it('interrupt mid-tool: the agent result for the running tool, then turn/end aborted', async () => {
    const s = await session({
      onSend: [
        [
          { type: 'turn-start', origin: 'user' },
          { type: 'step-start', agent: MAIN, stepId: 'm1', at: Date.now() },
          { type: 'delta', agent: MAIN, stepId: 'm1', kind: 'text', blockIndex: 0, text: 'Sleeping.', at: Date.now() },
          {
            type: 'delta',
            agent: MAIN,
            stepId: 'm1',
            kind: 'tool-input',
            blockIndex: 1,
            text: '{"command"',
            at: Date.now(),
          },
          {
            type: 'step-message',
            agent: MAIN,
            stepId: 'm1',
            blocks: [
              { type: 'text', text: 'Sleeping.' },
              { type: 'tool-call', id: 'toolu_1', name: 'Bash', arguments: '{"command":"sleep 100"}' },
            ],
            usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            final: true,
          },
        ],
      ],
      onInterrupt: [
        {
          type: 'tool-result',
          agent: MAIN,
          callId: 'toolu_1',
          isError: true,
          chainId: 'c2',
          content: [{ type: 'text', text: 'Interrupted' }],
        },
        { type: 'turn-end', agent: MAIN, outcome: 'interrupted', pendingInputs: 0 },
      ],
    });
    s.agent.followup(user('sleep'));
    await until(() => s.agent.session.snapshotEvents().some((e: any) => e.type === 'tool/call'));
    s.agent.cancel({ kind: 'user' }, { keepInbox: true });
    await idle(s.agent);
    expect(s.record.interrupts).toBe(1);
    expect(s.record.disposed).toBe(0); // Stop never ends the process (rule 6)
    const c = await checkSession(dsh!, rt!, s.handle, s.sessionId);
    expectValid(c);
    expect(fromTurn(c).slice(3)).toEqual([
      'step/start 1',
      'assistant/message',
      'tool/call',
      'tool/result',
      'step/end 1',
      'turn/end "aborted"',
    ]);
    const result = c.events.find((e: any) => e.type === 'tool/result');
    expect(result.data.message.content).toEqual([{ type: 'text', text: 'Interrupted' }]);
  });

  it('interrupt mid-tool with no agent result: DSH repair result, then step/end', async () => {
    const s = await session({
      onSend: [
        [
          { type: 'turn-start', origin: 'user' },
          { type: 'step-start', agent: MAIN, stepId: 'm1', at: Date.now() },
          {
            type: 'step-message',
            agent: MAIN,
            stepId: 'm1',
            blocks: [{ type: 'tool-call', id: 'toolu_9', name: 'Bash', arguments: '{}' }],
            final: true,
          },
        ],
      ],
      onInterrupt: [], // the agent never answers: the driver closes the turn after the grace time
    });
    s.agent.followup(user('sleep'));
    await until(() => s.agent.session.snapshotEvents().some((e: any) => e.type === 'tool/call'));
    s.agent.cancel({ kind: 'user' }, { keepInbox: true });
    await idle(s.agent);
    const c = await checkSession(dsh!, rt!, s.handle, s.sessionId);
    expectValid(c);
    const result = c.events.find((e: any) => e.type === 'tool/result');
    expect(result.data.error.code).toBe('TOOL_OUTCOME_UNKNOWN');
    expect(c.sequence.at(-1)).toBe('turn/end "aborted"');
  });

  it('interrupt before anything visible: assistant/attempt, no message', async () => {
    const s = await session({
      onSend: [
        [
          { type: 'turn-start', origin: 'user' },
          { type: 'step-start', agent: MAIN, stepId: 'm1', at: Date.now() },
        ],
      ],
      onInterrupt: [{ type: 'turn-end', agent: MAIN, outcome: 'interrupted', pendingInputs: 0 }],
    });
    s.agent.followup(user('hi'));
    await until(() => s.agent.session.snapshotEvents().some((e: any) => e.type === 'step/start'));
    s.agent.cancel({ kind: 'user' }, { keepInbox: true });
    await idle(s.agent);
    const c = await checkSession(dsh!, rt!, s.handle, s.sessionId);
    expectValid(c);
    expect(fromTurn(c).slice(3)).toEqual(['step/start 1', 'assistant/attempt', 'step/end 1', 'turn/end "aborted"']);
  });

  it('background shell → job with a pending wait; Stop mid-text; the CLI wake turn (recorded fixture)', async () => {
    const { events, cut } = mapFixture('bg-interrupt-wake.jsonl');
    const turns = splitTurns(events);
    expect(turns).toHaveLength(3);
    const t1 = turns[0]!;
    const t2start = t1.length;
    const beforeStop = events.slice(t2start, cut);
    const t2rest = events.slice(cut, t2start + turns[1]!.length);
    const rest = events.slice(t2start + turns[1]!.length);
    const s = await session({ onSend: [t1, beforeStop], onInterrupt: t2rest }, { jobs: true });

    // Turn 1: Bash with run_in_background. The DSH turn ends; the task is a job.
    s.agent.followup(user('start a background sleep'));
    await idle(s.agent);
    const jobs = rt!.ctx.jobs.list(s.sessionId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('running');
    expect(s.agent.status).toBe('idle'); // the session is free (rule 7)

    // Turn 2: Stop while text streams. interrupt() only; the task keeps running.
    s.agent.followup(user('write a long poem'));
    await until(() => s.agent.session.snapshotEvents().filter((e: any) => e.type === 'step/start').length >= 3);
    s.agent.cancel({ kind: 'user' }, { keepInbox: true });
    await idle(s.agent);
    expect(s.record.interrupts).toBe(1);
    expect(rt!.ctx.jobs.list(s.sessionId)[0].status).toBe('running');

    // The task ends; the CLI starts a turn by itself → a wake turn with no user/message.
    let settled: any;
    rt!.ctx.jobs.events.subscribe({}, (e: any) => {
      if (e.type === 'settled') settled = e;
    });
    await s.record.emit(rest);
    await until(() => s.agent.session.snapshotEvents().filter((e: any) => e.type === 'turn/end').length === 3);
    await idle(s.agent);
    expect(settled?.job.status).toBe('completed');
    expect(settled?.awaited).toBe(true); // our pending wait: tool-jobs would stay silent (D47)

    const c = await checkSession(dsh!, rt!, s.handle, s.sessionId);
    expectValid(c);
    expect(rt!.stray).toEqual([]);
    const ends = c.events.filter((e: any) => e.type === 'turn/end').map((e: any) => e.data.reason.kind);
    expect(ends).toEqual(['completed', 'aborted', 'completed']);
    expect(c.events.filter((e: any) => e.type === 'user/message')).toHaveLength(2);
    const wakeTurn = c.events.slice(c.events.findLastIndex((e: any) => e.type === 'turn/start'));
    expect(wakeTurn.map((e: any) => e.type)).toEqual([
      'turn/start',
      'agent/inbox/spliced',
      'step/start',
      'assistant/message',
      'step/end',
      'turn/end',
    ]);
    const interrupted = c.events.find((e: any) => e.type === 'assistant/message' && e.data.interrupted === true);
    expect(interrupted).toBeDefined();
    expect(c.events.some((e: any) => e.type === 'job/registered')).toBe(true);
  });

  it('a queued follow-up runs as the next turn (D3)', async () => {
    const s = await session({ onSend: [[{ type: 'wait', ms: 80 }, ...textTurn('first')], textTurn('second')] });
    s.agent.followup(user('one'));
    await new Promise((r) => setTimeout(r, 20));
    s.agent.followup(user('two'));
    await until(() => s.agent.session.snapshotEvents().filter((e: any) => e.type === 'turn/end').length === 2);
    await idle(s.agent);
    const c = await checkSession(dsh!, rt!, s.handle, s.sessionId);
    expectValid(c);
    expect(s.record.sent.map((i) => i.parts)).toHaveLength(2);
  });

  it('D3: a failed re-wake send puts the queued message back; it is never lost (M1 verify 2)', async () => {
    const s = await session({ onSend: [[{ type: 'wait', ms: 80 }, ...textTurn('first')], textTurn('second')] });
    s.agent.followup(user('one'));
    await new Promise((r) => setTimeout(r, 20));
    const two = user('two');
    s.agent.followup(two);
    const orig = s.agent.send.bind(s.agent);
    let failed = 0;
    s.agent.send = (m: unknown, lane: string, wake?: boolean) => {
      if (lane === 'next-turn' && wake === true && failed === 0) {
        failed++;
        throw new Error('send refused');
      }
      return orig(m, lane, wake);
    };
    await until(() => failed === 1);
    await idle(s.agent);
    expect(s.agent.inbox.nextTurn.map((m: any) => m.id)).toEqual([two.id]);
    const c = await checkSession(dsh!, rt!, s.handle, s.sessionId);
    expect(c.relationships).toBe('ok');
    expect(c.streamCheck).toBe('ok');
    expect(c.reload).toBe('ok');
    // DSH's reload takes the still-queued message up itself (a splice); nothing is repaired.
    expect(c.reloadAddedTail.filter((t) => t !== 'session/end-seed' && t !== 'agent/inbox/spliced')).toEqual([]);
  });

  it('a non-human claimed message is dropped, never sent (D22)', async () => {
    const s = await session({ onSend: [] });
    s.agent.followup({ ...user('notice'), source: { kind: 'schedule', form: 'notice', summary: 'x' } } as any);
    await idle(s.agent);
    expect(s.record.sent).toHaveLength(0);
    expect(s.record.opened).toHaveLength(0); // no process for nothing (rule 9)
    const c = await checkSession(dsh!, rt!, s.handle, s.sessionId);
    expectValid(c);
  });

  it('negative: the real checks catch a mismatched stream and an unadvertised tool/call (#57)', () => {
    const msg = (content: unknown) => ({
      type: 'assistant/message',
      seq: 3,
      data: {
        turn: 1,
        step: 1,
        message: { id: 'm', role: 'assistant', content, source: { kind: 'model', provider: 'p', model: 'm' } },
        stream: [
          { type: 'chunk', time: 1, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'B' } } },
        ],
      },
    });
    expect(realStreamCheck(dsh!, [msg([{ type: 'text', text: 'A' }])])).toMatch(/content disagrees/);
    const ev = (type: string, data: unknown, seq: number) => ({ type, data, seq, time: 0 });
    const bad = [
      ev('turn/start', { turn: 1 }, 0),
      ev('step/start', { turn: 1, step: 1 }, 1),
      ev('tool/call', { turn: 1, step: 1, callId: 't', name: 'Bash', arguments: '{}' }, 2),
    ];
    expect(relationshipCheck(dsh!, 's', bad)).not.toBe('ok');
  });
});
