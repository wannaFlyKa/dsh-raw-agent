// R9.1, R9.2: the sample plugin (examples/sample-restyle). It must load in DSH's module-loader
// format, shadow our context pill (same slot and id, lower priority), fill the slot our client
// declares, and call every `rawAgentClient` method. The targets are checked against our real
// client port, so a renamed id or slot fails here. Hooks run in a tiny in-test runtime (no DOM).

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RawAgentServiceError, type RawAgentClientService, type RawAgentPublicEvent } from '@dsh-raw-agent/core';
import {
  CONTEXT_PILL_ENTRY_ID,
  CONTEXT_PILL_SLOT,
  PLUGIN_EXTRAS_SLOT,
  SessionStores,
  createRawAgentClientService,
  mountClient,
  type PluginApi,
  type RawAgentApi,
} from '@dsh-raw-agent/dsh-client';

/* eslint-disable @typescript-eslint/no-explicit-any */
const root = fileURLToPath(new URL('../../../', import.meta.url));
const dir = `${root}examples/sample-restyle/`;
const reactRequire = createRequire(`${root}packages/dsh-client/package.json`);
const ReactReal = reactRequire('react') as typeof import('react');
const { renderToStaticMarkup } = reactRequire('react-dom/server') as { renderToStaticMarkup(el: unknown): string };

/** Load client.js as DSH does: one `__ModuleLoader__.load` row, its factory gets `require`. */
function loadSample(react: unknown = reactRequire('react')): any {
  const loads: Array<{ id: string; factory: (req: (id: string) => unknown) => any }> = [];
  const requested: string[] = [];
  new Function('window', readFileSync(`${dir}client.js`, 'utf8'))({
    __ModuleLoader__: { load: (row: (typeof loads)[number]) => void loads.push(row) },
  });
  expect(loads).toHaveLength(1);
  const mod = loads[0]!.factory((id) => {
    requested.push(id);
    if (id !== 'react') throw new Error(`unexpected require ${id}`);
    return react;
  });
  return { id: loads[0]!.id, mod, requested };
}

/** A fake service that records each call; `refuse` names methods that reject. */
function fakeService(refuse: string[] = []) {
  const calls: Array<[string, unknown[]]> = [];
  const listeners: Array<(e: RawAgentPublicEvent) => void> = [];
  let unsubscribed = 0;
  const call =
    <T>(name: string, value: T) =>
    async (...args: unknown[]): Promise<T> => {
      calls.push([name, args]);
      if (refuse.includes(name)) throw new RawAgentServiceError('no-grant', 'no grant token was given');
      return value;
    };
  const info = {
    sessionId: 's1',
    backend: { kind: 'claude-code', displayName: 'Claude Code' },
    process: 'running' as const,
    running: true,
    busy: false,
    backgroundTasks: 2,
    waitingForUser: 0,
    mode: 'plan',
  };
  const svc: RawAgentClientService = {
    apiVersion: 1,
    backends: [{ kind: 'claude-code', displayName: 'Claude Code' }],
    sessionInfo: call('sessionInfo', info),
    interrupt: call('interrupt', undefined),
    send: call('send', { messageId: 'm-1' }),
    steer: call('steer', { messageId: 'm-2' }),
    askSideQuestion: call('askSideQuestion', 'It is about tests.'),
    prefill: call('prefill', true),
    onEvent(sessionId, listener) {
      calls.push(['onEvent', [sessionId]]);
      listeners.push(listener);
      return () => void unsubscribed++;
    },
  };
  return { svc, calls, listeners, info, unsubscribed: () => unsubscribed };
}

function fakeSlots() {
  const registered: Array<{ key: string; options: Record<string, any>; component: any }> = [];
  let key = '';
  const slots = {
    inject(k: string, cb: () => unknown) {
      key = k;
      cb();
      return () => {};
    },
    register(options: Record<string, any>, component: unknown) {
      registered.push({ key, options, component });
      return () => {};
    },
  };
  return { slots, registered };
}

