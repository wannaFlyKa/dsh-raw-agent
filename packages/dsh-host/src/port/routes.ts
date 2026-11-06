// Plugin Fetch routes (D63, rule 12). Exact routes registered through `ctx.connection.fetch`, so
// they use DSH's own cookie authentication and Host/Origin fence (401 without auth, 403 for an
// untrusted host or origin, owner Peers only): `P/dsh-client-connection/lib/index.js:732-750,
// 840-853`, `README.md` "Browser authentication and request trust"; probes r1/r4 in
// dsh-ui-surfaces §8. Client code calls them with a relative URL (`api/raw-agent/…`).

import { readFileSync, statSync } from 'node:fs';
import type { AgentBackendFactory, SessionChoiceRequest, SettingsDefaults } from '@dsh-raw-agent/core';
import { offeredPermissionModes } from '@dsh-raw-agent/core';
import { listConfigFiles, previewConfigFile, type ConfigPreviewDeps } from '../config-preview.js';
import type { AskReply } from '../asks.js';
import type { SessionView } from '../driver.js';
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
/** D46: stop one child agent (`?session=…&child=…`); the others keep running. */
export const CHILD_STOP_ROUTE = '/api/raw-agent/child-stop';
/** D47: stop one background task from the plugin task list (`?session=…&task=…`). */
export const TASK_STOP_ROUTE = '/api/raw-agent/task-stop';
/** D45: which of our sessions holds this host child session (`?session=<child host id>`). */
export const CHILD_OF_ROUTE = '/api/raw-agent/child-of';
/** D48: "Stop entire workflow" (`?session=…&task=<run task id>`). */
export const WORKFLOW_STOP_ROUTE = '/api/raw-agent/workflow-stop';
/** D48: stop one workflow agent (`?session=…&task=…&agent=…`); refused when the agent cannot. */
export const WORKFLOW_AGENT_STOP_ROUTE = '/api/raw-agent/workflow-agent-stop';
/** R6.2: the output of one of the session's own background shells or monitors (`?session=…&task=…`). */
export const TASK_OUTPUT_ROUTE = '/api/raw-agent/task-output';

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
    {
      path: CHILD_STOP_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const url = new URL(request.url);
        const id = url.searchParams.get('session');
        const child = url.searchParams.get('child');
        if (!id || !child) return json(400, { error: 'missing session or child' });
        const r = registry.get(id);
        if (!r) return json(missing.status, missing.body);
        try {
          const result = await r.stopChild(child);
          return json(result.ok ? 200 : result.status === 'unknown' ? 404 : 409, result);
        } catch (e) {
          return json(500, { error: String((e as Error)?.message ?? e) });
        }
      },
    },
    {
      path: TASK_STOP_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const url = new URL(request.url);
        const id = url.searchParams.get('session');
        const task = url.searchParams.get('task');
        if (!id || !task) return json(400, { error: 'missing session or task' });
        const r = registry.get(id);
        if (!r) return json(missing.status, missing.body);
        try {
          const result = await r.stopTask(task);
          return json(result.ok ? 200 : 409, result);
        } catch (e) {
          return json(500, { error: String((e as Error)?.message ?? e) });
        }
      },
    },
    {
      path: WORKFLOW_STOP_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const url = new URL(request.url);
        const id = url.searchParams.get('session');
        const task = url.searchParams.get('task');
        if (!id || !task) return json(400, { error: 'missing session or task' });
        const r = registry.get(id);
        if (!r) return json(missing.status, missing.body);
        try {
          const result = await r.stopWorkflow(task);
          return json(result.ok ? 200 : result.status === 'unknown' ? 404 : 409, result);
        } catch (e) {
          return json(500, { error: String((e as Error)?.message ?? e) });
        }
      },
    },
    {
      path: WORKFLOW_AGENT_STOP_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const url = new URL(request.url);
        const id = url.searchParams.get('session');
        const task = url.searchParams.get('task');
        const agent = url.searchParams.get('agent');
        if (!id || !task || !agent) return json(400, { error: 'missing session, task or agent' });
        const r = registry.get(id);
        if (!r) return json(missing.status, missing.body);
        try {
          const result = await r.stopWorkflowAgent(task, agent);
          const status = result.ok ? 200 : result.unsupported ? 409 : result.status === 'unknown' ? 404 : 409;
          return json(status, result);
        } catch (e) {
          return json(500, { error: String((e as Error)?.message ?? e) });
        }
      },
    },
    {
      // Only a task this session's own process started (a shell or a monitor): the task id is
      // looked up in that runtime, never used as a path. No file is served.
      path: TASK_OUTPUT_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch(request) {
        const url = new URL(request.url);
        const id = url.searchParams.get('session');
        const task = url.searchParams.get('task');
        if (!id || !task) return json(400, { error: 'missing session or task' });
        const r = registry.get(id);
        if (!r) return json(missing.status, missing.body);
        try {
          const result = await r.taskOutput(task);
          if (result.ok) return json(200, result);
          return json(result.code === 'unknown' ? 404 : result.code === 'unsupported' ? 409 : 502, result);
        } catch (e) {
          return json(500, { error: String((e as Error)?.message ?? e) });
        }
      },
    },
    {
      path: CHILD_OF_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: handler(async (id) => {
        const found = registry.findChild?.(id);
        if (!found) return { status: 404, body: { error: 'not a child session of this plugin' } };
        return { status: 200, body: found };
      }),
    },
    ...(controls ? sessionControlRoutes(registry, controls) : []),
  ];
}

