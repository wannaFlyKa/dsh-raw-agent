// 0.1.1 UI polish: compact chips, mode colours, the full-access confusion fix and the fading
// status note. No DSH and no browser needed.

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_NOTE_ORDER,
  CHIP_CLASS,
  CHIP_CSS,
  ERROR_SHOW_MS,
  FADE_TIMERS,
  NOTE_SHOW_MS,
  PRESET_DECORATION,
  SessionControlStore,
  SessionControls,
  SessionStores,
  accessNoteText,
  choiceNote,
  createApi,
  effortChip,
  guardPresetDecoration,
  isOurPreset,
  isOurSession,
  modeChip,
  modePopup,
  modePopupOptions,
  modelChip,
  shortModelName,
  statusLine,
  type FetchFn,
  type HostActions,
  type SessionInfo,
  type TimerApi,
} from '@dsh-raw-agent/dsh-client';

function info(over: Partial<SessionInfo> = {}, view: Partial<SessionInfo['view']> = {}): SessionInfo {
  return {
    backend: { kind: 'claude-code', displayName: 'Claude Code' },
    permissionModes: [
      { id: 'default', label: 'Ask before edits', shortLabel: 'Default', risk: 'neutral' },
      { id: 'acceptEdits', label: 'Accept edits', risk: 'caution' },
      { id: 'plan', label: 'Plan mode', shortLabel: 'Plan', risk: 'plan' },
      { id: 'auto', label: 'Auto', risk: 'caution' },
      { id: 'dontAsk', label: "Don't ask", risk: 'caution' },
    ],
    unavailableModes: [
      {
        id: 'bypassPermissions',
        label: 'Bypass permissions',
        shortLabel: 'Bypass',
        risk: 'danger',
        requiresOption: 'allowDangerouslySkipPermissions',
        optionLabel: 'Allow bypass permissions mode',
      },
    ],
    efforts: [
      { id: 'high', label: 'High' },
      { id: 'xhigh', label: 'Extra high' },
      { id: 'ultracode', label: 'Ultracode', kind: 'mode' },
    ],
    needsProcess: [],
    models: [{ value: 'claude-sonnet-4-5', displayName: 'Sonnet 4.5' }],
    modelsFrom: 'session',
    settings: { model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'auto', sources: {} },
    view: {
      state: { process: 'running', turn: false, backgroundTasks: 0 },
      live: { model: 'global.anthropic.claude-opus-5-5', mode: 'auto', effort: 'xhigh' },
      choice: { applied: {}, resetPending: false },
      ...view,
    },
    ...over,
  } as SessionInfo;
}

const actions = (): HostActions => ({
  openPreview: () => true,
  openTerminal: () => true,
  copy: async () => true,
  portal: (n) => n,
});

