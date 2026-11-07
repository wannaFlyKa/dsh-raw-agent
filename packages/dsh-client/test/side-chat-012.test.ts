// 0.1.2 (D89): the side chat as a tab of DSH's right sidebar. Registration through the public
// tab-type registry, one tab per session, prefill into the tab, and the inline box on a DSH
// without that API. No DSH and no browser needed.

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  SIDE_CHAT_TAB_ID,
  SIDE_CHAT_TAB_KIND,
  SIDE_CHAT_TAB_SLOT,
  SessionControls,
  SessionStores,
  SideChatTab,
  createRawAgentClientService,
  hostActions,
  mountClient,
  openSideChatTab,
  registerSideChat,
  sideChatElsewhereText,
  sideChatTabDefinition,
  type HostActions,
  type PluginApi,
  type RawAgentApi,
  type SessionInfo,
  type SideViewWire,
  type TimerApi,
} from '@dsh-raw-agent/dsh-client';

const timers = (): TimerApi => ({ set: () => 0, clear: () => {} });

function info(side?: SideViewWire): SessionInfo {
  return {
    backend: { kind: 'k', displayName: 'Agent' },
    permissionModes: [{ id: 'default', label: 'Default' }],
    efforts: [],
    needsProcess: [],
    models: [],
    modelsFrom: 'none',
    view: {
      state: { process: 'running', turn: true, backgroundTasks: 0 },
      live: { model: 'm', mode: 'default' },
      choice: { applied: {}, resetPending: false },
      ...(side ? { side } : {}),
    },
  } as SessionInfo;
}

const sides: Record<string, SideViewWire> = {
  s1: {
    entries: [{ id: 'a', question: 'What changed in s1?', status: 'answered', at: 1, answer: 'The **a.ts** file.' }],
    historySize: 1,
  },
  s2: { entries: [{ id: 'b', question: 'Why s2?', status: 'asking', at: 1 }], historySize: 0 },
};

function api(over: Partial<RawAgentApi> = {}): RawAgentApi {
  return {
    session: async (id: string) => {
      if (id === 'other') {
        const { RouteError } = await import('@dsh-raw-agent/dsh-client');
        throw new RouteError(404, 'not ours');
      }
      return info(sides[id]);
    },
    askSide: async () => ({ ok: true }),
    cancelSide: async () => ({ ok: true }),
    ...over,
  } as unknown as RawAgentApi;
}

async function readyStores(a = api()): Promise<SessionStores> {
  const stores = new SessionStores(a, timers());
  for (const id of ['s1', 's2', 'other']) await stores.get(id).refresh();
  return stores;
}

const baseActions = (over: Partial<HostActions> = {}): HostActions => ({
  openPreview: () => true,
  openTerminal: () => true,
  copy: async () => true,
  portal: (n) => n,
  ...over,
});

