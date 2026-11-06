// The plugin's own Host routes, seen from the browser (D62). Relative URLs (`api/raw-agent/…`),
// so DSH's `--public-url` prefixes and its cookie auth apply. No backend names here (D80): labels
// come from the Host.

import type {
  AgentInfo,
  AuthInfo,
  ConfigFileInfo,
  ContextCategory,
  CostLabel,
  PlanLimit,
  PlanLimits,
  TurnUsage,
  UsageTotals,
  EffortInfo,
  ModelInfo,
  PermissionModeInfo,
  SessionChoiceRequest,
  SettingsDefaults,
} from '@dsh-raw-agent/core';

export type FetchFn = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  /** The response body as a byte stream (the interaction channel reads it line by line). */
  body?: ReadableStream<Uint8Array> | null;
}>;

/** Mirrors dsh-host `SessionView` (wire shape; kept structural on purpose). */
export interface SessionViewWire {
  state: {
    process: 'none' | 'starting' | 'running';
    turn: boolean;
    backgroundTasks: number;
    waiting?: number;
    lastExit?: { error?: string; at: number; duringTurn: boolean };
  };
  live: {
    model?: string;
    mode?: string;
    version?: string;
    notice?: { level: string; text: string; at: number };
    /** D15: the main-thread agent the process runs with. */
    agent?: string;
    /** D37: the agent's own ultracode state, once the live process reported it. */
    ultracode?: { on: boolean; requested?: boolean; available?: boolean };
  };
  choice: {
    model?: string;
    effort?: string;
    pendingMode?: string;
    applied: { model?: string; effort?: string };
    refused?: { model: string };
    resetPending: boolean;
    /** D15, D51: the main-thread agent picked for this new session. */
    agent?: string;
    /** The main-thread agent cannot change any more (the session had a turn). */
    agentLocked?: boolean;
  };
  models?: ModelInfo[];
  cwd?: string;
  /** Asks waiting for the user's answer; the Host never answers them itself. */
  asks?: AskWire[];
  /** Child agents of this session (D45, D46): the tree and per-child rows. */
  children?: ChildWire[];
  /** The team roster (D50). */
  team?: TeamWire;
  /** Background tasks (D47), including the plugin-only rows past the host's job limit. */
  tasks?: TaskWire[];
  /** D51: the agents the live process lists. */
  agents?: AgentInfo[];
  /** D48: dynamic workflow runs of this process (phases, agents, tokens, status). */
  workflows?: WorkflowWire[];
  /** D48: the agent can stop one workflow agent on its own (else only the whole run). */
  workflowAgentStop?: boolean;
  /** M5: the context pill's data and short usage totals (mirrors dsh-host `UsageSummary`). */
  usage?: UsageSummaryWire;
}

/** The agent's context figure (mirrors dsh-host `ContextView`, D59). */
export interface ContextViewWire {
  used: number;
  window: number;
  autoCompactAt?: number;
  autoCompactEnabled?: boolean;
  percent: number;
  categories?: ContextCategory[];
  model?: string;
  /** 'call': the last model call's usage; 'report': the agent's own report; 'compaction': after one. */
  source: 'call' | 'report' | 'compaction';
  at: number;
}

/** The small usage part of the session view (mirrors dsh-host `UsageSummary`). */
export interface UsageSummaryWire {
  context?: Pick<ContextViewWire, 'used' | 'window' | 'percent' | 'autoCompactAt' | 'source' | 'at'>;
  compacting: boolean;
  tokens?: number;
  costUsd?: number;
  costLabel?: CostLabel;
  limitsAvailable?: boolean;
  blocked?: boolean;
  limit?: Pick<PlanLimit, 'id' | 'label' | 'percent' | 'resetsAt' | 'status'>;
  auth?: Pick<AuthInfo, 'kind' | 'label'>;
  retry?: { attempt: number; maxRetries?: number; error: string; at: number };
  at?: number;
}

/** One per-turn row (mirrors dsh-host `TurnUsageRow`). No `hostTurn`: it ran outside a turn. */
export interface TurnUsageRowWire {
  hostTurn?: number;
  usage: TurnUsage;
  at: number;
}

