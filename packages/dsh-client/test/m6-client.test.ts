// M6 client-commands (R7.1-R7.5; D19, D52-D56, D69, D70): the tool view registration and its
// session scoping, the side-question panel, the MCP and commands panel, the local command nodes
// in the chat, the M6 routes and channel fields, and the view-only leftovers (diff line numbers,
// the workflow launch preview).

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CLAUDE_TOOL_VIEWS, toolViewPack } from '@dsh-raw-agent/views-claude';
import {
  CommandList,
  DSH_TOOL_VIEW_KEYS,
  Divider,
  LOCAL_COMMAND_DEFINITION_KIND,
  LOCAL_COMMAND_NODE_KIND,
  LocalCommandView,
  LocalContextView,
  McpPanel,
  PreviewView,
  ScopedToolView,
  SessionControlStore,
  SessionStores,
  SidePanelBody,
  TOOL_VIEW_SLOT,
  clearedText,
  commandRowText,
  createApi,
  filterCommands,
  localCommandDefinition,
  localCommandOf,
  localTextFormat,
  localRender,
  mcpActions,
  mcpButtonLabel,
  mcpLevel,
  parseChannelLine,
  permissionPreview,
  registerToolViews,
  sideNote,
  sideShouldOpen,
  sideStatusText,
  signInUrl,
  toolViewNames,
  toolViewPropsOf,
  type ChannelLine,
  type CommandRowWire,
  type FetchFn,
  type HostActions,
  type RawAgentApi,
  type SessionInfo,
  type SideViewWire,
} from '@dsh-raw-agent/dsh-client';

const flush = () => new Promise((r) => setTimeout(r, 0));

function info(view: Partial<SessionInfo['view']> = {}, kind = 'claude-code'): SessionInfo {
  return {
    backend: { kind, displayName: 'Agent' },
    permissionModes: [{ id: 'default', label: 'Ask' }],
    efforts: [],
    needsProcess: [],
    models: [],
    modelsFrom: 'session',
    view: {
      state: { process: 'running', turn: false, backgroundTasks: 0 },
      live: {},
      choice: { applied: {}, resetPending: false, agentLocked: false },
      ...view,
    },
  } as SessionInfo;
}

const noActions: HostActions = {
  openPreview: () => false,
  openTerminal: () => false,
  copy: async () => true,
  portal: (n) => n,
};

function api(sessions: Record<string, SessionInfo | 404>, over: Partial<RawAgentApi> = {}): RawAgentApi {
  return {
    ...createApi(async () => ({ status: 500, ok: false, json: async () => ({}) })),
    session: async (id) => {
      const s = sessions[id];
      if (s === undefined || s === 404) {
        const { RouteError } = await import('@dsh-raw-agent/dsh-client');
        throw new RouteError(404, 'not ours');
      }
      return s;
    },
    ...over,
  };
}

/** A fetch that records calls and answers from a table. */
function recordingFetch(answers: Record<string, { status: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', ...(init?.body ? { body: init.body } : {}) });
    const key = Object.keys(answers).find((k) => url.includes(k));
    const a = key ? answers[key]! : { status: 404, body: { error: 'none' } };
    return { status: a.status, ok: a.status >= 200 && a.status < 300, json: async () => a.body };
  };
  return { calls, fetchFn };
}

// ---- D19: tool views -----------------------------------------------------------------------------

