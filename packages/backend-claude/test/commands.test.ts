// M6 backend-commands: the `/` menu, skills, local command output, MCP status and `/btw`
// (R7.1-R7.5; D52-D56, D9). Frame shapes follow the CLI 2.1.318 recordings of Phase 1 (probe5
// `/context`, `/usage`, `/cost`, `/compact`; raw-baseline `sdk-commands`), with names made generic.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AsyncQueue,
  SentInputTracker,
  SideQuestionHistory,
  type BackendEvent,
  type InteractionHandler,
} from '@dsh-raw-agent/core';
import {
  ClaudeMessageMapper,
  CommandCatalog,
  MCP_TOGGLE_NOTE,
  createClaudeFactory,
  localCommandOf,
  sideHistoryWire,
  slashCommandOf,
  toCommandInfo,
  toMcpAuthStart,
  toMcpServerInfo,
  toSdkUserMessage,
  toSideAnswer,
  type QueryFn,
} from '@dsh-raw-agent/backend-claude';

const SID = 's-1';

/** Rows as `commands_changed` / `supportedCommands()` carry them (probe5, shortened). */
const ROWS = [
  { name: 'deep-research', description: 'Deep research harness (dynamic workflow)', argumentHint: '', builtin: true },
  {
    name: 'my-plugin:review',
    description: '(my-plugin) Review a change',
    argumentHint: '[quick] <id>',
    aliases: ['review-it'],
  },
  {
    name: 'clear',
    description: 'Start a new session with empty context',
    argumentHint: '[name]',
    aliases: ['reset', 'new'],
    builtin: true,
  },
  { name: 'context', description: 'Show current context usage', argumentHint: '', builtin: true },
  { name: 'usage', description: 'Show session cost', argumentHint: '', aliases: ['cost', 'stats'], builtin: true },
  { name: 'doctor', description: 'Health-check the setup', argumentHint: '', builtin: true },
  { name: 'outlook:scheduler (MCP)', description: 'A prompt template', argumentHint: '' },
  { name: 'my-command', description: 'A project command', argumentHint: '<file>' },
];

const INIT = {
  type: 'system',
  subtype: 'init',
  session_id: SID,
  model: 'claude-sonnet-5-5',
  claude_code_version: '2.1.318',
  slash_commands: ['deep-research', 'my-plugin:review', 'clear', 'context', 'usage', 'doctor', 'my-command'],
  skills: ['deep-research', 'my-plugin:review'],
  terminal_slash_commands: ['doctor'],
  mcp_servers: [
    { name: 'outlook', status: 'pending', source: 'user' },
    { name: 'plugin:my-plugin:builder', status: 'pending', source: 'plugin' },
  ],
};

const ZERO_USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

function synthetic(id: string, text: string, extra: Record<string, unknown>) {
  return {
    type: 'assistant',
    message: { id, model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }], usage: ZERO_USAGE },
    parent_tool_use_id: null,
    session_id: SID,
    uuid: `u-${id}`,
    ...extra,
  };
}

function localResult(name: string, inputId: string) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 0,
    result: '',
    duration_api_ms: 0,
    usage: ZERO_USAGE,
    modelUsage: {},
    total_cost_usd: 0,
    local_command: name,
    user_message_uuids: [inputId],
    session_id: SID,
  };
}

/** The `/context` twin on the synthetic message (snake_case, probe5). */
const CONTEXT_TWIN = {
  model: 'claude-sonnet-5-5',
  total_tokens: 27203,
  raw_max_tokens: 1000000,
  percentage: 3,
  categories: [
    { name: 'System prompt', tokens: 1134, kind: 'used' },
    { name: 'MCP tools (deferred)', tokens: 150432, kind: 'deferred' },
    { name: 'Messages', tokens: 5338, kind: 'used' },
    { name: 'Autocompact buffer', tokens: 33000, kind: 'buffer' },
    { name: 'Free space', tokens: 939797, kind: 'free' },
  ],
  mcp_tools: [{ name: 'mcp__outlook__calendar_view', server_name: 'outlook', tokens: 412 }],
  memory_files: [],
  agents: [{ agent_type: 'my-plugin:coder', source: 'plugin', tokens: 122 }],
  skills: [{ name: 'my-plugin:review', source: 'plugin', plugin_name: 'my-plugin', tokens: 216 }],
};

