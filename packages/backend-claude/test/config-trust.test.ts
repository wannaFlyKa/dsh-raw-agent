import { describe, expect, it } from 'vitest';
import {
  claudeConfigFiles,
  createClaudeFactory,
  MASK,
  maskClaudeSettings,
  readTrustState,
  repositoryRoot,
  TRUST_QUESTION,
  type TrustReadDeps,
} from '@dsh-raw-agent/backend-claude';

const json = { path: '/x/settings.json', format: 'json' };

describe('configFiles (D63)', () => {
  it('names exactly the three settings files', () => {
    const files = claudeConfigFiles('/work/repo', { env: {}, platform: 'linux', homedir: '/home/u' });
    expect(files).toEqual([
      { label: 'User settings', path: '/home/u/.claude/settings.json', scope: 'user', format: 'json' },
      { label: 'Project settings', path: '/work/repo/.claude/settings.json', scope: 'project', format: 'json' },
      {
        label: 'Project local settings',
        path: '/work/repo/.claude/settings.local.json',
        scope: 'local',
        format: 'json',
      },
    ]);
  });
  it('follows CLAUDE_CONFIG_DIR for the user file, as the CLI does', () => {
    const files = claudeConfigFiles('/w', { env: { CLAUDE_CONFIG_DIR: '/cfg' }, platform: 'linux', homedir: '/h' });
    expect(files[0]!.path).toBe('/cfg/settings.json');
  });
  it('uses Windows paths on Windows', () => {
    const files = claudeConfigFiles('C:\\w', { env: {}, platform: 'win32', homedir: 'C:\\Users\\u' });
    expect(files.map((f) => f.path)).toEqual([
      'C:\\Users\\u\\.claude\\settings.json',
      'C:\\w\\.claude\\settings.json',
      'C:\\w\\.claude\\settings.local.json',
    ]);
  });
});

describe('maskConfig (D63)', () => {
  const text = JSON.stringify(
    {
      model: 'opus',
      env: { ANTHROPIC_API_KEY: 'sk-ant-secret', AWS_REGION: 'us-west-2', N: 5, NESTED: { a: 'deep' } },
      permissions: { allow: ['Bash(ls:*)'] },
      apiKeyHelper: 'echo x',
    },
    null,
    2,
  );

  it('hides every value under env and nothing else', () => {
    const { masked, secrets } = maskClaudeSettings(json, text);
    expect(masked).not.toContain('sk-ant-secret');
    expect(masked).not.toContain('us-west-2');
    expect(masked).not.toContain('deep');
    expect(masked).toContain('"ANTHROPIC_API_KEY": "' + MASK + '"');
    expect(masked).toContain('"N": ' + MASK);
    expect(masked).toContain('"model": "opus"');
    expect(masked).toContain('Bash(ls:*)');
    expect(masked).toContain('"apiKeyHelper": "echo x"');
    expect(secrets.map((s) => s.key)).toEqual(['env.ANTHROPIC_API_KEY', 'env.AWS_REGION', 'env.N', 'env.NESTED.a']);
  });

  it('gives ranges into both texts', () => {
    const { masked, secrets } = maskClaudeSettings(json, text);
    for (const s of secrets) expect(masked.slice(s.start, s.end)).toBe(MASK);
    expect(text.slice(secrets[0]!.sourceStart, secrets[0]!.sourceEnd)).toBe('sk-ant-secret');
  });

  it('handles comments, escapes and trailing commas', () => {
    const t = '{\n  // a comment\n  "env": { "K": "a\\"b", /* x */ "L": "c", },\n  "x": 1\n}';
    const { masked, secrets } = maskClaudeSettings(json, t);
    expect(masked).not.toContain('a\\"b');
    expect(secrets).toHaveLength(2);
    expect(masked).toContain('"x": 1');
  });

  it('a top-level env that is not an object is hidden too', () => {
    expect(maskClaudeSettings(json, '{"env": "oops"}').masked).toBe(`{"env": "${MASK}"}`);
  });

  it('masks conservatively when the text is not well-formed', () => {
    const t = '{"env": {"K": "secret"}, "model": "opus"';
    const { masked } = maskClaudeSettings(json, t);
    expect(masked).not.toContain('secret');
    expect(masked).not.toContain('opus');
  });

  it('a file with no env is unchanged', () => {
    const t = '{"model": "opus"}';
    expect(maskClaudeSettings(json, t)).toEqual({ masked: t, secrets: [] });
  });

  it('leaves non-json formats alone', () => {
    expect(maskClaudeSettings({ path: 'a', format: 'text' }, 'K=v')).toEqual({ masked: 'K=v', secrets: [] });
  });
});

function trustDeps(files: Record<string, string>, over: Partial<TrustReadDeps> = {}): TrustReadDeps {
  return {
    env: {},
    platform: 'linux',
    homedir: '/home/u',
    readText: (p) => files[p],
    realpath: (p) => p,
    exists: (p) => p in files,
    ...over,
  };
}

