// One live Claude Code session: a persistent SDK `query()` in streaming-input mode (D4).
// Stop is `interrupt()` only (rule 6); the process ends only on forceStop or dispose.

import { randomUUID } from 'node:crypto';
import {
  AsyncQueue,
  SentInputTracker,
  type AgentBackendSession,
  type BackendCapabilities,
  type BackendControls,
  type BackendEvent,
  type ContextUsage,
  type UserInput,
} from '@dsh-raw-agent/core';
import { ClaudeMessageMapper } from './mapper.js';
import type { Options, Query, SDKUserMessage } from './sdk.js';
import { planChoices } from './interactions.js';
import { withSdkVersionEnvRestored } from './env.js';

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

export interface ClaudeSessionInit {
  kind: string;
  sessionId: string;
  startedAs: AgentBackendSession['startedAs'];
  options: Options;
  queryFn: QueryFn;
  canBypass: boolean;
  /** Called once the CLI has died, so the factory can clean up its process group (D8). */
  onExit?: (error?: string) => void;
  /** Kills the CLI's process group (force stop). */
  killGroup?: () => void;
  now?: () => number;
  debug?: (note: string, detail: unknown) => void;
}

/** `@"<path>"` is the TUI's own attach mechanism (D23). */
export function fileReference(hostPath: string): string {
  return `@"${hostPath}"`;
}

/** Build the SDK user message for one input (D23, D27). */
export function toSdkUserMessage(input: UserInput, mode: 'next' | 'queue'): SDKUserMessage {
  const content: Array<Record<string, unknown>> = [];
  let text = '';
  const flushText = () => {
    if (text !== '') content.push({ type: 'text', text });
    text = '';
  };
  for (const part of input.parts) {
    if (part.type === 'text') text += part.text;
    else if (part.type === 'file')
      text += (text === '' || text.endsWith(' ') ? '' : ' ') + fileReference(part.hostPath);
    else {
      flushText();
      content.push({ type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.base64 } });
    }
  }
  flushText();
  const msg: Record<string, unknown> = {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    uuid: input.id,
    origin: { kind: 'human' },
  };
  if (mode === 'next') msg.priority = 'next'; // never 'now' (D27)
  return msg as unknown as SDKUserMessage;
}

type Loose = Record<string, unknown>;

/** Call an optional control; `undefined` when this CLI or SDK lacks it (D9). */
async function optionalControl<T>(q: Query, name: string, ...args: unknown[]): Promise<T | undefined> {
  const fn = (q as unknown as Loose)[name];
  if (typeof fn !== 'function') return undefined;
  try {
    return (await (fn as (...a: unknown[]) => Promise<T>).apply(q, args)) as T;
  } catch (e) {
    if (/Unsupported control request subtype/.test(String((e as Error)?.message ?? e))) return undefined;
    throw e;
  }
}

export class ClaudeBackendSession implements AgentBackendSession {
  readonly kind: string;
  readonly startedAs: AgentBackendSession['startedAs'];
  readonly capabilities: BackendCapabilities;
  readonly controls: BackendControls;

  #sessionId: string;
  readonly #input = new AsyncQueue<SDKUserMessage>();
  readonly #events = new AsyncQueue<BackendEvent>();
  readonly #tracker = new SentInputTracker();
  readonly #mapper: ClaudeMessageMapper;
  readonly #query: Query;
  readonly #init: ClaudeSessionInit;
  #cliVersion: string | undefined;
  #exited = false;
  readonly #pump: Promise<void>;

