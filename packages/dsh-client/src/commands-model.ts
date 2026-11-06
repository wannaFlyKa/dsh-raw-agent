// Pure view logic for M6 (R7.1-R7.4): side questions (D54), the MCP list (D55), the agent's
// command list (D52) and local command outputs in the chat (D53, D69, D70). No React, no DSH, no
// backend names: labels come from the Host (`displayName`).

import type {
  CommandRowWire,
  CommandsAnswerWire,
  McpServerWire,
  SessionViewWire,
  SideEntryWire,
  SideViewWire,
} from './api.js';

// ---- side questions (D54) ------------------------------------------------------------------------

/** The newest side question, if any. */
export function latestSide(side: SideViewWire | undefined): SideEntryWire | undefined {
  const list = side?.entries ?? [];
  return list.length > 0 ? list[list.length - 1] : undefined;
}

/** A question is still open (the panel offers Cancel). */
export const sideOpen = (e: SideEntryWire): boolean => e.status === 'asking' || e.status === 'waiting';

/** The status line of one side question. */
export function sideStatusText(e: SideEntryWire, displayName: string, now = Date.now()): string | undefined {
  switch (e.status) {
    case 'waiting':
      return `Waiting for ${displayName} to start. Start it to get the answer.`;
    case 'asking': {
      const s = Math.max(0, Math.round((now - e.at) / 1000));
      return `Thinking… ${s}s`;
    }
    case 'failed':
      return e.error ? `No answer: ${e.error}` : 'No answer.';
    case 'cancelled':
      return 'Cancelled.';
    default:
      return e.synthetic ? `${displayName} gave no answer to this question.` : undefined;
  }
}

/**
 * Whether the panel should open by itself: a side question the user has not dismissed yet. The
 * panel opens for a new question (typed `/btw …` or asked in the panel) and stays open until the
 * user closes it; closing it hides that question until the next one.
 */
export function sideShouldOpen(side: SideViewWire | undefined, dismissedId: string | undefined): boolean {
  const last = latestSide(side);
  return last !== undefined && last.id !== dismissedId;
}

/** The note every side panel shows (R7.3: the question is never part of the conversation). */
export function sideNote(displayName: string, historySize: number): string {
  const ctx = historySize > 0 ? ` and the last ${historySize} side ${historySize === 1 ? 'answer' : 'answers'}` : '';
  return `${displayName} answers from the conversation so far${ctx}, without tools. Nothing here is added to the conversation.`;
}

// ---- MCP servers (D55) ---------------------------------------------------------------------------

export type McpLevel = 'ok' | 'pending' | 'warn' | 'error' | 'off';

const MCP_LABEL: Record<string, string> = {
  connected: 'connected',
  pending: 'connecting',
  failed: 'failed',
  'needs-auth': 'needs sign-in',
  disabled: 'disabled',
};

export function mcpStatusLabel(status: string): string {
  return MCP_LABEL[status] ?? status;
}

export function mcpLevel(status: string): McpLevel {
  if (status === 'connected') return 'ok';
  if (status === 'pending') return 'pending';
  if (status === 'needs-auth') return 'warn';
  if (status === 'disabled') return 'off';
  return status === 'failed' ? 'error' : 'pending';
}

/** What a server row offers. Toggling and reconnecting are the agent's own controls. */
export function mcpActions(
  s: McpServerWire,
  running: boolean,
): { reconnect: boolean; toggle: 'enable' | 'disable'; signIn: boolean } {
  const off = s.status === 'disabled';
  return {
    reconnect: running && !off,
    toggle: off ? 'enable' : 'disable',
    signIn: running && s.status === 'needs-auth',
  };
}

/** The controls button label: server count, and a mark when one needs the user. */
export function mcpButtonLabel(mcp: SessionViewWire['mcp']): string {
  const list = mcp ?? [];
  if (list.length === 0) return 'MCP';
  const bad = list.filter((m) => m.status === 'failed' || m.status === 'needs-auth').length;
  const ok = list.filter((m) => m.status === 'connected').length;
  return bad > 0 ? `MCP ${ok}/${list.length} ⚠` : `MCP ${ok}/${list.length}`;
}

/** One line under a server: scope, transport, source and version, in the agent's words. */
export function mcpDetail(s: McpServerWire): string {
  const parts: string[] = [];
  if (s.scope) parts.push(s.scope);
  if (s.transport) parts.push(s.transport);
  if (s.source && s.source !== s.scope) parts.push(`from ${s.source}`);
  if (s.serverName && s.serverName !== s.name) parts.push(s.serverName);
  if (s.serverVersion) parts.push(`v${s.serverVersion}`);
  if (s.tools && s.tools.length > 0) parts.push(`${s.tools.length} ${s.tools.length === 1 ? 'tool' : 'tools'}`);
  return parts.join(' · ');
}

/** Only an http(s) sign-in address is linked. */
export function signInUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

