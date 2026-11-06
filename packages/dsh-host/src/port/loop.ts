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
// - the D3 re-wake splices a queued follow-up out of `nextTurn` before `send()` (through the
//   writer's asserting `spliceInbox`, D17 h);
// - the D27 steer claim splices a consumed steer out of `nextStep` itself (no `outcome`, no
//   `agent/inbox/claimed` notification), then writes the unchanged `user/message`;
// - a steer the agent cancelled on Stop is removed with the public `inbox.remove()` (D25 r4).

import type { AgentBackendFactory, BackendUserConfig, ContentBlock, Usage, UserInput } from '@dsh-raw-agent/core';
import {
  SessionRuntime,
  imageUnavailableText,
  type HostBinding,
  type HostSessionPort,
  type SinkResultContent,
  type TurnSink,
} from '../driver.js';
import { SessionRegistry, SESSIONS_SERVICE, isSessionRegistry, type ReturnedDraft } from '../registry.js';
import { modeCommandDescription, runModeCommand } from '../mode-command.js';
import { SETTINGS_MODEL } from './catalog.js';
import { startJob } from './jobs.js';
import { childPreStep, createChildSession } from './children.js';
import { appendWorkflowRecord, openWorkflowRuns } from './workflows.js';
import {
  DSH_IMAGE_MEDIA_TYPES,
  type CordisContext,
  type DshAgent,
  type DshAttachments,
  type DshJobs,
  type DshUserMessage,
  type PreStepDecision,
  type PreStepPayload,
} from './types.js';
import { TurnLog, spliceInbox, type LiveChannel, type ToolResultBlock, type WriterOptions } from './writer.js';

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
  /** Read at every spawn (D87): executable path and backend options. */
  userConfig?: () => BackendUserConfig;
  /** Test seam: use this registry instead of the Host entry's service or a mount-local one. */
  registry?: SessionRegistry;
  /** The preset id this mount serves (D81: `raw-agent-<kind>`). Used to find agents rebound to it. */
  presetId?: string;
  /**
   * Shadow DSH's `/permission` in our agents' own scope (R1.4 leftover). Default on. DSH's preset
   * would show and set a level this agent never applies.
   */
  modeCommand?: boolean;
}

/** The part of DSH's command registry the port uses (`P/dsh-commands/lib/index.js:262-268`). */
interface DshCommands {
  register(definition: {
    name: string;
    description: string;
    input?: { hint: string };
    handler(invocation: { agent: DshAgent; rawInput: string }): Promise<unknown> | unknown;
  }): unknown;
}

/** The name of DSH's permission-preset command, shadowed in our sessions. */
export const PERMISSION_COMMAND = 'permission';

/** D81: the preset row of a backend kind. */
export function presetIdFor(kind: string): string {
  return `raw-agent-${kind}`;
}

interface DshAgentsService {
  list?(): readonly DshAgent[];
}
interface DshAgentPresets {
  composedPreset?(ctx: unknown): string | undefined;
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

/** D85: tool-result content → native `tool/result` blocks. Stored images become attachment refs. */
export function toResultBlocks(content: SinkResultContent[]): ToolResultBlock[] {
  return content.map((c): ToolResultBlock => {
    switch (c.type) {
      case 'text':
        return { type: 'text', text: c.text };
      case 'saved-image':
        return { type: 'image', attachment: c.ref };
      case 'image': // never written as base64 (D85); the driver stores images first
        return { type: 'text', text: imageUnavailableText(c.mediaType, 'it was not stored') };
      default:
        return { type: 'text', text: JSON.stringify(c.value) };
    }
  });
}

/** D85: decode result images and store them as one ordered batch through `ctx.attachments`. */
export async function saveResultImages(
  ctx: CordisContext,
  images: ReadonlyArray<{ mediaType: string; base64: string }>,
): Promise<readonly unknown[]> {
  const store = ctx.get('attachments') as DshAttachments | undefined;
  if (typeof store?.saveImages !== 'function') throw new Error('no attachment store is mounted');
  const decoded = images.map((i) => {
    if (!DSH_IMAGE_MEDIA_TYPES.includes(i.mediaType))
      throw new Error(`the media type ${i.mediaType} is not PNG, JPEG, WebP or GIF`);
    const data = Buffer.from(i.base64, 'base64');
    if (data.length === 0) throw new Error('the image data is empty or not base64');
    return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), mediaType: i.mediaType };
  });
  return store.saveImages(decoded);
}