/** Everything the usage panel shows (mirrors dsh-host `UsageView`). Absent: not known yet. */
export interface UsageViewWire {
  totals?: UsageTotals;
  costLabel?: CostLabel;
  auth?: AuthInfo;
  limits?: PlanLimits;
  lastTurn?: TurnUsageRowWire;
  turns: TurnUsageRowWire[];
  context?: ContextViewWire;
  compacting: boolean;
  compactions: Array<{
    phase: 'start' | 'end';
    trigger?: 'manual' | 'auto';
    preTokens?: number;
    postTokens?: number;
    error?: string;
    at: number;
  }>;
  retries: Array<{
    attempt: number;
    maxRetries?: number;
    delayMs?: number;
    error: string;
    httpStatus?: number;
    hostTurn?: number;
    at: number;
  }>;
  resets: Array<{ trigger?: string; hostTurn?: number; at: number }>;
  at?: number;
}

/** `GET api/raw-agent/usage` (D58-D60). Never starts a process. */
export interface UsageAnswerWire {
  running: boolean;
  usage: UsageViewWire;
  /** The live process's usage control could not be read. */
  error?: string;
}

/** `GET api/raw-agent/context` (D59). Never starts a process. */
export interface ContextAnswerWire {
  running: boolean;
  context?: ContextViewWire;
  /** 'not-running', 'unsupported' or the agent's error, when no live report was read. */
  reason?: string;
}

/** One workflow agent row (mirrors core `WorkflowAgent` plus the host's child session). */
export interface WorkflowAgentWire {
  index: number;
  label: string;
  state: 'queued' | 'running' | 'done' | 'error' | 'stopped';
  rawState?: string;
  phaseIndex?: number;
  phaseTitle?: string;
  /** The agent's child id (same as its child row's id), once it started. */
  agentId?: string;
  attempt?: number;
  model?: string;
  agentType?: string;
  tokens?: number;
  toolCalls?: number;
  lastToolName?: string;
  lastToolSummary?: string;
  queuedAt?: number;
  startedAt?: number;
  lastProgressAt?: number;
  durationMs?: number;
  promptPreview?: string;
  resultPreview?: string;
  error?: string;
  cached?: boolean;
  blocked?: boolean;
  /** The agent's host child session, once its member record is written. */
  childSessionId?: string;
}

/** One workflow run (mirrors dsh-host `WorkflowView`). */
export interface WorkflowWire {
  /** The run's task id: "Stop entire workflow" names it. */
  taskId: string;
  /** The id of the native `tool-workflow/*` records (the chat node matches it). */
  runId: string;
  name: string;
  label?: string;
  status: 'starting' | 'running' | 'completed' | 'cancelled' | 'error';
  stopping?: boolean;
  phases: Array<{ index: number; title: string }>;
  agents: WorkflowAgentWire[];
  usage?: { tokens?: number; toolUses?: number; durationMs?: number };
  callId?: string;
  startedAt: number;
  endedAt?: number;
  summary?: string;
}

/** `GET api/raw-agent/task-output`: the end of one background shell's or monitor's output. */
export interface TaskOutputWire {
  output: string;
  totalBytes: number;
  truncated: boolean;
}

export type ChildStatusWire = 'starting' | 'running' | 'completed' | 'failed' | 'stopped';

/** One child agent row (mirrors dsh-host `ChildView`). */
export interface ChildWire {
  id: string;
  /** `'main'` or the parent child's id. */
  parent: string;
  label: string;
  role: 'subagent' | 'teammate' | 'workflow-agent';
  status: ChildStatusWire;
  background: boolean;
  depth: number;
  agentType?: string;
  name?: string;
  team?: string;
  hostSessionId?: string;
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
  startedAt: number;
  endedAt?: number;
  summary?: string;
  wakes: number;
  wokenBy?: string;
  inputs: number;
  stopping?: boolean;
  noSession?: boolean;
  /** The parent's tool call that started the child (D77). */
  callId?: string;
  /** The child's latest output line (R6.1). */
  last?: { kind: 'text' | 'reasoning' | 'tool'; text: string; at: number };
}

export interface TeamMessageWire {
  from: string;
  to: string;
  text: string;
  summary?: string;
  /** `'main'` or a child id. */
  sender: string;
  at: number;
}

/** The team roster model (mirrors dsh-host `TeamView`). */
export interface TeamWire {
  teams: Array<{ name: string; members: string[] }>;
  messages: TeamMessageWire[];
  /** The agent takes messages from the user to a teammate (D50). */
  messaging: boolean;
}