describe('tool views (D19)', () => {
  it('never registers an MCP name or a key a DSH package uses', () => {
    const pack = {
      kind: 'k',
      views: { Bash: () => null, bash: () => null, mcp__srv__tool: () => null, '': () => null },
    };
    expect(toolViewNames(pack)).toEqual(['Bash']);
    // The Claude pack has no overlap with DSH 0.2.2-rc.1's own keys.
    const dsh = new Set(DSH_TOOL_VIEW_KEYS);
    expect(Object.keys(CLAUDE_TOOL_VIEWS).filter((n) => dsh.has(n))).toEqual([]);
    expect(toolViewNames(toolViewPack).length).toBe(Object.keys(CLAUDE_TOOL_VIEWS).length);
  });

  it('registers one keyed entry per name, through the slot generator', () => {
    const registered: Array<Record<string, unknown>> = [];
    const slots = {
      inject: (key: string, cb: () => unknown) => {
        expect(key).toBe(TOOL_VIEW_SLOT);
        Array.from(cb() as Iterable<unknown>);
        return () => {};
      },
      register: (o: Record<string, unknown>) => (registered.push(o), () => {}),
    };
    const stores = new SessionStores(api({}));
    const names = registerToolViews(slots, [toolViewPack, { kind: 'other', views: { Bash: () => null } }], stores);
    expect(names).toEqual(Object.keys(CLAUDE_TOOL_VIEWS));
    expect(registered.map((o) => o.key)).toEqual(names);
    const injected = (registered[0]!.inject as (id: string) => Record<string, unknown>)('s1');
    expect(injected.sessionId).toBe('s1');
    expect(injected.kind).toBe('claude-code'); // first pack wins the name
    stores.dispose();
  });

  it('turns DSH call records into the neutral props', () => {
    const start = toolViewPropsOf({
      callId: 'c',
      toolName: 'Bash',
      phase: 'start',
      block: { argsRaw: '{"command":"ls"}' },
      cwd: '/w',
    });
    expect(start).toMatchObject({ phase: 'running', input: { command: 'ls' }, cwd: '/w' });
    const done = toolViewPropsOf({
      callId: 'c',
      toolName: 'Read',
      phase: 'result',
      block: {
        call: { name: 'Read', argsRaw: '{"file_path":"/w/a"}' },
        content: [{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }],
        isError: false,
        callTime: 1000,
        time: 1500,
      },
    });
    expect(done.result).toEqual({ text: 'one\ntwo', isError: false, images: 1, durationMs: 500 });
    const fields: Record<string, unknown> = { skill: 'rev' };
    const prep = toolViewPropsOf({
      callId: 'c',
      toolName: 'Skill',
      phase: 'preparing',
      block: { args: { keys: () => Object.keys(fields), value: (k) => fields[k] } },
    });
    expect(prep).toMatchObject({ phase: 'preparing', input: { skill: 'rev' } });
    const opened: unknown[] = [];
    const p = toolViewPropsOf({
      callId: 'c',
      toolName: 'Read',
      phase: 'start',
      block: {},
      openFile: (...a) => opened.push(a),
    });
    p.openFile?.('/x', 4);
    expect(opened).toEqual([['/x', { line: 4 }]]);
  });

  it('draws the pack view only in sessions of its backend; elsewhere the plain row', async () => {
    const stores = new SessionStores(api({ ours: info(), std: 404, other: info({}, 'codex') }));
    for (const id of ['ours', 'std', 'other']) await stores.get(id).refresh();
    const owner = { callId: 'c', toolName: 'Skill', phase: 'start' as const, block: { argsRaw: '{"skill":"deploy"}' } };
    const draw = (sessionId: string) =>
      renderToStaticMarkup(
        React.createElement(ScopedToolView, {
          ...owner,
          sessionId,
          stores,
          kind: 'claude-code',
          view: CLAUDE_TOOL_VIEWS.Skill!,
        }),
      );
    expect(draw('ours')).toContain('data-raw-agent="tool-skill"');
    expect(draw('std')).toContain('data-raw-agent="tool-plain"');
    expect(draw('std')).toContain('Tool call · Skill');
    expect(draw('other')).toContain('data-raw-agent="tool-plain"');
    stores.dispose();
  });
});

// ---- R7.3, D54: side questions -------------------------------------------------------------------

const side = (over: Partial<SideViewWire> = {}): SideViewWire => ({
  entries: [
    { id: 'q1', question: 'What did we change?', status: 'answered', at: 1000, answer: 'We changed **a.ts**.' },
    { id: 'q2', question: 'And why?', status: 'asking', at: 5000 },
  ],
  historySize: 1,
  ...over,
});

