// M3 child agents: subagents, nested subagents, background agents and shells, teammates
// (D45, D46, D47, D50, D68), against wire recordings from CLI 2.1.318 (fixtures/README.md).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SentInputTracker, type AgentRef, type BackendEvent } from '@dsh-raw-agent/core';
import {
  ChildAgents,
  ClaudeMessageMapper,
  agentMessageSender,
  firstAgentSetting,
  projectSlug,
  readSessionMainAgent,
  transcriptEvents,
  transcriptPaths,
  type TranscriptReadDeps,
} from '@dsh-raw-agent/backend-claude';

type Ev<T extends BackendEvent['type']> = Extract<BackendEvent, { type: T }>;

function loadFixture(name: string): Record<string, unknown>[] {
  const p = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function replay(name: string): BackendEvent[] {
  const tracker = new SentInputTracker();
  const mapper = new ClaudeMessageMapper(tracker);
  const out: BackendEvent[] = [];
  let at = 1000;
  for (const m of loadFixture(name)) {
    if (m.type === 'command_lifecycle' && m.state === 'queued') tracker.sent(m.command_uuid as string);
    out.push(...mapper.map(m, (at += 10)));
  }
  return out;
}

const of = <T extends BackendEvent['type']>(events: BackendEvent[], t: T): Ev<T>[] =>
  events.filter((e): e is Ev<T> => e.type === t);

const key = (r: AgentRef): string => (r.kind === 'main' ? 'main' : r.id);

/** Child guarantees (§7.2 + D68): start first; step-start before its messages; results after their call. */
function checkChildGuarantees(events: BackendEvent[]): void {
  const running = new Set<string>();
  const steps = new Map<string, string>();
  const advertised = new Set<string>();
  for (const e of events) {
    if (e.type === 'agent-start') {
      expect(running.has(key(e.ref))).toBe(false);
      running.add(key(e.ref));
      steps.delete(key(e.ref));
    }
    if (e.type === 'agent-end') {
      expect(running.has(key(e.ref))).toBe(true);
      running.delete(key(e.ref));
    }
    if (e.type === 'agent-input') expect(running.has(key(e.ref))).toBe(true);
    if (
      (e.type === 'step-start' || e.type === 'step-message' || e.type === 'tool-result') &&
      e.agent.kind === 'child'
    ) {
      expect(running.has(e.agent.id)).toBe(true);
      if (e.type === 'step-start') steps.set(e.agent.id, e.stepId);
      if (e.type === 'step-message') {
        expect(steps.get(e.agent.id)).toBe(e.stepId);
        expect(e.usage).toBeUndefined(); // D68
        expect(e.final).toBe(false);
        for (const b of e.blocks) if (b.type === 'tool-call') advertised.add(b.id);
      }
      if (e.type === 'tool-result') expect(advertised.has(e.callId)).toBe(true);
    }
  }
}

describe('foreground subagent (fixture subagent.jsonl)', () => {
  const events = replay('subagent.jsonl');

  it('announces the child before its events, with the spawning call, label and prompt', () => {
    checkChildGuarantees(events);
    const [start, ...more] = of(events, 'agent-start');
    expect(more).toHaveLength(0);
    expect(start).toMatchObject({
      ref: { kind: 'child', id: 'task_01' },
      parent: { kind: 'main' },
      label: 'echo helper',
      role: 'subagent',
      background: false,
      taskId: 'task_01',
      agentType: 'general-purpose',
      depth: 1,
      taskPrompt: 'Run the Bash command `echo hi` and reply with its output only.',
    });
    const agentCall = of(events, 'step-message')
      .filter((e) => e.agent.kind === 'main')
      .flatMap((e) => e.blocks)
      .find((b) => b.type === 'tool-call' && b.name === 'Agent');
    expect(start!.parentCallId).toBe(agentCall && agentCall.type === 'tool-call' ? agentCall.id : 'missing');
  });

  it('writes the child as steps of whole messages (D68), and skips its forwarded prompt', () => {
    const child = events.filter(
      (e) => (e.type === 'step-message' || e.type === 'tool-result') && e.agent.kind === 'child',
    );
    const names = child.flatMap((e) =>
      e.type === 'step-message' ? e.blocks.map((b) => (b.type === 'tool-call' ? b.name : b.type)) : ['result'],
    );
    expect(names).toEqual(['Bash', 'result', 'SubagentHandback', 'result']);
    expect(of(events, 'agent-input')).toHaveLength(0); // the prompt frame is the host's own prompt
    const steps = of(events, 'step-start').filter((e) => e.agent.kind === 'child');
    expect(steps).toHaveLength(2); // one per CLI message id
  });

  it('ends the child before the parent gets its Agent result; foreground is no job', () => {
    const end = events.findIndex((e) => e.type === 'agent-end');
    expect(events[end]).toMatchObject({ type: 'agent-end', ref: { id: 'task_01' }, status: 'completed' });
    const parentResult = events.findIndex(
      (e) =>
        e.type === 'tool-result' && e.agent.kind === 'main' && e.callId === of(events, 'agent-start')[0]!.parentCallId,
    );
    expect(parentResult).toBeGreaterThan(end);
    expect(of(events, 'task-start')).toHaveLength(0);
    // Progress of a foreground child still reaches its row (D46).
    expect(of(events, 'task-progress').some((e) => e.taskId === 'task_01' && e.usage?.toolUses === 1)).toBe(true);
    // The notification's final usage updates the row last (live: the last progress frame was early).
    const last = of(events, 'task-progress')
      .filter((e) => e.taskId === 'task_01')
      .at(-1);
    expect(last?.usage).toEqual({ tokens: 21782, toolUses: 2, durationMs: 4100 });
  });

  it('keeps the main turn intact: child events never open or end a main turn', () => {
    expect(of(events, 'turn-start')).toHaveLength(1);
    expect(of(events, 'turn-end')).toHaveLength(1);
    expect(of(events, 'turn-end')[0]!.outcome).toBe('completed');
  });
});

describe('nested subagent (fixture nested-subagent.jsonl)', () => {
  const events = replay('nested-subagent.jsonl');

  it('places the inner child under the outer one (spawn_depth, parent_task_id)', () => {
    checkChildGuarantees(events);
    const starts = of(events, 'agent-start');
    expect(starts.map((s) => [s.label, key(s.parent), s.depth])).toEqual([
      ['outer', 'main', 1],
      ['inner', starts[0]!.ref.kind === 'child' ? starts[0]!.ref.id : '?', 2],
    ]);
    const outerCall = of(events, 'step-message')
      .filter((e) => e.agent.kind === 'child' && key(e.agent) === key(starts[0]!.ref))
      .flatMap((e) => e.blocks)
      .find((b) => b.type === 'tool-call' && b.name === 'Agent');
    expect(outerCall && outerCall.type === 'tool-call' && outerCall.id).toBe(starts[1]!.parentCallId);
  });

  it('ends the inner child before the outer, and the outer gets the inner result', () => {
    const ends = of(events, 'agent-end').map((e) => key(e.ref));
    const starts = of(events, 'agent-start').map((e) => key(e.ref));
    expect(ends).toEqual([starts[1], starts[0]]);
    const innerResult = of(events, 'tool-result').find((e) => e.callId === of(events, 'agent-start')[1]!.parentCallId);
    expect(innerResult && key(innerResult.agent)).toBe(starts[0]);
  });
});

describe('background agent and shells (fixture background-agent-shell.jsonl)', () => {
  const events = replay('background-agent-shell.jsonl');

  it('makes jobs for the two shells and the agent; the agent job names its child', () => {
    checkChildGuarantees(events);
    const jobs = of(events, 'task-start');
    expect(jobs.map((j) => j.kind)).toEqual(['shell', 'shell', 'agent']);
    const agentJob = jobs[2]!;
    const start = of(events, 'agent-start')[0]!;
    expect(start.background).toBe(true);
    expect(agentJob.agent).toEqual(start.ref);
    expect(agentJob.label).toBe('bg helper');
    expect(events.indexOf(start)).toBeLessThan(events.indexOf(agentJob));
  });

  it('settles the child, then its job; a stopped shell settles stopped (stopTask)', () => {
    const ends = events.filter((e) => e.type === 'agent-end' || e.type === 'task-end');
    expect(ends.map((e) => [e.type, e.status])).toEqual([
      ['agent-end', 'completed'],
      ['task-end', 'completed'],
      ['task-end', 'stopped'],
      ['task-end', 'completed'],
    ]);
  });

  it('runs the wake turns as main turns while the child lives outside any turn', () => {
    // Child frames arrive after the first main result: they are no main turn-start.
    const turns = of(events, 'turn-start');
    expect(turns.length).toBe(3);
    expect(turns.slice(1).every((t) => t.origin === 'self')).toBe(true);
  });
});

describe('two-teammate team (fixture team.jsonl)', () => {
  const events = replay('team.jsonl');

  it('names both teammates from the Agent call (name, team_name)', () => {
    checkChildGuarantees(events);
    const first = of(events, 'agent-start').filter((e) => !e.resumed);
    expect(first.map((e) => [e.label, e.role, e.name, e.team, e.background])).toEqual([
      ['alice', 'teammate', 'alice', 'probe-team', true],
      ['bob', 'teammate', 'bob', 'probe-team', true],
    ]);
    expect(of(events, 'task-start').map((t) => t.label)).toEqual(['alice', 'bob', 'bob', 'alice']);
  });

  it('turns SendMessage calls into team messages after their step-message', () => {
    const msgs = of(events, 'team-message');
    expect(msgs.map((m) => [m.from, m.to, m.text])).toEqual([
      ['alice', 'bob', 'ping'],
      ['bob', 'alice', 'pong'],
    ]);
    for (const m of msgs) {
      const carrier = events.findIndex(
        (e) => e.type === 'step-message' && e.blocks.some((b) => b.type === 'tool-call' && b.id === m.callId),
      );
      expect(carrier).toBeGreaterThanOrEqual(0);
      expect(carrier).toBeLessThan(events.indexOf(m));
    }
  });

  it('re-wakes a finished teammate with the same ref, the message as prompt and its sender', () => {
    const woken = of(events, 'agent-start').filter((e) => e.resumed);
    expect(woken.map((e) => [e.label, e.wokenBy])).toEqual([
      ['bob', 'alice'],
      ['alice', 'bob'],
    ]);
    const bob = of(events, 'agent-start').find((e) => e.label === 'bob' && !e.resumed)!;
    expect(woken[0]!.ref).toEqual(bob.ref);
    expect(woken[0]!.parentCallId).toBe(bob.parentCallId);
    expect(woken[0]!.taskPrompt).toContain('<agent-message from="alice">');
    // A woken child opens a fresh step; its first frame is a step-start of that child.
    const after = events
      .slice(events.indexOf(woken[0]!) + 1)
      .find(
        (e) =>
          (e.type === 'step-start' || e.type === 'step-message' || e.type === 'tool-result') &&
          key(e.agent) === key(bob.ref),
      );
    expect(after?.type).toBe('step-start');
  });

  it('passes CLI text delivered to a running child as agent-input', () => {
    const inputs = of(events, 'agent-input');
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.every((i) => !i.text.startsWith('<system-reminder>'))).toBe(true);
    expect(inputs.some((i) => i.text.includes('handback-send-enforce'))).toBe(true);
  });

  it('every start has an end: four runs, four ends', () => {
    expect(of(events, 'agent-start')).toHaveLength(4);
    expect(of(events, 'agent-end')).toHaveLength(4);
  });
});

