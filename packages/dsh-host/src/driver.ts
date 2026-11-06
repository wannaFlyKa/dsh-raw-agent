// One DSH session driven by one backend session (D4, D18, D25, D26, D27, D47). DSH-neutral: every
// DSH touch point is behind the interfaces below, implemented in ./port (D79). No backend names
// either (D80): labels come from the factory.

import type {
  AgentBackendFactory,
  AgentBackendSession,
  BackendEvent,
  InteractionHandler,
  TaskKind,
  TaskStatus,
  ToolResultContent,
  Usage,
  UserInput,
  ContentBlock,
} from '@dsh-raw-agent/core';

/** What the driver writes into one open host turn. Implemented by the port writer. */
export interface TurnSink {
  readonly stepOpen: boolean;
  readonly openCallIds: string[];
  hasCall(callId: string): boolean;
  openStep(): void;
  delta(kind: 'text' | 'reasoning' | 'tool-input', blockIndex: number, text: string, at: number): void;
  commit(m: {
    blocks: ContentBlock[];
    usage?: Usage;
    model?: string;
    interrupted?: boolean;
    binding: Record<string, unknown>;
  }): { calls: string[] };
  result(callId: string, content: ToolResultContent[], isError: boolean, chainId?: string): void;
  closeStep(): void;
}

/** One binding read back from the host log (D21). */
export interface HostBinding {
  /** The backend session id. */
  sessionId: string;
  /** The host session that wrote it; another id means an inherited (forked) binding (D29). */
  hostSessionId?: string;
  /** The last backend chain entry at or before the cut (D29). */
  chainId?: string;
}

/** A host job that mirrors one background task (D47). */
export interface JobLink {
  progress(line: string): void;
  end(status: TaskStatus, summary?: string): void;
}

/** The host session as the driver sees it. Implemented by the port. */
export interface HostSessionPort {
  readonly hostSessionId: string;
  readonly cwd: string;
  /** Open a host turn for work the agent started by itself (D26). */
  wake(summary: string): void;
  /** The latest binding in the host log, own or inherited (D21, D28, D29), if any. */
  latestBinding(): HostBinding | undefined;
  /** The user's explicit model choice for this session (D35), or undefined for "your settings". */
  modelChoice?(): string | undefined;
  startJob(task: { taskId: string; kind: TaskKind; label: string }, stop: () => void): JobLink | undefined;
  warn(note: string, detail?: unknown): void;
}

/** The claimed inputs of one host turn, already filtered by the port (D22). */
export interface TurnInput {
  userInputs: UserInput[];
  wake: boolean;
}

export type TurnOutcome =
  { kind: 'completed' } | { kind: 'interrupted' } | { kind: 'error'; message: string } | { kind: 'nothing' };

type Item = BackendEvent | { type: 'stop-timeout' };