describe('side chat tab registration (0.1.2)', () => {
  it('registers a page type with no guide entry and the body under its id', () => {
    const defs: Array<Record<string, unknown>> = [];
    const registered: Array<Record<string, unknown>> = [];
    let disposed = 0;
    const effects: Array<() => () => void> = [];
    const scope = {
      slots: {
        inject: (_k: string, cb: () => unknown) => void cb(),
        register: (o: Record<string, unknown>) => {
          registered.push(o);
          return () => {};
        },
      },
      get: () => undefined,
      effect: (fn: () => () => void) => void effects.push(fn),
    };
    const state = { on: false };
    const stores = new SessionStores(api(), timers());
    const registry = {
      register: (d: Record<string, unknown>) => {
        defs.push(d);
        return () => void disposed++;
      },
    };
    expect(registerSideChat(scope as never, registry, state, { stores, api: api(), agentNames: ['Agent'] })).toBe(true);
    expect(state.on).toBe(false); // the type registers in the scope's effect
    const undo = effects[0]!();
    expect(state.on).toBe(true);
    expect(defs[0]).toMatchObject({ id: SIDE_CHAT_TAB_ID, kind: SIDE_CHAT_TAB_KIND, keepMounted: true });
    expect(defs[0]!.guide).toBeUndefined(); // the guide is shared by every session; ours is not
    expect((defs[0]!.title as (a: string) => string)('x')).toBe('Side chat');
    expect(registered[0]).toMatchObject({ name: SIDE_CHAT_TAB_SLOT, key: SIDE_CHAT_TAB_ID });
    const injected = (registered[0]!.inject as (id: string) => Record<string, unknown>)('s1');
    expect(injected).toMatchObject({ sessionId: 's1', stores, agentNames: ['Agent'] });
    undo();
    expect(state.on).toBe(false);
    expect(disposed).toBe(1);
  });

  it('a registry that refuses the type keeps the inline box', () => {
    const state = { on: false };
    const scope = { slots: { inject: () => () => {}, register: () => () => {} }, get: () => undefined };
    const registry = {
      register: () => {
        throw new Error('kind taken');
      },
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      registerSideChat(scope as never, registry, state, {
        stores: new SessionStores(api(), timers()),
        api: api(),
        agentNames: [],
      });
    } finally {
      console.warn = warn;
    }
    expect(state.on).toBe(false);
    expect(registerSideChat(scope as never, undefined, state, {} as never)).toBe(false);
  });

  it('mountClient registers the tab where DSH has the sidebar API, and not on an older DSH', () => {
    const run = (services: Record<string, unknown>) => {
      const registered: string[] = [];
      const effects: Array<() => () => void> = [];
      const slots = {
        inject: (_k: string, cb: () => unknown) => void cb(),
        register: (o: Record<string, unknown>) => {
          registered.push(String(o.name));
          return () => {};
        },
      };
      const ctx = {
        slots,
        get: (n: string) => services[n],
        effect: (fn: () => () => void) => void effects.push(fn),
        inject: (deps: string[], fn: (scope: unknown) => void) => {
          if (deps.some((d) => d !== 'slots' && services[d] === undefined)) return; // Cordis waits
          fn({ ...Object.fromEntries(deps.map((d) => [d, services[d]])), slots, get: ctx.get, effect: ctx.effect });
        },
      };
      const warn = console.warn;
      console.warn = () => {};
      try {
        mountClient(ctx as never, { fetch: async () => ({ status: 404, ok: false, json: async () => ({}) }) });
        for (const e of effects) e();
      } finally {
        console.warn = warn;
      }
      return registered;
    };
    const tabs = { register: () => () => {} };
    const sidebarRight = { openTabIn: () => {} };
    expect(run({ sidebarRightTabs: tabs, sidebarRight })).toContain(SIDE_CHAT_TAB_SLOT);
    expect(run({})).not.toContain(SIDE_CHAT_TAB_SLOT);
  });

  it('the definition is plain data (no DSH import)', () => {
    expect(Object.keys(sideChatTabDefinition()).sort()).toEqual(['id', 'keepMounted', 'kind', 'priority', 'title']);
  });
});

describe('opening the tab (0.1.2)', () => {
  it('opens the tab in the session through the public openTabIn', () => {
    const opened: string[] = [];
    const sidebar = { openTabIn: (s: string, k: string) => void opened.push(`${s}:${k}`) };
    expect(openSideChatTab(sidebar, { on: true }, 's1')).toBe(true);
    expect(opened).toEqual([`s1:${SIDE_CHAT_TAB_KIND}`]);
    expect(openSideChatTab(sidebar, { on: false }, 's1')).toBe(false);
    expect(openSideChatTab(undefined, { on: true }, 's1')).toBe(false);
  });

  it('quiet: leaves the active tab alone while the user types in it', () => {
    const opened: string[] = [];
    const sidebar = {
      openTabIn: (s: string) => void opened.push(s),
      mounted: { getSnapshot: () => 's1' },
      isExpanded: () => true,
      active: () => ({ id: 't1', kind: SIDE_CHAT_TAB_KIND }),
    };
    expect(openSideChatTab(sidebar, { on: true }, 's1', { quiet: true })).toBe(true);
    expect(opened).toEqual([]);
    // Another session, or a collapsed column: open (reveal) it.
    expect(openSideChatTab(sidebar, { on: true }, 's2', { quiet: true })).toBe(true);
    expect(openSideChatTab({ ...sidebar, isExpanded: () => false }, { on: true }, 's1', { quiet: true })).toBe(true);
    expect(opened).toEqual(['s2', 's1']);
  });

  it('a sidebar that throws answers false, so the inline box shows', () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      const sidebar = {
        openTabIn: () => {
          throw new Error('no surface');
        },
      };
      expect(openSideChatTab(sidebar, { on: true }, 's1')).toBe(false);
    } finally {
      console.warn = warn;
    }
  });

  it('hostActions: the sidebar mode needs both the tab type and openTabIn', () => {
    const state = { on: true };
    const withSidebar = hostActions({ get: () => ({ openTabIn: () => {} }) } as never, state);
    expect(withSidebar.sideChatInSidebar?.()).toBe(true);
    expect(withSidebar.openSideChat?.('s1')).toBe(true);
    const older = hostActions({ get: () => ({}) } as never, state);
    expect(older.sideChatInSidebar?.()).toBe(false);
    expect(hostActions({ get: () => ({ openTabIn: () => {} }) } as never).sideChatInSidebar?.()).toBe(false);
  });
});

