// The Host entry hands its row config to the backends (D87, D14): the bypass switch reaches the
// shared session registry, which the agent entry and the routes read at every spawn.
import { describe, expect, it } from 'vitest';
import { apply } from '../src/host.js';

function fakeCtx() {
  const provided: Record<string, unknown> = {};
  const ctx = {
    get: () => undefined,
    provide: (name: string, value: unknown) => void (provided[name] = value),
    effect: () => undefined,
    on: () => () => undefined,
    logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
  };
  return { ctx, provided };
}

describe('plugin Host entry config', () => {
  it('passes the row options (bypass switch) to the session registry, read at each call', () => {
    const { ctx, provided } = fakeCtx();
    const config: { options: Record<string, unknown> } = { options: { allowDangerouslySkipPermissions: true } };
    apply(ctx as never, config);
    const registry = provided.rawAgentSessions as { userConfig?: () => { options: Record<string, unknown> } };
    expect(registry.userConfig?.().options.allowDangerouslySkipPermissions).toBe(true);
    config.options.allowDangerouslySkipPermissions = false;
    expect(registry.userConfig?.().options.allowDangerouslySkipPermissions).toBe(false);
  });

  it('no config: no options (bypass stays off)', () => {
    const { ctx, provided } = fakeCtx();
    apply(ctx as never);
    const registry = provided.rawAgentSessions as { userConfig?: () => { options: Record<string, unknown> } };
    expect(registry.userConfig?.().options).toEqual({});
  });
});
