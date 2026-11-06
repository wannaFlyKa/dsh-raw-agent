// Turn an SDK message recording (one SDKMessage per line) into a scrubbed test fixture.
// Usage: node make-fixture.mjs <in.jsonl> <out.jsonl> [maxLines] [--transcripts <dir> <outDir>]
//
// With --transcripts, a workflow run's transcript folder (agent-<id>.jsonl, *.meta.json,
// journal.jsonl) is scrubbed with the same id maps. Agent files keep only their chat lines
// (user/assistant) in full; every other line becomes a small stub of the same type, so a tail
// still meets non-chat lines.
//
// Scrubbing: ids are renumbered, signatures and Bedrock metrics removed, local paths replaced,
// and frames that carry the user's own setup (hooks, slash commands, plugins, MCP, tools) dropped.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const tIndex = argv.indexOf('--transcripts');
const transcripts = tIndex >= 0 ? { dir: argv[tIndex + 1], out: argv[tIndex + 2] } : undefined;
if (tIndex >= 0) argv.splice(tIndex, 3);
const [input, output, max] = argv;
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
const WF_RE = /\bwf_[0-9a-f][0-9a-f-]*/g;
const AGENT_RE = /\ba[0-9a-f]{16}\b/g;

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
    .replace(WF_RE, (v) => renumber('wf', v, (n) => `wf_${String(n).padStart(4, '0')}`))
    .replace(AGENT_RE, (v) => renumber('agent', v, (n) => `a${String(n).padStart(16, '0')}`))
    .replace(/\/tmp\/claude-\d+\//g, '/tmp/claude-UID/')
    .replace(/-tmp-dsh-raw-p1-[a-z-]+/g, '-tmp-scratch')
    .replace(/\/tmp\/dsh-raw-p1-[a-z-]+/g, '/tmp/scratch')
    .replace(/-tmp-raw-[a-z0-9-]+/g, '-tmp-scratch')
    .replace(/\/tmp\/raw-[a-z0-9-]+/g, '/tmp/scratch');
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

if (transcripts) {
  mkdirSync(transcripts.out, { recursive: true });
  const CHAT_KEEP = ['type', 'uuid', 'parentUuid', 'isSidechain', 'agentId', 'isMeta', 'timestamp'];
  for (const name of readdirSync(transcripts.dir).sort()) {
    const text = readFileSync(join(transcripts.dir, name), 'utf8');
    const target = join(transcripts.out, scrubString(name));
    if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) {
      writeFileSync(target, scrubString(text));
      continue;
    }
    const kept = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      const m = JSON.parse(line);
      if (m.type === 'user' || m.type === 'assistant') {
        const x = Object.fromEntries(CHAT_KEEP.filter((k) => k in m).map((k) => [k, m[k]]));
        const msg = m.message ?? {};
        x.message =
          m.type === 'assistant'
            ? { id: msg.id, model: msg.model, role: 'assistant', content: msg.content }
            : { role: 'user', content: msg.content };
        kept.push(JSON.stringify(scrub(x)));
      } else kept.push(JSON.stringify({ type: m.type, stub: true }));
    }
    writeFileSync(target, kept.join('\n') + '\n');
  }
  console.log(`wrote transcripts to ${transcripts.out}`);
}
