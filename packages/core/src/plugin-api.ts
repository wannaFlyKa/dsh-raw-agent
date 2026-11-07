// The public service API for other DSH plugins (R9.2, D66, architecture §7.3). Types and pure
// logic only; both halves use them: the Host service `rawAgent` and the Client service
// `rawAgentClient`. Documented in docs/plugin-api.md.
//
// Rules (D66):
// - Other plugins read the native DSH session log first (rule 8). `onEvent` carries only data the
//   log does not have: process and turn state, usage and cost, workflow snapshots, child agents,
//   and which asks wait for the user (never their choices or answers).
// - Only `prefill` (Client) can put text toward the agent without a grant; the user sends it.
// - `send`, `steer` and `askSideQuestion` need a grant token the user created for the calling
//   plugin. The grant is a consent switch between trusted in-process plugins, not a security
//   boundary: DSH runs every plugin in one process.
// - A granted message is written with `source.kind: 'raw-agent-plugin'`, never `'user'`.

/** Cordis service name of the Host service. */
export const RAW_AGENT_SERVICE = 'rawAgent';
/** Cordis service name of the Client (browser) service. */
export const RAW_AGENT_CLIENT_SERVICE = 'rawAgentClient';
/** The service API version. A change of any shape bumps it. */
export const RAW_AGENT_API_VERSION = 1;
/** `source.kind` of a message a granted plugin sent. Never `'user'` (D66). */
export const PLUGIN_SOURCE_KIND = 'raw-agent-plugin';
/** The longest text `send` and `steer` accept (characters). */
export const PLUGIN_TEXT_MAX = 100_000;
/** The longest grant label (characters). */
export const GRANT_LABEL_MAX = 80;

export interface RawAgentBackendInfo {
  /** The backend factory kind (D80), for example the Claude Code factory's kind. */
  kind: string;
  /** The backend's own name for labels. */
  displayName: string;
  /** The agent's version, once a process reported it. */
  version?: string;
}

/** What other plugins may know about one of our sessions. */
export interface RawAgentSessionInfo {
  sessionId: string;
  backend: RawAgentBackendInfo;
  /** The agent process: none yet (or ended), starting, or running. */
  process: 'none' | 'starting' | 'running';
  /** Shorthand: `process === 'running'`. */
  running: boolean;
  /** A DSH turn of this session is running. */
  busy: boolean;
  /** Background tasks (agents, workflows, shells) of the process. */
  backgroundTasks: number;
  /** Asks (permission, question, plan, …) waiting for the user. */
  waitingForUser: number;
  /** The permission mode the agent reports (or the one picked before the start). */
  mode?: string;
  /** The model the agent reports. */
  model?: string;
  /** The agent's own session id (its transcript id), once known. */
  backendSessionId?: string;
}

/** Usage numbers as the agent reports them (D57-D60); absent fields are unknown, never 0. */
export interface RawAgentUsageInfo {
  tokens?: number;
  costUsd?: number;
  /** How the cost was found (the agent's report, an estimate, …). */
  costLabel?: string;
  context?: { used: number; window: number; percent: number };
  compacting: boolean;
  /** The plan window with the highest share (subscription accounts only). */
  limit?: { id: string; label: string; percent?: number; resetsAt?: number; status?: string };
  limitsAvailable?: boolean;
}

export interface RawAgentWorkflowInfo {
  taskId: string;
  runId: string;
  name: string;
  status: string;
  phases: Array<{ index: number; title: string }>;
  agents: Array<{ index: number; label: string; state: string; phaseIndex?: number; tokens?: number }>;
  startedAt: number;
  endedAt?: number;
}

export interface RawAgentChildInfo {
  id: string;
  parent: string;
  label: string;
  status: string;
  background: boolean;
  /** The DSH child session, once it exists (read its native log for the content). */
  hostSessionId?: string;
  tokens?: number;
}

/** An ask that waits for the user. Its choices and any answer are never exposed (D66). */
export interface RawAgentAskInfo {
  id: string;
  kind: string;
  agent: 'main' | 'child';
  title: string;
  at: number;
}

export type RawAgentPublicEvent =
  | { type: 'state'; sessionId: string; info: RawAgentSessionInfo }
  | { type: 'usage'; sessionId: string; usage: RawAgentUsageInfo }
  | { type: 'workflows'; sessionId: string; runs: RawAgentWorkflowInfo[] }
  | { type: 'children'; sessionId: string; children: RawAgentChildInfo[] }
  | { type: 'asks'; sessionId: string; asks: RawAgentAskInfo[] }
  /** The Host no longer holds this session (it was closed or the plugin was disabled). */
  | { type: 'ended'; sessionId: string };

export type RawAgentPublicEventType = RawAgentPublicEvent['type'];