/** One background task row (mirrors dsh-host `TaskView`). */
export interface TaskWire {
  taskId: string;
  kind: string;
  label: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  progress?: string;
  /** A host job mirrors it; false: only this row does. */
  job: boolean;
  note?: string;
  /** The child agent this task runs. */
  agent?: string;
}

/** What `GET api/raw-agent/child-of` answers for a host child session (D45). */
export interface ChildLinkWire {
  parentSession: string;
  childId: string;
}

/** One choice of an ask (mirrors dsh-host `AskChoice`). */
export interface AskChoiceWire {
  id: string;
  label: string;
  /** Permission option kind (`allow-once`, `allow-always`, `reject-once`, …). */
  kind?: string;
  /** Where an "always" choice is saved, in plain words. */
  destination?: string;
  /** What an "always" choice saves, one line each (the exact rule text). */
  effects?: string[];
  /** The choice takes an optional typed text (reject with feedback, keep planning). */
  feedback?: boolean;
  feedbackPlaceholder?: string;
  /** `submits`: the choice needs a filled form (question answers, elicitation content). */
  submits?: 'answers' | 'content';
  /** With `submits: 'answers'`: a partly filled or empty form is fine ("Chat about this"). */
  partial?: boolean;
  /** An "always" choice whose rule the user may edit first (the agent's own suggestion). */
  editable?: { value: string; placeholder?: string; toolName: string };
}

/** One question of an AskUserQuestion ask (core `QuestionItem`). */
export interface QuestionWire {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: Array<{ label: string; description?: string; preview?: string }>;
  allowsOther: boolean;
}

/** The data a card renders (mirrors dsh-host `AskForm`). */
export type AskFormWire =
  | {
      type: 'permission';
      toolName: string;
      displayName?: string;
      input?: unknown;
      inputTruncated?: boolean;
      description?: string;
      reason?: string;
      blockedPath?: string;
      defaultToNo?: boolean;
      mcpServer?: { name: string; source: string };
    }
  | { type: 'question'; questions: QuestionWire[]; previewFormat: 'markdown' | 'html'; otherLabel: string }
  | { type: 'plan'; plan: string; planFilePath?: string }
  | {
      type: 'elicitation';
      serverName: string;
      message: string;
      mode: 'form' | 'url';
      url?: string;
      requestedSchema?: unknown;
      title?: string;
      displayName?: string;
      description?: string;
    }
  | { type: 'trust'; directory: string; body: string };

/** One pending ask (mirrors dsh-host `AskView`). */
export interface AskWire {
  id: string;
  kind: 'permission' | 'question' | 'plan' | 'elicitation' | 'trust';
  agent: 'main' | 'child';
  /** The subagent's id and label, when a subagent asked (D77). */
  agentId?: string;
  agentLabel?: string;
  /** The tool call the ask is about (D77). */
  callId?: string;
  title: string;
  detail?: string;
  choices: AskChoiceWire[];
  stopChoice: string;
  /** `waiting`: an accepted URL elicitation the agent has not finished yet (D43). */
  state?: 'waiting';
  form?: AskFormWire;
  at: number;
}

/** The user's answer to one ask (`POST …/answer`); only `choice` is required. */
export interface AskReplyWire {
  choice: string;
  feedback?: string;
  answers?: Record<string, string | string[]>;
  notes?: Record<string, string>;
  content?: Record<string, unknown>;
  /** The edited rule of an `editable` choice (only when changed). */
  rule?: string;
}

/** A mode the session cannot pick now, and the backend option that unlocks it (D38 r4). */
export interface UnavailableModeWire extends PermissionModeInfo {
  optionLabel?: string;
}

/** One line of `GET api/raw-agent/interactions` (D39). */
export type ChannelLine =
  | {
      type: 'asks';
      asks: AskWire[];
      state?: SessionViewWire['state'];
      live?: SessionViewWire['live'];
      /** Present when the Host sends the agent rows on the channel (R6.1-R6.3). */
      agents?: { children: ChildWire[]; team?: TeamWire; tasks: TaskWire[] };
      /** Present when the Host sends the workflow runs on the channel (D48). */
      workflows?: WorkflowWire[];
      /** M5: the usage summary; `null` = nothing known yet, absent = an older Host line. */
      usage?: UsageSummaryWire | null;
    }
  | { type: 'ping' };

