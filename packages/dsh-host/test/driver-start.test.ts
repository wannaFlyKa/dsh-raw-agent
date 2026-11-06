import { describe, expect, it } from 'vitest';
import { AsyncQueue, type AgentBackendFactory, type BackendEvent, type OpenSessionOptions } from '@dsh-raw-agent/core';
import { SessionRuntime, type HostBinding, type HostSessionPort, type TurnSink } from '@dsh-raw-agent/dsh-host';

function setup(binding: HostBinding | undefined, choice?: string) {
  const opened: OpenSessionOptions[] = [];
  const models: string[] = [];
  const factory = {
    kind: 'k',
    displayName: 'K',
    staticCapabilities: { ids: 'derived', resume: true, fork: 'at-chain-point' },
    sessionIdFor: (h: string) => `derived-${h}`,
    sessionExists: async () => false,
    async open(o: OpenSessionOptions) {
      opened.push(o);
      const q = new AsyncQueue<BackendEvent>();
      return {
        kind: 'k',
        sessionId: 'x',
        startedAs: 'new',
        capabilities: {},
        events: () => q,
        send: async () => q.push({ type: 'turn-end', outcome: 'completed', pendingInputs: 0 } as BackendEvent),
        interrupt: async () => ({ cancelledInputIds: [] }),
        forceStop: async () => {},
        dispose: async () => q.end(),
        controls: { setModel: async (m: string) => void models.push(m) },
      };
    },
  } as unknown as AgentBackendFactory;
  const port: HostSessionPort = {
    hostSessionId: 'h2',
    cwd: '/w',
    wake: () => {},
    latestBinding: () => binding,
    modelChoice: () => choice,
    startJob: () => undefined,
    warn: () => {},
  };
  const sink: TurnSink = {
    stepOpen: false,
    openCallIds: [],
    hasCall: () => false,
    openStep: () => {},
    delta: () => {},
    commit: () => ({ calls: [] }),
    result: () => {},
    closeStep: () => {},
  };
  const rt = new SessionRuntime(factory, port, { env: {} });
  const run = () =>
    rt.runTurn(
      sink,
      { userInputs: [{ id: 'u1', parts: [{ type: 'text', text: 'hi' }] }], wake: false },
      new AbortController().signal,
    );
  return { opened, models, run, rt };
}

describe('driver start (D28, D29, D35)', () => {
  it('forks an inherited binding at its chain point with the derived id', async () => {
    const t = setup({ sessionId: 'src', hostSessionId: 'h1', chainId: 'c9' });
    await t.run();
    expect(t.opened[0]!.start).toEqual({
      kind: 'fork',
      fromSessionId: 'src',
      newSessionId: 'derived-h2',
      atChainId: 'c9',
    });
    await t.rt.dispose();
  });

  it('resumes its own binding', async () => {
    const t = setup({ sessionId: 'own', hostSessionId: 'h2' });
    await t.run();
    expect(t.opened[0]!.start).toEqual({ kind: 'resume', sessionId: 'own' });
    await t.rt.dispose();
  });

  it('applies an explicit model choice once per spawn, and none for "settings"', async () => {
    const t = setup(undefined, 'm1');
    await t.run();
    await t.run();
    expect(t.models).toEqual(['m1']);
    const u = setup(undefined, undefined);
    await u.run();
    expect(u.models).toEqual([]);
    await t.rt.dispose();
    await u.rt.dispose();
  });
});