/** Why a service call was refused. */
export type RawAgentErrorCode =
  /** The session is not a session of this plugin (or not open). */
  | 'not-our-session'
  /** No grant token was given. */
  | 'no-grant'
  /** The token names no grant (wrong, or revoked by the user). */
  | 'bad-grant'
  /** The agent has no running process; the user must start it first (no hidden process, rule 9). */
  | 'not-running'
  | 'empty'
  | 'too-long'
  /** Another side question is still open. */
  | 'busy'
  /** This backend or version cannot do it. */
  | 'unsupported'
  /** The call reached the plugin, but DSH or the agent refused or failed it. */
  | 'failed';

export class RawAgentServiceError extends Error {
  override readonly name = 'RawAgentServiceError';
  constructor(
    readonly code: RawAgentErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** True for a `RawAgentServiceError`, also one from another bundle's copy of this module. */
export function isRawAgentServiceError(e: unknown): e is RawAgentServiceError {
  return e instanceof Error && e.name === 'RawAgentServiceError' && typeof (e as { code?: unknown }).code === 'string';
}

/** The Host service (`ctx.rawAgent`). */
export interface RawAgentService {
  readonly apiVersion: 1;
  /** The backends this plugin runs (one agent preset each). */
  readonly backends: readonly RawAgentBackendInfo[];
  /** Undefined when the session is not one of ours. Never starts a process. */
  sessionInfo(sessionId: string): Promise<RawAgentSessionInfo | undefined>;
  /** Stop the running turn, as DSH's Stop does. The process and its background tasks keep running. */
  interrupt(sessionId: string): Promise<void>;
  /**
   * Plugin-only data of one session (not in the native log). The listener gets the current
   * state at once and then each change. Returns the unsubscribe function.
   */
  onEvent(sessionId: string, listener: (e: RawAgentPublicEvent) => void): () => void;
  /** Queue a message as a new turn. Needs a grant token (D66). Resolves with the message id. */
  send(sessionId: string, text: string, grant: string): Promise<{ messageId: string }>;
  /** Add a message to the running turn (or start one). Needs a grant token (D66). */
  steer(sessionId: string, text: string, grant: string): Promise<{ messageId: string }>;
  /**
   * A side question (`/btw`): full context, no tools, nothing written to any log. Needs a grant
   * token and a running process. `null`: the agent gave no answer.
   */
  askSideQuestion(sessionId: string, question: string, grant: string): Promise<string | null>;
}

/** The Client service (`ctx.rawAgentClient`): the same calls over the plugin's routes, plus `prefill`. */
export interface RawAgentClientService extends RawAgentService {
  /**
   * Put text into our composer (`'composer'`, at the caret) or into the side-question box
   * (`'side-question'`). Nothing is sent until the user presses Enter. Needs no grant.
   * Resolves `false` when the session is not one of ours.
   */
  prefill(sessionId: string, text: string, target?: 'composer' | 'side-question'): Promise<boolean>;
}

// ---- pure helpers shared by the Host and the Client ----

/** The parts of a session view (Host `SessionView`, Client `SessionViewWire`) the API reads. */
export interface PublicViewInput {
  state: { process: 'none' | 'starting' | 'running'; turn: boolean; backgroundTasks: number; waiting?: number };
  live: { model?: string; mode?: string; version?: string };
  choice?: { pendingMode?: string };
  backendSessionId?: string;
  usage?: {
    tokens?: number;
    costUsd?: number;
    costLabel?: string;
    compacting: boolean;
    context?: { used: number; window: number; percent: number };
    limitsAvailable?: boolean;
    limit?: { id: string; label: string; percent?: number; resetsAt?: number; status?: string };
  };
  workflows?: ReadonlyArray<{
    taskId: string;
    runId: string;
    name: string;
    status: string;
    phases: ReadonlyArray<{ index: number; title: string }>;
    agents: ReadonlyArray<{ index: number; label: string; state: string; phaseIndex?: number; tokens?: number }>;
    startedAt: number;
    endedAt?: number;
  }>;
  children?: ReadonlyArray<{
    id: string;
    parent: string;
    label: string;
    status: string;
    background: boolean;
    hostSessionId?: string;
    tokens?: number;
  }>;
  asks?: ReadonlyArray<{ id: string; kind: string; agent: 'main' | 'child'; title: string; at: number }>;
}

const put = <T extends object, K extends keyof T>(o: T, k: K, v: T[K] | undefined): void => {
  if (v !== undefined) o[k] = v;
};

export function sessionInfoFromView(
  sessionId: string,
  backend: RawAgentBackendInfo,
  view: PublicViewInput,
): RawAgentSessionInfo {
  const b: RawAgentBackendInfo = { kind: backend.kind, displayName: backend.displayName };
  put(b, 'version', view.live.version ?? backend.version);
  const info: RawAgentSessionInfo = {
    sessionId,
    backend: b,
    process: view.state.process,
    running: view.state.process === 'running',
    busy: view.state.turn,
    backgroundTasks: view.state.backgroundTasks,
    waitingForUser: view.state.waiting ?? view.asks?.length ?? 0,
  };
  put(info, 'mode', view.live.mode ?? view.choice?.pendingMode);
  put(info, 'model', view.live.model);
  put(info, 'backendSessionId', view.backendSessionId);
  return info;
}

function usageOf(u: NonNullable<PublicViewInput['usage']>): RawAgentUsageInfo {
  const out: RawAgentUsageInfo = { compacting: u.compacting === true };
  put(out, 'tokens', u.tokens);
  put(out, 'costUsd', u.costUsd);
  put(out, 'costLabel', u.costLabel);
  if (u.context) out.context = { used: u.context.used, window: u.context.window, percent: u.context.percent };
  if (u.limit) {
    const l: NonNullable<RawAgentUsageInfo['limit']> = { id: u.limit.id, label: u.limit.label };
    put(l, 'percent', u.limit.percent);
    put(l, 'resetsAt', u.limit.resetsAt);
    put(l, 'status', u.limit.status);
    out.limit = l;
  }
  put(out, 'limitsAvailable', u.limitsAvailable);
  return out;
}

function workflowsOf(list: NonNullable<PublicViewInput['workflows']>): RawAgentWorkflowInfo[] {
  return list.map((w) => {
    const r: RawAgentWorkflowInfo = {
      taskId: w.taskId,
      runId: w.runId,
      name: w.name,
      status: w.status,
      phases: w.phases.map((p) => ({ index: p.index, title: p.title })),
      agents: w.agents.map((a) => {
        const row: RawAgentWorkflowInfo['agents'][number] = { index: a.index, label: a.label, state: a.state };
        put(row, 'phaseIndex', a.phaseIndex);
        put(row, 'tokens', a.tokens);
        return row;
      }),
      startedAt: w.startedAt,
    };
    put(r, 'endedAt', w.endedAt);
    return r;
  });
}

function childrenOf(list: NonNullable<PublicViewInput['children']>): RawAgentChildInfo[] {
  return list.map((c) => {
    const r: RawAgentChildInfo = {
      id: c.id,
      parent: c.parent,
      label: c.label,
      status: c.status,
      background: c.background,
    };
    put(r, 'hostSessionId', c.hostSessionId);
    put(r, 'tokens', c.tokens);
    return r;
  });
}

/** Only the id, kind, who asked, the title and the time: never the choices, a form or an answer. */
function asksOf(list: NonNullable<PublicViewInput['asks']>): RawAgentAskInfo[] {
  return list.map((a) => ({ id: a.id, kind: a.kind, agent: a.agent, title: a.title, at: a.at }));
}

/**
 * Turns successive views of one session into public events. Each kind of event is sent when its
 * content changed (the first view sends every kind the view has, and `state` always).
 */
export class PublicEventTracker {
  readonly #sessionId: string;
  readonly #backend: RawAgentBackendInfo;
  readonly #last = new Map<RawAgentPublicEventType, string>();
  #ended = false;

  constructor(sessionId: string, backend: RawAgentBackendInfo) {
    this.#sessionId = sessionId;
    this.#backend = backend;
  }

  update(view: PublicViewInput): RawAgentPublicEvent[] {
    if (this.#ended) return [];
    const id = this.#sessionId;
    const candidates: RawAgentPublicEvent[] = [
      { type: 'state', sessionId: id, info: sessionInfoFromView(id, this.#backend, view) },
    ];
    if (view.usage) candidates.push({ type: 'usage', sessionId: id, usage: usageOf(view.usage) });
    if (view.workflows || this.#last.has('workflows'))
      candidates.push({ type: 'workflows', sessionId: id, runs: workflowsOf(view.workflows ?? []) });
    if (view.children || this.#last.has('children'))
      candidates.push({ type: 'children', sessionId: id, children: childrenOf(view.children ?? []) });
    if (view.asks || this.#last.has('asks'))
      candidates.push({ type: 'asks', sessionId: id, asks: asksOf(view.asks ?? []) });
    const out: RawAgentPublicEvent[] = [];
    for (const e of candidates) {
      const key = JSON.stringify(e);
      if (this.#last.get(e.type) === key) continue;
      this.#last.set(e.type, key);
      out.push(e);
    }
    return out;
  }

  /** The session went away: one `ended` event, then nothing. */
  end(): RawAgentPublicEvent[] {
    if (this.#ended) return [];
    this.#ended = true;
    return [{ type: 'ended', sessionId: this.#sessionId }];
  }
}

/** A plain trimmed label for a grant, or why it is refused. */
export function checkGrantLabel(label: unknown): { ok: true; label: string } | { ok: false; error: string } {
  if (typeof label !== 'string') return { ok: false, error: 'the label must be text' };
  const l = label.replace(/\s+/g, ' ').trim();
  if (l === '') return { ok: false, error: 'Name the plugin this grant is for.' };
  if (l.length > GRANT_LABEL_MAX) return { ok: false, error: `The name is longer than ${GRANT_LABEL_MAX} characters.` };
  return { ok: true, label: l };
}
