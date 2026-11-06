// Import-graph and layering check (architecture §8, R10.3, D65, D79, D80). Exit code 1 on any violation.
//
// Rules:
// 1. Only packages/backend-claude imports @anthropic-ai/claude-agent-sdk.
// 2. Only packages/plugin imports @dsh-raw-agent/backend-claude.
// 3. dsh-host, dsh-client and views-claude import no workspace package except core.
// 4. core imports no workspace package, no SDK and nothing from DSH.
// 5. No runtime import of @deepseek-ai/* or Cordis anywhere (`import type` is fine).
// 6. dsh-host and dsh-client source contains no `claude` or `.claude/` outside comments (D80).
// 7. In dsh-host and dsh-client, only src/port/ names a DSH event type or slot (D79).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkgDir = join(root, 'packages');
const SDK = '@anthropic-ai/claude-agent-sdk';
const errors = [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(?:[cm]?[jt]sx?)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Remove comments, keep strings. Good enough for our own sources. */
export function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length;) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += src[i++];
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') out += src[i++];
        out += src[i++];
      }
      out += src[i++] ?? '';
    } else out += src[i++];
  }
  return out;
}

/** Every module specifier with whether it is type-only. */
export function importsOf(code) {
  const found = [];
  const re =
    /(?:^|[;\n])\s*(import|export)\s+(type\s+)?(?:[\w*${}\s,]+?\s+from\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    if (m[3] !== undefined) found.push({ spec: m[3], typeOnly: m[2] !== undefined });
    else found.push({ spec: m[4] ?? m[5], typeOnly: false });
  }
  return found;
}

const DSH_NAMES = [
  'assistant/message',
  'assistant/attempt',
  'tool/call',
  'tool/result',
  'step/start',
  'step/end',
  'turn/start',
  'turn/end',
  'user/message',
  'session/title',
  'agent/pre-step',
  'agent/inbox/',
  'agent/status',
  'approval/',
  'subagent/',
  'tool-workflow/',
  'agent-preset/',
  'model/selection',
  'conversation.',
  'tool.call.toolview',
];

const isDshRuntime = (s) => s.startsWith('@deepseek-ai/') || s === 'cordis' || s.startsWith('@cordisjs/');

for (const pkg of readdirSync(pkgDir)) {
  const src = join(pkgDir, pkg, 'src');
  let files;
  try {
    files = walk(src);
  } catch {
    continue;
  }
  for (const file of files) {
    const rel = relative(root, file);
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const { spec, typeOnly } of importsOf(code)) {
      if ((spec === SDK || spec.startsWith(`${SDK}/`)) && pkg !== 'backend-claude' && !(typeOnly && pkg === 'plugin'))
        errors.push(`${rel}: imports the Claude Agent SDK (only backend-claude may)`);
      if (spec === '@dsh-raw-agent/backend-claude' && pkg !== 'plugin')
        errors.push(`${rel}: imports backend-claude (only plugin may)`);
      if (
        ['dsh-host', 'dsh-client', 'views-claude'].includes(pkg) &&
        spec.startsWith('@dsh-raw-agent/') &&
        !spec.startsWith('@dsh-raw-agent/core')
      )
        errors.push(`${rel}: imports ${spec} (this package may import only core)`);
      if (pkg === 'core' && spec.startsWith('@dsh-raw-agent/')) errors.push(`${rel}: core imports ${spec}`);
      if (isDshRuntime(spec) && !typeOnly) errors.push(`${rel}: runtime import of ${spec} (types only, D65)`);
    }
    if (pkg === 'dsh-host' || pkg === 'dsh-client') {
      if (/claude/i.test(code)) errors.push(`${rel}: contains "claude" outside comments (D80)`);
      const inPort = rel.split(sep).includes('port');
      if (!inPort) {
        for (const name of DSH_NAMES) {
          if (code.includes(`'${name}`) || code.includes(`"${name}`) || code.includes(`\`${name}`))
            errors.push(`${rel}: names DSH "${name}" outside src/port/ (D79)`);
        }
      }
    }
  }
  // package.json dependencies follow the same graph.
  const manifest = JSON.parse(readFileSync(join(pkgDir, pkg, 'package.json'), 'utf8'));
  const deps = { ...manifest.dependencies, ...manifest.peerDependencies };
  for (const d of Object.keys(deps)) {
    if (d === SDK && !['backend-claude', 'plugin'].includes(pkg))
      errors.push(`packages/${pkg}/package.json: depends on the SDK`);
    if (isDshRuntime(d))
      errors.push(`packages/${pkg}/package.json: runtime dependency on ${d} (devDependency for types only)`);
  }
}

if (errors.length > 0) {
  console.error(`check-imports: ${errors.length} violation(s)`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log('check-imports: ok');
