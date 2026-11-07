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

/** M7 (D30): the rewind dialog's facts (`?session=…`). Never spawns. */
export const REWIND_ROUTE = '/api/raw-agent/rewind';
/** M7 (D30): "restore code" at a fork's first start (`?session=<fork>&on=1|0`). */
export const REWIND_RESTORE_ROUTE = '/api/raw-agent/rewind-restore';
/** M7 (D30): "Restore code" in place (`?session=…&message=<host message id>&dryRun=1`). */
export const REWIND_FILES_ROUTE = '/api/raw-agent/rewind-files';

/** M5 (D58-D60): the usage panel's data (`?session=…`). Reads the live process only. */
export const USAGE_ROUTE = '/api/raw-agent/usage';
/** M5 (D59): the context pill and breakdown (`?session=…&detail=summary|full`). Never spawns. */
export const CONTEXT_ROUTE = '/api/raw-agent/context';

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
    ...rewindRoutes(registry),
    ...usageRoutes(registry),
    ...commandRoutes(registry),
    ...(controls ? sessionControlRoutes(registry, controls) : []),
  ];
}

/**
 * M7 rewind routes (D30). A session id names only a runtime the registry holds (D62). None starts
 * a process; "Restore code" in place needs the live process and is refused otherwise. No file
 * path comes from the request: a message id names a turn, and the agent restores its own
 * checkpoints.
 */
export function rewindRoutes(registry: SessionRegistry): FetchRoute[] {
  const missing = () => json(404, { error: 'not a session of this plugin' });
  const lookup = (request: Request) => {
    const url = new URL(request.url);
    const id = url.searchParams.get('session');
    return { url, id, runtime: id ? registry.get(id) : undefined };
  };
  const guard = async (fn: () => Promise<Response>) => {
    try {
      return await fn();
    } catch (e) {
      return json(500, { error: String((e as Error)?.message ?? e) });
    }
  };
  return [
    {
      path: REWIND_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) =>
        guard(async () => {
          const { id, runtime } = lookup(request);
          if (!id) return json(400, { error: 'missing session' });
          if (!runtime) return missing();
          if (typeof runtime.rewindOptions !== 'function') return json(409, { error: 'this runtime cannot rewind' });
          return json(200, await runtime.rewindOptions());
        }),
    },
    {
      path: REWIND_RESTORE_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) =>
        guard(async () => {
          const { url, id, runtime } = lookup(request);
          if (!id) return json(400, { error: 'missing session' });
          if (!runtime) return missing();
          if (typeof runtime.requestCodeRestore !== 'function')
            return json(409, { error: 'this runtime cannot rewind' });
          const on = url.searchParams.get('on') !== '0';
          const r = runtime.requestCodeRestore(on);
          return json(r.ok ? 200 : 409, r);
        }),
    },
    {
      path: REWIND_FILES_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) =>
        guard(async () => {
          const { url, id, runtime } = lookup(request);
          const message = url.searchParams.get('message');
          if (!id || !message || message.length > 256) return json(400, { error: 'missing session or message' });
          if (!runtime) return missing();
          if (typeof runtime.rewindFiles !== 'function') return json(409, { error: 'this runtime cannot rewind' });
          const r = await runtime.rewindFiles(message, url.searchParams.get('dryRun') === '1');
          const status = r.ok ? 200 : r.code === 'failed' ? 502 : 409;
          return json(status, r);
        }),
    },
  ];
}

/**
 * M5 usage routes. GET only, no body; a session id names only a runtime the registry holds
 * (D62). Neither route starts a process (rule 9, D4): with no process they answer what is
 * known, and the client offers "Start". Neither writes the DSH log (no `request/context`, D59).
 */
export function usageRoutes(registry: SessionRegistry): FetchRoute[] {
  const missing = json(404, { error: 'not a session of this plugin' });
  return [
    {
      path: USAGE_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch(request) {
        const id = new URL(request.url).searchParams.get('session');
        if (!id) return json(400, { error: 'missing session' });
        const r = registry.get(id);
        if (!r) return missing;
        if (typeof r.usage !== 'function') return json(409, { error: 'this runtime has no usage data' });
        try {
          return json(200, await r.usage());
        } catch (e) {
          return json(500, { error: String((e as Error)?.message ?? e) });
        }
      },
    },
    {
      path: CONTEXT_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch(request) {
        const url = new URL(request.url);
        const id = url.searchParams.get('session');
        if (!id) return json(400, { error: 'missing session' });
        const detail = url.searchParams.get('detail') ?? 'summary';
        if (detail !== 'summary' && detail !== 'full') return json(400, { error: 'detail must be summary or full' });
        const r = registry.get(id);
        if (!r) return missing;
        if (typeof r.contextUsage !== 'function') return json(409, { error: 'this runtime has no context data' });
        try {
          return json(200, await r.contextUsage(detail));
        } catch (e) {
          return json(500, { error: String((e as Error)?.message ?? e) });
        }
      },
    },
  ];
}