describe('ChildAgents edge cases', () => {
  const mainAgentFrame = (id: string, input: Record<string, unknown>) => ({
    type: 'assistant',
    uuid: `u-${id}`,
    message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name: 'Agent', input }] },
  });
  const childFrame = (
    uuid: string,
    parent: string,
    agentId: string | undefined,
    block: Record<string, unknown>,
    msgId = 'cm1',
  ) => ({
    type: 'assistant',
    uuid,
    parent_tool_use_id: parent,
    ...(agentId ? { agent_id: agentId } : {}),
    message: { id: msgId, content: [block] },
  });

  it('announces a child whose frames come before task_started, then adopts the task', () => {
    const mapper = new ClaudeMessageMapper(new SentInputTracker());
    const out: BackendEvent[] = [];
    out.push(...mapper.map(mainAgentFrame('call1', { description: 'early', prompt: 'p', run_in_background: true })));
    out.push(...mapper.map(childFrame('c1', 'call1', undefined, { type: 'text', text: 'hi' })));
    out.push(
      ...mapper.map({
        type: 'system',
        subtype: 'task_started',
        task_id: 't9',
        tool_use_id: 'call1',
        task_type: 'local_agent',
        is_backgrounded: true,
        prompt: 'p',
      }),
    );
    out.push(...mapper.map({ type: 'system', subtype: 'task_notification', task_id: 't9', status: 'completed' }));
    const starts = of(out, 'agent-start');
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ label: 'early', background: true, taskPrompt: 'p' });
    const job = of(out, 'task-start')[0]!;
    expect(job.agent).toEqual(starts[0]!.ref);
    expect(of(out, 'agent-end')).toHaveLength(1);
    expect(of(out, 'task-end')).toHaveLength(1);
  });

  it('ends running foreground children on an interrupted main turn, and all on exit', () => {
    const tracker = new SentInputTracker();
    const mapper = new ClaudeMessageMapper(tracker);
    const out: BackendEvent[] = [];
    tracker.sent('in1');
    out.push(...mapper.map({ type: 'system', subtype: 'status', status: 'requesting', user_message_uuids: ['in1'] }));
    out.push(...mapper.map(mainAgentFrame('fg', { description: 'fg' })));
    out.push(...mapper.map(mainAgentFrame('bg', { description: 'bg', run_in_background: true })));
    for (const [id, call, bg] of [
      ['tf', 'fg', false],
      ['tb', 'bg', true],
    ] as const)
      out.push(
        ...mapper.map({
          type: 'system',
          subtype: 'task_started',
          task_id: id,
          tool_use_id: call,
          task_type: 'local_agent',
          is_backgrounded: bg,
        }),
      );
    mapper.noteInterruptRequested();
    out.push(...mapper.map({ type: 'result', subtype: 'error_during_execution', num_turns: 1, result: '' }));
    expect(of(out, 'agent-end').map((e) => [key(e.ref), e.status])).toEqual([['tf', 'stopped']]);
    // A late notification for the stopped child is not a second end.
    out.push(...mapper.map({ type: 'system', subtype: 'task_notification', task_id: 'tf', status: 'stopped' }));
    expect(of(out, 'agent-end')).toHaveLength(1);
    const exit = mapper.exit('gone');
    expect(exit.map((e) => e.type)).toEqual(['agent-end', 'exit']);
    expect(exit[0]).toMatchObject({ type: 'agent-end', ref: { id: 'tb' }, status: 'failed' });
  });

  it('drops repeated child frames and repeated tool ids; buffers an early result', () => {
    const kids = new ChildAgents();
    const out: BackendEvent[] = [];
    kids.noteCalls([{ type: 'tool_use', id: 'call', name: 'Agent', input: { description: 'd' } }], { kind: 'main' });
    kids.taskStarted({ type: 'system', task_id: 'k', tool_use_id: 'call' }, 1, out);
    const result = {
      type: 'user',
      uuid: 'r1',
      parent_tool_use_id: 'call',
      agent_id: 'k',
      message: { content: [{ type: 'tool_result', tool_use_id: 'x1', content: 'ok' }] },
    };
    kids.user(result, 2, out); // before its call: buffered
    expect(of(out, 'tool-result')).toHaveLength(0);
    const frame = childFrame('a1', 'call', 'k', { type: 'tool_use', id: 'x1', name: 'Bash', input: {} });
    kids.assistant(frame, 3, out);
    kids.assistant(frame, 4, out); // same uuid
    kids.assistant({ ...frame, uuid: 'a2' }, 5, out); // re-sent tool id
    expect(of(out, 'step-message')).toHaveLength(1);
    expect(out.map((e) => e.type)).toEqual(['agent-start', 'step-start', 'step-message', 'tool-result']);
  });

  it('keeps non-empty child thinking as a reasoning block; drops only the empty one (D86)', () => {
    const kids = new ChildAgents();
    const out: BackendEvent[] = [];
    kids.noteCalls([{ type: 'tool_use', id: 'call', name: 'Agent', input: { description: 'd' } }], { kind: 'main' });
    kids.taskStarted({ type: 'system', task_id: 'k', tool_use_id: 'call' }, 1, out);
    kids.assistant(childFrame('a1', 'call', 'k', { type: 'thinking', thinking: 'plan it', signature: 's' }), 2, out);
    kids.assistant(childFrame('a2', 'call', 'k', { type: 'thinking', thinking: '', signature: 's' }, 'cm2'), 3, out);
    const msgs = of(out, 'step-message');
    expect(msgs.map((m) => key(m.agent))).toContain('k');
    const blocks = msgs.flatMap((m) => m.blocks);
    expect(blocks).toEqual([{ type: 'reasoning', text: 'plan it' }]);
  });

  it('reads the agent-message sender', () => {
    expect(agentMessageSender('<agent-message from="alice">\nping\n</agent-message>')).toBe('alice');
    expect(agentMessageSender('plain')).toBeUndefined();
  });

  it('team message from the main thread names the sender main', () => {
    const kids = new ChildAgents();
    const out: BackendEvent[] = [];
    kids.teamMessages(
      [
        {
          type: 'tool-call',
          id: 's1',
          name: 'SendMessage',
          arguments: JSON.stringify({ to: 'bob', message: { kind: 'x' } }),
        },
      ],
      { kind: 'main' },
      out,
    );
    expect(out).toEqual([
      { type: 'team-message', from: 'main', to: 'bob', text: '{"kind":"x"}', agent: { kind: 'main' }, callId: 's1' },
    ]);
  });
});

