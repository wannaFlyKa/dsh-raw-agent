// One DSH session driven by one backend session (D4, D18, D25, D26, D27, D47). DSH-neutral: every
// DSH touch point is behind the interfaces below, implemented in ./port (D79). No backend names
// either (D80): labels come from the factory.

import type {
  AgentBackendFactory,
  AgentInfo,
  OpenSessionOptions,
  AgentBackendSession,
  BackendEvent,
  BackendEventOf,
  BackendUserConfig,
  CommandInfo,
  ContextUsage,
  ExitReason,
  FileRewindResult,
  SessionTail,
  McpServerInfo,
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
import { AskDesk, type AskReply, type AskResult, type AskView, type AuditInfo, type AuditOutcome } from './asks.js';
import {
  ChildHub,
  type ChildHandle,
  type ChildRunner,
  type ChildSpec,
  type ChildStatus,
  type ChildView,
  type TeamView,
} from './children.js';
import { UsageBoard, type ContextView, type UsageSummary, type UsageView } from './usage.js';
import { WorkflowRecorder, type OpenWorkflowRun, type WorkflowRecord, type WorkflowView } from './workflows.js';
import {
  LocalOutputs,
  SideQuestionDesk,
  planCommandMenu,
  type McpActionResult,
  type McpAnswer,
  type MenuRow,
  type SideAskResult,
  type SideControl,
  type SideView,
} from './agent-commands.js';

/** What the driver writes into one open host turn. Implemented by the port writer. */
export interface TurnSink {
  /** The host turn this sink writes (absent in older sinks). */
  readonly turn?: number;
  readonly stepOpen: boolean;
  /** The open step already has an assistant message (a further one is a D84 continuation). */
  readonly hasMessage: boolean;
  readonly openCallIds: string[];
  hasCall(callId: string): boolean;
  /** `startedAt`: when the agent began the step (its request, R8.4). */
  openStep(startedAt?: number): void;
  delta(
    kind: 'text' | 'reasoning' | 'tool-input',
    blockIndex: number,
    text: string,
    at: number,
    tool?: { id: string; name: string },
  ): void;
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
  /**
   * D44: the host's native, log-only audit of an ask shown while this turn is open. Returns the
   * audit id for `approvalDecided`. Absent when the host has no such record.
   */
  approvalAsked?(info: AuditInfo): string | undefined;
  /** D44: the outcome of an audited ask. "Always" is `allowed-once` (the rule is the agent's). */
  approvalDecided?(auditId: string, outcome: AuditOutcome): void;
  /**
   * D26 (M3): the visible, native trigger of a wake turn, written once inside its first step.
   * Log-only for the agent: the backend is never sent it (D22), and no host model runs (D2).
   */
  trigger?(text: string, items?: readonly string[]): void;
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
  /**
   * D24: the permission mode the user chose in this session, as the agent last reported it. Only
   * written after a choice; a new process after a host restart applies it again (R1.4).
   */
  mode?: string;
}

/** A host job that mirrors one background task (D47). */
export interface JobLink {
  progress(line: string): void;
  end(status: TaskStatus, summary?: string): void;
}

/** The host refused a job (D47 r4): the task gets a row in the plugin's own task list instead. */
export interface JobRefusal {
  refused: string;
  /** The host's per-owner job limit was reached (the note names its config key). */
  limit?: boolean;
}

/** One background task as the plugin's task list shows it (D47). */
export interface TaskView {
  taskId: string;
  kind: TaskKind;
  label: string;
  status: 'running' | TaskStatus;
  progress?: string;
  /** A host job mirrors it; false: only the plugin row does (limit reached, or no controller). */
  job: boolean;
  note?: string;
  /** The child agent this task runs, for a background agent. */
  agent?: string;
}

/** The host's per-owner job limit key, named in the fallback note (D47 r4). */
export const JOB_LIMIT_CONFIG_KEY = 'maxConcurrentJobsPerOwner';

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
  /**
   * D47: mirror a background task as a host job. `onTeardown`: the host dropped the job without a
   * user's kill (its owner was disposed); the task keeps running and is linked again on attach.
   */
  startJob(
    task: { taskId: string; kind: TaskKind; label: string },
    stop: () => void,
    onTeardown?: () => void,
  ): JobLink | JobRefusal | undefined;
  /** D45: create a host child session under this session for a child agent. */
  createChild?(spec: ChildSpec, runner: ChildRunner): Promise<ChildHandle>;
  /**
   * D48: write one native workflow record into this session (dsh-seams R2.4: no host workflow
   * call is needed). A throw: the host refused it.
   */
  recordWorkflow?(record: WorkflowRecord): void;
  /** D48: workflow records this session's log holds open (a process that is gone wrote them). */
  openWorkflowRuns?(): OpenWorkflowRun[];
  warn(note: string, detail?: unknown): void;
  /**
   * D25: a steer the agent dropped on Stop goes back to the user: remove it from the host inbox
   * and put its text back into the composer draft. Nothing of it reaches the agent again.
   */
  returnDraft?(hostMessageId: string): void;
  /** Lifecycle changes for the plugin UI (D75 idle-death notice, Start button, job counts). */
  notify?(state: RuntimeState): void;
  /** R7.1: the agent's command list changed; the port updates the host `/` menu (D52). */
  commandsChanged?(): void;
  /**
   * M7 (D29, D30): for a fork, the host message id of the human message that opened the first
   * source turn the cut drops (read from the source session's log). Undefined when the cut is
   * inside a turn, when that turn has no human message (a wake turn), or when the source cannot
   * be read. The backend checks it again before it trusts it.
   */
  forkDroppedMessage?(): Promise<string | undefined>;
  /** M7: this session is a branch of a child agent's session (its kept steps are a child's). */
  forkedFromChild?(): boolean;
  /**
   * M7 (D75): background tasks this session's log shows as running, or torn down by the host,
   * when the host last stopped. The agent ended with the host, and so did they.
   */
  tasksEndedByStop?(): string[];
  /** M7 (D30): the human messages of this session's log the rewind dialog can go back to. */
  rewindPoints?(): RewindPoint[];
}

/** What the plugin UI can show about one session's agent process. */
export interface RuntimeState {
  process: 'none' | 'starting' | 'running';
  turn: boolean;
  backgroundTasks: number;
  /** How many asks wait for the user's answer. */
  waiting?: number;
  /** The last unexpected end of the process (D75), until the next spawn. */
  lastExit?: {
    error?: string;
    at: number;
    duringTurn: boolean;
    /** R3.6 (M7): 'crashed' (failed or killed) or 'ended' (stopped by itself with success). */
    reason?: ExitReason;
    code?: number;
    signal?: string;
    /** The end of the agent's error output: shown by the plugin UI, never written to the log (M8). */
    stderr?: string;
  };
}

/** M7: fork, rewind, recovery and restart facts for the plugin UI (none is a log event). */
export interface LifecycleView {
  /** D75: background tasks that ended when the host last stopped; the agent was not told. */
  endedByStop?: string[];
  /** This session is a branch of a child agent's session; the agent starts a new conversation. */
  forkedFromChild?: boolean;
  /** R3.6: the last time replies were read back from the agent's own record. */
  recovered?: { at: number; why: RecoveryCause; steps: number; note?: string };
  /** The record could not be compared (too large, not found), in words. */
  recoveryProblem?: string;
  /** D30: the last file restore (or its preview). */
  rewind?: { inputId: string; result: FileRewindResult; at: number };
  /** D30: "restore code" runs at this fork's first start. */
  restoreCodePending?: boolean;
  /** D29: this session is a fork whose agent has not started yet (its first start forks). */
  unstartedFork?: boolean;
}

/** Why replies were read back from the agent's own record (M7, R3.6). */
export type RecoveryCause = 'restart' | 'crash';

/** The rewind dialog's facts (D30, M7). Never starts a process. */
export interface RewindOptions {
  running: boolean;
  /** The agent keeps file checkpoints (the live process, else what a start now would do). */
  fileRewind: boolean;
  /** This session is a fork whose first start is still to come ("restore code" can apply then). */
  unstartedFork: boolean;
  restoreCodePending: boolean;
  displayName: string;
  /** The human messages the dialog lists, oldest first (empty when the log cannot be read). */
  points: RewindPoint[];
}

/** D30 (M7): one earlier human message the rewind dialog can go back to. */
export interface RewindPoint {
  /** The host id of the human message that opened the turn. */
  messageId: string;
  /** Its text, cut to `REWIND_TEXT_MAX` characters (the dialog's label). */
  text: string;
  /**
   * M8: the whole text when `text` is cut and the message is not too long (`REWIND_DRAFT_MAX`);
   * "restore conversation" puts it back in the branch's composer.
   */
  draft?: string;
  /** M8: `text` is cut (the label ends with "…"). */
  cut?: boolean;
  /** Non-text parts (images, files) of the message. */
  attachments?: number;
  /** When it was written (host time). */
  at: number;
  /**
   * Fork here for "restore conversation": the inclusive cut is the end of the turn before this
   * one, as DSH's own Branch action cuts. Undefined for the first turn (nothing to keep).
   */
  forkSeq?: number;
  /** The message is in this fork's inherited prefix (it ran in the source session). */
  inherited?: boolean;
}

/** The outcome of an in-place file restore (D30 "Restore code"). */
export interface RewindFilesAnswer {
  ok: boolean;
  /** 'not-running' | 'busy' | 'unsupported' | 'failed' when not ok. */
  code?: 'not-running' | 'busy' | 'unsupported' | 'failed';
  error?: string;
  result?: FileRewindResult;
}

/** What the live process reports about itself (system/init and status frames). */
export interface LiveInfo {
  model?: string;
  mode?: string;
  version?: string;
  /**
   * The last line the agent showed the user outside the conversation (`notice` event). `topic:
   * 'lifecycle'` marks a line the lifecycle view also holds (M8 polish): the plugin UI shows that
   * fact once, as a banner note, not again in the status line.
   */
  notice?: { level: string; text: string; at: number; topic?: 'lifecycle' };
  /** D15: the main-thread agent the process was started with (passed at spawn, or read on resume). */
  agent?: string;
  /**
   * D37: the agent's own ultracode state (Claude: `getSettings().applied`), read after every spawn
   * and every applied choice. `available: false`: the picker greys out its ultracode entry.
   */
  ultracode?: { on: boolean; requested?: boolean; available?: boolean };
  /**
   * R1.4: the effort level the agent says it applies now (Claude: `getSettings().applied.effort`),
   * read with the ultracode state and again after every turn end, so a typed `/effort` shows.
   */
  effort?: string;
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
  /** D15, D51: the main-thread agent picked for this new session; undefined = none. */
  agent?: string;
  /**
   * The main-thread agent can no longer change: the session had a turn (the agent's CLI cannot
   * switch it after turn 1), or the backend has no such picker.
   */
  agentLocked: boolean;
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
  /** Child agents of this process (D45, D46): the tree and per-child rows. */
  children?: ChildView[];
  /** The team roster model (D50). */
  team?: TeamView;
  /** Background tasks of this process (D47), with the plugin-only fallback rows. */
  tasks?: TaskView[];
  /** D51: the agents the live process lists for the main-thread picker (no process: absent). */
  agents?: AgentInfo[];
  /** Dynamic workflow runs of this process (D48): phases, agents, tokens, status, stop. */
  workflows?: WorkflowView[];
  /** D48: the backend can stop one workflow agent on its own (else only the whole run). */
  workflowAgentStop?: boolean;
  /** M5: the context pill's data and short usage totals (the panel reads the usage route). */
  usage?: UsageSummary;
  /** R7.3, D54: the side questions of this session (in memory only). */
  side?: SideView;
  /** R7.1: the agent's command list changed when `version` changes; read the commands route. */
  menu?: { version: number; count: number; full: boolean };
  /** R7.4: a short MCP summary (name and state); the panel reads the MCP route. */
  mcp?: Array<{ name: string; status: string }>;
  /** M7: fork, rewind, recovery and restart facts. */
  lifecycle?: LifecycleView;
  /** M8 (R9.2): the agent's own session id while a process runs (the public service shows it). */
  backendSessionId?: string;
}