/** The writer seen through the driver's neutral interface. */
function sinkFor(log: TurnLog, agent: DshAgent, ctx: CordisContext): TurnSink {
  return {
    get stepOpen() {
      return log.stepOpen;
    },
    get hasMessage() {
      return log.hasMessage;
    },
    claim: (id) => log.claim(id, agent.inbox),
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
      if (m.continued) input.continued = true;
      return log.commit(input);
    },
    result: (id, content, isError, chainId) =>
      log.result(id, toResultBlocks(content), isError, chainId === undefined ? undefined : { chainUuid: chainId }),
    saveImages: (images) => saveResultImages(ctx, images),
    closeStep: () => log.closeStep(),
    approvalAsked: (info) => log.approvalAsked(info),
    approvalDecided: (id, outcome) => log.approvalDecided(id, outcome),
    trigger: (text, items) => log.trigger(text, WAKE_SOURCE_KIND, items),
  };
}

/** A user-content image or file the agent cannot be given; the turn ends with this error. */
export class AttachmentInputError extends Error {
  override readonly name = 'AttachmentInputError';
}

const hasImage = (m: DshUserMessage): boolean => m.content.some((b) => b.type === 'image');

function attachmentName(ref: unknown): string {
  const n = (ref as { name?: unknown } | undefined)?.name;
  return typeof n === 'string' && n !== '' ? `"${n}"` : 'a file';
}

/**
 * Human text and attachments → backend input, in part order (D22, D23). `images` holds the bytes of
 * each image part, read first by {@link readImages}. Files go as their host path; the backend turns
 * that into its own attach form. Nothing is added that the user did not type or attach.
 */
function buildInput(
  factory: AgentBackendFactory,
  m: DshUserMessage,
  ctx: CordisContext,
  images: ReadonlyArray<{ mediaType: string; base64: string }> = [],
): UserInput {
  const parts: UserInput['parts'] = [];
  const store = ctx.get('attachments') as DshAttachments | undefined;
  let k = 0;
  for (const b of m.content) {
    if (b.type === 'text' && typeof b.text === 'string') parts.push({ type: 'text', text: b.text });
    else if (b.type === 'file') {
      const path = typeof store?.fileHostPath === 'function' ? store.fileHostPath(b.attachment) : undefined;
      if (path === undefined || path === '')
        throw new AttachmentInputError(
          `${attachmentName(b.attachment)} has no local copy on this host, so ${factory.displayName} cannot read it`,
        );
      parts.push({ type: 'file', hostPath: path });
    } else if (b.type === 'image') {
      const image = images[k++];
      if (image === undefined) throw new AttachmentInputError('an attached image was not read');
      parts.push({ type: 'image', mediaType: image.mediaType, base64: image.base64 });
    }
  }
  return { id: factory.inputIdFor?.(m.id) ?? m.id, parts };
}