describe('main-thread agent read (D15)', () => {
  it('returns the agent-setting written before the first message only', () => {
    const lines = (...xs: unknown[]) => xs.map((x) => JSON.stringify(x)).join('\n');
    expect(firstAgentSetting(lines({ type: 'agent-setting', agentSetting: 'pirate' }, { type: 'user' }))).toBe(
      'pirate',
    );
    expect(
      firstAgentSetting(
        lines({ type: 'queue-operation' }, { type: 'user' }, { type: 'agent-setting', agentSetting: 'p' }),
      ),
    ).toBeUndefined();
    expect(firstAgentSetting('{"type":"agent-setting","agentSetting":"x"}\n{"type":"us')).toBe('x');
    // The recorded --agent session (fixture main-agent.jsonl) carries no agent field on the stream.
    expect(loadFixture('main-agent.jsonl').some((m) => 'agent' in m)).toBe(false);
  });

  it('finds the transcript under the CLI projects folder (config dir, real path, long names)', () => {
    const files = new Map<string, string>();
    const deps: TranscriptReadDeps = {
      env: { CLAUDE_CONFIG_DIR: '/cfg' },
      platform: 'linux',
      homedir: '/home/u',
      realpath: (p) => (p === '/link' ? '/real/dir' : p),
      exists: (p) => files.has(p),
      readHead: (p) => files.get(p),
      listDir: () => [`${'-x'.repeat(100)}--abc123`],
    };
    expect(projectSlug('/tmp/a.b_c')).toBe('-tmp-a-b-c');
    files.set('/cfg/projects/-real-dir/s1.jsonl', '{"type":"agent-setting","agentSetting":"reviewer"}');
    expect(readSessionMainAgent('s1', '/link', deps)).toBe('reviewer');
    expect(readSessionMainAgent('s2', '/link', deps)).toBeUndefined();
    const long = '/x'.repeat(150);
    expect(transcriptPaths('s', long, deps)).toEqual([`/cfg/projects/${'-x'.repeat(100)}--abc123/s.jsonl`]);
  });
});

