// Browser half: view logic, the session store, the rendered controls and settings panel, and the
// port's slot registration (R1.3, R1.4, D63, D36). No DSH and no browser needed.

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CONTROLS_SLOT,
  RouteError,
  SessionControlStore,
  SessionControls,
  SettingsPanel,
  START_OPTION,
  createApi,
  effortSelect,
  fileResourceAddress,
  maskedSegments,
  modeSelect,
  modelSelect,
  restoreReturnedDrafts,
  askModels,
  cdCommand,
  folderOf,
  keyLayerRows,
  mountClient,
  hideNativeSeat,
  hostActions,
  NATIVE_PERMISSION_SLOT,
  SEAT_HIDDEN_ATTR,
  statusLine,
  type FetchFn,
  type HostActions,
  type RawAgentApi,
  type SessionInfo,
  type TimerApi,
} from '@dsh-raw-agent/dsh-client';

function info(over: Partial<SessionInfo> = {}, view: Partial<SessionInfo['view']> = {}): SessionInfo {
  return {
    backend: { kind: 'k', displayName: 'Agent' },
    permissionModes: [
      { id: 'default', label: 'Ask' },
      { id: 'plan', label: 'Plan' },
    ],
    efforts: [
      { id: 'low', label: 'Low' },
      { id: 'high', label: 'High' },
    ],
    needsProcess: [],
    models: [{ value: 'm1', displayName: 'Model one', efforts: ['low'] }],
    modelsFrom: 'session',
    settings: { model: 'from-files', effort: 'high', permissionMode: 'plan', sources: {} },
    view: {
      state: { process: 'running', turn: false, backgroundTasks: 0 },
      live: { model: 'live-model', mode: 'default' },
      choice: { applied: {}, resetPending: false },
      ...view,
    },
    ...over,
  };
}

describe('view model', () => {
  it('"Your settings" names the live model while nothing is applied, else the settings preview', () => {
    expect(modelSelect(info()).options[0]).toEqual({ value: 'settings', label: 'Your settings (live-model)' });
    expect(modelSelect(info()).value).toBe('settings');
    const chosen = modelSelect(info({}, { choice: { model: 'm1', applied: { model: 'm1' }, resetPending: false } }));
    expect(chosen.value).toBe('m1');
    expect(chosen.options[0]!.label).toBe('Your settings (from-files)');
  });

  it('keeps an unknown chosen model, and offers Start when no list and no process (D4, D34)', () => {
    const s = modelSelect(
      info(
        { models: [], modelsFrom: 'none' },
        {
          state: { process: 'none', turn: false, backgroundTasks: 0 },
          live: {},
          choice: { model: 'x', applied: {}, resetPending: false },
        },
      ),
    );
    expect(s.options.map((o) => o.value)).toEqual(['settings', 'x', START_OPTION]);
    expect(s.options[2]!.label).toBe('Start Agent to list models');
    expect(modelSelect(info({ modelsFrom: 'recent' })).title).toContain('may differ for this folder');
  });

  it('effort list narrows to the chosen model; mode follows the agent', () => {
    const e = effortSelect(info({}, { choice: { model: 'm1', applied: {}, resetPending: false } }))!;
    expect(e.options.map((o) => [o.value, !!o.disabled])).toEqual([
      ['settings', false],
      ['low', false],
      ['high', true],
    ]);
    expect(e.options[0]!.label).toBe('Effort: your settings (high)');
    expect(effortSelect(info({ efforts: [] }))).toBeUndefined();
    expect(modeSelect(info()).value).toBe('default');
    expect(modeSelect(info({}, { live: {} })).value).toBe('plan'); // from the settings preview
    const pending = modeSelect(info({}, { choice: { pendingMode: 'plan', applied: {}, resetPending: false } }));
    expect(pending.value).toBe('plan');
    expect(pending.title).toBe('Applies when Agent starts.');
  });

  it('marks the mode the settings pick, as model and effort do (M1 verify 2)', () => {
    expect(modeSelect(info()).options).toEqual([
      { value: 'default', label: 'Ask' },
      { value: 'plan', label: 'Plan (your settings)' },
    ]);
  });

  it('status line for a pending reset and an idle death', () => {
    expect(statusLine(info({}, { choice: { applied: {}, resetPending: true } }))).toBe(
      'Back to your settings after Agent restarts',
    );
    expect(
      statusLine(
        info(
          {},
          {
            state: {
              process: 'none',
              turn: false,
              backgroundTasks: 0,
              lastExit: { at: 1, duringTurn: false, error: 'boom' },
            },
          },
        ),
      ),
    ).toBe('Agent stopped: boom. Send a message to start it again.');
    expect(statusLine(info())).toBeUndefined();
  });

  it('splits masked text into text and secret parts, ignoring bad ranges', () => {
    const masked = '{"env":{"A":"••","B":"••"}}';
    const a = masked.indexOf('••');
    const b = masked.lastIndexOf('••');
    const segs = maskedSegments(masked, [
      { start: b, end: b + 2, key: 'env.B' },
      { start: a, end: a + 2, key: 'env.A' },
      { start: -1, end: 3 },
      { start: a, end: a + 1 },
    ]);
    expect(segs.map((s) => s.kind)).toEqual(['text', 'secret', 'text', 'secret', 'text']);
    expect(segs[1]).toEqual({ kind: 'secret', text: '••', index: 1, key: 'env.A' });
    expect(segs.map((s) => s.text).join('')).toBe(masked);
  });
});

