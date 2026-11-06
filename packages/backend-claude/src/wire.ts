// Loose wire shapes of the SDK messages the mapper reads. Every field is optional and checked
// at run time (D9): the user's CLI auto-updates and drifts from the pinned SDK types, and some
// frames we use (`command_lifecycle`, `aborted`, `user_message_uuids` on frames) are not declared.

export interface WireUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
}

export type WireBlock =
  | { type: 'text'; text?: string }
  | { type: 'thinking'; thinking?: string; signature?: string }
  | { type: 'redacted_thinking'; data?: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: unknown }
  | { type: 'tool_result'; tool_use_id?: string; content?: unknown; is_error?: boolean }
  | { type: string; [k: string]: unknown };

export interface WireMessage {
  type?: string;
  subtype?: string;
  uuid?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  user_message_uuids?: string[];
  [k: string]: unknown;
}

export interface WireAssistant extends WireMessage {
  type: 'assistant';
  message?: { id?: string; model?: string; content?: WireBlock[]; usage?: WireUsage };
  error?: unknown;
  aborted?: boolean;
}

export interface WireUser extends WireMessage {
  type: 'user';
  message?: { role?: string; content?: string | WireBlock[] };
  isSynthetic?: boolean;
  isReplay?: boolean;
}

export interface WireStreamEvent extends WireMessage {
  type: 'stream_event';
  event?: {
    type?: string;
    index?: number;
    message?: { id?: string; model?: string; usage?: WireUsage };
    content_block?: WireBlock;
    delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
    usage?: WireUsage;
  };
}

export interface WireResult extends WireMessage {
  type: 'result';
  subtype?: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  num_turns?: number;
  terminal_reason?: string | null;
  queued_turn_count?: number;
  local_command?: string;
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