/** The commands route's answer (R7.1). Never starts a process. */
export interface CommandsAnswer {
  running: boolean;
  /** 'live': read from the process now; 'reported': the agent's own report; 'none': nothing yet. */
  from: 'live' | 'reported' | 'none';
  /** Names only (the agent's start report), until the full rows are read. */
  full: boolean;
  /** Every agent command with its place in the plugin's `/` source (D52). */
  rows: MenuRow[];
  /** The backend's name for its labels ("Start <displayName>"). */
  displayName: string;
  /** The side-question command the client source claims (D54), if the backend has one. */
  sideQuestionCommand?: string;
  /** The agent's MCP view command; bare, it opens the plugin's MCP panel (D55). */
  mcpCommand?: string;
  /** The agent's rewind menu command; bare (or an alias), it opens the plugin's rewind dialog (D30). */
  rewindCommand?: string;
  reason?: string;
}

/** The usage route's answer (D58-D60). Never starts a process. */
export interface UsageAnswer {
  running: boolean;
  usage: UsageView;
  /** The live process's usage control could not be read (the board is shown as it was). */
  error?: string;
}

/** The context route's answer (D59). Never starts a process. */
export interface ContextAnswer {
  running: boolean;
  /** The agent's report (live), else the last known figure. Absent: nothing known yet. */
  context?: ContextView;
  /** 'not-running', 'unsupported' or the agent's error, when no live report was read. */
  reason?: string;
}

/** Context reports closer together than this are answered from the last one (D59). */
export const CONTEXT_REPORT_MIN_MS = 1000;

/** How long "Stop entire workflow" waits for the run's own end before it reports "stopping". */
export const WORKFLOW_STOP_WAIT_MS = 2000;
/** The most task output the output route returns (the end of it). */
export const TASK_OUTPUT_MAX_CHARS = 256 * 1024;
/** How many task ids (running or ended) one session remembers for the output route. */
export const TASK_KINDS_KEPT = 200;
/** Ended shell and monitor rows kept in the session view (their output stays readable). */
export const ENDED_TASKS_KEPT = 10;

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
type Item = BackendEvent | { type: 'stop-timeout' } | { type: 'ended' } | { type: 'recovered-end' };

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

const TURN_EVENTS = new Set(['turn-start', 'request-start', 'step-start', 'delta', 'step-message', 'tool-result']);

/** An event that belongs to a child agent, not to this session's own turn (D45, D50). */
export function isChildEvent(e: BackendEvent): boolean {
  if (e.type === 'agent-start' || e.type === 'agent-end' || e.type === 'agent-input' || e.type === 'team-message')
    return true;
  return TURN_EVENTS.has(e.type) && 'agent' in e && e.agent?.kind === 'child';
}
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
 * M7 (R3.6): the visible trigger of a turn that shows replies read back from the agent's own
 * record. Log-only for the agent (D26): nothing of it is ever sent.
 */
export function recoveryTrigger(displayName: string, why: RecoveryCause): string {
  const when = why === 'restart' ? 'while DSH was not running or before it stopped' : 'before its process ended';
  return `Read back from ${displayName}'s own record of this conversation: ${displayName} wrote this ${when}, and this session had not shown it yet.`;
}

/** M7 (R3.6): the trigger card's list for a recovery, and what was not shown as steps. */
export function recoveryItems(tail: Pick<SessionTail, 'prompts' | 'notes' | 'orphanResults'>): string[] {
  const out: string[] = [];
  for (const p of tail.prompts) {
    const t = p.replace(/\s+/g, ' ').trim();
    out.push(`it took your message "${t.length > 80 ? `${t.slice(0, 80)}…` : t}"`);
  }
  for (const n of tail.notes) out.push(`it took in ${n}`);
  if (tail.orphanResults > 0)
    out.push(
      `${tail.orphanResults} tool ${tail.orphanResults === 1 ? 'result' : 'results'} came back for calls shown above as interrupted; ${tail.orphanResults === 1 ? 'it is' : 'they are'} in the agent's memory`,
    );
  return out.slice(0, 20);
}

/** M7 (D75): the notice for background tasks that ended with the host. */
export function endedByStopNotice(displayName: string, labels: readonly string[]): string {
  const shown = labels
    .slice(0, 3)
    .map((l) => `"${l}"`)
    .join(', ');
  const more = labels.length > 3 ? ` and ${labels.length - 3} more` : '';
  const what = labels.length === 1 ? 'background task' : 'background tasks';
  return `When DSH last stopped, ${displayName} stopped with it, and its ${what} ${shown}${more} ended too. ${displayName} was not told; ask it to run ${labels.length === 1 ? 'it' : 'them'} again if you need ${labels.length === 1 ? 'it' : 'them'}.`;
}

