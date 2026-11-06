// The loop seam (D1, D2, D3, D22, D26, D76, D81). Mounted by our agent preset's single row.
//
// Listener order (`P/cordis/lib/index.js:920`: `push` unless `prepend`): the guard is prepended,
// so it wraps every Host listener and the driver; Host listeners registered at startup (for
// example dsh-time-context) wrap the driver. The guard forces `messages: []` on the way out, so
// the DSH loop never makes a model request in our sessions (D2).
//
// Known divergences from DSH's own loop (D79):
// - live frames are emitted with a plain `ctx.emit('agent/assistant-stream', …)`; the session
//   controller listens with `global: true` and filters by session id
//   (`P/dsh-api-session-controller/lib/index.js:1628, 1667`), so no scope carrier is needed;
// - the D3 re-wake splices a queued follow-up out of `nextTurn` before `send()`.

import type { AgentBackendFactory, ContentBlock, ToolResultContent, Usage, UserInput } from '@dsh-raw-agent/core';
import { SessionRuntime, type HostBinding, type HostSessionPort, type TurnSink } from '../driver.js';
import { SETTINGS_MODEL } from './catalog.js';
import { startJob } from './jobs.js';
import type { CordisContext, DshAgent, DshJobs, DshUserMessage, PreStepDecision, PreStepPayload } from './types.js';
import { TurnLog, type LiveChannel, type WriterOptions } from './writer.js';

/** `source.kind` of the log-only notice that opens a wake turn (D26). Never a `user/message`. */
export const WAKE_SOURCE_KIND = 'raw-agent-wake';

export interface AgentMountOptions {
  factory: AgentBackendFactory;
  env?: Readonly<Record<string, string | undefined>>;
  stopGraceMs?: number;
  /** Test seam for the writer (skip the self-check to prove the harness catches it). */
  writer?: Partial<WriterOptions>;
  /** Record a `model/selection` for our provider on new sessions (D76). Needs our catalog row. */
  selectSettingsModel?: boolean;
}

const randomId = (): string => globalThis.crypto.randomUUID();

function liveChannel(
  ctx: CordisContext,
  agent: DshAgent,
  counters: { revision: number; attempt: number },
): LiveChannel {
  return {
    emit: (frame) => ctx.emit('agent/assistant-stream', { agent, frame }),
    nextRevision: () => ++counters.revision,
    nextAttemptId: () => `${agent.session.id}:raw-${++counters.attempt}`,
  };
}

function toDshUsage(u: Usage): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
} {
  const out: ReturnType<typeof toDshUsage> = {
    inputTokens: u.input,
    outputTokens: u.output,
    cacheReadTokens: u.cacheRead,
    cacheWriteTokens: u.cacheWrite,
  };
  if (u.reasoning !== undefined) out.reasoningTokens = u.reasoning;
  return out;
}

function toResultBlocks(content: ToolResultContent[]): Array<{ type: 'text'; text: string }> {
  // Images become a short placeholder until D85 saves them as attachment refs.
  return content.map((c) =>
    c.type === 'text'
      ? { type: 'text', text: c.text }
      : c.type === 'image'
        ? { type: 'text', text: `[image ${c.mediaType}]` }
        : { type: 'text', text: JSON.stringify(c.value) },
  );
}

/** The writer seen through the driver's neutral interface. */
function sinkFor(log: TurnLog): TurnSink {
  return {
    get stepOpen() {
      return log.stepOpen;
    },
    get openCallIds() {
      return log.openCallIds;
    },
    hasCall: (id) => log.hasCall(id),
    openStep: () => log.openStep(),
    delta: (k, i, t, at) => log.delta(k, i, t, at),
    commit: (m) => {
      const input: Parameters<TurnLog['commit']>[0] = {
        blocks: m.blocks.map((b: ContentBlock) => (b.type === 'reasoning' ? { type: 'reasoning', text: b.text } : b)),
        binding: m.binding,
      };
      if (m.usage) input.usage = toDshUsage(m.usage);
      if (m.model) input.model = m.model;
      if (m.interrupted) input.interrupted = true;
      return log.commit(input);
    },
    result: (id, content, isError, chainId) =>
      log.result(id, toResultBlocks(content), isError, chainId === undefined ? undefined : { chainUuid: chainId }),
    closeStep: () => log.closeStep(),
  };
}

