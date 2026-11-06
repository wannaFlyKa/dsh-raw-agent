import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AsyncQueue, type BackendEvent, type InteractionHandler } from '@dsh-raw-agent/core';
import { createClaudeFactory, toSdkUserMessage, type QueryFn } from '@dsh-raw-agent/backend-claude';

/** A fake Query: records calls, yields what the test pushes. */
function fakeQuery() {
  const out = new AsyncQueue<unknown>();
  const calls: Array<[string, unknown[]]> = [];
  let options: Record<string, unknown> | undefined;
  let prompt: AsyncIterable<unknown> | undefined;
  const q = {
    [Symbol.asyncIterator]: () => out[Symbol.asyncIterator](),
    interrupt: async (...a: unknown[]) => {
      calls.push(['interrupt', a]);
      return { still_queued: [], cancelled: ['in-2'] };
    },
    stopTask: async (...a: unknown[]) => void calls.push(['stopTask', a]),
    setModel: async (...a: unknown[]) => void calls.push(['setModel', a]),
    applyFlagSettings: async (...a: unknown[]) => void calls.push(['applyFlagSettings', a]),
    close: () => {
      calls.push(['close', []]);
      out.end();
    },
  };
  const queryFn: QueryFn = (p) => {
    options = p.options as unknown as Record<string, unknown>;
    prompt = p.prompt;
    process.env.CLAUDE_AGENT_SDK_VERSION = '0.3.318'; // as the real query() does
    return q as never;
  };
  return {
    out,
    calls,
    queryFn,
    get options() {
      return options;
    },
    get prompt() {
      return prompt;
    },
  };
}

const noInteractions: InteractionHandler = {
  permission: async () => ({ optionId: 'reject' }),
  question: async () => null,
  plan: async () => ({ kind: 'keep-planning' }),
  elicitation: async () => ({ action: 'decline' }),
};

function fakeClaude(): string {
  const dir = mkdtempSync(join(tmpdir(), 'raw-agent-test-'));
  const p = join(dir, 'claude');
  writeFileSync(p, '#!/bin/sh\nexit 1\n');
  chmodSync(p, 0o755);
  return p;
}

describe('user message shape (D23, D27)', () => {
  it('sends human origin, our uuid, priority next and @"path" file references', () => {
    const m = toSdkUserMessage(
      {
        id: 'u1',
        parts: [
          { type: 'text', text: 'look at' },
          { type: 'file', hostPath: '/w/a b.ts' },
          { type: 'image', mediaType: 'image/png', base64: 'AA' },
        ],
      },
      'next',
    );
    expect(m).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'look at @"/w/a b.ts"' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } },
        ],
      },
      parent_tool_use_id: null,
      uuid: 'u1',
      origin: { kind: 'human' },
      priority: 'next',
    });
    expect(toSdkUserMessage({ id: 'u2', parts: [{ type: 'text', text: 'x' }] }, 'queue')).not.toHaveProperty(
      'priority',
    );
  });
});

describe.skipIf(process.platform === 'win32')('Claude factory and session (fake query)', () => {
  it('opens one persistent session with raw options, streams events, interrupts without closing', async () => {
    const fake = fakeQuery();
    const factory = createClaudeFactory({ queryFn: fake.queryFn });
    const exe = fakeClaude();
    const before = process.env.CLAUDE_AGENT_SDK_VERSION;
    const sessionId = factory.sessionIdFor!('dsh-session-1');
    const session = await factory.open({
      cwd: '/tmp',
      env: { PATH: '/usr/bin', CLAUDECODE: '1', ANTHROPIC_API_KEY: 'k' },
      start: { kind: 'new', sessionId },
      userConfig: { executablePath: exe, options: {} },
      interactions: noInteractions,
      signal: new AbortController().signal,
    });
    expect(process.env.CLAUDE_AGENT_SDK_VERSION).toBe(before); // D7
    expect(session.sessionId).toBe(sessionId);
    expect(session.startedAs).toBe('new');
    const o = fake.options!;
    expect(o.pathToClaudeCodeExecutable).toBe(exe);
    expect(o.sessionId).toBe(sessionId);
    expect(o.env).toEqual({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'k' });
    expect(o.perTaskStopAffordance).toBe(true);
    expect(typeof o.spawnClaudeCodeProcess).toBe('function');

    // input goes to the SDK prompt stream
    const input = fake.prompt![Symbol.asyncIterator]();
    await session.send({ id: factory.inputIdFor!('m1'), parts: [{ type: 'text', text: 'hi' }] }, 'next');
    expect(((await input.next()).value as { uuid: string }).uuid).toBe(factory.inputIdFor!('m1'));

    const events: BackendEvent[] = [];
    const reader = (async () => {
      for await (const e of session.events()) events.push(e);
    })();
    fake.out.push({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5', claude_code_version: '2.1.318' });

    // Stop = interrupt only (rule 6)
    await session.send({ id: 'in-2', parts: [{ type: 'text', text: 'later' }] }, 'queue');
    expect(await session.interrupt({ cancelQueued: true })).toEqual({ cancelledInputIds: ['in-2'] });
    expect(fake.calls.find((c) => c[0] === 'interrupt')![1]).toEqual([{ cancelQueued: true }]);
    expect(fake.calls.some((c) => c[0] === 'close')).toBe(false);

    await session.controls.stopTask!('task_1');
    await session.controls.setEffort!('ultracode');
    expect(fake.calls.find((c) => c[0] === 'applyFlagSettings')![1]).toEqual([
      { effortLevel: 'xhigh', ultracode: true },
    ]);

    await session.dispose();
    await reader;
    expect(events[0]).toEqual({ type: 'session-info', model: 'claude-sonnet-5-5', version: '2.1.318' });
    expect(events.at(-1)).toEqual({ type: 'exit' });
    expect(session.capabilities.backendVersion).toBe('2.1.318');
  });

  it('derives stable ids (D5)', () => {
    const f = createClaudeFactory({ queryFn: fakeQuery().queryFn });
    expect(f.sessionIdFor!('a')).toBe(f.sessionIdFor!('a'));
    expect(f.sessionIdFor!('a')).not.toBe(f.inputIdFor!('a'));
  });
});
