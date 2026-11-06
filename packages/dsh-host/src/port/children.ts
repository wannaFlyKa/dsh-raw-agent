// Host child sessions (D45, D68, D74): the DSH side of the live-child registry in ../children.ts.
//
// Each child agent is a one-shot DSH child session, made the way DSH's own local spawn records
// one (`P/dsh-subagent/lib/index.js:345-358, 573-660, 816-825`; dsh-seams R2.1):
// - `ctx.agents.create({sessionId, parentAgent, meta: {parentSession, origin: 'subagent',
//   delegationDepth, isSeeded: false, cwd, agentPreset}, agentOptions: {provider, model}, setup})`;
// - `setup` mounts only the `prepend` guard (D2) and the child writer (a pre-step listener). Nothing
//   in a child can spawn or send (D45);
// - the child log starts with `subagent/descriptor` v3 `one-shot` and `agent-preset/selected`;
// - the parent log gets one `subagent/catalog` v0 `one-shot` row (not relationship-checked, so it
//   may sit inside the parent's open step; a duplicate child id is refused on load, so one row per
//   child, never again for a woken teammate);
// - each child turn opens with `child.followup(<text>)` (`source.kind: 'user'`, as DSH's own spawn
//   labels a task prompt, `:1467`); the child writer writes it unchanged, then the child's steps.
//
// The live-child lookup is module-level: when our preset is also mounted on a child (its header
// names our preset), that mount's pre-step finds the same writer here; a cold-resumed child has no
// entry and writes nothing (D45).

import { randomUUID } from 'node:crypto';
import type { AgentBackendFactory, ContentBlock } from '@dsh-raw-agent/core';
import type { ChildHandle, ChildRunner, ChildSpec } from '../children.js';
import type { TurnSink } from '../driver.js';
import { SETTINGS_MODEL } from './catalog.js';
import type { CordisContext, DshAgent, PreStepDecision, PreStepPayload } from './types.js';
import { TurnLog, type LiveChannel, type LiveFrame, type WriterOptions } from './writer.js';

/** The part of DSH's agent registry the child port uses (`P/dsh-agent/lib/types/index.d.ts:49-101`). */
interface DshAgentFactory {
  create(options: {
    sessionId: string;
    parentAgent?: DshAgent;
    meta?: Record<string, unknown>;
    agentOptions?: { provider: string; model: string };
    setup?: (ctx: CordisContext, agent: DshAgent) => unknown;
  }): Promise<{ agent: DshAgent; dispose(): Promise<void> }>;
}

const ENTER: PreStepDecision = { kind: 'enter', messages: [] };

/** Child session id → its writer. Shared by every mount of this bundle (see the header). */
const LIVE_CHILDREN = new Map<string, (p: PreStepPayload) => Promise<PreStepDecision>>();

/** Run the live child writer of this child session, if there is one (D45). */
export function childPreStep(p: PreStepPayload): Promise<PreStepDecision> | undefined {
  return LIVE_CHILDREN.get(p.agent.session.id)?.(p);
}

/** How many child sessions have a live writer (tests). */
export function liveChildCount(): number {
  return LIVE_CHILDREN.size;
}

export interface ChildPortOptions {
  factory: AgentBackendFactory;
  presetId: string;
  warn: (note: string, detail?: unknown) => void;
  writer?: Partial<WriterOptions>;
}