/** A fetch fake that records calls and answers from a table. */
function fakeFetch(handler: (url: string, init?: Parameters<FetchFn>[1]) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', ...(init?.body ? { body: init.body } : {}) });
    const r = handler(url, init);
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body };
  };
  return { fetchFn, calls };
}

function manualTimers() {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  const timers: TimerApi = {
    set: (fn, ms) => {
      const t = { fn, ms };
      pending.push(t);
      return t;
    },
    clear: (h) => {
      const i = pending.indexOf(h as never);
      if (i >= 0) pending.splice(i, 1);
    },
  };
  return { timers, pending };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('api and store', () => {
  it('uses relative plugin routes and posts choices as JSON (D62)', async () => {
    const { fetchFn, calls } = fakeFetch((url) =>
      url.includes('/choice') ? { status: 200, body: { ok: true, note: 'applied' } } : { status: 200, body: {} },
    );
    const api = createApi(fetchFn);
    await api.session('s 1');
    await api.choose('s 1', { model: 'm1' });
    await api.start('s 1');
    await api.reveal('s 1', 'user', 2);
    expect(calls).toEqual([
      { url: 'api/raw-agent/session?session=s%201', method: 'GET' },
      { url: 'api/raw-agent/choice?session=s%201', method: 'POST', body: '{"model":"m1"}' },
      { url: 'api/raw-agent/start?session=s%201', method: 'POST', body: '{}' },
      { url: 'api/raw-agent/config-file?session=s%201&scope=user&reveal=2', method: 'GET' },
    ]);
  });

  it('404 means "not ours"; polling runs only while subscribed', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ status: 404, body: { error: 'not a session of this plugin' } }));
    const { timers, pending } = manualTimers();
    const store = new SessionControlStore('s1', createApi(fetchFn), timers, { ready: 1, absent: 2, error: 3 });
    const off = store.subscribe(() => {});
    await flush();
    expect(store.getSnapshot().status).toBe('absent');
    expect(pending.map((p) => p.ms)).toEqual([2]);
    pending[0]!.fn();
    await flush();
    expect(calls).toHaveLength(2);
    off();
    expect(pending).toHaveLength(0);
  });

  it('after a 404 it retries soon, then backs off (M1 live: a new task is adopted a moment later)', async () => {
    let n = 0;
    const { fetchFn } = fakeFetch(() => (++n <= 4 ? { status: 404, body: {} } : { status: 200, body: info() }));
    const { timers, pending } = manualTimers();
    const store = new SessionControlStore('s1', createApi(fetchFn), timers, {
      ready: 50,
      active: 5,
      absent: 20,
      absentFirst: 3,
      error: 9,
    });
    store.subscribe(() => {});
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      await flush();
      const p = pending.at(-1)!;
      seen.push(p.ms);
      pending.length = 0;
      p.fn();
    }
    await flush();
    expect(seen).toEqual([3, 6, 12, 20, 50]);
    expect(store.getSnapshot().status).toBe('ready');
  });

  it('a choice answer replaces the state; a refused choice shows its error', async () => {
    let n = 0;
    const { fetchFn } = fakeFetch((url) => {
      if (url.includes('/choice'))
        return ++n === 1
          ? { status: 200, body: { ok: true, note: 'applied', session: info({}, { live: { model: 'm1' } }) } }
          : { status: 409, body: { ok: false, error: 'unknown mode: x' } };
      return { status: 200, body: info() };
    });
    const store = new SessionControlStore('s1', createApi(fetchFn), manualTimers().timers);
    await store.refresh();
    await store.choose({ model: 'm1' });
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', note: 'applied', busy: false });
    expect(store.getSnapshot().info?.view.live.model).toBe('m1');
    await store.choose({ mode: 'x' });
    expect(store.getSnapshot().error).toBe('unknown mode: x');
  });

  it('drops the "applies when … starts" note once the process state changes (M1 verify 2)', async () => {
    const idle = info({}, { state: { process: 'none', turn: false, backgroundTasks: 0 }, live: {} });
    let running = false;
    const { fetchFn } = fakeFetch((url) => {
      if (url.includes('/choice'))
        return { status: 200, body: { ok: true, note: 'applies when Agent starts', session: idle } };
      return { status: 200, body: running ? info() : idle };
    });
    const store = new SessionControlStore('s1', createApi(fetchFn), manualTimers().timers);
    await store.refresh();
    await store.choose({ mode: 'plan' });
    expect(store.getSnapshot().note).toBe('applies when Agent starts');
    await store.refresh();
    expect(store.getSnapshot().note).toBe('applies when Agent starts'); // still not started
    running = true;
    await store.refresh();
    expect(store.getSnapshot().note).toBeUndefined();
  });

  it('RouteError carries the status', async () => {
    const { fetchFn } = fakeFetch(() => ({ status: 500, body: { error: 'boom' } }));
    await expect(createApi(fetchFn).session('s')).rejects.toEqual(new RouteError(500, 'boom'));
  });
});

