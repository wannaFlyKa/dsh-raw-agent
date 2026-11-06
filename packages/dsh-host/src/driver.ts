// One DSH session driven by one backend session (D4, D18, D25, D26, D27, D47). DSH-neutral: every
// DSH touch point is behind the interfaces below, implemented in ./port (D79). No backend names
// either (D80): labels come from the factory.

import type {
  AgentBackendFactory,
  OpenSessionOptions,
  AgentBackendSession,
  BackendEvent,
  BackendEventOf,
  BackendUserConfig,
  ModelInfo,
  SessionChoiceRequest,
  TaskKind,
  TaskStatus,
  ToolResultContent,
  Usage,
  UserInput,
  ContentBlock,
} from '@dsh-raw-agent/core';
import { offeredPermissionModes } from '@dsh-raw-agent/core';
import { AskDesk, type AskView } from './asks.js';

/** What the driver writes into one open host turn. Implemented by the port writer. */
export interface TurnSink {
  readonly stepOpen: boolean;
  /** The open step already has an assistant message (a further one is a D84 continuation). */
  readonly hasMessage: boolean;
  readonly openCallIds: string[];
  hasCall(callId: string): boolean;
  openStep(): void;
  delta(kind: 'text' | 'reasoning' | 'tool-input', blockIndex: number, text: string, at: number): void;
  commit(m: {
    blocks: ContentBlock[];
    usage?: Usage;
    model?: string;
    interrupted?: boolean;
    continued?: boolean;
    binding: Record<string, unknown>;
  }): { calls: string[] };
  /** Images arrive here only as `saved-image` refs or as text placeholders (D85). */
  result(callId: string, content: SinkResultContent[], isError: boolean, chainId?: string): void;
  /**
   * D85: store tool-result images in host storage, as one ordered batch; refs in input order.
   * Rejects when the host refuses them. Absent when the host has no attachment store.
   */
  saveImages?(images: ReadonlyArray<{ mediaType: string; base64: string }>): Promise<readonly unknown[]>;
  closeStep(): void;
  /**
   * Claim one steer between steps (D27): remove it from the host inbox and write it unchanged as
   * the human message. False when it is no longer pending.
   */
  claim(hostMessageId: string): boolean;
}

/** Tool-result content as the sink writes it: a stored image is an opaque host ref (D85). */
export type SinkResultContent =
  | Exclude<ToolResultContent, { type: 'image' }>
  | { type: 'saved-image'; mediaType: string; ref: unknown }
  | { type: 'image'; mediaType: string; base64: string };

/**
 * D85: the log-only placeholder for a result image the host did not store. Same form as DSH's own
 * MCP client (`P/dsh-mcp-client/lib/index.js:304-306`). The agent keeps its own copy of the image,
 * so nothing the model sees changes; this text exists only in the host log.
 */
export function imageUnavailableText(mediaType: string, reason: string): string {
  return `[image unavailable: ${mediaType || 'unknown media type'}; ${reason}]`;
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
  /**
   * D36: record a session-only model choice in the host log (`'settings'` = "your settings"). It
   * never saves the host's default model.
   */
  selectModel?(model: string): void;
  startJob(task: { taskId: string; kind: TaskKind; label: string }, stop: () => void): JobLink | undefined;
  warn(note: string, detail?: unknown): void;
  /**
   * D25: a steer the agent dropped on Stop goes back to the user: remove it from the host inbox
   * and put its text back into the composer draft. Nothing of it reaches the agent again.
   */
  returnDraft?(hostMessageId: string): void;
  /** Lifecycle changes for the plugin UI (D75 idle-death notice, Start button, job counts). */
  notify?(state: RuntimeState): void;
}

/** What the plugin UI can show about one session's agent process. */
export interface RuntimeState {
  process: 'none' | 'starting' | 'running';
  turn: boolean;
  backgroundTasks: number;
  /** How many asks wait for the user's answer. */
  waiting?: number;
  /** The last unexpected end of the process (D75), until the next spawn. */
  lastExit?: { error?: string; at: number; duringTurn: boolean };
}

/** What the live process reports about itself (system/init and status frames). */
export interface LiveInfo {
  model?: string;
  mode?: string;
  version?: string;
  /** The last line the agent showed the user outside the conversation (`notice` event). */
  notice?: { level: string; text: string; at: number };
}

/** The session-only choices (D35-D38) and what reached the live process. */
export interface ChoiceView {
  /** The model choice in the host log; undefined = "your settings". */
  model?: string;
  /** The effort choice (in memory, D24); undefined = "your settings". */
  effort?: string;
  /** A mode choice not yet applied (made before the spawn, D4). */
  pendingMode?: string;
  /** Values applied to the live process. */
  applied: { model?: string; effort?: string };
  /**
   * A model choice the live process refused (`setModel` failed). The agent may run another model
   * then (it substitutes a restricted id), so the picker names the model that really runs.
   */
  refused?: { model: string };
  /**
   * A "back to my settings" waits for a fresh start: the agent cannot clear a model or effort it
   * was given (D35 exact reset), so the process restarts with resume when it is idle.
   */
  resetPending: boolean;
}

