// Read-only settings preview for R1.4 (what a new session runs when the user makes no choice).

import { describe, expect, it } from 'vitest';
import {
  claudeConfigFiles,
  createClaudeFactory,
  parseSettingsText,
  readSettingsDefaults,
} from '@dsh-raw-agent/backend-claude';

const files = claudeConfigFiles('/w', { env: {}, platform: 'linux', homedir: '/home/u' });
const read = (map: Record<string, string>) => (p: string) => map[p];

describe('settings defaults preview (R1.4, D83)', () => {
  it('parses JSON with comments and trailing commas, keeping // inside strings', () => {
    expect(parseSettingsText('{ // c\n "a": "x//y", /* b */ "n": [1,], }')).toEqual({ a: 'x//y', n: [1] });
    expect(parseSettingsText('not json')).toBeUndefined();
    expect(parseSettingsText('[1]')).toBeUndefined();
  });

  it('local beats project beats user; the env beats files', () => {
    const r = readSettingsDefaults(
      files,
      read({
        '/home/u/.claude/settings.json':
          '{"model":"u-model","effortLevel":"high","permissions":{"defaultMode":"plan"}}',
        '/w/.claude/settings.json': '{"model":"p-model"}',
        '/w/.claude/settings.local.json': '{"permissions":{"defaultMode":"acceptEdits"}}',
      }),
      {},
    );
    expect(r).toEqual({
      model: 'p-model',
      effort: 'high',
      permissionMode: 'acceptEdits',
      sources: { model: 'project', effort: 'user', permissionMode: 'local' },
      keys: [
        { key: 'effortLevel', scopes: ['user'] },
        { key: 'model', scopes: ['project', 'user'] },
        { key: 'permissions', scopes: ['local', 'user'], merged: true },
      ],
    });
    const env = readSettingsDefaults(
      files,
      read({ '/home/u/.claude/settings.json': '{"model":"u","env":{"ANTHROPIC_MODEL":"from-settings-env"}}' }),
      {},
    );
    expect(env.model).toBe('from-settings-env');
    expect(env.sources.model).toBe('user env');
    expect(readSettingsDefaults(files, read({}), { ANTHROPIC_MODEL: 'proc' }).sources.model).toBe('env');
  });

  it('names the layers of every top-level key, highest first; objects in two layers are merged (D63)', () => {
    const r = readSettingsDefaults(
      files,
      read({
        '/home/u/.claude/settings.json': '{"$schema":"x","env":{"A":"1"},"hooks":{},"theme":"dark"}',
        '/w/.claude/settings.local.json': '{"env":{"B":"2"},"theme":"light"}',
      }),
      {},
    );
    expect(r.keys).toEqual([
      { key: 'env', scopes: ['local', 'user'], merged: true },
      { key: 'hooks', scopes: ['user'] },
      { key: 'theme', scopes: ['local', 'user'] },
    ]);
  });

  it('missing or broken files give an empty preview', () => {
    expect(readSettingsDefaults(files, read({ '/w/.claude/settings.json': '{' }), {})).toEqual({ sources: {} });
  });

  it('the factory reads only, through its file seam', async () => {
    const seen: string[] = [];
    const factory = createClaudeFactory({
      env: () => ({}),
      homedir: '/home/u',
      fs: {
        readText: (p) => (seen.push(p), p.endsWith('/home/u/.claude/settings.json') ? '{"model":"m"}' : undefined),
        realpath: (p) => p,
        exists: () => false,
      },
    });
    expect(await factory.settingsDefaults!('/w')).toEqual({
      model: 'm',
      sources: { model: 'user' },
      keys: [{ key: 'model', scopes: ['user'] }],
    });
    expect(seen.length).toBe(3);
  });
});