  constructor(init: ClaudeSessionInit) {
    this.#init = init;
    this.kind = init.kind;
    this.#sessionId = init.sessionId;
    this.startedAs = init.startedAs;
    const mapperOpts: ConstructorParameters<typeof ClaudeMessageMapper>[1] = {};
    if (init.now) mapperOpts.now = init.now;
    if (init.debug) mapperOpts.debug = init.debug;
    this.#mapper = new ClaudeMessageMapper(this.#tracker, mapperOpts);
    this.capabilities = {
      perTaskStop: true,
      sideQuestions: false,
      workflows: false,
      teamMessaging: false,
      cancelQueued: true,
      fileRewind: init.options.enableFileCheckpointing === true,
      planChoices: planChoices(init.canBypass),
      toolViewPack: init.kind,
    };
    this.#query = withSdkVersionEnvRestored(() => init.queryFn({ prompt: this.#input, options: init.options }));
    this.controls = this.#makeControls();
    this.#pump = this.#run();
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get cliVersion(): string | undefined {
    return this.#cliVersion;
  }

  events(): AsyncIterable<BackendEvent> {
    return this.#events;
  }

  async #run(): Promise<void> {
    let error: string | undefined;
    try {
      for await (const msg of this.#query) {
        const m = msg as unknown as Loose;
        if (m.type === 'system' && m.subtype === 'init' && typeof m.claude_code_version === 'string') {
          this.#cliVersion = m.claude_code_version;
          this.capabilities.backendVersion = m.claude_code_version;
        }
        if (m.type === 'system' && m.subtype === 'conversation_reset' && typeof m.new_conversation_id === 'string') {
          this.#sessionId = m.new_conversation_id; // D70; the event itself is mapped in a later milestone
        }
        for (const e of this.#mapper.map(msg)) this.#events.push(e);
      }
    } catch (e) {
      error = String((e as Error)?.message ?? e);
    }
    this.#exited = true;
    for (const e of this.#mapper.exit(error)) this.#events.push(e);
    this.#events.end();
    this.#input.end();
    this.#init.onExit?.(error);
  }

  async send(input: UserInput, mode: 'next' | 'queue'): Promise<void> {
    if (this.#exited) throw new Error('Claude Code is not running');
    this.#tracker.sent(input.id);
    this.#input.push(toSdkUserMessage(input, mode));
  }

  async interrupt(opts?: { cancelQueued?: boolean }): Promise<{ cancelledInputIds: string[] }> {
    if (this.#exited) return { cancelledInputIds: [] };
    this.#mapper.noteInterruptRequested();
    const call = this.#query.interrupt as unknown as (o?: { cancelQueued?: boolean }) => Promise<unknown>;
    const receipt = (await call.call(this.#query, opts?.cancelQueued ? { cancelQueued: true } : undefined)) as
      { still_queued?: string[]; cancelled?: string[] } | undefined;
    const cancelled = Array.isArray(receipt?.cancelled) ? receipt.cancelled : [];
    return { cancelledInputIds: this.#tracker.cancel(cancelled) };
  }

  async forceStop(): Promise<void> {
    this.#input.end();
    this.#query.close();
    this.#init.killGroup?.();
    await this.#pump;
  }

  async dispose(): Promise<void> {
    this.#input.end();
    this.#query.close();
    await this.#pump;
  }

  #makeControls(): BackendControls {
    const q = this.#query;
    return {
      stopTask: async (taskId) => {
        await q.stopTask(taskId);
      },
      setPermissionMode: async (mode) => {
        await q.setPermissionMode(mode as Parameters<Query['setPermissionMode']>[0]);
      },
      setModel: async (model) => {
        await q.setModel(model); // never undefined (D35)
      },
      setEffort: async (effortId) => {
        const flags: Loose =
          effortId === 'ultracode'
            ? { effortLevel: 'xhigh', ultracode: true }
            : { effortLevel: effortId, ultracode: null };
        await (q.applyFlagSettings as unknown as (s: Loose) => Promise<void>).call(q, flags);
      },
      models: async () => {
        const list = await q.supportedModels();
        return list.map((m) => {
          const info: { value: string; displayName: string; description?: string; efforts?: string[] } = {
            value: m.value,
            displayName: m.displayName,
          };
          if (m.description) info.description = m.description;
          const efforts = (m as unknown as Loose).supportedEffortLevels;
          if (Array.isArray(efforts)) info.efforts = efforts.map(String);
          return info;
        });
      },
      agents: async () => {
        const list = await q.supportedAgents();
        return list.map((a) => (a.description ? { name: a.name, description: a.description } : { name: a.name }));
      },
      commands: async () => {
        const list = await q.supportedCommands();
        return list.map((c) => {
          const info: { name: string; description?: string; argumentHint?: string } = { name: c.name };
          if (c.description) info.description = c.description;
          if (c.argumentHint) info.argumentHint = c.argumentHint;
          return info;
        });
      },
      contextUsage: async (detail) => {
        const r = (await optionalControl<Loose>(q, 'getContextUsage', { detail })) ?? {};
        const used = typeof r.totalTokens === 'number' ? r.totalTokens : 0;
        const window = typeof r.maxTokens === 'number' ? r.maxTokens : 0;
        const out: ContextUsage = { used, window };
        if (typeof r.autoCompactThreshold === 'number') out.autoCompactAt = r.autoCompactThreshold;
        return out;
      },
    };
  }
}

export const newRequestId = (): string => randomUUID();
