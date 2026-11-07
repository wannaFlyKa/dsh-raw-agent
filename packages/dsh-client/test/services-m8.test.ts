// M8 (R9.2, D66): the Client service `rawAgentClient`, its routes, prefill and the plugin access panel.

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RawAgentServiceError, type RawAgentPublicEvent } from '@dsh-raw-agent/core';
import {
  GrantsPanel,
  SessionStores,
  SidePanelBody,
  createPluginApi,
  createRawAgentClientService,
  grantNote,
  takePrefill,
  type FetchFn,
  type PluginApi,
  type RawAgentApi,
  type SessionInfo,
} from '@dsh-raw-agent/dsh-client';

function info(view: Partial<SessionInfo['view']> = {}): SessionInfo {
  return {
    backend: { kind: 'k', displayName: 'Agent' },
    permissionModes: [],
    efforts: [],
    needsProcess: [],
    models: [],
    modelsFrom: 'none',
    view: {
      state: { process: 'running', turn: false, backgroundTasks: 0 },
      live: { model: 'm', mode: 'plan' },
      choice: { applied: {}, resetPending: false },
      ...view,
    },
  } as SessionInfo;
}

function fakeApi(read: () => SessionInfo | undefined): RawAgentApi {
  return {
    session: async () => {
      const i = read();
      if (!i) {
        const { RouteError } = await import('@dsh-raw-agent/dsh-client');
        throw new RouteError(404, 'not ours');
      }
      return i;
    },
  } as unknown as RawAgentApi;
}

const plugin = (over: Partial<PluginApi> = {}): PluginApi =>
  ({
    sessionInfo: async () => undefined,
    interrupt: async () => {},
    send: async () => ({ messageId: 'm1' }),
    askSideQuestion: async () => 'answer',
    grants: async () => [],
    createGrant: async () => {
      throw new Error('x');
    },
    revokeGrant: async () => ({ saved: true, grants: [] }),
    ...over,
  }) as PluginApi;

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('rawAgentClient (R9.2)', () => {
  it('prefill hands the text to our controls only, and only in our sessions', async () => {
    let current: SessionInfo | undefined = info();
    const stores = new SessionStores(fakeApi(() => current));
    const svc = createRawAgentClientService(stores, plugin());
    expect(svc.apiVersion).toBe(1);
    expect(await svc.prefill('s1', 'look at this')).toBe(true);
    expect(stores.get('s1').getSnapshot().prefillRequest).toEqual({ text: 'look at this', target: 'composer', seq: 1 });
    expect(await svc.prefill('s1', 'why?', 'side-question')).toBe(true);
    expect(stores.get('s1').getSnapshot().prefillRequest).toMatchObject({ target: 'side-question', seq: 2 });
    current = undefined;
    expect(await svc.prefill('s2', 'x')).toBe(false);
    expect(stores.get('s2').getSnapshot().prefillRequest).toBeUndefined();
    await expect(svc.prefill('s1', '')).rejects.toBeInstanceOf(RawAgentServiceError);
    expect(svc.backends).toEqual([{ kind: 'k', displayName: 'Agent' }]);
    stores.dispose();
  });

  it('onEvent turns store snapshots into public events, without ask choices', async () => {
    let current: SessionInfo | undefined = info();
    const stores = new SessionStores(fakeApi(() => current));
    const svc = createRawAgentClientService(stores, plugin());
    const got: RawAgentPublicEvent[] = [];
    const off = svc.onEvent('s1', (e) => got.push(e));
    await tick();
    expect(got[0]).toMatchObject({ type: 'state', info: { running: true, mode: 'plan', model: 'm' } });
    current = info({
      asks: [
        {
          id: 'a',
          kind: 'question',
          agent: 'main',
          title: 'Pick one',
          choices: [{ id: 'c', label: 'C' }],
          stopChoice: 'x',
          at: 1,
        },
      ] as never,
    });
    await stores.get('s1').refresh();
    expect(got.at(-1)).toEqual({
      type: 'asks',
      sessionId: 's1',
      asks: [{ id: 'a', kind: 'question', agent: 'main', title: 'Pick one', at: 1 }],
    });
    current = undefined;
    await stores.get('s1').refresh();
    expect(got.at(-1)).toEqual({ type: 'ended', sessionId: 's1' });
    off();
    stores.dispose();
  });

  it('send, steer and side questions go to the routes with the grant', async () => {
    const calls: unknown[] = [];
    const stores = new SessionStores(fakeApi(() => info()));
    const svc = createRawAgentClientService(
      stores,
      plugin({
        send: async (...a) => {
          calls.push(a);
          return { messageId: 'id' };
        },
      }),
    );
    await svc.send('s1', 'hi', 'tok');
    await svc.steer('s1', 'more', 'tok');
    expect(calls).toEqual([
      ['s1', 'hi', 'tok', 'send'],
      ['s1', 'more', 'tok', 'steer'],
    ]);
    expect(await svc.askSideQuestion('s1', 'q', 'tok')).toBe('answer');
    stores.dispose();
  });
});