describe('side questions (R7.3)', () => {
  it('opens for a new question and stays closed for a dismissed one', () => {
    expect(sideShouldOpen(side(), undefined)).toBe(true);
    expect(sideShouldOpen(side(), 'q2')).toBe(false);
    expect(sideShouldOpen(side(), 'q1')).toBe(true);
    expect(sideShouldOpen({ entries: [], historySize: 0 }, undefined)).toBe(false);
  });

  it('says what each question waits for', () => {
    const [a, b] = side().entries;
    expect(sideStatusText(b!, 'Agent', 8000)).toBe('Thinking… 3s');
    expect(sideStatusText({ ...a!, status: 'waiting' }, 'Agent')).toContain('Waiting for Agent to start');
    expect(sideStatusText({ ...a!, status: 'failed', error: 'no process' }, 'Agent')).toBe('No answer: no process');
    expect(sideStatusText(a!, 'Agent')).toBeUndefined();
    expect(sideNote('Agent', 1)).toContain('Nothing here is added to the conversation');
  });

  it('renders the history, the answer, Cancel and the box', () => {
    const html = renderToStaticMarkup(
      React.createElement(SidePanelBody, {
        side: side(),
        displayName: 'Agent',
        busy: false,
        now: 6000,
        onAsk: () => {},
        onCancel: () => {},
        onStart: () => {},
        onClose: () => {},
      }),
    );
    expect(html).toContain('data-raw-agent="side-panel"');
    expect(html).toContain('What did we change?');
    expect(html).toContain('<strong>a.ts</strong>');
    expect(html).toContain('data-raw-agent="side-cancel"');
    expect(html).toContain('Thinking… 1s');
    expect(html).toContain('data-raw-agent="side-input"');
  });

  it('asks and cancels through the plugin routes', async () => {
    const { calls, fetchFn } = recordingFetch({
      'side-question-cancel': { status: 200, body: { ok: true, side: side() } },
      'side-question': {
        status: 202,
        body: { ok: true, entry: { id: 'q3', question: 'x', status: 'waiting', at: 1 } },
      },
    });
    const a = createApi(fetchFn);
    const r = await a.askSide!('s 1', 'Why?');
    expect(r.ok).toBe(true);
    expect(calls[0]).toMatchObject({
      url: 'api/raw-agent/side-question?session=s%201',
      method: 'POST',
      body: '{"question":"Why?"}',
    });
    expect((await a.cancelSide!('s', 'q 2')).ok).toBe(true);
    expect(calls[1]!.url).toBe('api/raw-agent/side-question-cancel?session=s&id=q%202');
  });

  it('takes the side questions, the menu version and the MCP summary from the channel', async () => {
    const line = parseChannelLine(
      JSON.stringify({
        type: 'asks',
        asks: [],
        side: side(),
        menu: { version: 3, count: 40, full: true },
        mcp: [{ name: 'gh', status: 'failed' }, 7],
      }),
    ) as Extract<ChannelLine, { type: 'asks' }>;
    expect(line.side?.entries).toHaveLength(2);
    expect(line.menu?.version).toBe(3);
    expect(line.mcp).toEqual([{ name: 'gh', status: 'failed' }]);
    const cleared = parseChannelLine(JSON.stringify({ type: 'asks', asks: [], side: null })) as Extract<
      ChannelLine,
      { type: 'asks' }
    >;
    expect(cleared.side).toBeNull();

    let push: ((l: ChannelLine) => void) | undefined;
    const store = new SessionControlStore(
      's',
      api(
        { s: info() },
        {
          interactions: (_id, signal, onLine) =>
            new Promise<void>((resolve) => {
              push = onLine;
              signal.addEventListener('abort', () => resolve());
            }),
        },
      ),
    );
    const off = store.subscribe(() => {});
    await flush();
    await flush();
    push?.(line);
    expect(store.getSnapshot().info?.view.side?.entries[1]?.id).toBe('q2');
    expect(store.getSnapshot().info?.view.mcp).toEqual([{ name: 'gh', status: 'failed' }]);
    push?.(cleared);
    expect(store.getSnapshot().info?.view.side).toBeUndefined();
    off();
  });
});

// ---- R7.4, D55 and R7.1 ---------------------------------------------------------------------------

