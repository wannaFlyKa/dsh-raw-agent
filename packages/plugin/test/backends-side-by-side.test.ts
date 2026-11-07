// R10.3 (D79-D83, architecture §10.4): a second backend beside Claude. The stub factory (kind
// `stub`, agent-chosen ids, no fork) and the real Claude factory are mounted side by side in one
// Host and one real in-process DSH loop. Checks: one catalog provider per factory, each preset row
// of the shipped patch mounts only our driver (D81), the stub session runs a valid native log
// with its binding in native fields (no `plugin:` record), and nothing in the stub session ever
// reaches the Claude factory (no open, so no `claude` process). The DSH loop part is skipped when
// no installed DSH is found.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentBackendFactory } from '@dsh-raw-agent/core';
import { createClaudeFactory } from '@dsh-raw-agent/backend-claude';
import { agentOps, createRawAgentHost, createRawAgentService, GrantStore } from '@dsh-raw-agent/dsh-host';
import {
  STUB_CAPABILITIES,
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
const root = fileURLToPath(new URL('../../../', import.meta.url));

const textTurn = (text: string): ScriptStep[] => [
  { type: 'turn-start', origin: 'user' },
  { type: 'step-start', agent: MAIN, stepId: 'm1', at: Date.now() },
  {
    type: 'step-message',
    agent: MAIN,
    stepId: 'm1',
    blocks: [{ type: 'text', text }],
    usage: { input: 3, output: 5, cacheRead: 0, cacheWrite: 0 },
    model: 'stub-model',
    final: true,
  },
  { type: 'turn-end', agent: MAIN, outcome: 'completed', pendingInputs: 0 },
];

/** The real Claude factory, with `open` counted (it must never run for a stub session). */
function spiedClaude(): { factory: AgentBackendFactory; opened: () => number } {
  const real = createClaudeFactory();
  let opened = 0;
  const factory = Object.create(real) as AgentBackendFactory;
  (factory as any).open = (...args: unknown[]) => {
    opened++;
    return (real.open as any)(...args);
  };
  return { factory, opened: () => opened };
}

/** The shipped preset rows (cordis.patch.yml), read without a YAML library: id, name, backend. */
function presetRows(
  yml: string,
): Array<{ preset: string; rows: Array<{ id: string; name: string; backend?: string }> }> {
  const out: Array<{ preset: string; rows: Array<{ id: string; name: string; backend?: string }> }> = [];
  const lines = yml.split('\n').filter((l) => !l.trim().startsWith('#'));
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*- id: (preset-raw-agent-\S+)/.exec(lines[i]!);
    if (!m) continue;
    const preset = { preset: m[1]!, rows: [] as Array<{ id: string; name: string; backend?: string }> };
    let j = i + 1;
    while (j < lines.length && !/^\s*plugins:/.test(lines[j]!)) j++;
    const indent = (lines[j] ?? '').search(/\S/);
    for (j++; j < lines.length && (lines[j]!.trim() === '' || lines[j]!.search(/\S/) > indent); j++) {
      const row = /^\s*- id: (\S+)/.exec(lines[j]!);
      if (row) preset.rows.push({ id: row[1]!, name: '' });
      const name = /^\s*name: '?([^']+)'?/.exec(lines[j]!);
      if (name && preset.rows.length > 0 && preset.rows.at(-1)!.name === '') preset.rows.at(-1)!.name = name[1]!;
      const backend = /^\s*backend: (\S+)/.exec(lines[j]!);
      if (backend && preset.rows.length > 0) preset.rows.at(-1)!.backend = backend[1]!;
    }
    out.push(preset);
  }
  return out;
}

