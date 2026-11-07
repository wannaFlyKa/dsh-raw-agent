// The backend interface (architecture §7.2). No DSH imports and no agent-SDK imports.
//
// This is the Phase 3 spike subset. Names and shapes follow §7.2 exactly; members that the
// spike does not need yet are left out and will be added in place, not renamed.

import type { BackendEvent } from './events.js';
import type { ContextCategory, UsageSnapshot } from './usage.js';

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
  /**
   * D28, D70 (M7 live): the agent conversation whose own record holds this input (the backend
   * input id, D5), checking `prefer` first. A `/clear` gives the conversation a new id with no
   * step for the host to bind it to; this read finds it after a restart. No process.
   */
  sessionHoldingInput?(inputId: string, cwd: string, prefer?: string): Promise<string | undefined>;
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
   * M7 (R3.6): what the agent wrote on its main thread after one chain entry, read from its own
   * files (no process). The DSH layer uses it to find replies the agent recorded but the host
   * log never got (the host died, or the process died before its last frames arrived).
   */
  readSessionTail?(sessionId: string, cwd: string, afterChainId: string): Promise<SessionTail>;
  /**
   * D15 (r4): the main-thread agent a session was started with, read from the agent's own
   * files, so a resume after a restart passes the same agent again. Undefined: none found.
   */
  sessionMainAgent?(sessionId: string, cwd: string): Promise<string | undefined>;
  /**
   * D16, D30 (M7): whether a session started in this folder now would keep file checkpoints, so
   * a rewind dialog can offer "restore code" before any process runs. Read-only, no process.
   */
  fileRewindAvailable?(cwd: string): Promise<boolean>;

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
  /**
   * The agent command that opens its MCP view in its terminal app ('mcp' for Claude, D55). The
   * plugin's `/` source claims the bare command and opens the MCP panel instead; with arguments
   * the line still goes to the agent.
   */
  mcpCommand?: string;
  /**
   * D30 (M7): the agent command that opens its rewind menu in its terminal app ('rewind' for
   * Claude, a terminal-only command). The plugin's `/` source claims the bare command (and its
   * aliases) and opens the plugin's rewind dialog instead.
   */
  rewindCommand?: string;
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
      /**
       * D29 (r3): the input id (as `UserInput.id`, D5) of the first host turn the cut drops. The
       * backend uses it as a validated cut only when it can prove that exactly this one turn lies
       * past the cut; otherwise it truncates plainly.
       */
      dropsTurnHint?: string;
      newSessionId?: string;
      mainAgent?: string;
      /**
       * D30 (M7): also restore the files to their state before this input ran (the rewind
       * dialog's "restore code"). Done on the new process before its first turn; the outcome
       * comes as a `files-rewound` event. Needs `capabilities.fileRewind`.
       */
      restoreFilesAt?: string;
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
  /** R7.1: the agent's own `/` menu rows, as it reports them now (Claude: `supportedCommands()`). */
  commands?(): Promise<CommandInfo[]>;
  /** R7.5: the skills this session can use. Read-only; reloads nothing. */
  skills?(): Promise<SkillInfo[]>;
  /**
   * D54, R7.3: answer a side question with the conversation's full context, no tools, and
   * nothing written to any transcript (Claude: `askSideQuestion`, the engine behind `/btw`).
   * Works while a turn runs. `history`: earlier exchanges, oldest first (the caller keeps them,
   * see `SideQuestionHistory`). `null`: cancelled through `signal`.
   */
  askSideQuestion?(question: string, history: SideExchange[], signal: AbortSignal): Promise<SideAnswer | null>;
  /** D55, R7.4: the MCP servers and their state. */
  mcpStatus?(): Promise<McpServerInfo[]>;
  mcpReconnect?(name: string): Promise<void>;
  /**
   * D55: turn a server on or off. The agent saves the choice itself; `note` says where, in the
   * backend's words, and the UI shows it as given.
   */
  mcpToggle?(name: string, enabled: boolean): Promise<{ note?: string }>;
  /** D55: start a sign-in for a server that needs auth (**unverified** live on Claude). */
  mcpAuthenticate?(name: string): Promise<McpAuthStart>;
  /** D55: finish a sign-in with the provider's final redirect address, pasted by the user. */
  mcpSubmitAuthCallback?(name: string, callbackUrl: string): Promise<void>;
  contextUsage?(detail: 'summary' | 'full'): Promise<ContextUsage>;
  /**
   * D58, D60: the conversation's totals, the cost label, the auth type and the plan limits, read
   * from the live process (Claude: its usage control). Never starts a model call.
   */
  usageSnapshot?(): Promise<UsageSnapshot>;
  /** The end of a background shell or monitor task's output (Claude: `getTaskOutput`). */
  taskOutput?(taskId: string): Promise<TaskOutput>;
  /**
   * D30 (M7): put the files back as they were before an input ran (the terminal app's "Restore
   * code" in its rewind menu). `dryRun` only reports what would change. Never touches the
   * conversation. Only when `capabilities.fileRewind`.
   */
  rewindFiles?(inputId: string, opts?: { dryRun?: boolean }): Promise<FileRewindResult>;
  /** Send a message to a running teammate (D50). Absent when the agent has no such control. */
  messageTeammate?(ref: AgentRef, text: string): Promise<void>;
}

/** D30: what a file restore did (or, with `dryRun`, would do). */
export interface FileRewindResult {
  /** false: nothing was restored; `error` says why in the agent's words. */
  ok: boolean;
  error?: string;
  filesChanged: string[];
  insertions?: number;
  deletions?: number;
  /** Files left alone because a link or another non-regular file sat at the path. */
  skippedLinks?: number;
  dryRun?: boolean;
}

