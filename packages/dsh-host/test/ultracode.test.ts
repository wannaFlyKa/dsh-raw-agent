// M4 client-workflows, host side of D37: the session view carries the agent's own ultracode state
// (read after every spawn and every applied choice), so the effort picker can offer ultracode only
// while the agent says it can be turned on.

import { describe, expect, it } from 'vitest';
import { AsyncQueue, type AgentBackendFactory, type BackendEvent, type EffortState } from '@dsh-raw-agent/core';
import { SessionRuntime, channelLine, type HostSessionPort } from '@dsh-raw-agent/dsh-host';

async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function setup(state: () => EffortState | Error) {
  const q = new AsyncQueue<BackendEvent>();
  const efforts: string[] = [];
  let reads = 0;
  const warnings: string[] = [];
  const factory = {
    kind: 'k',
    displayName: 'K',
    staticCapabilities: {
      ids: 'derived',
      resume: true,
      fork: 'none',
      permissionModes: [{ id: 'default', label: 'Ask' }],
      efforts: [
        { id: 'high', label: 'High' },
        { id: 'ultracode', label: 'Ultracode', kind: 'mode' },
      ],
      steer: 'native',
    },
    async open() {
      return {
        kind: 'k',
        sessionId: 'x',
        startedAs: 'new',
        capabilities: {},
        events: () => q,
        send: async () => {},
        interrupt: async () => ({ cancelledInputIds: [] }),
        forceStop: async () => q.end(),
        dispose: async () => {
          q.push({ type: 'exit' });
          q.end();
        },
        controls: {
          setEffort: async (id: string | null) => void efforts.push(String(id)),
          effortState: async () => {
            reads++;
            const s = state();
            if (s instanceof Error) throw s;
            return s;
          },
        },
      };
    },
  } as unknown as AgentBackendFactory;
  const port: HostSessionPort = {
    hostSessionId: 'h1',
    cwd: '/w',
    wake: () => {},
    latestBinding: () => undefined,
    warn: (t) => void warnings.push(t),
  };
  const rt = new SessionRuntime(factory, port, { env: {} });
  return { rt, efforts, reads: () => reads, warnings };
}

describe('ultracode state in the session view (D37)', () => {
  it('reads the state after the spawn and after a choice, and shows it on the channel', async () => {
    let s: EffortState = { ultracode: false, ultracodeAvailable: true };
    const t = setup(() => s);
    expect(t.rt.view().live.ultracode).toBeUndefined(); // no process: unknown
    await t.rt.start();
    await until(() => t.rt.view().live.ultracode !== undefined);
    expect(t.rt.view().live.ultracode).toEqual({ on: false, available: true });

    s = { ultracode: true, ultracodeRequested: true, ultracodeAvailable: true };
    const r = await t.rt.choose({ effort: 'ultracode' });
    expect(r.ok).toBe(true);
    expect(t.efforts).toEqual(['ultracode']);
    await until(() => t.rt.view().live.ultracode?.on === true);
    expect(t.rt.view().live.ultracode).toEqual({ on: true, requested: true, available: true });
    expect(JSON.parse(channelLine(t.rt.view())).live.ultracode).toEqual({ on: true, requested: true, available: true });
    expect(t.reads()).toBeGreaterThanOrEqual(2);
    await t.rt.dispose();
  });

  it('a failed read leaves the state unknown and only warns', async () => {
    const t = setup(() => new Error('no settings'));
    await t.rt.start();
    await until(() => t.warnings.some((w) => w.includes('effortState failed')));
    expect(t.rt.view().live.ultracode).toBeUndefined();
    await t.rt.dispose();
  });
});
