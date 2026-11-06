// R7.1, R7.3, D52 r5, D54, D55: our `/` source lists every agent command and claims /btw and a bare /mcp.
import { describe, expect, it } from 'vitest';
import {
  SessionStores,
  agentCommandSource,
  createApi,
  sourceCandidates,
  type CommandsAnswerWire,
  type RawAgentApi,
  type SessionInfo,
} from '@dsh-raw-agent/dsh-client';

const answer: CommandsAnswerWire = {
  running: true,
  from: 'live',
  full: true,
  displayName: 'Agent',
  sideQuestionCommand: 'btw',
  mcpCommand: 'mcp',
  rows: [
    { name: 'btw', menu: 'side-question' },
    { name: 'mcp', description: 'Manage MCP servers', menu: 'mcp-panel' },
    { name: 'usage', description: 'Show usage', aliases: ['cost'], menu: 'listed' },
    { name: 'context', description: 'Show current context usage', kind: 'builtin', menu: 'listed' },
    { name: 'model', kind: 'builtin', menu: 'taken' },
    { name: 'm6scratch:m6_greet (MCP)', description: 'Greet someone', kind: 'mcp-prompt', menu: 'listed' },
    {
      name: 'eli5:eli5',
      description: 'Explain',
      kind: 'skill',
      argumentHint: '<topic>',
      menu: 'listed',
      aliases: ['eli5'],
    },
    { name: 'focus', kind: 'builtin', menu: 'terminal-only' },
  ],
};

function info(): SessionInfo {
  return {
    backend: { kind: 'claude-code', displayName: 'Agent' },
    permissionModes: [],
    efforts: [],
    needsProcess: [],
    models: [],
    modelsFrom: 'session',
    view: {
      state: { process: 'running', turn: false, backgroundTasks: 0 },
      live: {},
      choice: { applied: {}, resetPending: false, agentLocked: false },
      menu: { version: 1, count: 5, full: true },
    },
  } as SessionInfo;
}