/** Human text and files → backend input (D22, D23). Images are S1 work (`ctx.attachments`). */
function toInput(factory: AgentBackendFactory, m: DshUserMessage, ctx: CordisContext): UserInput {
  const parts: UserInput['parts'] = [];
  const attachments = ctx.get('attachments') as { fileHostPath?(ref: unknown): string } | undefined;
  for (const b of m.content) {
    if (b.type === 'text' && typeof b.text === 'string') parts.push({ type: 'text', text: b.text });
    else if (b.type === 'file' && attachments?.fileHostPath)
      parts.push({ type: 'file', hostPath: attachments.fileHostPath(b.attachment) });
  }
  return { id: factory.inputIdFor?.(m.id) ?? m.id, parts };
}

/**
 * The last binding in this log (D21), own or inherited. The chain point is the later of the
 * binding's `lastChainId` and any later `tool/result` `meta.chainUuid` (D29).
 */
function latestBinding(agent: DshAgent, kind: string): HostBinding | undefined {
  const events = agent.session.snapshotEvents();
  let laterChain: string | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'tool/result' && laterChain === undefined) {
      const c = (e.data.meta as { chainUuid?: unknown } | undefined)?.chainUuid;
      if (typeof c === 'string') laterChain = c;
      continue;
    }
    if (e.type !== 'assistant/message') continue;
    const b = ((e.data.message as { source?: { rawAgent?: Record<string, unknown> } }).source ?? {}).rawAgent;
    if (b?.backend !== kind || typeof b.sessionId !== 'string' || b.sessionId === '') continue;
    const out: HostBinding = { sessionId: b.sessionId };
    if (typeof b.hostSessionId === 'string') out.hostSessionId = b.hostSessionId;
    const chain = laterChain ?? (typeof b.lastChainId === 'string' ? b.lastChainId : undefined);
    if (chain !== undefined) out.chainId = chain;
    return out;
  }
  return undefined;
}

/** D35: the latest own or inherited `model/selection` naming our provider; `settings` = no choice. */
function modelChoice(agent: DshAgent, kind: string): string | undefined {
  const events = agent.session.snapshotEvents();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== 'model/selection') continue;
    const d = e.data as { provider?: string; model?: string };
    if (d.provider !== kind) continue;
    return d.model === SETTINGS_MODEL || typeof d.model !== 'string' ? undefined : d.model;
  }
  return undefined;
}

export interface AgentMount {
  /** Live runtimes by DSH session id (tests and services). */
  readonly runtimes: ReadonlyMap<string, SessionRuntime>;
}