describe('the / menu (R7.1, D52)', () => {
  it('keeps names byte for byte and marks builtin, skill, MCP prompt, custom and terminal-only rows', () => {
    const c = new CommandCatalog();
    c.init(INIT);
    const list = c.rows(ROWS);
    expect(list.map((r) => r.name)).toEqual(ROWS.map((r) => r.name));
    const by = new Map(list.map((r) => [r.name, r]));
    expect(by.get('deep-research')).toEqual({
      name: 'deep-research',
      description: 'Deep research harness (dynamic workflow)',
      kind: 'builtin', // a built-in skill stays built-in
    });
    expect(by.get('my-plugin:review')).toEqual({
      name: 'my-plugin:review',
      description: '(my-plugin) Review a change',
      argumentHint: '[quick] <id>',
      aliases: ['review-it'],
      kind: 'skill',
    });
    expect(by.get('usage')?.aliases).toEqual(['cost', 'stats']);
    expect(by.get('doctor')?.terminalOnly).toBe(true);
    expect(by.get('outlook:scheduler (MCP)')?.kind).toBe('mcp-prompt');
    expect(by.get('my-command')).toEqual({
      name: 'my-command',
      description: 'A project command',
      argumentHint: '<file>',
      kind: 'custom',
    });
  });

  it('toCommandInfo drops empty hints and aliases', () => {
    expect(toCommandInfo({ name: 'x', description: '', argumentHint: '', aliases: [''] })).toEqual({
      name: 'x',
      kind: 'custom',
    });
  });

  it('init announces names only, then commands_changed replaces the list with full rows', () => {
    const m = new ClaudeMessageMapper(new SentInputTracker());
    const out = m.map(INIT);
    const cmds = out.find((e) => e.type === 'commands');
    expect(cmds).toMatchObject({ type: 'commands', namesOnly: true });
    expect(cmds?.type === 'commands' && cmds.list.map((c) => c.name)).toEqual(INIT.slash_commands);
    expect(cmds?.type === 'commands' && cmds.list.find((c) => c.name === 'my-plugin:review')?.kind).toBe('skill');
    expect(out.find((e) => e.type === 'mcp-status')).toEqual({
      type: 'mcp-status',
      servers: [
        { name: 'outlook', status: 'pending', source: 'user' },
        { name: 'plugin:my-plugin:builder', status: 'pending', source: 'plugin' },
      ],
    });
    const changed = m.map({ type: 'system', subtype: 'commands_changed', commands: ROWS.slice(0, 2), session_id: SID });
    expect(changed).toEqual([
      {
        type: 'commands',
        list: [
          expect.objectContaining({ name: 'deep-research', kind: 'builtin' }),
          expect.objectContaining({ name: 'my-plugin:review', kind: 'skill' }),
        ],
      },
    ]);
    // A later init (each turn re-sends it) keeps the full rows.
    const again = m.map(INIT).find((e) => e.type === 'commands');
    expect(again?.type === 'commands' && again.namesOnly).toBeFalsy();
    expect(again?.type === 'commands' && again.list).toHaveLength(2);
  });

  it('a slash command goes to the CLI as the plain text the user typed (D52, dsh-seams R2.3)', () => {
    const input = { id: 'in-1', parts: [{ type: 'text' as const, text: '/my-plugin:review quick 42' }] };
    const msg = toSdkUserMessage(input, 'queue') as unknown as Record<string, unknown>;
    expect(msg.message).toEqual({ role: 'user', content: [{ type: 'text', text: '/my-plugin:review quick 42' }] });
    expect(msg.origin).toEqual({ kind: 'human' });
    expect(slashCommandOf(input)).toEqual({ name: 'my-plugin:review', args: 'quick 42' });
    expect(slashCommandOf({ id: 'x', parts: [{ type: 'text', text: '/context' }] })).toEqual({
      name: 'context',
      args: '',
    });
    expect(slashCommandOf({ id: 'x', parts: [{ type: 'text', text: 'please run /context' }] })).toBeUndefined();
    expect(slashCommandOf({ id: 'x', parts: [{ type: 'text', text: '// a comment' }] })).toBeUndefined();
    expect(slashCommandOf({ id: 'x', parts: [{ type: 'file', hostPath: '/a' }] })).toBeUndefined();
  });
});

