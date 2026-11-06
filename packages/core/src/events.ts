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
  | { type: 'conversation-reset'; newSessionId: string; trigger?: string }
  | {
      type: 'turn-end';
      agent: AgentRef;
      outcome: 'completed' | 'interrupted' | 'error' | 'deferred';
      reason?: string;
      error?: string;
      pendingInputs: number;
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
  | { type: 'exit'; error?: string };

// Not in the spike yet (added in place later, §7.2): agent-start, agent-end, workflow-start,
// workflow-snapshot, workflow-end, team-message, interaction-done, interaction-cancel, title,
// usage, context, compaction, limits, retry, commands.

export type BackendEventType = BackendEvent['type'];
export type BackendEventOf<T extends BackendEventType> = Extract<BackendEvent, { type: T }>;