/** Everything the plugin's session controls show. */
export interface SessionView {
  state: RuntimeState;
  live: LiveInfo;
  choice: ChoiceView;
  /** The model list from this session's process, if it reported one (D34). */
  models?: ModelInfo[];
  cwd?: string;
  /** Asks waiting for the user's answer (permission, question, plan, trust). Never auto-answered. */
  asks?: AskView[];
}

/** The result of one choice: what happened, in words for the UI. */
export interface ChoiceResult {
  ok: boolean;
  /** Short status for the UI, for example "applies at the next start". */
  note?: string;
  error?: string;
  view: SessionView;
}

/** The claimed inputs of one host turn, already filtered by the port (D22). */
export interface TurnInput {
  userInputs: UserInput[];
  wake: boolean;
}

export type TurnOutcome =
  { kind: 'completed' } | { kind: 'interrupted' } | { kind: 'error'; message: string } | { kind: 'nothing' };

/**
 * `ended`: a process we ended on purpose (force stop, dispose, reset) exited during a turn. That
 * turn ends as stopped, not with the crash text (R3.6 is for unexpected ends only).
 */
type Item = BackendEvent | { type: 'stop-timeout' } | { type: 'ended' };

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
  /** Read at every spawn, so a volatile config edit applies to the next spawn only (D87). */
  userConfig?: () => BackendUserConfig;
  now?: () => number;
}

/** One input this process was sent (D27 sent-input map, DSH side). */
interface SentEntry {
  /** The host message id, for steers (claim, D25 draft return). */
  hostMessageId?: string;
  steer: boolean;
  consumed: boolean;
  claimed: boolean;
}

/** The text a crash reports in the host turn (R3.6): what happened and what to do next. */
export function crashMessage(displayName: string, error: string | undefined): string {
  const why = error ? `: ${error}` : '';
  return `${displayName} stopped unexpectedly${why}. Its open steps were closed. Send a message to start it again; the conversation resumes where it was.`;
}

/**
 * One host session's agent process and turns (D4, D6, D8, D18, D25-D28, D74, D75, D84).
 *
 * Lifecycle: the process starts on the first message or `start()` (the "Start <name>" button),
 * never on open. Stop is `interrupt()` only. The process ends only on `forceStop()`, `dispose()`,
 * or `reap()` when the user turned idle reaping on (D6) and nothing runs in the background. A
 * process that dies is reported, its open steps are closed, and the next message resumes (D28).
 *
 * The port can be detached and attached again (D87: a host agent can be evicted while its
 * process and background tasks keep running); events that start a turn meanwhile wait for the
 * next attach.
 */
/** The model or effort id that means "your settings" (D35); also the catalog row id (D34). */
export const SETTINGS_CHOICE = 'settings';

export class SessionRuntime {
  readonly #factory: AgentBackendFactory;
  #port: HostSessionPort | undefined;
  readonly #opts: SessionRuntimeOptions;
  readonly #now: () => number;
  #backend: AgentBackendSession | undefined;
  #backendAbort: AbortController | undefined;
  #starting: Promise<AgentBackendSession> | undefined;
  /** Backends we end on purpose (reap, dispose, force stop): their exit is not a crash. */
  readonly #ending = new WeakSet<AgentBackendSession>();
  #forced = false;
  #disposed = false;
  #box: EventBox | undefined;
  #turnActive = false;
  #wakeBuffer: Item[] | undefined;
  #wakePending = false;
  /**
   * Stop's grace time ran out and the driver closed the turn itself: the agent's late events of
   * that stopped turn are dropped until its own turn end, rather than opening a "continued on its
   * own" turn with a result whose call was never written.
   */
  #lateStopped = false;
  readonly #jobs = new Map<string, JobLink>();
  #tasks = new Set<string>();
  readonly #sent = new Map<string, SentEntry>();
  #earlySteers: UserInput[] = [];
  #chain: string[] = [];
  readonly #superseded = new Set<string>();
  #appliedModel: string | undefined;
  #refusedModel: string | undefined;
  #appliedEffort: string | undefined;
  #effortChoice: string | undefined;
  #pendingMode: string | undefined;
  /** The user picked a mode in this session (D38): a new process of this session keeps it. */
  #modeChosen = false;
  #resetPending = false;
  #live: LiveInfo = {};
  #models: ModelInfo[] | undefined;
  #idleSince: number | undefined;
  #lastExit: RuntimeState['lastExit'];
  /** Asks held until the user answers (rules 3, 4): nothing is ever answered for the user. */
  readonly #desk: AskDesk;

  constructor(factory: AgentBackendFactory, port: HostSessionPort, opts: SessionRuntimeOptions) {
    this.#factory = factory;
    this.#port = port;
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
    this.#desk = new AskDesk(() => this.#notify(), this.#now);
  }

  get backend(): AgentBackendSession | undefined {
    return this.#backend;
  }
  get runningJobs(): number {
    return this.#jobs.size;
  }
  get attached(): boolean {
    return this.#port !== undefined;
  }
  get turnActive(): boolean {
    return this.#turnActive;
  }

