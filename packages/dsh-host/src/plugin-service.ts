// The Host service `rawAgent` for other DSH plugins (R9.2, D66, architecture §7.3). DSH-neutral:
// the port (./port/services.ts) provides it and gives the DSH agent operations.
//
// - `sessionInfo` and `onEvent` read the registry runtime only; they never start a process.
// - `interrupt` is DSH's own Stop (`cancel` keeping the inbox): the process and its background
//   tasks keep running (rule 6).
// - `send`, `steer` and `askSideQuestion` need a grant token (./grants.ts). A granted message goes
//   into the DSH inbox with `source.kind: 'raw-agent-plugin'` and the grant label, and is admitted
//   in the registry, so the agent mount forwards it (D22, D27). It is written to the log unchanged.
// - Approvals and answers are never exposed: an ask shows only its id, kind, title and time.

import {
  PLUGIN_SOURCE_KIND,
  PLUGIN_TEXT_MAX,
  PublicEventTracker,
  RAW_AGENT_API_VERSION,
  RawAgentServiceError,
  sessionInfoFromView,
  type AgentBackendFactory,
  type PublicViewInput,
  type RawAgentBackendInfo,
  type RawAgentPublicEvent,
  type RawAgentService,
  type RawAgentSessionInfo,
} from '@dsh-raw-agent/core';
import { SIDE_QUESTION_MAX } from './agent-commands.js';
import type { GrantRecord, GrantStore } from './grants.js';
import type { RegisteredRuntime, SessionRegistry } from './registry.js';

/** The message a granted plugin sends, as it goes into the DSH inbox and the log. */
export interface PluginMessage {
  id: string;
  role: 'user';
  content: Array<{ type: 'text'; text: string }>;
  source: { kind: typeof PLUGIN_SOURCE_KIND; grant: string; grantId: string };
}

/** The DSH agent operations of one session (the port maps them to DSH's agent). */
export interface PluginAgentOps {
  /** Queue as a new turn (DSH `followup`). */
  followup(message: PluginMessage): void;
  /** Into the running turn (DSH `steer`); starts a turn when idle. */
  steer(message: PluginMessage): void;
  /** DSH's Stop: cancel the running turn, keep the inbox. */
  cancel(): void;
}

export interface PluginServiceDeps {
  registry: SessionRegistry;
  factories: readonly AgentBackendFactory[];
  grants: GrantStore;
  /** The open DSH agent of one session, if any. */
  agent(sessionId: string): PluginAgentOps | undefined;
  newId?: () => string;
  warn?: (note: string, detail?: unknown) => void;
}

const fail = (code: RawAgentServiceError['code'], message: string) => new RawAgentServiceError(code, message);

/** The view parts the public API reads (the view is wire-safe JSON with the same field names). */
function publicView(runtime: RegisteredRuntime): PublicViewInput {
  return runtime.view() as unknown as PublicViewInput;
}

export function backendInfos(factories: readonly AgentBackendFactory[]): RawAgentBackendInfo[] {
  return factories.map((f) => ({ kind: f.kind, displayName: f.displayName }));
}