const globalConfig = (projects: Record<string, unknown>) => JSON.stringify({ projects });

describe('trustState (D73, S10)', () => {
  it('trusted when the folder has the record', () => {
    const s = readTrustState(
      '/w/repo',
      trustDeps({ '/home/u/.claude.json': globalConfig({ '/w/repo': { hasTrustDialogAccepted: true } }) }),
    );
    expect(s).toMatchObject({ state: 'trusted', directory: '/w/repo', trustedBy: '/w/repo' });
    expect(s.question).toBeUndefined();
  });

  it('a trusted parent inside the repository counts; one above the repository root does not', () => {
    const files = {
      '/w/repo/.git': '',
      '/home/u/.claude.json': globalConfig({ '/w/repo': { hasTrustDialogAccepted: true } }),
    };
    expect(readTrustState('/w/repo/pkg/a', trustDeps(files)).state).toBe('trusted');
    const above = {
      '/w/repo/.git': '',
      '/home/u/.claude.json': globalConfig({ '/w': { hasTrustDialogAccepted: true } }),
    };
    const s = readTrustState('/w/repo/pkg', trustDeps(above));
    expect(s).toMatchObject({ state: 'untrusted', root: '/w/repo' });
    expect(s.question).toEqual(TRUST_QUESTION);
    expect(s.untrustedEffect).toMatch(/permission rules/);
  });

  it('outside a repository any trusted parent counts', () => {
    const files = { '/home/u/.claude.json': globalConfig({ '/w': { hasTrustDialogAccepted: true } }) };
    expect(readTrustState('/w/a/b', trustDeps(files)).state).toBe('trusted');
  });

  it('keys by real path', () => {
    const files = { '/home/u/.claude.json': globalConfig({ '/real/w': { hasTrustDialogAccepted: true } }) };
    const s = readTrustState('/link/w', trustDeps(files, { realpath: (p) => p.replace('/link', '/real') }));
    expect(s).toMatchObject({ state: 'trusted', directory: '/real/w' });
  });

  it('a false or missing record is untrusted', () => {
    const files = { '/home/u/.claude.json': globalConfig({ '/w': { hasTrustDialogAccepted: false } }) };
    expect(readTrustState('/w', trustDeps(files)).state).toBe('untrusted');
  });

  it('CLAUDE_CODE_SANDBOXED counts as trusted, as in the CLI', () => {
    expect(readTrustState('/w', trustDeps({}, { env: { CLAUDE_CODE_SANDBOXED: '1' } })).state).toBe('trusted');
  });

  it('untrusted, with the question, when there is no global config yet (a new user, M1 verify 2)', () => {
    const s = readTrustState('/w', trustDeps({}));
    expect(s.state).toBe('untrusted');
    expect(s.question).toEqual(TRUST_QUESTION);
  });

  it('unknown when the global config exists but cannot be read or parsed', () => {
    const unreadable = trustDeps({}, { exists: (p) => p === '/home/u/.claude.json' });
    expect(readTrustState('/w', unreadable).state).toBe('unknown');
    expect(readTrustState('/w', trustDeps({ '/home/u/.claude.json': '{' })).state).toBe('unknown');
  });

  it('reads the global config inside CLAUDE_CONFIG_DIR when set', () => {
    const files = { '/cfg/.claude.json': globalConfig({ '/w': { hasTrustDialogAccepted: true } }) };
    expect(readTrustState('/w', trustDeps(files, { env: { CLAUDE_CONFIG_DIR: '/cfg' } })).state).toBe('trusted');
  });

  it('repositoryRoot finds the nearest .git', () => {
    expect(repositoryRoot('/a/b/c', { exists: (p) => p === '/a/.git', platform: 'linux' })).toBe('/a');
    expect(repositoryRoot('/a/b', { exists: () => false, platform: 'linux' })).toBeUndefined();
  });
});

describe('factory no-process reads (D83)', () => {
  const fs = {
    readText: (p: string) =>
      p === '/home/u/.claude.json' ? globalConfig({ '/w': { hasTrustDialogAccepted: true } }) : undefined,
    realpath: (p: string) => p,
    exists: () => false,
  };
  const f = createClaudeFactory({ env: () => ({ CLAUDECODE: '1' }), fs, homedir: '/home/u' });

  it('configFiles, maskConfig and trustState are wired', async () => {
    expect((await f.configFiles!('/w')).map((x) => x.scope)).toEqual(['user', 'project', 'local']);
    expect(f.maskConfig!(json, '{"env":{"K":"v"}}').masked).toBe(`{"env":{"K":"${MASK}"}}`);
    expect((await f.trustState!('/w')).state).toBe('trusted');
  });
});
