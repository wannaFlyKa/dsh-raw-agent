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
  models?(): Promise<ModelInfo[]>;
  agents?(): Promise<AgentInfo[]>;
  commands?(): Promise<CommandInfo[]>;
  contextUsage?(detail: 'summary' | 'full'): Promise<ContextUsage>;
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
  label: string;
  destination?: string;
  acceptsFeedback?: boolean;
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
  options: PermissionOption[];
}

/** The backend turns a reject option into its own text (D40). The DSH layer never builds deny text. */
export interface PermissionAnswer {
  optionId: string;
  feedback?: string;
}

export interface QuestionRequest {
  id: string;
  agent: AgentRef;
  callId?: string;
  questions: Array<{
    question: string;
    header?: string;
    multiSelect: boolean;
    options: Array<{ label: string; description?: string; preview?: string }>;
  }>;
}

/** Keyed by question text, as the CLI expects. `null` means the user dismissed the card. */
export type QuestionAnswer = { answers: Record<string, string> } | null;

export interface PlanRequest {
  id: string;
  agent: AgentRef;
  callId?: string;
  plan: string;
  planFilePath?: string;
  choices: PlanChoiceInfo[];
}

export type PlanAnswer = { kind: 'approve'; choiceId: string } | { kind: 'keep-planning'; feedback?: string };

export interface ElicitationRequest {
  id: string;
  serverName: string;
  message: string;
  mode?: 'form' | 'url';
  url?: string;
  requestedSchema?: unknown;
}

export type ElicitationAnswer =
  { action: 'accept'; content?: Record<string, unknown> } | { action: 'decline' } | { action: 'cancel' };

// ---- plain data shapes ----

export interface PermissionModeInfo {
  id: string;
  label: string;
}

export interface EffortInfo {
  id: string;
  label: string;
}

export interface PlanChoiceInfo {
  id: string;
  label: string;
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
}

export interface AgentInfo {
  name: string;
  description?: string;
}

export interface CommandInfo {
  name: string;
  description?: string;
  argumentHint?: string;
}

export interface ContextUsage {
  used: number;
  window: number;
  autoCompactAt?: number;
  categories?: Array<{ name: string; tokens: number }>;
}
