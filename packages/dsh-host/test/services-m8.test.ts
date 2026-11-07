// M8 (R9.2, D66): plugin grants, the Host service `rawAgent`, its routes and grant storage.

import { describe, expect, it, vi } from 'vitest';
import { PLUGIN_SOURCE_KIND, isRawAgentServiceError, type AgentBackendFactory } from '@dsh-raw-agent/core';
import {
  GRANT_CREATE_ROUTE,
  GRANT_REVOKE_ROUTE,
  GRANTS_ROUTE,
  GrantStore,
  PLUGIN_INTERRUPT_ROUTE,
  PLUGIN_SEND_ROUTE,
  PLUGIN_SESSION_INFO_ROUTE,
  PLUGIN_SIDE_QUESTION_ROUTE,
  SessionRegistry,
  configGrantPersistence,
  createRawAgentService,
  hashToken,
  mountServices,
  onlyRuntimeFieldsChanged,
  parseGrantRecords,
  pluginRoutes,
  statusOf,
  type PluginMessage,
  type RegisteredRuntime,
} from '@dsh-raw-agent/dsh-host';

const factory = { kind: 'k', displayName: 'Agent', staticCapabilities: {} } as unknown as AgentBackendFactory;

type View = ReturnType<RegisteredRuntime['view']>;

function fakeRuntime(over: Partial<View> = {}, side?: RegisteredRuntime['askSideQuestion']) {
  let view = {
    state: { process: 'running', turn: false, backgroundTasks: 0 },
    live: { model: 'm1', mode: 'default', version: '9.9' },
    choice: { applied: {}, resetPending: false, agentLocked: false },
    backendSessionId: 'b-1',
    ...over,
  } as unknown as View;
  const listeners = new Set<(v: View) => void>();
  const ends = new Set<() => void>();
  const rt = {
    view: () => view,
    state: () => view.state,
    subscribe(l: (v: View) => void, onEnd?: () => void) {
      listeners.add(l);
      if (onEnd) ends.add(onEnd);
      return () => {
        listeners.delete(l);
        if (onEnd) ends.delete(onEnd);
      };
    },
    ...(side ? { askSideQuestion: side } : {}),
  } as unknown as RegisteredRuntime;
  return {
    rt,
    push(next: Partial<View>) {
      view = { ...view, ...next } as View;
      for (const l of [...listeners]) l(view);
    },
    end() {
      for (const e of [...ends]) e();
    },
    get listeners() {
      return listeners.size;
    },
  };
}

async function setup(runtime = fakeRuntime()) {
  const registry = new SessionRegistry();
  registry.set('s1', 'k', runtime.rt);
  const grants = new GrantStore();
  const created = await grants.create('my-plugin');
  if (!created.ok) throw new Error('no grant');
  const sent: Array<[string, PluginMessage]> = [];
  const cancels: string[] = [];
  const service = createRawAgentService({
    registry,
    factories: [factory],
    grants,
    agent: (id) =>
      id === 's1'
        ? {
            followup: (m) => void sent.push(['followup', m]),
            steer: (m) => void sent.push(['steer', m]),
            cancel: () => void cancels.push(id),
          }
        : undefined,
    newId: () => 'msg-1',
  });
  return { registry, grants, token: created.token, grantId: created.grant.id, service, sent, cancels, runtime };
}