describe('plugin routes from the browser (D62)', () => {
  it('POSTs relative URLs and turns a refusal into a coded error', async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const fetchFn: FetchFn = async (url, init) => {
      seen.push({ url, body: JSON.parse(init?.body ?? '{}') });
      if (url.endsWith('plugin/send'))
        return { status: 403, ok: false, json: async () => ({ error: 'no grant', code: 'no-grant' }) };
      if (url.endsWith('plugin/session-info')) return { status: 404, ok: false, json: async () => ({}) };
      if (url.endsWith('grants/create'))
        return {
          status: 200,
          ok: true,
          json: async () => ({
            grant: { id: 'g', label: 'L', created: 1, saved: true, uses: 0 },
            token: 'rag1_t',
            grants: [],
          }),
        };
      return { status: 200, ok: true, json: async () => ({ answer: null }) };
    };
    const api = createPluginApi(fetchFn);
    const err = await api.send('s1', 'hi', '', 'send').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RawAgentServiceError);
    expect((err as RawAgentServiceError).code).toBe('no-grant');
    expect(await api.sessionInfo('s1')).toBeUndefined();
    expect(await api.askSideQuestion('s1', 'q', 't')).toBeNull();
    expect((await api.createGrant('L')).token).toBe('rag1_t');
    expect(seen.every((s) => s.url.startsWith('api/raw-agent/'))).toBe(true);
    expect(seen[0]!.body).toEqual({ session: 's1', text: 'hi', grant: '', mode: 'send' });
  });
});

describe('prefill in the controls', () => {
  const target = (ok: boolean) => {
    const inserted: string[] = [];
    return {
      inserted,
      t: {
        setDraft: () => {
          throw new Error('never replaces the draft');
        },
        captureInsertion: () => ({}),
        insertText: (text: string) => {
          if (ok) inserted.push(text);
          return ok;
        },
      },
    };
  };
  it('inserts at the caret, holds a refused text, and sends side text to the side box', () => {
    const a = target(true);
    expect(takePrefill({ text: 'x', target: 'composer', seq: 1 }, 0, a.t)).toEqual({ kind: 'inserted', seq: 1 });
    expect(a.inserted).toEqual(['x']);
    expect(takePrefill({ text: 'x', target: 'composer', seq: 1 }, 1, a.t)).toBeUndefined();
    const b = target(false);
    expect(takePrefill({ text: 'y', target: 'composer', seq: 2 }, 1, b.t)).toEqual({ kind: 'held', seq: 2, text: 'y' });
    expect(takePrefill({ text: 'y', target: 'composer', seq: 2 }, 1, undefined)).toBeUndefined();
    expect(takePrefill({ text: 'q', target: 'side-question', seq: 3 }, 2, undefined)).toEqual({
      kind: 'side',
      seq: 3,
      text: 'q',
    });
  });
  it('the side box renders with the panel open (the text arrives in an effect)', () => {
    const html = renderToStaticMarkup(
      React.createElement(SidePanelBody, {
        side: undefined,
        displayName: 'Agent',
        busy: false,
        now: 0,
        onAsk() {},
        onCancel() {},
        onStart() {},
        onClose() {},
        prefill: { text: 'q', seq: 1 },
      }),
    );
    expect(html).toContain('side-ask');
  });
});

describe('plugin access panel (D66)', () => {
  it('says the grant is a consent switch, not a security boundary, and names each grant', () => {
    const html = renderToStaticMarkup(
      React.createElement(GrantsPanel, { plugin: plugin(), copy: async () => true, displayName: 'Agent' }),
    );
    expect(html).toContain('not a security boundary');
    expect(html).toContain('Create grant');
    expect(grantNote({ id: 'g', label: 'L', created: 0, saved: false, uses: 2 })).toMatch(/2 times.*DSH restarts/);
  });
});
