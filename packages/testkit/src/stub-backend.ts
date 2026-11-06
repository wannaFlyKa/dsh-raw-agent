// Stub backend (architecture §10.4): emits scripted BackendEvents. It never starts a process.
// Scripts are plain event lists; a test drives them per input, per interrupt, or by hand (a
// self-started turn, for example after a background task ends).

import {
  AsyncQueue,
  type AgentBackendFactory,
  type AgentBackendSession,
  type BackendEvent,
  type FactoryCapabilities,
  type OpenSessionOptions,
  type UserInput,
} from '@dsh-raw-agent/core';

export const STUB_CAPABILITIES: FactoryCapabilities = Object.freeze({
  ids: 'agent-chosen',
  resume: true,
  fork: 'none',
  needsProcess: [],
  permissionModes: [],
  mainAgentPicker: 'none',
  steer: 'restart',
}) as FactoryCapabilities;

export type ScriptStep = BackendEvent | { type: 'wait'; ms: number };

export interface StubScript {
  /** Events for each sent input, in send order. */
  onSend?: ScriptStep[][];
  /** Events after interrupt() (for example the agent's result for a running tool, then turn-end). */
  onInterrupt?: ScriptStep[];
}

export interface StubRecord {
  opened: OpenSessionOptions[];
  sent: UserInput[];
  interrupts: number;
  stoppedTasks: string[];
  disposed: number;
  /** Push events by hand into the open session. */
  emit(steps: ScriptStep[]): Promise<void>;
}

export function createStubFactory(
  script: StubScript,
  kind = 'stub',
): { factory: AgentBackendFactory; record: StubRecord } {
  let queue: AsyncQueue<BackendEvent> | undefined;
  const play = async (steps: ScriptStep[]) => {
    for (const s of steps) {
      if (s.type === 'wait') await new Promise((r) => setTimeout(r, (s as { ms: number }).ms));
      else queue?.push(s as BackendEvent);
    }
  };
  const record: StubRecord = { opened: [], sent: [], interrupts: 0, stoppedTasks: [], disposed: 0, emit: play };
  let sends = 0;
  const factory: AgentBackendFactory = {
    kind,
    displayName: 'Stub agent',
    staticCapabilities: STUB_CAPABILITIES,
    async open(o) {
      record.opened.push(o);
      queue = new AsyncQueue<BackendEvent>();
      const q = queue;
      const session: AgentBackendSession = {
        kind,
        sessionId: 'stub-session-1',
        startedAs: 'new',
        capabilities: {
          perTaskStop: true,
          sideQuestions: false,
          workflows: false,
          teamMessaging: false,
          cancelQueued: false,
          fileRewind: false,
          planChoices: [],
        },
        events: () => q,
        async send(input) {
          record.sent.push(input);
          const steps = script.onSend?.[sends++] ?? [];
          void play(steps);
        },
        async interrupt() {
          record.interrupts++;
          void play(script.onInterrupt ?? []);
          return { cancelledInputIds: [] };
        },
        async forceStop() {
          q.push({ type: 'exit' });
          q.end();
        },
        async dispose() {
          record.disposed++;
          q.push({ type: 'exit' });
          q.end();
        },
        controls: {
          async stopTask(taskId) {
            record.stoppedTasks.push(taskId);
          },
        },
      };
      return session;
    },
  };
  return { factory, record };
}