/** Mount the driver, the guard, the job controller and the re-wake in a preset-scoped context. */
export function mountAgent(ctx: CordisContext, o: AgentMountOptions): AgentMount {
  const factory = o.factory;
  const runtimes = new Map<string, SessionRuntime>();
  const counters = new WeakMap<DshAgent, { revision: number; attempt: number }>();
  const warn = (note: string, detail?: unknown) => ctx.logger?.warn(`[raw-agent] ${note}`, detail ?? '');
  const jobs = () => ctx.get('jobs') as DshJobs | undefined;

  // D47: our own scoped controller; this context serves exactly the agents of our preset.
  const j = jobs();
  if (j) ctx.effect(() => j.attachController('raw-agent'), 'raw-agent: job controller');

  const runtimeFor = (agent: DshAgent): SessionRuntime => {
    let r = runtimes.get(agent.id);
    if (r) return r;
    const port: HostSessionPort = {
      hostSessionId: agent.session.id,
      cwd: agent.session.header.cwd ?? process.cwd(),
      wake(summary) {
        // D26: a log-only notice opens the turn; the driver never writes it as a user/message.
        agent.followup({
          id: randomId(),
          role: 'user',
          content: [{ type: 'text', text: summary }],
          source: { kind: WAKE_SOURCE_KIND, form: 'notice', summary },
        });
      },
      latestBinding: () => latestBinding(agent, factory.kind),
      modelChoice: () => modelChoice(agent, factory.kind),
      startJob(task, stop) {
        const registry = jobs();
        return registry ? startJob(registry, agent.session.id, task, stop, warn) : undefined;
      },
      warn,
    };
    const opts: ConstructorParameters<typeof SessionRuntime>[2] = { env: o.env ?? process.env };
    if (o.stopGraceMs !== undefined) opts.stopGraceMs = o.stopGraceMs;
    r = new SessionRuntime(factory, port, opts);
    runtimes.set(agent.id, r);
    return r;
  };

  // D2: the guard. Outermost, so nothing a Host listener adds reaches a DSH model.
  ctx.on(
    'agent/pre-step',
    (async (_p: PreStepPayload, next: () => Promise<PreStepDecision>) => {
      const d = await next();
      return d.kind === 'reject' ? d : { kind: 'enter', messages: [] };
    }) as never,
    { prepend: true },
  );

  // D1: the driver. It runs the whole turn in the backend and admits nothing.
  ctx.on('agent/pre-step', (async (p: PreStepPayload, _next: () => Promise<PreStepDecision>) => {
    const { agent, messages, turn, signal } = p;
    if (messages.length === 0) return { kind: 'enter', messages: [] };
    // D45: a child session never spawns or sends (children are a later milestone).
    if (agent.session.header.origin === 'subagent') return { kind: 'enter', messages: [] };
    const human = messages.filter((m) => m.source.kind === 'user');
    const wake = messages.some((m) => m.source.kind === WAKE_SOURCE_KIND);
    // D22: every other claimed message (inject()ed DSH notices) is dropped, never sent.
    const log = new TurnLog(agent.session, liveChannel(ctx, agent, counters.get(agent) ?? newCounters(agent)), turn, {
      provider: factory.kind,
      warn,
      ...o.writer,
    });
    for (const m of human) log.writeUser(m);
    const runtime = runtimeFor(agent);
    const outcome = await runtime.runTurn(
      sinkFor(log),
      { userInputs: human.map((m) => toInput(factory, m, ctx)), wake },
      signal,
    );
    log.close();
    if (outcome.kind === 'error') throw new Error(outcome.message);
    signal.throwIfAborted();
    return { kind: 'enter', messages: [] };
  }) as never);

  function newCounters(agent: DshAgent) {
    const c = { revision: 0, attempt: 0 };
    counters.set(agent, c);
    return c;
  }

  // D3: a follow-up queued during a driver turn would stall; splice it out, then send it again.
  ctx.on('agent/status', ((p: { agent: DshAgent; status: string }) => {
    const { agent, status } = p;
    if (status !== 'idle' || agent.session.header.origin === 'subagent') return;
    const message = agent.inbox.nextTurn.at(0);
    if (!message) return;
    agent.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
    agent.send(message, 'next-turn', true);
  }) as never);

  // D76: image admission on turn 1 reads the current model; record our `settings` row.
  if (o.selectSettingsModel)
    ctx.on('agent/created', ((p: { agent: DshAgent; source: string }) => {
      if (p.source !== 'startup' || p.agent.session.header.isSeeded) return;
      // A choice made on the new-task page is already in the log; never overwrite it.
      if (p.agent.session.snapshotEvents().some((e) => e.type === 'model/selection')) return;
      try {
        p.agent.model.select({ provider: factory.kind, model: 'settings' });
      } catch (error) {
        warn('could not record the settings model selection', String(error));
      }
      return undefined;
    }) as never);

  ctx.on('agent/disposed', ((p: { agent: DshAgent }) => {
    const r = runtimes.get(p.agent.id);
    runtimes.delete(p.agent.id);
    void r?.dispose();
  }) as never);
  ctx.effect(
    () => () => {
      for (const r of runtimes.values()) void r.dispose();
      runtimes.clear();
    },
    'raw-agent: backend sessions',
  );

  return { runtimes };
}
