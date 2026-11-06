// M6 round trip (R7.1, R7.3, D36, D52 r5, D54): the real in-process DSH loop and DSH's real
// command registry.
// - The only host command of ours is `/permission`, in our agent's own scope (a Standard agent's
//   `/` menu is unchanged). The agent's commands and `/btw` are NOT host commands (the client's `/`
//   source lists them and claims `/btw`), so DSH writes no `command/run` record for them.
// - A typed `/cost` is a plain human `user/message`; the agent gets that exact text.
// - The commands route names the taken rows from DSH's registry (D52).
// - A side question (the client claim's route call) writes nothing to the DSH log.
// Skipped when no installed DSH is found.

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createRawAgentHost } from '@dsh-raw-agent/dsh-host';
import {
  TEXT_ONLY_DEFAULT,
  createLoop,
  createStubFactory,
  loadDsh,
  relationshipCheck,
  type LoopRuntime,
} from '@dsh-raw-agent/testkit';

/* eslint-disable @typescript-eslint/no-explicit-any */
const dsh = await loadDsh();
const MAIN = { kind: 'main' } as const;
const KIND = 'raw-test';

let rt: LoopRuntime | undefined;
afterEach(async () => {
  await rt?.dispose();
  rt = undefined;
});

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const idle = (agent: any) => tick(40).then(() => agent.whenIdle());
const names = (commands: any, agent: any) => commands.list(agent).map((d: any) => d.name);

