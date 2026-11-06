// In-process DSH loop harness (architecture §10.2). It loads the installed DSH packages at run
// time (tests only; nothing here is bundled), runs the real agent loop with JSONL persistence,
// and checks a session the way DSH does: the v4 relationship check, a reload from disk (the read
// path of a DSH restart, which also runs the check) and the embedded-stream replay through the
// real BlockAssembler. It makes no model calls: a stray DSH model request is recorded.

import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/** The directory that holds the installed `@deepseek-ai/*` packages, or undefined. */
export function findDshPackages(): string | undefined {
  const fromEnv = process.env.DSH_PKG;
  if (fromEnv && existsSync(join(fromEnv, '@deepseek-ai', 'dsh-agent-loop'))) return fromEnv;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const bin = join(dir, 'dsh');
    if (!existsSync(bin)) continue;
    let p = realpathSync(bin);
    for (let i = 0; i < 8; i++) {
      p = dirname(p);
      const nm = join(p, 'node_modules');
      if (existsSync(join(nm, '@deepseek-ai', 'dsh-agent-loop'))) return nm;
    }
  }
  return undefined;
}

export interface Dsh {
  dir: string;
  version: string;
  Context: Any;
  AgentRegistry: Any;
  AgentLoop: Any;
  SessionStore: Any;
  KNOWN_SESSION_EVENT_TYPES: Any;
  SessionProjectionRegistry: Any;
  SystemPrompt: Any;
  jsonl: Any;
  LocalJobRegistry: Any;
  assertReleasedV4Relationships: Any;
  BlockAssembler: Any;
  expandAssistantStream: Any;
  formatSessionMarkdown: Any;
  /** The real `llm` runtime (model directory and `resolveModelInfo`). */
  LlmRuntime: Any;
  /** The real content-addressed local attachment store (`ctx.attachments`). */
  LocalAttachmentStore: Any;
}

export async function loadDsh(dir = findDshPackages()): Promise<Dsh | undefined> {
  if (dir === undefined) return undefined;
  const imp = (pkg: string) => import(pathToFileURL(join(dir, '@deepseek-ai', pkg, 'lib', 'index.js')).href);
  const [cordis, agent, loop, session, proj, sp, jsonl, jobs, v4, llm, exp, att] = await Promise.all([
    imp('cordis'),
    imp('dsh-agent'),
    imp('dsh-agent-loop'),
    imp('dsh-session'),
    imp('dsh-session-projection'),
    imp('dsh-system-prompt'),
    imp('dsh-session-persistence-jsonl'),
    imp('dsh-jobs-local'),
    imp('dsh-session-format-v3-to-v4'),
    imp('dsh-llm'),
    imp('dsh-session-log-export'),
    imp('dsh-attachment-local'),
  ]);
  let version = 'unknown';
  try {
    const pj = join(dir, '@deepseek-ai', 'dsh-agent', 'package.json');
    if (statSync(pj).isFile())
      version = (await import(pathToFileURL(pj).href, { with: { type: 'json' } })).default.version;
  } catch {
    /* keep unknown */
  }
  return {
    dir,
    version,
    Context: cordis.Context,
    AgentRegistry: agent.AgentRegistry,
    AgentLoop: loop.AgentLoop,
    SessionStore: session.SessionStore,
    KNOWN_SESSION_EVENT_TYPES: session.KNOWN_SESSION_EVENT_TYPES,
    SessionProjectionRegistry: proj.SessionProjectionRegistry,
    SystemPrompt: sp.SystemPrompt,
    jsonl,
    LocalJobRegistry: jobs.default,
    assertReleasedV4Relationships: v4.assertReleasedV4Relationships,
    BlockAssembler: llm.BlockAssembler,
    expandAssistantStream: llm.expandAssistantStream,
    formatSessionMarkdown: exp.formatSessionMarkdown,
    LlmRuntime: llm.default,
    LocalAttachmentStore: att.default ?? att.LocalAttachmentStore,
  };
}

export interface LoopRuntime {
  ctx: Any;
  root: string;
  /** DSH model requests that reached the stub `llm` service (must stay empty). */
  stray: unknown[];
  dispose(): Promise<void>;
}

/** The text-only DSH default model of a real-llm loop (D76): what a fresh DSH profile may have. */
export const TEXT_ONLY_DEFAULT = Object.freeze({ provider: 'dsh-default', model: 'flash' });

export interface LoopOptions {
  jobs?: boolean;
  /**
   * 'real': the real `llm` runtime with one text-only DSH default provider ({@link TEXT_ONLY_DEFAULT})
   * whose calls are recorded as stray. Default: a stub `llm` that records every call.
   */
  llm?: 'stub' | 'real';
  /** Mount the real local attachment store under the loop's temp root. */
  attachments?: boolean;
}

