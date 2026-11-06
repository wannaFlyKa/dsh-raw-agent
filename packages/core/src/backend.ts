// The backend interface (architecture §7.2). No DSH imports and no agent-SDK imports.
//
// This is the Phase 3 spike subset. Names and shapes follow §7.2 exactly; members that the
// spike does not need yet are left out and will be added in place, not renamed.

import type { BackendEvent } from './events.js';

/** A backend kind the DSH layer can mount (D80). One preset and one catalog provider per factory. */
export interface AgentBackendFactory {
  /** 'claude-code'. Also the catalog provider id and the preset suffix (D80). */
  readonly kind: string;
  /** 'Claude Code'. Used for labels such as "Start Claude Code" (D4). */
  readonly displayName: string;
  /** Everything the DSH layer may read before a process exists (r4, D4). */
  readonly staticCapabilities: FactoryCapabilities;

  /** No-process reads (D83). Optional; none may start a process. */
  sessionExists?(sessionId: string, cwd: string): Promise<boolean>;
  sessionTitle?(sessionId: string, cwd: string): Promise<string | undefined>;
  /** Read-only: does the agent already trust this folder (D73)? Never writes the record. */
  trustState?(cwd: string): Promise<TrustState>;
  /** The agent's own settings files for this folder (D63). Paths only; nothing is read or written. */
  configFiles?(cwd: string): Promise<ConfigFileInfo[]>;
  /** Mask secret values in one file's text (D63). The DSH layer knows no file format. */
  maskConfig?(file: { path: string; format: string }, text: string): MaskedConfig;
  /**
   * Read-only preview of what the user's settings choose for a new session (R1.4): model, effort
   * and permission mode. For display only; the agent applies its own settings itself.
   */
  settingsDefaults?(cwd: string): Promise<SettingsDefaults>;
  /**
   * D49, D50: a child agent's own transcript as backend events (steps, tool results and the
   * agent's inputs, all with `agent: ref`), read from the agent's files. For a cold child view
   * after a restart and for teammate transcripts. No `agent-start` / `agent-end`.
   */
  readAgentTranscript?(sessionId: string, ref: AgentRef, cwd: string): Promise<BackendEvent[]>;
  /**
   * D15 (r4): the main-thread agent a session was started with, read from the agent's own
   * files, so a resume after a restart passes the same agent again. Undefined: none found.
   */
  sessionMainAgent?(sessionId: string, cwd: string): Promise<string | undefined>;

  /** Only when ids === 'host-chosen' (D5): deterministic, no storage. */
  sessionIdFor?(hostSessionId: string): string;
  inputIdFor?(hostMessageId: string): string;

  open(options: OpenSessionOptions): Promise<AgentBackendSession>;
}

export interface FactoryCapabilities {
  ids: 'host-chosen' | 'agent-chosen';
  resume: boolean;
  fork: 'at-chain-point' | 'whole-session' | 'none';
  /** Backend-owned config fields (Claude: the bypass switch, D14). Volatile (D87). */
  userOptions?: OptionSchema[];
  /** Control names that show "Start <displayName>" while no process runs (D4). */
  needsProcess: string[];
  /** 'btw' for Claude (D54). */
  sideQuestionCommand?: string;
  /** Static default list for the mode picker (D38). */
  permissionModes: PermissionModeInfo[];
  /**
   * The order of the agent's own "next mode" key (Claude: Shift+Tab). Unavailable modes are
   * skipped; a mode not in the list goes to the first entry. Absent: the agent has no such key.
   */
  permissionModeCycle?: string[];
  mainAgentPicker: 'new-session-only' | 'any-time' | 'none';
  efforts?: EffortInfo[];
  /** How mid-turn input is taken (D27). */
  steer: 'native' | 'restart' | 'queue';
}

export type SessionStart =
  | { kind: 'new'; sessionId?: string; mainAgent?: string }
  | { kind: 'resume'; sessionId: string; mainAgent?: string }
  | {
      kind: 'fork';
      fromSessionId: string;
      atChainId?: string;
      dropsTurnHint?: string;
      newSessionId?: string;
      mainAgent?: string;
    };

export interface OpenSessionOptions {
  cwd: string;
  /** The DSH process env. The backend applies its own env policy (D17a). */
  env: Readonly<Record<string, string | undefined>>;
  start: SessionStart;
  /** Only after the user's click (D73). */
  trustAccepted?: { directory: string };
  userConfig: BackendUserConfig;
  interactions: InteractionHandler;
  /** Aborts only on dispose or force stop. */
  signal: AbortSignal;
}