/** `GET api/raw-agent/session` */
export interface SessionInfo {
  backend: { kind: string; displayName: string };
  permissionModes: PermissionModeInfo[];
  /** Modes the session cannot pick now (D38 r4); shown greyed out with their reason. */
  unavailableModes?: UnavailableModeWire[];
  /** The agent's "next mode" key order (D38; Claude: Shift+Tab). */
  permissionModeCycle?: string[];
  efforts: EffortInfo[];
  needsProcess: string[];
  models: ModelInfo[];
  modelsFrom: 'session' | 'recent' | 'none';
  /** D15, D51: when the main-thread agent can be picked. */
  mainAgentPicker?: 'new-session-only' | 'any-time' | 'none';
  /** D51: the agents to pick from (the live process's list, or a recent one for this folder). */
  agents?: AgentInfo[];
  agentsFrom?: 'session' | 'recent' | 'none';
  settings?: SettingsDefaults;
  /** Present when the agent does not trust the session folder yet (R1.2, D73). */
  trust?: { state: string; directory: string; effect?: string };
  view: SessionViewWire;
}

/** `POST api/raw-agent/choice` */
export interface ChoiceResponse {
  ok: boolean;
  note?: string;
  error?: string;
  session?: SessionInfo;
}

export interface ConfigFileItem extends ConfigFileInfo {
  exists: boolean;
}

export interface ConfigFilePreviewWire extends ConfigFileInfo {
  exists: boolean;
  masked?: string;
  secrets?: Array<{ start: number; end: number; key?: string }>;
  mtimeMs?: number;
  size?: number;
  tooLarge?: boolean;
  error?: string;
}

/** The value `"settings"` means "your own settings" for model and effort (D35). */
export const SETTINGS = 'settings';

const BASE = 'api/raw-agent';

export class RouteError extends Error {
  override readonly name = 'RouteError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function read<T>(fetchFn: FetchFn, url: string, init?: Parameters<FetchFn>[1]): Promise<T> {
  const r = await fetchFn(url, init);
  const body = (await r.json().catch(() => undefined)) as { error?: unknown } | undefined;
  if (!r.ok) {
    const message = typeof body?.error === 'string' ? body.error : `request failed (${r.status})`;
    throw new RouteError(r.status, message);
  }
  return body as T;
}

const q = (sessionId: string) => `session=${encodeURIComponent(sessionId)}`;

/** A steer the agent did not run after Stop (D25); its text goes back to the composer. */
export interface ReturnedDraftWire {
  messageId: string;
  text: string;
  at: number;
  /** Images and files of the message; they cannot go back into the composer. */
  attachments?: number;
}

export interface RawAgentApi {
  session(sessionId: string): Promise<SessionInfo>;
  /** `GET api/raw-agent/state`: the returned drafts are handed out once. */
  state(sessionId: string): Promise<{ returnedDrafts: ReturnedDraftWire[] }>;
  choose(sessionId: string, choice: SessionChoiceRequest): Promise<ChoiceResponse>;
  start(sessionId: string): Promise<void>;
  /** The user's answer to one pending ask: a bare choice id, or a reply with its form. */
  answer(
    sessionId: string,
    askId: string,
    reply: string | AskReplyWire,
  ): Promise<{ ok: boolean; error?: string; gone?: boolean; session?: SessionInfo }>;
  /**
   * Read the interaction channel (D39) until it ends or `signal` aborts. Each parsed line goes to
   * `onLine`. Rejects with a RouteError for a non-200 answer.
   */
  interactions(sessionId: string, signal: AbortSignal, onLine: (line: ChannelLine) => void): Promise<void>;
  /** D46: stop one child agent; the others keep running. */
  stopChild(sessionId: string, childId: string): Promise<{ ok: boolean; status?: string; error?: string }>;
  /** D47: stop one background task. */
  stopTask(sessionId: string, taskId: string): Promise<{ ok: boolean; error?: string }>;
  /** D48: "Stop entire workflow" (the run's task id). */
  stopWorkflow(sessionId: string, taskId: string): Promise<{ ok: boolean; status?: string; error?: string }>;
  /** D48: stop one workflow agent; `unsupported` when the agent cannot do that. */
  stopWorkflowAgent(
    sessionId: string,
    taskId: string,
    agentId: string,
  ): Promise<{ ok: boolean; status?: string; error?: string; unsupported?: boolean }>;
  /** R6.2: the output of one background shell or monitor of this session (running or ended). */
  taskOutput(sessionId: string, taskId: string): Promise<TaskOutputWire>;
  /** D45: which of our sessions holds this host child session; undefined when none does. */
  childOf(childSessionId: string): Promise<ChildLinkWire | undefined>;
  /** M5: the usage panel's data (D58-D60). Reads only; never starts a process. */
  usage(sessionId: string): Promise<UsageAnswerWire>;
  /** M5: the agent's context report (D59); `full` adds the agent's whole breakdown. Never spawns. */
  context(sessionId: string, detail?: 'summary' | 'full'): Promise<ContextAnswerWire>;
  configFiles(sessionId: string): Promise<{ backend: string; files: ConfigFileItem[] }>;
  configFile(sessionId: string, scope: string): Promise<ConfigFilePreviewWire>;
  reveal(sessionId: string, scope: string, index: number): Promise<{ index: number; key?: string; value: string }>;
}