export async function createLoop(dsh: Dsh, opts: LoopOptions = {}): Promise<LoopRuntime> {
  const root = await mkdtemp(join(tmpdir(), 'raw-agent-rt-'));
  const ctx = new dsh.Context();
  const stray: unknown[] = [];
  if (opts.llm === 'real') {
    ctx.plugin(dsh.LlmRuntime);
    await new Promise((r) => setTimeout(r, 10));
    const strayCall = (c: unknown) => {
      stray.push(c);
      throw new Error('STRAY DSH MODEL REQUEST');
    };
    const row = (provider: string, id: string) => ({
      provider,
      id,
      name: id,
      inputModalities: ['text'],
      context: { contextWindow: 100000 },
    });
    ctx.get('llm').registerAdapter([TEXT_ONLY_DEFAULT.provider], {
      providerInfo: (p: string) => ({ id: p, name: 'Text-only default' }),
      providerRetryPolicy: () => undefined,
      imageRequestPricing: () => undefined,
      imageRequestTarget: () => undefined,
      listModels: async (p: string) => [row(p, TEXT_ONLY_DEFAULT.model)],
      resolveModel: async (p: string, m: string) => row(p, m),
      prepareCall: async (c: unknown) => strayCall(c),
      stream: (c: unknown) => strayCall(c ?? 'stream'),
    });
  } else
    ctx.provide('llm', {
      prepareCall: async (c: unknown) => {
        stray.push(c);
        throw new Error('STRAY DSH MODEL REQUEST');
      },
      stream() {
        stray.push('stream');
        throw new Error('STRAY DSH MODEL REQUEST');
      },
    });
  if (opts.attachments) ctx.plugin(dsh.LocalAttachmentStore, { dshHome: join(root, 'dsh-home') });
  ctx.provide('tools', {
    resolve: async () => ({ dispose() {}, view: () => new Map() }),
    execute: async () => {
      throw new Error('no tools');
    },
  });
  ctx.plugin(dsh.SessionStore);
  ctx.plugin(dsh.AgentRegistry);
  ctx.plugin(dsh.SessionProjectionRegistry);
  ctx.plugin(dsh.SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false });
  await ctx.plugin(dsh.jsonl, { root, compression: 'none' }).await();
  if (opts.jobs) ctx.plugin(dsh.LocalJobRegistry, {});
  await ctx.plugin(dsh.AgentLoop, { agents: [], maxParallelToolCalls: 1 }).await();
  await new Promise((r) => setTimeout(r, 30));
  return { ctx, root, stray, dispose: () => ctx.fiber.dispose() };
}

/**
 * DSH's image admission for one prompt, as the session controller runs it before admitting a
 * message with an image (`P/dsh-api-session-controller/lib/index.js:844-849`): the agent's current
 * model must declare image input. Resolves to the refusal text, or undefined when admitted.
 */
export async function imageAdmissionRefusal(ctx: Any, agent: Any): Promise<string | undefined> {
  const current = agent.model.current();
  if (current === undefined) return undefined;
  const model = await ctx.get('llm').resolveModelInfo(current.provider, current.model);
  if (model.inputModalities !== undefined && !model.inputModalities.includes('image'))
    return `Model "${current.model}" does not support image input.`;
  return undefined;
}

export interface SessionCheck {
  events: Any[];
  relationships: string;
  streamCheck: string;
  reload: string;
  reloadAddedTail: string[];
  exportMarkdown: string;
  /** Compact event list for assertions: `type` plus turn/step data. */
  sequence: string[];
}

/** Replay every embedded stream through the real assembler, as the generation check does. */
export function realStreamCheck(dsh: Dsh, events: Any[]): string {
  for (const e of events) {
    if (e.type !== 'assistant/message' && e.type !== 'assistant/attempt') continue;
    try {
      const asm = new dsh.BlockAssembler();
      const timed = dsh.expandAssistantStream(e.data.stream);
      for (const m of timed) asm.push(m.chunk);
      if (e.type === 'assistant/attempt' || timed.length === 0) continue;
      const content = e.data.interrupted === true ? asm.interruptedBlocks() : asm.blocks();
      if (!isDeepStrictEqual(e.data.message.content, content)) return `content disagrees with stream at seq ${e.seq}`;
      if (!isDeepStrictEqual(e.data.usage, asm.usage)) return `usage disagrees with stream at seq ${e.seq}`;
      if (!isDeepStrictEqual(e.data.message.source.replayState, asm.replayState))
        return `replay state disagrees with stream at seq ${e.seq}`;
    } catch (err) {
      return `stream invalid at seq ${e.seq}: ${(err as Error).message}`;
    }
  }
  return 'ok';
}

export function relationshipCheck(dsh: Dsh, sessionId: string, events: Any[]): string {
  try {
    dsh.assertReleasedV4Relationships(
      {
        header: { version: 4, id: sessionId, createdAt: 0, isSeeded: false, delegationDepth: 0 },
        events,
        inheritedEventCount: 0,
      },
      dsh.KNOWN_SESSION_EVENT_TYPES,
    );
    return 'ok';
  } catch (err) {
    return `${(err as Error).name}: ${(err as Error).message}`;
  }
}

/** Flush, dispose, reload from disk, and run every check. */
export async function checkSession(dsh: Dsh, rt: LoopRuntime, handle: Any, sessionId: string): Promise<SessionCheck> {
  const events = handle.agent.session.snapshotEvents();
  await rt.ctx.sessions.flush(handle.agent.session);
  await handle.dispose();
  let reload = 'ok';
  let reloadAddedTail: string[] = [];
  try {
    const h2 = await rt.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'raw-test', model: 'settings' },
    });
    const again = h2.agent.session.snapshotEvents();
    reloadAddedTail = again.slice(events.length).map((e: Any) => e.type);
    await h2.dispose();
  } catch (error) {
    const e = error as Error & { cause?: Error };
    reload = `FAILED: ${e.name}: ${e.message}${e.cause ? ` <- ${e.cause.message}` : ''}`;
  }
  return {
    events,
    relationships: relationshipCheck(dsh, sessionId, events),
    streamCheck: realStreamCheck(dsh, events),
    reload,
    reloadAddedTail,
    exportMarkdown: String(dsh.formatSessionMarkdown(events)),
    sequence: events.map((e: Any) =>
      e.type.startsWith('turn/') || e.type.startsWith('step/')
        ? `${e.type} ${JSON.stringify(e.data.reason?.kind ?? e.data.step ?? e.data.turn)}`
        : e.type,
    ),
  };
}

export async function filesUnder(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(p);
    }
  };
  await walk(root);
  return out;
}