const actions = (log: string[] = []): HostActions => ({
  openPreview: (id, p) => (log.push(`preview ${id} ${p}`), true),
  openTerminal: (id) => (log.push(`terminal ${id}`), true),
  copy: async (t) => (log.push(`copy ${t}`), true),
  portal: (n) => n,
});

describe('native permission seat (M1 verify 2)', () => {
  /** A tiny element tree: composer > [modes > permission outlet, left outlet > our bar]. */
  function tree(withSeat: boolean) {
    const attrs = new Map<string, string>();
    const composer = {
      parentElement: null,
      querySelector: (sel: string) => (withSeat && sel === `[data-slot="${NATIVE_PERMISSION_SLOT}"]` ? {} : null),
      setAttribute: (n: string, v: string) => void attrs.set(n, v),
      removeAttribute: (n: string) => void attrs.delete(n),
    };
    const outlet = { parentElement: composer, querySelector: () => null, setAttribute() {}, removeAttribute() {} };
    const bar = { parentElement: outlet, querySelector: () => null, setAttribute() {}, removeAttribute() {} };
    const styles: Array<{ id: string; textContent: string | null }> = [];
    const doc = {
      getElementById: (id: string) => styles.find((s) => s.id === id) ?? null,
      createElement: () => ({ id: '', textContent: null as string | null }),
      head: { appendChild: (n: unknown) => styles.push(n as never) },
    };
    return { attrs, bar, doc, styles };
  }

  it('marks the composer that holds the seat, adds one hiding rule, and undoes the mark', () => {
    const t = tree(true);
    const h = hideNativeSeat(t.bar, t.doc);
    expect(h.found).toBe(true);
    expect(t.attrs.has(SEAT_HIDDEN_ATTR)).toBe(true);
    expect(t.styles).toHaveLength(1);
    expect(t.styles[0]!.textContent).toBe(
      `[${SEAT_HIDDEN_ATTR}] [data-slot="${NATIVE_PERMISSION_SLOT}"]{display:none !important}`,
    );
    hideNativeSeat(t.bar, t.doc).undo();
    expect(t.styles).toHaveLength(1);
    h.undo();
    expect(t.attrs.has(SEAT_HIDDEN_ATTR)).toBe(false);
  });

  it('does nothing when no seat is found or there is no element', () => {
    const t = tree(false);
    expect(hideNativeSeat(t.bar, t.doc).found).toBe(false);
    expect(t.attrs.size).toBe(0);
    expect(hideNativeSeat(null, t.doc).found).toBe(false);
    expect(hostActions({ slots: {} as never, get: () => undefined }).hideNativeSeat).toBeTypeOf('function');
  });
});

