// M1 host-lifecycle round trips (architecture §10.2): recorded and hand-built wire fixtures through
// the real mapper → the dsh-host driver and writer → the real in-process DSH loop with JSONL
// persistence. Each log passes the real v4 relationship check, a reload from disk and the
// embedded-stream replay through DSH's BlockAssembler. Also: steer and queue mid-turn (D27), Stop
// with a queued steer (D25), a crash mid-turn (D8, D74), and an agent eviction with the Host
// registry (D87). Skipped when no installed DSH is found.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SentInputTracker, type BackendEvent } from '@dsh-raw-agent/core';
import { ClaudeMessageMapper } from '@dsh-raw-agent/backend-claude';
import { SessionRegistry, createRawAgentHost } from '@dsh-raw-agent/dsh-host';
import {
  checkSession,
  createLoop,
  createStubFactory,
  loadDsh,
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

/** Map a recording with the real mapper. `marks[i]` is the event count before the i-th queued input. */
function mapFixture(name: string): { events: BackendEvent[]; queued: string[]; marks: number[] } {
  const tracker = new SentInputTracker();
  const mapper = new ClaudeMessageMapper(tracker);
  const events: BackendEvent[] = [];
  const queued: string[] = [];
  const marks: number[] = [];
  let at = Date.now();
  for (const m of fixture(name)) {
    if (m.type === 'command_lifecycle' && m.state === 'queued') {
      tracker.sent(m.command_uuid as string);
      queued.push(m.command_uuid as string);
      marks.push(events.length);
    }
    events.push(...mapper.map(m, (at += 5)));
  }
  return { events, queued, marks };
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

interface SessionOpts {
  jobs?: boolean;
  registry?: SessionRegistry;
  sessionId?: string;
  factory?: ReturnType<typeof createStubFactory>;
}

async function session(script: StubScript, opts: SessionOpts = {}) {
  rt ??= await createLoop(dsh!, { jobs: opts.jobs === true });
  const stub = opts.factory ?? createStubFactory(script, 'raw-test');
  const host = createRawAgentHost({ factories: [stub.factory] });
  const sessionId = opts.sessionId ?? `session-${randomUUID()}`;
  const warnings: unknown[] = [];
  const mounts: any[] = [];
  const setup = async (agentCtx: any) => {
    mounts.push(
      host.applyAgent(
        agentCtx,
        { backend: 'raw-test' },
        {
          stopGraceMs: 300,
          writer: { warn: (n: string, d?: unknown) => warnings.push([n, d]) },
          ...(opts.registry ? { registry: opts.registry } : {}),
        },
      ),
    );
  };
  const handle = await rt.ctx.agents.create({
    sessionId,
    meta: { cwd: rt.root },
    agentOptions: { provider: 'raw-test', model: 'settings' },
    setup,
  });
  return { handle, agent: handle.agent, record: stub.record, stub, sessionId, warnings, mounts, setup };
}

const events = (agent: any) => agent.session.snapshotEvents();
const types = (agent: any) => events(agent).map((e: any) => e.type);

function expectValid(c: Awaited<ReturnType<typeof checkSession>>) {
  expect(c.relationships).toBe('ok');
  expect(c.streamCheck).toBe('ok');
  expect(c.reload).toBe('ok');
  expect(c.reloadAddedTail.filter((t) => t !== 'session/end-seed')).toEqual([]);
}

/** Run one recorded fixture as one host turn and check the log. */
async function fixtureTurn(name: string, prompt: string) {
  const { events: evs } = mapFixture(name);
  const s = await session({ onSend: [evs] });
  s.agent.followup(user(prompt));
  await idle(s.agent);
  const c = await checkSession(dsh!, rt!, s.handle, s.sessionId);
  expect(rt!.stray).toEqual([]);
  return { s, c };
}

describe.skipIf(dsh === undefined)(`M1 host lifecycle round trip (installed DSH ${dsh?.version})`, () => {
  it('D18 + D86: parallel calls with early results and empty signed thinking (recorded)', async () => {
    const { events: evs } = mapFixture('parallel-tools-thinking.jsonl');
    const cut = evs.findIndex((e) => e.type === 'turn-end') + 1;
    const s = await session({ onSend: [evs.slice(0, cut), evs.slice(cut)] });
    s.agent.followup(user('ask me a question'));
    await idle(s.agent);
    s.agent.followup(user('make a plan'));
    await idle(s.agent);
    const c = await checkSession(dsh!, rt!, s.handle, s.sessionId);
    expectValid(c);
    expect(s.warnings).toEqual([]);
    const two = c.events.find(
      (e: any) =>
        e.type === 'assistant/message' &&
        e.data.message.content.filter((b: any) => b.type === 'tool-call').length === 2,
    );
    expect(two).toBeDefined();
    expect(two.data.message.content.some((b: any) => b.type === 'reasoning')).toBe(false);
    const i = c.events.indexOf(two);
    expect(c.events.slice(i + 1, i + 5).map((e: any) => e.type)).toEqual([
      'tool/call',
      'tool/call',
      'tool/result',
      'tool/result',
    ]);
    expect(c.exportMarkdown).toContain('ToolSearch');
  });

  it('W1: a re-sent tool_use frame and a cumulative frame are written once (hand-built)', async () => {
    const { s, c } = await fixtureTurn('resend-tool-use.jsonl', 'list files');
    expectValid(c);
    expect(c.events.filter((e: any) => e.type === 'tool/call')).toHaveLength(1);
    const last = c.events.filter((e: any) => e.type === 'assistant/message').at(-1);
    expect(last.data.message.content).toEqual([
      { type: 'text', text: 'One.' },
      { type: 'text', text: ' Two.' },
    ]);
    expect(s.warnings).toEqual([]);
  });

  it('D84 + D69: whole responses, an empty signed thinking frame, then a synthetic API error (recorded)', async () => {
    const { c } = await fixtureTurn('whole-response-api-error.jsonl', 'say hello');
    expectValid(c);
    const end = c.events.findLast((e: any) => e.type === 'turn/end');
    expect(end.data.reason.kind).toBe('error');
    expect(JSON.stringify(end.data.reason)).toContain('API Error');
    const msgs = c.events.filter((e: any) => e.type === 'assistant/message');
    const err = msgs.at(-1);
    expect(err.data.message.content[0].text).toMatch(/^API Error/);
    expect(err.data.usage).toBeUndefined(); // D69: no usage, meters unchanged
    expect(msgs[0].data.usage).toBeDefined(); // the whole response carries final usage (D84)
    expect(c.events.some((e: any) => e.type === 'assistant/attempt')).toBe(true); // the empty thinking step
  });

  it('D84 (1): a failed stream, then the non-streaming fallback with a tool call (hand-built)', async () => {
    const { s, c } = await fixtureTurn('whole-response-tools.jsonl', 'look around');
    expectValid(c);
    const seq = c.sequence.slice(c.sequence.indexOf('user/message') + 1);
    expect(seq).toEqual([
      'step/start 1',
      'assistant/attempt', // the stale streamed step (D18)
      'step/end 1',
      'step/start 2',
      'assistant/message',
      'assistant/message', // the second frame of the same whole response (D68 shape)
      'tool/call',
      'tool/result',
      'step/end 2',
      'step/start 3',
      'assistant/message',
      'step/end 3',
      'turn/end "completed"',
    ]);
    expect(s.warnings).toEqual([]);
  });

  it('D84 (2): a tombstoned attempt leaves no unresolved call (hand-built)', async () => {
    const { c } = await fixtureTurn('tombstone.jsonl', 'retry');
    expectValid(c);
    expect(c.events.some((e: any) => e.type === 'tool/call')).toBe(false);
    expect(c.events.filter((e: any) => e.type === 'assistant/message')).toHaveLength(1);
  });

  it('D27: a steer during a tool is sent at once and claimed at the next step boundary (recorded)', async () => {
    const { events: evs, queued, marks } = mapFixture('steer-during-tool.jsonl');
    expect(queued).toHaveLength(2);
    const s = await session({ onSend: [evs.slice(0, marks[1]), evs.slice(marks[1])], inputAliases: queued });
    s.agent.followup(user('run a short command'));
    await until(() => types(s.agent).includes('tool/call'));
    const steer = user('Also add the word STEERED');
    s.agent.steer(steer);
    await idle(s.agent);
    expect(s.record.sent).toHaveLength(2); // sent once, at once (never again at a claim)
    expect(s.agent.inbox.nextStep).toHaveLength(0);
    const c = await checkSession(dsh!, rt!, s.handle, s.sessionId);
    expectValid(c);
    const t = c.events.map((e: any) => e.type);
    expect(t.filter((x: string) => x === 'turn/start')).toHaveLength(1); // one host turn
    const userMsgs = c.events.filter((e: any) => e.type === 'user/message');
    expect(userMsgs.map((e: any) => e.data.id)).toEqual([expect.any(String), steer.id]);
    const steerAt = c.events.indexOf(userMsgs[1]);
    expect(c.events[steerAt - 1].type).toBe('agent/inbox/spliced'); // driver claim, no outcome
    expect(c.events[steerAt - 1].data.outcome).toBeUndefined();
    expect(c.events[steerAt - 2].type).toBe('step/end'); // between steps
    expect(c.events[steerAt + 1].type).toBe('step/start');
    expect(c.exportMarkdown).toContain('STEERED');
  });

  it('D25: Stop with a queued steer cancels it, removes it from the inbox and returns its text', async () => {
    const registry = new SessionRegistry();
    const s = await session(
      {
        cancelQueued: true,
        onSend: [
          [
            { type: 'turn-start', origin: 'user' },
            { type: 'step-start', agent: MAIN, stepId: 'm1', at: Date.now() },
            {
              type: 'step-message',
              agent: MAIN,
              stepId: 'm1',
              blocks: [{ type: 'tool-call', id: 'toolu_1', name: 'Bash', arguments: '{"command":"sleep 100"}' }],
              final: true,
            },
          ],
          [], // the CLI queues the steer behind the running tool
          [
            { type: 'turn-start', origin: 'user' },
            { type: 'step-start', agent: MAIN, stepId: 'm3', at: Date.now() },
            { type: 'step-message', agent: MAIN, stepId: 'm3', blocks: [{ type: 'text', text: 'ok' }], final: true },
            { type: 'turn-end', agent: MAIN, outcome: 'completed', pendingInputs: 0 },
          ],
        ],
        onInterrupt: [
          {
            type: 'tool-result',
            agent: MAIN,
            callId: 'toolu_1',
            isError: true,
            content: [{ type: 'text', text: 'Interrupted' }],
          },
          { type: 'turn-end', agent: MAIN, outcome: 'interrupted', pendingInputs: 0 },
        ],
      },
      { registry },
    );
    s.agent.followup(user('sleep'));
    await until(() => types(s.agent).includes('tool/call'));
    const steer = user('then say hi');
    s.agent.steer(steer);
    await until(() => s.record.sent.length === 2);
    s.agent.cancel({ kind: 'user' }, { keepInbox: true });
    await idle(s.agent);
    expect(s.record.interruptOptions).toEqual([{ cancelQueued: true }]);
    expect(s.record.disposed).toBe(0); // Stop never ends the process (rule 6)
    expect(s.agent.inbox.nextStep).toHaveLength(0);
    expect(registry.takeDrafts(s.sessionId).map((d) => d.text)).toEqual(['then say hi']);
    const sentBefore = s.record.sent.length;
    s.agent.followup(user('next'));
    await idle(s.agent);
    // The cancelled steer is never sent again at the next claim (D25 r4 unit check).
    expect(s.record.sent.slice(sentBefore).map((i) => i.id)).not.toContain(steer.id);
    expect(s.record.sent.filter((i) => i.id === steer.id)).toHaveLength(1);
    const c = await checkSession(dsh!, rt!, s.handle, s.sessionId);
    expectValid(c);
    expect(c.events.filter((e: any) => e.type === 'user/message').map((e: any) => e.data.id)).not.toContain(steer.id);
    const canceled = c.events.find((e: any) => e.type === 'agent/inbox/spliced' && e.data.outcome === 'canceled');
    expect(canceled).toBeDefined();
  });

  it('D8 + D74: a crash mid-tool closes the step, reports clearly, and the next message resumes', async () => {
    const s = await session({
      onSend: [
        [
          { type: 'turn-start', origin: 'user' },
          { type: 'step-start', agent: MAIN, stepId: 'm1', at: Date.now() },
          {
            type: 'step-message',
            agent: MAIN,
            stepId: 'm1',
            blocks: [{ type: 'tool-call', id: 'toolu_1', name: 'Bash', arguments: '{}' }],
            final: true,
          },
        ],
        [
          { type: 'turn-start', origin: 'user' },
          { type: 'step-start', agent: MAIN, stepId: 'm2', at: Date.now() },
          {
            type: 'step-message',
            agent: MAIN,
            stepId: 'm2',
            blocks: [{ type: 'text', text: 'back' }],
            lastChainId: 'c2',
            final: true,
          },
          { type: 'turn-end', agent: MAIN, outcome: 'completed', pendingInputs: 0 },
        ],
      ],
    });
    s.agent.followup(user('run'));
    await until(() => types(s.agent).includes('tool/call'));
    s.record.crash('signal SIGKILL');
    await idle(s.agent);
    const end = events(s.agent).findLast((e: any) => e.type === 'turn/end');
    expect(end.data.reason.kind).toBe('error');
    expect(JSON.stringify(end.data.reason)).toContain('stopped unexpectedly: signal SIGKILL');
    const repair = events(s.agent).find((e: any) => e.type === 'tool/result');
    expect(repair.data.error.code).toBe('TOOL_OUTCOME_UNKNOWN');
    const state = s.mounts[0].runtime(s.sessionId).state();
    expect(state.process).toBe('none');
    expect(state.lastExit.error).toBe('signal SIGKILL');
    s.agent.followup(user('again'));
    await idle(s.agent);
    expect(s.record.opened).toHaveLength(2);
    expect(s.record.opened[1]!.start).toEqual({ kind: 'resume', sessionId: 'stub-session-1' }); // D28
    const c = await checkSession(dsh!, rt!, s.handle, s.sessionId);
    expectValid(c);
    expect(c.events.filter((e: any) => e.type === 'turn/end').map((e: any) => e.data.reason.kind)).toEqual([
      'error',
      'completed',
    ]);
  });

  it('D87: with the Host registry an agent dispose keeps the process; a reopened agent attaches to it', async () => {
    const registry = new SessionRegistry();
    const turn = (id: string, text: string): ScriptStep[] => [
      { type: 'turn-start', origin: 'user' },
      { type: 'step-start', agent: MAIN, stepId: id, at: Date.now() },
      { type: 'step-message', agent: MAIN, stepId: id, blocks: [{ type: 'text', text }], final: true },
      { type: 'turn-end', agent: MAIN, outcome: 'completed', pendingInputs: 0 },
    ];
    const s = await session({ onSend: [turn('m1', 'one'), turn('m2', 'two')] }, { registry });
    expect(s.mounts[0].shared).toBe(true);
    s.agent.followup(user('one'));
    await idle(s.agent);
    await rt!.ctx.sessions.flush(s.agent.session);
    await s.handle.dispose(); // DSH evicts the agent
    expect(s.record.disposed).toBe(0);
    expect(registry.get(s.sessionId)?.attached).toBe(false);
    const h2 = await rt!.ctx.agents.resume({
      resumeSessionId: s.sessionId,
      agentOptions: { provider: 'raw-test', model: 'settings' },
      setup: s.setup,
    });
    h2.agent.followup(user('two'));
    await idle(h2.agent);
    expect(s.record.opened).toHaveLength(1); // the same process served both agents
    expect(registry.get(s.sessionId)?.attached).toBe(true);
    expect(events(h2.agent).filter((e: any) => e.type === 'turn/end')).toHaveLength(2);
    await h2.dispose();
    await registry.disposeAll();
    expect(s.record.disposed).toBe(1);
  });
});
