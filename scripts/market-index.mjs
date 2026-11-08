// The DSH plugin market index (format 1) at market/index.json, served from the main branch at
// INDEX_URL. Users add that URL in DSH's Discover tab; each version installs from its commit on
// the `dist` branch (scripts/publish-dist.mjs), so npm is not used (CLAUDE.md §7).
//
//   node scripts/market-index.mjs check [--file <index.json>]
//   node scripts/market-index.mjs add <version> <dist-commit> [--time <unix seconds>] [--file <index.json>]
//
// `add` puts (or replaces) one version, takes `engines.dsh` and the icon from packages/plugin, and
// then checks the result. Both commands validate with DSH's own `parseMarketIndex`, loaded from
// DSH_PKG or a `dsh` on PATH (as the in-process tests do); without DSH they fail unless
// --allow-no-dsh is given (then only our own checks run).
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const INDEX_URL = 'https://raw.githubusercontent.com/wannaFlyKa/dsh-raw-agent/main/market/index.json';
export const REPO_URL = 'https://github.com/wannaFlyKa/dsh-raw-agent';
export const INDEX_FILE = join(root, 'market', 'index.json');
const PLUGIN = join(root, 'packages', 'plugin');

/** The directory holding the installed `@deepseek-ai/*` packages (DSH_PKG, else a `dsh` on PATH). */
export function findDshPackages() {
  const mark = (nm) => existsSync(join(nm, '@deepseek-ai', 'dsh-plugin-market-index', 'lib', 'index.js'));
  if (process.env.DSH_PKG && mark(process.env.DSH_PKG)) return process.env.DSH_PKG;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const bin = join(dir, 'dsh');
    if (!existsSync(bin)) continue;
    let p = realpathSync(bin);
    for (let i = 0; i < 8; i++) {
      p = dirname(p);
      if (mark(join(p, 'node_modules'))) return join(p, 'node_modules');
    }
  }
  return undefined;
}

/** DSH's own index module (`parseMarketIndex`, `marketInstallTarget`), or undefined without DSH. */
export async function loadMarketIndexModule(dir = findDshPackages()) {
  if (!dir) return undefined;
  return import(pathToFileURL(join(dir, '@deepseek-ai', 'dsh-plugin-market-index', 'lib', 'index.js')).href);
}

export function pluginManifest() {
  return JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'));
}

/** The plugin icon as an inline data URL (the raw file host serves SVG as text, so no relative URL). */
export function iconDataUrl() {
  return `data:image/svg+xml;base64,${readFileSync(join(PLUGIN, 'icon.svg')).toString('base64')}`;
}

/**
 * Our own rules on top of format 1: one entry named like the package, Git sources on this repo's
 * `dist` commits at the root, and the newest version's DSH range equal to the package's.
 * @returns a list of problems (empty when the index is fine).
 */
export function indexProblems(index, manifest = pluginManifest()) {
  const problems = [];
  const plugins = Array.isArray(index?.plugins) ? index.plugins : [];
  if (plugins.length !== 1 || plugins[0].name !== manifest.name) {
    problems.push(`plugins must hold one entry named ${manifest.name}`);
    return problems;
  }
  const versions = plugins[0].versions ?? [];
  for (const v of versions) {
    const s = v.source ?? {};
    if (s.type !== 'git' || s.url !== REPO_URL || !/^[0-9a-f]{40}$/.test(s.commit ?? '') || s.path !== undefined) {
      problems.push(`version ${v.version}: source must be a git commit of ${REPO_URL} without a path`);
    }
  }
  const newest = [...versions].sort((a, b) => b.publishTimestamp - a.publishTimestamp)[0];
  if (newest?.version === manifest.version && newest.engines?.dsh !== manifest.engines.dsh) {
    problems.push(`version ${newest.version}: engines.dsh must be ${manifest.engines.dsh}`);
  }
  return problems;
}

/** Put one version into the index (replacing an entry of the same version), newest first. */
export function withVersion(index, { version, commit, publishTimestamp, dsh, icon }) {
  const next = structuredClone(index);
  const plugin = next.plugins[0];
  if (icon) plugin.icon = icon;
  // A re-run for the same commit keeps the first publish time, so the file does not change.
  const same = plugin.versions.find((v) => v.version === version && v.source?.commit === commit);
  const time = same?.publishTimestamp ?? publishTimestamp;
  const entry = { version, publishTimestamp: time, source: { type: 'git', url: REPO_URL, commit }, engines: { dsh } };
  plugin.versions = [entry, ...plugin.versions.filter((v) => v.version !== version)];
  return next;
}

async function check(index, { allowNoDsh }) {
  const problems = indexProblems(index);
  const mod = await loadMarketIndexModule();
  if (mod) {
    try {
      const parsed = mod.parseMarketIndex(index, INDEX_URL);
      for (const v of parsed.plugins[0]?.versions ?? []) {
        console.error(
          `market-index: ${v.version} -> pnpm add ${mod.marketInstallTarget(parsed.plugins[0].name, v).spec}`,
        );
      }
    } catch (e) {
      problems.push(`DSH parseMarketIndex: ${e.message}`);
    }
  } else if (!allowNoDsh) {
    problems.push('DSH not found (set DSH_PKG or put dsh on PATH; --allow-no-dsh skips the format check)');
  }
  if (problems.length > 0) {
    console.error(`market-index: invalid\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.error(`market-index: ok${mod ? '' : ' (format not checked: no DSH)'}`);
}

async function main(argv) {
  const args = [...argv];
  const option = (name) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const allowNoDsh = args.includes('--allow-no-dsh');
  if (allowNoDsh) args.splice(args.indexOf('--allow-no-dsh'), 1);
  const file = resolve(option('--file') ?? INDEX_FILE);
  const time = option('--time');
  const [command, version, commit] = args;
  const index = JSON.parse(readFileSync(file, 'utf8'));
  if (command === 'check') return check(index, { allowNoDsh });
  if (command === 'add' && version && commit) {
    const manifest = pluginManifest();
    if (version !== manifest.version)
      throw new Error(`version ${version} is not the package version ${manifest.version}`);
    const publishTimestamp = time === undefined ? Math.floor(Date.now() / 1000) : Number(time);
    const next = withVersion(index, {
      version,
      commit,
      publishTimestamp,
      dsh: manifest.engines.dsh,
      icon: iconDataUrl(),
    });
    await check(next, { allowNoDsh });
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    console.error(`market-index: wrote ${version} (${commit}) to ${file}`);
    return;
  }
  throw new Error('usage: market-index.mjs check | add <version> <dist-commit> [--time <s>] [--file <path>]');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