describe('local command output (R7.2, D53, D69)', () => {
  function run(frames: unknown[], sent: string[] = ['in-1']) {
    const tracker = new SentInputTracker();
    for (const id of sent) tracker.sent(id);
    const m = new ClaudeMessageMapper(tracker);
    const out: BackendEvent[] = [];
    let at = 1000;
    for (const f of frames) out.push(...m.map(f, (at += 5)));
    return { m, out };
  }

  it('/context: a text step with the structured twin, no usage, and the ring untouched', () => {
    const text = '## Context Usage\n\n**Tokens:** 27.2k / 1m (3%)';
    const { out } = run([
      { type: 'command_lifecycle', command_uuid: 'in-1', state: 'started', session_id: SID },
      INIT,
      synthetic('a1', text, {
        local_command_source: `<local-command-stdout>${text}</local-command-stdout>`,
        local_command_run: { command: 'context', args: '' },
        context_usage: CONTEXT_TWIN,
      }),
      localResult('context', 'in-1'),
    ]);
    const msg = out.find((e) => e.type === 'step-message');
    expect(msg).toMatchObject({ synthetic: true, final: true, blocks: [{ type: 'text', text }] });
    expect(msg?.type === 'step-message' && msg.usage).toBeUndefined();
    expect(msg?.type === 'step-message' && msg.localCommand).toEqual({
      name: 'context',
      structured: {
        kind: 'context',
        context: {
          used: 27203,
          window: 1000000,
          percent: 3,
          model: 'claude-sonnet-5-5',
          categories: CONTEXT_TWIN.categories,
          details: {
            mcpTools: [{ name: 'mcp__outlook__calendar_view', server: 'outlook', tokens: 412 }],
            agents: [{ name: 'my-plugin:coder', source: 'plugin', tokens: 122 }],
            skills: [{ name: 'my-plugin:review', source: 'plugin', plugin: 'my-plugin', tokens: 216 }],
          },
        },
      },
    });
    // The local command counted nothing: no context meter or usage figure moves (R7.2).
    expect(out.filter((e) => e.type === 'context')).toEqual([]);
    expect(out.filter((e) => e.type === 'usage')).toEqual([]);
    // It answers our input, so its result ends the DSH turn (M5).
    expect(out.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed', pendingInputs: 0 });
    expect(out.map((e) => e.type)).toEqual([
      'input-consumed',
      'session-info',
      'commands',
      'mcp-status',
      'turn-start',
      'step-start',
      'step-message',
      'turn-end',
    ]);
  });

  it('/cost: the CLI gives text only; it is named by its run record (usage, as the CLI resolves the alias)', () => {
    const text = 'Total cost:            $0.0550\nTotal duration (API):  4s';
    const { out } = run([
      synthetic('a2', text, {
        local_command_source: `<local-command-stdout>${text}</local-command-stdout>`,
        local_command_run: { command: 'usage', args: '' },
      }),
      localResult('cost', 'in-1'),
    ]);
    const msg = out.find((e) => e.type === 'step-message');
    expect(msg?.type === 'step-message' && msg.localCommand).toEqual({ name: 'usage' });
    expect(msg?.type === 'step-message' && msg.usage).toBeUndefined();
  });

  it('a terminal-only command says so in the CLI’s words, marked unavailable', () => {
    const text = "/help isn't available in this environment.";
    const info = localCommandOf(
      synthetic('a3', text, {
        local_command_source: `<local-command-stdout>${text}</local-command-stdout>`,
        local_command_outcome: { kind: 'unavailable_headless' },
      }),
    );
    expect(info).toEqual({ name: 'help', unavailable: true });
  });

  it('an API error message is not a local command', () => {
    expect(localCommandOf({ type: 'assistant', error: 'rate_limit' })).toBeUndefined();
  });

  it('system/local_command_output (declared, not seen on 2.1.318) is a named synthetic step', () => {
    const tracker = new SentInputTracker();
    const m = new ClaudeMessageMapper(tracker);
    tracker.sent('in-1');
    m.noteSlashCommand(slashCommandOf({ id: 'in-1', parts: [{ type: 'text', text: '/mcp reconnect outlook' }] }));
    const out = m.map(
      { type: 'system', subtype: 'local_command_output', content: 'Reconnected.', uuid: 'lo-1', session_id: SID },
      5,
    );
    expect(out).toEqual([
      { type: 'turn-start', origin: 'user' },
      { type: 'step-start', agent: { kind: 'main' }, stepId: 'lo-1', at: 5, synthetic: true },
      {
        type: 'step-message',
        agent: { kind: 'main' },
        stepId: 'lo-1',
        blocks: [{ type: 'text', text: 'Reconnected.' }],
        final: true,
        synthetic: true,
        localCommand: { name: 'mcp', args: 'reconnect outlook' },
        lastChainId: 'lo-1',
      },
    ]);
    expect(m.map({ type: 'system', subtype: 'local_command_output', content: '', session_id: SID })).toEqual([]);
  });

  it('a local output with no name of its own takes the sent command’s name once', () => {
    const tracker = new SentInputTracker();
    const m = new ClaudeMessageMapper(tracker);
    m.noteSlashCommand({ name: 'compact', args: 'keep the tests' });
    const out = m.map(
      synthetic('a4', 'Compacted', { local_command_source: '<local-command-stdout>Compacted</local-command-stdout>' }),
    );
    const msg = out.find((e) => e.type === 'step-message');
    expect(msg?.type === 'step-message' && msg.localCommand).toEqual({ name: 'compact', args: 'keep the tests' });
    const later = m.map(
      synthetic('a5', 'x', { local_command_source: '<local-command-stdout>x</local-command-stdout>' }),
    );
    const msg2 = later.find((e) => e.type === 'step-message');
    expect(msg2?.type === 'step-message' && msg2.localCommand).toEqual({});
  });

  it('a plain prompt or a turn end drops the noted name; a line sent mid-turn waits for its turn', () => {
    const tracker = new SentInputTracker();
    const nameOf = (m: ClaudeMessageMapper, uuid: string) => {
      const out = m.map({ type: 'system', subtype: 'local_command_output', content: 'x', uuid, session_id: SID }, 1);
      const msg = out.find((e) => e.type === 'step-message');
      return msg?.type === 'step-message' ? msg.localCommand : undefined;
    };
    const a = new ClaudeMessageMapper(tracker);
    a.noteSlashCommand({ name: 'mcp', args: '' });
    a.noteSlashCommand(slashCommandOf({ id: 'p', parts: [{ type: 'text', text: 'a plain prompt' }] }));
    expect(nameOf(a, 'l1')).toEqual({});
    const b = new ClaudeMessageMapper(tracker);
    b.noteSlashCommand({ name: 'mcp', args: '' });
    b.map({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: '', session_id: SID }, 2);
    expect(nameOf(b, 'l2')).toEqual({});
    // Mid-turn: the running turn's result keeps it for the next turn's output.
    const c = new ClaudeMessageMapper(tracker);
    c.map(synthetic('t1', 'busy'));
    c.noteSlashCommand({ name: 'mcp', args: 'reconnect x' });
    c.map({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: '', session_id: SID }, 3);
    expect(nameOf(c, 'l3')).toEqual({ name: 'mcp', args: 'reconnect x' });
  });
});

describe('MCP status shapes (R7.4, D55)', () => {
  it('keeps state, scope, source, server info and tools; never config values', () => {
    expect(
      toMcpServerInfo({
        name: 'outlook',
        status: 'connected',
        serverInfo: { name: 'outlook-mcp', version: '1.2.0' },
        config: {
          type: 'http',
          url: 'https://x.example/mcp?token=SECRET',
          headers: { Authorization: 'Bearer SECRET' },
        },
        scope: 'user',
        source: 'user',
        tools: [
          { name: 'calendar_view', description: 'View', annotations: { readOnly: true } },
          { name: 'email_send', annotations: { destructive: true } },
          { bad: 1 },
        ],
      }),
    ).toEqual({
      name: 'outlook',
      status: 'connected',
      serverName: 'outlook-mcp',
      serverVersion: '1.2.0',
      transport: 'http',
      scope: 'user',
      source: 'user',
      tools: [
        { name: 'calendar_view', description: 'View', readOnly: true },
        { name: 'email_send', destructive: true },
      ],
    });
    expect(
      JSON.stringify(
        toMcpServerInfo({
          name: 's',
          status: 'failed',
          error: 'boom',
          config: { command: 'srv', env: { KEY: 'SECRET' } },
        }),
      ),
    ).not.toContain('SECRET');
    expect(toMcpServerInfo({ name: 's', status: 'failed', config: { command: 'srv' } })?.transport).toBe('stdio');
    expect(toMcpServerInfo({ status: 'connected' })).toBeUndefined();
    expect(toMcpServerInfo({ name: 'n', status: 'needs-auth' })?.status).toBe('needs-auth');
  });

  it('reads the sign-in answer (unverified shape, CLI 2.1.318 binary)', () => {
    expect(
      toMcpAuthStart({
        authUrl: 'https://auth.example/x',
        requiresUserAction: true,
        callbackExpected: true,
        callbackPort: 1,
      }),
    ).toEqual({
      url: 'https://auth.example/x',
      needsUserAction: true,
      callbackExpected: true,
    });
    expect(toMcpAuthStart({ requiresUserAction: false, callbackExpected: false })).toEqual({
      needsUserAction: false,
      callbackExpected: false,
    });
  });
});

describe('side questions (R7.3, D54)', () => {
  it('history keeps the last 20 non-synthetic answers, with the fallback notice, and clears on reset', () => {
    const h = new SideQuestionHistory();
    expect(h.record('q0', { text: '(No answer available…)', synthetic: true })).toBe(false);
    expect(h.record('q0', null)).toBe(false);
    for (let i = 1; i <= 22; i++) h.record(`q${i}`, { text: `a${i}`, synthetic: false });
    expect(h.size).toBe(20);
    expect(h.list()[0]).toEqual({ question: 'q3', answer: 'a3' });
    h.record('q23', {
      text: 'a23',
      synthetic: false,
      fallback: { originalModel: 'm1', fallbackModel: 'm2', content: 'Answered by m2.' },
    });
    expect(h.list().at(-1)).toEqual({ question: 'q23', answer: 'a23', fallbackNotice: 'Answered by m2.' });
    const copy = h.list();
    copy.pop();
    expect(h.size).toBe(20); // list() is a copy
    h.clear();
    expect(h.list()).toEqual([]);
  });

  it('wire history is the TUI’s shape, at most 20; answers keep synthetic and the fallback', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ question: `q${i}`, answer: `a${i}` }));
    const wire = sideHistoryWire([...many, { question: 'qf', answer: 'af', fallbackNotice: 'n' }]);
    expect(wire).toHaveLength(20);
    expect(wire.at(-1)).toEqual({ question: 'qf', response: 'af', fallback_notice: 'n' });
    expect(wire[0]).toEqual({ question: 'q6', response: 'a6' });
    expect(toSideAnswer(null)).toBeNull();
    expect(toSideAnswer({ response: 'ORCHID', synthetic: false })).toEqual({ text: 'ORCHID', synthetic: false });
    expect(
      toSideAnswer({
        response: 'x',
        synthetic: false,
        refusalFallback: { originalModel: 'a', fallbackModel: 'b', content: 'c' },
      }),
    ).toEqual({ text: 'x', synthetic: false, fallback: { originalModel: 'a', fallbackModel: 'b', content: 'c' } });
  });
});

