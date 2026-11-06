// M1 session-only choices round trip (R1.4; D34, D35, D36, D76, K1): the real in-process DSH loop
// with the real `llm` runtime. A model choice made through the plugin is recorded as a session-only
// `model/selection` and reaches the backend as `setModel`; nothing touches DSH's default model.
// Our catalog lists no rows in DSH's global directory, so DSH's own `selectModel` (which saves the
// profile default, `P/dsh-api-session-controller/lib/index.js:704-720`) refuses our provider.
// Skipped when no installed DSH is found.

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createRawAgentHost, mountHost, SETTINGS_MODEL } from '@dsh-raw-agent/dsh-host';
import { TEXT_ONLY_DEFAULT, createLoop, createStubFactory, loadDsh, type LoopRuntime } from '@dsh-raw-agent/testkit';

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

/** DSH's own availability check before `selectModel` saves a default (`requireModel`, same file :529-541, :875). */
async function dshModelAvailable(ctx: any, selection: { provider: string; model: string }): Promise<boolean> {
  const llm = ctx.get('llm');
  if (!llm.listProviders().some((p: { id: string }) => p.id === selection.provider)) return false;
  return (await llm.listModels(selection.provider)).some((m: { id: string }) => m.id === selection.model);
}

describe.skipIf(dsh === undefined)(`M1 session choices round trip (installed DSH ${dsh?.version})`, () => {
  it('a plugin model choice is session-only and reaches the backend; DSH selectModel cannot pick our rows', async () => {
    rt = await createLoop(dsh!, { llm: 'real' });
    const stub = createStubFactory(
      {
        onSend: [
          [
            { type: 'step-start', agent: MAIN, stepId: 'r1', at: Date.now() },
            { type: 'step-message', agent: MAIN, stepId: 'r1', blocks: [{ type: 'text', text: 'ok' }], final: true },
            { type: 'turn-end', agent: MAIN, outcome: 'completed', pendingInputs: 0 },
          ] as any,
        ],
      },
      KIND,
    );
    mountHost(rt.ctx, [stub.factory], ['seed-model']);
    const host = createRawAgentHost({ factories: [stub.factory] });
    let mount: ReturnType<typeof host.applyAgent> | undefined;
    const sessionId = `session-${randomUUID()}`;
    const handle = await rt.ctx.agents.create({
      sessionId,
      meta: { cwd: rt.root },
      agentOptions: { ...TEXT_ONLY_DEFAULT },
      setup: async (agentCtx: any) => {
        mount = host.applyAgent(agentCtx, { backend: KIND });
      },
    });
    const agent = handle.agent;
    const runtime = mount!.runtime(agent.id)!;
    expect(runtime).toBeDefined();

    // K1: the global directory has no row of ours, so the native seat and /model cannot select it.
    const llm = rt.ctx.get('llm');
    expect(await llm.listModels(KIND)).toEqual([]);
    expect(await dshModelAvailable(rt.ctx, { provider: KIND, model: 'seed-model' })).toBe(false);
    expect(await dshModelAvailable(rt.ctx, { provider: KIND, model: SETTINGS_MODEL })).toBe(false);
    expect(await dshModelAvailable(rt.ctx, TEXT_ONLY_DEFAULT)).toBe(true);

    // D36: the plugin's own path records a session-only selection (no spawn for the choice).
    const r = await runtime.choose({ model: 'seed-model', effort: 'high' });
    expect(r.ok).toBe(true);
    expect(stub.record.opened).toHaveLength(0);
    const sel = agent.session.snapshotEvents().filter((e: any) => e.type === 'model/selection');
    expect(sel.map((e: any) => [e.data.provider, e.data.model])).toEqual([
      [KIND, SETTINGS_MODEL],
      [KIND, 'seed-model'],
    ]);
    // Still resolvable for the loop and for image admission (D33, D76).
    expect((await llm.resolveModelInfo(KIND, 'seed-model')).inputModalities).toEqual(['text', 'image']);

    agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user', rpcId: randomUUID() },
    });
    await idle(agent);
    expect(stub.record.controls).toEqual([
      ['setModel', 'seed-model'],
      ['setEffort', 'high'],
    ]);
    expect(rt.stray).toEqual([]);

    // A new plain (Standard) session afterwards still starts on DSH's own default.
    const plain = await rt.ctx.agents.create({
      sessionId: `session-${randomUUID()}`,
      meta: { cwd: rt.root },
      agentOptions: { ...TEXT_ONLY_DEFAULT },
    });
    expect(plain.agent.model.current()).toMatchObject(TEXT_ONLY_DEFAULT);
    await plain.dispose();
    await handle.dispose();
  });
});
