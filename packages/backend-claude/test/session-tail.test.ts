// M7 (R3.6): the main-thread record past a chain point, read back from the CLI's transcript.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createClaudeFactory, projectSlug, sessionTail } from '@dsh-raw-agent/backend-claude';

const line = (o: Record<string, unknown>) => JSON.stringify(o);
const user = (uuid: string, parent: string | null, content: unknown, extra: Record<string, unknown> = {}) =>
  line({ type: 'user', uuid, parentUuid: parent, message: { role: 'user', content }, ...extra });
const asst = (uuid: string, parent: string, id: string, content: unknown[], model = 'claude-sonnet-5-5') =>
  line({ type: 'assistant', uuid, parentUuid: parent, message: { id, model, role: 'assistant', content } });
const text = (t: string) => ({ type: 'text', text: t });
const toolUse = (id: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } });
const result = (id: string, t: string) => ({ type: 'tool_result', tool_use_id: id, content: t });

const base = [user('p1', null, 'hi', { origin: { kind: 'human' } }), asst('a1', 'p1', 'm1', [toolUse('t1')])];

describe('sessionTail (R3.6)', () => {
  it('maps what lies past the point: the late result, the reply, a wake turn', () => {
    const t = [
      ...base,
      user('r1', 'a1', [result('t1', 'files')]),
      asst('a2', 'r1', 'm2', [text('Here are the files.')]),
      asst('a2b', 'a2', 'm2', [toolUse('t2')]),
      user('r2', 'a2b', [result('t2', 'ok')]),
      user('n1', 'r2', '<task-notification><summary>sleep done</summary></task-notification>'),
      asst('a3', 'n1', 'm3', [{ type: 'thinking', thinking: '' }, text('It finished.')]),
      line({ type: 'assistant', uuid: 'side', parentUuid: 'a3', isSidechain: true, message: { content: [] } }),
      '{"type":"assistant","uuid":"half',
    ].join('\n');
    const tail = sessionTail(t, 'a1', 5);
    expect(tail.found).toBe(true);
    expect(tail.orphanResults).toBe(1); // t1's call was before the point
    expect(tail.notes).toEqual(['a background task reported back: sleep done']);
    expect(tail.prompts).toEqual([]);
    expect(tail.lastChainId).toBe('a3');
    expect(tail.events.map((e) => e.type)).toEqual([
      'step-start',
      'step-message',
      'tool-result',
      'step-start',
      'step-message',
    ]);
    expect(tail.events[1]).toMatchObject({
      agent: { kind: 'main' },
      stepId: 'm2',
      final: true,
      lastChainId: 'a2b',
      model: 'claude-sonnet-5-5',
      blocks: [
        { type: 'text', text: 'Here are the files.' },
        { type: 'tool-call', id: 't2', name: 'Bash' },
      ],
    });
    expect(tail.events[2]).toMatchObject({ callId: 't2', chainId: 'r2', isError: false });
    expect(tail.events[4]).toMatchObject({ blocks: [{ type: 'text', text: 'It finished.' }] });
  });

  it('counts human prompts, skips meta and markers, follows a compaction boundary', () => {
    const t = [
      ...base,
      user('r1', 'a1', [result('t1', 'x')]),
      user('m1', 'r1', '[Request interrupted by user for tool use]'),
      user('meta', 'm1', 'caveat', { isMeta: true }),
      user('p2', 'meta', 'next question', { origin: { kind: 'human' } }),
      line({ type: 'system', subtype: 'compact_boundary', uuid: 'cb', parentUuid: null, logicalParentUuid: 'p2' }),
      asst('a4', 'cb', 'm4', [text('answer')], '<synthetic>'),
    ].join('\n');
    const tail = sessionTail(t, 'a1', 1);
    expect(tail.prompts).toEqual(['next question']);
    expect(tail.events[1]).toMatchObject({ synthetic: true, blocks: [{ type: 'text', text: 'answer' }] });
    expect(tail.events[1]).not.toHaveProperty('model');
  });

  it('nothing past the point, and a point it does not know', () => {
    expect(sessionTail(base.join('\n'), 'a1', 1)).toMatchObject({ found: true, events: [], orphanResults: 0 });
    expect(sessionTail(base.join('\n'), 'zz', 1).found).toBe(false);
  });
});

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('factory.readSessionTail', () => {
  it('reads the CLI transcript file; no record or no point says so', async () => {
    const root = mkdtempSync(join(tmpdir(), 'raw-agent-tail-'));
    dirs.push(root);
    const cwd = join(root, 'work');
    mkdirSync(cwd);
    const config = join(root, 'config');
    const dir = join(config, 'projects', projectSlug(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 's1.jsonl'), [...base, asst('a2', 'a1', 'm2', [text('late')])].join('\n'));
    const env = { PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: config };
    const factory = createClaudeFactory({ env: () => env });
    const tail = await factory.readSessionTail!('s1', cwd, 'a1');
    expect(tail.status).toBe('found');
    expect(tail.events.filter((e) => e.type === 'step-message')).toHaveLength(1);
    expect((await factory.readSessionTail!('s1', cwd, 'nope')).status).toBe('no-cut');
    expect((await factory.readSessionTail!('none', cwd, 'a1')).status).toBe('no-record');
  });
});
