// Plugin Fetch routes (D63, rule 12). Exact routes registered through `ctx.connection.fetch`, so
// they use DSH's own cookie authentication and Host/Origin fence (401 without auth, 403 for an
// untrusted host or origin, owner Peers only): `P/dsh-client-connection/lib/index.js:732-750,
// 840-853`, `README.md` "Browser authentication and request trust"; probes r1/r4 in
// dsh-ui-surfaces §8. Client code calls them with a relative URL (`api/raw-agent/…`).

import { readFileSync, statSync } from 'node:fs';
import type { AgentBackendFactory, SessionChoiceRequest, SettingsDefaults } from '@dsh-raw-agent/core';
import { offeredPermissionModes } from '@dsh-raw-agent/core';
import { listConfigFiles, previewConfigFile, type ConfigPreviewDeps } from '../config-preview.js';
import type { SessionRegistry } from '../registry.js';
import type { CordisContext, DshSession } from './types.js';

export const CONFIG_FILES_ROUTE = '/api/raw-agent/config-files';
export const CONFIG_FILE_ROUTE = '/api/raw-agent/config-file';

interface FetchRoute {
  path: string;
  methods: Array<'GET' | 'HEAD' | 'POST'>;
  requestBody: 'buffered' | 'streaming';
  fetch(request: Request): Promise<Response>;
}

interface Connection {
  fetch?: { register(route: FetchRoute): unknown };
}

interface Sessions {
  get(id: string): DshSession | undefined;
}