describe('rendered UI', () => {
  it('renders nothing until the Host says the session is ours, then three pickers and the settings button', async () => {
    const { fetchFn } = fakeFetch(() => ({ status: 200, body: info() }));
    const api = createApi(fetchFn);
    const store = new SessionControlStore('s1', api, manualTimers().timers);
    const el = () => React.createElement(SessionControls, { store, api, actions: actions() });
    expect(renderToStaticMarkup(el())).toBe('');
    await store.refresh();
    const html = renderToStaticMarkup(el());
    for (const id of ['model', 'effort', 'mode', 'settings-button']) expect(html).toContain(`data-raw-agent="${id}"`);
    expect(html).toContain('Your settings (live-model)');
    expect(html).toContain('Model one');
    expect(html).toContain('Settings files');
  });

  it('the settings panel says it is read-only (rule 2)', () => {
    const api: RawAgentApi = createApi(fakeFetch(() => ({ status: 200, body: { files: [] } })).fetchFn);
    const html = renderToStaticMarkup(
      React.createElement(SettingsPanel, {
        sessionId: 's1',
        api,
        actions: actions(),
        displayName: 'Agent',
        onClose: () => {},
      }),
    );
    expect(html).toContain('Agent settings files');
    expect(html).toContain('This plugin never changes these files');
    expect(html).toContain('role="dialog"');
  });
});

describe('port', () => {
  it('registers the controls in the composer row; inject gets the session id', () => {
    const registered: Array<{ options: Record<string, unknown>; component: unknown }> = [];
    const effects: Array<() => () => void> = [];
    const ctx = {
      slots: {
        inject: (key: string, cb: () => unknown) => {
          expect(key).toBe(CONTROLS_SLOT);
          cb();
          return () => {};
        },
        register: (options: Record<string, unknown>, component: unknown) => {
          registered.push({ options, component });
          return () => {};
        },
      },
      get: () => undefined,
      effect: (fn: () => () => void) => void effects.push(fn),
    };
    const stores = mountClient(ctx as never, { fetch: fakeFetch(() => ({ status: 404, body: {} })).fetchFn });
    expect(registered).toHaveLength(1);
    expect(registered[0]!.options).toMatchObject({ name: 'conversation.input.left', id: 'raw-agent-session-controls' });
    expect(registered[0]!.component).toBe(SessionControls);
    const injected = (registered[0]!.options.inject as (id: string) => { store: SessionControlStore })('s9');
    expect(injected.store).toBe(stores.get('s9'));
    expect(effects).toHaveLength(1);
  });

  it('builds DSH preview addresses for POSIX and Windows paths', () => {
    expect(fileResourceAddress('session-1', '/home/u/.config/a b.json')).toBe(
      'dsh-resource://file/session/session-1//home/u/.config/a%20b.json',
    );
    expect(fileResourceAddress('s', 'C:\\Users\\u\\settings.json')).toBe(
      'dsh-resource://file/session/s/C:/Users/u/settings.json',
    );
  });
});

describe('status line notice (M1 live)', () => {
  it('shows the agent notice', () => {
    const i = info({}, { live: { model: 'x', notice: { level: 'notice', text: 'Using y instead.', at: 1 } } });
    expect(statusLine(i)).toBe('Agent: Using y instead.');
  });
});