// ---- M6: commands, side questions, MCP, local outputs (R7.1-R7.4) ----

/** R7.1: the agent's commands and their place in the `/` menu (`?session=…`). Never spawns. */
export const COMMANDS_ROUTE = '/api/raw-agent/commands';
/** R7.3, D54: POST `{question}` asks; GET lists this session's side questions (`?session=…`). */
export const SIDE_QUESTION_ROUTE = '/api/raw-agent/side-question';
/** D54: cancel one open side question (`?session=…&id=…`). */
export const SIDE_QUESTION_CANCEL_ROUTE = '/api/raw-agent/side-question-cancel';
/** R7.4, D55: the MCP servers (`?session=…`). Never spawns. */
export const MCP_ROUTE = '/api/raw-agent/mcp';
/** D55: `?session=…&server=…`. */
export const MCP_RECONNECT_ROUTE = '/api/raw-agent/mcp-reconnect';
/** D55: `?session=…&server=…&enabled=true|false`. Saved by the agent itself, never by us. */
export const MCP_TOGGLE_ROUTE = '/api/raw-agent/mcp-toggle';
/** D55: start a sign-in (`?session=…&server=…`), **unverified** live. */
export const MCP_AUTH_ROUTE = '/api/raw-agent/mcp-auth';
/** D55: POST `{server, url}`: the provider's final redirect address, pasted by the user. */
export const MCP_AUTH_CALLBACK_ROUTE = '/api/raw-agent/mcp-auth-callback';
/** R7.2: one structured local-command output (`?session=…&id=…`), display-only. */
export const LOCAL_OUTPUT_ROUTE = '/api/raw-agent/local-output';

/** The longest MCP server name or callback address a route accepts. */
const MAX_MCP_TEXT = 4096;
const MAX_SIDE_BODY = 128 * 1024;

/**
 * Read a JSON body of at most `max` bytes. A declared larger length is refused before reading,
 * and the stream is read only up to the limit (M6 review: no whole-body read before the check).
 */
export async function readJson(request: Request, max: number): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) throw new RangeError('the body is too large');
  const body = request.body;
  if (!body) return JSON.parse(await request.text());
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new RangeError('the body is too large');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(all));
}

/**
 * M6 routes over the Host registry. A session id names only a runtime the registry holds (D62).
 * None of them starts a process (rule 9, D4) or writes the host log; the side question's answer
 * is held in memory only (D24, D54). MCP actions call the agent's own controls, never a settings
 * write (rule 2, D55).
 */
