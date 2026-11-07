// The public services in DSH (R9.2, D62, D66, D87): the Host service `rawAgent`, the routes the
// Client service `rawAgentClient` calls, the grant panel's routes, and where grants are stored.
//
// Grant storage (D24, D87, D88): the grants live in a DSH storage domain (`grant-storage.ts`), so
// they are kept across a DSH restart. The Host entry config's `grants` field is the old place: its
// grants are taken in once, and it is the fallback when `ctx.storageDomain` is missing or cannot
// open. A write to the config goes through Cordis `ctx.fiber.update(config)` (`P/cordis/src/fiber.ts`
// `update`: it emits `internal/commit`, which the loader saves into the entry tree,
// `P/cordis-plugin-loader/src/index.ts` `internal/commit`). An ordinary config update restarts
// the entry, and a restart would end every agent process (D75), so the entry keeps an
// `internal/update` hook on its own fiber: when only runtime fields changed (`grants`,
// `executablePath`, `options`; all read at use time) it takes the new config and
// does not call `next()` ("omitting `next()` keeps the current instance",
// `P/cordis/src/events.ts` `internal/update`). Live (M8, S7) a user's edit of the profile patch goes through this hook, but our own
// write is not saved to any profile file for a bundle row, so fallback grants last for one DSH run
// and the panel says so (`durable: false`).

import {
  RAW_AGENT_SERVICE,
  isRawAgentServiceError,
  type AgentBackendFactory,
  type RawAgentErrorCode,
  type RawAgentService,
} from '@dsh-raw-agent/core';
import { GrantStore, type GrantPersistence, type GrantRecord } from '../grants.js';
import { domainGrantPersistence } from './grant-storage.js';
import { createRawAgentService, type PluginAgentOps, type PluginMessage } from '../plugin-service.js';
import type { SessionRegistry } from '../registry.js';
import { readJson } from './routes.js';
import type { CordisContext } from './types.js';

export const PLUGIN_SESSION_INFO_ROUTE = '/api/raw-agent/plugin/session-info';
export const PLUGIN_INTERRUPT_ROUTE = '/api/raw-agent/plugin/interrupt';
export const PLUGIN_SEND_ROUTE = '/api/raw-agent/plugin/send';
export const PLUGIN_SIDE_QUESTION_ROUTE = '/api/raw-agent/plugin/side-question';
export const GRANTS_ROUTE = '/api/raw-agent/grants';
export const GRANT_CREATE_ROUTE = '/api/raw-agent/grants/create';
export const GRANT_REVOKE_ROUTE = '/api/raw-agent/grants/revoke';

const MAX_BODY = 512 * 1024;

interface FetchRoute {
  path: string;
  methods: Array<'GET' | 'HEAD' | 'POST'>;
  requestBody: 'buffered' | 'streaming';
  fetch(request: Request): Promise<Response>;
}