describe('agent command source', () => {
  it('offers every agent command with its exact name, hint, aliases and notes (one group)', () => {
    expect(sourceCandidates(answer, '').map((c) => c.name)).toEqual([
      'btw',
      'mcp',
      'usage',
      'context',
      'model',
      'm6scratch:m6_greet (MCP)',
      'eli5:eli5',
      'focus',
    ]);
    expect(sourceCandidates(answer, 'm6s')).toEqual([
      { name: 'm6scratch:m6_greet (MCP)', description: 'Greet someone · MCP prompt', value: 'line' },
    ]);
    expect(sourceCandidates(answer, 'eli')[0]).toEqual({
      name: 'eli5:eli5',
      description: 'Explain · skill · also /eli5',
      hint: '<topic>',
      value: 'line',
    });
    // An alias finds its command (/c → usage via cost); taken and terminal-only rows say so.
    expect(sourceCandidates(answer, 'cos').map((c) => c.name)).toEqual(['usage']);
    expect(sourceCandidates(answer, 'model')[0]).toMatchObject({ value: 'taken' });
    expect(sourceCandidates(answer, 'model')[0]!.description).toContain('taken by DSH');
    expect(sourceCandidates(answer, 'focus')[0]!.description).toContain('terminal app');
    expect(sourceCandidates(answer, 'btw')[0]).toMatchObject({ value: 'side', hint: '<question>' });
    expect(sourceCandidates(answer, 'tw').some((c) => c.value === 'side')).toBe(false);
    expect(sourceCandidates(undefined, '')).toEqual([]);
  });

  it('puts the exact name first for a typed query, so Enter on /compact never picks autocompact', () => {
    const cli: CommandsAnswerWire = {
      ...answer,
      rows: [
        { name: 'autocompact', kind: 'builtin', menu: 'listed' },
        { name: 'compact', kind: 'builtin', menu: 'listed' },
        { name: 'context', kind: 'builtin', menu: 'listed' },
        { name: 'usage', aliases: ['cost'], menu: 'listed' },
        { name: 'cost-report', menu: 'listed' },
      ],
    };
    expect(sourceCandidates(cli, 'compact').map((c) => c.name)).toEqual(['compact', 'autocompact']);
    expect(sourceCandidates(cli, 'co').map((c) => c.name)).toEqual([
      'compact',
      'context',
      'cost-report',
      'usage',
      'autocompact',
    ]);
    // An exact alias beats a longer name that starts with it.
    expect(sourceCandidates(cli, 'cost').map((c) => c.name)).toEqual(['usage', 'cost-report']);
    // No query: the agent's own order.
    expect(sourceCandidates(cli, '').map((c) => c.name)).toEqual([
      'btw',
      'autocompact',
      'compact',
      'context',
      'usage',
      'cost-report',
    ]);
  });

  it('offers a Start row (and the side question) before the agent listed its commands', () => {
    const before: CommandsAnswerWire = { ...answer, running: false, from: 'none', full: false, rows: [] };
    expect(sourceCandidates(before, '')).toEqual([
      expect.objectContaining({ name: 'btw', value: 'side' }),
      expect.objectContaining({ name: 'agent', label: 'Start Agent', value: 'start' }),
    ]);
  });

  it('answers only in our sessions, reads the route once per menu version, and picks plain text', async () => {
    let reads = 0;
    const api: RawAgentApi = {
      ...createApi(async () => ({ status: 500, ok: false, json: async () => ({}) })),
      session: async (id) => {
        if (id !== 'ours') {
          const { RouteError } = await import('@dsh-raw-agent/dsh-client');
          throw new RouteError(404, 'not ours');
        }
        return info();
      },
      commands: async () => {
        reads++;
        return answer;
      },
    };
    const stores = new SessionStores(api);
    await stores.get('ours').refresh();
    await stores.get('std').refresh();
    const src = agentCommandSource(stores, api);
    expect(await src.candidates({ sessionId: 'std' }, { query: '', position: 'leading' })).toEqual([]);
    expect(await src.candidates({ sessionId: 'unknown' }, { query: '', position: 'leading' })).toEqual([]);
    expect(await src.candidates({ sessionId: 'ours' }, { query: '', position: 'inline' })).toEqual([]);
    const got = await src.candidates({ sessionId: 'ours' }, { query: 'm6', position: 'leading' });
    expect(got.map((c) => c.name)).toEqual(['m6scratch:m6_greet (MCP)']);
    await src.candidates({ sessionId: 'ours' }, { query: '', position: 'leading' });
    expect(reads).toBe(1);
    const pick = (name: string, value?: string) =>
      src.onPick({ candidate: { name, ...(value ? { value } : {}) }, session: { sessionId: 'ours' } });
    expect(pick('m6scratch:m6_greet (MCP)', 'line')).toEqual({ text: '/m6scratch:m6_greet (MCP) ' });
    expect(pick('model', 'taken')).toBe('handled');
    expect(pick('btw', 'side')).toMatchObject({ claim: { name: 'btw', token: '/btw ' } });
  });

  it('claims /btw on Enter (even before the store is ready) and sends nothing to the agent', async () => {
    const asked: Array<[string, string]> = [];
    const api: RawAgentApi = {
      ...createApi(async () => ({ status: 500, ok: false, json: async () => ({}) })),
      commands: async (id) => {
        if (id !== 'ours') {
          const { RouteError } = await import('@dsh-raw-agent/dsh-client');
          throw new RouteError(404, 'not ours');
        }
        return answer;
      },
      askSide: async (id, q) => {
        asked.push([id, q]);
        return { ok: true, entry: { id: 's1', question: q, status: 'asking', at: 1 } };
      },
    };
    const stores = new SessionStores(api);
    const src = agentCommandSource(stores, api);
    // Not our session: nothing is claimed, the line goes on as typed.
    expect(await src.matchEnter({ sessionId: 'std' }, '/btw hi')).toBeUndefined();
    // Our session, store not read yet: still claimed.
    const out = await src.matchEnter({ sessionId: 'ours' }, '/btw what did we decide?');
    expect(out).toMatchObject({ claim: { name: 'btw', token: '/btw ', attachments: false } });
    const claim = (out as { claim: { submit: (a: string, c: unknown, x: unknown[]) => Promise<unknown> } }).claim;
    expect(await claim.submit('what did we decide?', {}, [])).toEqual({ kind: 'success' });
    expect(asked).toEqual([['ours', 'what did we decide?']]);
    await expect(src.matchEnter({ sessionId: 'ours' }, '/btw x', undefined, { attachments: 1 })).rejects.toThrow();
    // Agent commands are never claimed: Enter sends them as typed text.
    expect(await src.matchEnter({ sessionId: 'ours' }, '/context')).toBeUndefined();
    expect(await src.matchEnter({ sessionId: 'ours' }, '/btwx hi')).toBeUndefined();
    // Space after the token makes the chip once the answer is in hand.
    expect(src.matchSpace({ sessionId: 'ours' }, '/btw')).toMatchObject({ claim: { name: 'btw' } });
    expect(await src.matchClaim({ sessionId: 'ours' }, '/btw')).toMatchObject({ name: 'btw' });
  });

  it('a bare /mcp opens our MCP panel; with words it goes to the agent', async () => {
    const api: RawAgentApi = {
      ...createApi(async () => ({ status: 500, ok: false, json: async () => ({}) })),
      commands: async () => answer,
    };
    const stores = new SessionStores(api);
    const src = agentCommandSource(stores, api);
    expect(await src.matchEnter({ sessionId: 'ours' }, '/mcp enable x')).toBeUndefined();
    const out = (await src.matchEnter({ sessionId: 'ours' }, '/mcp')) as {
      claim: { submit: (a: string, c: unknown, x: unknown[]) => Promise<unknown> };
    };
    expect(stores.get('ours').getSnapshot().panelRequest).toBeUndefined();
    expect(await out.claim.submit('', {}, [])).toEqual({ kind: 'success' });
    expect(stores.get('ours').getSnapshot().panelRequest).toEqual({ panel: 'mcp', seq: 1 });
  });
});

describe('local command node placement (R7.2, live M6)', () => {
  it('stands at the turn, outside the folded process', async () => {
    const { localCommandDefinition, LOCAL_COMMAND_GROUP_TREE } = await import('@dsh-raw-agent/dsh-client');
    const def = localCommandDefinition() as { buildViewNode: (c: unknown) => { groupTree?: string } | null };
    const node = def.buildViewNode({
      key: 'k',
      id: 'local-5',
      state: { seq: 5, name: 'context' },
      matches: [{ location: { kind: 'step', turn: { index: 2 }, step: { index: 1 } } }],
    });
    expect(LOCAL_COMMAND_GROUP_TREE).toBe('turn');
    expect(node?.groupTree).toBe('turn');
  });
});