export function commandRoutes(registry: SessionRegistry): FetchRoute[] {
  const missing = () => json(404, { error: 'not a session of this plugin' });
  const lookup = (request: Request) => {
    const url = new URL(request.url);
    const id = url.searchParams.get('session');
    return { url, id, runtime: id ? registry.get(id) : undefined };
  };
  const guard = async (fn: () => Promise<Response>) => {
    try {
      return await fn();
    } catch (e) {
      return json(500, { error: String((e as Error)?.message ?? e) });
    }
  };
  const mcpStatusOf = (code: string) => (code === 'unknown-server' ? 404 : code === 'failed' ? 502 : 409); // not-running, unsupported
  const serverParam = (url: URL) => {
    const s = url.searchParams.get('server');
    return s && s.length <= MAX_MCP_TEXT ? s : undefined;
  };
  return [
    {
      path: COMMANDS_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) =>
        guard(async () => {
          const { id, runtime } = lookup(request);
          if (!id) return json(400, { error: 'missing session' });
          if (!runtime) return missing();
          if (typeof runtime.commandsAnswer !== 'function') return json(409, { error: 'this runtime has no commands' });
          return json(200, await runtime.commandsAnswer());
        }),
    },
    {
      path: SIDE_QUESTION_ROUTE,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: (request) =>
        guard(async () => {
          const { id, runtime } = lookup(request);
          if (!id) return json(400, { error: 'missing session' });
          if (!runtime) return missing();
          if (typeof runtime.askSideQuestion !== 'function' || typeof runtime.sideQuestions !== 'function')
            return json(409, { error: 'this runtime has no side questions' });
          if (request.method !== 'POST') return json(200, runtime.sideQuestions());
          let body: unknown;
          try {
            body = await readJson(request, MAX_SIDE_BODY);
          } catch {
            return json(400, { error: 'the body must be JSON: {"question": "…"}' });
          }
          const question = (body as { question?: unknown } | null)?.question;
          if (typeof question !== 'string') return json(400, { error: 'question must be text' });
          // Not tied to the request: the question runs to its answer even when the page that
          // asked it closes (the panel reads it back); the user cancels with the cancel route.
          const asked = runtime.askSideQuestion(question);
          // A refusal resolves at once; an answer takes a model call, so the route answers 202
          // while the question is open and the answer reaches the page on the interaction
          // channel (`side`). The composer's `/btw` claim does not wait for the model.
          const r = await Promise.race([asked, new Promise<undefined>((done) => setTimeout(() => done(undefined), 0))]);
          const side = runtime.sideQuestions();
          if (r === undefined) {
            const entry = side.entries.at(-1);
            return json(202, { ok: true, ...(entry ? { entry } : {}), side });
          }
          if (r.ok) return json(r.entry.status === 'answered' ? 200 : 202, { ...r, side });
          return json(r.code === 'busy' || r.code === 'unsupported' ? 409 : 400, { ...r, side });
        }),
    },
    {
      path: SIDE_QUESTION_CANCEL_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) =>
        guard(async () => {
          const { url, id, runtime } = lookup(request);
          const entry = url.searchParams.get('id');
          if (!id || !entry) return json(400, { error: 'missing session or id' });
          if (!runtime) return missing();
          if (typeof runtime.cancelSideQuestion !== 'function') return json(409, { error: 'no side questions' });
          const ok = runtime.cancelSideQuestion(entry);
          return json(ok ? 200 : 409, { ok, side: runtime.sideQuestions?.() });
        }),
    },
    {
      path: MCP_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) =>
        guard(async () => {
          const { id, runtime } = lookup(request);
          if (!id) return json(400, { error: 'missing session' });
          if (!runtime) return missing();
          if (typeof runtime.mcp !== 'function') return json(409, { error: 'this runtime has no MCP data' });
          return json(200, await runtime.mcp());
        }),
    },
    ...(
      [
        [MCP_RECONNECT_ROUTE, 'reconnect'],
        [MCP_TOGGLE_ROUTE, 'toggle'],
        [MCP_AUTH_ROUTE, 'authenticate'],
      ] as const
    ).map(([path, action]): FetchRoute => ({
      path,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) =>
        guard(async () => {
          const { url, id, runtime } = lookup(request);
          const server = serverParam(url);
          if (!id || server === undefined) return json(400, { error: 'missing session or server' });
          if (!runtime) return missing();
          if (typeof runtime.mcpAction !== 'function') return json(409, { error: 'this runtime has no MCP controls' });
          let arg: { enabled: boolean } | undefined;
          if (action === 'toggle') {
            const enabled = url.searchParams.get('enabled');
            if (enabled !== 'true' && enabled !== 'false') return json(400, { error: 'enabled must be true or false' });
            arg = { enabled: enabled === 'true' };
          }
          const r = await runtime.mcpAction(action, server, arg);
          return json(r.ok ? 200 : mcpStatusOf(r.code), r);
        }),
    })),
    {
      path: MCP_AUTH_CALLBACK_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) =>
        guard(async () => {
          const { id, runtime } = lookup(request);
          if (!id) return json(400, { error: 'missing session' });
          if (!runtime) return missing();
          if (typeof runtime.mcpAction !== 'function') return json(409, { error: 'this runtime has no MCP controls' });
          let body: unknown;
          try {
            body = await readJson(request, MAX_MCP_TEXT * 2);
          } catch {
            return json(400, { error: 'the body must be JSON: {"server": "…", "url": "…"}' });
          }
          const b = (body ?? {}) as { server?: unknown; url?: unknown };
          if (typeof b.server !== 'string' || b.server === '' || b.server.length > MAX_MCP_TEXT)
            return json(400, { error: 'server must be a server name' });
          if (typeof b.url !== 'string' || !/^https?:\/\//i.test(b.url) || b.url.length > MAX_MCP_TEXT)
            return json(400, { error: 'url must be the http(s) address the browser ended on' });
          const r = await runtime.mcpAction('auth-callback', b.server, { callbackUrl: b.url });
          return json(r.ok ? 200 : mcpStatusOf(r.code), r);
        }),
    },
    {
      path: LOCAL_OUTPUT_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) =>
        guard(async () => {
          const { url, id, runtime } = lookup(request);
          const out = url.searchParams.get('id');
          if (!id || !out) return json(400, { error: 'missing session or id' });
          if (!runtime) return missing();
          const found = runtime.localOutput?.(out);
          // Gone after a restart: the command's text stays in the log (display-only path).
          if (!found) return json(404, { error: 'this output is no longer kept; its text is in the conversation' });
          return json(200, found);
        }),
    },
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
    // M5: the pill's small usage summary, so context and totals update without a poll (D59).
    usage: view.usage ?? null,
    // M6: side questions (D54), the command list version (R7.1) and the MCP summary (R7.4).
    side: view.side ?? null,
    menu: view.menu ?? null,
    mcp: view.mcp ?? null,
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