describe('MCP panel (R7.4)', () => {
  it('labels states and offers the agent controls', () => {
    expect(mcpLevel('connected')).toBe('ok');
    expect(mcpLevel('needs-auth')).toBe('warn');
    expect(mcpLevel('something-new')).toBe('pending');
    expect(mcpActions({ name: 'a', status: 'disabled' }, true)).toEqual({
      reconnect: false,
      toggle: 'enable',
      signIn: false,
    });
    expect(mcpActions({ name: 'a', status: 'needs-auth' }, true).signIn).toBe(true);
    expect(mcpActions({ name: 'a', status: 'failed' }, false).reconnect).toBe(false);
    expect(
      mcpButtonLabel([
        { name: 'a', status: 'connected' },
        { name: 'b', status: 'failed' },
      ]),
    ).toBe('MCP 1/2 ⚠');
    expect(mcpButtonLabel(undefined)).toBe('MCP');
    expect(signInUrl('javascript:alert(1)')).toBeUndefined();
    expect(signInUrl('https://idp.example/auth?x=1')).toBe('https://idp.example/auth?x=1');
  });

  it('renders status, error text and buttons; offers Start with no process', () => {
    const props = {
      sessionId: 's',
      api: api({}),
      actions: noActions,
      displayName: 'Agent',
      onStart: () => {},
      onClose: () => {},
    };
    const html = renderToStaticMarkup(
      React.createElement(McpPanel, {
        ...props,
        initial: {
          mcp: {
            running: true,
            from: 'live',
            servers: [
              { name: 'github', status: 'failed', error: 'spawn ENOENT', scope: 'user', transport: 'stdio' },
              { name: 'docs', status: 'disabled' },
              { name: 'linear', status: 'needs-auth' },
            ],
          },
        },
      }),
    );
    expect(html).toContain('spawn ENOENT');
    expect(html).toContain('user · stdio');
    expect(html).toContain('Reconnect');
    expect(html).toContain('Enable');
    expect(html).toContain('Disable');
    expect(html).toContain('Sign in');
    const idle = renderToStaticMarkup(
      React.createElement(McpPanel, {
        ...props,
        initial: { mcp: { running: false, from: 'reported', servers: [{ name: 'a', status: 'pending' }] } },
      }),
    );
    expect(idle).toContain('Start Agent');
    expect(idle).toContain('connecting');
  });

  it('calls the toggle, reconnect and callback routes with exact parameters', async () => {
    const { calls, fetchFn } = recordingFetch({
      'mcp-toggle': { status: 200, body: { ok: true, note: 'Saved by the agent.' } },
      'mcp-reconnect': { status: 502, body: { ok: false, code: 'failed', error: 'still down' } },
      'mcp-auth-callback': { status: 200, body: { ok: true } },
    });
    const a = createApi(fetchFn);
    expect((await a.mcpAction!('s', 'toggle', 'my server', false)).note).toBe('Saved by the agent.');
    expect(calls[0]!.url).toBe('api/raw-agent/mcp-toggle?session=s&server=my%20server&enabled=false');
    expect(await a.mcpAction!('s', 'reconnect', 'x')).toMatchObject({ ok: false, error: 'still down' });
    await a.mcpAuthCallback!('s', 'x', 'http://localhost:1/cb?code=1');
    expect(calls[2]).toMatchObject({ method: 'POST', body: '{"server":"x","url":"http://localhost:1/cb?code=1"}' });
  });
});

