// The plugin market index (market/index.json, CLAUDE.md §7) against DSH's own format-1 validator,
// and the dist manifest rules of scripts/publish-dist.mjs. The DSH part skips without an installed
// DSH (DSH_PKG or `dsh` on PATH).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  INDEX_FILE,
  INDEX_URL,
  REPO_URL,
  iconDataUrl,
  indexProblems,
  loadMarketIndexModule,
  withVersion,
  // @ts-expect-error plain .mjs script without types
} from '../../../scripts/market-index.mjs';
// @ts-expect-error plain .mjs script without types
import { distManifestProblems } from '../../../scripts/publish-dist.mjs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const index = JSON.parse(readFileSync(INDEX_FILE, 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const mod: Any = await loadMarketIndexModule();

describe('market index (our rules)', () => {
  it('lists this package with Git sources on dist commits and no npm source', () => {
    expect(indexProblems(index, pkg)).toEqual([]);
    const plugin = index.plugins[0];
    expect(plugin.name).toBe(pkg.name);
    expect(plugin.icon).toBe(iconDataUrl());
    expect(plugin.title.en).toBeTruthy();
    expect(plugin.description.en).toBeTruthy();
    for (const v of plugin.versions) expect(v.source).toEqual({ type: 'git', url: REPO_URL, commit: v.source.commit });
  });

  it('lists the newest version with the package DSH range', () => {
    const newest = [...index.plugins[0].versions].sort((a: Any, b: Any) => b.publishTimestamp - a.publishTimestamp)[0];
    expect(newest.engines.dsh).toBe(pkg.engines.dsh);
  });

  it('adds a version newest first and replaces one of the same version', () => {
    const commit = 'a'.repeat(40);
    const next = withVersion(index, { version: '9.9.9', commit, publishTimestamp: 2e9, dsh: pkg.engines.dsh });
    expect(next.plugins[0].versions[0]).toMatchObject({ version: '9.9.9', source: { commit } });
    const again = withVersion(next, { version: '9.9.9', commit: 'b'.repeat(40), publishTimestamp: 2e9, dsh: '*' });
    expect(again.plugins[0].versions.filter((v: Any) => v.version === '9.9.9')).toHaveLength(1);
    expect(again.plugins[0].versions[0].source.commit).toBe('b'.repeat(40));
    expect(index.plugins[0].versions.some((v: Any) => v.version === '9.9.9')).toBe(false);
  });

  it('refuses a path, an npm source, another repository or another package name', () => {
    const bad = (patch: (i: Any) => void): string[] => {
      const copy = structuredClone(index);
      patch(copy);
      return indexProblems(copy, pkg);
    };
    expect(bad((i) => (i.plugins[0].versions[0].source.path = 'dsh-raw-agent'))).not.toEqual([]);
    expect(bad((i) => (i.plugins[0].versions[0].source = { type: 'npm' }))).not.toEqual([]);
    expect(bad((i) => (i.plugins[0].versions[0].source.url = 'https://github.com/x/y'))).not.toEqual([]);
    expect(bad((i) => (i.plugins[0].name = 'other'))).not.toEqual([]);
  });
});

describe('dist manifest rules', () => {
  it('accepts the packed manifest shape and refuses workspace ranges and install scripts', () => {
    expect(distManifestProblems({ dependencies: { a: '1.0.0' }, scripts: { build: 'tsc' } })).toEqual([]);
    expect(distManifestProblems({ devDependencies: { a: 'workspace:*' } })).toHaveLength(1);
    expect(distManifestProblems({ scripts: { prepare: 'x', postinstall: 'y' } })).toHaveLength(2);
  });
});

describe.skipIf(!mod)('market index (DSH parseMarketIndex)', () => {
  it('is a valid format-1 index at its raw URL', () => {
    const parsed = mod.parseMarketIndex(index, INDEX_URL);
    expect(parsed.format).toBe(1);
    expect(parsed.plugins.map((p: Any) => p.name)).toEqual(['dsh-raw-agent']);
    const plugin = parsed.plugins[0];
    expect(plugin.icon).toBe(iconDataUrl());
    expect(plugin.title.zh).toBeTruthy();
    expect(plugin.repository).toEqual({ url: REPO_URL, directory: 'packages/plugin' });
  });

  it('installs each version from its pinned dist commit at the repository root', () => {
    const plugin = mod.parseMarketIndex(index, INDEX_URL).plugins[0];
    for (const v of plugin.versions) {
      expect(mod.marketInstallTarget(plugin.name, v)).toEqual({ spec: `git+${REPO_URL}.git#${v.source.commit}` });
    }
  });
});
