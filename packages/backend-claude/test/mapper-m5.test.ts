// M5 (R8.4): the mapper marks each main-thread request, and names the tool call on its input
// deltas, so the DSH layer can give DSH real first-token times.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SentInputTracker, type BackendEvent } from '@dsh-raw-agent/core';
import { ClaudeMessageMapper } from '@dsh-raw-agent/backend-claude';

function run(name: string): BackendEvent[] {
  const p = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  const tracker = new SentInputTracker();
  const mapper = new ClaudeMessageMapper(tracker);
  let at = 1000;
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .flatMap((m) => {
      if (m.type === 'command_lifecycle' && m.state === 'queued') tracker.sent(m.command_uuid as string);
      return mapper.map(m, (at += 5));
    });
}

describe('request-start and tool delta names (R8.4)', () => {
  it('emits one request-start before each main response, stamped with its arrival', () => {
    const events = run('foreground-tool.jsonl');
    const kinds = events.filter((e) => e.type === 'request-start' || e.type === 'step-start').map((e) => e.type);
    expect(kinds).toEqual(['request-start', 'step-start', 'request-start', 'step-start']);
    const req = events.find((e) => e.type === 'request-start')!;
    const step = events.find((e) => e.type === 'step-start')!;
    expect(req.type === 'request-start' && step.type === 'step-start' && req.at < step.at).toBe(true);
  });

  it('never marks a subagent request', () => {
    const mapper = new ClaudeMessageMapper(new SentInputTracker());
    const out = mapper.map(
      { type: 'system', subtype: 'status', status: 'requesting', parent_tool_use_id: 'toolu_x' },
      1,
    );
    expect(out.some((e) => e.type === 'request-start')).toBe(false);
  });

  it('names the call on its tool-input deltas', () => {
    const deltas = run('foreground-tool.jsonl').filter(
      (e): e is Extract<BackendEvent, { type: 'delta' }> => e.type === 'delta' && e.kind === 'tool-input',
    );
    expect(deltas.length).toBeGreaterThan(0);
    for (const d of deltas) {
      expect(d.toolCallId).toMatch(/^toolu_/);
      expect(d.toolName).toBe('Bash');
    }
  });
});