export function createApi(fetchFn: FetchFn): RawAgentApi {
  const post = (body?: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return {
    session: (id) => read<SessionInfo>(fetchFn, `${BASE}/session?${q(id)}`),
    async state(id) {
      const body = await read<{ returnedDrafts?: unknown }>(fetchFn, `${BASE}/state?${q(id)}`);
      const list = Array.isArray(body?.returnedDrafts) ? body.returnedDrafts : [];
      return {
        returnedDrafts: list.filter(
          (d): d is ReturnedDraftWire => typeof d === 'object' && d !== null && typeof d.text === 'string',
        ),
      };
    },
    async choose(id, choice) {
      const r = await fetchFn(`${BASE}/choice?${q(id)}`, post(choice));
      const body = (await r.json().catch(() => undefined)) as ChoiceResponse | { error?: string } | undefined;
      if (r.status === 409 && body && 'ok' in body) return body;
      if (!r.ok) throw new RouteError(r.status, body?.error ?? `request failed (${r.status})`);
      return body as ChoiceResponse;
    },
    async start(id) {
      await read(fetchFn, `${BASE}/start?${q(id)}`, post());
    },
    async answer(id, ask, reply) {
      const r = await fetchFn(
        `${BASE}/answer?${q(id)}`,
        post(typeof reply === 'string' ? { ask, choice: reply } : { ...reply, ask }),
      );
      const body = (await r.json().catch(() => undefined)) as
        { ok?: boolean; error?: string; session?: SessionInfo } | undefined;
      // 409: another browser answered first, or the agent withdrew it; 400: the form does not fit.
      if ((r.status === 409 || r.status === 400) && body && body.ok === false)
        return {
          ok: false,
          error: body.error ?? 'that question is no longer open',
          ...(r.status === 409 ? { gone: true } : {}),
          ...(body.session ? { session: body.session } : {}),
        };
      if (r.status === 409 && body)
        return {
          ok: false,
          gone: true,
          error: body.error ?? 'that question is no longer open',
          ...(body.session ? { session: body.session } : {}),
        };
      if (!r.ok) throw new RouteError(r.status, body?.error ?? `request failed (${r.status})`);
      return { ok: true, ...(body?.session ? { session: body.session } : {}) };
    },
    async interactions(id, signal, onLine) {
      const r = await fetchFn(`${BASE}/interactions?${q(id)}`, { signal });
      if (!r.ok) {
        const body = (await r.json().catch(() => undefined)) as { error?: unknown } | undefined;
        throw new RouteError(r.status, typeof body?.error === 'string' ? body.error : `request failed (${r.status})`);
      }
      if (!r.body) throw new RouteError(r.status, 'the interaction channel has no body');
      await readLines(r.body, signal, (text) => {
        const line = parseChannelLine(text);
        if (line) onLine(line);
      });
    },
    async stopChild(id, child) {
      const r = await fetchFn(`${BASE}/child-stop?${q(id)}&child=${encodeURIComponent(child)}`, post());
      const body = (await r.json().catch(() => undefined)) as
        { ok?: boolean; status?: string; error?: string } | undefined;
      if (r.ok) return { ok: body?.ok !== false, ...(body?.status ? { status: body.status } : {}) };
      return {
        ok: false,
        error: body?.error ?? `request failed (${r.status})`,
        ...(body?.status ? { status: body.status } : {}),
      };
    },
    async stopTask(id, task) {
      const r = await fetchFn(`${BASE}/task-stop?${q(id)}&task=${encodeURIComponent(task)}`, post());
      const body = (await r.json().catch(() => undefined)) as { ok?: boolean; error?: string } | undefined;
      if (r.ok) return { ok: body?.ok !== false };
      return { ok: false, error: body?.error ?? `request failed (${r.status})` };
    },
    async stopWorkflow(id, task) {
      const r = await fetchFn(`${BASE}/workflow-stop?${q(id)}&task=${encodeURIComponent(task)}`, post());
      const body = (await r.json().catch(() => undefined)) as
        { ok?: boolean; status?: string; error?: string } | undefined;
      const status = typeof body?.status === 'string' ? { status: body.status } : {};
      if (r.ok) return { ok: body?.ok !== false, ...status };
      return { ok: false, error: body?.error ?? `request failed (${r.status})`, ...status };
    },
    async stopWorkflowAgent(id, task, agent) {
      const r = await fetchFn(
        `${BASE}/workflow-agent-stop?${q(id)}&task=${encodeURIComponent(task)}&agent=${encodeURIComponent(agent)}`,
        post(),
      );
      const body = (await r.json().catch(() => undefined)) as
        { ok?: boolean; status?: string; error?: string; unsupported?: boolean } | undefined;
      const status = typeof body?.status === 'string' ? { status: body.status } : {};
      if (r.ok) return { ok: body?.ok !== false, ...status };
      return {
        ok: false,
        error: body?.error ?? `request failed (${r.status})`,
        ...status,
        ...(body?.unsupported === true ? { unsupported: true } : {}),
      };
    },
    async taskOutput(id, task) {
      const body = await read<Partial<TaskOutputWire>>(
        fetchFn,
        `${BASE}/task-output?${q(id)}&task=${encodeURIComponent(task)}`,
      );
      return {
        output: typeof body?.output === 'string' ? body.output : '',
        totalBytes: typeof body?.totalBytes === 'number' ? body.totalBytes : 0,
        truncated: body?.truncated === true,
      };
    },
    async childOf(id) {
      const r = await fetchFn(`${BASE}/child-of?${q(id)}`);
      if (r.status === 404) return undefined;
      const body = (await r.json().catch(() => undefined)) as (Partial<ChildLinkWire> & { error?: string }) | undefined;
      if (!r.ok) throw new RouteError(r.status, body?.error ?? `request failed (${r.status})`);
      if (typeof body?.parentSession !== 'string' || typeof body.childId !== 'string')
        throw new RouteError(r.status, 'the answer names no parent session');
      return { parentSession: body.parentSession, childId: body.childId };
    },
    async usage(id) {
      const body = await read<Partial<UsageAnswerWire>>(fetchFn, `${BASE}/usage?${q(id)}`);
      return parseUsageAnswer(body);
    },
    async context(id, detail = 'summary') {
      const body = await read<Partial<ContextAnswerWire>>(fetchFn, `${BASE}/context?${q(id)}&detail=${detail}`);
      const out: ContextAnswerWire = { running: body?.running === true };
      const c = parseContextView(body?.context);
      if (c) out.context = c;
      if (typeof body?.reason === 'string') out.reason = body.reason;
      return out;
    },
    configFiles: (id) => read(fetchFn, `${BASE}/config-files?${q(id)}`),
    configFile: (id, scope) => read(fetchFn, `${BASE}/config-file?${q(id)}&scope=${encodeURIComponent(scope)}`),
    reveal: (id, scope, index) =>
      read(fetchFn, `${BASE}/config-file?${q(id)}&scope=${encodeURIComponent(scope)}&reveal=${index}`),
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A context figure from the wire, or undefined when it is not a usable one (never a made-up 0). */
export function parseContextView(v: unknown): ContextViewWire | undefined {
  if (!isObj(v) || !finite(v.used) || !finite(v.window) || v.window <= 0 || v.used < 0) return undefined;
  const source = v.source === 'report' || v.source === 'compaction' ? v.source : 'call';
  const out: ContextViewWire = {
    used: v.used,
    window: v.window,
    percent: finite(v.percent) ? v.percent : Math.round((v.used / v.window) * 1000) / 10,
    source,
    at: finite(v.at) ? v.at : 0,
  };
  if (finite(v.autoCompactAt)) out.autoCompactAt = v.autoCompactAt;
  if (typeof v.autoCompactEnabled === 'boolean') out.autoCompactEnabled = v.autoCompactEnabled;
  if (typeof v.model === 'string') out.model = v.model;
  if (Array.isArray(v.categories))
    out.categories = v.categories.filter(
      (c): c is ContextCategory => isObj(c) && typeof c.name === 'string' && finite(c.tokens),
    );
  return out;
}

/** The usage route's answer, with every list present (an older or partial answer stays usable). */
export function parseUsageAnswer(body: Partial<UsageAnswerWire> | undefined): UsageAnswerWire {
  const u: Partial<UsageViewWire> = isObj(body?.usage) ? (body.usage as Partial<UsageViewWire>) : {};
  const list = <T>(x: T[] | undefined): T[] => (Array.isArray(x) ? x : []);
  const usage: UsageViewWire = {
    ...u,
    turns: list(u.turns).filter((t) => isObj(t) && isObj(t.usage)),
    compacting: u.compacting === true,
    compactions: list(u.compactions),
    retries: list(u.retries),
    resets: list(u.resets),
  };
  const ctx = parseContextView(u.context);
  if (ctx) usage.context = ctx;
  else delete usage.context;
  const out: UsageAnswerWire = { running: body?.running === true, usage };
  if (typeof body?.error === 'string') out.error = body.error;
  return out;
}

/** Parse one NDJSON line of the interaction channel; anything else is ignored. */
export function parseChannelLine(text: string): ChannelLine | undefined {
  const t = text.trim();
  if (t === '') return undefined;
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch {
    return undefined;
  }
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as { type?: unknown; asks?: unknown; state?: unknown };
  if (o.type === 'ping') return { type: 'ping' };
  if (o.type !== 'asks' || !Array.isArray(o.asks)) return undefined;
  const asks = o.asks.filter(
    (a): a is AskWire =>
      typeof a === 'object' &&
      a !== null &&
      typeof (a as AskWire).id === 'string' &&
      typeof (a as AskWire).kind === 'string' &&
      Array.isArray((a as AskWire).choices),
  );
  const line: ChannelLine = { type: 'asks', asks };
  if (typeof o.state === 'object' && o.state !== null) line.state = o.state as SessionViewWire['state'];
  // The live line (mode, notice): a command's answer shows without waiting for the next read.
  const live = (v as { live?: unknown }).live;
  if (typeof live === 'object' && live !== null && !Array.isArray(live)) line.live = live as SessionViewWire['live'];
  // The agent rows (R6.1-R6.3): all three or none, so an older Host line keeps the polled rows.
  const rows = v as { children?: unknown; team?: unknown; tasks?: unknown };
  if (Array.isArray(rows.children) && Array.isArray(rows.tasks)) {
    const children = rows.children.filter(
      (c): c is ChildWire =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as ChildWire).id === 'string' &&
        typeof (c as ChildWire).label === 'string',
    );
    const tasks = rows.tasks.filter(
      (t): t is TaskWire => typeof t === 'object' && t !== null && typeof (t as TaskWire).taskId === 'string',
    );
    const team =
      typeof rows.team === 'object' && rows.team !== null && Array.isArray((rows.team as TeamWire).teams)
        ? (rows.team as TeamWire)
        : undefined;
    line.agents = { children, tasks, ...(team ? { team } : {}) };
  }
  // The workflow runs (D48): an older Host line without them keeps the polled runs.
  const runs = (v as { workflows?: unknown }).workflows;
  if (Array.isArray(runs))
    line.workflows = runs.filter(
      (w): w is WorkflowWire =>
        typeof w === 'object' &&
        w !== null &&
        typeof (w as WorkflowWire).taskId === 'string' &&
        typeof (w as WorkflowWire).runId === 'string' &&
        Array.isArray((w as WorkflowWire).agents) &&
        Array.isArray((w as WorkflowWire).phases),
    );
  // M5: the usage summary (`null`: nothing known yet). An older Host line has no key at all.
  const usage = (v as { usage?: unknown }).usage;
  if (usage === null) line.usage = null;
  else if (isObj(usage)) line.usage = usage as unknown as UsageSummaryWire;
  return line;
}

/** Split a byte stream into text lines. Ends when the stream ends or `signal` aborts. */
export async function readLines(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', cancel, { once: true });
  let buf = '';
  try {
    for (;;) {
      if (signal.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        onLine(line);
      }
    }
    buf += dec.decode();
    if (buf.trim() !== '') onLine(buf);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