describe('agent commands (R7.1)', () => {
  const rows: CommandRowWire[] = [
    { name: 'review', description: 'Review a PR', argumentHint: '<pr>', kind: 'skill', menu: 'listed' },
    {
      name: 'model',
      description: 'Pick a model',
      kind: 'builtin',
      menu: 'taken',
      note: 'taken by DSH in this session',
    },
    { name: 'plugin:do', description: 'Do it', kind: 'custom', menu: 'terminal-only' },
    { name: 'btw', description: 'Side question', menu: 'side-question' },
    { name: 'usage', description: 'Show usage', aliases: ['cost', 'stats'], kind: 'builtin', menu: 'listed' },
  ];

  it('says where each command is and how to type it', () => {
    expect(commandRowText(rows[0]!, 'Agent')).toEqual({ line: '/review <pr>', where: 'in the / menu' });
    expect(commandRowText(rows[1]!, 'Agent').where).toContain('taken by DSH in this session');
    expect(commandRowText(rows[1]!, 'Agent').where).not.toContain('not in the / menu');
    expect(commandRowText(rows[2]!, 'Agent').where).toContain('terminal app');
    expect(filterCommands(rows, '/cos').map((r) => r.name)).toEqual(['usage']);
  });

  it('lists every row, with kind, aliases and notes', () => {
    const html = renderToStaticMarkup(
      React.createElement(CommandList, {
        answer: { running: true, from: 'live', full: true, rows },
        displayName: 'Agent',
        actions: noActions,
      }),
    );
    expect(html).toContain('/review &lt;pr&gt;');
    expect(html).toContain('skill');
    expect(html).toContain('also /cost, /stats');
    expect(html).toContain('data-menu="taken"');
  });
});

// ---- R7.2, D69, D70: local command outputs ------------------------------------------------------