  state(): RuntimeState {
    const s: RuntimeState = {
      process: this.#backend ? 'running' : this.#starting ? 'starting' : 'none',
      turn: this.#turnActive,
      backgroundTasks: Math.max(this.#tasks.size, this.#jobs.size),
    };
    if (this.#desk.size > 0) s.waiting = this.#desk.size;
    if (this.#lastExit) s.lastExit = { ...this.#lastExit };
    return s;
  }

  #warn(note: string, detail?: unknown): void {
    this.#port?.warn(note, detail);
  }
  #notify(): void {
    try {
      this.#port?.notify?.(this.state());
    } catch (error) {
      this.#warn('state listener failed', String(error));
    }
  }

  /** Bind a new host agent (D87: after an eviction). A turn the agent started meanwhile wakes now. */
  attach(port: HostSessionPort): void {
    this.#port = port;
    if (this.#wakePending && this.#wakeBuffer !== undefined) {
      this.#wakePending = false;
      port.wake(`${this.#factory.displayName} continued on its own`);
    }
    this.#notify();
  }

  /** The host agent went away; the process and its background tasks keep running (rules 6, 7). */
  detach(): void {
    this.#port = undefined;
  }

  /** "Start <displayName>" (D4): spawn without sending anything. */
  async start(): Promise<void> {
    const backend = await this.#ensureBackend();
    await this.#applyChoices(backend);
  }

  /** What the plugin's session controls show (D35-D38, D4). */
  view(): SessionView {
    const choice: ChoiceView = { applied: {}, resetPending: this.#resetPending };
    const model = this.#port?.modelChoice?.();
    if (model !== undefined) choice.model = model;
    if (this.#effortChoice !== undefined) choice.effort = this.#effortChoice;
    if (this.#pendingMode !== undefined) choice.pendingMode = this.#pendingMode;
    if (this.#appliedModel !== undefined) choice.applied.model = this.#appliedModel;
    if (this.#refusedModel !== undefined) choice.refused = { model: this.#refusedModel };
    if (this.#appliedEffort !== undefined) choice.applied.effort = this.#appliedEffort;
    const v: SessionView = { state: this.state(), live: { ...this.#live }, choice };
    if (this.#models) v.models = this.#models.map((m) => ({ ...m }));
    if (this.#port) v.cwd = this.#port.cwd;
    const asks = this.#desk.list();
    if (asks.length > 0) v.asks = asks;
    return v;
  }

  /** The user answered one ask in the UI. False when it is gone or the choice is not offered. */
  answer(askId: string, choiceId: string): boolean {
    return this.#desk.answer(askId, choiceId);
  }

  /**
   * D73: before a spawn in a folder the agent does not trust yet, ask the user the agent's own
   * trust question. Returns the folder to trust only after the user's accept click; throws on a
   * decline (the agent's terminal app exits then). An unreadable record spawns without trust and
   * says what may not apply.
   */
  async #trustFor(cwd: string, setNotice: (text: string) => void): Promise<{ directory: string } | undefined> {
    const f = this.#factory;
    if (!f.trustState) return undefined;
    let t: Awaited<ReturnType<NonNullable<AgentBackendFactory['trustState']>>> | undefined;
    try {
      t = await f.trustState(cwd);
    } catch (error) {
      this.#warn('reading the workspace trust failed', String(error));
      t = undefined;
    }
    if (t?.state === 'trusted') return undefined;
    const effect = t?.untrustedEffect ?? 'project settings may not apply';
    if (!t || t.state === 'unknown' || !t.question) {
      setNotice(
        `${f.displayName} could not tell whether it trusts this folder: ${effect} until you trust it in the ${f.displayName} terminal app.`,
      );
      return undefined;
    }
    const accepted = await this.#desk.trust(t.question, t.directory);
    if (!accepted)
      throw new Error(
        `you did not trust this folder, so ${f.displayName} was not started (its terminal app exits too). Send a message to be asked again.`,
      );
    return { directory: t.directory };
  }

  /**
   * A session-only choice from the UI (D35-D38). Model choices are recorded in the host log
   * through the port (session-only, D36); effort and mode stay in memory (D24). A choice made
   * before the spawn is applied right after it (D4). Nothing is ever written to settings files.
   */
  async choose(req: SessionChoiceRequest): Promise<ChoiceResult> {
    const caps = this.#factory.staticCapabilities;
    const notes: string[] = [];
    const fail = (error: string): ChoiceResult => ({ ok: false, error, view: this.view() });
    if (req.mode !== undefined && !caps.permissionModes.some((m) => m.id === req.mode))
      return fail(`unknown mode: ${req.mode}`);
    if (
      req.mode !== undefined &&
      !offeredPermissionModes(caps.permissionModes, this.#opts.userConfig?.().options, [this.#live.mode]).some(
        (m) => m.id === req.mode,
      )
    )
      return fail(`${req.mode} is not available in this session (it needs a ${this.#factory.displayName} option)`);
    const effortId = req.effort === null || req.effort === SETTINGS_CHOICE ? null : req.effort;
    if (typeof effortId === 'string' && !(caps.efforts ?? []).some((e) => e.id === effortId))
      return fail(`unknown effort: ${effortId}`);
    if (req.model !== undefined) {
      if (!this.#port?.selectModel) return fail('the session is not open');
      this.#port.selectModel(req.model);
      if (req.model === SETTINGS_CHOICE && this.#appliedModel !== undefined) this.#resetPending = true;
    }
    if (req.effort !== undefined) {
      this.#effortChoice = effortId ?? undefined;
      if (effortId === null && this.#appliedEffort !== undefined) this.#resetPending = true;
    }
    if (req.mode !== undefined) {
      this.#pendingMode = req.mode;
      this.#modeChosen = true;
    }
    const backend = this.#backend;
    if (this.#resetPending) notes.push(await this.#resetIfIdle());
    else if (backend) {
      const error = await this.#applyChoices(backend);
      if (error) return fail(error);
      notes.push('applied');
    } else notes.push(`applies when ${this.#factory.displayName} starts`);
    this.#notify();
    return { ok: true, note: notes.filter(Boolean).join('; '), view: this.view() };
  }

  /** D35 exact reset: restart with resume and no choices, but only when nothing runs. */
  async #resetIfIdle(inTurn = false): Promise<string> {
    if (!this.#resetPending) return '';
    const b = this.#backend;
    if (!b) {
      this.#resetPending = false;
      return `your settings apply when ${this.#factory.displayName} starts`;
    }
    const busy = (!inTurn && this.#turnActive) || this.#starting !== undefined || this.#wakeBuffer !== undefined;
    if (busy || this.#tasks.size > 0 || this.#jobs.size > 0)
      return `your settings apply after ${this.#factory.displayName} restarts; it restarts at the next message once no work runs`;
    await this.#end(false);
    // The process ended on purpose; forget it now so the next spawn does not reuse it.
    if (this.#backend === b) {
      this.#backend = undefined;
      this.#backendAbort = undefined;
    }
    this.#carryMode();
    this.#appliedModel = undefined;
    this.#refusedModel = undefined;
    this.#appliedEffort = undefined;
    this.#live = {};
    this.#resetPending = false;
    return `${this.#factory.displayName} will start again with your settings at the next message`;
  }

  async #ensureBackend(): Promise<AgentBackendSession> {
    if (this.#disposed) throw new Error('the session is closed');
    if (this.#backend) return this.#backend;
    const port = this.#port;
    if (!port) throw new Error(`${this.#factory.displayName} cannot start: the session is not open`);
    this.#starting ??= (async () => {
      const f = this.#factory;
      const binding = port.latestBinding();
      const bound = binding?.sessionId;
      const derived = f.sessionIdFor?.(port.hostSessionId);
      const inherited = binding?.hostSessionId !== undefined && binding.hostSessionId !== port.hostSessionId;
      let start: OpenSessionOptions['start'];
      if (binding && inherited && f.staticCapabilities.fork !== 'none') {
        // D29: a host fork forks the backend session at the kept point; the source is left alone.
        start = { kind: 'fork', fromSessionId: binding.sessionId };
        if (derived !== undefined) start.newSessionId = derived;
        if (binding.chainId !== undefined && f.staticCapabilities.fork === 'at-chain-point')
          start.atChainId = binding.chainId;
      } else if (bound !== undefined && f.staticCapabilities.resume) start = { kind: 'resume', sessionId: bound };
      else if (
        derived !== undefined &&
        (await f.sessionExists?.(derived, port.cwd)) === true &&
        f.staticCapabilities.resume
      )
        start = { kind: 'resume', sessionId: derived };
      else start = derived !== undefined ? { kind: 'new', sessionId: derived } : { kind: 'new' };
      let trustNotice: string | undefined;
      const trustAccepted = await this.#trustFor(port.cwd, (text) => (trustNotice = text));
      const abort = new AbortController();
      const openOptions: OpenSessionOptions = {
        cwd: port.cwd,
        env: this.#opts.env,
        start,
        userConfig: this.#opts.userConfig?.() ?? { options: {} },
        interactions: this.#desk.handler(),
        signal: abort.signal,
      };
      if (trustAccepted) openOptions.trustAccepted = trustAccepted;
      const backend = await f.open(openOptions);
      if (this.#disposed) {
        this.#ending.add(backend);
        abort.abort();
        await backend.dispose().catch(() => {});
        throw new Error('the session is closed');
      }
      this.#backend = backend;
      this.#backendAbort = abort;
      this.#forced = false;
      this.#appliedModel = undefined;
      this.#refusedModel = undefined;
      this.#appliedEffort = undefined;
      this.#resetPending = false;
      this.#live = {};
      if (trustNotice !== undefined) this.#live.notice = { level: 'warning', text: trustNotice, at: this.#now() };
      this.#lastExit = undefined;
      this.#sent.clear();
      this.#tasks = new Set();
      if (!this.#turnActive) this.#idleSince = this.#now();
      void this.#pump(backend);
      this.#loadModels(backend);
      return backend;
    })();
    this.#notify();
    try {
      return await this.#starting;
    } finally {
      this.#starting = undefined;
      this.#notify();
    }
  }

  async #pump(backend: AgentBackendSession): Promise<void> {
    let exited = false;
    try {
      for await (const e of backend.events()) {
        if (e.type === 'exit') exited = true;
        this.#route(e, backend);
      }
    } catch (error) {
      exited = true;
      this.#route({ type: 'exit', error: String((error as Error)?.message ?? error) }, backend);
    }
    if (!exited) this.#route({ type: 'exit', error: 'the event stream ended' }, backend);
  }

  #route(e: BackendEvent, from: AgentBackendSession): void {
    if (from !== this.#backend) return; // a process we already replaced or ended
    switch (e.type) {
      case 'task-start': {
        this.#tasks.add(e.taskId);
        const link = this.#port?.startJob({ taskId: e.taskId, kind: e.kind, label: e.label }, () => {
          void from.controls.stopTask?.(e.taskId).catch((err) => this.#warn('stopTask failed', String(err)));
        });
        if (link) this.#jobs.set(e.taskId, link);
        this.#notify();
        return;
      }
      case 'task-progress':
        if (e.summary) this.#jobs.get(e.taskId)?.progress(e.summary);
        return;
      case 'task-end':
        this.#tasks.delete(e.taskId);
        this.#jobs.get(e.taskId)?.end(e.status, e.summary);
        this.#jobs.delete(e.taskId);
        this.#touchIdle();
        this.#notify();
        return;
      case 'tasks-snapshot':
        // The full list (D47): it corrects drift for the reaping check.
        this.#tasks = new Set(e.taskIds);
        return;
      case 'exit':
        this.#exit(e, from);
        return;
      case 'session-info':
        this.#live = this.#live.notice ? { notice: this.#live.notice } : {};
        if (e.model !== undefined) this.#live.model = e.model;
        if (e.mode !== undefined) this.#live.mode = e.mode;
        if (e.version !== undefined) this.#live.version = e.version;
        this.#notify();
        return;
      case 'mode':
        if (this.#live.mode !== e.mode) {
          this.#live.mode = e.mode;
          this.#notify();
        }
        return;
      case 'conversation-reset':
        return;
      case 'notice':
        // Not a conversation event: the agent keeps it in its own transcript. Shown in the UI.
        this.#live.notice = { level: e.level, text: e.text, at: this.#now() };
        this.#warn(`${this.#factory.displayName}: ${e.text}`);
        this.#notify();
        return;
      case 'input-cancelled':
        // D25: the agent dropped it (Stop with a queued steer): the text goes back to the user and
        // is never claimed, in or out of a turn.
        this.#returnSteers([e.inputId]);
        return;
      case 'input-consumed':
        if (!this.#box && !this.#wakeBuffer) {
          // Outside any turn: note it now, so the next turn does not wait for it (D22, D27). DSH
          // claims the message itself at that turn.
          const entry = this.#sent.get(e.inputId);
          if (entry) entry.consumed = true;
          return;
        }
        break;
    }
    if (this.#box) this.#box.push(e);
    else if (this.#wakeBuffer) this.#wakeBuffer.push(e);
    else if (this.#lateStopped && (TURN_EVENTS.has(e.type) || e.type === 'turn-end')) {
      if (e.type === 'turn-end') this.#lateStopped = false;
      this.#warn(`dropped a late ${e.type} of a turn closed after Stop`);
    } else if (TURN_EVENTS.has(e.type)) {
      // D26: the agent started a turn by itself; a log-only notice opens a host turn for it.
      this.#wakeBuffer = [e];
      const port = this.#port;
      if (port) port.wake(`${this.#factory.displayName} continued on its own`);
      else this.#wakePending = true;
    }
  }

  /**
   * A process of this session ends while the user's own mode choice is in force (a model or
   * effort reset, a reap, a crash, force stop): the next process starts in the settings mode,
   * which can be more permissive. So the mode it last ran in (the CLI's own report, which follows
   * plan approvals) becomes a pending choice again and is applied right after the next spawn (D4).
   * Only after the user picked a mode in this session; otherwise the settings mode stays (rule 4).
   */
  #carryMode(): void {
    if (!this.#modeChosen || this.#pendingMode !== undefined) return;
    const mode = this.#live.mode;
    if (mode !== undefined) this.#pendingMode = mode;
  }

  #exit(e: Extract<BackendEvent, { type: 'exit' }>, from: AgentBackendSession): void {
    const intended = this.#ending.has(from);
    this.#lateStopped = false;
    this.#carryMode();
    this.#desk.dropAll(); // the process that asked is gone
    this.#backend = undefined;
    this.#backendAbort = undefined;
    for (const [, link] of this.#jobs) link.end('failed', e.error ?? `${this.#factory.displayName} ended`);
    this.#jobs.clear();
    this.#tasks = new Set();
    // A new process has none of this process's inputs: an unclaimed steer is sent again (D22).
    this.#sent.clear();
    this.#earlySteers = [];
    this.#touchIdle();
    const duringTurn = this.#box !== undefined || this.#wakeBuffer !== undefined;
    if (!intended) {
      this.#lastExit = { at: this.#now(), duringTurn };
      if (e.error !== undefined) this.#lastExit.error = e.error;
    }
    const item: Item = intended ? { type: 'ended' } : e;
    if (this.#box) this.#box.push(item);
    else if (this.#wakeBuffer) this.#wakeBuffer.push(item);
    else if (!intended) this.#warn(`${this.#factory.displayName} ended while idle (D75)`, e.error ?? 'no error text');
    this.#notify();
  }

  #touchIdle(): void {
    if (!this.#turnActive) this.#idleSince = this.#now();
  }

  /**
   * D35, D38: apply explicit choices after every spawn and before a send, once per value. Never
   * `setModel(undefined)`. A mode choice applies once; after that the agent's own mode is the
   * truth (a plan approval changes it). Returns the first error text, if any.
   */
  async #applyChoices(backend: AgentBackendSession): Promise<string | undefined> {
    let firstError: string | undefined;
    const failed = (what: string, error: unknown) => {
      const text = `${what} failed: ${String((error as Error)?.message ?? error)}`;
      this.#warn(text);
      firstError ??= text;
    };
    const model = this.#port?.modelChoice?.();
    if (model !== undefined && model !== this.#appliedModel && backend.controls.setModel) {
      try {
        await backend.controls.setModel(model);
        this.#appliedModel = model;
        this.#refusedModel = undefined;
      } catch (error) {
        this.#refusedModel = model;
        failed('setModel', error);
      }
    }
    const effort = this.#effortChoice;
    if (effort !== undefined && effort !== this.#appliedEffort && backend.controls.setEffort) {
      try {
        await backend.controls.setEffort(effort);
        this.#appliedEffort = effort;
      } catch (error) {
        failed('setEffort', error);
      }
    }
    const mode = this.#pendingMode;
    if (mode !== undefined && backend.controls.setPermissionMode) {
      try {
        await backend.controls.setPermissionMode(mode);
        this.#pendingMode = undefined;
        this.#live.mode = mode;
      } catch (error) {
        this.#pendingMode = undefined;
        failed('setPermissionMode', error);
      }
    }
    return firstError;
  }

  /** D34: the model list from this process (no extra process; the live session answers). */
  #loadModels(backend: AgentBackendSession): void {
    if (!backend.controls.models) return;
    backend.controls.models().then(
      (list) => {
        if (backend !== this.#backend) return;
        this.#models = list;
        this.#notify();
      },
      (error) => this.#warn('reading the model list failed', String(error)),
    );
  }

  get #lastChainId(): string | undefined {
    for (let i = this.#chain.length - 1; i >= 0; i--) if (!this.#superseded.has(this.#chain[i]!)) return this.#chain[i];
    return undefined;
  }

  #noteChain(id: string | undefined): void {
    if (id === undefined || this.#superseded.has(id)) return;
    this.#chain.push(id);
    if (this.#chain.length > 64) this.#chain = this.#chain.slice(-32);
  }

  #binding(): Record<string, unknown> {
    const b: Record<string, unknown> = {
      backend: this.#factory.kind,
      sessionId: this.#backend?.sessionId ?? '',
      hostSessionId: this.#port?.hostSessionId ?? '',
    };
    const chain = this.#lastChainId;
    if (chain !== undefined) b.lastChainId = chain;
    return b;
  }

  /**
   * D27: a human message the user typed into the running turn (DSH `nextStep`). It goes to the
   * agent at once with priority `next`; the driver claims it at the next step boundary after the
   * agent took it. Returns false when no turn of ours is running (DSH claims it at the next turn).
   */
  steer(hostMessageId: string, input: UserInput): boolean {
    if (!this.#turnActive || this.#disposed) return false;
    if (this.#sent.has(input.id)) return true;
    this.#sent.set(input.id, { hostMessageId, steer: true, consumed: false, claimed: false });
    const backend = this.#backend;
    if (backend && this.#box) this.#sendSteer(backend, input);
    else this.#earlySteers.push(input); // the process is still starting
    return true;
  }

  #sendSteer(backend: AgentBackendSession, input: UserInput): void {
    backend.send(input, 'next').catch((err) => {
      this.#sent.delete(input.id); // not sent: DSH's own claim forwards it later
      this.#warn('could not send a steer', String((err as Error)?.message ?? err));
    });
  }

  /** Claim every consumed, unclaimed steer. Only between steps. */
  #claimConsumed(sink: TurnSink): void {
    if (sink.stepOpen) return;
    for (const entry of this.#sent.values()) {
      if (!entry.steer || !entry.consumed || entry.claimed || entry.hostMessageId === undefined) continue;
      entry.claimed = true;
      try {
        if (!sink.claim(entry.hostMessageId)) this.#warn('a consumed steer was no longer pending', entry.hostMessageId);
      } catch (error) {
        this.#warn('refused claim', String((error as Error)?.message ?? error));
      }
    }
  }

  /** D25: give the text of steers the agent will not run back to the user. */
  #returnSteers(ids: Iterable<string>): void {
    for (const id of ids) {
      const entry = this.#sent.get(id);
      this.#sent.delete(id);
      if (entry?.steer && !entry.claimed && entry.hostMessageId !== undefined)
        this.#port?.returnDraft?.(entry.hostMessageId);
    }
  }

  /** Run one host turn. Returns when the agent has consumed every input sent in it (D27). */
  async runTurn(sink: TurnSink, input: TurnInput, signal: AbortSignal): Promise<TurnOutcome> {
    const fresh = input.userInputs.filter((u) => !this.#sent.has(u.id));
    // Sent earlier (a steer DSH claimed after our turn ended) and still waiting: wait for it (D22).
    const waiting = input.userInputs.filter((u) => this.#sent.get(u.id)?.consumed === false);
    for (const u of input.userInputs) {
      const entry = this.#sent.get(u.id);
      if (entry) entry.claimed = true; // the loop wrote its user/message
    }
    const wake = input.wake && this.#wakeBuffer !== undefined;
    if (fresh.length === 0 && waiting.length === 0 && !wake)
      return input.userInputs.length > 0 ? { kind: 'completed' } : { kind: 'nothing' };
    this.#turnActive = true;
    this.#idleSince = undefined;
    let backend: AgentBackendSession;
    // Stop while the process starts: a trust question waiting for the user is declined (D73).
    const stopStart = () => this.#desk.stop(['trust']);
    signal.addEventListener('abort', stopStart, { once: true });
    try {
      // D35 exact reset: a pending "back to my settings" restarts the idle process first.
      if (this.#resetPending) await this.#resetIfIdle(true);
      backend = await this.#ensureBackend();
      await this.#applyChoices(backend);
    } catch (error) {
      this.#turnActive = false;
      this.#touchIdle();
      this.#notify();
      return {
        kind: 'error',
        message: `${this.#factory.displayName} could not start: ${String((error as Error)?.message ?? error)}`,
      };
    } finally {
      signal.removeEventListener('abort', stopStart);
    }
    const box = new EventBox();
    this.#box = box;
    this.#lateStopped = false; // a new turn takes what comes; a late turn end has pendingInputs > 0
    for (const e of this.#wakeBuffer ?? []) box.push(e);
    this.#wakeBuffer = undefined;
    this.#wakePending = false;
    this.#notify();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      // Stop = interrupt only (rule 6, D25). The process and its background tasks keep running.
      const queued = [...this.#sent.values()].some((s) => s.steer && !s.consumed);
      const cancelQueued = queued && backend.capabilities.cancelQueued;
      backend
        .interrupt(cancelQueued ? { cancelQueued: true } : undefined)
        .then((r) => this.#returnSteers(r.cancelledInputIds))
        .catch((err) => this.#warn('interrupt failed', String(err)));
      // An open main-thread ask gets the agent's own Esc answer, as when the user presses Esc in
      // its terminal app: Stop is the user's action, never the plugin's. A subagent's ask is left
      // alone: a background agent keeps running and its ask waits for the user (rule 6); the
      // agent itself cancels the ask of a subagent the interrupt ends.
      this.#desk.stop(undefined, ['main']);
      timer = setTimeout(() => box.push({ type: 'stop-timeout' }), this.#opts.stopGraceMs ?? STOP_GRACE_MS);
    };

    let outcome: TurnOutcome;
    /** A message of this turn the backend refused to take (it is in the host log as typed). */
    let sendError: string | undefined;
    try {
      let sent = 0;
      for (const u of fresh) {
        this.#sent.set(u.id, { steer: false, consumed: false, claimed: true });
        try {
          await backend.send(u, 'next');
          sent++;
        } catch (error) {
          // Not sent: forget it, so the turn does not wait for it and no later turn claims it. What
          // was already sent keeps running in the agent, so this turn goes on and shows that work;
          // the error is reported when it ends. Later inputs of this turn are not sent either.
          this.#sent.delete(u.id);
          sendError = `${this.#factory.displayName} was not sent a message: ${String((error as Error)?.message ?? error)}`;
          break;
        }
      }
      if (sendError !== undefined && sent === 0 && waiting.length === 0 && !wake) throw new Error(sendError);
      for (const u of this.#earlySteers.splice(0)) this.#sendSteer(backend, u);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      for (;;) {
        const e = await box.next();
        // D85: result images are stored before the result is written; the loop is sequential, so
        // the order of events is kept while the store works.
        const prepared = e.type === 'tool-result' ? await this.#prepareResult(sink, e) : undefined;
        const end = this.#handle(sink, e, prepared);
        if (end !== undefined) {
          outcome = end;
          break;
        }
      }
    } catch (error) {
      outcome = { kind: 'error', message: String((error as Error)?.message ?? error) };
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
      this.#box = undefined;
      try {
        sink.closeStep(); // D74: every open step is closed before the turn ends
        this.#claimConsumed(sink);
      } catch (error) {
        this.#warn('closing the step failed', String(error));
      }
      this.#turnActive = false;
      this.#touchIdle();
      // Events that arrived after the turn end belong to the agent's next, self-started turn.
      const rest = box.drain().filter((i): i is BackendEvent => i.type !== 'stop-timeout' && i.type !== 'ended');
      const current = this.#backend;
      if (current) for (const e of rest) this.#route(e, current);
      this.#notify();
    }
    if (sendError !== undefined && outcome!.kind === 'completed') return { kind: 'error', message: sendError };
    return outcome!;
  }

  /**
   * D85: replace every result image with a stored host ref, or, when the host has no store or
   * refuses the batch, with a short placeholder. One refusal turns every image of that result into
   * a placeholder, as DSH's MCP client does. Base64 bytes never reach the sink.
   */
  async #prepareResult(sink: TurnSink, e: BackendEventOf<'tool-result'>): Promise<SinkResultContent[]> {
    const images = e.content.filter((c): c is Extract<ToolResultContent, { type: 'image' }> => c.type === 'image');
    if (images.length === 0) return e.content;
    // A result that will be dropped (no written call) stores nothing.
    if (!sink.stepOpen || !sink.hasCall(e.callId)) return e.content;
    let refs: readonly unknown[] | undefined;
    let reason = 'the host has no attachment store';
    if (sink.saveImages) {
      try {
        refs = await sink.saveImages(images.map((i) => ({ mediaType: i.mediaType, base64: i.base64 })));
        if (refs.length !== images.length) {
          refs = undefined;
          reason = 'the host returned the wrong number of attachment refs';
        }
      } catch (error) {
        reason = `it was not stored: ${String((error as Error)?.message ?? error)}`;
      }
    }
    if (refs === undefined) this.#warn('could not store tool result images', reason);
    let k = 0;
    return e.content.map((c): SinkResultContent => {
      if (c.type !== 'image') return c;
      const ref = refs?.[k++];
      return refs === undefined
        ? { type: 'text', text: imageUnavailableText(c.mediaType, reason) }
        : { type: 'saved-image', mediaType: c.mediaType, ref };
    });
  }

  #handle(sink: TurnSink, e: Item, prepared?: SinkResultContent[]): TurnOutcome | undefined {
    try {
      switch (e.type) {
        case 'step-start':
          if (sink.stepOpen) sink.closeStep(); // stale step: attempt or repairs, then step/end (D18)
          this.#claimConsumed(sink);
          sink.openStep();
          return undefined;
        case 'delta':
          sink.delta(e.kind, e.blockIndex, e.text, e.at);
          return undefined;
        case 'step-message': {
          this.#noteChain(e.lastChainId);
          const continued = sink.stepOpen && sink.hasMessage;
          if (!sink.stepOpen) {
            this.#claimConsumed(sink);
            sink.openStep();
          }
          const m: Parameters<TurnSink['commit']>[0] = { blocks: e.blocks, binding: this.#binding() };
          if (e.usage) m.usage = e.usage;
          if (e.model) m.model = e.model;
          if (e.interrupted) m.interrupted = true;
          if (continued) m.continued = true;
          const { calls } = sink.commit(m);
          // A whole response may continue in further frames (D84): keep its step open until the
          // next step, the turn end, or its last result.
          if (sink.openCallIds.length === 0 && (e.final || calls.length > 0)) sink.closeStep();
          return undefined;
        }
        case 'tool-result':
          this.#noteChain(e.chainId);
          if (!sink.stepOpen || !sink.hasCall(e.callId)) {
            this.#warn('dropped a tool result with no written call', e.callId);
            return undefined;
          }
          sink.result(e.callId, prepared ?? e.content, e.isError, e.chainId);
          if (sink.openCallIds.length === 0) sink.closeStep();
          return undefined;
        case 'superseded':
          // D72, D84: a replaced uuid is off the agent's chain, so never a fork point.
          for (const id of e.chainIds) this.#superseded.add(id);
          return undefined;
        case 'input-consumed': {
          const entry = this.#sent.get(e.inputId);
          if (entry) entry.consumed = true;
          this.#claimConsumed(sink); // at once when between steps, else at the next boundary
          return undefined;
        }
        case 'turn-end':
          if (e.pendingInputs > 0) return undefined; // the agent runs a queued input next (D27)
          sink.closeStep();
          for (const entry of this.#sent.values()) entry.consumed = true; // the agent has nothing pending
          this.#claimConsumed(sink);
          if (e.outcome === 'error') return { kind: 'error', message: e.error ?? 'the agent reported an error' };
          if (e.outcome === 'interrupted') return { kind: 'interrupted' };
          return { kind: 'completed' };
        case 'ended':
          return { kind: 'interrupted' };
        case 'exit':
          if (this.#forced) return { kind: 'interrupted' };
          return { kind: 'error', message: crashMessage(this.#factory.displayName, e.error) };
        case 'stop-timeout': {
          this.#warn('the agent did not end its turn after Stop; closing it here');
          this.#lateStopped = true;
          // Steers it never took go back to the user rather than run unseen later (D25).
          const unconsumed = [...this.#sent].filter(([, s]) => s.steer && !s.consumed).map(([id]) => id);
          this.#returnSteers(unconsumed);
          return { kind: 'interrupted' };
        }
        default:
          return undefined;
      }
    } catch (error) {
      // A writer refusal: the event is not written, the log stays loadable.
      this.#warn(`refused ${e.type}`, String((error as Error)?.message ?? error));
      return undefined;
    }
  }

  /**
   * D6: may idle reaping end this process now? Only when the user set a timeout, no turn runs,
   * nothing runs in the background, and nothing waits for a wake turn.
   */
  isReapable(now: number, idleMs: number): boolean {
    if (!(idleMs > 0) || !this.#backend || this.#starting || this.#turnActive) return false;
    if (this.#tasks.size > 0 || this.#jobs.size > 0 || this.#wakeBuffer !== undefined) return false;
    return this.#idleSince !== undefined && now - this.#idleSince >= idleMs;
  }

  /** End an idle process (D6). The session stays; the next message resumes it (D28). */
  async reap(): Promise<boolean> {
    if (!this.isReapable(Number.POSITIVE_INFINITY, 1)) return false;
    await this.#end(false);
    return true;
  }

  /** "Force stop" (D25): the only user path that ends the process, background tasks included. */
  async forceStop(): Promise<void> {
    await this.#end(true);
  }

  async #end(force: boolean): Promise<void> {
    const b = this.#backend;
    if (!b) return;
    this.#ending.add(b);
    this.#forced = force;
    this.#backendAbort?.abort();
    await (force ? b.forceStop() : b.dispose()).catch((err) => this.#warn('ending the process failed', String(err)));
  }

  /** Ends the process for good (the host session or the plugin goes away). Never called on Stop. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#desk.dropAll();
    await this.#end(false);
    this.#box?.push({ type: 'ended' }); // a running turn ends as stopped, not as a crash
    this.#backend = undefined;
    this.#port = undefined;
  }
}
