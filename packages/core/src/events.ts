// The backend-neutral event union (architecture §6, §7.2). No DSH or SDK imports.
//
// Phase 3 spike subset. Every member keeps its final §7.2 name and shape; the members that
// the spike does not emit yet are listed at the end as a comment and are added in place later.

import type { AgentRef, CommandInfo, ContextUsage, FileRewindResult, McpServerInfo } from './backend.js';
import type { AuthInfo, CostLabel, PlanLimits, TurnUsage, UsageTotals } from './usage.js';

/** A content block as the DSH writer stores it. `arguments` is the exact JSON string (D21). */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; signature?: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string };

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
}

export type ToolResultContent =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; base64: string }
  | { type: 'other'; value: unknown };

export type TaskKind = 'shell' | 'monitor' | 'agent' | 'workflow';
export type TaskStatus = 'completed' | 'failed' | 'stopped';
/** What kind of child agent a child session holds (D45, D50). */
export type AgentRole = 'subagent' | 'teammate' | 'workflow-agent';

/** A workflow phase (D48). `index` is the agent's own 1-based phase number. */
export interface WorkflowPhase {
  index: number;
  title: string;
}

/**
 * A workflow agent's state (D48). 'queued': declared, not started; 'running'; 'done'; 'error'
 * (failed, or ended because the run was stopped); 'stopped': still open when the run ended.
 */
export type WorkflowAgentState = 'queued' | 'running' | 'done' | 'error' | 'stopped';

/** One agent row of a workflow snapshot (D48). Every field but `index`, `label`, `state` is optional. */
export interface WorkflowAgent {
  /** The agent's own stable number in the run (one per agent call). The merge key. */
  index: number;
  label: string;
  state: WorkflowAgentState;
  /** The agent's own state word, when it differs from `state` or is unknown. */
  rawState?: string;
  phaseIndex?: number;
  phaseTitle?: string;
  /** The child agent id (the child session's ref id), once the agent started. */
  agentId?: string;
  /** Retry number; a higher attempt replaces a settled row (D48). */
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
  /** The agent's result came from a cache of an earlier run. */
  cached?: boolean;
  /** The agent was refused before it started. */
  blocked?: boolean;
}

export interface TaskUsage {
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
}

