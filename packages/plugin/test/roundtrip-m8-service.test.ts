// M8 (R9.2, D66): the public Host service through the real in-process DSH loop. A granted plugin
// message reaches the agent and is written unchanged (`source.kind: 'raw-agent-plugin'`); a
// plugin-kind message that the service did not admit is dropped like a DSH notice (D22); a call
// without a valid grant puts nothing into the inbox. Skipped when no installed DSH is found.

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { PLUGIN_SOURCE_KIND, RawAgentServiceError } from '@dsh-raw-agent/core';
import { GrantStore, agentOps, createRawAgentHost, createRawAgentService } from '@dsh-raw-agent/dsh-host';
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

const textTurn = (text: string): ScriptStep[] => [
  { type: 'turn-start', origin: 'user' },
  { type: 'step-start', agent: MAIN, stepId: 'm1', at: Date.now() },
  {
    type: 'step-message',
    agent: MAIN,
    stepId: 'm1',
    blocks: [{ type: 'text', text }],
    usage: { input: 3, output: 5, cacheRead: 0, cacheWrite: 0 },
    model: 'test-model',
    lastChainId: 'chain-1',
    final: true,
  },
  { type: 'turn-end', agent: MAIN, outcome: 'completed', pendingInputs: 0 },
];

const idle = (agent: any) => new Promise((r) => setTimeout(r, 40)).then(() => agent.whenIdle());

let rt: LoopRuntime | undefined;
afterEach(async () => {
  await rt?.dispose();
  rt = undefined;
});

async function setup(onSend: ScriptStep[][]) {
  rt ??= await createLoop(dsh!, {});
  const stub = createStubFactory({ onSend }, 'raw-test');
  const host = createRawAgentHost({ factories: [stub.factory] });
  const sessionId = `session-${randomUUID()}`;
  const handle = await rt.ctx.agents.create({
    sessionId,
    meta: { cwd: rt.root },
    agentOptions: { provider: 'raw-test', model: 'settings' },
    setup: async (agentCtx: any) => {
      host.applyAgent(agentCtx, { backend: 'raw-test' }, { stopGraceMs: 300, registry: host.sessions });
    },
  });
  const grants = new GrantStore();
  const created = await grants.create('sample-plugin');
  if (!created.ok) throw new Error(created.error);
  const ctx = { get: (name: string) => (name === 'agents' ? rt!.ctx.agents : undefined) } as any;
  const service = createRawAgentService({
    registry: host.sessions,
    factories: [stub.factory],
    grants,
    agent: (id) => agentOps(ctx, id),
  });
  return { handle, agent: handle.agent, stub, sessionId, service, token: created.token, host };
}

describe.skipIf(dsh === undefined)(`M8 plugin service round trip (installed DSH ${dsh?.version})`, () => {
  it('a granted send runs a turn and is written as a raw-agent-plugin message', async () => {
    const s = await setup([textTurn('Hello, plugin.')]);
    const info = await s.service.sessionInfo(s.sessionId);
    expect(info).toMatchObject({ sessionId: s.sessionId, backend: { kind: 'raw-test' }, busy: false });
    const { messageId } = await s.service.send(s.sessionId, 'Summarise the repo', s.token);
    await idle(s.agent);
    expect(s.stub.record.sent).toHaveLength(1);
    expect(s.stub.record.sent[0]!.parts).toEqual([{ type: 'text', text: 'Summarise the repo' }]);
    const c = await checkSession(dsh!, rt!, s.handle, s.sessionId);
    expect(c.relationships).toBe('ok');
    expect(c.reload).toBe('ok');
    expect(rt!.stray).toEqual([]);
    const um = c.events.find((e: any) => e.type === 'user/message');
    expect(um.data.id).toBe(messageId);
    expect(um.data.source).toMatchObject({ kind: PLUGIN_SOURCE_KIND, grant: 'sample-plugin' });
    expect(um.data.source.kind).not.toBe('user');
    expect(c.events.some((e: any) => e.type === 'turn/end')).toBe(true);
  });

  it('a raw-agent-plugin message the service did not admit is dropped, never sent', async () => {
    const s = await setup([textTurn('never')]);
    s.agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: 'sneaky' }],
      source: { kind: PLUGIN_SOURCE_KIND, grant: 'forged', grantId: 'grant-x' },
    });
    await idle(s.agent);
    expect(s.stub.record.sent).toEqual([]);
    const evs = s.agent.session.snapshotEvents();
    expect(evs.some((e: any) => e.type === 'user/message')).toBe(false);
  });

  it('refuses a call without a valid grant and leaves the inbox alone', async () => {
    const s = await setup([textTurn('never')]);
    await expect(s.service.send(s.sessionId, 'hi', '')).rejects.toMatchObject({ code: 'no-grant' });
    await expect(s.service.steer(s.sessionId, 'hi', 'rag1_wrong')).rejects.toBeInstanceOf(RawAgentServiceError);
    await expect(s.service.send('session-other', 'hi', s.token)).rejects.toMatchObject({ code: 'not-our-session' });
    await idle(s.agent);
    expect(s.stub.record.sent).toEqual([]);
    expect(s.agent.inbox.nextTurn).toHaveLength(0);
  });
});