describe.skipIf(dsh === undefined)(`M6 / menu round trip (installed DSH ${dsh?.version})`, () => {
  it('lists the agent commands in our sessions only, forwards them as typed, and claims /btw', async () => {
    rt = await createLoop(dsh!, { commands: true });
    const commands = rt.ctx.get('commands');
    // Stand-in for a global DSH command another plugin registered.
    rt.ctx.effect(() =>
      commands.register({ name: 'goal', description: 'DSH goal', handler: () => ({ kind: 'success' }) }),
    );
    const side: Array<[string, unknown]> = [];
    const stub = createStubFactory(
      {
        staticCapabilities: { sideQuestionCommand: 'btw', steer: 'native' },
        capabilities: { sideQuestions: true },
        controls: {
          commands: async () => [
            { name: 'compact', description: 'Compact the conversation', argumentHint: '<instructions>' },
            { name: 'cost', description: 'Show cost' },
            { name: 'model', description: 'Claude model' },
            { name: 'goal', description: 'Claude goal' },
            { name: 'plugin:deploy', description: 'Plugin' },
            { name: 'btw', description: 'Side question', terminalOnly: true },
          ],
          askSideQuestion: async (q: string, history: unknown) => {
            side.push([q, history]);
            return { text: 'side answer', synthetic: false };
          },
        },
        onSend: [
          [
            { type: 'step-start', agent: MAIN, stepId: 'r1', at: Date.now(), synthetic: true },
            {
              type: 'step-message',
              agent: MAIN,
              stepId: 'r1',
              blocks: [{ type: 'text', text: 'Total cost: $0.00' }],
              final: true,
              synthetic: true,
              localCommand: { name: 'cost' },
            },
            { type: 'turn-end', agent: MAIN, outcome: 'completed', pendingInputs: 0 },
          ] as any,
        ],
      },
      KIND,
    );
    const host = createRawAgentHost({ factories: [stub.factory] });
    let mount: ReturnType<typeof host.applyAgent> | undefined;
    const ours = await rt.ctx.agents.create({
      sessionId: `session-${randomUUID()}`,
      meta: { cwd: rt.root },
      agentOptions: { ...TEXT_ONLY_DEFAULT },
      setup: async (agentCtx: any) => {
        mount = host.applyAgent(agentCtx, { backend: KIND });
      },
    });
    const plain = await rt.ctx.agents.create({
      sessionId: `session-${randomUUID()}`,
      meta: { cwd: rt.root },
      agentOptions: { ...TEXT_ONLY_DEFAULT },
    });
    const run = async (agent: any, line: string) =>
      (await commands.execute(agent, line, [], new AbortController().signal))?.result;
    const runtime = mount!.runtime(ours.agent.id)!;

    const userMessage = (text: string) => ({
      id: randomUUID(),
      role: 'user' as const,
      content: [{ type: 'text', text }],
      source: { kind: 'user', rpcId: randomUUID() },
    });

    // Our scope holds only /permission; the Standard agent sees none of it.
    expect(names(commands, ours.agent)).toEqual(['goal', 'permission']);
    expect(names(commands, plain.agent)).toEqual(['goal']);

    // D54: a side question before the start waits; nothing is sent and nothing is written.
    const early = await runtime.askSideQuestion!('what did we decide?');
    expect(early.ok && early.entry.status).toBe('waiting');
    expect(stub.record.opened).toHaveLength(0);
    expect(ours.agent.session.snapshotEvents().filter((e: any) => e.type.startsWith('command/'))).toEqual([]);

    await runtime.start();
    expect(stub.record.opened).toHaveLength(1);
    await tick();
    expect(side[0]).toEqual(['what did we decide?', []]);
    await stub.record.emit([{ type: 'commands', list: [{ name: 'compact' }], namesOnly: true } as any]);
    await tick();
    // D52 r5: no agent command becomes a host command (so no DSH command records for them).
    expect(names(commands, ours.agent)).toEqual(['goal', 'permission']);
    expect(commands.find(ours.agent, 'btw')).toBeUndefined();
    expect(commands.find(ours.agent, 'goal').description).toBe('DSH goal'); // taken: DSH keeps it
    expect(commands.find(ours.agent, 'model')).toBeUndefined(); // D36: never a host /model
    const answer = await runtime.commandsAnswer!();
    expect(Object.fromEntries(answer.rows.map((r) => [r.name, r.menu]))).toMatchObject({
      compact: 'listed',
      cost: 'listed',
      model: 'taken',
      goal: 'taken',
      'plugin:deploy': 'listed',
      btw: 'side-question',
    });
    expect(answer.rows.find((r) => r.name === 'compact')).toMatchObject({ argumentHint: '<instructions>' });

    // A typed agent command is plain text: DSH does not claim it, the agent gets the exact line.
    expect(await run(ours.agent, '/cost')).toBeUndefined();
    ours.agent.followup(userMessage('/cost'));
    await idle(ours.agent);
    expect(stub.record.sent.map((i: any) => i.parts)).toEqual([[{ type: 'text', text: '/cost' }]]);
    const events = ours.agent.session.snapshotEvents();
    const userMessages = events.filter((e: any) => e.type === 'user/message');
    expect(userMessages.map((e: any) => e.data.content)).toEqual([[{ type: 'text', text: '/cost' }]]);
    const local = events.find((e: any) => e.type === 'assistant/message');
    expect(local.data.message.source.rawAgent.localCommand).toEqual({ name: 'cost' });
    expect(local.data.message.content).toEqual([{ type: 'text', text: 'Total cost: $0.00' }]); // rule 8: as written
    expect(local.data.message.usage).toBeUndefined();
    expect(events.some((e: any) => e.type.startsWith('command/'))).toBe(false);

    // A side question while the agent runs: answered on the side; nothing at all in the log.
    const before = ours.agent.session.snapshotEvents().length;
    const r = await runtime.askSideQuestion!('is the plan clear?');
    expect(r.ok).toBe(true);
    await tick();
    expect(side[1]).toEqual(['is the plan clear?', [{ question: 'what did we decide?', answer: 'side answer' }]]);
    expect(ours.agent.session.snapshotEvents().slice(before)).toEqual([]);
    expect(stub.record.sent).toHaveLength(1);
    expect(runtime.sideQuestions!().entries.map((e) => e.status)).toEqual(['answered', 'answered']);
    expect(relationshipCheck(dsh!, ours.agent.session.id, ours.agent.session.snapshotEvents())).toBe('ok');

    await plain.dispose();
    await ours.dispose();
    await host.sessions.disposeAll();
  });
});