export type BackendEvent =
  | { type: 'session-info'; model?: string; mode?: string; version?: string }
  | { type: 'turn-start'; origin: 'user' | 'self' }
  /**
   * R8.4 (M5): the agent sent a main-thread model request (Claude: `system/status requesting`).
   * The DSH layer opens the step here, so the step starts at the request and DSH's
   * time-to-first-token is the real one. The `step-start` of the response then joins that step.
   * `at`: when the frame arrived.
   */
  | { type: 'request-start'; agent: AgentRef; at: number }
  | { type: 'step-start'; agent: AgentRef; stepId: string; at: number; synthetic?: boolean }
  | {
      type: 'delta';
      agent: AgentRef;
      stepId: string;
      kind: 'text' | 'reasoning' | 'tool-input';
      blockIndex: number;
      text: string;
      at: number;
      /** 'tool-input' only (R8.4): the call's id and tool name, so DSH sees when the call began. */
      toolCallId?: string;
      toolName?: string;
    }
  | {
      type: 'step-message';
      agent: AgentRef;
      stepId: string;
      blocks: ContentBlock[];
      usage?: Usage;
      model?: string;
      lastChainId?: string;
      /** false: more messages of this step follow (children, D68). */
      final: boolean;
      synthetic?: boolean;
      error?: string;
      /** R7.2, D53, D69: this message is a local command's output (no model call, no usage). */
      localCommand?: LocalCommandInfo;
      interrupted?: boolean;
    }
  | {
      type: 'tool-result';
      agent: AgentRef;
      callId: string;
      isError: boolean;
      chainId?: string;
      meta?: Record<string, unknown>;
      content: ToolResultContent[];
    }
  | { type: 'superseded'; chainIds: string[] }
  | { type: 'input-consumed'; inputId: string }
  /** A message the CLI shows the user outside the conversation (CLI `system/informational`). */
  | { type: 'notice'; level: string; text: string }
  /** The agent dropped a pending input (D25: interrupt with cancelQueued); it never ran. */
  | { type: 'input-cancelled'; inputId: string }
  | { type: 'conversation-reset'; newSessionId: string; trigger?: string }
  | {
      type: 'turn-end';
      agent: AgentRef;
      outcome: 'completed' | 'interrupted' | 'error' | 'deferred';
      reason?: string;
      error?: string;
      pendingInputs: number;
    }
  /**
   * A child agent starts (D45), or a finished one runs again (`resumed`: a teammate woken by a
   * message, D50). Comes before any event of that child and before its `task-start`. `parent`
   * is the agent whose tool call started it (nesting follows the CLI's spawn depth).
   */
  | {
      type: 'agent-start';
      ref: AgentRef;
      parent: AgentRef;
      /** The parent's tool call that started the child (Claude: the `Agent` call). */
      parentCallId?: string;
      label: string;
      role: AgentRole;
      background: boolean;
      taskId?: string;
      /** The text the child starts on: the parent's prompt, or the message that woke it. */
      taskPrompt: string;
      /** The agent type the parent asked for (Claude: `subagent_type`). */
      agentType?: string;
      /** An addressable name (Claude: the `Agent` call's `name`; a teammate's name). */
      name?: string;
      /** The team, for a teammate (Claude: `team_name`). */
      team?: string;
      /** 1 for a child of the main agent, 2 for its child, and so on. */
      depth?: number;
      /** true: this child ran before in this process and was woken again. */
      resumed?: boolean;
      /** For a resumed teammate: who sent the message that woke it. */
      wokenBy?: string;
      at: number;
    }
  /** A child agent finished or was stopped (D45, D46). Its open step, if any, closes. */
  | { type: 'agent-end'; ref: AgentRef; status: TaskStatus; summary?: string }
  /**
   * Text the agent itself delivered to a running child that is not a tool result: a message
   * from another agent at its next tool round, or the agent's own reminder. Never human text.
   */
  | { type: 'agent-input'; ref: AgentRef; text: string; at: number }
  /**
   * One agent sent a message to another (D50; Claude: a `SendMessage` call). Comes after the
   * `step-message` that holds the call. `from` is the sender's name ('main' for the main agent).
   */
  | {
      type: 'team-message';
      from: string;
      to: string;
      text: string;
      agent: AgentRef;
      callId?: string;
      summary?: string;
    }
  | { type: 'task-start'; taskId: string; kind: TaskKind; label: string; agent?: AgentRef }
  | {
      type: 'task-progress';
      taskId: string;
      summary?: string;
      usage?: { tokens?: number; toolUses?: number; durationMs?: number };
    }
  | { type: 'task-end'; taskId: string; status: TaskStatus; summary?: string }
  | { type: 'tasks-snapshot'; taskIds: string[] }
  /**
   * A dynamic workflow run started (D48). Comes after the run's `task-start` and after the
   * `tool-result` of the call that launched it. `taskId` is the run's task (stop it with
   * `stopTask(taskId)`); `runId` is the agent's own run id. Paths are the agent's own files.
   */
  | {
      type: 'workflow-start';
      taskId: string;
      name: string;
      label?: string;
      runId?: string;
      /** The main-thread tool call that launched the run. */
      callId?: string;
      transcriptDir?: string;
      scriptPath?: string;
      at: number;
    }
  /**
   * The run's full state (D48): the merged snapshot (replace the previous one). Only sent when
   * something changed. Agent rows link to child agents by `agentId` (their `agent-start` comes
   * right after the first snapshot that names them).
   */
  | {
      type: 'workflow-snapshot';
      taskId: string;
      phases: WorkflowPhase[];
      agents: WorkflowAgent[];
      usage?: TaskUsage;
      at: number;
    }
  /** The run ended (D48). Its agents' `agent-end` and a final snapshot come first; its `task-end` follows. */
  | {
      type: 'workflow-end';
      taskId: string;
      stopReason: 'completed' | 'cancelled' | 'error';
      summary?: string;
      usage?: TaskUsage;
    }
  | { type: 'mode'; mode: string }
  /** An interaction finished on the agent's side (D43: a URL elicitation completed). */
  | { type: 'interaction-done'; id: string }
  /** The agent withdrew an interaction (its abort signal also fires). */
  | { type: 'interaction-cancel'; id: string }
  /**
   * D58: the conversation's running totals, after a turn (`turn` set) or when they change
   * between turns (a background agent's calls, a baseline read, a reset to zero after D70).
   * Never sent for a synthetic or local-command step that counted nothing.
   */
  | { type: 'usage'; cumulative: UsageTotals; turn?: TurnUsage; costLabel: CostLabel }
  /**
   * D59: the context the main thread sent on its last model call (`used`), against the model's
   * window. Sent after each main-thread call with usage, after a compaction and after a reset.
   */
  | { type: 'context'; used: number; window: number; autoCompactAt?: number }
  /** D59: the agent compacts its conversation (start), or finished or failed doing so (end). */
  | {
      type: 'compaction';
      phase: 'start' | 'end';
      trigger?: 'manual' | 'auto';
      preTokens?: number;
      postTokens?: number;
      error?: string;
    }
  /** D60: plan limits changed (a live rate-limit report, or a read of the usage control). */
  | { type: 'limits'; limits: PlanLimits }
  /** D60: a model call failed and the agent retries it (throttling shows here, for every account). */
  | {
      type: 'retry';
      attempt: number;
      maxRetries?: number;
      delayMs?: number;
      /** The agent's error kind ('rate_limit', 'overloaded', …). */
      error: string;
      httpStatus?: number;
    }
  /** R8.3: how this session is billed (read from the live process, never from an extra one). */
  | { type: 'auth'; auth: AuthInfo; costLabel: CostLabel }
  /**
   * R7.1, D52: the agent's `/` menu changed (Claude: `system/init` names, then the full rows of
   * `commands_changed`). Replace the cached list. Rows from `init` carry names only; read
   * `controls.commands()` for descriptions.
   */
  | { type: 'commands'; list: CommandInfo[]; namesOnly?: boolean }
  /**
   * D55: the MCP servers as the agent reported them on its own (Claude: `system/init.mcp_servers`,
   * always 'pending' at start). Read `controls.mcpStatus()` for the live state.
   */
  | { type: 'mcp-status'; servers: McpServerInfo[] }
  /**
   * D30 (M7): the outcome of a fork's `restoreFilesAt` (files put back before the first turn).
   */
  | { type: 'files-rewound'; inputId: string; result: FileRewindResult }
  /**
   * The process ended (R3.6). `reason`: 'disposed' and 'force-stopped' were asked for; 'ended'
   * means the agent stopped by itself with success; 'crashed' means it failed or was killed.
   * `error` is a short plain reason for the user; it may go into the host log, so it never holds
   * the agent's error output (M8). Absent for an asked-for end.
   */
  | {
      type: 'exit';
      error?: string;
      reason?: ExitReason;
      /** The process exit code, when it exited. */
      code?: number;
      /** The signal that ended it, when one did (POSIX names). */
      signal?: string;
      /**
       * The end of the agent's error output (ANSI stripped, a few lines). For the plugin UI only:
       * the host never writes it to its log (M8).
       */
      stderr?: string;
    };

export type ExitReason = 'disposed' | 'force-stopped' | 'ended' | 'crashed';

/** R7.2: what a local command step is. */
export interface LocalCommandInfo {
  /** The command's name without the slash ('context', 'usage', 'compact', …). Absent: unknown. */
  name?: string;
  /** What the user typed after the name. */
  args?: string;
  /**
   * The agent says the command does not run here (Claude: 'unavailable_headless', a TUI-only
   * command such as `/help` or `/btw` typed into the composer). The text says so in its words.
   */
  unavailable?: boolean;
  /** Structured twin of the text, when the agent sends one. */
  structured?: LocalCommandStructured;
}

/** The structured output of a local command, where the agent gives structure (R7.2). */
export type LocalCommandStructured = { kind: 'context'; context: ContextUsage };

// Not in the spike yet (added in place later, §7.2): title.

export type BackendEventType = BackendEvent['type'];
export type BackendEventOf<T extends BackendEventType> = Extract<BackendEvent, { type: T }>;
