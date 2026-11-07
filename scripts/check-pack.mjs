// Pack the published plugin and check the tarball holds exactly what it needs (R10.4,
// architecture §9): the three bundles, the API types, the patch, locales, icon, README, LICENSE,
// CHANGELOG and package.json. No source maps, no declaration tree, no sources, no tests.
// Run after `pnpm build`. Exit code 1 on a difference.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const plugin = join(root, 'packages', 'plugin');

/** The exact file list we ship (paths inside the tarball's `package/` folder). */
export function expectedFiles() {
  const locales = readdirSync(join(plugin, 'locale'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => `locale/${f}`);
  return [
    'CHANGELOG.md',
    'LICENSE',
    'README.md',
    'cordis.patch.yml',
    'icon.svg',
    'lib/agent.js',
    'lib/api.d.ts',
    'lib/client.js',
    'lib/host.js',
    'package.json',
    ...locales,
  ].sort();
}

function main() {
  const dest = mkdtempSync(join(tmpdir(), 'raw-agent-pack-'));
  try {
    const shell = process.platform === 'win32';
    execFileSync('pnpm', ['pack', '--pack-destination', dest], { cwd: plugin, stdio: 'inherit', shell });
    const tgz = readdirSync(dest).find((f) => f.endsWith('.tgz'));
    if (!tgz) throw new Error('pnpm pack wrote no tarball');
    const list = execFileSync('tar', ['-tzf', tgz], { cwd: dest, encoding: 'utf8' })
      .split(/\r?\n/)
      .filter((l) => l !== '' && !l.endsWith('/'))
      .map((l) => l.replace(/^package\//, ''))
      .sort();
    const want = expectedFiles();
    const extra = list.filter((f) => !want.includes(f));
    const missing = want.filter((f) => !list.includes(f));
    if (extra.length > 0 || missing.length > 0) {
      console.error(`check-pack: ${tgz} differs`);
      for (const f of extra) console.error(`  extra:   ${f}`);
      for (const f of missing) console.error(`  missing: ${f}`);
      process.exit(1);
    }
    const version = JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8')).version;
    if (!tgz.includes(version)) throw new Error(`tarball ${tgz} does not carry version ${version}`);
    console.log(`check-pack: ok (${tgz}, ${list.length} files)`);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
