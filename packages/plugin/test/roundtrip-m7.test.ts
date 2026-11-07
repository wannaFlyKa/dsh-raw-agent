// M7 round trips (R3.5, R3.6, R4.1): through the real in-process DSH loop with JSONL persistence.
// A crash, then replies read back from the agent's record as their own log-only turn; a DSH fork
// seed whose first start gets the dropped turn's input id as its hint (read from the live source
// session). Each log passes the real v4 relationship check, a reload and the stream replay, and
// its export holds the read-back text (plain DSH renders and exports it). Skipped without DSH.

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionTail } from '@dsh-raw-agent/core';
import { createRawAgentHost } from '@dsh-raw-agent/dsh-host';
import {
  checkSession,
  createLoop,
  createStubFactory,
  loadDsh,
  type LoopRuntime,
  type ScriptStep,
} from '@dsh-raw-agent/testkit';

/* eslint-disable @typescript-eslint/no-explicit-any */
const dsh = await loadDsh();
const MAIN = { kind: 'main' } as const;

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
const turn = (id: string, text: string, chain: string): ScriptStep[] => [
  { type: 'turn-start', origin: 'user' },
  { type: 'step-start', agent: MAIN, stepId: id, at: Date.now() },
  { type: 'step-message', agent: MAIN, stepId: id, blocks: [{ type: 'text', text }], lastChainId: chain, final: true },
  { type: 'turn-end', agent: MAIN, outcome: 'completed', pendingInputs: 0 },
];

let rt: LoopRuntime | undefined;
afterEach(async () => {
  await rt?.dispose();
  rt = undefined;
});

function expectValid(c: Awaited<ReturnType<typeof checkSession>>) {
  expect(c.relationships).toBe('ok');
  expect(c.streamCheck).toBe('ok');
  expect(c.reload).toBe('ok');
  expect(c.reloadAddedTail.filter((t) => t !== 'session/end-seed')).toEqual([]);
}

describe.skipIf(dsh === undefined)(`M7 lifecycle round trip (installed DSH ${dsh?.version})`, () => {
  it('R3.6: after a crash, replies only the agent recorded open their own log-only turn', async () => {
    rt = await createLoop(dsh!);
    const stub = createStubFactory({ onSend: [turn('m1', 'first', 'a1')] }, 'raw-test');
    const reads: string[] = [];
    const tail: SessionTail = {
      status: 'found',
      events: [
        { type: 'step-start', agent: MAIN, stepId: 'm2', at: Date.now() },
        {
          type: 'step-message',
          agent: MAIN,
          stepId: 'm2',
          blocks: [
            { type: 'text', text: 'the late reply' },
            { type: 'tool-call', id: 'toolu_9', name: 'Bash', arguments: '{"command":"ls"}' },
          ],
          lastChainId: 'a2',
          final: true,
        },
        {
          type: 'tool-result',
          agent: MAIN,
          callId: 'toolu_9',
          isError: false,
          content: [{ type: 'text', text: 'x.txt' }],
          chainId: 'r2',
        },
        { type: 'step-start', agent: MAIN, stepId: 'm3', at: Date.now() },
        {
          type: 'step-message',
          agent: MAIN,
          stepId: 'm3',
          blocks: [{ type: 'text', text: 'all done' }],
          lastChainId: 'a3',
          final: true,
        },
      ],
      prompts: [],
      notes: [],
      orphanResults: 0,
      lastChainId: 'a3',
    };
    (stub.factory as any).readSessionTail = async (_id: string, _cwd: string, after: string) => {
      reads.push(after);
      return tail;
    };
    const host = createRawAgentHost({ factories: [stub.factory] });
    const sessionId = `session-${randomUUID()}`;
    const mounts: any[] = [];
    const handle = await rt.ctx.agents.create({
      sessionId,
      meta: { cwd: rt.root },
      agentOptions: { provider: 'raw-test', model: 'settings' },
      setup: async (agentCtx: any) =>
        void mounts.push(host.applyAgent(agentCtx, { backend: 'raw-test' }, { stopGraceMs: 300 })),
    });
    const agent = handle.agent;
    agent.followup(user('one'));
    await idle(agent);
    stub.record.crash('it exited with code 1');
    await until(() => agent.session.snapshotEvents().filter((e: any) => e.type === 'turn/end').length === 2);
    await idle(agent);
    expect(reads).toEqual(['a1']);
    expect(stub.record.opened).toHaveLength(1); // no process for the read-back turn (rule 9)
    expect(mounts[0].runtime(sessionId).view().lifecycle.recovered).toMatchObject({ why: 'crash', steps: 2 });
    const c = await checkSession(dsh!, rt, handle, sessionId);
    expectValid(c);
    expect(rt.stray).toEqual([]);
    expect(c.exportMarkdown).toContain('the late reply');
    expect(c.exportMarkdown).toContain('all done');
    const evs = c.events;
    expect(evs.filter((e: any) => e.type === 'user/message')).toHaveLength(1); // nothing synthetic
    const trigger = evs.find((e: any) => e.type === 'developer/message');
    expect(JSON.stringify(trigger.data)).toContain('own record of this conversation');
    const last = evs.filter((e: any) => e.type === 'assistant/message').at(-1);
    expect(last.data.message.source.rawAgent).toMatchObject({ sessionId: 'stub-session-1', lastChainId: 'a3' });
  });

  it('D29: a fork seed hints the first dropped turn from the live source log', async () => {
    rt = await createLoop(dsh!);
    const stub = createStubFactory(
      {
        onSend: [turn('m1', 'one', 'a1'), turn('m2', 'two', 'a2'), turn('f1', 'fork', 'b1')],
        staticCapabilities: { fork: 'at-chain-point' },
      },
      'raw-test',
    );
    (stub.factory as any).inputIdFor = (m: string) => `in-${m}`;
    const host = createRawAgentHost({ factories: [stub.factory] });
    const setup = async (agentCtx: any) =>
      void host.applyAgent(agentCtx, { backend: 'raw-test' }, { stopGraceMs: 300 });
    const srcId = `session-${randomUUID()}`;
    const src = await rt.ctx.agents.create({
      sessionId: srcId,
      meta: { cwd: rt.root },
      agentOptions: { provider: 'raw-test', model: 'settings' },
      setup,
    });
    src.agent.followup(user('one'));
    await idle(src.agent);
    const second = user('two');
    src.agent.followup(second);
    await idle(src.agent);
    const events = src.agent.session.snapshotEvents();
    const boundary = events.find((e: any) => e.type === 'turn/end').seq;
    const session = await import(pathToFileURL(join(dsh!.dir, '@deepseek-ai', 'dsh-session', 'lib', 'index.js')).href);
    const forkId = `session-${randomUUID()}`;
    const fork = await rt.ctx.agents.create({
      sessionId: forkId,
      seed: session.buildForkSeed(events, boundary),
      inheritedEventCount: boundary + 1,
      meta: { cwd: rt.root, isSeeded: true },
      agentOptions: { provider: 'raw-test', model: 'settings' },
      setup,
    });
    fork.agent.followup(user('in the fork'));
    await idle(fork.agent);
    expect(stub.record.opened.at(-1)!.start).toMatchObject({
      kind: 'fork',
      fromSessionId: 'stub-session-1',
      atChainId: 'a1',
      dropsTurnHint: `in-${second.id}`,
    });
    const c = await checkSession(dsh!, rt, fork, forkId);
    expectValid(c);
  });
});
