// The backend-neutral event union (architecture §6, §7.2). No DSH or SDK imports.
//
// Phase 3 spike subset. Every member keeps its final §7.2 name and shape; the members that
// the spike does not emit yet are listed at the end as a comment and are added in place later.

import type { AgentRef } from './backend.js';

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

export type BackendEvent =
  | { type: 'session-info'; model?: string; mode?: string; version?: string }
  | { type: 'turn-start'; origin: 'user' | 'self' }
  | { type: 'step-start'; agent: AgentRef; stepId: string; at: number; synthetic?: boolean }
  | {
      type: 'delta';
      agent: AgentRef;
      stepId: string;
      kind: 'text' | 'reasoning' | 'tool-input';
      blockIndex: number;
      text: string;
      at: number;
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
      localCommand?: { name: string; structured?: unknown };
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
  | { type: 'mode'; mode: string }
  /** An interaction finished on the agent's side (D43: a URL elicitation completed). */
  | { type: 'interaction-done'; id: string }
  /** The agent withdrew an interaction (its abort signal also fires). */
  | { type: 'interaction-cancel'; id: string }
  | { type: 'exit'; error?: string };

// Not in the spike yet (added in place later, §7.2): workflow-start,
// workflow-snapshot, workflow-end, title,
// usage, context, compaction, limits, retry, commands.

export type BackendEventType = BackendEvent['type'];
export type BackendEventOf<T extends BackendEventType> = Extract<BackendEvent, { type: T }>;