export interface BackendUserConfig {
  executablePath?: string;
  /** Values for staticCapabilities.userOptions, validated by the backend. */
  options: Readonly<Record<string, unknown>>;
}

export interface AgentBackendSession {
  readonly kind: string;
  /** Changes on conversation-reset (D70). */
  readonly sessionId: string;
  readonly capabilities: BackendCapabilities;
  readonly startedAs: 'new' | 'resumed' | 'forked';
  /** One iterator per session. It ends after an `exit` event. */
  events(): AsyncIterable<BackendEvent>;

  send(input: UserInput, mode: 'next' | 'queue'): Promise<void>;
  /** Never ends the process (rule 6). */
  interrupt(opts?: { cancelQueued?: boolean }): Promise<{ cancelledInputIds: string[] }>;
  /** Ends the process (an explicit user action). */
  forceStop(): Promise<void>;
  dispose(): Promise<void>;

  readonly controls: BackendControls;
}

export interface BackendCapabilities {
  backendVersion?: string;
  perTaskStop: boolean;
  sideQuestions: boolean;
  workflows: boolean;
  teamMessaging: boolean;
  /**
   * D48: one workflow agent can be stopped on its own. false for Claude Code: the CLI has no
   * control for it (its terminal app's "skip agent" is internal; `stopTask(<agent id>)` is a
   * silent no-op on 2.1.318). Stop the whole run with `stopTask(<run task id>)` instead.
   */
  workflowAgentStop?: boolean;
  cancelQueued: boolean;
  fileRewind: boolean;
  planChoices: PlanChoiceInfo[];
  mainAgentPicker?: 'new-session-only' | 'any-time' | 'none';
  permissionModes?: PermissionModeInfo[];
  efforts?: EffortInfo[];
  sideQuestionCommand?: string;
  needsProcess?: string[];
  toolViewPack?: string;
}

export interface BackendControls {
  stopTask?(taskId: string): Promise<void>;
  setPermissionMode?(mode: string): Promise<void>;
  setModel?(model: string): Promise<void>;
  /** An id from capabilities.efforts; null clears the flag layer. */
  setEffort?(effortId: string | null): Promise<void>;
  /**
   * D37: the agent's own standing workflow mode, on or off, at any effort level (Claude:
   * ultracode, the terminal app's `/effort ultracode on|off`). Session only.
   */
  setUltracode?(on: boolean): Promise<void>;
  /** The effort and ultracode state the agent reports now (Claude: `getSettings().applied`). */
  effortState?(): Promise<EffortState>;
  models?(): Promise<ModelInfo[]>;
  agents?(): Promise<AgentInfo[]>;
  commands?(): Promise<CommandInfo[]>;
  contextUsage?(detail: 'summary' | 'full'): Promise<ContextUsage>;
  /** The end of a background shell or monitor task's output (Claude: `getTaskOutput`). */
  taskOutput?(taskId: string): Promise<TaskOutput>;
  /** Send a message to a running teammate (D50). Absent when the agent has no such control. */
  messageTeammate?(ref: AgentRef, text: string): Promise<void>;
}

export interface TaskOutput {
  /** Plain text as the command wrote it (escape sequences included); render it as text. */
  output: string;
  totalBytes: number;
  /** true: `output` is only the end of a longer output. */
  truncated: boolean;
}

export type AgentRef = { kind: 'main' } | { kind: 'child'; id: string };

export type UserInputPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; base64: string }
  | { type: 'file'; hostPath: string };

export interface UserInput {
  /** factory.inputIdFor(DSH message id), or a host id when ids are agent-chosen. */
  id: string;
  parts: UserInputPart[];
}

// ---- interactions (§7.1: through calls, not the event stream) ----

