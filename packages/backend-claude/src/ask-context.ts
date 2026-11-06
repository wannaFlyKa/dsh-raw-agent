// What the interaction adapter needs to know about the live session but the SDK callbacks do not
// carry (D44, D77, D43): the label of a subagent by its id, which agent has an open call to an MCP
// server (an elicitation names only the server), and which ask a URL elicitation completion closes.
// It reads the same wire messages the mapper reads; it never changes or sends anything.

import type { AgentRef, BackendEvent } from '@dsh-raw-agent/core';
import { isObject, str } from './wire.js';

type Loose = Record<string, unknown>;

/** The CLI's MCP tool name: `mcp__<server>__<tool>`. Server names are normalized by the CLI. */
export function mcpServerOfTool(toolName: string): string | undefined {
  if (!toolName.startsWith('mcp__')) return undefined;
  const rest = toolName.slice(5);
  const i = rest.indexOf('__');
  return i > 0 ? rest.slice(0, i) : undefined;
}

/** Compare a configured server name with the tool-name form (the CLI replaces odd characters). */
export function normalizeServerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * How many open MCP calls, URL elicitations and subagent labels are kept. A call whose
 * `tool_result` never comes (a crashed agent) or an elicitation that never completes would
 * otherwise stay for the whole process; the oldest entry goes first. Far above what one session
 * has open at once.
 */
export const ASK_CONTEXT_LIMIT = 256;

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, limit = ASK_CONTEXT_LIMIT): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

function sameAgent(a: AgentRef, b: AgentRef): boolean {
  return a.kind === b.kind && (a.kind === 'main' || (b.kind === 'child' && a.id === b.id));
}

export class AskContext {
  readonly #labels = new Map<string, string>();
  /** Open MCP tool calls: tool_use id → server (normalized) and asking agent. */
  readonly #mcpCalls = new Map<string, { server: string; agent: AgentRef }>();
  /** URL elicitation id → our interaction id (D43). */
  readonly #elicitations = new Map<string, string>();
  #mode: string | undefined;
  #prePlanMode: string | undefined;
  #startMode: string | undefined;

  /** The CLI's current permission mode (init, then every `status` frame). */
  get mode(): string | undefined {
    return this.#mode;
  }

  /** The mode before plan mode began; the CLI restores it on a plain plan approval (D42). */
  get prePlanMode(): string | undefined {
    return this.#prePlanMode;
  }

  /** The mode this process started in (the CLI allows bypass when it started in it, D14). */
  get startMode(): string | undefined {
    return this.#startMode;
  }

  agentLabel(agentId: string): string | undefined {
    return this.#labels.get(agentId);
  }

  /**
   * The agent whose open MCP call is the only one to this server, or undefined when none or
   * several agents have one (**inferred**: the CLI's elicitation callback names no agent).
   */
  elicitationAgent(serverName: string): AgentRef | undefined {
    const server = normalizeServerName(serverName);
    let found: AgentRef | undefined;
    for (const c of this.#mcpCalls.values()) {
      if (c.server !== server) continue;
      if (found && !sameAgent(found, c.agent)) return undefined;
      found = c.agent;
    }
    return found;
  }

  rememberElicitation(elicitationId: string, interactionId: string): void {
    setBounded(this.#elicitations, elicitationId, interactionId);
  }

  forgetElicitation(elicitationId: string): void {
    this.#elicitations.delete(elicitationId);
  }

  /**
   * The process start mode, known before the CLI reports one (a mode set right after the spawn
   * comes before the first `init`). Ignored once the CLI has reported a mode.
   */
  seedStartMode(mode: string | undefined): void {
    if (mode === undefined || this.#mode !== undefined || this.#startMode !== undefined) return;
    this.#startMode = mode;
    this.#mode = mode;
  }

  /** Read one wire message. Returns the events it closes (D43 `interaction-done`). */
  observe(raw: unknown): BackendEvent[] {
    if (!isObject(raw)) return [];
    const msg = raw as Loose;
    const out: BackendEvent[] = [];
    if (msg.type === 'system') this.#system(msg, out);
    else if (msg.type === 'assistant') this.#assistant(msg);
    else if (msg.type === 'user') this.#user(msg);
    return out;
  }

  #setMode(mode: string): void {
    if (mode === 'plan' && this.#mode !== 'plan') this.#prePlanMode = this.#mode;
    this.#mode = mode;
  }

  #system(msg: Loose, out: BackendEvent[]): void {
    const mode = str(msg.permissionMode);
    if (msg.subtype === 'init') {
      // The CLI sends `init` again at the start of every turn, with the current mode (live
      // probe M2 `probe-init.txt`). Only the first one is the start mode; a later one must not
      // forget the pre-plan mode (a plan begun in auto offers "use auto mode", D42).
      if (mode !== undefined) {
        if (this.#startMode === undefined) {
          this.#startMode = mode;
          this.#mode = undefined;
        }
        this.#setMode(mode);
      }
      return;
    }
    if (msg.subtype === 'status') {
      if (mode !== undefined) this.#setMode(mode);
      return;
    }
    if (msg.subtype === 'elicitation_complete') {
      const eid = str(msg.elicitation_id);
      const id = eid === undefined ? undefined : this.#elicitations.get(eid);
      if (eid !== undefined && id !== undefined) {
        this.#elicitations.delete(eid);
        out.push({ type: 'interaction-done', id });
      }
    }
  }

  #assistant(msg: Loose): void {
    const agentId = str(msg.agent_id);
    const agent: AgentRef = msg.parent_tool_use_id && agentId ? { kind: 'child', id: agentId } : { kind: 'main' };
    if (agentId !== undefined && !this.#labels.has(agentId)) {
      const type = str(msg.subagent_type);
      const task = str(msg.task_description);
      const label = type && task ? `${type}: ${task}` : (type ?? task);
      if (label !== undefined) setBounded(this.#labels, agentId, label, ASK_CONTEXT_LIMIT * 4);
    }
    const message = isObject(msg.message) ? (msg.message as Loose) : undefined;
    const content = Array.isArray(message?.content) ? (message.content as unknown[]) : [];
    for (const b of content) {
      if (!isObject(b) || b.type !== 'tool_use') continue;
      const id = str(b.id);
      const server = mcpServerOfTool(str(b.name) ?? '');
      if (id !== undefined && server !== undefined) setBounded(this.#mcpCalls, id, { server, agent });
    }
  }

  #user(msg: Loose): void {
    const message = isObject(msg.message) ? (msg.message as Loose) : undefined;
    const content = Array.isArray(message?.content) ? (message.content as unknown[]) : [];
    for (const b of content) {
      if (!isObject(b) || b.type !== 'tool_result') continue;
      const id = str(b.tool_use_id);
      if (id !== undefined) this.#mcpCalls.delete(id);
    }
  }
}