describe('GrantStore (D66)', () => {
  it('keeps only the hash, checks the token and counts uses', async () => {
    const saved: unknown[] = [];
    let stored: unknown;
    const store = new GrantStore({
      persistence: {
        load: () => stored,
        save: async (r) => {
          saved.push(r);
          stored = r;
          return true;
        },
      },
      now: () => 1000,
    });
    const r = await store.create('  reminders  plugin ');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.token.startsWith('rag1_')).toBe(true);
    expect(r.grant).toMatchObject({ label: 'reminders plugin', saved: true, uses: 0 });
    expect(JSON.stringify(saved)).not.toContain(r.token);
    expect((stored as Array<{ hash: string }>)[0]!.hash).toBe(hashToken(r.token));
    expect(store.check(r.token)?.label).toBe('reminders plugin');
    expect(store.check(`${r.token}x`)).toBeUndefined();
    expect(store.check('nope')).toBeUndefined();
    expect(store.check(42)).toBeUndefined();
    expect(store.list()[0]).toMatchObject({ uses: 1, lastUsed: 1000 });
  });

  it('refuses an empty or too long name', async () => {
    const store = new GrantStore();
    expect(await store.create('  ')).toMatchObject({ ok: false });
    expect(await store.create('x'.repeat(81))).toMatchObject({ ok: false });
    expect(await store.create(7)).toMatchObject({ ok: false });
  });

  it('keeps a grant in memory when the config write fails, and says so', async () => {
    const store = new GrantStore({ persistence: { load: () => undefined, save: async () => false } });
    const r = await store.create('p');
    expect(r).toMatchObject({ ok: true, grant: { saved: false } });
    if (r.ok) expect(store.check(r.token)).toBeDefined();
    expect(store.list()[0]!.saved).toBe(false);
  });

  it('a non-durable store marks every grant as kept until DSH restarts (M8 live)', async () => {
    let stored: unknown;
    const store = new GrantStore({
      persistence: {
        load: () => stored,
        save: async (r) => {
          stored = r;
          return true;
        },
        durable: () => false,
      },
    });
    const r = await store.create('p');
    expect(r).toMatchObject({ ok: true, grant: { saved: false } });
    if (!r.ok) return;
    expect(store.check(r.token)).toBeDefined();
    expect(store.list()).toEqual([expect.objectContaining({ id: r.grant.id, saved: false })]);
    // Nothing outlives the run, so a revoke has nothing left to undo after a restart.
    expect(await store.revoke(r.grant.id)).toEqual({ ok: true, saved: true });
    expect(store.check(r.token)).toBeUndefined();
  });

  it('revokes at once, even when the stored list cannot be written', async () => {
    let stored: unknown;
    let fail = false;
    const store = new GrantStore({
      persistence: {
        load: () => stored,
        save: async (r) => {
          if (fail) throw new Error('read-only');
          stored = r;
          return true;
        },
      },
    });
    const r = await store.create('p');
    if (!r.ok) throw new Error('x');
    fail = true;
    expect(await store.revoke(r.grant.id)).toEqual({ ok: true, saved: false });
    expect(store.check(r.token)).toBeUndefined();
    expect(store.list()).toEqual([]);
    expect(await store.revoke('grant-none')).toEqual({ ok: false, saved: false });
  });

  it('reads grants a config edit added (volatile references too) and ignores bad rows', () => {
    const token = 'rag1_abc';
    const rows = [{ id: 'g1', label: 'L', hash: hashToken(token), created: 5 }, { id: 'bad', hash: 'xyz' }, null];
    expect(parseGrantRecords({ get: () => rows })).toHaveLength(1);
    const store = new GrantStore({ persistence: { load: () => rows, save: async () => true } });
    expect(store.check(token)?.id).toBe('g1');
  });
});