describe('returned drafts (D25, M1 live)', () => {
  const apiWith = (drafts: Array<{ messageId: string; text: string; at: number }>) =>
    ({ state: async () => ({ returnedDrafts: drafts }) }) as unknown as RawAgentApi;

  it('puts the text of cancelled steers back at the caret, keeping a typed draft', async () => {
    const calls: string[] = [];
    const target = {
      setDraft: (t: string) => void calls.push(`set:${t}`),
      captureInsertion: () => 'span',
      insertText: (t: string, span: never) => (calls.push(`insert:${t}@${String(span)}`), true),
    };
    const r = await restoreReturnedDrafts(
      apiWith([
        { messageId: 'a', text: 'first ', at: 1 },
        { messageId: 'b', text: 'second', at: 2 },
      ]),
      's1',
      target,
    );
    expect(r).toEqual({ inserted: 'first\n\nsecond', droppedAttachments: 0 });
    expect(calls).toEqual(['insert:first\n\nsecond@span']);
  });

  it('never replaces the draft: a refused insert holds the text and retries it later (verify-1-2 item 2)', async () => {
    const calls: string[] = [];
    let accept = false;
    const target = {
      setDraft: (t: string) => void calls.push(`set:${t}`),
      captureInsertion: () => 0,
      insertText: (t: string) => (calls.push(`insert:${t}`), accept),
    };
    const first = await restoreReturnedDrafts(apiWith([{ messageId: 'a', text: 'x', at: 1 }]), 's1', target);
    expect(first).toEqual({ held: 'x', droppedAttachments: 0 });
    accept = true;
    const second = await restoreReturnedDrafts(
      apiWith([{ messageId: 'b', text: 'y', at: 2 }]),
      's1',
      target,
      first.held,
    );
    expect(second).toEqual({ inserted: 'x\n\ny', droppedAttachments: 0 });
    expect(calls.some((c) => c.startsWith('set:'))).toBe(false);
    // A composer with no insert: the text is held, never set over the user's draft.
    const plain = { setDraft: (t: string) => void calls.push(`set:${t}`) };
    expect(await restoreReturnedDrafts(apiWith([{ messageId: 'c', text: 'z', at: 3 }]), 's1', plain)).toEqual({
      held: 'z',
      droppedAttachments: 0,
    });
    expect(calls.some((c) => c.startsWith('set:'))).toBe(false);
    expect(await restoreReturnedDrafts(apiWith([]), 's1', target)).toEqual({ droppedAttachments: 0 });
    expect(await restoreReturnedDrafts(apiWith([]), 's1', undefined, 'h')).toEqual({
      held: 'h',
      droppedAttachments: 0,
    });
  });

  it('counts the attachments of a stopped message that cannot go back', async () => {
    const target = { setDraft: () => {}, captureInsertion: () => 0, insertText: () => true };
    const api = {
      state: async () => ({ returnedDrafts: [{ messageId: 'a', text: 'look', at: 1, attachments: 2 }] }),
    } as unknown as RawAgentApi;
    expect(await restoreReturnedDrafts(api, 's1', target)).toEqual({ inserted: 'look', droppedAttachments: 2 });
  });

  it('the api reads GET state and keeps only well-formed drafts', async () => {
    const urls: string[] = [];
    const fetchFn: FetchFn = async (url) => {
      urls.push(url);
      return {
        status: 200,
        ok: true,
        json: async () => ({ returnedDrafts: [{ messageId: 'a', text: 't', at: 1 }, { bad: 1 }] }),
      };
    };
    const r = await createApi(fetchFn).state('s 1');
    expect(urls).toEqual(['api/raw-agent/state?session=s%201']);
    expect(r.returnedDrafts).toEqual([{ messageId: 'a', text: 't', at: 1 }]);
  });
});

