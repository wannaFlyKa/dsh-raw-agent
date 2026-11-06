// Turn an SDK message recording (one SDKMessage per line) into a scrubbed test fixture.
// Usage: node make-fixture.mjs <in.jsonl> <out.jsonl> [maxLines]
//
// Scrubbing: ids are renumbered, signatures and Bedrock metrics removed, local paths replaced,
// and frames that carry the user's own setup (hooks, slash commands, plugins, MCP, tools) dropped.
import { readFileSync, writeFileSync } from 'node:fs';

const [, , input, output, max] = process.argv;
if (!input || !output) {
  console.error('usage: node make-fixture.mjs <in.jsonl> <out.jsonl> [maxLines]');
  process.exit(2);
}

const maps = new Map();
const renumber = (kind, value, fmt) => {
  const key = `${kind}:${value}`;
  if (!maps.has(key)) {
    const n = [...maps.keys()].filter((k) => k.startsWith(`${kind}:`)).length + 1;
    maps.set(key, fmt(n));
  }
  return maps.get(key);
};
const uuid = (v) => renumber('uuid', v, (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const MSG_RE = /\bmsg_[A-Za-z0-9_]+/g;
const TOOLU_RE = /\btoolu_[A-Za-z0-9_]+/g;

const taskIds = new Set();
const lines = readFileSync(input, 'utf8').split('\n').filter(Boolean);
const msgs = lines.slice(0, max ? Number(max) : undefined).map((l) => JSON.parse(l));
for (const m of msgs) {
  if (typeof m.task_id === 'string') taskIds.add(m.task_id);
  if (typeof m.run_id === 'string') taskIds.add(m.run_id);
}

function scrubString(s) {
  let out = s
    .replace(MSG_RE, (v) => renumber('msg', v, (n) => `msg_${String(n).padStart(2, '0')}`))
    .replace(TOOLU_RE, (v) => renumber('toolu', v, (n) => `toolu_${String(n).padStart(2, '0')}`))
    .replace(UUID_RE, uuid)
    .replace(/\/tmp\/claude-\d+\//g, '/tmp/claude-UID/')
    .replace(/-tmp-dsh-raw-p1-[a-z-]+/g, '-tmp-scratch')
    .replace(/\/tmp\/dsh-raw-p1-[a-z-]+/g, '/tmp/scratch');
  if (process.env.HOME) out = out.split(process.env.HOME).join('/home/user');
  for (const id of taskIds) out = out.split(id).join(renumber('task', id, (n) => `task_${String(n).padStart(2, '0')}`));
  return out;
}

function scrub(v, key) {
  if (key === 'signature' && typeof v === 'string') return v === '' ? '' : 'SIG';
  if (typeof v === 'string') return scrubString(v);
  if (Array.isArray(v)) return v.map((x) => scrub(x));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === 'amazon-bedrock-invocationMetrics' || k === 'safeguard_results' || k === 'request_id') continue;
      o[k] = scrub(x, k);
    }
    return o;
  }
  return v;
}

const DROP_SYSTEM = new Set(['hook_started', 'hook_response', 'commands_changed']);
const INIT_KEEP = [
  'type',
  'subtype',
  'session_id',
  'uuid',
  'model',
  'permissionMode',
  'claude_code_version',
  'user_message_uuids',
];

const out = [];
for (const m of msgs) {
  if (m.type === 'system' && DROP_SYSTEM.has(m.subtype)) continue;
  let x = m;
  if (m.type === 'system' && m.subtype === 'init')
    x = Object.fromEntries(INIT_KEEP.filter((k) => k in m).map((k) => [k, m[k]]));
  if (m.type === 'result') {
    x = { ...m };
    for (const k of ['subagent_stats', 'safety_stops', 'fast_mode_disabled_reason', 'model_usage_since_last_result'])
      delete x[k];
  }
  out.push(JSON.stringify(scrub(x)));
}
writeFileSync(output, out.join('\n') + '\n');
console.log(`wrote ${out.length} messages to ${output}`);