export function createRawAgentService(deps: PluginServiceDeps): RawAgentService {
  const { registry, factories, grants } = deps;
  const newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
  const backends = backendInfos(factories);
  const backendOf = (sessionId: string): RawAgentBackendInfo | undefined => {
    const kind = registry.kindOf(sessionId);
    return backends.find((b) => b.kind === kind);
  };

  const ours = (sessionId: unknown): { runtime: RegisteredRuntime; backend: RawAgentBackendInfo; id: string } => {
    if (typeof sessionId !== 'string' || sessionId === '') throw fail('not-our-session', 'missing session id');
    const runtime = registry.get(sessionId);
    const backend = backendOf(sessionId);
    if (!runtime || !backend) throw fail('not-our-session', 'not a session of this plugin');
    return { runtime, backend, id: sessionId };
  };

  const granted = (grant: unknown): GrantRecord => {
    if (grant === undefined || grant === null || grant === '')
      throw fail('no-grant', 'This call needs a grant token. The user creates one in the plugin access panel.');
    const record = grants.check(grant);
    if (!record) throw fail('bad-grant', 'The grant token is not valid (wrong, or revoked by the user).');
    return record;
  };

  const checkText = (text: unknown, max: number): string => {
    if (typeof text !== 'string') throw fail('empty', 'the text must be a string');
    if (text.trim() === '') throw fail('empty', 'the text is empty');
    if (text.length > max) throw fail('too-long', `the text is longer than ${max} characters`);
    return text;
  };

  const deliver = (mode: 'send' | 'steer', sessionId: string, text: unknown, grant: unknown) => {
    const { id } = ours(sessionId);
    const body = checkText(text, PLUGIN_TEXT_MAX);
    const record = granted(grant);
    const agent = deps.agent(id);
    if (!agent) throw fail('not-our-session', 'the session is not open in DSH');
    const message: PluginMessage = {
      id: newId(),
      role: 'user',
      content: [{ type: 'text', text: body }],
      source: { kind: PLUGIN_SOURCE_KIND, grant: record.label, grantId: record.id },
    };
    // Admit first: DSH may run the pre-step (and the steer listener) inside the inbox call.
    registry.admitPluginMessage(message.id, { grantId: record.id, label: record.label });
    try {
      if (mode === 'send') agent.followup(message);
      else agent.steer(message);
    } catch (error) {
      throw fail('failed', `DSH refused the message: ${String((error as Error)?.message ?? error)}`);
    }
    return { messageId: message.id };
  };

  const service: RawAgentService = {
    apiVersion: RAW_AGENT_API_VERSION as 1,
    backends,
    async sessionInfo(sessionId): Promise<RawAgentSessionInfo | undefined> {
      const runtime = typeof sessionId === 'string' ? registry.get(sessionId) : undefined;
      const backend = typeof sessionId === 'string' ? backendOf(sessionId) : undefined;
      if (!runtime || !backend) return undefined;
      return sessionInfoFromView(sessionId, backend, publicView(runtime));
    },
    async interrupt(sessionId) {
      const { id } = ours(sessionId);
      const agent = deps.agent(id);
      if (!agent) throw fail('not-our-session', 'the session is not open in DSH');
      try {
        agent.cancel();
      } catch (error) {
        throw fail('failed', `DSH refused the stop: ${String((error as Error)?.message ?? error)}`);
      }
    },
    onEvent(sessionId, listener) {
      let stopped = false;
      let offRuntime: (() => void) | undefined;
      let offAdded: (() => void) | undefined;
      let tracker: PublicEventTracker | undefined;
      const emit = (events: RawAgentPublicEvent[]) => {
        for (const e of events) {
          if (stopped) return;
          try {
            listener(e);
          } catch (error) {
            deps.warn?.('a plugin event listener failed', String(error));
          }
        }
      };
      const attach = (): boolean => {
        const runtime = registry.get(sessionId);
        const backend = backendOf(sessionId);
        if (!runtime || !backend || stopped) return false;
        tracker ??= new PublicEventTracker(sessionId, backend);
        const t = tracker;
        emit(t.update(publicView(runtime)));
        offRuntime = runtime.subscribe(
          (view) => emit(t.update(view as unknown as PublicViewInput)),
          () => {
            offRuntime?.();
            offRuntime = undefined;
            // The runtime ended; a new one for the same session (a later open) is followed again.
            if (registry.get(sessionId) && registry.get(sessionId) !== runtime) {
              attach();
              return;
            }
            emit(t.end());
            stop();
          },
        );
        return true;
      };
      const stop = () => {
        stopped = true;
        offRuntime?.();
        offAdded?.();
        offRuntime = undefined;
        offAdded = undefined;
      };
      if (typeof sessionId !== 'string' || sessionId === '') return () => {};
      if (!attach())
        offAdded = registry.onRuntime((id) => {
          if (id !== sessionId || offRuntime) return;
          if (attach()) {
            offAdded?.();
            offAdded = undefined;
          }
        });
      return stop;
    },
    send: async (sessionId, text, grant) => deliver('send', sessionId, text, grant),
    steer: async (sessionId, text, grant) => deliver('steer', sessionId, text, grant),
    async askSideQuestion(sessionId, question, grant) {
      const { runtime } = ours(sessionId);
      const q = checkText(question, SIDE_QUESTION_MAX);
      granted(grant);
      if (typeof runtime.askSideQuestion !== 'function')
        throw fail('unsupported', 'this session cannot answer side questions');
      // Rule 9: never start a process for a plugin. The user starts the agent.
      if (runtime.state().process !== 'running')
        throw fail('not-running', 'the agent is not running; the user must start it first');
      const r = await runtime.askSideQuestion(q);
      if (!r.ok) throw fail(r.code === 'busy' ? 'busy' : r.code === 'unsupported' ? 'unsupported' : 'failed', r.error);
      const entry = r.entry;
      if (entry.status === 'failed') throw fail('failed', entry.error ?? 'the side question failed');
      if (entry.status !== 'answered' || entry.synthetic) return null;
      return entry.answer ?? null;
    },
  };
  return Object.freeze(service);
}