describe('two backends side by side (R10.3)', () => {
  it('one catalog provider per factory; the stub is agent-chosen with no fork', () => {
    const claude = spiedClaude();
    const stub = createStubFactory({}, 'stub');
    const host = createRawAgentHost({ factories: [claude.factory, stub.factory] });
    const providers: string[][] = [];
    const ctx = {
      get: (name: string) =>
        name === 'llm' ? { registerAdapter: (p: string[]) => (providers.push(p), () => undefined) } : undefined,
      provide: () => undefined,
      effect: (fn: () => unknown) => void fn(),
      on: () => () => undefined,
      logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
    };
    host.apply(ctx as never);
    expect(providers).toEqual([['claude-code'], ['stub']]);
    expect(stub.factory.staticCapabilities).toMatchObject({ ids: 'agent-chosen', fork: 'none', steer: 'restart' });
    expect(STUB_CAPABILITIES.ids).not.toBe(claude.factory.staticCapabilities.ids);
    expect(claude.opened()).toBe(0);
  });

  it('each shipped preset mounts exactly our driver row, one per shipped factory (D81)', () => {
    const presets = presetRows(readFileSync(`${root}packages/plugin/cordis.patch.yml`, 'utf8'));
    const kinds = [createClaudeFactory().kind];
    expect(presets.map((p) => p.preset)).toEqual(kinds.map((k) => `preset-raw-agent-${k}`));
    for (const [i, p] of presets.entries())
      expect(p.rows).toEqual([{ id: 'raw-agent-driver', name: 'dsh-raw-agent/agent', backend: kinds[i] }]);
  });
});

let rt: LoopRuntime | undefined;
afterEach(async () => {
  await rt?.dispose();
  rt = undefined;
});

describe.skipIf(dsh === undefined)(`stub and Claude in one DSH loop (installed DSH ${dsh?.version})`, () => {
  it('a stub session runs without ever reaching the Claude factory', async () => {
    rt = await createLoop(dsh!, {});
    const claude = spiedClaude();
    const stub = createStubFactory({ onSend: [textTurn('stub answer')] }, 'stub');
    const host = createRawAgentHost({ factories: [claude.factory, stub.factory] });
    const open = async (backend: string) => {
      const sessionId = `session-${randomUUID()}`;
      const handle = await rt!.ctx.agents.create({
        sessionId,
        meta: { cwd: rt!.root },
        agentOptions: { provider: backend, model: 'settings' },
        setup: async (agentCtx: any) => {
          host.applyAgent(agentCtx, { backend }, { stopGraceMs: 300, registry: host.sessions });
        },
      });
      return { sessionId, handle };
    };
    const claudeSession = await open('claude-code');
    const stubSession = await open('stub');

    // Session info for both, before any process: never spawns (D4, D83).
    const grants = new GrantStore();
    const ops = { get: (name: string) => (name === 'agents' ? rt!.ctx.agents : undefined) } as any;
    const service = createRawAgentService({
      registry: host.sessions,
      factories: [claude.factory, stub.factory],
      grants,
      agent: (id) => agentOps(ops, id),
    });
    expect(await service.sessionInfo(claudeSession.sessionId)).toMatchObject({
      backend: { kind: 'claude-code' },
      process: 'none',
    });
    expect(await service.sessionInfo(stubSession.sessionId)).toMatchObject({ backend: { kind: 'stub' } });

    stubSession.handle.agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: 'hello stub' }],
      source: { kind: 'user', rpcId: randomUUID() },
    });
    await new Promise((r) => setTimeout(r, 40));
    await stubSession.handle.agent.whenIdle();
    expect(stub.record.sent).toHaveLength(1);
    expect(stub.record.opened).toHaveLength(1);
    expect(claude.opened()).toBe(0);

    const c = await checkSession(dsh!, rt, stubSession.handle, stubSession.sessionId);
    expect(c.relationships).toBe('ok');
    expect(c.reload).toBe('ok');
    expect(rt.stray).toEqual([]);
    expect(c.events.some((e: any) => String(e.type).startsWith('plugin:'))).toBe(false);
    // D82: the agent-chosen binding is in native fields of the reply.
    const reply = c.events.find((e: any) => e.type === 'assistant/message');
    expect(reply.data.message.source.rawAgent).toMatchObject({ sessionId: 'stub-session-1' });
    expect(claude.opened()).toBe(0);
    await claudeSession.handle.dispose();
  });
});