/** A tiny hooks runtime: enough for useState, useEffect, useMemo and createElement trees. */
function hookRuntime() {
  const cells: unknown[] = [];
  const effects: Array<{ deps?: unknown[]; cleanup?: (() => void) | void }> = [];
  const pending: Array<() => void> = [];
  let at = 0;
  const same = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
  const React = {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
      type,
      props: { ...(props ?? {}), children: children.flat() },
    }),
    useState(init: unknown) {
      const i = at++;
      if (!(i in cells)) cells[i] = typeof init === 'function' ? (init as () => unknown)() : init;
      return [
        cells[i],
        (v: unknown) => (cells[i] = typeof v === 'function' ? (v as (p: unknown) => unknown)(cells[i]) : v),
      ];
    },
    useMemo(fn: () => unknown, deps: unknown[]) {
      const i = at++;
      const c = cells[i] as { deps: unknown[]; value: unknown } | undefined;
      if (c && same(c.deps, deps)) return c.value;
      cells[i] = { deps, value: fn() };
      return (cells[i] as { value: unknown }).value;
    },
    useEffect(fn: () => (() => void) | void, deps?: unknown[]) {
      const i = at++;
      const e = (effects[i] ??= {});
      if (e.deps && same(e.deps, deps)) return;
      pending.push(() => {
        if (typeof e.cleanup === 'function') e.cleanup();
        e.cleanup = fn();
        e.deps = deps;
      });
    },
  };
  return {
    React,
    render(component: (p: any) => any, props: any) {
      at = 0;
      const out = component(props);
      while (pending.length > 0) pending.shift()!();
      return out;
    },
    unmount() {
      for (const e of effects) if (typeof e?.cleanup === 'function') e.cleanup();
    },
  };
}