/** Read-only file read for the preview. Never follows a path from the request. */
export function readFileForPreview(p: string): ReturnType<ConfigPreviewDeps['readFile']> {
  try {
    const st = statSync(p);
    if (!st.isFile()) return { kind: 'error', message: 'not a regular file' };
    if (st.size > 1024 * 1024) return { kind: 'ok', text: '', mtimeMs: st.mtimeMs, size: st.size };
    return { kind: 'ok', text: readFileSync(p, 'utf8'), mtimeMs: st.mtimeMs, size: st.size };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    return { kind: 'error', message: code ?? 'unreadable' };
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/** Build the two routes. `deps` is injectable for tests. */
export function configRoutes(deps: ConfigPreviewDeps): FetchRoute[] {
  const wrap =
    (fn: typeof listConfigFiles): FetchRoute['fetch'] =>
    async (request) => {
      try {
        const r = await fn(new URL(request.url), deps);
        return json(r.status, r.body);
      } catch (e) {
        return json(500, { error: String((e as Error)?.message ?? e) });
      }
    };
  return [
    { path: CONFIG_FILES_ROUTE, methods: ['GET'], requestBody: 'buffered', fetch: wrap(listConfigFiles) },
    { path: CONFIG_FILE_ROUTE, methods: ['GET'], requestBody: 'buffered', fetch: wrap(previewConfigFile) },
  ];
}

/** Register the settings-preview routes on the Host entry once `connection` is served. */
export function mountConfigRoutes(ctx: CordisContext, factories: readonly AgentBackendFactory[]): boolean {
  if (!factories.some((f) => f.configFiles !== undefined)) return false;
  const register = (c: CordisContext) => {
    const connection = c.get('connection') as Connection | undefined;
    if (!connection?.fetch) return;
    const routes = configRoutes({
      factories,
      cwdOf(sessionId) {
        const sessions = c.get('sessions') as Sessions | undefined;
        const cwd = sessions?.get(sessionId)?.header.cwd;
        return typeof cwd === 'string' && cwd !== '' ? cwd : undefined;
      },
      readFile: readFileForPreview,
    });
    // `register` is already scoped to the reading context (an effect, removed on dispose).
    for (const r of routes) connection.fetch.register(r);
  };
  if (ctx.inject) ctx.inject(['connection'], register);
  else register(ctx);
  return true;
}

// ---- lifecycle routes (D4 Start button, D25 Force stop and returned drafts, D75 state) ----

export const START_ROUTE = '/api/raw-agent/start';
export const FORCE_STOP_ROUTE = '/api/raw-agent/force-stop';
export const STATE_ROUTE = '/api/raw-agent/state';

/**
 * The lifecycle routes over the Host registry (D87). A session id names only a runtime the
 * registry already holds, so no route can reach a session outside our presets (D62).
 * - POST start: spawn without a message ("Start <displayName>", D4).
 * - POST force-stop: end the process and its background tasks (D25, explicit user action).
 * - GET state: the process state and, once, the steer texts returned on Stop (D25).
 */
export function lifecycleRoutes(registry: SessionRegistry, controls?: SessionControlDeps): FetchRoute[] {
  const handler =
    (fn: (id: string) => Promise<{ status: number; body: unknown }>): FetchRoute['fetch'] =>
    async (request) => {
      const id = new URL(request.url).searchParams.get('session');
      if (!id) return json(400, { error: 'missing session' });
      try {
        const r = await fn(id);
        return json(r.status, r.body);
      } catch (e) {
        return json(500, { error: String((e as Error)?.message ?? e) });
      }
    };
  const missing = { status: 404, body: { error: 'not a session of this plugin' } };
  return [
    {
      path: START_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: handler(async (id) => {
        const r = registry.get(id);
        if (!r) return missing;
        await r.start();
        return { status: 200, body: { state: r.state() } };
      }),
    },
    {
      path: FORCE_STOP_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: handler(async (id) => {
        const r = registry.get(id);
        if (!r) return missing;
        await r.forceStop();
        return { status: 200, body: { state: r.state() } };
      }),
    },
    {
      path: STATE_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: handler(async (id) => {
        const r = registry.get(id);
        if (!r) return missing;
        return { status: 200, body: { state: r.state(), returnedDrafts: registry.takeDrafts(id) } };
      }),
    },
    ...(controls ? sessionControlRoutes(registry, controls) : []),
  ];
}

// ---- session controls (R1.4, D35-D38, D4) ----

export const SESSION_ROUTE = '/api/raw-agent/session';
export const CHOICE_ROUTE = '/api/raw-agent/choice';
export const ANSWER_ROUTE = '/api/raw-agent/answer';

export interface SessionControlDeps {
  factories: readonly AgentBackendFactory[];
  /** Test-only rows for the plugin's model picker (live suites); empty in normal use. */
  seedModels?: readonly string[];
}

/** A model id the UI may send: no spaces or control characters, bounded length. */
const MODEL_ID = /^[\w.:@/[\]-]{1,200}$/;

/** Parse and check the body of `POST …/choice`. */
export function parseChoice(body: unknown): SessionChoiceRequest | string {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'the body must be a JSON object';
  const b = body as Record<string, unknown>;
  const out: SessionChoiceRequest = {};
  if (b.model !== undefined) {
    if (typeof b.model !== 'string' || !MODEL_ID.test(b.model)) return 'model must be a model id';
    out.model = b.model;
  }
  if (b.effort !== undefined) {
    if (b.effort !== null && (typeof b.effort !== 'string' || !MODEL_ID.test(b.effort))) return 'bad effort';
    out.effort = b.effort as string | null;
  }
  if (b.mode !== undefined) {
    if (typeof b.mode !== 'string' || !MODEL_ID.test(b.mode)) return 'bad mode';
    out.mode = b.mode;
  }
  if (out.model === undefined && out.effort === undefined && out.mode === undefined) return 'nothing to choose';
  return out;
}

/** Parse and check the body of `POST …/answer`: `{ask, choice}`, ids only. */
export function parseAnswer(body: unknown): { ask: string; choice: string } | string {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'the body must be a JSON object';
  const b = body as Record<string, unknown>;
  if (typeof b.ask !== 'string' || !MODEL_ID.test(b.ask)) return 'ask must be an ask id';
  if (typeof b.choice !== 'string' || !MODEL_ID.test(b.choice)) return 'choice must be a choice id';
  return { ask: b.ask, choice: b.choice };
}

/**
 * The plugin's session controls (D36, D38). Only sessions in the registry are reachable, so a
 * Standard session gets 404 and the client shows nothing there (D62).
 * - GET session: backend labels, static mode and effort lists, models, the live state and choices,
 *   and a read-only preview of what the user's settings pick (R1.4).
 * - POST choice: `{model?, effort?, mode?}`; session-only, never `selectModel` (K1).
 * - POST answer: `{ask, choice}`: the user's answer to one pending ask (permission, question,
 *   plan, trust). Only a choice the ask offers is accepted; nothing is answered without this call.
 */
export function sessionControlRoutes(registry: SessionRegistry, deps: SessionControlDeps): FetchRoute[] {
  const missing = { status: 404, body: { error: 'not a session of this plugin' } };
  const describe = async (id: string) => {
    const runtime = registry.get(id);
    const kind = registry.kindOf(id);
    const factory = deps.factories.find((f) => f.kind === kind);
    if (!runtime || !factory) return undefined;
    const view = runtime.view();
    const live = view.models ?? registry.lastModels(factory.kind);
    const models = [...(live ?? [])];
    for (const seed of deps.seedModels ?? [])
      if (!models.some((m) => m.value === seed)) models.push({ value: seed, displayName: seed });
    let settings: SettingsDefaults | undefined;
    if (factory.settingsDefaults && view.cwd !== undefined) {
      try {
        settings = await factory.settingsDefaults(view.cwd);
      } catch {
        settings = undefined;
      }
    }
    // R1.2 / D73: say when the agent does not trust this folder yet (read-only, no process).
    let trust: { state: string; directory: string; effect?: string } | undefined;
    if (factory.trustState && view.cwd !== undefined) {
      try {
        const t = await factory.trustState(view.cwd);
        if (t.state !== 'trusted') {
          trust = { state: t.state, directory: t.directory };
          if (t.untrustedEffect !== undefined) trust.effect = t.untrustedEffect;
        }
      } catch {
        trust = undefined;
      }
    }
    return {
      backend: { kind: factory.kind, displayName: factory.displayName },
      // D38 r4: a mode that needs a backend option (Claude: bypass) shows only when it is on, or
      // when the session already runs in it.
      permissionModes: offeredPermissionModes(
        factory.staticCapabilities.permissionModes,
        registry.userConfig?.().options,
        [view.live.mode, view.choice.pendingMode, settings?.permissionMode],
      ),
      efforts: factory.staticCapabilities.efforts ?? [],
      needsProcess: factory.staticCapabilities.needsProcess,
      models,
      modelsFrom: live ? (view.models ? 'session' : 'recent') : 'none',
      settings,
      trust,
      view,
    };
  };
  return [
    {
      path: SESSION_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch(request) {
        const id = new URL(request.url).searchParams.get('session');
        if (!id) return json(400, { error: 'missing session' });
        try {
          const body = await describe(id);
          return body ? json(200, body) : json(missing.status, missing.body);
        } catch (e) {
          return json(500, { error: String((e as Error)?.message ?? e) });
        }
      },
    },
    {
      path: CHOICE_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const id = new URL(request.url).searchParams.get('session');
        if (!id) return json(400, { error: 'missing session' });
        const runtime = registry.get(id);
        if (!runtime) return json(missing.status, missing.body);
        let raw: unknown;
        try {
          raw = await request.json();
        } catch {
          return json(400, { error: 'the body must be JSON' });
        }
        const choice = parseChoice(raw);
        if (typeof choice === 'string') return json(400, { error: choice });
        try {
          const result = await runtime.choose(choice);
          return json(result.ok ? 200 : 409, { ...result, session: await describe(id) });
        } catch (e) {
          return json(500, { error: String((e as Error)?.message ?? e) });
        }
      },
    },
    {
      path: ANSWER_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const id = new URL(request.url).searchParams.get('session');
        if (!id) return json(400, { error: 'missing session' });
        const runtime = registry.get(id);
        if (!runtime) return json(missing.status, missing.body);
        let raw: unknown;
        try {
          raw = await request.json();
        } catch {
          return json(400, { error: 'the body must be JSON' });
        }
        const a = parseAnswer(raw);
        if (typeof a === 'string') return json(400, { error: a });
        const ok = runtime.answer(a.ask, a.choice);
        return ok
          ? json(200, { ok: true, session: await describe(id) })
          : json(409, { ok: false, error: 'that question is no longer open', session: await describe(id) });
      },
    },
  ];
}

/** Register the lifecycle and session-control routes on the Host entry once `connection` is served. */
export function mountLifecycleRoutes(
  ctx: CordisContext,
  registry: SessionRegistry,
  controls?: SessionControlDeps,
): void {
  const register = (c: CordisContext) => {
    const connection = c.get('connection') as Connection | undefined;
    if (!connection?.fetch) return;
    for (const r of lifecycleRoutes(registry, controls)) connection.fetch.register(r);
  };
  if (ctx.inject) ctx.inject(['connection'], register);
  else register(ctx);
}