describe('M1 verify fixes (client)', () => {
  it('the model picker names the model that really runs when the agent substituted it (R1.4)', () => {
    const v = modelSelect(
      info(
        {},
        {
          live: { model: 'big-model' },
          choice: { model: 'bogus-1', applied: { model: 'bogus-1' }, resetPending: false },
        },
      ),
    );
    expect(v.options.find((o) => o.value === 'bogus-1')!.label).toBe('bogus-1 (running: big-model)');
    // M1 live: the CLI refused setModel for a restricted id and ran its own model instead.
    const refused = modelSelect(
      info(
        {},
        {
          live: { model: 'big-model' },
          choice: { model: 'bogus-1', applied: {}, refused: { model: 'bogus-1' }, resetPending: false },
        },
      ),
    );
    expect(refused.options.find((o) => o.value === 'bogus-1')!.label).toBe('bogus-1 (running: big-model)');
    const same = modelSelect(
      info({}, { live: { model: 'm1' }, choice: { model: 'm1', applied: { model: 'm1' }, resetPending: false } }),
    );
    expect(same.options.find((o) => o.value === 'm1')!.label).toBe('Model one');
  });

  it('pending asks render as headings with their own choices; trust is in the status line (R1.2, D73)', () => {
    const i = info(
      { trust: { state: 'untrusted', directory: '/w', effect: 'project permission rules are ignored' } },
      {
        asks: [
          {
            id: 'p1',
            kind: 'permission',
            agent: 'child',
            title: 'Bash wants to run',
            detail: 'ls',
            choices: [{ id: 'allow-once', label: 'Allow once' }],
            stopChoice: 'reject',
            at: 2,
          },
        ],
      },
    );
    expect(askModels(i)).toEqual([
      {
        id: 'p1',
        heading: 'A Agent subagent asks for permission: Bash wants to run',
        detail: 'ls',
        choices: [{ id: 'allow-once', label: 'Allow once' }],
      },
    ]);
    expect(statusLine(i)).toBe(
      'Agent does not trust this folder yet (project permission rules are ignored). It asks before it starts.',
    );
  });

  it('an ask renders buttons; a click posts the answer (never answered without one)', async () => {
    const bodies: string[] = [];
    const withAsk = info(
      {},
      {
        asks: [
          {
            id: 'p1',
            kind: 'permission',
            agent: 'main',
            title: 'Bash wants to run',
            choices: [
              { id: 'allow-once', label: 'Allow once' },
              { id: 'reject', label: 'Reject' },
            ],
            stopChoice: 'reject',
            at: 1,
          },
        ],
      },
    );
    const fetchFn: FetchFn = async (url, init) => {
      if (url.includes('/answer')) bodies.push(init?.body ?? '');
      return { status: 200, ok: true, json: async () => (url.includes('/answer') ? { ok: true } : withAsk) };
    };
    const api = createApi(fetchFn);
    const store = new SessionControlStore('s1', api, manualTimers().timers);
    await store.refresh();
    const html = renderToStaticMarkup(React.createElement(SessionControls, { store, api, actions: actions() }));
    expect(html).toContain('data-raw-agent="ask-card"');
    expect(html).toContain('Allow once');
    expect(bodies).toEqual([]);
    await store.answer('p1', 'reject');
    expect(bodies).toEqual([JSON.stringify({ ask: 'p1', choice: 'reject' })]);
  });

  it('"Open in terminal" copies a cd to the file folder (D63)', () => {
    expect(folderOf('/home/u/.claude/settings.json')).toBe('/home/u/.claude');
    expect(folderOf('C:\\Users\\u\\.claude\\settings.json')).toBe('C:\\Users\\u\\.claude');
    expect(folderOf('C:\\settings.json')).toBe('C:\\');
    expect(folderOf('/settings.json')).toBe('/');
    expect(cdCommand('/w/.claude/settings.local.json')).toBe('cd "/w/.claude"');
    expect(cdCommand('/a"b/settings.json')).toBe(`cd '/a"b'`);
  });

  it('names the layer of each key (D63) and shows it in the panel', () => {
    const rows = keyLayerRows(
      [
        { key: 'env', scopes: ['local', 'user'], merged: true },
        { key: 'model', scopes: ['project', 'user'] },
        { key: 'theme', scopes: ['user'] },
      ],
      (s) => ({ local: 'Local', project: 'Project', user: 'User' })[s] ?? s,
    );
    expect(rows).toEqual([
      { key: 'env', text: 'combined from Local + User' },
      { key: 'model', text: 'Project (overrides User)' },
      { key: 'theme', text: 'User' },
    ]);
    const api: RawAgentApi = createApi(fakeFetch(() => ({ status: 200, body: { files: [] } })).fetchFn);
    const html = renderToStaticMarkup(
      React.createElement(SettingsPanel, {
        sessionId: 's1',
        api,
        actions: actions(),
        displayName: 'Agent',
        keys: [{ key: 'model', scopes: ['user'] }],
        onClose: () => {},
      }),
    );
    expect(html).toContain('Which file sets each key');
    expect(html).toContain('data-raw-agent="settings-key"');
  });
});

describe('controls bar layout', () => {
  it('takes the space left in the composer row and never squeezes DSH items (M1 live: ask buttons covered)', async () => {
    const { css } = await import('../src/ui/style.js');
    expect(css.bar.flex).toBe('1 1 0%');
    expect(css.bar.minWidth).toBe(0);
  });
});