export interface InteractionHandler {
  permission(req: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer>;
  question(req: QuestionRequest, signal: AbortSignal): Promise<QuestionAnswer>;
  plan(req: PlanRequest, signal: AbortSignal): Promise<PlanAnswer>;
  elicitation(req: ElicitationRequest, signal: AbortSignal): Promise<ElicitationAnswer>;
}

export interface PermissionOption {
  id: string;
  kind: 'allow-once' | 'allow-always' | 'reject-once' | 'reject-always';
  /** The agent's own wording where it has one (Claude: the TUI's "Yes, and don't ask again for …"). */
  label: string;
  /** Where an "always" choice is saved, in plain words ("project local settings"). */
  destination?: string;
  /** What an "always" choice saves, one line each (Claude: the exact rule text, `Bash(rm:*)`). */
  effects?: string[];
  acceptsFeedback?: boolean;
  /** Placeholder for the feedback field (Claude: "and tell Claude what to do differently"). */
  feedbackPlaceholder?: string;
  /**
   * The rule this "always" choice saves may be edited before it is saved, as in the agent's
   * terminal app (Claude: "Yes, and don't ask again for: <command prefix>"). `ruleContent` is the
   * agent's own suggestion; the answer's `ruleContent` replaces it.
   */
  editableRule?: { toolName: string; ruleContent: string; placeholder?: string };
}

export interface PermissionRequest {
  id: string;
  agent: AgentRef;
  agentLabel?: string;
  callId?: string;
  toolName: string;
  displayName?: string;
  input: unknown;
  title?: string;
  description?: string;
  reason?: string;
  blockedPath?: string;
  /** Open the card on its reject option and offer no one-key approve (Claude: `defaultToNo`). */
  defaultToNo?: boolean;
  /** For an MCP tool: the server that serves it. `name` is untrusted text from configuration. */
  mcpServer?: { name: string; source: string };
  options: PermissionOption[];
}

/** The backend turns a reject option into its own text (D40). The DSH layer never builds deny text. */
export interface PermissionAnswer {
  optionId: string;
  feedback?: string;
  /** The edited rule of an `editableRule` choice (only when the user changed it). */
  ruleContent?: string;
}

export interface QuestionItem {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: Array<{ label: string; description?: string; preview?: string }>;
  /** The user may type their own answer instead of picking an option (Claude: always, as "Other"). */
  allowsOther: boolean;
}

export interface QuestionRequest {
  id: string;
  agent: AgentRef;
  agentLabel?: string;
  callId?: string;
  questions: QuestionItem[];
  /**
   * How option previews are written (D13). 'html' only when the user's own env chose it; the UI
   * must then show it as text or in a sandbox, never as live HTML.
   */
  previewFormat: 'markdown' | 'html';
  /** Label of the "type your own answer" choice (Claude: "Other"). */
  otherLabel: string;
  /**
   * The agent offers to talk the questions over instead of answering (Claude: "Chat about this").
   * The UI then sends `chat: true` with whatever answers the user gave so far.
   */
  chatLabel?: string;
}

/**
 * Keyed by question text, as the CLI expects. A multi-select answer lists the picked labels; an
 * "Other" answer is the typed text. `notes` are optional free-text notes per question. `null`
 * means the user dismissed the card.
 */
export type QuestionAnswer = {
  answers: Record<string, string | string[]>;
  notes?: Record<string, string>;
  /** The user picked the `chatLabel` choice; `answers` may be partial or empty. */
  chat?: true;
} | null;

export interface PlanRequest {
  id: string;
  agent: AgentRef;
  agentLabel?: string;
  callId?: string;
  plan: string;
  planFilePath?: string;
  /** Approve choices, in the agent's own order and words (D42). */
  choices: PlanChoiceInfo[];
  /** The "keep planning" choice; it takes optional feedback (D42). */
  keepPlanning: { label: string; feedbackPlaceholder?: string };
}

export type PlanAnswer = { kind: 'approve'; choiceId: string } | { kind: 'keep-planning'; feedback?: string };

export interface ElicitationRequest {
  id: string;
  /**
   * Which agent's tool call asked, when the backend can tell (D44). Claude's callback names no
   * agent; the backend infers it from the open MCP tool calls of that server. Absent: unknown.
   */
  agent?: AgentRef;
  agentLabel?: string;
  serverName: string;
  message: string;
  mode?: 'form' | 'url';
  url?: string;
  /** Correlates a URL elicitation with its completion (`interaction-done`, D43). */
  elicitationId?: string;
  requestedSchema?: unknown;
  title?: string;
  displayName?: string;
  description?: string;
}

export type ElicitationAnswer =
  { action: 'accept'; content?: Record<string, unknown> } | { action: 'decline' } | { action: 'cancel' };

// ---- plain data shapes ----

export interface PermissionModeInfo {
  id: string;
  label: string;
  /** The agent's own one-line description of the mode. */
  description?: string;
  /**
   * Offered only when this backend user option is on (D38 r4; Claude: bypass needs
   * `allowDangerouslySkipPermissions`, as `claude --allow-dangerously-skip-permissions`, D14).
   * A mode the session already runs in (for example from the user's settings) is still shown.
   */
  requiresOption?: string;
}

export interface EffortState {
  effort?: string;
  /** In effect now. */
  ultracode: boolean;
  /** Asked for (a setting or a session choice), whether or not it can take effect. */
  ultracodeRequested?: boolean;
  /** Can be turned on (workflows on and a model that supports it). Offer the control only then. */
  ultracodeAvailable?: boolean;
}

export interface EffortInfo {
  id: string;
  label: string;
  /**
   * `level` (default): one effort level; a model's own effort list narrows it (D34). `mode`: a
   * session mode beside the level that keeps the level as it is (Claude: ultracode, D37). A model's
   * effort list does not narrow a mode; the live `EffortState` says whether it can be turned on.
   */
  kind?: 'level' | 'mode';
  /** One plain line for the picker's tooltip. */
  description?: string;
}

export interface PlanChoiceInfo {
  id: string;
  label: string;
  /** The permission mode the agent runs in after this choice, when it is known. */
  mode?: string;
}

export interface OptionSchema {
  key: string;
  type: 'boolean' | 'string';
  label: string;
  description?: string;
  default?: boolean | string;
}

export interface ModelInfo {
  value: string;
  displayName: string;
  description?: string;
  efforts?: string[];
  /** false: the agent says its auto permission mode is not available with this model (D38). */
  supportsAutoMode?: boolean;
}

export interface AgentInfo {
  name: string;
  description?: string;
  /** The agent's own model choice as the agent reports it ('inherit' = the parent's model). */
  model?: string;
}

export interface CommandInfo {
  name: string;
  description?: string;
  argumentHint?: string;
}

/** One settings file the agent reads (D63). `scope` is a stable key such as 'user' or 'project'. */
export interface ConfigFileInfo {
  label: string;
  path: string;
  scope: string;
  format: 'json' | 'toml' | 'text';
}

/** One hidden value. `start`/`end` index the masked text; `sourceStart`/`sourceEnd` the original. */
export interface ConfigSecret {
  start: number;
  end: number;
  sourceStart: number;
  sourceEnd: number;
  /** The key path of the value, for example 'env.ANTHROPIC_API_KEY'. */
  key?: string;
}

export interface MaskedConfig {
  masked: string;
  secrets: ConfigSecret[];
}

/** The agent's own workspace-trust question (D73), as its terminal app shows it. */
export interface TrustQuestion {
  title: string;
  body: string;
  acceptLabel: string;
  declineLabel: string;
}

export interface TrustState {
  state: 'trusted' | 'untrusted' | 'unknown';
  /** The folder the trust is for (what `trustAccepted.directory` must name). */
  directory: string;
  /** Repository root, when the folder is inside one. */
  root?: string;
  /** Where a 'trusted' answer came from (the folder itself or a parent). */
  trustedBy?: string;
  /** What is lost while untrusted, in the agent's own terms (from S10). */
  untrustedEffect?: string;
  question?: TrustQuestion;
}

export interface ContextUsage {
  used: number;
  window: number;
  autoCompactAt?: number;
  categories?: Array<{ name: string; tokens: number }>;
}

/** What the user's own settings choose (R1.4). Display only; read without a process (D83). */
export interface SettingsDefaults {
  model?: string;
  effort?: string;
  permissionMode?: string;
  /** Where each value came from, for example 'env', 'local', 'project', 'user'. */
  sources: Partial<Record<'model' | 'effort' | 'permissionMode', string>>;
  /**
   * D63: every top-level key of the settings files and the layers that set it, highest
   * precedence first. `merged` when more than one layer sets an object or list value (the agent
   * combines those layers instead of picking one).
   */
  keys?: SettingsKeySource[];
}

export interface SettingsKeySource {
  key: string;
  /** Scopes that set the key, highest precedence first (for Claude: local, project, user). */
  scopes: string[];
  merged?: boolean;
}

/** A session-only choice from the UI (D35-D38). `null` or 'settings' means "back to my settings". */
export interface SessionChoiceRequest {
  model?: string;
  effort?: string | null;
  mode?: string;
  /**
   * D15, D51: the main-thread agent for a new session (a pending choice, passed at spawn). `null`
   * or 'settings' means "no agent" (the agent's own settings decide). Refused after the first turn.
   */
  agent?: string | null;
}