describe('agent transcript read (D49, D50)', () => {
  it('maps a teammate transcript to child events, prompt and delivered message as inputs', () => {
    const ref = { kind: 'child', id: 'k' } as const;
    const events = transcriptEvents(
      ref,
      [
        { type: 'user', uuid: 'u1', message: { role: 'user', content: 'You are bob.' } },
        { type: 'user', uuid: 'u2', message: { role: 'user', content: '<system-reminder>\nctx\n</system-reminder>' } },
        {
          type: 'assistant',
          uuid: 'a1',
          message: { id: 'm1', content: [{ type: 'thinking', thinking: '', signature: 's' }] },
        },
        {
          type: 'assistant',
          uuid: 'a2',
          message: {
            id: 'm1',
            content: [{ type: 'tool_use', id: 't1', name: 'SendMessage', input: { to: 'alice', message: 'pong' } }],
          },
        },
        { type: 'user', uuid: 'u3', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
        {
          type: 'user',
          uuid: 'u4',
          message: {
            content: 'Another Claude session sent a message: <agent-message from="alice">ping</agent-message>',
          },
        },
      ],
      7,
    );
    expect(events.map((e) => e.type)).toEqual([
      'agent-input',
      'step-start',
      'step-message',
      'tool-result',
      'agent-input',
    ]);
    expect(events.every((e) => ('agent' in e ? e.agent : (e as Ev<'agent-input'>).ref).kind === 'child')).toBe(true);
  });
});

describe('session controls for agents and tasks', () => {
  async function open(extra: Record<string, unknown>) {
    const { chmodSync, mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createClaudeFactory } = await import('@dsh-raw-agent/backend-claude');
    const dir = mkdtempSync(join(tmpdir(), 'raw-agent-test-'));
    const bin = join(dir, 'claude');
    writeFileSync(bin, '#!/bin/sh\nexit 1\n');
    chmodSync(bin, 0o755);
    const { AsyncQueue } = await import('@dsh-raw-agent/core');
    const out = new AsyncQueue<unknown>();
    const q = { [Symbol.asyncIterator]: () => out[Symbol.asyncIterator](), close: () => out.end(), ...extra };
    const factory = createClaudeFactory({ queryFn: () => q as never });
    const session = await factory.open({
      cwd: '/tmp',
      env: { PATH: '/usr/bin' },
      start: { kind: 'new' },
      userConfig: { executablePath: bin, options: {} },
      interactions: {
        permission: async () => ({ optionId: 'x' }),
        question: async () => null,
        plan: async () => ({ kind: 'keep-planning' }),
        elicitation: async () => ({ action: 'decline' }),
      },
      signal: new AbortController().signal,
    });
    return { session, out };
  }

  it('lists agents with their model (R6.4) and reads task output (getTaskOutput)', async () => {
    const { session } = await open({
      supportedAgents: async () => [
        { name: 'pirate', description: 'Talks like a pirate', model: 'inherit' },
        { name: 'plain', description: '' },
      ],
      getTaskOutput: async (id: string) => ({ output: `out ${id}`, total_bytes: 9, truncated: false }),
    });
    expect(await session.controls.agents!()).toEqual([
      { name: 'pirate', description: 'Talks like a pirate', model: 'inherit' },
      { name: 'plain' },
    ]);
    expect(await session.controls.taskOutput!('b1')).toEqual({ output: 'out b1', totalBytes: 9, truncated: false });
    expect(session.controls.messageTeammate).toBeUndefined(); // D50: CLI 2.1.318 has no control
    expect(session.capabilities.teamMessaging).toBe(false);
    await session.dispose();
  });

  it('says clearly when the CLI cannot read task output', async () => {
    const { session } = await open({});
    await expect(session.controls.taskOutput!('b1')).rejects.toThrow(/cannot read task output/);
    await session.dispose();
  });
});

describe('factory no-process reads for agents (D15, D49)', () => {
  it('readAgentTranscript maps getSubagentMessages for a child; nothing for main', async () => {
    const { createClaudeFactory } = await import('@dsh-raw-agent/backend-claude');
    const calls: unknown[] = [];
    const f = createClaudeFactory({
      subagentMessages: async (sid, agentId, cwd) => {
        calls.push([sid, agentId, cwd]);
        return [{ type: 'assistant', uuid: 'a', message: { id: 'm', content: [{ type: 'text', text: 'hi' }] } }];
      },
    });
    const events = await f.readAgentTranscript!('s', { kind: 'child', id: 'k' }, '/w');
    expect(events.map((e) => e.type)).toEqual(['step-start', 'step-message']);
    expect(calls).toEqual([['s', 'k', '/w']]);
    expect(await f.readAgentTranscript!('s', { kind: 'main' }, '/w')).toEqual([]);
  });

  it('sessionMainAgent reads the seated agent from the transcript head', async () => {
    const { createClaudeFactory } = await import('@dsh-raw-agent/backend-claude');
    const f = createClaudeFactory({
      env: () => ({ CLAUDE_CONFIG_DIR: '/cfg' }),
      fs: {
        readText: () => undefined,
        realpath: (p) => p,
        exists: () => true,
        readHead: (p) =>
          p === join('/cfg', 'projects', '-w', 's.jsonl')
            ? '{"type":"agent-setting","agentSetting":"pirate"}\n'
            : undefined,
        listDir: () => [],
      },
    });
    expect(await f.sessionMainAgent!('s', '/w')).toBe('pirate');
    expect(await f.sessionMainAgent!('other', '/w')).toBeUndefined();
  });
});
