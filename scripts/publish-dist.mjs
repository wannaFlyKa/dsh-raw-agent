// Publish one packed release as a commit on the orphan `dist` branch, so DSH's plugin market can
// install it from Git without npm (CLAUDE.md §7). The commit holds exactly the tarball's files at
// the branch root (package.json, lib/, README.md, LICENSE, ...), one commit per version, each on
// top of the previous one. A `dist-vX.Y.Z` tag pins it, so it is never garbage-collected.
//
//   node scripts/publish-dist.mjs <dsh-raw-agent-X.Y.Z.tgz> [--source <sha>] [--push] [--remote origin]
//
// Prints the dist commit SHA on the last line (and writes `commit=` to $GITHUB_OUTPUT when set).
// Without --push it only builds the commit and the local tag. A second run for the same version
// with the same files reuses the existing commit.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Lifecycle scripts pnpm would run (or refuse to run) for a Git-hosted dependency. */
export const FORBIDDEN_SCRIPTS = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepack',
  'postpack',
  'prepublish',
  'prepublishOnly',
  'publish',
];

const DEP_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'];

/**
 * Check a packed manifest is safe to install from Git: no `workspace:` (or `link:`/`file:`) ranges,
 * and no script pnpm runs when it fetches or installs a Git-hosted package.
 * @returns a list of problems (empty when the manifest is fine).
 */
export function distManifestProblems(manifest) {
  const problems = [];
  for (const field of DEP_FIELDS) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (/^(workspace|link|file|portal):/.test(String(range))) problems.push(`${field}.${name} is ${range}`);
    }
  }
  for (const s of FORBIDDEN_SCRIPTS) {
    if (manifest.scripts?.[s] !== undefined) problems.push(`scripts.${s} is set`);
  }
  return problems;
}

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', ...opts }).trim();
}

function tryGit(args, opts = {}) {
  try {
    return git(args, { stdio: ['ignore', 'pipe', 'ignore'], ...opts });
  } catch {
    return undefined;
  }
}

function main(argv) {
  const args = [...argv];
  const flag = (name) => {
    const i = args.indexOf(name);
    if (i < 0) return false;
    args.splice(i, 1);
    return true;
  };
  const option = (name, fallback) => {
    const i = args.indexOf(name);
    if (i < 0) return fallback;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const push = flag('--push');
  const remote = option('--remote', 'origin');
  const source = option('--source', tryGit(['rev-parse', 'HEAD']));
  const tgz = args[0];
  if (!tgz) throw new Error('usage: publish-dist.mjs <tgz> [--source <sha>] [--push] [--remote origin]');

  const tmp = mkdtempSync(join(tmpdir(), 'raw-agent-dist-'));
  try {
    execFileSync('tar', ['-xzf', resolve(tgz), '-C', tmp]);
    const pkgDir = join(tmp, 'package');
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    if (manifest.name !== 'dsh-raw-agent') throw new Error(`tarball holds ${manifest.name}, not dsh-raw-agent`);
    const problems = distManifestProblems(manifest);
    if (problems.length > 0)
      throw new Error(`packed package.json cannot be installed from Git:\n  ${problems.join('\n  ')}`);
    const version = manifest.version;
    const tag = `dist-v${version}`;

    // The previous dist head and an existing tag for this version, from the remote when there is one.
    tryGit(['fetch', '--quiet', '--no-tags', remote, '+refs/heads/dist:refs/remotes/' + remote + '/dist']);
    tryGit(['fetch', '--quiet', '--no-tags', remote, `+refs/tags/${tag}:refs/tags/${tag}`]);
    const parent = tryGit(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/dist^{commit}`]);
    const tagged = tryGit(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]);

    // Build the tree from the unpacked files with a private index (no checkout, no ignore rules).
    const index = join(tmp, 'index');
    const env = { ...process.env, GIT_INDEX_FILE: index };
    git(['--work-tree', pkgDir, 'add', '--all', '--force', '.'], { env });
    const tree = git(['write-tree'], { env });

    let commit;
    if (tagged && git(['rev-parse', `${tagged}^{tree}`]) === tree) commit = tagged;
    else if (parent && git(['rev-parse', `${parent}^{tree}`]) === tree) commit = parent;
    else {
      const message = `dsh-raw-agent ${version}\n\nThe packed release v${version}${source ? ` (from ${source})` : ''}.\n`;
      const cargs = ['commit-tree', tree, '-m', message];
      if (parent) cargs.splice(2, 0, '-p', parent);
      commit = git(cargs);
    }
    git(['tag', '--force', tag, commit]);
    if (push) {
      git(['push', remote, `${commit}:refs/heads/dist`, `+refs/tags/${tag}:refs/tags/${tag}`], { stdio: 'inherit' });
    }
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `commit=${commit}\n`);
    console.error(`publish-dist: ${tag} -> ${commit}${push ? ` (pushed to ${remote})` : ''}`);
    console.log(commit);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
