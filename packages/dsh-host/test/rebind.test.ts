// A blank session created under another preset and then switched to ours never announces
// `agent/created` to our mount (DSH's new-task page creates a Standard agent, then
// `agentPresets.select` rebinds it and emits `tools/change`). The mount must adopt it, so the
// session controls and "Start" work before the first message (D4). Found in the M1 live run.

import { describe, expect, it } from 'vitest';
import type { AgentBackendFactory } from '@dsh-raw-agent/core';
import { SessionRegistry, mountAgent, presetIdFor, type DshAgent, type HostContext } from '@dsh-raw-agent/dsh-host';

const factory = {
  kind: 'raw-test',
  displayName: 'Raw Test',
  staticCapabilities: { permissionModes: [], needsProcess: true, steer: 'next' },
  open() {
    throw new Error('no spawn in this test');
  },
} as unknown as AgentBackendFactory;

function fakeAgent(id: string, bound: string | undefined, events: { type: string; data: unknown }[] = []) {
  const selected: unknown[] = [];
  const agent = {
    id,
    ctx: { bound },
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    model: { current: () => undefined, select: (s: unknown) => selected.push(s) },
    send() {},
    followup() {},
    session: {
      id,
      seq: 0,
      header: { cwd: '/tmp/x' },
      append: () => ({ seq: 0 }),
      snapshotEvents: () => events.map((e, i) => ({ ...e, seq: i, time: 0 })),
    },
  };
  return { agent: agent as unknown as DshAgent, selected };
}

function fakeCtx(agents: DshAgent[]) {
  const listeners = new Map<string, Array<(...a: unknown[]) => unknown>>();
  const ctx = {
    on(name: string, fn: (...a: unknown[]) => unknown) {
      listeners.set(name, [...(listeners.get(name) ?? []), fn]);
      return () => {};
    },
    emit(name: string, ...args: unknown[]) {
      for (const fn of listeners.get(name) ?? []) fn(...args);
    },
    effect() {
      return undefined;
    },
    get(name: string) {
      if (name === 'agents') return { list: () => agents };
      if (name === 'agentPresets') return { composedPreset: (c: { bound?: string }) => c.bound };
      return undefined;
    },
    logger: { warn() {}, info() {} },
  };
  return ctx as unknown as HostContext;
}

describe('rebound agents (preset switched after creation)', () => {
  it('adopts a live agent rebound to our preset on tools/change, and only that one', () => {
    const ours = fakeAgent('session-ours', presetIdFor('raw-test'));
    const theirs = fakeAgent('session-standard', 'standard');
    const ctx = fakeCtx([ours.agent, theirs.agent]);
    const registry = new SessionRegistry();
    const mount = mountAgent(ctx, { factory, registry, selectSettingsModel: true });
    expect(mount.runtime('session-ours')).toBeUndefined();

    ctx.emit('tools/change');
    expect(mount.runtime('session-ours')).toBeDefined();
    expect(mount.runtime('session-standard')).toBeUndefined();
    // D76: the settings row is recorded for the adopted session, as for a new one.
    expect(ours.selected).toEqual([{ provider: 'raw-test', model: 'settings' }]);
    expect(theirs.selected).toEqual([]);

    // A second change is a no-op for an adopted agent.
    const first = mount.runtime('session-ours');
    ctx.emit('tools/change');
    expect(mount.runtime('session-ours')).toBe(first);
    expect(ours.selected).toHaveLength(1);
  });

  it('keeps a model choice already in the log and ignores children', () => {
    const chosen = fakeAgent('session-chosen', presetIdFor('raw-test'), [
      { type: 'model/selection', data: { provider: 'raw-test', model: 'm1' } },
    ]);
    const child = fakeAgent('session-child', presetIdFor('raw-test'));
    (child.agent.session.header as Record<string, unknown>).origin = 'subagent';
    const ctx = fakeCtx([chosen.agent, child.agent]);
    const mount = mountAgent(ctx, { factory, registry: new SessionRegistry(), selectSettingsModel: true });
    ctx.emit('tools/change');
    expect(mount.runtime('session-chosen')).toBeDefined();
    expect(chosen.selected).toEqual([]);
    expect(mount.runtime('session-child')).toBeUndefined();
  });

  it('a blank session switched from our preset to another gets its own route back (M1 live, S4)', () => {
    const events: { type: string; data: unknown }[] = [];
    const leaving = fakeAgent('session-leaving', presetIdFor('raw-test'), events);
    const selected = leaving.selected;
    const a = leaving.agent as unknown as {
      model: { current(): unknown; select(s: unknown): void };
      ctx: { bound?: string };
    };
    a.model = {
      current: () => {
        for (let i = events.length - 1; i >= 0; i--) if (events[i]!.type === 'model/selection') return events[i]!.data;
        return { provider: 'deepseek-official', model: 'ds-default' };
      },
      select: (sel: unknown) => {
        selected.push(sel);
        events.push({ type: 'model/selection', data: sel });
      },
    };
    const ctx = fakeCtx([leaving.agent]);
    const mount = mountAgent(ctx, { factory, registry: new SessionRegistry(), selectSettingsModel: true });
    ctx.emit('tools/change');
    expect(mount.runtime('session-leaving')).toBeDefined();
    expect(selected).toEqual([{ provider: 'raw-test', model: 'settings' }]);

    a.ctx.bound = 'standard';
    ctx.emit('tools/change');
    expect(selected.at(-1)).toEqual({ provider: 'deepseek-official', model: 'ds-default' });
    expect(mount.runtime('session-leaving')).toBeUndefined();

    // Back to ours: adopted again with the settings row.
    a.ctx.bound = presetIdFor('raw-test');
    ctx.emit('tools/change');
    expect(mount.runtime('session-leaving')).toBeDefined();
    expect(selected.at(-1)).toEqual({ provider: 'raw-test', model: 'settings' });
  });

  it('a session that already ran a turn keeps its route when the preset changes', () => {
    const events: { type: string; data: unknown }[] = [{ type: 'turn/start', data: { turn: 1 } }];
    const ran = fakeAgent('session-ran', presetIdFor('raw-test'), events);
    const ctx = fakeCtx([ran.agent]);
    const mount = mountAgent(ctx, { factory, registry: new SessionRegistry(), selectSettingsModel: true });
    ctx.emit('tools/change');
    (ran.agent as unknown as { ctx: { bound?: string } }).ctx.bound = 'standard';
    ctx.emit('tools/change');
    expect(mount.runtime('session-ran')).toBeDefined();
    expect(ran.selected).toEqual([{ provider: 'raw-test', model: 'settings' }]);
  });
});
