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
  permissionModes: [
    { id: 'default', label: 'Default' },
    { id: 'plan', label: 'Plan' },
  ],
  efforts: [
    { id: 'low', label: 'Low' },
    { id: 'high', label: 'High' },
  ],
  mainAgentPicker: 'none',
  steer: 'restart',
}) as FactoryCapabilities;

export type ScriptStep = BackendEvent | { type: 'wait'; ms: number };

export interface StubScript {
  /** Events for each sent input, in send order. */
  onSend?: ScriptStep[][];
  /** Events after interrupt() (for example the agent's result for a running tool, then turn-end). */
  onInterrupt?: ScriptStep[];
  /** Report `cancelQueued` support; interrupt({cancelQueued}) then cancels every unconsumed input but the first. */
  cancelQueued?: boolean;
  /**
   * Placeholder input ids used in recorded scripts: `inputAliases[k]` in an `input-consumed`
   * event is replaced by the id of the k-th input the driver sent.
   */
  inputAliases?: string[];
}

export interface StubRecord {
  opened: OpenSessionOptions[];
  sent: UserInput[];
  interrupts: number;
  interruptOptions: Array<{ cancelQueued?: boolean } | undefined>;
  stoppedTasks: string[];
  /** Session controls the driver called, in order: `[name, value]` (D35, D38). */
  controls: Array<[string, unknown]>;
  disposed: number;
  /** Push events by hand into the open session. */
  emit(steps: ScriptStep[]): Promise<void>;
  /** The process dies: an `exit` with this error, then the stream ends. */
  crash(error?: string): void;
}

export function createStubFactory(
  script: StubScript,
  kind = 'stub',
): { factory: AgentBackendFactory; record: StubRecord } {
  let queue: AsyncQueue<BackendEvent> | undefined;
  const consumed = new Set<string>();
  const alias = (e: BackendEvent): BackendEvent => {
    if (e.type !== 'input-consumed') return e;
    const k = script.inputAliases?.indexOf(e.inputId) ?? -1;
    const id = k >= 0 ? record.sent[k]?.id : undefined;
    return id === undefined ? e : { ...e, inputId: id };
  };
  const play = async (steps: ScriptStep[]) => {
    for (const s of steps) {
      if (s.type === 'wait') await new Promise((r) => setTimeout(r, (s as { ms: number }).ms));
      else {
        const e = alias(s as BackendEvent);
        if (e.type === 'input-consumed') consumed.add(e.inputId);
        queue?.push(e);
      }
    }
  };
  const record: StubRecord = {
    opened: [],
    sent: [],
    interrupts: 0,
    interruptOptions: [],
    stoppedTasks: [],
    controls: [],
    disposed: 0,
    emit: play,
    crash(error) {
      queue?.push(error === undefined ? { type: 'exit' } : { type: 'exit', error });
      queue?.end();
    },
  };
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
          cancelQueued: script.cancelQueued === true,
          fileRewind: false,
          planChoices: [],
        },
        events: () => q,
        async send(input) {
          record.sent.push(input);
          const steps = script.onSend?.[sends++] ?? [];
          void play(steps);
        },
        async interrupt(opts) {
          record.interrupts++;
          record.interruptOptions.push(opts);
          const cancelled =
            opts?.cancelQueued && script.cancelQueued
              ? record.sent
                  .slice(1)
                  .filter((i) => !consumed.has(i.id))
                  .map((i) => i.id)
              : [];
          void play(script.onInterrupt ?? []);
          return { cancelledInputIds: cancelled };
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
          async setModel(model) {
            record.controls.push(['setModel', model]);
          },
          async setEffort(effort) {
            record.controls.push(['setEffort', effort]);
          },
          async setPermissionMode(mode) {
            record.controls.push(['setPermissionMode', mode]);
            q.push({ type: 'mode', mode }); // as the CLI's status frame
          },
        },
      };
      return session;
    },
  };
  return { factory, record };
}