/** Read the bytes of every image part (`ctx.attachments.readImage`, D23), in part order. */
async function readImages(
  m: DshUserMessage,
  ctx: CordisContext,
  signal?: AbortSignal,
): Promise<Array<{ mediaType: string; base64: string }>> {
  const blocks = m.content.filter((b) => b.type === 'image');
  if (blocks.length === 0) return [];
  const store = ctx.get('attachments') as DshAttachments | undefined;
  if (typeof store?.readImage !== 'function')
    throw new AttachmentInputError('an image is attached, but no attachment store is mounted');
  const out: Array<{ mediaType: string; base64: string }> = [];
  for (const b of blocks) {
    // An `offloaded` image is a DSH request-size decision for DSH routes; the bytes are still stored.
    let stored: Awaited<ReturnType<NonNullable<DshAttachments['readImage']>>>;
    try {
      stored = await store.readImage(b.attachment, signal);
    } catch (error) {
      throw new AttachmentInputError(
        `an attached image could not be read: ${String((error as Error)?.message ?? error)}`,
        {
          cause: error,
        },
      );
    }
    const ref = (b.attachment ?? {}) as { mediaType?: unknown };
    const mediaType = stored.ref?.mediaType ?? (typeof ref.mediaType === 'string' ? ref.mediaType : undefined);
    if (mediaType === undefined) throw new AttachmentInputError('an attached image has no media type');
    out.push({ mediaType, base64: Buffer.from(stored.data).toString('base64') });
  }
  return out;
}

/** One human message → backend input (D22, D23), reading image bytes first. */
export async function toInput(
  factory: AgentBackendFactory,
  m: DshUserMessage,
  ctx: CordisContext,
  signal?: AbortSignal,
): Promise<UserInput> {
  return buildInput(factory, m, ctx, await readImages(m, ctx, signal));
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
    if (typeof b.mode === 'string' && b.mode !== '') out.mode = b.mode; // D24
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
  /** The registry this mount uses: the Host entry's (D87) or its own. */
  readonly registry: SessionRegistry;
  /** Whether the registry is the Host entry's shared one. */
  readonly shared: boolean;
  /** The runtime of one host session (tests and services). */
  runtime(hostSessionId: string): SessionRuntime | undefined;
}

