// M7 client-lifecycle (R3.5, R3.6; D29, D30, D70, D75): the exit banner with Restart, the
// lifecycle notes, the rewind dialog and its routes, the `/rewind` claim, and the /clear divider
// and /compact marker on the typed command.

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  COMMAND_MARKER_NODE_KIND,
  CommandMarkerView,
  LifecycleBanner,
  RewindPanel,
  SessionStores,
  UsageReader,
  agentCommandSource,
  commandMarkerDefinition,
  commandMarkerOf,
  compactMarkerText,
  compactOutcome,
  createApi,
  exitBanner,
  lifecycleNotes,
  markerOfEvent,
  parseRewindOptions,
  pointLabel,
  requestRestoreAtStart,
  rewindChoices,
  rewindResultText,
  statusLine,
  type CommandsAnswerWire,
  type FetchFn,
  type HostActions,
  type RawAgentApi,
  type RewindOptionsWire,
  type SessionInfo,
} from '@dsh-raw-agent/dsh-client';

function info(view: Partial<SessionInfo['view']> = {}): SessionInfo {
  return {
    backend: { kind: 'claude-code', displayName: 'Agent' },
    permissionModes: [{ id: 'default', label: 'Ask' }],
    efforts: [],
    needsProcess: [],
    models: [],
    modelsFrom: 'session',
    view: {
      state: { process: 'none', turn: false, backgroundTasks: 0 },
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

function api(sessions: Record<string, SessionInfo>, over: Partial<RawAgentApi> = {}): RawAgentApi {
  return {
    ...createApi(async () => ({ status: 500, ok: false, json: async () => ({}) })),
    session: async (id) => {
      const s = sessions[id];
      if (!s) {
        const { RouteError } = await import('@dsh-raw-agent/dsh-client');
        throw new RouteError(404, 'not ours');
      }
      return s;
    },
    ...over,
  };
}

function recordingFetch(answers: Record<string, { status: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    const key = Object.keys(answers).find((k) => url.includes(k));
    const a = key ? answers[key]! : { status: 404, body: { error: 'none' } };
    return { status: a.status, ok: a.status >= 200 && a.status < 300, json: async () => a.body };
  };
  return { calls, fetchFn };
}

const options = (over: Partial<RewindOptionsWire> = {}): RewindOptionsWire => ({
  running: true,
  fileRewind: true,
  unstartedFork: false,
  restoreCodePending: false,
  displayName: 'Agent',
  points: [
    { messageId: 'm1', text: 'first', at: 1 },
    { messageId: 'm2', text: 'second  line\nnext', at: 2, forkSeq: 7, attachments: 2 },
  ],
  ...over,
});

// ---- the exit banner (R3.6) -----------------------------------------------------------------------

describe('exit banner (R3.6, D75)', () => {
  it('names a crash during a reply, its signal and its words, and offers Restart', () => {
    const b = exitBanner(
      info({
        state: {
          process: 'none',
          turn: false,
          backgroundTasks: 0,
          lastExit: { at: 5, duringTurn: true, reason: 'crashed', signal: 'SIGKILL', error: '  boom\n' },
        },
      }),
    );
    expect(b).toMatchObject({
      key: 'exit-5',
      level: 'error',
      title: 'Agent crashed during a reply (killed (SIGKILL)).',
      detail: 'boom',
      restartLabel: 'Restart Agent',
    });
    expect(b?.reply).toContain('resumes the same conversation');
  });

  it('says when the reply was read back after the crash', () => {
    const b = exitBanner(
      info({
        state: {
          process: 'none',
          turn: false,
          backgroundTasks: 0,
          lastExit: { at: 5, duringTurn: true, reason: 'crashed', code: 1 },
        },
        lifecycle: { recovered: { at: 6, why: 'crash', steps: 2 } },
      }),
    );
    expect(b?.title).toBe('Agent crashed during a reply (exit code 1).');
    expect(b?.reply).toContain('read back from its own record (2 steps)');
  });

  it('an end by itself is a warning; an intended end or a running process shows nothing', () => {
    const at = (reason: 'ended' | 'disposed' | 'force-stopped', process: 'none' | 'running' = 'none') =>
      exitBanner(
        info({ state: { process, turn: false, backgroundTasks: 0, lastExit: { at: 1, duringTurn: false, reason } } }),
      );
    expect(at('ended')).toMatchObject({ level: 'warning', title: 'Agent ended by itself.' });
    expect(at('disposed')).toBeUndefined();
    expect(at('force-stopped')).toBeUndefined();
    expect(at('ended', 'running')).toBeUndefined();
  });

  it('the controls line does not repeat an exit the banner shows', () => {
    const i = info({
      state: { process: 'none', turn: false, backgroundTasks: 0, lastExit: { at: 1, duringTurn: false, error: 'x' } },
    });
    expect(statusLine(i)).toContain('Agent stopped: x');
    expect(statusLine(i, { exitShown: true })).toBeUndefined();
  });

  it('renders the banner with Restart in our session only', async () => {
    const crashed = info({
      state: {
        process: 'none',
        turn: false,
        backgroundTasks: 0,
        lastExit: { at: 1, duringTurn: false, reason: 'crashed' },
      },
      lifecycle: { unstartedFork: true, restoreCodePending: true },
    });
    const stores = new SessionStores(api({ s: crashed }));
    await stores.get('s').refresh();
    await stores.get('x').refresh();
    const html = renderToStaticMarkup(React.createElement(LifecycleBanner, { store: stores.get('s') }));
    expect(html).toContain('data-raw-agent="exit-banner"');
    expect(html).toContain('Restart Agent');
    expect(html).toContain('This is a branch.');
    expect(html).toContain('puts the files back');
    expect(renderToStaticMarkup(React.createElement(LifecycleBanner, { store: stores.get('x') }))).toBe('');
    stores.dispose();
  });
});

// ---- lifecycle notes -------------------------------------------------------------------------------

describe('lifecycle notes (D29, D30, D75, R3.6)', () => {
  it('lists the fork, child-branch, restart, recovery and restore facts', () => {
    const notes = lifecycleNotes(
      info({
        lifecycle: {
          forkedFromChild: true,
          endedByStop: ['npm test', 'watch'],
          recovered: { at: 3, why: 'restart', steps: 1, note: 'it took in a queued message' },
          recoveryProblem: 'too large',
          rewind: { inputId: 'i', at: 4, result: { ok: true, filesChanged: ['a', 'b'], insertions: 3, deletions: 1 } },
        },
      }),
    );
    expect(notes.map((n) => n.id)).toEqual([
      'child-fork',
      'ended-by-stop-npm test|watch',
      'recovered-3',
      'recovery-problem',
      'rewind-4',
    ]);
    expect(notes[1]!.text).toBe('When DSH last stopped, npm test, watch ended too. Agent was not told.');
    expect(notes[2]!.text).toContain('1 step while DSH was not looking');
    expect(notes[4]!.text).toBe('Restored 2 files (+3 −1 lines).');
    // A crash recovery is told by the exit banner; a preview is the dialog's.
    expect(
      lifecycleNotes(
        info({
          lifecycle: {
            recovered: { at: 3, why: 'crash', steps: 1 },
            rewind: { inputId: 'i', at: 4, result: { ok: true, filesChanged: [], dryRun: true } },
          },
        }),
      ),
    ).toEqual([]);
  });

  it('words a file restore and its preview', () => {
    expect(rewindResultText({ ok: false, error: 'no checkpoint', filesChanged: [] }, 'Agent')).toBe(
      'Agent did not restore the files: no checkpoint.',
    );
    expect(rewindResultText({ ok: true, filesChanged: [], dryRun: true }, 'Agent')).toBe(
      'No file changed since this message.',
    );
    expect(rewindResultText({ ok: true, filesChanged: ['a'], dryRun: true, skippedLinks: 1 }, 'Agent')).toBe(
      'Restore code would change 1 file; 1 left alone (a link sits at the path).',
    );
  });
});

// ---- the rewind dialog (D30) -----------------------------------------------------------------------

describe('rewind dialog (D30)', () => {
  it('offers the terminal menu choices with their limits', () => {
    const o = options();
    const first = rewindChoices(o, o.points[0]!, { state: 'none' });
    expect(first.map((c) => c.id)).toEqual(['both', 'conversation', 'code', 'cancel']);
    expect(first[0]!.disabled).toContain('first message');
    expect(first[1]!.disabled).toContain('first message');
    expect(first[2]!.disabled).toBeUndefined();
    const later = rewindChoices(o, o.points[1]!, {
      state: 'done',
      result: { ok: true, filesChanged: [], dryRun: true },
    });
    expect(later[0]!.disabled).toBeUndefined();
    expect(later[2]!.disabled).toBe('No file changed since this message.');
    const off = rewindChoices(options({ fileRewind: false }), o.points[1]!, { state: 'none' });
    expect(off[0]!.disabled).toContain('no file checkpoints');
    expect(off[1]!.disabled).toBeUndefined();
    expect(off[2]!.disabled).toContain('no file checkpoints');
    const idle = rewindChoices(options({ running: false }), o.points[1]!, { state: 'none' });
    expect(idle[2]!.disabled).toBe('Start Agent first: it restores the files from its checkpoints.');
    expect(pointLabel(o.points[1]!)).toBe('second line next [+2 attachments]');
    expect(pointLabel({ messageId: 'x', text: ' ', at: 0 })).toBe('(no text)');
  });

  it('draws the points newest first and the picked point’s choices', () => {
    const stores = new SessionStores(api({}));
    const html = renderToStaticMarkup(
      React.createElement(RewindPanel, {
        sessionId: 's',
        api: api({}),
        actions: noActions,
        store: stores.get('s'),
        onClose: () => {},
        initial: {
          options: options(),
          picked: 'm2',
          preview: { state: 'done', result: { ok: true, filesChanged: ['src/a.ts'], dryRun: true } },
        },
      }),
    );
    expect(html.indexOf('second line')).toBeLessThan(html.indexOf('first'));
    expect(html).toContain('Restore code and conversation');
    expect(html).toContain('Restore code would change 1 file. src/a.ts');
    expect(html).toContain('Never mind');
    expect(html).toContain('Summarize from here');
    const empty = renderToStaticMarkup(
      React.createElement(RewindPanel, {
        sessionId: 's',
        api: api({}),
        actions: noActions,
        store: stores.get('s'),
        onClose: () => {},
        initial: { options: options({ points: [] }) },
      }),
    );
    expect(empty).toContain('rewind-empty');
    stores.dispose();
  });

  it('reads the routes: options, restore at start, restore in place', async () => {
    const { calls, fetchFn } = recordingFetch({
      '/rewind?': {
        status: 200,
        body: { ...options(), points: [{ messageId: 'm1', text: 'a', at: 1 }, { text: 'no id' }] },
      },
      '/rewind-restore': { status: 409, body: { ok: false, error: 'started' } },
      '/rewind-files': { status: 200, body: { ok: true, result: { ok: true, filesChanged: ['a', 3], dryRun: true } } },
    });
    const a = createApi(fetchFn);
    expect((await a.rewind!('s')).points).toEqual([{ messageId: 'm1', text: 'a', at: 1 }]);
    expect(await a.rewindRestore!('f', true)).toEqual({ ok: false, status: 409, error: 'started' });
    expect(await a.rewindFiles!('s', 'msg 1', true)).toEqual({
      ok: true,
      result: { ok: true, filesChanged: ['a'], dryRun: true },
    });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET api/raw-agent/rewind?session=s',
      'POST api/raw-agent/rewind-restore?session=f&on=1',
      'POST api/raw-agent/rewind-files?session=s&message=msg%201&dryRun=1',
    ]);
    expect(parseRewindOptions(undefined)).toMatchObject({ running: false, points: [], displayName: 'The agent' });
  });

  it('asks a new branch to restore code until its runtime answers', async () => {
    let n = 0;
    const answers = [404, 409, 200];
    const a: RawAgentApi = {
      ...api({}),
      rewindRestore: async () => {
        const status = answers[n++]!;
        return { ok: status === 200, status };
      },
    };
    expect(await requestRestoreAtStart(a, 'f', { sleep: async () => {} })).toEqual({ ok: true });
    expect(n).toBe(3);
    const refused: RawAgentApi = { ...api({}), rewindRestore: async () => ({ ok: false, status: 500, error: 'no' }) };
    expect(await requestRestoreAtStart(refused, 'f', { sleep: async () => {} })).toEqual({ ok: false, error: 'no' });
    expect((await requestRestoreAtStart(api({}), 'f', { attempts: 2, sleep: async () => {} })).ok).toBe(false);
  });
});

// ---- the /rewind claim (D30) ------------------------------------------------------------------------

describe('/rewind opens our dialog', () => {
  const answer: CommandsAnswerWire = {
    running: true,
    from: 'live',
    full: true,
    displayName: 'Agent',
    rewindCommand: 'rewind',
    rows: [{ name: 'rewind', aliases: ['checkpoint', 'undo'], menu: 'rewind-panel' }],
  };

  it('claims the bare command and its aliases; words or attachments go to the agent', async () => {
    const a: RawAgentApi = { ...api({ ours: info() }), commands: async () => answer };
    const stores = new SessionStores(a);
    const src = agentCommandSource(stores, a);
    for (const line of ['/rewind', '/undo', '/checkpoint']) {
      const out = await src.matchEnter({ sessionId: 'ours' }, line);
      const claim = (out as { claim: { submit: () => Promise<unknown> } }).claim;
      expect(await claim.submit()).toEqual({ kind: 'success' });
    }
    expect(stores.get('ours').getSnapshot().panelRequest).toEqual({ panel: 'rewind', seq: 3 });
    expect(await src.matchEnter({ sessionId: 'ours' }, '/rewind now')).toBeUndefined();
    expect(await src.matchEnter({ sessionId: 'ours' }, '/rewind', undefined, { attachments: 1 })).toBeUndefined();
    stores.dispose();
  });
});

// ---- /clear divider and /compact marker (D70) --------------------------------------------------------

describe('/clear divider and /compact marker on the typed command (D70)', () => {
  const userEvent = (text: string, over: Record<string, unknown> = {}) => ({
    type: 'user/message',
    seq: 4,
    time: 100,
    data: { id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }], ...over },
  });

  it('finds the marker only for a message that is the command', () => {
    expect(commandMarkerOf('/clear', 1, 2)).toEqual({ kind: 'cleared', seq: 1, time: 2 });
    expect(commandMarkerOf(' /new ', 1, 2)?.kind).toBe('cleared');
    expect(commandMarkerOf('/clear now', 1, 2)).toBeUndefined();
    expect(commandMarkerOf('/compact keep the tests', 1, 2)).toEqual({
      kind: 'compacted',
      seq: 1,
      time: 2,
      args: 'keep the tests',
    });
    expect(commandMarkerOf('/autocompact', 1, 2)).toBeUndefined();
    expect(commandMarkerOf('please /clear', 1, 2)).toBeUndefined();
    expect(markerOfEvent(userEvent('/clear'))).toEqual({ kind: 'cleared', seq: 4, time: 100 });
    expect(markerOfEvent(userEvent('/clear', { source: { kind: 'plugin' } }))).toBeUndefined();
    expect(
      markerOfEvent(userEvent('/clear', { content: [{ type: 'text', text: '/clear' }, { type: 'image' }] })),
    ).toBeUndefined();
    expect(markerOfEvent({ ...userEvent('/clear'), type: 'assistant/message' })).toBeUndefined();
  });

  it('the Definition never claims the message and builds a turn-level node', () => {
    const def = commandMarkerDefinition() as {
      match: (e: unknown) => { id: string; exclusive?: boolean } | null;
      start: (c: unknown, m: { event: unknown }) => unknown;
      buildViewNode: (c: unknown) => { kind: string; anchorSeq: number; groupTree?: string } | null;
    };
    const m = def.match(userEvent('/compact'));
    expect(m).toEqual({ id: 'marker-4', role: 'start' });
    expect(def.match(userEvent('hello'))).toBeNull();
    const state = def.start(undefined, { event: userEvent('/compact') });
    const node = def.buildViewNode({ key: 'k', id: 'marker-4', state, matches: [] });
    expect(node).toMatchObject({ kind: COMMAND_MARKER_NODE_KIND, anchorSeq: 4, groupTree: 'turn' });
  });

  it('matches the compaction that ran after the typed command', () => {
    const rows = (list: Array<Record<string, unknown>>) => ({ compactions: list as never });
    expect(
      compactOutcome(
        100,
        rows([
          { phase: 'end', trigger: 'auto', at: 50, preTokens: 1, postTokens: 1 },
          { phase: 'start', at: 110 },
          { phase: 'end', trigger: 'manual', at: 120, preTokens: 9000, postTokens: 1200 },
        ]),
        false,
      ),
    ).toEqual({ state: 'done', preTokens: 9000, postTokens: 1200 });
    expect(compactOutcome(100, rows([{ phase: 'start', at: 110 }]), true)).toEqual({ state: 'running' });
    expect(compactOutcome(100, rows([{ phase: 'end', at: 130, error: 'too short' }]), false)).toEqual({
      state: 'failed',
      error: 'too short',
    });
    expect(compactOutcome(100, rows([{ phase: 'end', at: 90 }]), false)).toEqual({ state: 'unknown' });
    expect(compactOutcome(100, undefined, false)).toEqual({ state: 'unknown' });
    const fmt = (n: number) => `${n}`;
    expect(compactMarkerText({ state: 'done', preTokens: 2, postTokens: 1 }, 'Agent', fmt)).toBe(
      'Conversation compacted (2 → 1 tokens)',
    );
    expect(compactMarkerText({ state: 'unknown' }, 'Agent', fmt)).toContain('not known');
  });

  it('draws the divider in our sessions, and the compact outcome from the usage board', async () => {
    const usage = {
      running: true,
      usage: {
        turns: [],
        compacting: false,
        compactions: [{ phase: 'end' as const, at: 150, preTokens: 50_000, postTokens: 4_000 }],
        retries: [],
        resets: [],
      },
    };
    const a = api(
      { s: info({ state: { process: 'running', turn: false, backgroundTasks: 0 } }) },
      { usage: async () => usage },
    );
    const stores = new SessionStores(a);
    await stores.get('s').refresh();
    await stores.get('x').refresh();
    const cleared = renderToStaticMarkup(
      React.createElement(CommandMarkerView, { marker: { kind: 'cleared', seq: 1, time: 1 }, store: stores.get('s') }),
    );
    expect(cleared).toContain('Conversation cleared — Agent starts fresh here');
    expect(
      renderToStaticMarkup(
        React.createElement(CommandMarkerView, {
          marker: { kind: 'cleared', seq: 1, time: 1 },
          store: stores.get('x'),
        }),
      ),
    ).toBe('');
    const reader = new UsageReader('s', a);
    await reader.read({ usage: true });
    const compact = renderToStaticMarkup(
      React.createElement(CommandMarkerView, {
        marker: { kind: 'compacted', seq: 1, time: 100 },
        store: stores.get('s'),
        reader,
      }),
    );
    expect(compact).toContain('marker-compact-done');
    expect(compact).toContain('Conversation compacted (');
    reader.dispose();
    stores.dispose();
  });
});