describe('rawAgent Host service (R9.2)', () => {
  it('reports session info and nothing for a session that is not ours', async () => {
    const s = await setup();
    expect(s.service.apiVersion).toBe(1);
    expect(s.service.backends).toEqual([{ kind: 'k', displayName: 'Agent' }]);
    expect(await s.service.sessionInfo('s1')).toEqual({
      sessionId: 's1',
      backend: { kind: 'k', displayName: 'Agent', version: '9.9' },
      process: 'running',
      running: true,
      busy: false,
      backgroundTasks: 0,
      waitingForUser: 0,
      mode: 'default',
      model: 'm1',
      backendSessionId: 'b-1',
    });
    expect(await s.service.sessionInfo('other')).toBeUndefined();
  });

  it('send and steer need a valid grant; a granted message is admitted and marked as a plugin message', async () => {
    const s = await setup();
    await expect(s.service.send('s1', 'hi', '')).rejects.toMatchObject({ code: 'no-grant' });
    await expect(s.service.send('s1', 'hi', 'rag1_bad')).rejects.toMatchObject({ code: 'bad-grant' });
    await expect(s.service.send('s1', '   ', s.token)).rejects.toMatchObject({ code: 'empty' });
    await expect(s.service.send('s1', 'x'.repeat(100_001), s.token)).rejects.toMatchObject({ code: 'too-long' });
    await expect(s.service.send('zz', 'hi', s.token)).rejects.toMatchObject({ code: 'not-our-session' });
    expect(s.sent).toEqual([]);
    expect(await s.service.send('s1', 'hello', s.token)).toEqual({ messageId: 'msg-1' });
    expect(s.sent[0]![0]).toBe('followup');
    expect(s.sent[0]![1]).toEqual({
      id: 'msg-1',
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: PLUGIN_SOURCE_KIND, grant: 'my-plugin', grantId: s.grantId },
    });
    expect(s.registry.pluginSender('msg-1')).toEqual({ grantId: s.grantId, label: 'my-plugin' });
    await s.service.steer('s1', 'more', s.token);
    expect(s.sent[1]![0]).toBe('steer');
  });

  it('a revoked grant stops working at once', async () => {
    const s = await setup();
    await s.grants.revoke(s.grantId);
    await expect(s.service.send('s1', 'hi', s.token)).rejects.toMatchObject({ code: 'bad-grant' });
  });

  it('interrupt is DSH Stop on our sessions only', async () => {
    const s = await setup();
    await s.service.interrupt('s1');
    expect(s.cancels).toEqual(['s1']);
    await expect(s.service.interrupt('zz')).rejects.toMatchObject({ code: 'not-our-session' });
  });

  it('askSideQuestion: grant, a running process, and only the answer text', async () => {
    const ask = vi.fn(async (q: string) => ({
      ok: true as const,
      entry: { id: 'side-1', question: q, status: 'answered' as const, at: 1, answer: `A: ${q}` },
    }));
    const s = await setup(fakeRuntime({}, ask));
    await expect(s.service.askSideQuestion('s1', 'why?', 'rag1_bad')).rejects.toMatchObject({ code: 'bad-grant' });
    expect(await s.service.askSideQuestion('s1', 'why?', s.token)).toBe('A: why?');
    const idle = await setup(
      fakeRuntime({ state: { process: 'none', turn: false, backgroundTasks: 0 } } as Partial<View>, ask),
    );
    await expect(idle.service.askSideQuestion('s1', 'why?', idle.token)).rejects.toMatchObject({ code: 'not-running' });
    expect(ask).toHaveBeenCalledTimes(1); // never starts a process (rule 9)
    const synthetic = await setup(
      fakeRuntime({}, async (q) => ({
        ok: true,
        entry: { id: 'x', question: q, status: 'answered', at: 1, answer: 'no answer', synthetic: true },
      })),
    );
    expect(await synthetic.service.askSideQuestion('s1', 'q', synthetic.token)).toBeNull();
    const none = await setup(fakeRuntime());
    await expect(none.service.askSideQuestion('s1', 'q', none.token)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('onEvent: current state at once, changes only, asks without choices, and ended', async () => {
    const s = await setup();
    const got: unknown[] = [];
    const off = s.service.onEvent('s1', (e) => got.push(e));
    expect(got).toEqual([{ type: 'state', sessionId: 's1', info: expect.objectContaining({ busy: false }) }]);
    s.runtime.push({});
    expect(got).toHaveLength(1);
    s.runtime.push({
      state: { process: 'running', turn: true, backgroundTasks: 0, waiting: 1 },
      asks: [
        {
          id: 'a1',
          kind: 'permission',
          agent: 'main',
          title: 'Run ls?',
          choices: [{ id: 'yes', label: 'Yes' }],
          stopChoice: 'no',
          at: 3,
        },
      ],
    } as unknown as Partial<View>);
    expect(got.slice(1)).toEqual([
      { type: 'state', sessionId: 's1', info: expect.objectContaining({ busy: true, waitingForUser: 1 }) },
      {
        type: 'asks',
        sessionId: 's1',
        asks: [{ id: 'a1', kind: 'permission', agent: 'main', title: 'Run ls?', at: 3 }],
      },
    ]);
    expect(JSON.stringify(got)).not.toContain('stopChoice');
    s.runtime.end();
    expect(got.at(-1)).toEqual({ type: 'ended', sessionId: 's1' });
    off();
    expect(s.runtime.listeners).toBe(0);
  });

  it('onEvent follows a session registered later', async () => {
    const registry = new SessionRegistry();
    const service = createRawAgentService({
      registry,
      factories: [factory],
      grants: new GrantStore(),
      agent: () => undefined,
    });
    const got: unknown[] = [];
    const off = service.onEvent('late', (e) => got.push(e));
    expect(got).toEqual([]);
    registry.set('late', 'k', fakeRuntime().rt);
    expect(got).toHaveLength(1);
    off();
  });
});

describe('plugin routes and grant storage (D62, D87)', () => {
  const post = (path: string, body: unknown) =>
    new Request(`http://h${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });

  it('maps refusals to statuses, never 401', () => {
    expect(statusOf('not-our-session')).toBe(404);
    expect(statusOf('no-grant')).toBe(403);
    expect(statusOf('bad-grant')).toBe(403);
    expect(statusOf('too-long')).toBe(400);
    expect(statusOf('not-running')).toBe(409);
    expect(statusOf('failed')).toBe(502);
  });

  it('serves the client service and the grant panel', async () => {
    const s = await setup();
    const routes = pluginRoutes(s.service, s.grants);
    const call = async (path: string, body: unknown) => {
      const r = routes.find((x) => x.path === path)!;
      expect(r.methods).toEqual(['POST']);
      const res = await r.fetch(post(path, body));
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    expect((await call(PLUGIN_SESSION_INFO_ROUTE, { session: 's1' })).body).toMatchObject({ sessionId: 's1' });
    expect((await call(PLUGIN_SESSION_INFO_ROUTE, { session: 'zz' })).status).toBe(404);
    expect(await call(PLUGIN_SEND_ROUTE, { session: 's1', text: 'hi' })).toMatchObject({
      status: 403,
      body: { code: 'no-grant' },
    });
    expect(await call(PLUGIN_SEND_ROUTE, { session: 's1', text: 'hi', grant: s.token, mode: 'steer' })).toMatchObject({
      status: 200,
      body: { ok: true, messageId: 'msg-1' },
    });
    expect(s.sent[0]![0]).toBe('steer');
    expect((await call(PLUGIN_INTERRUPT_ROUTE, { session: 's1' })).status).toBe(200);
    expect((await call(PLUGIN_SIDE_QUESTION_ROUTE, { session: 's1', question: 'q', grant: s.token })).status).toBe(409);
    const listed = await call(GRANTS_ROUTE, {});
    expect(listed.body.grants).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(s.token);
    const made = await call(GRANT_CREATE_ROUTE, { label: 'second' });
    expect(made.body).toMatchObject({ ok: true, token: expect.stringMatching(/^rag1_/) });
    expect((await call(GRANT_CREATE_ROUTE, { label: '' })).status).toBe(400);
    expect((await call(GRANT_REVOKE_ROUTE, { id: s.grantId })).body).toMatchObject({ ok: true });
    expect((await call(GRANT_REVOKE_ROUTE, { id: s.grantId })).status).toBe(404);
    const bad = await routes[0]!.fetch(new Request('http://h/x', { method: 'POST', body: '[1]' }));
    expect(bad.status).toBe(400);
  });

  it('a change of runtime fields only (grants, executablePath, options) skips the restart (D87)', () => {
    expect(onlyRuntimeFieldsChanged({ a: 1, grants: [] }, { grants: [{ id: 'x' }], a: 1 })).toBe(true);
    // M8 live: a user's edit of executablePath or the bypass option in the profile patch ended the CLI.
    expect(onlyRuntimeFieldsChanged({ a: 1, options: { b: 1 } }, { a: 1, options: { b: 2 } })).toBe(true);
    expect(onlyRuntimeFieldsChanged({ executablePath: '/x' }, {})).toBe(true);
    expect(
      onlyRuntimeFieldsChanged({}, { executablePath: '/y', options: { allowDangerouslySkipPermissions: true } }),
    ).toBe(true);
    // Any other field still takes the ordinary restart path.
    expect(onlyRuntimeFieldsChanged({ a: 1 }, { a: 2 })).toBe(false);
    expect(onlyRuntimeFieldsChanged({}, { other: true, executablePath: '/y' })).toBe(false);
  });

  it('stores grants through the entry fiber, and the update hook keeps the entry running', async () => {
    let config: Record<string, unknown> | undefined = { executablePath: '/bin/agent' };
    let hook: ((resolved: unknown, next: () => unknown) => unknown) | undefined;
    const restarts: unknown[] = [];
    const ctx = {
      on: (name: string, l: never) => {
        if (name === 'internal/update') hook = l;
        return () => {};
      },
      fiber: {
        update: (next: unknown) => hook!(next, () => restarts.push(next)),
      },
      emit() {},
      effect() {},
      get: () => undefined,
    };
    const persistence = configGrantPersistence(ctx as never, { get: () => config, set: (c) => (config = c) });
    const store = new GrantStore({ persistence });
    const r = await store.create('p');
    // M8 live: the loader keeps a bundle row's config change in memory only, so not "saved".
    expect(r).toMatchObject({ ok: true, grant: { saved: false } });
    expect(persistence.durable?.()).toBe(false);
    expect(restarts).toEqual([]);
    expect(config).toMatchObject({ executablePath: '/bin/agent', grants: [expect.objectContaining({ label: 'p' })] });
    // A user's edit of executablePath or options is taken in place too (read at the next spawn).
    hook!(
      { executablePath: '/other', options: { allowDangerouslySkipPermissions: true }, grants: config!.grants },
      () => restarts.push('restart'),
    );
    expect(restarts).toEqual([]);
    expect(config).toMatchObject({ executablePath: '/other', options: { allowDangerouslySkipPermissions: true } });
    // Another field changed: the ordinary restart path runs.
    hook!({ ...config, unknownField: 1 }, () => restarts.push('restart'));
    expect(restarts).toEqual(['restart']);
  });

  it('mountServices provides rawAgent and registers the routes once connection is served', () => {
    const provided: Array<[string, unknown]> = [];
    const registered: string[] = [];
    const ctx = {
      on: () => () => {},
      emit() {},
      effect() {},
      provide: (n: string, v: unknown) => void provided.push([n, v]),
      get: (n: string) =>
        n === 'connection' ? { fetch: { register: (r: { path: string }) => registered.push(r.path) } } : undefined,
    };
    const m = mountServices(ctx as never, { registry: new SessionRegistry(), factories: [factory] });
    expect(provided.map(([n]) => n)).toEqual(['rawAgent']);
    expect(provided[0]![1]).toBe(m.service);
    expect(registered).toContain(PLUGIN_SEND_ROUTE);
    expect(registered).toContain(GRANT_CREATE_ROUTE);
    expect(registered.every((p) => p.startsWith('/api/raw-agent/'))).toBe(true);
  });

  it('a refusal is recognisable across bundles', async () => {
    const s = await setup();
    const e = await s.service.send('s1', 'x', '').catch((x: unknown) => x);
    expect(isRawAgentServiceError(e)).toBe(true);
  });
});
