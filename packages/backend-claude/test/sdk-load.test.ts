import { describe, expect, it } from 'vitest';
import {
  loadSdk,
  normalizeConfiguredPath,
  resetSdkForTests,
  SDK_PROCESS_ENV_WRITES,
  withProcessEnvRestored,
  type SdkModule,
} from '@dsh-raw-agent/backend-claude';

describe('withProcessEnvRestored (D7)', () => {
  it('restores set and unset names after a sync call, also on throw', () => {
    const env: NodeJS.ProcessEnv = { A: '1' };
    withProcessEnvRestored(
      ['A', 'B'],
      () => {
        env.A = 'x';
        env.B = 'y';
      },
      env,
    );
    expect(env).toEqual({ A: '1' });
    expect(() =>
      withProcessEnvRestored(
        ['B'],
        () => {
          env.B = 'z';
          throw new Error('boom');
        },
        env,
      ),
    ).toThrow('boom');
    expect(env).toEqual({ A: '1' });
  });

  it('restores after an async call settles', async () => {
    const env: NodeJS.ProcessEnv = {};
    await withProcessEnvRestored(
      ['B'],
      async () => {
        env.B = 'y';
      },
      env,
    );
    expect(env).toEqual({});
  });
});

describe('loadSdk (D7)', () => {
  it('puts back what the SDK module writes on load, and loads once', async () => {
    resetSdkForTests();
    const env: NodeJS.ProcessEnv = { CLAUDE_AGENT_SDK_VERSION: 'user-value' };
    let calls = 0;
    const fake = { query: () => undefined } as unknown as SdkModule;
    const importer = async () => {
      calls++;
      env.NoDefaultCurrentDirectoryInExePath = '1';
      env.CLAUDE_AGENT_SDK_VERSION = '0.3.318';
      return fake;
    };
    expect(await loadSdk(importer, env)).toBe(fake);
    expect(await loadSdk(importer, env)).toBe(fake);
    expect(calls).toBe(1);
    expect(env).toEqual({ CLAUDE_AGENT_SDK_VERSION: 'user-value' });
    resetSdkForTests();
  });

  it('does not cache a failed import', async () => {
    resetSdkForTests();
    await expect(loadSdk(async () => Promise.reject(new Error('no sdk')), {})).rejects.toThrow('no sdk');
    const fake = {} as SdkModule;
    expect(await loadSdk(async () => fake, {})).toBe(fake);
    resetSdkForTests();
  });

  it('the real SDK import leaves the DSH process env unchanged', async () => {
    resetSdkForTests();
    const before = SDK_PROCESS_ENV_WRITES.map((n) => [n, process.env[n]]);
    const sdk = await loadSdk();
    expect(typeof sdk.query).toBe('function');
    expect(SDK_PROCESS_ENV_WRITES.map((n) => [n, process.env[n]])).toEqual(before);
    resetSdkForTests();
  });
});

describe('configured executable path (D10, D87)', () => {
  it('trims, unquotes and expands ~', () => {
    expect(normalizeConfiguredPath('  ~/bin/claude ', '/home/u', 'linux')).toBe('/home/u/bin/claude');
    expect(normalizeConfiguredPath('"/opt/my claude/claude"', '/home/u', 'linux')).toBe('/opt/my claude/claude');
    expect(normalizeConfiguredPath('~\\bin\\claude.exe', 'C:\\Users\\u', 'win32')).toBe(
      'C:\\Users\\u\\bin\\claude.exe',
    );
    expect(normalizeConfiguredPath('   ', '/h', 'linux')).toBeUndefined();
    expect(normalizeConfiguredPath(undefined, '/h', 'linux')).toBeUndefined();
    expect(normalizeConfiguredPath('~user/x', '/h', 'linux')).toBe('~user/x');
  });
});