// ---- session controls ----

interface FakeOpts {
  missing?: string[];
  unsupported?: string[];
}

function fakeQuery(opts: FakeOpts = {}) {
  const out = new AsyncQueue<unknown>();
  const calls: Array<[string, unknown[]]> = [];
  const refuse = (name: string) => {
    if (opts.unsupported?.includes(name)) throw new Error(`Unsupported control request subtype: ${name}`);
  };
  const methods: Record<string, (...a: unknown[]) => Promise<unknown>> = {
    supportedCommands: async () => ROWS,
    getContextUsage: async (...a) => (
      calls.push(['getContextUsage', a]),
      {
        totalTokens: 1,
        maxTokens: 10,
        categories: [],
        skills: {
          totalSkills: 1,
          skillFrontmatter: [
            { name: 'my-plugin:review', source: 'plugin', pluginName: 'my-plugin', path: '/p', tokens: 216 },
          ],
        },
      }
    ),
    askSideQuestion: async (question, o) => {
      calls.push(['askSideQuestion', [question, o]]);
      refuse('side_question');
      const signal = (o as { signal?: AbortSignal }).signal;
      if (question === 'slow')
        return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      if (question === 'nothing') return { response: '(No answer available…)', synthetic: true };
      return { response: 'ORCHID', synthetic: false };
    },
    mcpServerStatus: async () => {
      refuse('mcp_status');
      return [{ name: 'outlook', status: 'needs-auth', config: { type: 'http', headers: { a: 'SECRET' } } }];
    },
    reconnectMcpServer: async (...a) => {
      calls.push(['reconnectMcpServer', a]);
      if (a[0] === 'nope') throw new Error('Server not found: nope');
    },
    toggleMcpServer: async (...a) => void calls.push(['toggleMcpServer', a]),
    mcpAuthenticate: async (...a) => (
      calls.push(['mcpAuthenticate', a]),
      refuse('mcp_authenticate'),
      { authUrl: 'https://auth.example/a', requiresUserAction: true, callbackExpected: true }
    ),
    mcpSubmitOAuthCallbackUrl: async (...a) => void calls.push(['mcpSubmitOAuthCallbackUrl', a]),
  };
  const q: Record<string | symbol, unknown> = {
    [Symbol.asyncIterator]: () => out[Symbol.asyncIterator](),
    interrupt: async () => ({ still_queued: [] }),
    close: () => out.end(),
  };
  for (const [k, v] of Object.entries(methods)) if (!opts.missing?.includes(k)) q[k] = v;
  const queryFn: QueryFn = () => {
    process.env.CLAUDE_AGENT_SDK_VERSION = '0.3.318';
    return q as never;
  };
  return { out, calls, queryFn };
}