describe('local command outputs (R7.2)', () => {
  const event = (localCommand: unknown, seq = 9) => ({
    type: 'assistant/message',
    seq,
    data: {
      message: {
        content: [{ type: 'text', text: 'Total cost: $0.14\nTotal duration: 3s' }],
        source: { rawAgent: { backend: 'k', localCommand } },
      },
    },
  });

  it('claims only local command messages and carries their text as written (D69 r5)', () => {
    const def = localCommandDefinition() as {
      kind: string;
      match(e: unknown): { id: string; role: string; exclusive?: boolean } | null;
      start(c: unknown, m: { event: unknown }): unknown;
      buildViewNode(c: unknown): { kind: string; anchorSeq: number } | null;
    };
    expect(def.kind).toBe(LOCAL_COMMAND_DEFINITION_KIND);
    expect(def.match(event({ name: 'context', structured: 'context', outputId: 'o1' }))).toEqual({
      id: 'local-9',
      role: 'start',
      exclusive: true,
    });
    expect(
      def.match({ type: 'assistant/message', seq: 1, data: { message: { source: { rawAgent: {} } } } }),
    ).toBeNull();
    expect(def.match({ type: 'user/message', seq: 1, data: {} })).toBeNull();
    const state = def.start({}, { event: event({ name: 'clear' }) });
    expect(state).toEqual({ seq: 9, name: 'clear', text: 'Total cost: $0.14\nTotal duration: 3s' });
    expect(def.buildViewNode({ key: 'k', id: 'local-9', state, matches: [] })).toMatchObject({
      kind: LOCAL_COMMAND_NODE_KIND,
      anchorSeq: 9,
    });
  });

  it('picks the render by the command name', () => {
    const d = (name: string, extra: object = {}) =>
      localCommandOf({ rawAgent: { localCommand: { name, ...extra } } }, 1)!;
    expect(localRender(d('clear'))).toBe('cleared');
    expect(localRender(d('reset'))).toBe('cleared');
    expect(localRender(d('compact'))).toBe('compacted');
    expect(localRender(d('context'))).toBe('context');
    expect(localRender(d('cost'))).toBe('usage');
    expect(localRender(d('help', { unavailable: true }))).toBe('none');
    expect(clearedText('Agent')).toBe('Conversation cleared — Agent starts fresh here');
  });

  it('leaves the /clear divider and the compact marker to the typed command (M7)', async () => {
    const stores = new SessionStores(api({ s: info() }));
    const store = stores.get('s');
    await store.refresh();
    const draw = (name: string) =>
      renderToStaticMarkup(
        React.createElement(LocalCommandView, { data: { seq: 1, name }, sessionId: 's', store, api: api({}) }),
      );
    expect(draw('clear')).toBe('');
    expect(draw('compact')).toBe('');
    expect(draw('help')).toBe('');
    // The agent's text is drawn by our node: plain columns monospaced, `$` kept as written.
    const usage = renderToStaticMarkup(
      React.createElement(LocalCommandView, {
        data: { seq: 1, name: 'cost', text: 'Total cost: $0.14 ($0.14)\nTotal duration: 3s' },
        sessionId: 's',
        store,
        api: api({}),
      }),
    );
    expect(usage).toContain('<pre');
    expect(usage).toContain('Total cost: $0.14 ($0.14)');
    const md = renderToStaticMarkup(
      React.createElement(LocalCommandView, {
        data: { seq: 1, name: 'help', unavailable: true, text: '**Note:** costs $1 and $2' },
        sessionId: 's',
        store,
        api: api({}),
      }),
    );
    expect(md).toContain('local-markdown');
    expect(md).toContain('$1 and $2');
    expect(localTextFormat('one line')).toBe('markdown');
    expect(localTextFormat('## Context\n| a | b |')).toBe('markdown');
    expect(localTextFormat('a\nb')).toBe('plain');
    expect(renderToStaticMarkup(React.createElement(Divider, { text: 'x', testId: 't' }))).toContain(
      'role="separator"',
    );
    stores.dispose();
  });

  it('shows the usage numbers beside /usage and /cost', async () => {
    const stores = new SessionStores(
      api({ s: info({ usage: { compacting: false, tokens: 12_345, costUsd: 0.42, costLabel: 'estimate' } as never }) }),
    );
    const store = stores.get('s');
    await store.refresh();
    const html = renderToStaticMarkup(
      React.createElement(LocalCommandView, { data: { seq: 1, name: 'usage' }, sessionId: 's', store, api: api({}) }),
    );
    expect(html).toContain('data-raw-agent="local-usage"');
    expect(html).toContain('tokens');
    stores.dispose();
  });

  it('renders the /context categories and item tables', () => {
    const html = renderToStaticMarkup(
      React.createElement(LocalContextView, {
        displayName: 'Agent',
        output: {
          kind: 'context',
          context: {
            used: 30_000,
            window: 200_000,
            categories: [
              { name: 'System prompt', tokens: 3000, id: 'system' },
              { name: 'Messages', tokens: 27_000, id: 'messages' },
            ],
            details: {
              mcpTools: [{ name: 'search', server: 'gh', tokens: 900 }],
              skills: [{ name: 'pdf', source: 'user', tokens: 40 }],
            },
          },
        },
      }),
    );
    expect(html).toContain('data-raw-agent="usage-context"');
    expect(html).toContain('System prompt');
    expect(html).toContain('MCP tools (1)');
    expect(html).toContain('Skills (1)');
  });

  it('reads the display-only copy, and 404 means no longer kept', async () => {
    const { fetchFn } = recordingFetch({
      'id=o1': { status: 200, body: { kind: 'context', context: { used: 1, window: 2 } } },
    });
    const a = createApi(fetchFn);
    expect(await a.localOutput!('s', 'o1')).toEqual({ kind: 'context', context: { used: 1, window: 2 } });
    expect(await a.localOutput!('s', 'gone')).toBeUndefined();
  });
});

// ---- leftovers (view-only) -----------------------------------------------------------------------

describe('view-only leftovers', () => {
  it('numbers the lines of an edit preview (M2)', () => {
    const p = permissionPreview({ file_path: '/f', old_string: 'a\nb', new_string: 'a\nc' });
    expect(p).toMatchObject({ kind: 'diff' });
    const html = renderToStaticMarkup(React.createElement(PreviewView, { preview: p!, actions: noActions }));
    expect(html).toContain('data-raw-agent="diff-num"');
    expect(html).toContain('1 1 </span>  a');
    expect(html).toContain('2   </span>- b');
    expect(html).toContain('  2 </span>+ c');
  });

  it('shows a workflow launch as its script, not as JSON (M4)', () => {
    const p = permissionPreview({ script: "phase('One')\nawait agent('x')", name: 'probe' });
    expect(p).toEqual({
      kind: 'text',
      label: 'Script',
      text: "phase('One')\nawait agent('x')",
      note: 'Workflow: probe · Phases: One',
    });
  });
});