/**
 * M7 (R3.6): the main-thread record past one chain entry. `events` are `step-start`,
 * `step-message` and `tool-result` events of the main agent (`agent: {kind: 'main'}`), in order,
 * with the same guarantees as the live stream (a result follows the message that advertises its
 * call; a result whose call lies before the chain entry is left out and counted).
 */
export interface SessionTail {
  /**
   * 'found': the chain entry is in the record (`events` may be empty). 'no-record': the agent
   * has no record of this session. 'no-cut': the entry is not in it. 'too-large': not read.
   */
  status: 'found' | 'no-record' | 'no-cut' | 'too-large';
  events: BackendEvent[];
  /** Human prompts past the entry (the host log normally holds them already, as typed). */
  prompts: string[];
  /** Other inputs past the entry, in words (for example "a background task finished"). */
  notes: string[];
  /** Results whose call was before the entry (the host log closed those calls itself). */
  orphanResults: number;
  /** The last chain entry read. */
  lastChainId?: string;
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

/**
 * One row of the agent's own `/` menu (R7.1, D52). `name` is the agent's name, byte for byte, with
 * no leading slash: the menu inserts `/<name>` and the line goes to the agent as typed text.
 */
export interface CommandInfo {
  name: string;
  description?: string;
  argumentHint?: string;
  /** Other names that run the same command (Claude: `/cost` and `/stats` for `/usage`). */
  aliases?: string[];
  /**
   * What the row is, as far as the agent tells: its own command ('builtin'), a skill ('skill'), an
   * MCP server prompt ('mcp-prompt'), or another user, project or plugin command ('custom').
   */
  kind?: 'builtin' | 'skill' | 'mcp-prompt' | 'custom';
  /**
   * The agent says the command only makes sense in its terminal app (Claude:
   * `system/init.terminal_slash_commands`). The menu may hide or mark it.
   */
  terminalOnly?: boolean;
}

/** One skill the session can use (R7.5; Claude: the skills of `system/init` and `/context`). */
export interface SkillInfo {
  name: string;
  description?: string;
  argumentHint?: string;
  /** Where the skill comes from, in the agent's own words ('plugin', 'built-in', 'userSettings', …). */
  source?: string;
  /** The plugin that ships it, when it comes from one. */
  plugin?: string;
  /** Context tokens its listing costs, when the agent reports it. */
  tokens?: number;
}

/** D55: one MCP server as the agent reports it (Claude: `mcpServerStatus()`). */
export interface McpServerInfo {
  /** The agent's name for the server; pass it back to the MCP controls unchanged. Untrusted text. */
  name: string;
  /** Unknown words from a newer agent are kept as they are. */
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled' | (string & {});
  error?: string;
  /** Configuration scope ('user', 'project', 'local', 'claudeai', 'managed', …). */
  scope?: string;
  /** Where the definition came from ('plugin', 'user', 'sdk', …). Key trust on this, not on `name`. */
  source?: string;
  /** The server's own name and version, once connected. */
  serverName?: string;
  serverVersion?: string;
  /** 'stdio', 'http', 'sse', … Only the transport kind: never headers, env or arguments. */
  transport?: string;
  /** The server's tools, once connected. */
  tools?: Array<{ name: string; description?: string; readOnly?: boolean; destructive?: boolean }>;
}

/** D55: what starting an MCP sign-in returned. */
export interface McpAuthStart {
  /** Open this in a browser. Absent: nothing for the user to do (already signed in). */
  url?: string;
  needsUserAction: boolean;
  /**
   * The agent waits for the provider's redirect. When the browser cannot reach the agent's
   * machine, the user pastes the final address into `mcpSubmitAuthCallback`.
   */
  callbackExpected: boolean;
}

/** D54: one earlier side question and its answer, oldest first. */
export interface SideExchange {
  question: string;
  answer: string;
  /** The agent's note that another model answered (Claude: the refusal fallback's content). */
  fallbackNotice?: string;
}

/** D54: the agent's answer to a side question. */
export interface SideAnswer {
  text: string;
  /**
   * true: the agent made this text itself (no answer was possible). It is shown, but not kept
   * in the side-question history, as the terminal app does.
   */
  synthetic: boolean;
  /** Another model answered after the first one declined. */
  fallback?: { originalModel: string; fallbackModel: string; content: string };
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

/** D59: the agent's own context report (Claude: `getContextUsage`, the data behind `/context`). */
export interface ContextUsage {
  used: number;
  window: number;
  autoCompactAt?: number;
  /** false: the agent does not compact by itself. */
  autoCompactEnabled?: boolean;
  /** The agent's own percentage, when it reports one. */
  percent?: number;
  /** The agent's categories, in its order (classify on `id` and `kind`, never on `name`). */
  categories?: ContextCategory[];
  /** The model the report is for (display id, D61). */
  model?: string;
  /** R7.2: the per-item tables of the agent's `/context`, when it reports them. */
  details?: ContextDetails;
}

/** The item tables behind `/context` (Claude: MCP tools, memory files, agents, skills). */
export interface ContextDetails {
  mcpTools?: Array<{ name: string; server: string; tokens: number }>;
  memoryFiles?: Array<{ path: string; type: string; tokens: number }>;
  agents?: Array<{ name: string; source: string; tokens: number }>;
  skills?: Array<{ name: string; source: string; plugin?: string; tokens: number }>;
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
