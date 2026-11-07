// R10.4, architecture §8: the published manifest and the files that ship with it. No build
// needed (the packed file list itself is checked by scripts/check-pack.mjs after a build).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TESTED_DSH_VERSIONS } from '@dsh-raw-agent/dsh-client';
// @ts-expect-error plain .mjs script without types
import { apiTypes } from '../../../scripts/api-types.mjs';
// @ts-expect-error plain .mjs script without types
import { expectedFiles } from '../../../scripts/check-pack.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dir = `${root}packages/plugin/`;
const pkg = JSON.parse(readFileSync(`${dir}package.json`, 'utf8'));
const RANGE = '>=0.2.2-rc.1 <0.3.0-0';

describe('published manifest (§8)', () => {
  it('declares the DSH range in engines and as an optional peer', () => {
    expect(pkg.name).toBe('dsh-raw-agent');
    expect(pkg.license).toBe('MIT');
    expect(pkg.type).toBe('module');
    expect(pkg.engines).toEqual({ node: '>=24.9.0', dsh: RANGE });
    expect(pkg.peerDependencies).toEqual({ '@deepseek-ai/dsh': RANGE });
    expect(pkg.peerDependenciesMeta['@deepseek-ai/dsh'].optional).toBe(true);
    // Every tested DSH version sits at the range's lower bound or above it (prerelease order is
    // not compared here; the dsh-next CI job checks newer tags).
    expect(TESTED_DSH_VERSIONS).toContain(RANGE.split(' ')[0]!.slice(2));
  });

  it('the SDK is the only runtime dependency; DSH and Cordis are never one', () => {
    expect(Object.keys(pkg.dependencies)).toEqual(['@anthropic-ai/claude-agent-sdk']);
  });

  it('exports the Host, agent and client entries, the API types, locales and the patch', () => {
    expect(pkg.main).toBe('./lib/host.js');
    expect(pkg.exports).toMatchObject({
      '.': './lib/host.js',
      './agent': './lib/agent.js',
      './client': './lib/client.js',
      './api': { types: './lib/api.d.ts' },
      './locale/*.json': './locale/*.json',
      './icon': './icon.svg',
      './cordis.patch.yml': './cordis.patch.yml',
    });
    expect(pkg.dsh).toEqual({
      bundle: { patch: './cordis.patch.yml' },
      client: { platform: 'web', immediately: true },
    });
  });

  it('every export target is in the file list; no maps, types tree or sources ship', () => {
    const files: string[] = pkg.files;
    const targets = Object.values(pkg.exports as Record<string, string | { types: string }>)
      .map((t) => (typeof t === 'string' ? t : t.types).replace(/^\.\//, ''))
      .filter((t) => t !== 'package.json');
    for (const t of targets) expect(files).toContain(t);
    for (const f of files) {
      expect(f).not.toMatch(/\.map$|^lib\/types|^src|^test/);
    }
    const shipped = expectedFiles() as string[];
    for (const f of files.filter((x) => !x.includes('*'))) expect(shipped).toContain(f);
    for (const f of ['README.md', 'LICENSE', 'package.json']) expect(shipped).toContain(f);
  });

  it('ships LICENSE (same as the repo), README and CHANGELOG', () => {
    expect(readFileSync(`${dir}LICENSE`, 'utf8')).toBe(readFileSync(`${root}LICENSE`, 'utf8'));
    expect(readFileSync(`${dir}LICENSE`, 'utf8')).toMatch(/^MIT License/);
    const changelog = readFileSync(`${dir}CHANGELOG.md`, 'utf8');
    expect(changelog).toContain(`## ${pkg.version}`);
    for (const f of ['cordis.patch.yml', 'icon.svg', 'locale/en.json']) expect(existsSync(`${dir}${f}`)).toBe(true);
  });

  it('the user README covers install, overrides, settings access, support limits and privacy', () => {
    const readme = readFileSync(`${dir}README.md`, 'utf8');
    expect(readme).toContain('dsh plugin --profile');
    expect(readme).toContain('add dsh-raw-agent');
    expect(readme).toContain('overrides:');
    for (const p of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64'])
      expect(readme).toContain(`@anthropic-ai/claude-agent-sdk-${p}': '-'`);
    expect(readme).toContain('## Settings quick access');
    expect(readme).toContain('never writes');
    expect(readme).toContain('## What is not supported');
    expect(readme).toContain('## Privacy');
    expect(readme).toContain('No telemetry');
    expect(readme).toContain(RANGE);
  });

  it('the API types are one self-contained declaration file', () => {
    const dts = apiTypes(root) as string;
    expect(dts).not.toMatch(/^\s*import\s/m);
    for (const name of ['RawAgentService', 'RawAgentClientService', 'RawAgentPublicEvent', 'RawAgentErrorCode'])
      expect(dts).toContain(name);
    expect(dts).toContain('import type');
  });
});
