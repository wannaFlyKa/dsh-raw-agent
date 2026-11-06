// `pnpm test:cli-constants` (architecture §9, D40, D17a, K7). Checks the constants and env names
// this plugin copies from Claude Code against the user's installed `claude` binary:
//   1. D40: every reject text of the table entry for this CLI version is in the binary; the TUI
//      labels and mode descriptions we show (D40-D42) are too (a warning, not a failure).
//   2. D17a: every env name a host Claude Code session puts into the env of its children (the
//      child-marker builder and the Bash/MCP env builders, found by their `CLAUDECODE:"1"`
//      object literals) is in our strip list, our conditional list, or our documented keep list.
//   3. D17a: every `CLAUDE*` name the CLI writes into its own process env is either in those
//      lists or in the reviewed list below, so a CLI upgrade cannot add one silently.
//   4. Every name we strip still exists in the binary or the SDK (a vanished name is reported).
// It reads the binary only; it runs `claude --version` once and nothing else. Needs `pnpm build`
// (it imports packages/backend-claude/lib). Set CLAUDE_BIN to check another binary.
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const lib = await import(`${root}packages/backend-claude/lib/index.js`);
const {
  REJECT_CONSTANTS_BY_VERSION,
  TUI_TEXT,
  MODE_DESCRIPTIONS,
  HOST_SESSION_VARS,
  CONDITIONAL_HOST_VARS,
  KEPT_HOST_MARKERS,
} = lib;

/**
 * `CLAUDE*` names the CLI 2.1.318 writes into its own `process.env`, reviewed and kept (not
 * host-session markers, or the user's own auth or flags; rule 5 forbids stripping tokens).
 * Whether each reaches a tool child is **unverified**: see M1 notes.
 */
const REVIEWED_SELF_WRITES = new Set([
  'CLAUDE_AGENT_SDK_VERSION', // written by the CLI for its children; stripped anyway (HOST list)
  'CLAUDE_CODE_SESSION_ID', // HOST list
  'CLAUDE_CODE_MESSAGING_SOCKET', // HOST list
  'CLAUDE_CODE_BRIDGE_SESSION_ID', // the CLI strips it from children itself (child strip set)
  'CLAUDE_CODE_COORDINATOR_MODE', // the CLI strips it from children itself
  'CLAUDE_CODE_OAUTH_TOKEN', // the user's own token
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN', // the user's own token
  'CLAUDE_CODE_SUBSCRIPTION_TYPE', // account facts that come with the token
  'CLAUDE_CODE_RATE_LIMIT_TIER',
  'CLAUDE_CODE_SIMPLE', // from the user's own `--bare`
  'CLAUDE_CODE_SAFE_MODE', // from the user's own safe-mode flag
  'CLAUDE_CODE_DISABLE_CLAUDE_MDS', // from the user's own flag
  'CLAUDE_CODE_AGENT', // from the user's own `--agent`
  'CLAUDE_AGENTS_SELECT', // from the user's own `--agents`
  'CLAUDE_TMPDIR',
  'CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX',
]);

function findBinary() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const deps = {
    env: process.env,
    platform: process.platform,
    homedir: homedir(),
    isExecutable(p) {
      try {
        if (!statSync(p).isFile()) return false;
        if (process.platform !== 'win32') accessSync(p, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    readText(p) {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return undefined;
      }
    },
  };
  return lib.resolveClaudeBinary(undefined, deps).path;
}

const errors = [];
const warnings = [];
const bin = findBinary();
const version = /(\d+\.\d+\.\d+)/.exec(execFileSync(bin, ['--version'], { encoding: 'utf8' }))?.[1];
const text = readFileSync(realpathSync(bin)).toString('latin1');
const has = (s) => text.includes(Buffer.from(s, 'utf8').toString('latin1'));
console.log(`claude ${version} at ${bin}`);

// 1. D40 reject constants.
const versions = Object.keys(REJECT_CONSTANTS_BY_VERSION);
const entryVersion = versions.includes(version) ? version : versions.at(-1);
if (entryVersion !== version) warnings.push(`no D40 table entry for ${version}; checking the newest (${entryVersion})`);
for (const [name, value] of Object.entries(REJECT_CONSTANTS_BY_VERSION[entryVersion])) {
  if (!has(value)) errors.push(`D40 constant ${name} is not in the binary: ${JSON.stringify(value)}`);
}

// 1b. TUI labels and mode descriptions we show (labels only; they never reach the model).
for (const [name, value] of [...Object.entries(TUI_TEXT), ...Object.entries(MODE_DESCRIPTIONS)]) {
  if (!has(value)) warnings.push(`TUI text ${name} is not in the binary: ${JSON.stringify(value)}`);
}

// 2. Host markers in the child env builders.
const listed = new Set([...HOST_SESSION_VARS, ...CONDITIONAL_HOST_VARS, ...KEPT_HOST_MARKERS]);
const markers = new Set();
let builders = 0;
for (let i = text.indexOf('CLAUDECODE:"1"'); i !== -1; i = text.indexOf('CLAUDECODE:"1"', i + 1)) {
  let s = i;
  for (let d = 0; s > i - 2000; s--) {
    if (text[s] === '}') d++;
    else if (text[s] === '{') {
      if (d === 0) break;
      d--;
    }
  }
  let e = i;
  for (let d = 0; e < i + 2000; e++) {
    if (text[e] === '{') d++;
    else if (text[e] === '}') {
      if (d === 0) break;
      d--;
    }
  }
  builders++;
  for (const m of text.slice(s, e + 1).matchAll(/(?<![\w.$])([A-Z][A-Z0-9_]{2,}):/g)) markers.add(m[1]);
  const ret = text.indexOf('return', e);
  const tail = text.slice(e, ret);
  if (ret !== -1 && tail.length < 600) for (const m of tail.matchAll(/\b\w\.([A-Z][A-Z0-9_]{2,})=/g)) markers.add(m[1]);
}
for (const m of text.matchAll(/\.set\("(CLAUDE_CODE_MESSAGING_[A-Z_]+)"/g)) markers.add(m[1]);
if (builders === 0)
  errors.push('found no child env builder (`CLAUDECODE:"1"`): the CLI changed shape, re-check D17a by hand');
for (const m of markers) if (!listed.has(m)) errors.push(`D17a: new host marker ${m} in a child env builder`);

// 3. CLAUDE* names the CLI writes into its own env.
const selfWrites = new Set([...text.matchAll(/process\.env\.(CLAUDE[A-Z0-9_]*)=(?!=)/g)].map((m) => m[1]));
for (const n of selfWrites)
  if (!listed.has(n) && !REVIEWED_SELF_WRITES.has(n))
    errors.push(`D17a: the CLI now writes ${n} into its env; review it`);

// 4. Every stripped name still exists (the SDK owns CLAUDE_AGENT_SDK_VERSION and the entrypoint).
for (const n of HOST_SESSION_VARS) if (!has(n)) warnings.push(`D17a: ${n} is no longer in the binary`);

console.log(`child env builders: ${builders}; markers: ${[...markers].sort().join(', ')}`);
for (const w of warnings) console.warn(`warning: ${w}`);
if (errors.length > 0) {
  console.error(`test:cli-constants: ${errors.length} failure(s)`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log('test:cli-constants: ok');