/** The plain text of a message (D25: what goes back into the composer). */
function messageText(m: DshUserMessage): string {
  return m.content
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** The Host entry's registry, if it serves this context (D87). */
function hostRegistry(ctx: CordisContext): SessionRegistry | undefined {
  try {
    const r = ctx.get(SESSIONS_SERVICE);
    return isSessionRegistry(r) ? r : undefined;
  } catch {
    return undefined;
  }
}

/** Mount the driver, the guard, the job controller and the re-wake in a preset-scoped context. */
export function mountAgent(ctx: CordisContext, o: AgentMountOptions): AgentMount {
  const factory = o.factory;
  const shared = o.registry ?? hostRegistry(ctx);
  const registry = shared ?? new SessionRegistry();
  const mine = new Set<string>();
  const counters = new WeakMap<DshAgent, { revision: number; attempt: number }>();
  const warn = (note: string, detail?: unknown) => ctx.logger?.warn(`[raw-agent] ${note}`, detail ?? '');
  const jobs = () => ctx.get('jobs') as DshJobs | undefined;
  const presetId = o.presetId ?? presetIdFor(factory.kind);

  // D47: our own scoped controller; this context serves exactly the agents of our preset.
  const j = jobs();
  if (j) ctx.effect(() => j.attachController('raw-agent'), 'raw-agent: job controller');

  const portFor = (agent: DshAgent): HostSessionPort => ({
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
    // D36: session-only. `agent.model.select` records `model/selection` and never saves the host
    // default (DSH's `session.selectModel` would, K1).
    selectModel(model) {
      agent.model.select({ provider: factory.kind, model });
    },
    startJob(task, stop, onTeardown) {
      const registry = jobs();
      return registry ? startJob(registry, agent.session.id, task, stop, warn, onTeardown) : undefined;
    },
    // D45: child agents become one-shot host child sessions of this session.
    createChild: (spec, runner) =>
      createChildSession(
        ctx,
        agent,
        { factory, presetId, warn, ...(o.writer ? { writer: o.writer } : {}) },
        spec,
        runner,
      ),
    // D48: native workflow records in this (the parent) session; no DSH workflow call (R2.4).
    recordWorkflow: (record) => appendWorkflowRecord(agent.session, record),
    openWorkflowRuns: () => openWorkflowRuns(agent.session),
    warn,
    returnDraft(messageId) {
      // D25: the steer goes back to the composer; the recorded `outcome: 'canceled'` is the truth.
      const m = [...agent.inbox.nextStep, ...agent.inbox.nextTurn].find((x) => x.id === messageId);
      try {
        agent.inbox.remove?.(messageId);
      } catch (error) {
        warn('could not remove a cancelled steer from the inbox', String(error));
      }
      const draft: ReturnedDraft = { messageId, text: m ? messageText(m) : '', at: Date.now() };
      const attachments = m ? m.content.filter((b) => b.type !== 'text').length : 0;
      if (attachments > 0) draft.attachments = attachments;
      registry.noteDraft(agent.session.id, draft);
      ctx.emit('raw-agent/draft-returned', { sessionId: agent.session.id, ...draft });
    },
    notify(state) {
      ctx.emit('raw-agent/state', { sessionId: agent.session.id, state });
    },
  });

  const runtimeFor = (agent: DshAgent): SessionRuntime => {
    const existing = registry.get(agent.id, factory.kind) as SessionRuntime | undefined;
    if (existing) {
      if (!mine.has(agent.id)) {
        // D87: the agent was evicted and is open again; the process kept running.
        existing.attach(portFor(agent));
        mine.add(agent.id);
        shadowPermission(agent);
      }
      return existing;
    }
    const opts: ConstructorParameters<typeof SessionRuntime>[2] = { env: o.env ?? process.env };
    if (o.stopGraceMs !== undefined) opts.stopGraceMs = o.stopGraceMs;
    const userConfig = o.userConfig ?? shared?.userConfig;
    if (userConfig) opts.userConfig = userConfig;
    const r = new SessionRuntime(factory, portFor(agent), opts);
    registry.set(agent.id, factory.kind, r);
    mine.add(agent.id);
    shadowPermission(agent);
    return r;
  };

  // R1.4 leftover (CLAUDE.md §4): DSH's `/permission` changes DSH's preset, which this agent
  // ignores. A command registered under the agent's own context shadows the global one for that
  // agent only (`P/dsh-commands/lib/index.js:89, 207-208`: "for a per-agent variant, mount a
  // command-injected plugin under that agent's agent.ctx"). It shows and switches the agent's real
  // mode instead. Standard sessions keep DSH's command. Live scope behaviour is **unverified**.
  const shadows = new Map<string, unknown>();
  function shadowPermission(agent: DshAgent): void {
    if (o.modeCommand === false || shadows.has(agent.id)) return;
    const actx = agent.ctx as CordisContext | undefined;
    if (typeof actx?.inject !== 'function') return;
    const register = (c: CordisContext) => {
      const commands = c.get('commands') as DshCommands | undefined;
      if (typeof commands?.register !== 'function') return;
      try {
        commands.register({
          name: PERMISSION_COMMAND,
          description: modeCommandDescription(factory),
          input: { hint: '<mode>' },
          handler: ({ agent: a, rawInput }) =>
            runModeCommand(
              registry.get(a.id, factory.kind) as SessionRuntime | undefined,
              factory,
              typeof rawInput === 'string' ? rawInput : '',
            ),
        });
      } catch (error) {
        warn('could not shadow /permission in this session', String((error as Error)?.message ?? error));
      }
    };
    try {
      shadows.set(agent.id, actx.inject(['commands'], register));
    } catch (error) {
      warn('could not shadow /permission in this session', String(error));
    }
  }
  function unshadowPermission(agentId: string): void {
    const handle = shadows.get(agentId);
    shadows.delete(agentId);
    try {
      if (typeof handle === 'function') (handle as () => void)();
      else (handle as { dispose?: () => void } | undefined)?.dispose?.();
    } catch (error) {
      warn('could not remove the /permission shadow', String(error));
    }
  }

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
    // D45: a child session never spawns or sends. A live child runs its writer; a cold one nothing.
    if (agent.session.header.origin === 'subagent') return (await childPreStep(p)) ?? { kind: 'enter', messages: [] };
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
    let userInputs: UserInput[];
    try {
      userInputs = await Promise.all(human.map((m) => toInput(factory, m, ctx, signal)));
    } catch (error) {
      // The message stays in the log as typed; the turn ends with a clear error and nothing is sent.
      log.close();
      throw new Error(
        `${factory.displayName} was not sent this message: ${String((error as Error)?.message ?? error)}`,
        {
          cause: error,
        },
      );
    }
    const outcome = await runtime.runTurn(sinkFor(log, agent, ctx), { userInputs, wake }, signal);
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
    try {
      spliceInbox(agent.session, agent.inbox, { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
    } catch (error) {
      warn('refused the re-wake splice', String(error));
      return;
    }
    try {
      agent.send(message, 'next-turn', true);
    } catch (error) {
      // Never lose the user's message: put it back where it was, so DSH runs it at the next turn.
      warn('the re-wake send failed; the message stays queued', String(error));
      try {
        spliceInbox(agent.session, agent.inbox, {
          target: 'next-turn',
          start: 0,
          removedCount: 0,
          inserted: [message],
        });
      } catch (again) {
        warn('could not put the queued message back', String(again));
      }
    }
  }) as never);

  // D27: a human message typed into the running turn lands in `nextStep`; send it at once.
  ctx.on('agent/inbox/inserted', ((p: { agent: DshAgent; message: DshUserMessage }) => {
    const { agent, message } = p;
    if (!agent || !message || agent.session.header.origin === 'subagent') return;
    // Only typed human text (r3). inject()ed DSH notices share the lane and are dropped at the claim (D22).
    if (message.source.kind !== 'user') return;
    // 'queue': the backend takes no mid-turn input; the message waits for DSH's next turn.
    if (factory.staticCapabilities.steer === 'queue') return;
    if (!agent.inbox.nextStep.some((m) => m.id === message.id)) return;
    const runtime = registry.get(agent.id, factory.kind) as SessionRuntime | undefined;
    if (!runtime) return;
    // Text and files are ready at once; image bytes are read first (D23). A steer that cannot be
    // built stays in `nextStep`, so DSH claims it at the next turn, which then reports the error.
    if (!hasImage(message)) {
      try {
        runtime.steer(message.id, buildInput(factory, message, ctx));
      } catch (error) {
        warn('could not send a steer', String(error));
      }
      return;
    }
    toInput(factory, message, ctx).then(
      (input) => runtime.steer(message.id, input),
      (error) => warn('could not send a steer', String(error)),
    );
  }) as never);

  // Attach a runtime (no process) as soon as the agent exists, so "Start" works before a message (D4).
  ctx.on('agent/created', ((p: { agent: DshAgent }) => {
    if (p.agent?.session.header.origin === 'subagent') return;
    try {
      runtimeFor(p.agent);
    } catch (error) {
      warn('could not attach the session runtime', String(error));
    }
    return undefined;
  }) as never);

  // D76: image admission on turn 1 reads the current model; record our `settings` row.
  // The route the agent had before our automatic row, per agent, so a switch away can restore it.
  const routeBefore = new Map<string, { provider: string; model: string }>();
  const lastSelection = (agent: DshAgent): { provider?: unknown; model?: unknown } | undefined => {
    const events = agent.session.snapshotEvents();
    for (let i = events.length - 1; i >= 0; i--)
      if (events[i]!.type === 'model/selection') return events[i]!.data as { provider?: unknown; model?: unknown };
    return undefined;
  };
  const recordSettingsModel = (agent: DshAgent) => {
    if (!o.selectSettingsModel || agent.session.header.isSeeded) return;
    // A choice for our provider made on the new-task page is already in the log; never overwrite it.
    if (lastSelection(agent)?.provider === factory.kind) return;
    try {
      const before = agent.model.current() as { provider?: unknown; model?: unknown } | undefined;
      if (typeof before?.provider === 'string' && typeof before.model === 'string' && before.provider !== factory.kind)
        routeBefore.set(agent.id, { provider: before.provider, model: before.model });
      agent.model.select({ provider: factory.kind, model: 'settings' });
    } catch (error) {
      warn('could not record the settings model selection', String(error));
    }
  };
  ctx.on('agent/created', ((p: { agent: DshAgent; source: string }) => {
    if (p.source === 'startup') recordSettingsModel(p.agent);
    return undefined;
  }) as never);

  // A blank session created under another preset and then switched to ours (DSH's new-task page
  // creates a Standard agent, then `agentPresets.select` rebinds it) never announces
  // `agent/created` to this mount. The rebind emits `tools/change`
  // (`P/dsh-agent-preset-registry/lib/index.js` `recompose`); attach every live root agent now
  // bound to our preset, so the controls and "Start" work before the first message (D4).
  const adoptRebound = () => {
    let agents: readonly DshAgent[];
    let presets: DshAgentPresets | undefined;
    try {
      agents = (ctx.get('agents') as DshAgentsService | undefined)?.list?.() ?? [];
      presets = ctx.get('agentPresets') as DshAgentPresets | undefined;
    } catch {
      return;
    }
    if (typeof presets?.composedPreset !== 'function') return;
    for (const agent of agents) {
      if (agent.session.header.origin === 'subagent' || agent.ctx === undefined) continue;
      let bound: string | undefined;
      try {
        bound = presets.composedPreset(agent.ctx);
      } catch {
        continue;
      }
      if (mine.has(agent.id)) {
        if (bound !== undefined && bound !== presetId) leaveRebound(agent);
        continue;
      }
      if (bound !== presetId) continue;
      try {
        runtimeFor(agent);
        recordSettingsModel(agent);
      } catch (error) {
        warn('could not attach the session runtime', String(error));
      }
    }
  };
  // The user switched a blank session from our preset to another one before its first turn
  // (M1 live: the new-task page remembered our preset, the user picked Standard). Our automatic
  // `settings` row would route the other preset's turn to our provider ("This model only works in
  // Claude Code sessions"), so restore the route it had, and stop showing our controls. A session
  // that already ran a turn or a process is left alone.
  function leaveRebound(agent: DshAgent): void {
    const runtime = registry.get(agent.id, factory.kind) as SessionRuntime | undefined;
    if (runtime?.backend !== undefined) return;
    if (agent.session.snapshotEvents().some((e) => e.type === 'turn/start')) return;
    const last = lastSelection(agent);
    const before = routeBefore.get(agent.id);
    if (before && last?.provider === factory.kind && last.model === 'settings') {
      try {
        agent.model.select(before);
      } catch (error) {
        warn('could not restore the model route', String(error));
      }
    }
    routeBefore.delete(agent.id);
    mine.delete(agent.id);
    unshadowPermission(agent.id);
    void registry.delete(agent.id);
  }

  ctx.on('tools/change', (() => {
    adoptRebound();
    return undefined;
  }) as never);

  // D87: with the Host registry, an agent dispose (eviction) only detaches; the process and its
  // background tasks keep running. Without it, the process ends with the agent (D75).
  const release = (id: string) => {
    shadows.delete(id); // the agent's own context disposes the command with it
    if (!mine.delete(id)) return;
    if (shared) (registry.get(id, factory.kind) as SessionRuntime | undefined)?.detach();
    else void registry.delete(id);
  };
  ctx.on('agent/disposed', ((p: { agent: DshAgent }) => release(p.agent.id)) as never);
  ctx.effect(
    () => () => {
      for (const id of [...mine]) release(id);
    },
    'raw-agent: backend sessions',
  );

  return {
    registry,
    shared: shared !== undefined,
    runtime: (id) => registry.get(id, factory.kind) as SessionRuntime | undefined,
  };
}