function find(node: any, marker: string): any {
  if (!node || typeof node !== 'object') return undefined;
  if (node.props?.['data-sample-restyle'] === marker) return node;
  for (const c of node.props?.children ?? []) {
    const hit = find(c, marker);
    if (hit) return hit;
  }
  return undefined;
}
const text = (node: any): string =>
  node == null || node === false
    ? ''
    : typeof node !== 'object'
      ? String(node)
      : (node.props?.children ?? []).map(text).join('');
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('sample-restyle plugin (R9.1, R9.2)', () => {
  it('is a DSH plugin package: module-loader client, Host entry, patch, locale', async () => {
    const pkg = JSON.parse(readFileSync(`${dir}package.json`, 'utf8'));
    expect(pkg.dsh.client).toMatchObject({ platform: 'web', immediately: true });
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml');
    expect(pkg.exports).toMatchObject({ '.': './index.js', './client': './client.js' });
    const ours = JSON.parse(readFileSync(`${root}packages/plugin/package.json`, 'utf8'));
    expect(pkg.engines.dsh).toBe(ours.engines.dsh);
    const { id, mod, requested } = loadSample();
    expect(id).toBe(pkg.name);
    expect([...new Set(requested)]).toEqual(['react']);
    expect(mod.inject).toEqual(['slots', 'rawAgentClient']);
    const host = await import(`${dir}index.js`);
    expect(host.name).toBe(pkg.name);
    expect(readFileSync(`${dir}cordis.patch.yml`, 'utf8')).toContain(`name: '${pkg.name}'`);
  });

  it('shadows our context pill and fills the slot our client declares', () => {
    const { mod } = loadSample();
    const { slots, registered } = fakeSlots();
    mod.apply({ slots, rawAgentClient: fakeService().svc, get: () => undefined });
    expect(registered).toHaveLength(2);
    const [pill, extra] = registered;
    // Our real client port: the entry the sample shadows, and the entry that declares the slot.
    const ours = fakeSlots();
    mountClient({ slots: ours.slots, get: () => undefined } as never, {
      fetch: async () => ({ status: 404, ok: false, json: async () => ({}) }) as never,
    });
    const target = ours.registered.find(
      (r) => r.options.name === CONTEXT_PILL_SLOT && r.options.id === CONTEXT_PILL_ENTRY_ID,
    );
    expect(target).toBeDefined();
    expect(pill!.options).toMatchObject({ name: CONTEXT_PILL_SLOT, id: CONTEXT_PILL_ENTRY_ID });
    expect(pill!.options.priority).toBeLessThan(target!.options.priority ?? 0);
    const declarer = ours.registered.find((r) => r.options.children?.[PLUGIN_EXTRAS_SLOT]);
    expect(declarer?.options.children[PLUGIN_EXTRAS_SLOT]).toEqual({ kind: 'list', scope: 'session' });
    expect(extra!.options.name).toBe(PLUGIN_EXTRAS_SLOT);
    expect(extra!.key).toBe(PLUGIN_EXTRAS_SLOT);
    expect(pill!.options.inject('s7')).toEqual({ sessionId: 's7' });
  });

  it('does nothing without API version 1', () => {
    const { mod } = loadSample();
    const { slots, registered } = fakeSlots();
    const warn = console.warn;
    console.warn = () => {};
    try {
      mod.apply({ slots, rawAgentClient: { ...fakeService().svc, apiVersion: 2 } });
    } finally {
      console.warn = warn;
    }
    expect(registered).toEqual([]);
  });

  it('the panel calls every rawAgentClient method; a refusal shows its code', async () => {
    const { mod } = loadSample();
    const f = fakeService(['send']);
    const demo = mod.sample.createDemo(f.svc, 's1');
    const lines = [
      await demo.info(),
      await demo.prefill('composer'),
      await demo.prefill('side-question'),
      await demo.interrupt(),
      await demo.send(''),
      await demo.steer('rag1_token'),
      await demo.ask('rag1_token'),
    ];
    expect(lines[0]).toBe('Claude Code: process running, mode plan, 2 background task(s). Backends seen: Claude Code.');
    expect(lines[1]).toMatch(/Press Enter/);
    expect(lines[3]).toMatch(/Background tasks keep running/);
    expect(lines[4]).toBe('Refused (no-grant): no grant token was given');
    expect(lines[5]).toBe('Steered as message m-2.');
    expect(lines[6]).toBe('Answer: It is about tests.');
    expect(f.calls.find((c) => c[0] === 'prefill' && c[1][2] === 'side-question')).toBeDefined();
    expect(f.calls.find((c) => c[0] === 'steer')![1]).toEqual(['s1', mod.sample.TEXTS.steer, 'rag1_token']);

    // onEvent: the shadowing pill subscribes, renders from the events, unsubscribes on unmount.
    const rt = hookRuntime();
    const { SamplePill } = loadSample(rt.React).mod.sample.makeComponents(f.svc);
    expect(rt.render(SamplePill, { sessionId: 's1' })).toBeNull();
    f.listeners[0]!({ type: 'state', sessionId: 's1', info: f.info });
    f.listeners[0]!({
      type: 'usage',
      sessionId: 's1',
      usage: { tokens: 12_345, costUsd: 0.1234, context: { used: 1, window: 2, percent: 41.6 }, compacting: false },
    });
    expect(text(rt.render(SamplePill, { sessionId: 's1' }))).toBe('ctx 42% · 12.3k tok · $0.12');
    rt.unmount();
    expect(f.unsubscribed()).toBe(1);

    // Every method of the real Client service was called by the sample.
    const real = createRawAgentClientService(new SessionStores({} as RawAgentApi), {} as PluginApi);
    const methods = Object.keys(real).filter((k) => typeof (real as any)[k] === 'function');
    expect(methods.sort()).toEqual(
      ['askSideQuestion', 'interrupt', 'onEvent', 'prefill', 'send', 'sessionInfo', 'steer'].sort(),
    );
    for (const m of methods) expect(f.calls.some((c) => c[0] === m)).toBe(true);
  });

  it('the button panel wires each action and shows the result line', async () => {
    const f = fakeService();
    const rt = hookRuntime();
    const { SampleButton } = loadSample(rt.React).mod.sample.makeComponents(f.svc);
    let tree = rt.render(SampleButton, { sessionId: 's1' });
    expect(find(tree, 'result')).toBeUndefined();
    tree.props.children[0].props.onClick();
    // The open panel's effect asks for the session info.
    expect(find(rt.render(SampleButton, { sessionId: 's1' }), 'result')).toBeDefined();
    await settle();
    tree = rt.render(SampleButton, { sessionId: 's1' });
    expect(text(find(tree, 'result'))).toMatch(/^Claude Code: process running/);
    find(tree, 'action-send').props.onClick();
    await settle();
    tree = rt.render(SampleButton, { sessionId: 's1' });
    expect(text(find(tree, 'result'))).toBe('Sent as message m-1.');
    for (const a of ['info', 'prefill-composer', 'prefill-side-question', 'stop-turn', 'steer', 'side-question'])
      expect(find(tree, `action-${a}`)).toBeDefined();
  });

  it('pill text: unknown numbers are left out; not ours renders nothing', () => {
    const { mod } = loadSample();
    const state = { running: false, busy: false, waitingForUser: 0 };
    expect(mod.sample.pillText(undefined, undefined)).toBeUndefined();
    expect(mod.sample.pillText(state, undefined)).toBe('not started');
    expect(mod.sample.pillText({ ...state, running: true, busy: true }, { compacting: true })).toBe(
      'compacting · working',
    );
    expect(mod.sample.pillText({ ...state, waitingForUser: 1 }, { tokens: 900 })).toBe('900 tok · waiting for you');
  });

  it('renders real React markup (closed button)', () => {
    const { mod } = loadSample(ReactReal);
    const { SampleButton } = mod.sample.makeComponents(fakeService().svc);
    const html = renderToStaticMarkup(ReactReal.createElement(SampleButton, { sessionId: 's1' }));
    expect(html).toContain('data-sample-restyle="extra"');
    expect(html).toContain('>Sample</button>');
  });
});