function fakeFetch(handler: (url: string) => { status: number; body: unknown }) {
  const calls: string[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url} ${init?.body ?? ''}`);
    const r = handler(url);
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body };
  };
  return { fetchFn, calls };
}

const timers = (): TimerApi => ({ set: () => 0, clear: () => {} });

describe('chips: short values (change 1)', () => {
  it('shortens model ids, with or without a provider prefix', () => {
    expect(shortModelName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(shortModelName('global.anthropic.claude-opus-5-5')).toBe('Opus 5.5');
    expect(shortModelName('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('Sonnet 4.5');
    expect(shortModelName('claude-3-5-haiku-20241022')).toBe('Haiku 3.5');
    expect(shortModelName('claude-opus-4-1[1m]')).toBe('Opus 4.1 (1M)');
    expect(shortModelName('sonnet')).toBe('Sonnet');
    expect(shortModelName('some-very-long-custom-model-name-x')).toBe('some-very-long-custom-m…');
  });

  it('model chip: the settings model with a dot, a chosen model without one', () => {
    expect(modelChip(info())).toMatchObject({ text: 'Opus 5.5', fromSettings: true });
    expect(modelChip(info()).full).toBe('Your settings (global.anthropic.claude-opus-5-5)');
    const chosen = modelChip(info({}, { choice: { model: 'claude-sonnet-4-5', applied: {}, resetPending: false } }));
    expect(chosen).toMatchObject({ text: 'Sonnet 4.5', fromSettings: false, full: 'Sonnet 4.5' });
  });

  it('effort chip: the level id; ultracode shown as itself', () => {
    expect(effortChip(info())).toMatchObject({ text: 'xhigh', fromSettings: true });
    const ultra = info({}, { live: { mode: 'auto', effort: 'xhigh', ultracode: { on: true, available: true } } });
    expect(effortChip(ultra)).toMatchObject({ text: 'Ultracode', fromSettings: true, sessionMode: true });
    const picked = info({}, { choice: { effort: 'ultracode', applied: {}, resetPending: false } });
    expect(effortChip(picked)).toMatchObject({ text: 'Ultracode', fromSettings: false, sessionMode: true });
    const level = info({}, { choice: { effort: 'high', applied: { effort: 'high' }, resetPending: false } });
    expect(effortChip(level)).toMatchObject({ text: 'high', fromSettings: false });
  });

  it('renders chips (DSH pill style), keeps the native select, the empty state and the text buttons', async () => {
    const empty = info(
      { models: [], modelsFrom: 'none', settings: { sources: {} } },
      { state: { process: 'none', turn: false, backgroundTasks: 0 }, live: {} },
    );
    const { fetchFn } = fakeFetch(() => ({ status: 200, body: empty }));
    const api = createApi(fetchFn);
    const store = new SessionControlStore('s1', api, timers());
    await store.refresh();
    const html = renderToStaticMarkup(React.createElement(SessionControls, { store, api, actions: actions() }));
    expect(html).toContain('Start Claude Code to list models');
    for (const id of ['model', 'effort', 'mode']) {
      expect(html).toContain(`data-raw-agent="${id}-chip"`);
      expect(html).toMatch(new RegExp(`<select[^>]*data-raw-agent="${id}"`));
    }
    for (const id of ['settings-button', 'rewind-button'])
      if (html.includes(`data-raw-agent="${id}"`))
        expect(html).toMatch(new RegExp(`class="${CHIP_CLASS}"[^>]*data-raw-agent="${id}"`));
    expect(html).toContain('Settings files');
    expect(html).not.toMatch(/<select[^>]*style=/); // no bordered native dropdowns any more
    expect(html).toContain('data-raw-agent="chip-style"');
  });

  it('a settings value carries a dot and "from your settings" in its name and tooltip', async () => {
    const { fetchFn } = fakeFetch(() => ({ status: 200, body: info() }));
    const api = createApi(fetchFn);
    const store = new SessionControlStore('s1', api, timers());
    await store.refresh();
    const html = renderToStaticMarkup(React.createElement(SessionControls, { store, api, actions: actions() }));
    expect(html).toMatch(/data-raw-agent="model-chip"[^>]*data-from-settings=""/);
    expect(html).toContain('data-chip-dot=""');
    expect(html).toContain(
      'aria-label="Claude Code model for this session: Your settings (global.anthropic.claude-opus-5-5), from your settings"',
    );
    expect(html).toContain('title="From your settings: Your settings (global.anthropic.claude-opus-5-5).');
    expect(html).toMatch(/<span data-chip-text="" aria-hidden="true">Opus 5.5<\/span>/);
    expect(html).toMatch(/<span data-chip-text="" aria-hidden="true">xhigh<\/span>/);
    expect(html).toMatch(/<span data-chip-text="" aria-hidden="true">Auto<\/span>/);
  });

  it('the style sheet uses DSH tokens, as DSH composer pills do', () => {
    for (const t of [
      '--dsw-alias-label-tertiary',
      '--dsw-radius-sm',
      '--dsw-alias-interactive-bg-hover',
      '--dsh-content-font-size-secondary',
    ])
      expect(CHIP_CSS).toContain(t);
  });
});

describe('mode chip colour (change 2)', () => {
  const at = (mode: string) => modeChip(info({}, { live: { mode } }));
  it('neutral, plan blue, caution amber, bypass red', () => {
    expect(at('default')).toMatchObject({ text: 'Default', risk: 'neutral' });
    expect(at('plan')).toMatchObject({ text: 'Plan', risk: 'plan' });
    expect(at('acceptEdits').risk).toBe('caution');
    expect(at('auto')).toMatchObject({ text: 'Auto', risk: 'caution', fromSettings: true });
    expect(at('dontAsk').risk).toBe('caution');
    expect(at('bypassPermissions')).toMatchObject({ text: 'Bypass', risk: 'danger' });
  });

  it('each risk has a rule built on DSH state tokens mixed with the label colour (both themes)', () => {
    expect(CHIP_CSS).toMatch(
      /\[data-risk="plan"\]\{color:color-mix\(in srgb, var\(--raw-agent-chip-plan, var\(--dsw-alias-state-business-primary/,
    );
    expect(CHIP_CSS).toMatch(/\[data-risk="caution"\][^}]*--dsw-alias-state-warn-primary/);
    expect(CHIP_CSS).toMatch(/\[data-risk="danger"\][^}]*--dsw-alias-state-error-primary/);
    expect(CHIP_CSS).toContain('var(--dsw-alias-label-primary, CanvasText)');
    expect(CHIP_CSS).not.toMatch(/\[data-risk="neutral"\]/); // neutral is the plain grey chip
  });

  it('the rendered mode chip carries its risk', async () => {
    const { fetchFn } = fakeFetch(() => ({ status: 200, body: info({}, { live: { mode: 'plan' } }) }));
    const api = createApi(fetchFn);
    const store = new SessionControlStore('s1', api, timers());
    await store.refresh();
    const html = renderToStaticMarkup(React.createElement(SessionControls, { store, api, actions: actions() }));
    expect(html).toMatch(/data-raw-agent="mode-chip" data-risk="plan"/);
  });
});

describe('full access (change 3)', () => {
  it('the /permission popup lists the agent modes only, with the reasons', () => {
    const rows = modePopupOptions(info());
    expect(rows.map((r) => r.id)).toEqual(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']);
    expect(rows.some((r) => /workspace|full|read-only/i.test(r.id))).toBe(false);
    expect(rows.find((r) => r.id === 'auto')).toMatchObject({ active: true, badge: 'your settings' });
    expect(rows.find((r) => r.id === 'bypassPermissions')!.blocked).toMatch(/Allow bypass permissions mode/);
    expect(rows.find((r) => r.id === 'bypassPermissions')!.confirmation).toBeUndefined();
    const on = modePopupOptions(
      info({ permissionModes: [...info().permissionModes, ...info().unavailableModes!], unavailableModes: [] }),
    );
    expect(on.find((r) => r.id === 'bypassPermissions')!.confirmation?.title).toBe('Switch to Bypass permissions?');
  });

  it('a pick goes to the session choice; a blocked mode only says why', async () => {
    const { fetchFn, calls } = fakeFetch((url) =>
      url.includes('/choice')
        ? { status: 200, body: { ok: true, note: 'applied', session: info({}, { live: { mode: 'plan' } }) } }
        : { status: 200, body: info() },
    );
    const stores = new SessionStores(createApi(fetchFn));
    const popup = modePopup(stores);
    expect((await popup.options({ sessionId: 's1' })).length).toBe(6);
    await popup.onSelect({ id: 'bypassPermissions' }, { sessionId: 's1' });
    expect(calls.some((c) => c.includes('/choice'))).toBe(false);
    expect(stores.get('s1').getSnapshot().note).toMatch(/^Bypass permissions: Needs the plugin option/);
    await popup.onSelect({ id: 'plan' }, { sessionId: 's1' });
    expect(calls.find((c) => c.includes('/choice'))).toContain('"mode":"plan"');
    expect(stores.get('s1').getSnapshot().note).toBe('Permission mode: Plan mode (this session)');
    stores.dispose();
  });

  it("DSH's preset popup is replaced in our sessions only", () => {
    const live = { decorations: new Map<string, unknown>() };
    const popup = modePopup(new SessionStores(createApi(fakeFetch(() => ({ status: 404, body: {} })).fetchFn)));
    guardPresetDecoration({ live }, (id) => id === 'ours', popup);
    const dsh = { name: PRESET_DECORATION, available: () => true, ui: { kind: 'popupSelect', presets: true } };
    live.decorations.set(PRESET_DECORATION, dsh);
    const read = () => live.decorations.get(PRESET_DECORATION) as { available(s: unknown): boolean; ui: unknown };
    let d = read();
    expect(d.available({ sessionId: 'ours' })).toBe(true);
    expect(d.ui).toBe(popup);
    d = read();
    expect(d.available({ sessionId: 'standard' })).toBe(true);
    expect(d.ui).toBe(dsh.ui);
  });

  it('a session that picked our preset counts as ours at once and is read again', async () => {
    let n = 0;
    const { fetchFn } = fakeFetch(() => (++n === 1 ? { status: 404, body: {} } : { status: 200, body: info() }));
    const stores = new SessionStores(createApi(fetchFn));
    const store = stores.get('s1');
    await store.refresh();
    expect(store.getSnapshot().status).toBe('absent');
    expect(isOurSession(stores, 's1')).toBe(false);
    store.notePreset(true);
    expect(isOurSession(stores, 's1')).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getSnapshot().status).toBe('ready');
    expect(isOurPreset('raw-agent-claude-code')).toBe(true);
    expect(isOurPreset('standard')).toBe(false);
    stores.dispose();
  });

  it("before our route answers, a session of our preset still hides DSH's seat", () => {
    const store = new SessionControlStore(
      's1',
      createApi(fakeFetch(() => ({ status: 404, body: {} })).fetchFn),
      timers(),
    );
    const hidden: unknown[] = [];
    const a: HostActions = {
      ...actions(),
      isOurPreset,
      hideNativeSeat: (el) => (hidden.push(el), { found: true, undo() {} }),
    };
    const html = renderToStaticMarkup(
      React.createElement(SessionControls, {
        store,
        api: createApi(fakeFetch(() => ({ status: 404, body: {} })).fetchFn),
        actions: a,
        useProjection: (k: string) => (k === 'agentPreset' ? 'raw-agent-claude-code' : undefined),
      }),
    );
    expect(html).toContain('data-raw-agent="controls-pending"');
    const plain = renderToStaticMarkup(
      React.createElement(SessionControls, {
        store,
        api: createApi(fakeFetch(() => ({ status: 404, body: {} })).fetchFn),
        actions: a,
        useProjection: () => 'standard',
      }),
    );
    expect(plain).toBe('');
  });

  it('the settings note says DSH access does not apply and names the agent ways', () => {
    const t = accessNoteText(['Claude Code']);
    expect(t.title).toBe('Claude Code sessions do not use this access setting');
    expect(t.detail).toMatch(/bypassPermissions \(needs the plugin option allowDangerouslySkipPermissions\) or Auto/);
    expect(ACCESS_NOTE_ORDER).toBe(-19); // right after DSH's access row (order -20)
  });
});

describe('status line (change 4)', () => {
  it('our /permission answer has no agent-name prefix; no line gets the name twice', () => {
    const notice = (text: string, topic?: 'mode') =>
      info({}, { live: { mode: 'auto', notice: { level: 'info', text, at: 1, ...(topic ? { topic } : {}) } } });
    expect(statusLine(notice('Permission mode: Auto (this session).', 'mode'))).toBe(
      'Permission mode: Auto (this session).',
    );
    expect(statusLine(notice('Claude Code could not start.'))).toBe('Claude Code could not start.');
    expect(statusLine(notice('Using y instead.'))).toBe('Claude Code: Using y instead.');
  });

  it('a mode choice note names the mode, and drops a bare "applied"', () => {
    expect(choiceNote({ mode: 'auto' }, 'applied', info())).toBe('Permission mode: Auto (this session)');
    expect(choiceNote({ mode: 'plan' }, 'applies when Claude Code starts', info())).toBe(
      'Permission mode: Plan mode (this session; applies when Claude Code starts)',
    );
    expect(choiceNote({ model: 'm' }, 'applied', info())).toBe('applied');
  });

  it('the note is a live region; it fades out of the row (errors stay longer)', async () => {
    expect(NOTE_SHOW_MS).toBeLessThan(ERROR_SHOW_MS);
    expect(NOTE_SHOW_MS).toBeLessThanOrEqual(6000);
    const { fetchFn } = fakeFetch(() => ({
      status: 200,
      body: info(
        {},
        {
          live: {
            mode: 'auto',
            notice: { level: 'warning', text: 'DSH file access does not apply.', at: 1, topic: 'mode' },
          },
        },
      ),
    }));
    const api = createApi(fetchFn);
    const store = new SessionControlStore('s1', api, timers());
    await store.refresh();
    const html = renderToStaticMarkup(React.createElement(SessionControls, { store, api, actions: actions() }));
    expect(html).toMatch(
      /class="raw-agent-status" data-raw-agent="status" role="status" aria-live="polite" data-level="error"/,
    );
    expect(CHIP_CSS).toMatch(
      /\.raw-agent-status\[data-faded\]\{position:absolute;width:1px;height:1px;overflow:hidden;clip/,
    );
    expect(CHIP_CSS).toMatch(/\.raw-agent-status\[data-fading\]\{opacity:0\}/);
  });

  it('the fade timers call the browser timer functions unbound (live: "Illegal invocation")', () => {
    const real = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const strict = function (this: unknown, ...a: unknown[]) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      return (real as unknown as (...x: unknown[]) => unknown)(...a);
    };
    globalThis.setTimeout = strict as never;
    globalThis.clearTimeout = function (this: unknown, h: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      realClear(h as never);
    } as never;
    try {
      const h = FADE_TIMERS.set(() => {}, 1);
      FADE_TIMERS.clear(h);
    } finally {
      globalThis.setTimeout = real;
      globalThis.clearTimeout = realClear;
    }
  });
});