/** D2: the guard, outermost in the child too, so no Host listener reaches a DSH model. */
async function guard(_p: PreStepPayload, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> {
  const d = await next();
  return d.kind === 'reject' ? d : ENTER;
}

/**
 * D68: a child's live channel carries no stream chunks: child messages arrive whole, so the only
 * frames are a step's `start` and its `end`. No deltas over a near-zero time, so no tok/s.
 */
function childChannel(ctx: CordisContext, agent: DshAgent): LiveChannel {
  let revision = 0;
  let attempt = 0;
  return {
    emit: (frame: LiveFrame) => {
      if (frame.type !== 'chunk') ctx.emit('agent/assistant-stream', { agent, frame });
    },
    nextRevision: () => ++revision,
    nextAttemptId: () => `${agent.session.id}:raw-child-${++attempt}`,
  };
}

function childSink(log: TurnLog): TurnSink {
  return {
    get stepOpen() {
      return log.stepOpen;
    },
    get hasMessage() {
      return log.hasMessage;
    },
    get openCallIds() {
      return log.openCallIds;
    },
    hasCall: (id) => log.hasCall(id),
    openStep: () => log.openStep(),
    delta: () => {}, // D68: none for children
    commit: (m) => {
      const input: Parameters<TurnLog['commit']>[0] = {
        blocks: m.blocks.map((b: ContentBlock) => (b.type === 'reasoning' ? { type: 'reasoning', text: b.text } : b)),
        binding: m.binding,
      };
      // D68: never usage on a child step.
      if (m.model) input.model = m.model;
      if (m.continued) input.continued = true;
      return log.commit(input);
    },
    result: (id, content, isError, chainId) =>
      log.result(
        id,
        content.map((c) =>
          c.type === 'text'
            ? { type: 'text', text: c.text }
            : c.type === 'saved-image'
              ? { type: 'image', attachment: c.ref }
              : { type: 'text', text: c.type === 'image' ? '[image]' : JSON.stringify(c.value) },
        ),
        isError,
        chainId === undefined ? undefined : { chainUuid: chainId },
      ),
    closeStep: () => log.closeStep(),
    claim: () => false, // a child has no steers (D45)
    approvalAsked: (info) => log.approvalAsked(info),
    approvalDecided: (id, outcome) => log.approvalDecided(id, outcome),
  };
}

/** The child writer: one pre-step that writes the claimed text, then the child's own turn. */
function childWriter(
  ctx: CordisContext,
  o: ChildPortOptions,
  runner: ChildRunner,
): (p: PreStepPayload) => Promise<PreStepDecision> {
  return async (p) => {
    const { agent, messages, turn, signal } = p;
    if (messages.length === 0) return ENTER;
    const log = new TurnLog(agent.session, childChannel(ctx, agent), turn, {
      provider: o.factory.kind,
      warn: o.warn,
      ...o.writer,
    });
    // The task prompt (or the message that woke a teammate), unchanged. Nothing is ever sent.
    for (const m of messages) if (m.source.kind === 'user') log.writeUser(m);
    let outcome: Awaited<ReturnType<ChildRunner>>;
    try {
      outcome = await runner(childSink(log), signal);
    } finally {
      log.close(); // D74: every open step closed, open asks cancelled, before turn/end
    }
    if (outcome.kind === 'error') throw new Error(outcome.message);
    if (outcome.kind === 'stopped' && !signal.aborted) {
      // The loop writes `turn/end aborted` only for an aborted turn signal (`P/dsh-agent-loop/lib/index.js:800-806`).
      try {
        (agent as DshAgent & { cancel?(c: { kind: string }, o?: { keepInbox?: boolean }): void }).cancel?.(
          { kind: outcome.cause },
          { keepInbox: true },
        );
      } catch (error) {
        o.warn('could not mark the child turn stopped', String(error));
      }
    }
    signal.throwIfAborted();
    return ENTER;
  };
}

/** Create one host child session under `parent` (D45). Resolves after the parent's catalog row. */
export async function createChildSession(
  ctx: CordisContext,
  parent: DshAgent,
  o: ChildPortOptions,
  spec: ChildSpec,
  runner: ChildRunner,
): Promise<ChildHandle> {
  const agents = ctx.get('agents') as Partial<DshAgentFactory> | undefined;
  if (typeof agents?.create !== 'function') throw new Error('the host has no agent registry');
  const sessionId = `session-${randomUUID()}`;
  const header = parent.session.header;
  const depth = (typeof header.delegationDepth === 'number' ? header.delegationDepth : 0) + 1;
  const meta: Record<string, unknown> = {
    parentSession: parent.session.id,
    isSeeded: false,
    origin: 'subagent',
    delegationDepth: depth,
    agentPreset: o.presetId,
  };
  if (header.cwd !== undefined) meta.cwd = header.cwd;
  const write = childWriter(ctx, o, runner);
  const handle = await agents.create({
    sessionId,
    parentAgent: parent,
    meta,
    agentOptions: { provider: o.factory.kind, model: SETTINGS_MODEL },
    setup: (cctx, child) => {
      const descriptor: Record<string, unknown> = { version: 3, mode: 'one-shot', provider: o.factory.kind };
      descriptor.label = spec.label;
      child.session.append('subagent/descriptor', descriptor);
      child.session.append('agent-preset/selected', { agentPreset: o.presetId });
      cctx.on('agent/pre-step', guard as never, { prepend: true });
      cctx.on('agent/pre-step', ((p: PreStepPayload) => write(p)) as never);
    },
  });
  LIVE_CHILDREN.set(sessionId, write);
  try {
    parent.session.append('subagent/catalog', {
      version: 0,
      childId: sessionId,
      childCreatedAt: handle.agent.session.header.createdAt,
      mode: 'one-shot',
      label: spec.label,
    });
  } catch (error) {
    o.warn('could not list the child in its parent', String((error as Error)?.message ?? error));
  }
  let disposed = false;
  return {
    hostSessionId: sessionId,
    begin(prompt) {
      const child = handle.agent as DshAgent & { whenIdle?(): Promise<void> };
      const open = () =>
        child.followup({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'user' },
        });
      // A follow-up sent while the previous child turn still winds down would wait in the inbox
      // with no wake (the D3 stall), so a woken teammate's turn opens once the child is idle.
      if (child.status === 'running' && typeof child.whenIdle === 'function')
        void child.whenIdle().then(open, (error: unknown) => o.warn('could not open a child turn', String(error)));
      else open();
    },
    createChild: (s, r) => createChildSession(ctx, handle.agent, o, s, r),
    async dispose() {
      if (disposed) return;
      disposed = true;
      LIVE_CHILDREN.delete(sessionId);
      await handle.dispose().catch((error: unknown) => o.warn('could not release a child session', String(error)));
    },
  };
}