interface DshAgentLike {
  followup(message: PluginMessage): void;
  steer?(message: PluginMessage): void;
  send?(message: PluginMessage, target: 'next-turn' | 'next-step', wakeup: boolean): void;
  cancel?(cause: { kind: string }, options?: { keepInbox?: boolean }): void;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/** HTTP status of a refused service call. Never 401: that is DSH's own "not signed in". */
export function statusOf(code: RawAgentErrorCode): number {
  switch (code) {
    case 'not-our-session':
      return 404;
    case 'no-grant':
    case 'bad-grant':
      return 403;
    case 'empty':
    case 'too-long':
      return 400;
    case 'not-running':
    case 'busy':
    case 'unsupported':
      return 409;
    default:
      return 502;
  }
}

/** DSH agent operations of one session: DSH's own `followup`, `steer` and Stop (`cancel`). */
export function agentOps(ctx: CordisContext, sessionId: string): PluginAgentOps | undefined {
  let agent: DshAgentLike | undefined;
  try {
    agent = (ctx.get('agents') as { get?(id: string): DshAgentLike | undefined } | undefined)?.get?.(sessionId);
  } catch {
    return undefined;
  }
  if (!agent || typeof agent.followup !== 'function') return undefined;
  const a = agent;
  return {
    followup: (m) => a.followup(m),
    steer: (m) => {
      if (typeof a.steer === 'function') a.steer(m);
      else if (typeof a.send === 'function') a.send(m, 'next-step', true);
      else a.followup(m);
    },
    cancel: () => {
      // DSH's Stop button (`P/dsh-api-session-controller/lib/index.js` `cancel`).
      if (typeof a.cancel !== 'function') throw new Error('this DSH agent has no cancel');
      a.cancel({ kind: 'user' }, { keepInbox: true });
    },
  };
}

/** The routes behind the Client service and the grant panel. Every one is POST with a JSON body. */
export function pluginRoutes(service: RawAgentService, grants: GrantStore): FetchRoute[] {
  const handle =
    (fn: (body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>): FetchRoute['fetch'] =>
    async (request) => {
      let body: unknown;
      try {
        body = await readJson(request, MAX_BODY);
      } catch {
        return json(400, { error: 'the body must be a JSON object' });
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body))
        return json(400, { error: 'the body must be a JSON object' });
      try {
        const r = await fn(body as Record<string, unknown>);
        return json(r.status, r.body);
      } catch (e) {
        if (isRawAgentServiceError(e)) return json(statusOf(e.code), { error: e.message, code: e.code });
        return json(500, { error: String((e as Error)?.message ?? e) });
      }
    };
  const session = (b: Record<string, unknown>) => (typeof b.session === 'string' ? b.session : '');
  const route = (path: string, fn: Parameters<typeof handle>[0]): FetchRoute => ({
    path,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: handle(fn),
  });
  return [
    route(PLUGIN_SESSION_INFO_ROUTE, async (b) => {
      const info = await service.sessionInfo(session(b));
      return info
        ? { status: 200, body: info }
        : { status: 404, body: { error: 'not a session of this plugin', code: 'not-our-session' } };
    }),
    route(PLUGIN_INTERRUPT_ROUTE, async (b) => {
      await service.interrupt(session(b));
      return { status: 200, body: { ok: true } };
    }),
    route(PLUGIN_SEND_ROUTE, async (b) => {
      const call = b.mode === 'steer' ? service.steer : service.send;
      const r = await call(session(b), b.text as string, b.grant as string);
      return { status: 200, body: { ok: true, ...r } };
    }),
    route(PLUGIN_SIDE_QUESTION_ROUTE, async (b) => {
      const answer = await service.askSideQuestion(session(b), b.question as string, b.grant as string);
      return { status: 200, body: { ok: true, answer } };
    }),
    // The grant panel. Any page script with the DSH cookie can call these too: the grant is a
    // consent switch between trusted plugins, not a security boundary (D66).
    route(GRANTS_ROUTE, async () => ({ status: 200, body: { grants: grants.list() } })),
    route(GRANT_CREATE_ROUTE, async (b) => {
      const r = await grants.create(b.label);
      return r.ok
        ? { status: 200, body: { ok: true, grant: r.grant, token: r.token, grants: grants.list() } }
        : { status: 400, body: { ok: false, error: r.error } };
    }),
    route(GRANT_REVOKE_ROUTE, async (b) => {
      const id = typeof b.id === 'string' ? b.id : '';
      const r = await grants.revoke(id);
      return r.ok
        ? { status: 200, body: { ok: true, saved: r.saved, grants: grants.list() } }
        : { status: 404, body: { ok: false, error: 'no such grant' } };
    }),
  ];
}

/** The Host entry config: plain values (no Schemastery schema yet, D65/S7). */
export type HostConfigShape = Record<string, unknown> & { grants?: unknown };

export interface HostConfigAccess {
  get(): HostConfigShape | undefined;
  set(next: HostConfigShape): void;
}

interface FiberLike {
  update?(config: unknown, noSave?: boolean): unknown;
}

/**
 * The Host entry fields read at use time (D87): grants at each call, `executablePath` and backend
 * `options` at the next spawn. A change confined to them is taken in place, without a remount.
 */
export const RUNTIME_CONFIG_FIELDS: readonly string[] = ['grants', 'executablePath', 'options'];

const withoutRuntimeFields = (c: unknown): string => {
  if (c === null || typeof c !== 'object') return JSON.stringify(c ?? null);
  const src = c as Record<string, unknown>;
  const rest: Record<string, unknown> = {};
  for (const k of Object.keys(src).sort())
    if (!RUNTIME_CONFIG_FIELDS.includes(k) && src[k] !== undefined) rest[k] = src[k];
  return JSON.stringify(rest);
};

/**
 * True when two entry configs differ only in runtime fields (grants, executablePath, options).
 * Such an edit (ours, or the user's own edit of the profile patch) never restarts the entry, so it
 * never ends a running CLI (D87, rules 6 and 7).
 */
export function onlyRuntimeFieldsChanged(before: unknown, after: unknown): boolean {
  return withoutRuntimeFields(before) === withoutRuntimeFields(after);
}

/**
 * Store grants in the Host entry config without a restart (see the file comment). Returns the
 * persistence for the grant store.
 */
export function configGrantPersistence(
  ctx: CordisContext,
  config: HostConfigAccess,
  /** Called after a config change was taken in place (the grant storage takes in new grants). */
  onChange?: () => void,
): GrantPersistence {
  // Our own fiber's update hook (not global): a change of runtime fields only applies in place.
  try {
    ctx.on('internal/update', ((resolved: unknown, next: () => unknown) => {
      if (resolved !== null && typeof resolved === 'object' && onlyRuntimeFieldsChanged(config.get() ?? {}, resolved)) {
        config.set(resolved as HostConfigShape);
        onChange?.();
        return undefined;
      }
      return next();
    }) as never);
  } catch (error) {
    ctx.logger?.warn('[raw-agent] could not watch config updates; grants stay in memory', String(error));
  }
  return {
    load: () => config.get()?.grants,
    // M8 live (DSH 0.2.2-rc.1): `fiber.update` reaches the loader, but a row inserted by a bundle
    // layer is changed in the composed tree only; the profile files are not written, so the grants
    // are gone after a DSH restart. Say so instead of claiming they are saved.
    durable: () => false,
    async save(records: GrantRecord[]) {
      const fiber = (ctx as { fiber?: FiberLike }).fiber;
      if (typeof fiber?.update !== 'function') return false;
      const next: HostConfigShape = { ...(config.get() ?? {}), grants: records.map((r) => ({ ...r })) };
      await fiber.update(next);
      // The hook took the config (no restart). If it did not, the stored list is not ours yet.
      const stored = config.get()?.grants;
      return Array.isArray(stored) && stored.length === records.length;
    },
  };
}

export interface MountServicesOptions {
  registry: SessionRegistry;
  factories: readonly AgentBackendFactory[];
  /** The Host entry config: old grants to take in, and the fallback store (D88). */
  hostConfig?: HostConfigAccess;
  /** Test seam. */
  grants?: GrantStore;
}

export interface MountedServices {
  service: RawAgentService;
  grants: GrantStore;
}

/** Nothing stored: the fallback when there is no entry config. */
const NO_PERSISTENCE: GrantPersistence = { load: () => undefined, save: async () => false, durable: () => false };

/**
 * The grant persistence (D88): a DSH storage domain once it is open, else the entry config (kept for
 * this DSH run only). Old config grants are taken in once.
 */
export function grantPersistence(ctx: CordisContext, hostConfig: HostConfigAccess | undefined): GrantPersistence {
  // Called only after the hook took a config change, so `durable` is set by then.
  const takeIn = () =>
    void durable
      .importConfig()
      .catch((e: unknown) => ctx.logger?.warn('[raw-agent] could not take in config grants', String(e)));
  const fallback = hostConfig ? configGrantPersistence(ctx, hostConfig, takeIn) : NO_PERSISTENCE;
  const durable = domainGrantPersistence(ctx, {
    fallback,
    ...(hostConfig ? { importable: () => hostConfig.get()?.grants } : {}),
  });
  return durable;
}

/** Provide `rawAgent` and register the Client service's and the grant panel's routes. */
export function mountServices(ctx: CordisContext, o: MountServicesOptions): MountedServices {
  const warn = (note: string, detail?: unknown) => ctx.logger?.warn(`[raw-agent] ${note}`, detail ?? '');
  const grants = o.grants ?? new GrantStore({ persistence: grantPersistence(ctx, o.hostConfig) });
  const service = createRawAgentService({
    registry: o.registry,
    factories: o.factories,
    grants,
    agent: (id) => agentOps(ctx, id),
    warn,
  });
  // A failed provide must not fail the entry: a provider that fails blocks every dependent (D66).
  try {
    ctx.provide?.(RAW_AGENT_SERVICE, service);
  } catch (error) {
    warn('could not provide the rawAgent service', String(error));
  }
  const register = (c: CordisContext) => {
    const connection = c.get('connection') as { fetch?: { register(route: FetchRoute): unknown } } | undefined;
    if (!connection?.fetch) return;
    for (const r of pluginRoutes(service, grants)) connection.fetch.register(r);
  };
  if (ctx.inject) ctx.inject(['connection'], register);
  else register(ctx);
  return { service, grants };
}