/** M7: the notice for a branch made from a child agent's session. */
export function childForkNotice(displayName: string): string {
  return `This branch was made from a child agent's session. ${displayName} cannot continue a child agent's conversation as its own, so it starts a new conversation here with no memory of the kept turns.`;
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
  /** What each background task is, for the plugin task list and for re-linking jobs (D47). */
  readonly #taskInfo = new Map<string, TaskView>();
  /**
   * Ended shells and monitors of this process (R6.2): their rows stay, so their output stays
   * readable after they end. At most ENDED_TASKS_KEPT, cleared at each spawn.
   */
  readonly #endedTasks = new Map<string, TaskView>();
  /** Live child agents (D45). */
  readonly #hub: ChildHub;
  /** Dynamic workflow runs and their native records (D48). */
  readonly #workflows: WorkflowRecorder;
  /** Workflow records made while no host agent was attached (D87); written at the next attach. */
  #workflowBacklog: WorkflowRecord[] = [];
  /** Records a gone process left open in the log were closed once (at the first spawn). */
  #staleChecked = false;
  /** The kind of every task this runtime saw (output route: own shells and monitors only). */
  readonly #taskKinds = new Map<string, TaskKind>();
  /** Background work that ended since the last turn: named by the next wake trigger (D26). */
  #wakeNotes: string[] = [];
  /** The trigger text of the wake turn waiting to open (D26). */
  #wakeText: string | undefined;
  /** The wake notes the waiting wake text was built from (the trigger card's list, D26). */
  #wakeItems: string[] | undefined;
  /** The open wake turn still needs its visible trigger, written in its first step. */
  #triggerPending: string | undefined;
  #triggerItems: string[] = [];
  /** D15, D51: the main-thread agent picked for a new session, passed at the next spawn. */
  #agentChoice: string | undefined;
  /** The main-thread agent the live process was started with. */
  #mainAgent: string | undefined;
  /** D51: the agent list the live process reported. */
  #agents: AgentInfo[] | undefined;
  /** This runtime ran a turn (the main agent is fixed from then on, D15). */
  #hadTurn = false;
  readonly #sent = new Map<string, SentEntry>();
  #earlySteers: UserInput[] = [];
  #chain: string[] = [];
  readonly #superseded = new Set<string>();
  #appliedModel: string | undefined;
  #refusedModel: string | undefined;
  #appliedEffort: string | undefined;
  /** D37: the last effort state the live process reported (see LiveInfo.ultracode). */
  #ultracode: LiveInfo['ultracode'];
  /** R1.4: the effort level the live process last reported. */
  #effort: string | undefined;
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
  /** The writer of the open host turn, for the D44 audit pair. */
  #sink: TurnSink | undefined;
  /** Audited asks: ask id → audit id and the writer of the turn it is in (D44; root or child). */
  readonly #audits = new Map<string, { id: string; sink: TurnSink }>();
  /** The mode choice was read back from the host log once (D24). */
  #modeRestored = false;
  readonly #listeners = new Set<(view: SessionView) => void>();
  /** M5: what the agent reported about usage, context, limits and auth (never written to the log). */
  readonly #usage: UsageBoard;
  /** The open step was opened by a request and no response has joined it yet (R8.4). */
  #requestStep = false;
  #contextRead: { at: number; detail: string; promise: Promise<ContextAnswer> } | undefined;
  /** Told once when the runtime is disposed, so open channels close (D39). */
  readonly #endListeners = new Set<() => void>();
  /** R7.3, D54: side questions and their history (in memory only, D24). */
  readonly #side: SideQuestionDesk;
  /** R7.1: the agent's command list (kept after the process ends; it still names what typing runs). */
  #commandList: CommandInfo[] | undefined;
  #commandsFull = false;
  #commandsVersion = 0;
  /** The menu placements the port computed last (D52: `taken` needs the host's registry). */
  #menuRows: MenuRow[] | undefined;
  /** R7.4, D55: the MCP servers as last reported or read. Reset at each spawn. */
  #mcp: McpServerInfo[] | undefined;
  #mcpFrom: 'live' | 'reported' | 'none' = 'none';
  /** R7.2: structured local-command outputs (display-only path). */
  readonly #local = new LocalOutputs();
  /** M7: the facts the lifecycle view shows. */
  #lifecycle: LifecycleView = {};
  /** M7 (D30): "restore code" at this fork's first start. */
  #restoreCode = false;
  /** M7 (R3.6): the read of the agent's own record that runs now, if any. */
  #recovery: Promise<void> | undefined;
  /** The chain point the last recovery read started from (never read twice from one point). */
  #recoveredFrom: string | undefined;
  /** A recovery found while a turn ran; it opens its own turn after that one. */
  #pendingRecovery: { items: Item[]; text: string; list: string[]; sessionId: string } | undefined;
  /** The wake buffer holds recovered steps (its turn needs no process). */
  #wakeRecovery = false;
  /** The running turn shows only recovered steps. */
  #recoveryTurn = false;
  /** The backend session id recovered steps are bound to while no process runs. */
  #recoverySession: string | undefined;
  /** The open check (`#checkOnOpen`) ran; it runs once, at the latest before the first spawn. */
  #openChecked = false;

  constructor(factory: AgentBackendFactory, port: HostSessionPort, opts: SessionRuntimeOptions) {
    this.#factory = factory;
    this.#port = port;
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
    this.#usage = new UsageBoard(this.#now);
    this.#desk = new AskDesk(() => this.#notify(), this.#now, {
      opened: (view, info) => this.#auditOpened(view, info),
      closed: (id, outcome) => this.#auditClosed(id, outcome),
    });
    this.#hub = new ChildHub({
      now: this.#now,
      warn: (n, d) => this.#warn(n, d),
      notify: () => this.#notify(),
      createRootChild: (spec, runner) => {
        const create = this.#port?.createChild;
        if (!create) return Promise.reject(new Error('the host session cannot hold child sessions'));
        return create(spec, runner);
      },
      stopTask: (taskId) => {
        const stop = this.#backend?.controls.stopTask;
        if (!stop) return Promise.reject(new Error(`${factory.displayName} is not running`));
        return stop(taskId);
      },
      teamMessaging: () => this.#backend?.capabilities.teamMessaging === true,
      imageText: (mediaType) => imageUnavailableText(mediaType, 'child result images are not stored'),
    });
    this.#side = new SideQuestionDesk({
      displayName: factory.displayName,
      now: this.#now,
      notify: () => this.#notify(),
      control: () => this.#sideControl(),
    });
    this.#workflows = new WorkflowRecorder({
      now: this.#now,
      warn: (n, d) => this.#warn(n, d),
      notify: () => this.#notify(),
      write: (r) => this.#writeWorkflow(r),
      childSession: (id) => this.#hub.session(id),
    });
    // M7: what the log says about the last host stop, read once the runtime exists.
    queueMicrotask(() => this.#checkOnOpen());
  }

  /**
   * M7: once per runtime, before any process of it runs: background tasks that ended with the last
   * host stop (D75), a branch of a child's session, and replies the agent wrote that the log does
   * not hold (R3.6). No process starts (rule 9); the record read is a file read.
   */
  #checkOnOpen(beforeSpawn = false): void {
    const port = this.#port;
    if (this.#openChecked || !port || this.#disposed) return;
    this.#openChecked = true;
    const name = this.#factory.displayName;
    try {
      const ended = port.tasksEndedByStop?.() ?? [];
      if (ended.length > 0) {
        this.#lifecycle.endedByStop = ended;
        this.showNotice('warning', endedByStopNotice(name, ended), 'lifecycle');
      }
    } catch (error) {
      this.#warn('could not read the jobs of the last run', String((error as Error)?.message ?? error));
    }
    try {
      if (port.forkedFromChild?.() === true) {
        this.#lifecycle.forkedFromChild = true;
        this.showNotice('info', childForkNotice(name), 'lifecycle');
      }
    } catch (error) {
      this.#warn('could not read the fork prefix', String((error as Error)?.message ?? error));
    }
    // A spawn that started before this check ran (a message sent at once) runs it first itself.
    if (!this.#backend && (beforeSpawn || !this.#starting)) this.#recovery = this.#recoverTail('restart');
  }

  /**
   * M7 (R3.6): read what the agent wrote past the log's chain point from its own record. Only the
   * session's own binding counts: past a fork's inherited point lie the source's turns the fork
   * dropped. Found steps open a log-only turn of their own (no process), or join the next turn.
   */
  async #recoverTail(why: RecoveryCause): Promise<void> {
    const f = this.#factory;
    const port = this.#port;
    if (!f.readSessionTail || !port || this.#disposed) return;
    let binding: HostBinding | undefined;
    try {
      binding = port.latestBinding();
    } catch {
      return;
    }
    if (!binding || binding.chainId === undefined) return;
    if (binding.hostSessionId !== undefined && binding.hostSessionId !== port.hostSessionId) return;
    const from = `${binding.sessionId}:${binding.chainId}`;
    if (this.#recoveredFrom === from) return;
    this.#recoveredFrom = from;
    let tail: SessionTail;
    try {
      tail = await f.readSessionTail(binding.sessionId, port.cwd, binding.chainId);
    } catch (error) {
      this.#warn('could not read the agent record', String((error as Error)?.message ?? error));
      return;
    }
    if (this.#disposed) return;
    const name = f.displayName;
    if (tail.status === 'too-large') {
      this.#lifecycle.recoveryProblem = `${name}'s record of this conversation is too large to compare, so replies it wrote while this session was not looking may be missing here.`;
      this.#notify();
      return;
    }
    if (tail.status !== 'found') {
      this.#warn(`no recovery read (${tail.status})`, binding.chainId);
      return;
    }
    const steps = tail.events.filter((e) => e.type === 'step-message').length;
    const list = recoveryItems(tail);
    if (steps === 0) {
      // Nothing to show as steps; say what the agent has that this session does not.
      const unseen = tail.notes.length > 0 || tail.orphanResults > 0;
      if (unseen) {
        const note = `${name} has more than this session shows: ${list.join('; ')}.`;
        this.#lifecycle.recovered = { at: this.#now(), why, steps: 0, note };
        // The banner shows a restart's read-back as a note; a crash's is in the exit banner text only.
        this.showNotice('warning', note, why === 'restart' ? 'lifecycle' : undefined);
      }
      return;
    }
    this.#lifecycle.recovered = { at: this.#now(), why, steps };
    if (list.length > 0) this.#lifecycle.recovered.note = list.join('; ');
    this.#pendingRecovery = {
      items: [...tail.events, { type: 'recovered-end' }],
      text: recoveryTrigger(name, why),
      list,
      sessionId: binding.sessionId,
    };
    this.#flushRecovery();
  }

  /**
   * Open the recovery turn once no turn runs or waits (its steps must not split another turn).
   * `join`: the turn that is starting takes the steps itself, before its input is sent, so the
   * newest turn's binding stays the last one in the log (no wake is asked for).
   */
  #flushRecovery(join = false): void {
    const r = this.#pendingRecovery;
    if (!r || this.#wakeBuffer !== undefined || this.#disposed) return;
    if (this.#turnActive && !join) return;
    this.#pendingRecovery = undefined;
    this.#wakeBuffer = [...r.items];
    this.#wakeRecovery = true;
    this.#recoverySession = r.sessionId;
    this.#wakeText = r.text;
    this.#wakeItems = r.list;
    if (!join) {
      const port = this.#port;
      if (port) port.wake(r.text);
      else this.#wakePending = true;
    }
    this.#notify();
  }

  /** D48: one native workflow record into the parent session; held while no host agent is attached. */
  #writeWorkflow(r: WorkflowRecord): void {
    const port = this.#port;
    if (!port) {
      this.#workflowBacklog.push(r);
      return;
    }
    port.recordWorkflow?.(r);
  }

  /**
   * D44: an ask of the main thread shown while its host turn is open gets the host's native
   * audit pair. An ask outside a turn writes nothing (the pair must be turn-enclosed); a
   * subagent's ask waits for child sessions (D45) and is not audited in the parent's log.
   */
  #auditOpened(view: AskView, info: AuditInfo): void {
    // A child's ask goes into that child's log while its turn is open (D44, D45).
    const sink =
      view.agent === 'main'
        ? this.#turnActive
          ? this.#sink
          : undefined
        : view.agentId !== undefined
          ? this.#hub.openSink(view.agentId)
          : undefined;
    if (!sink?.approvalAsked) return;
    try {
      const id = sink.approvalAsked(info);
      if (id !== undefined) this.#audits.set(view.id, { id, sink });
    } catch (error) {
      this.#warn('could not record the approval audit', String((error as Error)?.message ?? error));
    }
  }

  #auditClosed(askId: string, outcome: AuditOutcome): void {
    const a = this.#audits.get(askId);
    if (a === undefined) return;
    this.#audits.delete(askId);
    try {
      a.sink.approvalDecided?.(a.id, outcome);
    } catch (error) {
      this.#warn('could not record the approval outcome', String((error as Error)?.message ?? error));
    }
  }

  /** D74: an audited ask still open when the turn ends is `cancelled` in the host log. */
  #closeAudits(): void {
    const sink = this.#sink;
    for (const [id, a] of [...this.#audits]) if (a.sink === sink) this.#auditClosed(id, 'cancelled');
  }

  /**
   * Live updates for the interaction channel (D39): the listener gets the whole view after every
   * change (asks, state). Returns the unsubscribe function.
   */
  /**
   * Show one line to the user outside the conversation (the plugin's status line), for example
   * the answer of our `/permission` command: DSH does not show a command's result in the chat.
   */
  showNotice(level: 'info' | 'warning', text: string, topic?: 'lifecycle'): void {
    if (this.#disposed) return;
    this.#live.notice = { level, text, at: this.#now(), ...(topic ? { topic } : {}) };
    this.#notify();
  }

  subscribe(listener: (view: SessionView) => void, onEnd?: () => void): () => void {
    if (this.#disposed) {
      onEnd?.();
      return () => {};
    }
    this.#listeners.add(listener);
    if (onEnd) this.#endListeners.add(onEnd);
    return () => {
      this.#listeners.delete(listener);
      if (onEnd) this.#endListeners.delete(onEnd);
    };
  }

  /**
   * D24, R1.4: after a host restart the user's mode choice is read back from the binding in the
   * host log (written only after a choice) and becomes a pending choice, applied right after the
   * next spawn (D4). Once per runtime; a choice made in this run wins. Only the session's own
   * binding counts: a DSH fork inherits the parent's binding, but the parent's choice was for the
   * parent, so a fork starts in the user's settings mode (rule 4). What the TUI does on a fork is **unverified**.
   */
  #restoreMode(): void {
    if (this.#modeRestored || !this.#port) return;
    this.#modeRestored = true;
    if (this.#modeChosen) return;
    let mode: string | undefined;
    try {
      const b = this.#port.latestBinding();
      const inherited = b?.hostSessionId !== undefined && b.hostSessionId !== this.#port.hostSessionId;
      mode = inherited ? undefined : b?.mode;
    } catch {
      mode = undefined;
    }
    if (mode === undefined || !this.#factory.staticCapabilities.permissionModes.some((m) => m.id === mode)) return;
    this.#pendingMode = mode;
    this.#modeChosen = true;
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
    if (this.#listeners.size === 0) return;
    const view = this.view();
    for (const listener of [...this.#listeners]) {
      try {
        listener(view);
      } catch (error) {
        this.#warn('interaction listener failed', String(error));
      }
    }
  }

  /** Bind a new host agent (D87: after an eviction). A turn the agent started meanwhile wakes now. */
  attach(port: HostSessionPort): void {
    this.#port = port;
    // D48: workflow records made while detached, in order.
    const backlog = this.#workflowBacklog;
    this.#workflowBacklog = [];
    for (const r of backlog) {
      try {
        port.recordWorkflow?.(r);
      } catch (error) {
        this.#warn(`could not record workflow ${r.kind}`, String((error as Error)?.message ?? error));
      }
    }
    // D47: tasks whose job the host dropped with the evicted agent keep running; link them again.
    for (const taskId of this.#tasks) if (!this.#jobs.has(taskId)) this.#linkJob(taskId);
    if (this.#wakePending && this.#wakeBuffer !== undefined) {
      this.#wakePending = false;
      port.wake(this.#wakeText ?? this.#wakeSummary());
    }
    this.#notify();
  }

  /** D26: the wake trigger's text: what ended in the background since the last turn. */
  #wakeSummary(): string {
    const name = this.#factory.displayName;
    const notes = this.#wakeNotes;
    if (notes.length === 0) return `${name} continued on its own`;
    const shown = notes.slice(-3).join('; ');
    const more = notes.length > 3 ? ` (and ${notes.length - 3} more)` : '';
    return `${name} continued on its own after: ${shown}${more}`;
  }

  /** D47: mirror one running task as a host job, or give it a plugin-only row. */
  #linkJob(taskId: string): void {
    const info = this.#taskInfo.get(taskId);
    const port = this.#port;
    if (!info || !port) return;
    const backend = this.#backend;
    const stop = () => {
      if (info.kind === 'workflow') this.#workflows.noteStop(taskId); // the job's kill stops the whole run
      void backend?.controls.stopTask?.(taskId).catch((err) => {
        if (info.kind === 'workflow') this.#workflows.clearStop(taskId);
        this.#warn('stopTask failed', String(err));
      });
    };
    let link: ReturnType<HostSessionPort['startJob']>;
    try {
      link = port.startJob({ taskId, kind: info.kind, label: info.label }, stop, () => {
        // Teardown (D47): the host dropped the row; the task keeps running and is linked again.
        if (this.#jobs.get(taskId) === current) this.#jobs.delete(taskId);
        const i = this.#taskInfo.get(taskId);
        if (i && i.status === 'running') i.job = false;
      });
    } catch (error) {
      link = { refused: String((error as Error)?.message ?? error) };
    }
    const current = link !== undefined && !('refused' in link) ? link : undefined;
    if (current) {
      this.#jobs.set(taskId, current);
      info.job = true;
      delete info.note;
      return;
    }
    info.job = false;
    if (link && 'refused' in link && link.limit)
      info.note = `The host's background job limit is reached (${JOB_LIMIT_CONFIG_KEY} in the profile config), so this task shows only here.`;
    else if (link && 'refused' in link) info.note = 'The host did not take this task as a job, so it shows only here.';
  }

  /** The host agent went away; the process and its background tasks keep running (rules 6, 7). */
  detach(): void {
    this.#port = undefined;
  }

  /** D30: record a file restore (a fork's first start, or "Restore code" in place) for the UI. */
  #noteRewind(inputId: string, result: FileRewindResult): void {
    // A preview (dry run) changes nothing: it must not replace the outcome of a real restore that
    // the banner shows (the rewind dialog previews several points, M8 polish).
    if (result.dryRun) return;
    this.#lifecycle.rewind = { inputId, result, at: this.#now() };
    const name = this.#factory.displayName;
    if (result.ok) {
      const n = result.filesChanged.length;
      this.showNotice(
        'info',
        n === 0 ? 'No file needed restoring.' : `Restored ${n} ${n === 1 ? 'file' : 'files'}.`,
        'lifecycle',
      );
    } else
      this.showNotice(
        'warning',
        `${name} did not restore the files: ${result.error ?? 'no reason given'}`,
        'lifecycle',
      );
  }

  /** The session is a fork that has not started its own process yet (D29). */
  #unstartedFork(): boolean {
    const port = this.#port;
    if (!port || this.#backend || this.#starting) return false;
    if (this.#factory.staticCapabilities.fork !== 'at-chain-point') return false;
    try {
      const b = port.latestBinding();
      return b?.hostSessionId !== undefined && b.hostSessionId !== port.hostSessionId && b.chainId !== undefined;
    } catch {
      return false;
    }
  }

  /** D30, M7: what the rewind dialog may offer now. Never starts a process. */
  async rewindOptions(): Promise<RewindOptions> {
    const running = this.#backend !== undefined;
    let fileRewind = this.#backend?.capabilities.fileRewind === true;
    if (!running && this.#port && this.#factory.fileRewindAvailable) {
      try {
        fileRewind = await this.#factory.fileRewindAvailable(this.#port.cwd);
      } catch (error) {
        this.#warn('could not read the checkpoint setting', String((error as Error)?.message ?? error));
      }
    }
    let points: RewindPoint[] = [];
    try {
      points = this.#port?.rewindPoints?.() ?? [];
    } catch (error) {
      this.#warn('could not read the rewind points', String((error as Error)?.message ?? error));
    }
    return {
      running,
      fileRewind,
      unstartedFork: this.#unstartedFork(),
      restoreCodePending: this.#restoreCode,
      displayName: this.#factory.displayName,
      points,
    };
  }

  /**
   * D30 "restore code and conversation": the fork's first start also puts the files back as they
   * were before the first dropped turn. Only for a fork that has not started yet.
   */
  requestCodeRestore(on: boolean): { ok: boolean; error?: string } {
    if (!on) {
      this.#restoreCode = false;
      this.#notify();
      return { ok: true };
    }
    if (!this.#unstartedFork())
      return { ok: false, error: 'only a branch that has not started yet can restore code at its start' };
    this.#restoreCode = true;
    this.#notify();
    return { ok: true };
  }

  /**
   * D30 "Restore code" (in place): the files go back to before the turn of this host message ran;
   * the conversation stays. `dryRun` only reports what would change. Needs the live process; never
   * while a turn runs.
   */
  async rewindFiles(hostMessageId: string, dryRun: boolean): Promise<RewindFilesAnswer> {
    const b = this.#backend;
    const control = b?.controls.rewindFiles;
    if (!b) return { ok: false, code: 'not-running', error: `${this.#factory.displayName} is not running` };
    if (!control || !b.capabilities.fileRewind)
      return { ok: false, code: 'unsupported', error: `${this.#factory.displayName} keeps no file checkpoints here` };
    if (this.#turnActive && !dryRun) return { ok: false, code: 'busy', error: 'wait until the turn ends' };
    const inputId = this.#factory.inputIdFor?.(hostMessageId) ?? hostMessageId;
    let result: FileRewindResult;
    try {
      result = await control(inputId, { dryRun });
    } catch (error) {
      return { ok: false, code: 'failed', error: String((error as Error)?.message ?? error) };
    }
    this.#noteRewind(inputId, result);
    return result.ok
      ? { ok: true, result }
      : { ok: false, code: 'failed', result, ...(result.error ? { error: result.error } : {}) };
  }

  /** "Start <displayName>" (D4): spawn without sending anything. */
  async start(): Promise<void> {
    const backend = await this.#ensureBackend();
    await this.#applyChoices(backend);
  }

  /** What the plugin's session controls show (D35-D38, D4). */
  view(): SessionView {
    this.#restoreMode();
    const choice: ChoiceView = { applied: {}, resetPending: this.#resetPending, agentLocked: this.#agentLocked() };
    if (this.#agentChoice !== undefined) choice.agent = this.#agentChoice;
    const model = this.#port?.modelChoice?.();
    if (model !== undefined) choice.model = model;
    if (this.#effortChoice !== undefined) choice.effort = this.#effortChoice;
    if (this.#pendingMode !== undefined) choice.pendingMode = this.#pendingMode;
    if (this.#appliedModel !== undefined) choice.applied.model = this.#appliedModel;
    if (this.#refusedModel !== undefined) choice.refused = { model: this.#refusedModel };
    if (this.#appliedEffort !== undefined) choice.applied.effort = this.#appliedEffort;
    const v: SessionView = { state: this.state(), live: { ...this.#live }, choice };
    if (this.#ultracode !== undefined) v.live.ultracode = { ...this.#ultracode };
    if (this.#effort !== undefined) v.live.effort = this.#effort;
    if (this.#models) v.models = this.#models.map((m) => ({ ...m }));
    if (this.#port) v.cwd = this.#port.cwd;
    if (this.#backend) v.backendSessionId = this.#backend.sessionId;
    const asks = this.#desk.list();
    if (asks.length > 0) v.asks = asks;
    if (this.#hub.size > 0) v.children = this.#hub.views();
    const team = this.#hub.team();
    if (team) v.team = team;
    if (this.#taskInfo.size > 0 || this.#endedTasks.size > 0)
      v.tasks = [...this.#taskInfo.values(), ...this.#endedTasks.values()].map((t) => ({ ...t }));
    if (this.#agents) v.agents = this.#agents.map((a) => ({ ...a }));
    if (this.#workflows.size > 0) {
      v.workflows = this.#workflows.views();
      v.workflowAgentStop = this.#backend?.capabilities.workflowAgentStop === true;
    }
    const lifecycle: LifecycleView = { ...this.#lifecycle };
    if (this.#restoreCode) lifecycle.restoreCodePending = true;
    if (!this.#backend && this.#unstartedFork()) lifecycle.unstartedFork = true;
    if (Object.keys(lifecycle).length > 0) v.lifecycle = lifecycle;
    const usage = this.#usage.summary();
    if (usage) v.usage = usage;
    const side = this.#side.view();
    if (side.entries.length > 0) v.side = side;
    if (this.#commandList)
      v.menu = { version: this.#commandsVersion, count: this.#commandList.length, full: this.#commandsFull };
    if (this.#mcp) v.mcp = this.#mcp.map((m) => ({ name: m.name, status: m.status }));
    return v;
  }

  // ---- M6: commands, side questions, MCP, local outputs (R7.1-R7.4) ----

  /** R7.1: the agent's command list as known now (the port builds the host menu from it). */
  commandList(): { list: CommandInfo[] | undefined; full: boolean; version: number } {
    return {
      list: this.#commandList?.map((c) => ({ ...c })),
      full: this.#commandsFull,
      version: this.#commandsVersion,
    };
  }

  /** The port's menu placements (D52), so the commands route can name the taken rows. */
  noteMenu(rows: MenuRow[]): void {
    const changed = JSON.stringify(rows) !== JSON.stringify(this.#menuRows);
    this.#menuRows = rows.map((r) => ({ ...r }));
    // The client source caches the answer per menu version: a new taken name must reach it.
    if (changed) {
      this.#commandsVersion++;
      this.#notify();
    }
  }

  #setCommands(list: CommandInfo[], full: boolean): void {
    this.#commandList = list.map((c) => ({ ...c }));
    this.#commandsFull = full;
    this.#commandsVersion++;
    this.#menuRows = undefined;
    try {
      this.#port?.commandsChanged?.();
    } catch (error) {
      this.#warn('could not update the / menu', String((error as Error)?.message ?? error));
    }
    this.#notify();
  }

  /** The agent sent names only: read the full rows (descriptions, hints) from the live process. */
  #loadCommands(backend: AgentBackendSession): void {
    const read = backend.controls.commands;
    if (!read) return;
    read.call(backend.controls).then(
      (list) => {
        if (backend !== this.#backend || !Array.isArray(list)) return;
        this.#setCommands(list, true);
      },
      (error) => this.#warn('reading the command list failed', String((error as Error)?.message ?? error)),
    );
  }

  /**
   * R7.1: the commands route. With a process and only names known, the full rows are read once
   * (the agent's own command list, no model call). Never starts a process (rule 9, D4).
   */
  async commandsAnswer(): Promise<CommandsAnswer> {
    const backend = this.#backend;
    let reason: string | undefined;
    let from: CommandsAnswer['from'] = this.#commandList ? 'reported' : 'none';
    if (backend && !this.#commandsFull && backend.controls.commands) {
      try {
        const list = await backend.controls.commands.call(backend.controls);
        if (backend === this.#backend && Array.isArray(list)) {
          this.#setCommands(list, true);
          from = 'live';
        }
      } catch (e) {
        reason = String((e as Error)?.message ?? e);
      }
    }
    const { sideQuestionCommand, mcpCommand, rewindCommand } = this.#factory.staticCapabilities;
    const rows =
      this.#menuRows ??
      planCommandMenu(this.#commandList ?? [], {
        displayName: this.#factory.displayName,
        ...(sideQuestionCommand !== undefined ? { sideQuestionCommand } : {}),
        ...(mcpCommand !== undefined ? { mcpCommand } : {}),
        ...(rewindCommand !== undefined ? { rewindCommand } : {}),
      }).rows;
    const answer: CommandsAnswer = {
      running: backend !== undefined,
      from,
      full: this.#commandsFull,
      rows: rows.map((r) => ({ ...r })),
      displayName: this.#factory.displayName,
    };
    if (sideQuestionCommand !== undefined) answer.sideQuestionCommand = sideQuestionCommand;
    if (mcpCommand !== undefined) answer.mcpCommand = mcpCommand;
    if (rewindCommand !== undefined) answer.rewindCommand = rewindCommand;
    if (reason !== undefined) answer.reason = reason;
    return answer;
  }

  #sideControl(): SideControl {
    const backend = this.#backend;
    if (!backend) return { kind: 'not-running' };
    const ask = backend.controls.askSideQuestion;
    if (!ask || !backend.capabilities.sideQuestions) return { kind: 'unsupported' };
    return { kind: 'ready', ask: (q, history, signal) => ask.call(backend.controls, q, history, signal) };
  }

  /**
   * R7.3, D54: one side question. Full context, no tools, nothing written to either log. With no
   * process the question waits and is asked after the user starts the agent (D4).
   */
  askSideQuestion(question: string, signal?: AbortSignal): Promise<SideAskResult> {
    if (this.#disposed) return Promise.resolve({ ok: false, code: 'unsupported', error: 'the session is closed' });
    return this.#side.ask(question, signal);
  }

  sideQuestions(): SideView {
    return this.#side.view();
  }

  cancelSideQuestion(id: string): boolean {
    return this.#side.cancel(id);
  }

  /** R7.4, D55: the MCP servers, read from the live process when it can. Never spawns. */
  async mcp(): Promise<McpAnswer> {
    const backend = this.#backend;
    const answer = (reason?: string): McpAnswer => {
      const a: McpAnswer = {
        running: backend !== undefined,
        from: this.#mcpFrom,
        servers: (this.#mcp ?? []).map((m) => ({ ...m })),
      };
      if (reason !== undefined) a.reason = reason;
      return a;
    };
    if (!backend) return answer('not-running');
    const read = backend.controls.mcpStatus;
    if (!read) return answer('unsupported');
    try {
      const servers = await read.call(backend.controls);
      if (backend !== this.#backend) return answer('not-running');
      this.#mcp = Array.isArray(servers) ? servers.map((m) => ({ ...m })) : [];
      this.#mcpFrom = 'live';
      this.#notify();
      return answer();
    } catch (e) {
      return answer(String((e as Error)?.message ?? e));
    }
  }

  /**
   * D55: reconnect, toggle or sign in one MCP server. The name must be one the agent listed (it is
   * untrusted text, passed back unchanged). The agent saves a toggle itself; its note is shown as
   * given. Never writes a settings file (rule 2) and never spawns.
   */
  async mcpAction(
    action: 'reconnect' | 'toggle' | 'authenticate' | 'auth-callback',
    name: string,
    arg?: { enabled?: boolean; callbackUrl?: string },
  ): Promise<McpActionResult> {
    const backend = this.#backend;
    const label = this.#factory.displayName;
    if (!backend) return { ok: false, code: 'not-running', error: `${label} is not running. Start it first.` };
    const c = backend.controls;
    const fn =
      action === 'reconnect'
        ? c.mcpReconnect
        : action === 'toggle'
          ? c.mcpToggle
          : action === 'authenticate'
            ? c.mcpAuthenticate
            : c.mcpSubmitAuthCallback;
    if (!fn) return { ok: false, code: 'unsupported', error: `This ${label} version cannot do that.` };
    let known = this.#mcp;
    if (!known?.some((m) => m.name === name)) known = (await this.mcp()).servers;
    if (!known.some((m) => m.name === name))
      return { ok: false, code: 'unknown-server', error: `${label} lists no MCP server with that name.` };
    try {
      let note: string | undefined;
      let auth: Awaited<ReturnType<NonNullable<typeof c.mcpAuthenticate>>> | undefined;
      if (action === 'reconnect') await c.mcpReconnect!.call(c, name);
      else if (action === 'toggle') note = (await c.mcpToggle!.call(c, name, arg?.enabled === true))?.note;
      else if (action === 'authenticate') auth = await c.mcpAuthenticate!.call(c, name);
      else await c.mcpSubmitAuthCallback!.call(c, name, arg?.callbackUrl ?? '');
      const mcp = await this.mcp();
      const r: McpActionResult = { ok: true, mcp };
      if (note !== undefined) r.note = note;
      if (auth !== undefined) r.auth = auth;
      return r;
    } catch (e) {
      return { ok: false, code: 'failed', error: String((e as Error)?.message ?? e), mcp: await this.mcp() };
    }
  }

  /** R7.2: one structured local-command output (display-only; the text is in the host log). */
  localOutput(id: string): ReturnType<LocalOutputs['get']> {
    return this.#local.get(id);
  }

  /**
   * M5 usage panel (D58-D60): the board, refreshed from the live process's usage control when one
   * runs. Never starts a process (rule 9) and never makes a model call.
   */
  async usage(): Promise<UsageAnswer> {
    const backend = this.#backend;
    const read = backend?.controls.usageSnapshot;
    let error: string | undefined;
    if (backend && read) {
      try {
        const snap = await read.call(backend.controls);
        if (backend === this.#backend) this.#usage.snapshot(snap);
      } catch (e) {
        error = String((e as Error)?.message ?? e);
      }
    }
    const answer: UsageAnswer = { running: backend !== undefined, usage: this.#usage.view() };
    if (error !== undefined) answer.error = error;
    return answer;
  }

  /**
   * M5 context pill and panel (D59): the agent's own report, read from the live process only
   * (Claude: `getContextUsage`). No process: the last known figure and `not-running`; the pill
   * offers "Start" (D4). Reports closer than CONTEXT_REPORT_MIN_MS share one read.
   */
  contextUsage(detail: 'summary' | 'full' = 'summary'): Promise<ContextAnswer> {
    const backend = this.#backend;
    const last = (reason: string): ContextAnswer => {
      const a: ContextAnswer = { running: backend !== undefined, reason };
      const c = this.#usage.context;
      if (c) a.context = c;
      return a;
    };
    if (!backend) return Promise.resolve(last('not-running'));
    const read = backend.controls.contextUsage;
    if (!read) return Promise.resolve(last('unsupported'));
    const now = this.#now();
    const prior = this.#contextRead;
    if (prior && now - prior.at < CONTEXT_REPORT_MIN_MS && (prior.detail === detail || detail === 'summary'))
      return prior.promise;
    const promise = (async (): Promise<ContextAnswer> => {
      try {
        const r: ContextUsage = await read.call(backend.controls, detail);
        if (backend !== this.#backend) return last('not-running');
        const c = this.#usage.report(r);
        this.#notify();
        const a: ContextAnswer = { running: true };
        if (c) a.context = c;
        return a;
      } catch (e) {
        return last(String((e as Error)?.message ?? e));
      }
    })();
    this.#contextRead = { at: now, detail, promise };
    return promise;
  }

  /**
   * D15: the main-thread agent is fixed once the session had a turn (here, or before a restart:
   * the host log then holds a binding), and for a backend without the picker.
   */
  #agentLocked(): boolean {
    if (this.#factory.staticCapabilities.mainAgentPicker === 'none') return true;
    if (this.#factory.staticCapabilities.mainAgentPicker === 'any-time') return false;
    return this.#hadTurn || this.#turnActive || this.#port?.latestBinding() !== undefined;
  }

  /**
   * D46: stop one child agent (its task); the others and the main turn keep running. Waits up to
   * 2 s for the agent's own end, then reports "stopping".
   */
  stopChild(childId: string): Promise<{ ok: boolean; status: ChildStatus | 'stopping' | 'unknown'; error?: string }> {
    // D48: a workflow agent stops on its own only when the backend can do that.
    if (this.#hub.role(childId) === 'workflow-agent' && this.#backend?.capabilities.workflowAgentStop !== true) {
      const status = this.#hub.views().find((c) => c.id === childId)?.status ?? 'unknown';
      return Promise.resolve({ ok: false, status, error: this.#noAgentStopText() });
    }
    return this.#hub.stop(childId);
  }

  #noAgentStopText(): string {
    return `${this.#factory.displayName} cannot stop one agent of a workflow. Stop the whole workflow instead.`;
  }

  /**
   * D48: "Stop entire workflow": the backend's per-task stop on the run. Waits up to 2 s for the
   * run's own end, then reports "stopping". The process and other tasks keep running (rule 6).
   */
  async stopWorkflow(
    taskId: string,
    waitMs = WORKFLOW_STOP_WAIT_MS,
  ): Promise<{ ok: boolean; status: WorkflowView['status'] | 'stopping' | 'unknown'; error?: string }> {
    if (!this.#workflows.has(taskId))
      return { ok: false, status: 'unknown', error: 'no such workflow in this session' };
    const current = () => this.#workflows.views().find((w) => w.taskId === taskId)?.status ?? 'unknown';
    if (!this.#workflows.isLive(taskId)) return { ok: true, status: current() };
    const stop = this.#backend?.controls.stopTask;
    if (!stop) return { ok: false, status: current(), error: `${this.#factory.displayName} cannot stop a workflow` };
    this.#workflows.noteStop(taskId);
    try {
      await stop(taskId);
    } catch (error) {
      this.#workflows.clearStop(taskId);
      return { ok: false, status: current(), error: String((error as Error)?.message ?? error) };
    }
    const end = Date.now() + waitMs;
    while (this.#workflows.isLive(taskId) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    return { ok: true, status: this.#workflows.isLive(taskId) ? 'stopping' : current() };
  }

  /**
   * D48: stop one agent of a workflow. Only when the backend can (Claude Code cannot: the user
   * gets the plain reason and the "Stop entire workflow" path, nothing is sent to the agent).
   */
  async stopWorkflowAgent(
    taskId: string,
    agentId: string,
  ): Promise<{ ok: boolean; status: ChildStatus | 'stopping' | 'unknown'; error?: string; unsupported?: boolean }> {
    const run = this.#workflows.views().find((w) => w.taskId === taskId);
    if (!run || !run.agents.some((a) => a.agentId === agentId))
      return { ok: false, status: 'unknown', error: 'no such workflow agent in this session' };
    if (this.#backend?.capabilities.workflowAgentStop !== true)
      return { ok: false, status: 'unknown', error: this.#noAgentStopText(), unsupported: true };
    return this.#hub.stop(agentId);
  }

  /**
   * The output of one background shell or monitor task of this session (R6.2, the client's
   * output view). Only tasks this session's own process started; never a workflow or an agent.
   */
  async taskOutput(
    taskId: string,
  ): Promise<
    | { ok: true; output: string; totalBytes: number; truncated: boolean }
    | { ok: false; code: 'unknown' | 'unsupported' | 'failed'; error: string }
  > {
    const kind = this.#taskKinds.get(taskId);
    if (kind === undefined) return { ok: false, code: 'unknown', error: 'no such task in this session' };
    if (kind !== 'shell' && kind !== 'monitor')
      return { ok: false, code: 'unsupported', error: 'only background shells and monitors have an output' };
    const read = this.#backend?.controls.taskOutput;
    if (!read)
      return { ok: false, code: 'unsupported', error: `${this.#factory.displayName} cannot show task output now` };
    try {
      const o = await read(taskId);
      const text = typeof o.output === 'string' ? o.output : '';
      if (text.length <= TASK_OUTPUT_MAX_CHARS)
        return { ok: true, output: text, totalBytes: o.totalBytes, truncated: o.truncated };
      return { ok: true, output: text.slice(-TASK_OUTPUT_MAX_CHARS), totalBytes: o.totalBytes, truncated: true };
    } catch (error) {
      return { ok: false, code: 'failed', error: String((error as Error)?.message ?? error) };
    }
  }

  #noteTaskKind(taskId: string, kind: TaskKind): void {
    this.#taskKinds.delete(taskId);
    this.#taskKinds.set(taskId, kind);
    if (this.#taskKinds.size > TASK_KINDS_KEPT) {
      const first = this.#taskKinds.keys().next().value;
      if (first !== undefined) this.#taskKinds.delete(first);
    }
  }

  /** D47: stop one background task from the plugin task list (a fallback row, or any task). */
  async stopTask(taskId: string): Promise<{ ok: boolean; error?: string }> {
    const backend = this.#backend;
    if (!this.#tasks.has(taskId)) return { ok: false, error: 'no such running task' };
    if (!backend?.controls.stopTask) return { ok: false, error: `${this.#factory.displayName} cannot stop one task` };
    try {
      await backend.controls.stopTask(taskId);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String((error as Error)?.message ?? error) };
    }
  }

  /** The user answered one ask in the UI. False when it is gone or the choice is not offered. */
  answer(askId: string, choiceId: string): boolean {
    return this.#desk.answer(askId, choiceId);
  }

  /** The user's full answer (feedback, question form, elicitation content). First answer wins. */
  respond(askId: string, reply: AskReply): AskResult {
    return this.#desk.respond(askId, reply);
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
    this.#restoreMode();
    const caps = this.#factory.staticCapabilities;
    const notes: string[] = [];
    const fail = (error: string): ChoiceResult => ({ ok: false, error, view: this.view() });
    if (req.mode !== undefined && !caps.permissionModes.some((m) => m.id === req.mode))
      return fail(`unknown mode: ${req.mode}`);
    if (
      req.mode !== undefined &&
      !offeredPermissionModes(caps.permissionModes, this.#opts.userConfig?.().options, [
        this.#live.mode,
        // The same list the picker shows (routes): the settings mode is offered before a spawn too.
        await this.#settingsMode(),
      ]).some((m) => m.id === req.mode)
    )
      return fail(`${req.mode} is not available in this session (it needs a ${this.#factory.displayName} option)`);
    const effortId = req.effort === null || req.effort === SETTINGS_CHOICE ? null : req.effort;
    if (typeof effortId === 'string' && !(caps.efforts ?? []).some((e) => e.id === effortId))
      return fail(`unknown effort: ${effortId}`);
    const agentId = req.agent === null || req.agent === SETTINGS_CHOICE ? null : req.agent;
    if (req.agent !== undefined && this.#agentLocked())
      return fail(
        caps.mainAgentPicker === 'none'
          ? `${this.#factory.displayName} has no main-thread agent picker`
          : 'the main-thread agent can only be picked before the first message of a new session',
      );
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
    let agentNote: string | undefined;
    if (req.agent !== undefined && (agentId ?? undefined) !== this.#agentChoice) {
      this.#agentChoice = agentId ?? undefined;
      // D15: the agent is a start option. A process the user started with "Start" before the
      // first message runs without it, so it ends now (idle, no turn yet) and the next message
      // starts it again with the agent.
      if (this.#backend && (agentId ?? undefined) !== this.#mainAgent) agentNote = await this.#restartForAgent();
      else agentNote = `applies when ${this.#factory.displayName} starts`;
    }
    const backend = this.#backend;
    if (agentNote !== undefined && req.model === undefined && req.effort === undefined && req.mode === undefined) {
      this.#notify();
      return { ok: true, note: agentNote, view: this.view() };
    }
    if (agentNote !== undefined) notes.push(agentNote);
    if (this.#resetPending) notes.push(await this.#resetIfIdle());
    else if (backend) {
      const error = await this.#applyChoices(backend);
      if (error) return fail(error);
      notes.push('applied');
    } else notes.push(`applies when ${this.#factory.displayName} starts`);
    this.#notify();
    return { ok: true, note: notes.filter(Boolean).join('; '), view: this.view() };
  }

  /** The mode the user's settings pick (display read, no process, D83); undefined when unknown. */
  async #settingsMode(): Promise<string | undefined> {
    const cwd = this.#port?.cwd;
    if (cwd === undefined || !this.#factory.settingsDefaults) return undefined;
    try {
      return (await this.#factory.settingsDefaults(cwd)).permissionMode;
    } catch {
      return undefined;
    }
  }

  /**
   * D15: a main-agent pick after "Start" and before the first message. The process has no turn yet;
   * it ends (nothing runs) and the next message starts it again with the agent as a start option.
   */
  async #restartForAgent(): Promise<string> {
    const b = this.#backend;
    if (!b) return `applies when ${this.#factory.displayName} starts`;
    if (this.#starting !== undefined || this.#tasks.size > 0 || this.#jobs.size > 0 || this.#turnActive)
      return `${this.#factory.displayName} is busy; the agent applies at its next start`;
    await this.#end(false);
    if (this.#backend === b) {
      this.#backend = undefined;
      this.#backendAbort = undefined;
    }
    this.#carryMode();
    this.#appliedModel = undefined;
    this.#refusedModel = undefined;
    this.#appliedEffort = undefined;
    this.#ultracode = undefined;
    this.#effort = undefined;
    this.#live = {};
    this.#mainAgent = undefined;
    return `${this.#factory.displayName} starts again with this agent at the next message`;
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
    this.#ultracode = undefined;
    this.#effort = undefined;
    this.#live = {};
    this.#resetPending = false;
    return `${this.#factory.displayName} will start again with your settings at the next message`;
  }

  /**
   * D28, D70 (M7 live): the conversation the agent runs under now. A `/clear` (as the last
   * message before a restart) gives it a new id with no step to bind; the agent's own record of
   * the newest human messages says which conversation took them. Their own binding else.
   */
  async #conversationNow(bound: string): Promise<string> {
    const f = this.#factory;
    const port = this.#port;
    if (!f.sessionHoldingInput || !port?.rewindPoints) return bound;
    let points: RewindPoint[];
    try {
      points = port.rewindPoints().filter((p) => !p.inherited);
    } catch {
      return bound;
    }
    // Newest first; the last one may be the message that starts this spawn (not taken yet).
    for (const p of points.slice(-2).reverse()) {
      try {
        const held = await f.sessionHoldingInput(f.inputIdFor?.(p.messageId) ?? p.messageId, port.cwd, bound);
        if (held === undefined) continue;
        if (held !== bound) this.#warn('resuming the conversation that took the last message', held);
        return held;
      } catch (error) {
        this.#warn('could not read the agent record', String((error as Error)?.message ?? error));
        return bound;
      }
    }
    return bound;
  }

  async #ensureBackend(): Promise<AgentBackendSession> {
    if (this.#disposed) throw new Error('the session is closed');
    if (this.#backend) return this.#backend;
    const port = this.#port;
    if (!port) throw new Error(`${this.#factory.displayName} cannot start: the session is not open`);
    this.#restoreMode();
    this.#starting ??= (async () => {
      const f = this.#factory;
      // M7 (R3.6): the record read decides first, so a spawn never runs ahead of what it shows.
      this.#checkOnOpen(true);
      await this.#recovery?.catch(() => undefined);
      const binding = port.latestBinding();
      const bound = binding?.sessionId;
      const derived = f.sessionIdFor?.(port.hostSessionId);
      const inherited = binding?.hostSessionId !== undefined && binding.hostSessionId !== port.hostSessionId;
      let start: OpenSessionOptions['start'];
      let startNotice: string | undefined;
      const forkRan =
        binding !== undefined &&
        inherited &&
        derived !== undefined &&
        f.staticCapabilities.resume &&
        (await f.sessionExists?.(derived, port.cwd)) === true;
      if (forkRan) {
        // M7: this fork already started once (its first turn ended before a reply was logged, for
        // example a crash): its own record exists, so it resumes; forking again would drop that turn.
        start = { kind: 'resume', sessionId: derived };
        this.#restoreCode = false;
      } else if (binding && inherited && f.staticCapabilities.fork !== 'none') {
        // D29: a host fork forks the backend session at the kept point; the source is left alone.
        const fork: Extract<OpenSessionOptions['start'], { kind: 'fork' }> = {
          kind: 'fork',
          fromSessionId: binding.sessionId,
        };
        if (derived !== undefined) fork.newSessionId = derived;
        if (binding.chainId !== undefined && f.staticCapabilities.fork === 'at-chain-point') {
          fork.atChainId = binding.chainId;
          // D29 (r3): the first dropped turn's input id, as a hint the backend checks itself.
          let dropped: string | undefined;
          try {
            dropped = await port.forkDroppedMessage?.();
          } catch (error) {
            this.#warn('could not read the fork source', String((error as Error)?.message ?? error));
          }
          const hint = dropped === undefined ? undefined : (f.inputIdFor?.(dropped) ?? dropped);
          if (hint !== undefined) fork.dropsTurnHint = hint;
          // D30: "restore code and conversation": the files go back to before that turn ran.
          if (this.#restoreCode) {
            if (hint !== undefined) fork.restoreFilesAt = hint;
            else
              startNotice =
                'The files were not restored: the turn after the branch point has no message of yours to restore to.';
          }
        }
        this.#restoreCode = false;
        start = fork;
      } else if (bound !== undefined && f.staticCapabilities.resume)
        start = { kind: 'resume', sessionId: await this.#conversationNow(bound) };
      else if (
        derived !== undefined &&
        (await f.sessionExists?.(derived, port.cwd)) === true &&
        f.staticCapabilities.resume
      )
        start = { kind: 'resume', sessionId: derived };
      else start = derived !== undefined ? { kind: 'new', sessionId: derived } : { kind: 'new' };
      // D15: a new session gets the picked main agent; a resumed one the agent it was started
      // with (read from the agent's own files, no process, D83). A fork keeps the CLI's own restore.
      let mainAgent: string | undefined;
      if (start.kind === 'new' || (start.kind === 'resume' && !this.#agentLocked())) mainAgent = this.#agentChoice;
      else if (start.kind === 'resume' && f.sessionMainAgent) {
        try {
          mainAgent = await f.sessionMainAgent(start.sessionId, port.cwd);
        } catch (error) {
          this.#warn('reading the main agent failed', String((error as Error)?.message ?? error));
        }
      }
      if (mainAgent !== undefined) start.mainAgent = mainAgent;
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
      this.#ultracode = undefined;
      this.#effort = undefined;
      this.#resetPending = false;
      this.#live = {};
      this.#mainAgent = mainAgent;
      if (mainAgent !== undefined) this.#live.agent = mainAgent;
      this.#agents = undefined;
      this.#mcp = undefined;
      this.#mcpFrom = 'none';
      if (trustNotice !== undefined) this.#live.notice = { level: 'warning', text: trustNotice, at: this.#now() };
      else if (startNotice !== undefined) this.#live.notice = { level: 'warning', text: startNotice, at: this.#now() };
      this.#lastExit = undefined;
      delete this.#lifecycle.restoreCodePending;
      this.#sent.clear();
      this.#tasks = new Set();
      this.#taskInfo.clear();
      this.#endedTasks.clear();
      this.#taskKinds.clear(); // a new process has none of the old one's tasks
      this.#closeStaleWorkflows();
      if (!this.#turnActive) this.#idleSince = this.#now();
      void this.#pump(backend);
      this.#loadModels(backend);
      this.#loadAgents(backend);
      // D54: a side question typed before the start is asked now that the user started the agent.
      queueMicrotask(() => {
        if (backend === this.#backend) this.#side.resume();
      });
      return backend;
    })();
    this.#notify();
    try {
      return await this.#starting;
    } catch (error) {
      // D54: a question waiting for this start would otherwise block every later one.
      this.#side.startFailed(String((error as Error)?.message ?? error));
      throw error;
    } finally {
      this.#starting = undefined;
      this.#notify();
    }
  }

  /**
   * D48, D74: workflow records left open in the log belong to a process that is gone (a host
   * restart ends it), so they are closed once, before the first process of this runtime runs.
   */
  #closeStaleWorkflows(): void {
    if (this.#staleChecked) return;
    this.#staleChecked = true;
    let open: OpenWorkflowRun[];
    try {
      open = this.#port?.openWorkflowRuns?.() ?? [];
    } catch (error) {
      this.#warn('could not read the workflow records', String((error as Error)?.message ?? error));
      return;
    }
    if (open.length > 0) this.#workflows.closeStale(open);
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
    // D45: child agents get their own child sessions (the live-child registry, ./children.ts).
    // Their events never reach this session's log (a child step would break the main step, D17).
    if (isChildEvent(e)) {
      this.#hub.handle(e);
      // D48: a workflow agent's member record names its child session.
      if (e.type === 'agent-start') this.#workflows.agentStarted(e);
      else if (e.type === 'agent-end') this.#workflows.agentEnded(e);
      this.#notify();
      return;
    }
    // R1.4: a turn (a typed `/effort` included) can change the applied effort; re-read it.
    if (e.type === 'turn-end') this.#readEffortState(from);
    switch (e.type) {
      case 'workflow-start':
        // Inside a turn it follows the launching call's result in the turn's order (D48).
        if (this.#box) break;
        this.#workflows.start(e);
        return;
      case 'workflow-snapshot':
        this.#workflows.snapshot(e);
        this.#notify();
        return;
      case 'workflow-end':
        this.#workflows.ended(e);
        return;
      case 'task-start': {
        this.#tasks.add(e.taskId);
        this.#noteTaskKind(e.taskId, e.kind);
        if (e.kind === 'workflow') this.#workflows.taskStarted(e.taskId, e.label);
        const info: TaskView = { taskId: e.taskId, kind: e.kind, label: e.label, status: 'running', job: false };
        if (e.agent?.kind === 'child') info.agent = e.agent.id;
        this.#taskInfo.set(e.taskId, info);
        this.#linkJob(e.taskId);
        this.#notify();
        return;
      }
      case 'task-progress': {
        if (e.summary) this.#jobs.get(e.taskId)?.progress(e.summary);
        const info = this.#taskInfo.get(e.taskId);
        if (info && e.summary) info.progress = e.summary;
        if (this.#hub.progress(e.taskId, e.usage) || info) this.#notify();
        return;
      }
      case 'task-end': {
        this.#tasks.delete(e.taskId);
        this.#jobs.get(e.taskId)?.end(e.status, e.summary);
        this.#jobs.delete(e.taskId);
        const info = this.#taskInfo.get(e.taskId);
        if (info) {
          this.#taskInfo.delete(e.taskId);
          if (info.kind === 'shell' || info.kind === 'monitor') {
            this.#endedTasks.set(e.taskId, { ...info, status: e.status, job: false });
            if (this.#endedTasks.size > ENDED_TASKS_KEPT) {
              const first = this.#endedTasks.keys().next().value;
              if (first !== undefined) this.#endedTasks.delete(first);
            }
          }
          // D26: the next wake trigger names what ended in the background.
          const word = e.status === 'completed' ? 'finished' : e.status;
          this.#wakeNotes.push(`background ${info.kind} "${info.label}" ${word}`);
          if (this.#wakeNotes.length > 20) this.#wakeNotes = this.#wakeNotes.slice(-20);
        }
        this.#touchIdle();
        this.#notify();
        return;
      }
      case 'tasks-snapshot': {
        // The full list (D47): it corrects drift for the reaping check and the task list.
        this.#tasks = new Set(e.taskIds);
        for (const id of [...this.#taskInfo.keys()]) if (!this.#tasks.has(id)) this.#taskInfo.delete(id);
        return;
      }
      case 'exit':
        this.#exit(e, from);
        return;
      case 'session-info':
        this.#live = this.#live.notice ? { notice: this.#live.notice } : {};
        if (this.#mainAgent !== undefined) this.#live.agent = this.#mainAgent;
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
      case 'commands':
        // R7.1: names only from the start report; read the full rows from the live process.
        this.#setCommands(e.list, e.namesOnly !== true);
        if (e.namesOnly === true) this.#loadCommands(from);
        return;
      case 'mcp-status':
        // D55: the agent's own start report; a live read replaces it.
        if (this.#mcpFrom !== 'live' || !this.#mcp) {
          this.#mcp = e.servers.map((m) => ({ ...m }));
          this.#mcpFrom = 'reported';
          this.#notify();
        }
        return;
      case 'conversation-reset':
        // D70: the side-question history belongs to the old conversation.
        this.#side.clear();
        if (this.#usage.apply(e, this.#box ? this.#sink?.turn : undefined)) this.#notify();
        return;
      case 'context':
      case 'compaction':
      case 'limits':
      case 'auth':
        // M5: state for the usage panel and the context pill; never a log event (D59).
        if (this.#usage.apply(e, this.#box ? this.#sink?.turn : undefined)) this.#notify();
        return;
      case 'retry':
        if (this.#usage.apply(e, this.#box ? this.#sink?.turn : undefined)) this.#notify();
        return;
      case 'usage':
        // A turn's figure belongs to the host turn it ran in: inside a turn (or a wake turn
        // still opening) it goes through the turn's queue, so it is bound when it is handled.
        if (e.turn !== undefined && (this.#box || this.#wakeBuffer)) break;
        if (this.#usage.apply(e)) this.#notify();
        return;
      case 'files-rewound':
        // D30: a rewind fork's "restore code" ran on the new process before its first turn.
        this.#noteRewind(e.inputId, e.result);
        return;
      case 'interaction-done':
        // D43: a URL elicitation completed; its waiting card closes.
        this.#desk.done(e.id);
        return;
      case 'interaction-cancel':
        this.#desk.cancel(e.id);
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
      this.#wakeText = this.#wakeSummary();
      this.#wakeItems = [...this.#wakeNotes];
      const port = this.#port;
      if (port) port.wake(this.#wakeText);
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
    const intended = this.#ending.has(from) || e.reason === 'disposed' || e.reason === 'force-stopped';
    this.#lateStopped = false;
    this.#carryMode();
    this.#desk.dropAll(); // the process that asked is gone
    this.#backend = undefined;
    this.#backendAbort = undefined;
    for (const [, link] of this.#jobs) link.end('failed', e.error ?? `${this.#factory.displayName} ended`);
    this.#jobs.clear();
    this.#tasks = new Set();
    this.#taskInfo.clear();
    // D74: every live child closes its open step and ends its turn, before the root turn ends.
    if (intended) this.#hub.endAll('stopped', `${this.#factory.displayName} was stopped`);
    else this.#hub.endAll('failed', crashMessage(this.#factory.displayName, e.error));
    // D48, D74: every live workflow run ends with its process.
    if (intended) this.#workflows.closeAll('cancelled', `${this.#factory.displayName} was stopped`);
    else this.#workflows.closeAll('error', crashMessage(this.#factory.displayName, e.error));
    // A new process has none of this process's inputs: an unclaimed steer is sent again (D22).
    this.#sent.clear();
    this.#earlySteers = [];
    this.#touchIdle();
    const duringTurn = this.#box !== undefined || this.#wakeBuffer !== undefined;
    if (!intended) {
      this.#lastExit = { at: this.#now(), duringTurn };
      if (e.error !== undefined) this.#lastExit.error = e.error;
      if (e.reason !== undefined) this.#lastExit.reason = e.reason;
      if (e.code !== undefined) this.#lastExit.code = e.code;
      if (e.signal !== undefined) this.#lastExit.signal = e.signal;
      if (e.stderr !== undefined) this.#lastExit.stderr = e.stderr;
      // R3.6: what the agent recorded but never sent before it died is read back (no process).
      this.#recovery = this.#recoverTail('crash');
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
        this.#effort = undefined; // a model can change the applied effort (R1.4)
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
        this.#effort = undefined; // stale until the read below answers (R1.4)
      } catch (error) {
        failed('setEffort', error);
      }
    }
    const mode = this.#pendingMode;
    if (mode !== undefined && backend.controls.setPermissionMode) {
      try {
        await backend.controls.setPermissionMode(mode);
        this.#pendingMode = undefined;
        // No local copy: the agent's own mode report (`mode` event) is the truth (R5.1, D38).
      } catch (error) {
        this.#pendingMode = undefined;
        failed('setPermissionMode', error);
      }
    }
    this.#readEffortState(backend);
    return firstError;
  }

  /**
   * D37: read the agent's effort state (no process, the live session answers) without holding the
   * caller; the next view shows it. Ultracode can depend on the model, so this runs after every
   * applied choice, a model switch included.
   */
  #readEffortState(backend: AgentBackendSession): void {
    const read = backend.controls.effortState;
    if (!read) return;
    read.call(backend.controls).then(
      (state) => {
        if (backend !== this.#backend) return;
        const next: NonNullable<LiveInfo['ultracode']> = { on: state.ultracode === true };
        if (state.ultracodeRequested !== undefined) next.requested = state.ultracodeRequested;
        if (state.ultracodeAvailable !== undefined) next.available = state.ultracodeAvailable;
        const cur = this.#ultracode;
        const effort = state.effort;
        if (
          cur &&
          cur.on === next.on &&
          cur.requested === next.requested &&
          cur.available === next.available &&
          effort === this.#effort
        )
          return;
        this.#ultracode = next;
        this.#effort = effort;
        this.#notify();
      },
      (error: unknown) => this.#warn(`effortState failed: ${String((error as Error)?.message ?? error)}`),
    );
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

  /** D51: the live process's agent list for the main-thread picker (no extra process, rule 9). */
  #loadAgents(backend: AgentBackendSession): void {
    if (!backend.controls.agents) return;
    backend.controls.agents().then(
      (list) => {
        if (backend !== this.#backend) return;
        this.#agents = list;
        this.#notify();
      },
      (error) => this.#warn('reading the agent list failed', String(error)),
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

  /**
   * R7.2: a local command step names its command in the binding (a native field, D21), so it
   * survives reload and fork. The structured twin has no host event type: it is kept in memory
   * and the binding carries its id (display-only path).
   */
  #localCommandBinding(lc: NonNullable<BackendEventOf<'step-message'>['localCommand']>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (lc.name !== undefined) out.name = lc.name;
    if (lc.args !== undefined && lc.args !== '') out.args = lc.args;
    if (lc.unavailable) out.unavailable = true;
    if (lc.structured) {
      out.structured = lc.structured.kind;
      out.outputId = this.#local.add(lc.structured);
    }
    return out;
  }

  #binding(): Record<string, unknown> {
    const b: Record<string, unknown> = {
      backend: this.#factory.kind,
      sessionId: this.#backend?.sessionId ?? this.#recoverySession ?? '',
      hostSessionId: this.#port?.hostSessionId ?? '',
    };
    const chain = this.#lastChainId;
    if (chain !== undefined) b.lastChainId = chain;
    // D24: the user's mode choice rides in the binding, so a host restart can apply it again.
    if (this.#modeChosen) {
      const mode = this.#live.mode ?? this.#pendingMode;
      if (mode !== undefined) b.mode = mode;
    }
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
    // M7 (R3.6): a turn that only shows replies read back from the agent's record needs no process.
    const recoveryOnly = wake && this.#wakeRecovery && fresh.length === 0 && waiting.length === 0;
    this.#turnActive = true;
    this.#hadTurn = true;
    this.#idleSince = undefined;
    let backend: AgentBackendSession | undefined;
    // Stop while the process starts: a trust question waiting for the user is declined (D73).
    const stopStart = () => this.#desk.stop(['trust']);
    signal.addEventListener('abort', stopStart, { once: true });
    try {
      if (!recoveryOnly) {
        // D35 exact reset: a pending "back to my settings" restarts the idle process first.
        if (this.#resetPending) await this.#resetIfIdle(true);
        backend = await this.#ensureBackend();
        await this.#applyChoices(backend);
      }
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
    this.#sink = sink;
    this.#requestStep = false;
    this.#lateStopped = false; // a new turn takes what comes; a late turn end has pendingInputs > 0
    // A recovery the record read found while this turn started joins it, before its input.
    if (this.#wakeBuffer === undefined && this.#pendingRecovery) this.#flushRecovery(true);
    const recovering = this.#wakeRecovery && this.#wakeBuffer !== undefined;
    for (const e of this.#wakeBuffer ?? []) box.push(e);
    this.#wakeBuffer = undefined;
    this.#wakePending = false;
    this.#wakeRecovery = false;
    this.#recoveryTurn = recoveryOnly;
    // D26: a wake turn shows what woke it, once, in its first step (log-only for the agent).
    const triggered = wake || recovering;
    this.#triggerPending = triggered ? (this.#wakeText ?? this.#wakeSummary()) : undefined;
    this.#triggerItems = triggered ? (this.#wakeItems ?? [...this.#wakeNotes]).slice(-20) : [];
    this.#wakeText = undefined;
    this.#wakeItems = undefined;
    this.#wakeNotes = [];
    this.#notify();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (!backend) {
        box.push({ type: 'ended' }); // a recovery turn has no process to interrupt
        return;
      }
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
      // Elicitations are never answered by Stop: the agent itself cancels the one its interrupt
      // ends (its abort signal closes the card), and one from a background agent stays open.
      this.#desk.stop(['permission', 'question', 'plan'], ['main']);
      timer = setTimeout(() => box.push({ type: 'stop-timeout' }), this.#opts.stopGraceMs ?? STOP_GRACE_MS);
    };

    let outcome: TurnOutcome;
    /** A message of this turn the backend refused to take (it is in the host log as typed). */
    let sendError: string | undefined;
    try {
      let sent = 0;
      for (const u of fresh) {
        if (!backend) break;
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
      if (backend) for (const u of this.#earlySteers.splice(0)) this.#sendSteer(backend, u);
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
      this.#closeAudits(); // D74: before the turn ends
      this.#sink = undefined;
      try {
        sink.closeStep(); // D74: every open step is closed before the turn ends
        this.#claimConsumed(sink);
      } catch (error) {
        this.#warn('closing the step failed', String(error));
      }
      this.#turnActive = false;
      this.#requestStep = false;
      this.#usage.turnEnded();
      this.#touchIdle();
      // Events that arrived after the turn end belong to the agent's next, self-started turn.
      const rest = box
        .drain()
        .filter(
          (i): i is BackendEvent => i.type !== 'stop-timeout' && i.type !== 'ended' && i.type !== 'recovered-end',
        );
      const current = this.#backend;
      if (current) for (const e of rest) this.#route(e, current);
      this.#recoveryTurn = false;
      this.#flushRecovery(); // a recovery found during this turn opens its own turn now
      this.#notify();
    }
    this.#triggerPending = undefined;
    // D74: children closed by a crash, force stop or interrupt end their turns before this one.
    if (outcome!.kind !== 'completed') await this.#hub.quiesce(1500);
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

  /** Open a step; the first step of a wake turn carries the turn's visible trigger (D26). */
  #openStep(sink: TurnSink, startedAt?: number): void {
    this.#requestStep = false;
    if (startedAt === undefined) sink.openStep();
    else sink.openStep(startedAt);
    const text = this.#triggerPending;
    if (text === undefined) return;
    this.#triggerPending = undefined;
    const items = this.#triggerItems;
    this.#triggerItems = [];
    try {
      sink.trigger?.(text, items);
    } catch (error) {
      this.#warn('could not write the wake trigger', String((error as Error)?.message ?? error));
    }
  }

  #handle(sink: TurnSink, e: Item, prepared?: SinkResultContent[]): TurnOutcome | undefined {
    try {
      switch (e.type) {
        case 'request-start':
          // R8.4: the step starts at the request, so DSH's first-token time is the real one. A
          // retried request with nothing shown yet keeps its step (as DSH's own in-step retry).
          if (sink.stepOpen) {
            if (!sink.hasMessage && this.#requestStep) return undefined;
            if (sink.hasMessage && sink.openCallIds.length > 0) return undefined; // results still due
            sink.closeStep(); // a stale response, or a finished whole response (D18, D84)
          }
          this.#claimConsumed(sink);
          this.#openStep(sink, e.at);
          this.#requestStep = true;
          return undefined;
        case 'step-start':
          if (sink.stepOpen && !sink.hasMessage && this.#requestStep) {
            this.#requestStep = false; // the response joins the step its request opened
            return undefined;
          }
          if (sink.stepOpen) sink.closeStep(); // stale step: attempt or repairs, then step/end (D18)
          this.#claimConsumed(sink);
          this.#openStep(sink, e.at);
          return undefined;
        case 'delta': {
          const tool =
            e.kind === 'tool-input' && e.toolCallId !== undefined && e.toolName !== undefined
              ? { id: e.toolCallId, name: e.toolName }
              : undefined;
          if (tool) sink.delta(e.kind, e.blockIndex, e.text, e.at, tool);
          else sink.delta(e.kind, e.blockIndex, e.text, e.at);
          return undefined;
        }
        case 'usage':
          if (this.#usage.apply(e, sink.turn)) this.#notify();
          return undefined;
        case 'step-message': {
          this.#noteChain(e.lastChainId);
          const continued = sink.stepOpen && sink.hasMessage;
          this.#requestStep = false;
          if (!sink.stepOpen) {
            this.#claimConsumed(sink);
            this.#openStep(sink);
          }
          const binding = this.#binding();
          if (e.localCommand) binding.localCommand = this.#localCommandBinding(e.localCommand);
          // Rule 8: the CLI's text as it wrote it; the client draws local outputs (R7.2, D69 r5).
          const m: Parameters<TurnSink['commit']>[0] = { blocks: e.blocks, binding };
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
        case 'workflow-start':
          // D48: after the launching call's result, so the run's node sits in that step.
          this.#workflows.start(e);
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
          if (e.outcome === 'interrupted') {
            this.#hub.endForeground(); // D74: foreground children end with the main turn
            return { kind: 'interrupted' };
          }
          return { kind: 'completed' };
        case 'ended':
          return { kind: 'interrupted' };
        case 'recovered-end':
          // The read-back steps are written; only a turn of their own ends here.
          if (!this.#recoveryTurn) return undefined;
          sink.closeStep();
          return { kind: 'completed' };
        case 'exit':
          if (this.#forced) return { kind: 'interrupted' };
          return { kind: 'error', message: crashMessage(this.#factory.displayName, e.error) };
        case 'stop-timeout': {
          this.#warn('the agent did not end its turn after Stop; closing it here');
          this.#lateStopped = true;
          // Steers it never took go back to the user rather than run unseen later (D25).
          const unconsumed = [...this.#sent].filter(([, s]) => s.steer && !s.consumed).map(([id]) => id);
          this.#returnSteers(unconsumed);
          this.#hub.endForeground(); // D74
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
    // D48, D74: live runs end; their records are written while the child sessions still exist.
    this.#workflows.closeAll('cancelled', `${this.#factory.displayName} was stopped`);
    await this.#workflows.flush(2000);
    await this.#hub.dispose(); // D74: child turns closed, child sessions released
    this.#backend = undefined;
    this.#port = undefined;
    // Close every interaction channel of this session: the session is gone (D39).
    const ends = [...this.#endListeners];
    this.#endListeners.clear();
    this.#listeners.clear();
    for (const end of ends) {
      try {
        end();
      } catch (error) {
        this.#warn('interaction channel close failed', String(error));
      }
    }
  }
}