/** An unbounded event box with a drain, so nothing is lost when a turn ends mid-burst. */
class EventBox {
  #items: Item[] = [];
  #waiter: ((i: Item) => void) | undefined;
  push(i: Item): void {
    const w = this.#waiter;
    if (w) {
      this.#waiter = undefined;
      w(i);
    } else this.#items.push(i);
  }
  next(): Promise<Item> {
    const i = this.#items.shift();
    if (i !== undefined) return Promise.resolve(i);
    return new Promise((r) => (this.#waiter = r));
  }
  drain(): Item[] {
    return this.#items.splice(0);
  }
}

const TURN_EVENTS = new Set(['turn-start', 'step-start', 'delta', 'step-message', 'tool-result']);
/** How long Stop waits for the agent to end its turn before the driver closes it itself. */
export const STOP_GRACE_MS = 10_000;

export interface SessionRuntimeOptions {
  env: Readonly<Record<string, string | undefined>>;
  stopGraceMs?: number;
}

/** Spike interaction handler: the channel is S3. Asks are declined, never auto-allowed (rule 4). */
function declineAll(port: HostSessionPort): InteractionHandler {
  return {
    async permission(req) {
      port.warn('permission ask declined: the interaction channel is not built yet (S3)', { tool: req.toolName });
      const reject =
        req.options.find((o) => o.kind === 'reject-once') ?? req.options.find((o) => o.kind.startsWith('reject'));
      return { optionId: reject?.id ?? req.options[0]?.id ?? 'reject' };
    },
    async question() {
      return null;
    },
    async plan() {
      return { kind: 'keep-planning' };
    },
    async elicitation() {
      return { action: 'decline' };
    },
  };
}

export class SessionRuntime {
  readonly #factory: AgentBackendFactory;
  readonly #port: HostSessionPort;
  readonly #opts: SessionRuntimeOptions;
  readonly #abort = new AbortController();
  #backend: AgentBackendSession | undefined;
  #starting: Promise<AgentBackendSession> | undefined;
  #box: EventBox | undefined;
  #wakeBuffer: BackendEvent[] | undefined;
  readonly #jobs = new Map<string, JobLink>();
  #lastChainId: string | undefined;
  #appliedModel: string | undefined;

  constructor(factory: AgentBackendFactory, port: HostSessionPort, opts: SessionRuntimeOptions) {
    this.#factory = factory;
    this.#port = port;
    this.#opts = opts;
  }

  get backend(): AgentBackendSession | undefined {
    return this.#backend;
  }
  get runningJobs(): number {
    return this.#jobs.size;
  }

  async #ensureBackend(): Promise<AgentBackendSession> {
    if (this.#backend) return this.#backend;
    this.#starting ??= (async () => {
      const f = this.#factory;
      const binding = this.#port.latestBinding();
      const bound = binding?.sessionId;
      const derived = f.sessionIdFor?.(this.#port.hostSessionId);
      const inherited = binding?.hostSessionId !== undefined && binding.hostSessionId !== this.#port.hostSessionId;
      let start: Parameters<AgentBackendFactory['open']>[0]['start'];
      if (binding && inherited && f.staticCapabilities.fork !== 'none') {
        // D29: a host fork forks the backend session at the kept point; the source is left alone.
        start = { kind: 'fork', fromSessionId: binding.sessionId };
        if (derived !== undefined) start.newSessionId = derived;
        if (binding.chainId !== undefined && f.staticCapabilities.fork === 'at-chain-point')
          start.atChainId = binding.chainId;
      } else if (bound !== undefined && f.staticCapabilities.resume) start = { kind: 'resume', sessionId: bound };
      else if (
        derived !== undefined &&
        (await f.sessionExists?.(derived, this.#port.cwd)) === true &&
        f.staticCapabilities.resume
      )
        start = { kind: 'resume', sessionId: derived };
      else start = derived !== undefined ? { kind: 'new', sessionId: derived } : { kind: 'new' };
      const backend = await f.open({
        cwd: this.#port.cwd,
        env: this.#opts.env,
        start,
        userConfig: { options: {} },
        interactions: declineAll(this.#port),
        signal: this.#abort.signal,
      });
      this.#backend = backend;
      this.#appliedModel = undefined;
      void this.#pump(backend);
      return backend;
    })();
    try {
      return await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  async #pump(backend: AgentBackendSession): Promise<void> {
    try {
      for await (const e of backend.events()) this.#route(e);
    } catch (error) {
      this.#route({ type: 'exit', error: String((error as Error)?.message ?? error) });
    }
  }

  #route(e: BackendEvent): void {
    switch (e.type) {
      case 'task-start': {
        const backend = this.#backend;
        const link = this.#port.startJob({ taskId: e.taskId, kind: e.kind, label: e.label }, () => {
          void backend?.controls.stopTask?.(e.taskId).catch((err) => this.#port.warn('stopTask failed', String(err)));
        });
        if (link) this.#jobs.set(e.taskId, link);
        return;
      }
      case 'task-progress':
        if (e.summary) this.#jobs.get(e.taskId)?.progress(e.summary);
        return;
      case 'task-end':
        this.#jobs.get(e.taskId)?.end(e.status, e.summary);
        this.#jobs.delete(e.taskId);
        return;
      case 'tasks-snapshot':
        return;
      case 'exit':
        this.#backend = undefined;
        for (const [, link] of this.#jobs) link.end('failed', e.error ?? 'the agent process ended');
        this.#jobs.clear();
        if (this.#box) this.#box.push(e);
        else if (e.error) this.#port.warn('the agent process ended while idle (D75)', e.error);
        return;
    }
    if (this.#box) this.#box.push(e);
    else if (this.#wakeBuffer) this.#wakeBuffer.push(e);
    else if (TURN_EVENTS.has(e.type)) {
      this.#wakeBuffer = [e];
      this.#port.wake(`${this.#factory.displayName} continued on its own`);
    }
  }

  /** D35: apply an explicit choice after every spawn and before a send. Never `setModel(undefined)`. */
  async #applyModelChoice(backend: AgentBackendSession): Promise<void> {
    const choice = this.#port.modelChoice?.();
    if (choice === undefined || choice === this.#appliedModel || !backend.controls.setModel) return;
    try {
      await backend.controls.setModel(choice);
      this.#appliedModel = choice;
    } catch (error) {
      this.#port.warn('setModel failed', String((error as Error)?.message ?? error));
    }
  }

  #binding(): Record<string, unknown> {
    const b: Record<string, unknown> = {
      backend: this.#factory.kind,
      sessionId: this.#backend?.sessionId ?? '',
      hostSessionId: this.#port.hostSessionId,
    };
    if (this.#lastChainId !== undefined) b.lastChainId = this.#lastChainId;
    return b;
  }

  /** Run one host turn. Returns when the agent has consumed every input sent in it (D27). */
  async runTurn(sink: TurnSink, input: TurnInput, signal: AbortSignal): Promise<TurnOutcome> {
    const hasWork = input.userInputs.length > 0 || (input.wake && this.#wakeBuffer !== undefined);
    if (!hasWork) return { kind: 'nothing' };
    const backend = await this.#ensureBackend();
    await this.#applyModelChoice(backend);
    const box = new EventBox();
    this.#box = box;
    for (const e of this.#wakeBuffer ?? []) box.push(e);
    this.#wakeBuffer = undefined;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      // Stop = interrupt only (rule 6, D25). The process and its background tasks keep running.
      backend.interrupt().catch((err) => this.#port.warn('interrupt failed', String(err)));
      timer = setTimeout(() => box.push({ type: 'stop-timeout' }), this.#opts.stopGraceMs ?? STOP_GRACE_MS);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    let outcome: TurnOutcome;
    try {
      for (const u of input.userInputs) await backend.send(u, 'next');
      for (;;) {
        const e = await box.next();
        const end = this.#handle(sink, e);
        if (end !== undefined) {
          outcome = end;
          break;
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
      this.#box = undefined;
      try {
        sink.closeStep();
      } catch (error) {
        this.#port.warn('closing the step failed', String(error));
      }
      // Events that arrived after the turn end belong to the agent's next, self-started turn.
      const rest = box.drain().filter((i): i is BackendEvent => i.type !== 'stop-timeout');
      for (const e of rest) this.#route(e);
    }
    return outcome;
  }

  #handle(sink: TurnSink, e: Item): TurnOutcome | undefined {
    try {
      switch (e.type) {
        case 'step-start':
          if (sink.stepOpen) sink.closeStep(); // stale step: attempt or repairs, then step/end (D18)
          sink.openStep();
          return undefined;
        case 'delta':
          sink.delta(e.kind, e.blockIndex, e.text, e.at);
          return undefined;
        case 'step-message': {
          if (e.lastChainId !== undefined) this.#lastChainId = e.lastChainId;
          if (!sink.stepOpen) sink.openStep();
          const m: Parameters<TurnSink['commit']>[0] = { blocks: e.blocks, binding: this.#binding() };
          if (e.usage) m.usage = e.usage;
          if (e.model) m.model = e.model;
          if (e.interrupted) m.interrupted = true;
          const { calls } = sink.commit(m);
          if (calls.length === 0) sink.closeStep();
          return undefined;
        }
        case 'tool-result':
          if (e.chainId !== undefined) this.#lastChainId = e.chainId;
          if (!sink.stepOpen || !sink.hasCall(e.callId)) {
            this.#port.warn('dropped a tool result with no written call', e.callId);
            return undefined;
          }
          sink.result(e.callId, e.content, e.isError, e.chainId);
          if (sink.openCallIds.length === 0) sink.closeStep();
          return undefined;
        case 'turn-end':
          if (e.pendingInputs > 0) return undefined; // the agent runs a queued input next (D27)
          sink.closeStep();
          if (e.outcome === 'error') return { kind: 'error', message: e.error ?? 'the agent reported an error' };
          if (e.outcome === 'interrupted') return { kind: 'interrupted' };
          return { kind: 'completed' };
        case 'exit':
          return { kind: 'error', message: e.error ?? `${this.#factory.displayName} stopped` };
        case 'stop-timeout':
          this.#port.warn('the agent did not end its turn after Stop; closing it here');
          return { kind: 'interrupted' };
        default:
          return undefined;
      }
    } catch (error) {
      // A writer refusal: the event is not written, the log stays loadable.
      this.#port.warn(`refused ${e.type}`, String((error as Error)?.message ?? error));
      return undefined;
    }
  }

  /** Ends the process (dispose of the host session or force stop). Never called on Stop. */
  async dispose(): Promise<void> {
    this.#abort.abort();
    const b = this.#backend;
    this.#backend = undefined;
    await b?.dispose().catch(() => {});
  }
}