// ---- the agent's commands (R7.1, D52) ------------------------------------------------------------

/** How a command row reads in the commands list: the line to type and where it shows in `/`. */
export function commandRowText(r: CommandRowWire, displayName: string): { line: string; where: string } {
  const line = `/${r.name}${r.argumentHint ? ` ${r.argumentHint}` : ''}`;
  const where =
    r.menu === 'listed'
      ? 'in the / menu'
      : r.menu === 'taken'
        ? `in the / menu, ${r.note ?? 'taken by DSH in this session'}: typed, DSH's command runs`
        : r.menu === 'terminal-only'
          ? `in the / menu; ${displayName} runs this only in its terminal app`
          : r.menu === 'mcp-panel'
            ? 'in the / menu; on its own it opens this MCP panel, with words it goes to the agent'
            : 'opens the side panel; never sent to the conversation';
  return { line, where };
}

const KIND_LABEL: Record<string, string> = {
  builtin: 'built-in',
  skill: 'skill',
  'mcp-prompt': 'MCP prompt',
  custom: 'custom',
};

export function commandKindLabel(kind: CommandRowWire['kind']): string | undefined {
  return kind ? KIND_LABEL[kind] : undefined;
}

/** Filter rows by a typed text (name, description, kind). */
export function filterCommands(rows: readonly CommandRowWire[], query: string): CommandRowWire[] {
  const q = query.trim().toLowerCase().replace(/^\//, '');
  if (q === '') return [...rows];
  return rows.filter(
    (r) =>
      r.name.toLowerCase().includes(q) ||
      (r.description ?? '').toLowerCase().includes(q) ||
      (r.aliases ?? []).some((a) => a.toLowerCase().includes(q)),
  );
}

/** One candidate of our `/` source (the DSH input-trigger candidate shape, without DSH types). */
export interface CommandCandidate {
  name: string;
  label?: string;
  description?: string;
  hint?: string;
  /** What a pick does: 'start' starts the agent, 'taken' is shown only, 'side' claims the line. */
  value?: CandidateAction;
}

export type CandidateAction = 'start' | 'taken' | 'side' | 'mcp' | 'line';

/** The name of the stand-in row before the agent listed its commands. */
export function startCandidateName(displayName: string): string {
  return (
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'agent'
  );
}

const matches = (q: string, name: string, aliases?: readonly string[]) =>
  q === '' || name.toLowerCase().includes(q) || (aliases ?? []).some((a) => a.toLowerCase().includes(q));

/**
 * How well a typed query fits a row: 0 exact name, 1 exact alias, 2 name prefix, 3 alias prefix,
 * 4 anywhere. DSH keeps a source's order and Enter picks the first row, so `/compact` must not pick
 * `autocompact`, which the CLI lists first (M6 live).
 */
const matchRank = (q: string, name: string, aliases?: readonly string[]): number => {
  const n = name.toLowerCase();
  const al = (aliases ?? []).map((a) => a.toLowerCase());
  if (n === q) return 0;
  if (al.includes(q)) return 1;
  if (n.startsWith(q)) return 2;
  if (al.some((a) => a.startsWith(q))) return 3;
  return 4;
};

/**
 * R7.1, D52 r5: our `/` source offers every agent command, names byte for byte (the CLI needs the
 * ` (MCP)` suffix), with the agent's description and argument hint, matched by name or alias.
 * None is a DSH host command, so DSH writes no `command/run` record for them. Rows DSH already
 * uses (`taken`) and terminal-only rows show with a note, so the menu matches the agent's list.
 * Before the agent listed its commands, one row offers to start it.
 */
export function sourceCandidates(answer: CommandsAnswerWire | undefined, query: string): CommandCandidate[] {
  if (!answer) return [];
  const q = query.trim().toLowerCase();
  const name = answer.displayName ?? 'the agent';
  const out: CommandCandidate[] = [];
  const side = answer.sideQuestionCommand;
  // A prefix match only, so a typed `/t` + Enter does not pick the side row over an agent row.
  if (side !== undefined && side.toLowerCase().startsWith(q))
    out.push({
      name: side,
      description: `Ask ${name} a side question: full context, no tools, not added to the conversation`,
      hint: '<question>',
      value: 'side',
    });
  if (answer.rows.length === 0 && !answer.running) {
    const start = startCandidateName(name);
    if (matches(q, start) || matches(q, 'start'))
      out.push({
        name: start,
        label: `Start ${name}`,
        description: `${name} commands — Start ${name} to list them`,
        value: 'start',
      });
    return out;
  }
  // An empty query keeps the agent's own order; a typed one puts the best fits first (stable sort).
  const rows = answer.rows.filter((r) => r.menu !== 'side-question' && matches(q, r.name, r.aliases));
  if (q !== '') rows.sort((a, b) => matchRank(q, a.name, a.aliases) - matchRank(q, b.name, b.aliases));
  for (const r of rows) {
    const kind = commandKindLabel(r.kind);
    const notes: string[] = [];
    if (r.menu === 'taken') notes.push(r.note ?? 'taken by DSH in this session');
    if (r.menu === 'terminal-only') notes.push(`runs only in ${name}'s terminal app`);
    if (r.menu === 'mcp-panel') notes.push('on its own it opens the MCP panel');
    if (r.aliases && r.aliases.length > 0) notes.push(`also ${r.aliases.map((a) => `/${a}`).join(', ')}`);
    const c: CommandCandidate = { name: r.name };
    const d = [r.description, kind, ...notes].filter(Boolean).join(' · ');
    if (d) c.description = d;
    if (r.argumentHint) c.hint = r.argumentHint;
    c.value = r.menu === 'taken' ? 'taken' : r.menu === 'mcp-panel' ? 'mcp' : 'line';
    out.push(c);
  }
  return out;
}

/** D52: a pick only puts the exact line in the composer; Enter then sends it as typed text. */
export function sourcePickText(name: string): string {
  return `/${name} `;
}

/** The leading command token of a composer line (`/btw`), and the text after it. */
export function leadingCommand(line: string): { name: string; rest: string } | undefined {
  const t = line.trim();
  if (!t.startsWith('/')) return undefined;
  const ws = t.search(/\s/);
  const name = (ws === -1 ? t : t.slice(0, ws)).slice(1);
  if (name === '') return undefined;
  return { name, rest: ws === -1 ? '' : t.slice(ws).trim() };
}

// ---- local command outputs in the chat (D53, D69, D70) ------------------------------------------

/** What the binding of a local command's `assistant/message` says (host `localCommand`). */
export interface LocalCommandData {
  /** The host event's seq (the node's anchor). */
  seq: number;
  name?: string;
  args?: string;
  unavailable?: boolean;
  /** 'context' when the Host kept a structured twin. */
  structured?: string;
  outputId?: string;
  /** The command's text, as the agent wrote it (the native message's text blocks, rule 8). */
  text?: string;
}

/** The text blocks of a native `assistant/message` (structural). */
export function messageText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => ((b as { type?: unknown })?.type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
    .filter((t) => t !== '')
    .join('\n\n');
}

const MARKDOWN_LINE = /^ {0,3}(?:#|\||[-*+] |\d+\. |>|```)/u;

/**
 * R7.2, D69 r5: how our chat node draws a local command's text. The CLI's plain columns
 * (`/usage`, `/cost`: "Total cost: $0.14 … ($0.14)") are drawn monospaced as written; its
 * Markdown (`/context`) goes through our Markdown, which has no `$…$` math. The log keeps the
 * text unchanged; only the drawing differs.
 */
export function localTextFormat(text: string): 'markdown' | 'plain' {
  const lines = text.split('\n');
  if (text.includes('**') || lines.some((l) => MARKDOWN_LINE.test(l))) return 'markdown';
  return lines.length > 1 ? 'plain' : 'markdown';
}

/** Read the binding's `localCommand` from a message's `source` field (structural). */
export function localCommandOf(source: unknown, seq: number): LocalCommandData | undefined {
  const raw = (source as { rawAgent?: { localCommand?: unknown } } | undefined)?.rawAgent?.localCommand;
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const out: LocalCommandData = { seq };
  if (typeof r.name === 'string' && r.name !== '') out.name = r.name;
  if (typeof r.args === 'string' && r.args !== '') out.args = r.args;
  if (r.unavailable === true) out.unavailable = true;
  if (typeof r.structured === 'string') out.structured = r.structured;
  if (typeof r.outputId === 'string' && r.outputId !== '') out.outputId = r.outputId;
  return out;
}

/** The commands whose output the chat draws in its own way. */
export type LocalRender = 'cleared' | 'compacted' | 'context' | 'usage' | 'none';

const CLEAR = new Set(['clear', 'reset', 'new']);
const USAGE = new Set(['usage', 'cost', 'stats']);

export function localRender(d: LocalCommandData): LocalRender {
  if (d.unavailable || !d.name) return 'none';
  if (CLEAR.has(d.name)) return 'cleared';
  if (d.name === 'compact') return 'compacted';
  if (d.name === 'context') return 'context';
  if (USAGE.has(d.name)) return 'usage';
  return 'none';
}

/** D70: the divider text after `/clear`. */
export function clearedText(displayName: string): string {
  return `Conversation cleared — ${displayName} starts fresh here`;
}

/** Leftover M5: the marker after `/compact`, with the sizes when the usage panel knows them. */
export function compactedText(c?: { preTokens?: number; postTokens?: number }, fmt?: (n: number) => string): string {
  const f = fmt ?? ((n: number) => String(n));
  if (c?.preTokens !== undefined && c.postTokens !== undefined)
    return `Conversation compacted (${f(c.preTokens)} → ${f(c.postTokens)} tokens)`;
  return 'Conversation compacted';
}