// ---- session controls (R1.4, D35-D38, D4) ----

export const SESSION_ROUTE = '/api/raw-agent/session';
export const CHOICE_ROUTE = '/api/raw-agent/choice';
export const ANSWER_ROUTE = '/api/raw-agent/answer';
/** D39: the streaming interaction channel (NDJSON). */
export const INTERACTIONS_ROUTE = '/api/raw-agent/interactions';
/** How often the channel sends a keep-alive line. */
export const INTERACTIONS_PING_MS = 25_000;

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
  if (b.agent !== undefined) {
    if (b.agent !== null && (typeof b.agent !== 'string' || !MODEL_ID.test(b.agent))) return 'bad agent';
    out.agent = b.agent as string | null;
  }
  if (out.model === undefined && out.effort === undefined && out.mode === undefined && out.agent === undefined)
    return 'nothing to choose';
  return out;
}

const MAX_ANSWER_BYTES = 512 * 1024;
const plainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Parse and check the body of `POST …/answer`: `{ask, choice}` (ids), plus what the choice may
 * carry: `feedback` (text), `answers` and `notes` (question form, D41), `content` (elicitation
 * form, D43). The ask itself checks that the choice takes them (AskDesk.respond).
 */
export function parseAnswer(body: unknown): ({ ask: string } & AskReply) | string {
  if (!plainObject(body)) return 'the body must be a JSON object';
  const b = body;
  if (typeof b.ask !== 'string' || !MODEL_ID.test(b.ask)) return 'ask must be an ask id';
  if (typeof b.choice !== 'string' || !MODEL_ID.test(b.choice)) return 'choice must be a choice id';
  try {
    if (JSON.stringify(b).length > MAX_ANSWER_BYTES) return 'the answer is too large';
  } catch {
    return 'the body must be JSON';
  }
  const out: { ask: string } & AskReply = { ask: b.ask, choice: b.choice };
  if (b.feedback !== undefined) {
    if (typeof b.feedback !== 'string') return 'feedback must be text';
    out.feedback = b.feedback;
  }
  if (b.answers !== undefined) {
    if (!plainObject(b.answers)) return 'answers must be an object';
    out.answers = b.answers as Record<string, string | string[]>;
  }
  if (b.notes !== undefined) {
    if (!plainObject(b.notes)) return 'notes must be an object';
    out.notes = b.notes as Record<string, string>;
  }
  if (b.content !== undefined) {
    if (!plainObject(b.content)) return 'content must be an object';
    out.content = b.content;
  }
  if (b.rule !== undefined) {
    if (typeof b.rule !== 'string') return 'rule must be text';
    out.rule = b.rule;
  }
  return out;
}

/**
 * One line of the interaction channel: the open asks and the process state (D39), plus the
 * child rows, team roster and task list (R6.1-R6.3), so live child output shows without a poll.
 */