const noInteractions: InteractionHandler = {
  permission: async () => ({ optionId: 'reject' }),
  question: async () => null,
  plan: async () => ({ kind: 'keep-planning' }),
  elicitation: async () => ({ action: 'decline' }),
};

async function openSession(opts?: FakeOpts) {
  const fake = fakeQuery(opts);
  const factory = createClaudeFactory({ queryFn: fake.queryFn });
  const dir = mkdtempSync(join(tmpdir(), 'raw-agent-cmd-'));
  const exe = join(dir, 'claude');
  writeFileSync(exe, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const session = await factory.open({
    cwd: '/tmp',
    env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: join(dir, '.claude') },
    start: { kind: 'new', sessionId: factory.sessionIdFor!('cmd-session') },
    userConfig: { executablePath: exe, options: {} },
    interactions: noInteractions,
    signal: new AbortController().signal,
  });
  const events: BackendEvent[] = [];
  const reader = (async () => {
    for await (const e of session.events()) events.push(e);
  })();
  return { fake, session, events, reader };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

describe.skipIf(process.platform === 'win32')('session controls for commands, skills, MCP and /btw', () => {
  it('commands and skills come from the live process, marked by the init lists', async () => {
    const { fake, session, reader } = await openSession();
    fake.out.push(INIT);
    await flush();
    const cmds = await session.controls.commands!();
    expect(cmds.find((c) => c.name === 'my-plugin:review')?.kind).toBe('skill');
    expect(cmds.find((c) => c.name === 'doctor')?.terminalOnly).toBe(true);
    expect(await session.controls.skills!()).toEqual([
      { name: 'deep-research', description: 'Deep research harness (dynamic workflow)' },
      {
        name: 'my-plugin:review',
        description: '(my-plugin) Review a change',
        argumentHint: '[quick] <id>',
        source: 'plugin',
        plugin: 'my-plugin',
        tokens: 216,
      },
    ]);
    // The skill read uses the summary context report: no token-count calls (M5).
    expect(fake.calls.filter((c) => c[0] === 'getContextUsage').map((c) => c[1])).toContainEqual([
      { detail: 'summary' },
    ]);
    await session.dispose();
    await reader;
  });

  it('before init, skills come from the /context skill rows', async () => {
    const { session, reader } = await openSession();
    expect((await session.controls.skills!()).map((s) => s.name)).toEqual(['my-plugin:review']);
    await session.dispose();
    await reader;
  });

  it('/btw: history in the TUI shape, works mid-turn, cancels to null, writes no event', async () => {
    const { fake, session, events, reader } = await openSession();
    expect(session.capabilities.sideQuestions).toBe(true);
    // A turn is running (a stream started, no result yet).
    fake.out.push({ type: 'system', subtype: 'status', status: 'requesting', session_id: SID });
    fake.out.push({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } }, session_id: SID });
    await flush();
    const before = events.length;
    const history = new SideQuestionHistory();
    history.record('Which fruit?', { text: 'Mango', synthetic: false });
    const answer = await session.controls.askSideQuestion!(
      'What colour?',
      history.list(),
      new AbortController().signal,
    );
    expect(answer).toEqual({ text: 'ORCHID', synthetic: false });
    const [, [q, o]] = fake.calls.find((c) => c[0] === 'askSideQuestion')!;
    expect(q).toBe('What colour?');
    expect((o as { history: unknown }).history).toEqual([{ question: 'Which fruit?', response: 'Mango' }]);
    // No history: none passed (as the SDK omits an empty list).
    await session.controls.askSideQuestion!('again', [], new AbortController().signal);
    expect(Object.keys(fake.calls.filter((c) => c[0] === 'askSideQuestion')[1]![1][1] as object)).toEqual(['signal']);
    // Synthetic answer: shown, not kept.
    const nothing = await session.controls.askSideQuestion!('nothing', [], new AbortController().signal);
    expect(nothing?.synthetic).toBe(true);
    expect(history.record('nothing', nothing)).toBe(false);
    // Cancel.
    const ac = new AbortController();
    const slow = session.controls.askSideQuestion!('slow', [], ac.signal);
    ac.abort();
    expect(await slow).toBeNull();
    await flush();
    expect(events.length).toBe(before); // nothing reaches the event stream (and so no log)
    await session.dispose();
    await reader;
  });

  it('/btw on a CLI that refuses side_question: a plain error, and the capability turns off (D9)', async () => {
    const { session, reader } = await openSession({ unsupported: ['side_question'] });
    await expect(session.controls.askSideQuestion!('q', [], new AbortController().signal)).rejects.toThrow(
      /cannot answer side questions/,
    );
    expect(session.capabilities.sideQuestions).toBe(false);
    await session.dispose();
    await reader;
  });

  it('an SDK without askSideQuestion or the MCP auth controls offers none of them', async () => {
    const { session, reader } = await openSession({
      missing: ['askSideQuestion', 'mcpAuthenticate', 'mcpSubmitOAuthCallbackUrl'],
    });
    expect(session.capabilities.sideQuestions).toBe(false);
    expect(session.controls.askSideQuestion).toBeUndefined();
    expect(session.controls.mcpAuthenticate).toBeUndefined();
    expect(session.controls.mcpSubmitAuthCallback).toBeUndefined();
    expect(session.controls.mcpStatus).toBeDefined();
    await session.dispose();
    await reader;
  });

  it('MCP: status without config values, reconnect, toggle with the backend note, sign-in', async () => {
    const { fake, session, reader } = await openSession();
    const status = await session.controls.mcpStatus!();
    expect(status).toEqual([{ name: 'outlook', status: 'needs-auth', transport: 'http' }]);
    expect(JSON.stringify(status)).not.toContain('SECRET');
    await session.controls.mcpReconnect!('outlook');
    await expect(session.controls.mcpReconnect!('nope')).rejects.toThrow(/Server not found: nope/);
    expect(await session.controls.mcpToggle!('outlook', false)).toEqual({ note: MCP_TOGGLE_NOTE });
    expect(await session.controls.mcpAuthenticate!('outlook')).toEqual({
      url: 'https://auth.example/a',
      needsUserAction: true,
      callbackExpected: true,
    });
    await session.controls.mcpSubmitAuthCallback!('outlook', 'http://localhost:1/cb?code=x');
    expect(fake.calls.filter((c) => c[0] !== 'getContextUsage')).toEqual([
      ['reconnectMcpServer', ['outlook']],
      ['reconnectMcpServer', ['nope']],
      ['toggleMcpServer', ['outlook', false]],
      ['mcpAuthenticate', ['outlook']],
      ['mcpSubmitOAuthCallbackUrl', ['outlook', 'http://localhost:1/cb?code=x']],
    ]);
    await session.dispose();
    await reader;
  });

  it('MCP on a CLI that refuses the control: a plain error (D9)', async () => {
    const { session, reader } = await openSession({ unsupported: ['mcp_status', 'mcp_authenticate'] });
    await expect(session.controls.mcpStatus!()).rejects.toThrow(/cannot report its MCP servers/);
    await expect(session.controls.mcpAuthenticate!('outlook')).rejects.toThrow(/cannot sign in to an MCP server/);
    await session.dispose();
    await reader;
  });

  it('a sent slash command names a later unnamed local output (R7.2)', async () => {
    const { fake, session, events, reader } = await openSession();
    await session.send({ id: 'in-9', parts: [{ type: 'text', text: '/mcp' }] }, 'queue');
    fake.out.push({
      type: 'system',
      subtype: 'local_command_output',
      content: '2 MCP server(s)',
      uuid: 'lo-9',
      session_id: SID,
    });
    await flush();
    const msg = events.find((e) => e.type === 'step-message');
    expect(msg?.type === 'step-message' && msg.localCommand).toEqual({ name: 'mcp' });
    await session.dispose();
    await reader;
  });
});