describe('the tab follows its own session (0.1.2)', () => {
  it('each session shows its own questions; a session that is not ours says so', async () => {
    const stores = await readyStores();
    const render = (sessionId: string) =>
      renderToStaticMarkup(
        React.createElement(SideChatTab, { sessionId, stores, api: api(), agentNames: ['Agent CLI'] }),
      );
    const one = render('s1');
    expect(one).toContain('data-raw-agent="side-chat"');
    expect(one).toContain('aria-label="Side chat"');
    expect(one).toContain('What changed in s1?');
    expect(one).toContain('<strong>a.ts</strong>'); // Markdown answer
    expect(one).not.toContain('Why s2?');
    expect(one).toContain('role="log"');
    const two = render('s2');
    expect(two).toContain('Why s2?');
    expect(two).toContain('aria-busy="true"');
    expect(two).not.toContain('What changed in s1?');
    const other = render('other');
    expect(other).toContain(sideChatElsewhereText(['Agent CLI']));
    expect(other).not.toContain('side-input');
    expect(sideChatElsewhereText(['Agent CLI'])).toBe(
      'Side chat works only in Agent CLI sessions. This session runs another agent.',
    );
  });

  it('newest at the bottom, the box and Ask under the list', async () => {
    const two: SideViewWire = {
      entries: [
        { id: 'a', question: 'Q-one', status: 'answered', at: 1, answer: 'x' },
        { id: 'b', question: 'Q-two', status: 'answered', at: 2, answer: 'y' },
      ],
      historySize: 2,
    };
    const stores = new SessionStores(api({ session: async () => info(two) } as never), timers());
    await stores.get('s1').refresh();
    const html = renderToStaticMarkup(React.createElement(SideChatTab, { sessionId: 's1', stores, api: api() }));
    expect(html.indexOf('Q-one')).toBeLessThan(html.indexOf('Q-two'));
    expect(html.indexOf('Q-two')).toBeLessThan(html.indexOf('side-input'));
    expect(html.indexOf('side-input')).toBeLessThan(html.indexOf('side-ask'));
  });
});

describe('prefill into the tab (R9.2, 0.1.2)', () => {
  const plugin = {} as PluginApi;
  it('the service prefill reaches the tab once', async () => {
    const stores = await readyStores();
    const svc = createRawAgentClientService(stores, plugin);
    expect(await svc.prefill('s1', 'why?', 'side-question')).toBe(true);
    const store = stores.get('s1');
    expect(store.takeSidePrefill()).toMatchObject({ text: 'why?' });
    expect(store.takeSidePrefill()).toBeUndefined(); // a remounted tab does not take it again
    await svc.prefill('s1', 'compose', 'composer');
    expect(store.takeSidePrefill()).toBeUndefined(); // composer text is not for the tab
    await svc.prefill('s1', 'again', 'side-question');
    expect(store.takeSidePrefill()).toMatchObject({ text: 'again' });
  });
});

describe('controls: tab or inline box (0.1.2)', () => {
  it('with the sidebar: a "Side chat" button and no inline box', async () => {
    const stores = await readyStores();
    const opened: string[] = [];
    const html = renderToStaticMarkup(
      React.createElement(SessionControls, {
        store: stores.get('s1'),
        api: api(),
        actions: baseActions({
          sideChatInSidebar: () => true,
          openSideChat: (id) => {
            opened.push(id);
            return true;
          },
        }),
      }),
    );
    expect(html).toContain('data-raw-agent="side-button"');
    expect(html).toContain('Side chat</button>');
    expect(html).not.toContain('Side questions');
    expect(html).not.toContain('side-panel');
  });

  it('without the sidebar (older DSH): the old "Side questions" button and box', async () => {
    const stores = await readyStores();
    const html = renderToStaticMarkup(
      React.createElement(SessionControls, { store: stores.get('s1'), api: api(), actions: baseActions() }),
    );
    expect(html).toContain('Side questions');
    expect(html).not.toContain('Side chat</button>');
  });
});