export function channelLine(view: SessionView): string {
  const line = {
    type: 'asks',
    asks: view.asks ?? [],
    state: view.state,
    live: view.live,
    children: view.children ?? [],
    team: view.team ?? null,
    tasks: view.tasks ?? [],
    workflows: view.workflows ?? [],
  };
  return `${JSON.stringify(line)}\n`;
}

/**
 * D39: the streaming interaction channel. On connect it sends the open asks (so a reloaded page
 * or a second browser gets them again), then one line after every change, and a keep-alive.
 * Answers go through `POST …/answer`; the first answer wins and the next line drops the card in
 * every other browser. Nothing here reaches the host log.
 */
export function interactionsRoute(registry: SessionRegistry, pingMs: number = INTERACTIONS_PING_MS): FetchRoute {
  return {
    path: INTERACTIONS_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const id = new URL(request.url).searchParams.get('session');
      if (!id) return json(400, { error: 'missing session' });
      const runtime = registry.get(id);
      if (!runtime) return json(404, { error: 'not a session of this plugin' });
      const enc = new TextEncoder();
      let stop = () => {};
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let last = '';
          let closed = false;
          const send = (line: string) => {
            if (closed) return;
            try {
              controller.enqueue(enc.encode(line));
            } catch {
              stop();
            }
          };
          const push = (view: SessionView) => {
            const line = channelLine(view);
            if (line === last) return;
            last = line;
            send(line);
          };
          let unsubscribe = () => {};
          const timer = setInterval(() => send('{"type":"ping"}\n'), pingMs);
          (timer as { unref?: () => void }).unref?.();
          stop = () => {
            if (closed) return;
            closed = true;
            clearInterval(timer);
            unsubscribe();
            request.signal?.removeEventListener('abort', stop);
            try {
              controller.close();
            } catch {
              // already closed by the reader
            }
          };
          request.signal?.addEventListener('abort', stop, { once: true });
          push(runtime.view());
          // The runtime closes the channel when it is disposed (session gone, plugin unload).
          unsubscribe = runtime.subscribe(push, () => stop());
          if (closed) unsubscribe();
        },
        cancel() {
          stop();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    },
  };
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
    // D51: the agent list of this process, else of a recent process in the same folder.
    const agentList = view.agents ?? registry.lastAgents?.(factory.kind, view.cwd);
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
    // D38 r4: a mode that needs a backend option (Claude: bypass) can be picked only when it is
    // on, or when the session already runs in it. The others are listed apart with the option
    // that unlocks them, so the picker can name every mode (R5.1) without offering them.
    const allModes = factory.staticCapabilities.permissionModes;
    const permissionModes = offeredPermissionModes(allModes, registry.userConfig?.().options, [
      view.live.mode,
      view.choice.pendingMode,
      settings?.permissionMode,
    ]);
    const unavailableModes = allModes
      .filter((m) => !permissionModes.some((o) => o.id === m.id))
      .map((m) => {
        const option = factory.staticCapabilities.userOptions?.find((o) => o.key === m.requiresOption);
        return { ...m, ...(option?.label !== undefined ? { optionLabel: option.label } : {}) };
      });
    return {
      backend: { kind: factory.kind, displayName: factory.displayName },
      permissionModes,
      ...(unavailableModes.length > 0 ? { unavailableModes } : {}),
      ...(factory.staticCapabilities.permissionModeCycle
        ? { permissionModeCycle: [...factory.staticCapabilities.permissionModeCycle] }
        : {}),
      efforts: factory.staticCapabilities.efforts ?? [],
      needsProcess: factory.staticCapabilities.needsProcess,
      models,
      modelsFrom: live ? (view.models ? 'session' : 'recent') : 'none',
      mainAgentPicker: factory.staticCapabilities.mainAgentPicker,
      agents: [...(agentList ?? [])],
      agentsFrom: agentList ? (view.agents ? 'session' : 'recent') : 'none',
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
        const { ask, ...reply } = a;
        const r = runtime.respond(ask, reply);
        if (r.ok) return json(200, { ok: true, session: await describe(id) });
        // 409: the ask is gone (another browser answered first, or the agent cancelled it);
        // 400: the reply does not fit the ask (a choice it does not offer, a bad form).
        return json(r.code === 'gone' ? 409 : 400, { ok: false, error: r.error, session: await describe(id) });
      },
    },
    interactionsRoute(registry),
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
