// M2 host-channel round trip (D39, D44, D24, R1.4 leftover): the real in-process DSH loop with the
// real command registry and JSONL persistence.
// - An ask shown while the turn is open writes DSH's native `approval/asked` + `approval/decided`
//   pair inside that turn; one still open at the turn end is `cancelled` (D74). The log passes the
//   v4 relationship check and reloads.
// - The user's mode choice rides in the binding and comes back after a restart (D24).
// - Our `/permission` shadows DSH's command for our agent only (scoped registry).
// Skipped when no installed DSH is found.

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createRawAgentHost, PERMISSION_COMMAND } from '@dsh-raw-agent/dsh-host';
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

const idle = (agent: any) => new Promise((r) => setTimeout(r, 40)).then(() => agent.whenIdle());
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const user = (text: string) => ({
  id: randomUUID(),
  role: 'user' as const,
  content: [{ type: 'text', text }],
  source: { kind: 'user', rpcId: randomUUID() },
});
const ASK_OPTIONS = [
  { id: 'allow-once', kind: 'allow-once', label: 'Yes' },
  { id: 'reject', kind: 'reject-once', label: 'No', acceptsFeedback: true },
] as const;

describe.skipIf(dsh === undefined)(`M2 host channel round trip (installed DSH ${dsh?.version})`, () => {
  it('audits asks inside the open turn, keeps the log valid, and brings the mode choice back', async () => {
    rt = await createLoop(dsh!);
    const stub = createStubFactory(
      {
        onSend: [
          // The turn stays open: the test asks by hand, then ends the turn.
          [{ type: 'step-start', agent: MAIN, stepId: 'r1', at: Date.now() }] as any,
        ],
      },
      KIND,
    );
    const host = createRawAgentHost({ factories: [stub.factory] });
    let mount: ReturnType<typeof host.applyAgent> | undefined;
    const sessionId = `session-${randomUUID()}`;
    const setup = async (agentCtx: any) => {
      mount = host.applyAgent(agentCtx, { backend: KIND });
    };
    const handle = await rt.ctx.agents.create({
      sessionId,
      meta: { cwd: rt.root },
      agentOptions: { ...TEXT_ONLY_DEFAULT },
      setup,
    });
    const agent = handle.agent;
    const runtime = mount!.runtime(agent.id)!;
    expect((await runtime.choose({ mode: 'plan' })).ok).toBe(true);

    // An ask outside any turn writes nothing to the log (D44).
    agent.followup(user('hi'));
    await tick(60);
    const handler = stub.record.opened[0]!.interactions;
    const answered = handler.permission(
      {
        id: 'p1',
        agent: MAIN,
        callId: 'call-1',
        toolName: 'Bash',
        input: { command: 'rm x' },
        reason: 'rule',
        options: [...ASK_OPTIONS],
      },
      new AbortController().signal,
    );
    await tick();
    expect(runtime.view().asks?.map((a) => a.id)).toEqual(['p1']);
    expect(runtime.respond('p1', { choice: 'reject', feedback: 'use trash' })).toEqual({ ok: true });
    expect(runtime.respond('p1', { choice: 'allow-once' })).toMatchObject({ ok: false, code: 'gone' });
    expect(await answered).toEqual({ optionId: 'reject', feedback: 'use trash' });
    // A second ask stays open when the turn ends: cancelled in the log, still open for the user.
    void handler
      .permission(
        { id: 'p2', agent: MAIN, toolName: 'Bash', input: { command: 'ls' }, options: [...ASK_OPTIONS] },
        new AbortController().signal,
      )
      .catch(() => undefined);
    await tick();
    await stub.record.emit([
      { type: 'step-message', agent: MAIN, stepId: 'r1', blocks: [{ type: 'text', text: 'ok' }], final: true },
      { type: 'turn-end', agent: MAIN, outcome: 'completed', pendingInputs: 0 },
    ] as any);
    await idle(agent);

    const events = agent.session.snapshotEvents();
    const types = events.map((e: any) => e.type);
    const asked = events.filter((e: any) => e.type === 'approval/asked');
    const decided = events.filter((e: any) => e.type === 'approval/decided');
    expect(asked.map((e: any) => e.data)).toEqual([
      { id: expect.any(String), toolName: 'Bash', callId: 'call-1', reason: 'rule' },
      { id: expect.any(String), toolName: 'Bash' },
    ]);
    expect(decided.map((e: any) => [e.data.id, e.data.outcome])).toEqual([
      [asked[0].data.id, 'rejected'],
      [asked[1].data.id, 'cancelled'],
    ]);
    const turnStart = types.lastIndexOf('turn/start');
    const turnEnd = types.lastIndexOf('turn/end');
    for (const e of [...asked, ...decided]) {
      expect(e.seq).toBeGreaterThan(events[turnStart].seq);
      expect(e.seq).toBeLessThan(events[turnEnd].seq);
    }
    expect(runtime.view().asks?.map((a) => a.id)).toEqual(['p2']);
    expect(relationshipCheck(dsh!, sessionId, events)).toBe('ok');

    // D24: the binding carries the CLI-reported mode of the user's choice.
    expect(stub.record.controls).toEqual([['setPermissionMode', 'plan']]);
    const msg = events.find((e: any) => e.type === 'assistant/message');
    expect(msg.data.message.source.rawAgent.mode).toBe('plan');

    // Restart: a new host (empty registry) resumes the log; the choice is pending again.
    await rt.ctx.sessions.flush(agent.session);
    await handle.dispose();
    await host.sessions.disposeAll();
    const host2 = createRawAgentHost({ factories: [stub.factory] });
    let mount2: ReturnType<typeof host2.applyAgent> | undefined;
    const h2 = await rt.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { ...TEXT_ONLY_DEFAULT },
      setup: async (agentCtx: any) => {
        mount2 = host2.applyAgent(agentCtx, { backend: KIND });
      },
    });
    const r2 = mount2!.runtime(h2.agent.id)!;
    expect(r2.view().choice.pendingMode).toBe('plan');
    await r2.start();
    await tick();
    expect(stub.record.controls.at(-1)).toEqual(['setPermissionMode', 'plan']);
    await h2.dispose();
    await host2.sessions.disposeAll();
  });

  it('shadows DSH /permission for our agent only; it shows and switches the agent mode', async () => {
    rt = await createLoop(dsh!, { commands: true });
    const commands = rt.ctx.get('commands');
    // Stand-in for DSH's global preset command (dsh-permission-presets).
    rt.ctx.effect(() =>
      commands.register({
        name: PERMISSION_COMMAND,
        description: 'Switch the permission preset',
        handler: () => ({ kind: 'success', text: 'dsh preset' }),
      }),
    );
    const stub = createStubFactory({}, KIND);
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

    expect(await run(plain.agent, '/permission')).toEqual({ kind: 'success', text: 'dsh preset' });
    const shown = await run(ours.agent, '/permission');
    expect(shown.kind).toBe('success');
    expect(shown.text).toMatch(/Stub agent permission mode/);
    expect(shown.text).toMatch(/DSH permission presets do not apply/);
    expect(await run(ours.agent, '/permission read-only')).toMatchObject({ kind: 'error' });
    const switched = await run(ours.agent, '/permission Plan');
    expect(switched).toMatchObject({ kind: 'success' });
    expect(mount!.runtime(ours.agent.id)!.view().choice.pendingMode).toBe('plan');
    // DSH's own preset events were never written in our session.
    expect(ours.agent.session.snapshotEvents().some((e: any) => e.type === 'permission/preset')).toBe(false);
    await plain.dispose();
    await ours.dispose();
    await host.sessions.disposeAll();
  });
});
