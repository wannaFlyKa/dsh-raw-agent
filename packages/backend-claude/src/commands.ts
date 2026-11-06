// Commands, skills, local command output, MCP status and side questions (R7.1-R7.5; D52-D56).
//
// Sources (CLI 2.1.318, SDK 0.3.318):
// - `supportedCommands()` rows: `{name, description, argumentHint, aliases?, builtin?}`
//   (`SDK/sdk.d.ts:9876-9898`); the CLI pushes the full list again as `system/commands_changed`
//   (`SDK/sdk.d.ts:3875-3882`), and `supportedCommands()` returns the latest push (`SDK/sdk.mjs`).
// - `system/init`: `slash_commands`, `skills` and `terminal_slash_commands` are name lists
//   (`SDK/sdk.d.ts:6335-6341`; probe5 `L.messages.jsonl`). MCP prompts are rows named
//   `<server>:<prompt> (MCP)` with no `builtin` (probe5).
// - Local commands (`/context`, `/usage`, `/cost`, `/mcp`, …) answer with a synthetic assistant
//   message that carries `local_command_run {command, args}` (or `local_command_outcome {kind:
//   'unavailable_headless'}` for a terminal-only command), and for `/context` a structured
//   `context_usage` twin (probe5; Phase 1 `raw-baseline/sdk-commands.jsonl`). The declared
//   `system/local_command_output {content}` was never seen on 2.1.318; it is handled anyway (D9).
// - `askSideQuestion(question, {history, signal})` → `{response, synthetic, refusalFallback?}` or
//   `null` (undeclared, `SDK/sdk.mjs`). History items `{question, response, fallback_notice?}`;
//   the TUI keeps the last 20 non-synthetic exchanges, with `fallback_notice` = the refusal
//   fallback's content (CLI 2.1.318 binary, `btwHistory.append`).
// - `mcpServerStatus()`, `reconnectMcpServer()`, `toggleMcpServer()` (declared, live-tested in
//   Phase 1 probe6 M). `toggleMcpServer` persists `disabledMcpServers` in `~/.claude.json`.
//   `mcpAuthenticate(name, redirectUri?, {redirectUriOnly})` → `{authUrl?, requiresUserAction,
//   callbackExpected, …}` and `mcpSubmitOAuthCallbackUrl(name, url)` are undeclared and not
//   run live (**unverified**).

import type {
  CommandInfo,
  LocalCommandInfo,
  McpAuthStart,
  McpServerInfo,
  SideAnswer,
  SideExchange,
  SkillInfo,
  UserInput,
} from '@dsh-raw-agent/core';
import { parseContextUsage } from './usage.js';
import { isObject, str, strArray } from './wire.js';

/** D55: the backend-written note for a toggle (the DSH layer shows it as given). */
export const MCP_TOGGLE_NOTE = 'Saved by Claude Code in ~/.claude.json, like /mcp in the terminal.';

/** The suffix the CLI gives MCP server prompts in its command list (probe5). */
const MCP_PROMPT_SUFFIX = ' (MCP)';

/**
 * What the session knows about its command list (R7.1). The `init` lists and the latest full rows
 * are kept so every list says which rows are skills or terminal-only.
 */
export class CommandCatalog {
  #skills = new Set<string>();
  #terminal = new Set<string>();
  #initNames: string[] | undefined;
  #rows: CommandInfo[] | undefined;

  /** `system/init`. Returns the names-only list to announce, or undefined when it lists none. */
  init(msg: Record<string, unknown>): CommandInfo[] | undefined {
    if (Array.isArray(msg.skills)) this.#skills = new Set(strArray(msg.skills));
    if (Array.isArray(msg.terminal_slash_commands)) this.#terminal = new Set(strArray(msg.terminal_slash_commands));
    if (!Array.isArray(msg.slash_commands)) return undefined;
    this.#initNames = strArray(msg.slash_commands);
    // Full rows already known (an earlier push or read) win: keep their order and details.
    if (this.#rows !== undefined) return this.list();
    return this.#initNames.map((name) => this.#decorate({ name }));
  }

  /** Full rows from `supportedCommands()` or a `commands_changed` push. */
  rows(raw: unknown): CommandInfo[] {
    const list = Array.isArray(raw) ? raw.flatMap((r) => (isObject(r) ? [toCommandInfo(r)] : [])) : [];
    this.#rows = list;
    return this.list();
  }

  /** The current list, decorated. Empty before any report. */
  list(): CommandInfo[] {
    const base = this.#rows ?? (this.#initNames ?? []).map((name) => ({ name }) as CommandInfo);
    return base.map((c) => this.#decorate({ ...c }));
  }

  isSkill(name: string): boolean {
    return this.#skills.has(name);
  }

  /** The skill names `init` reported, in its order (undefined before `init`). */
  get skillNames(): string[] | undefined {
    return this.#initNames === undefined && this.#skills.size === 0 ? undefined : [...this.#skills];
  }

  #decorate(c: CommandInfo): CommandInfo {
    if (this.#skills.has(c.name) && c.kind !== 'builtin') c.kind = 'skill';
    if (this.#terminal.has(c.name)) c.terminalOnly = true;
    return c;
  }
}

/** One `SlashCommand` row (`SDK/sdk.d.ts:9876`). Names are kept byte for byte (D52). */
export function toCommandInfo(raw: Record<string, unknown>): CommandInfo {
  const name = str(raw.name) ?? '';
  const info: CommandInfo = { name };
  const description = str(raw.description);
  if (description) info.description = description;
  const hint = str(raw.argumentHint);
  if (hint) info.argumentHint = hint;
  const aliases = strArray(raw.aliases).filter((a) => a !== '');
  if (aliases.length > 0) info.aliases = aliases;
  if (raw.builtin === true) info.kind = 'builtin';
  else if (name.endsWith(MCP_PROMPT_SUFFIX)) info.kind = 'mcp-prompt';
  else info.kind = 'custom';
  return info;
}

/**
 * R7.5: the session's skills: the `init` skill names (or, before `init`, the `/context` skill
 * rows) joined with the command rows that describe them. Read-only: nothing is reloaded.
 */
export function skillList(
  catalog: CommandCatalog,
  commands: CommandInfo[],
  contextSkills: Array<{ name: string; source: string; plugin?: string; tokens: number }> | undefined,
): SkillInfo[] {
  const byName = new Map(commands.map((c) => [c.name, c]));
  const fromContext = new Map((contextSkills ?? []).map((s) => [s.name, s]));
  const names = catalog.skillNames ?? (contextSkills ?? []).map((s) => s.name);
  const seen = new Set<string>();
  const out: SkillInfo[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const info: SkillInfo = { name };
    const c = byName.get(name);
    if (c?.description) info.description = c.description;
    if (c?.argumentHint) info.argumentHint = c.argumentHint;
    const s = fromContext.get(name);
    if (s !== undefined) {
      info.source = s.source;
      if (s.plugin !== undefined) info.plugin = s.plugin;
      info.tokens = s.tokens;
    }
    out.push(info);
  }
  return out;
}

/**
 * R7.2: what a synthetic assistant message says about the local command it answers. Undefined
 * when it is not a local command's output (an API error, a model-less notice).
 */
export function localCommandOf(msg: Record<string, unknown>): LocalCommandInfo | undefined {
  const run = isObject(msg.local_command_run) ? msg.local_command_run : undefined;
  const outcome = isObject(msg.local_command_outcome) ? msg.local_command_outcome : undefined;
  if (run === undefined && outcome === undefined && msg.local_command_source === undefined) return undefined;
  const info: LocalCommandInfo = {};
  const name = str(run?.command) ?? nameFromSource(str(msg.local_command_source));
  if (name !== undefined && name !== '') info.name = name;
  const args = str(run?.args);
  if (args !== undefined && args !== '') info.args = args;
  if (str(outcome?.kind) === 'unavailable_headless') info.unavailable = true;
  if (isObject(msg.context_usage)) info.structured = { kind: 'context', context: parseContextUsage(msg.context_usage) };
  return info;
}

/** "/btw isn't available in this environment." → 'btw' (the only name an unavailable reply has). */
function nameFromSource(source: string | undefined): string | undefined {
  const m = source === undefined ? null : /^<local-command-stdout>\/([^\s]+) isn't available/.exec(source);
  return m?.[1];
}

/**
 * The command a sent input starts with, as the CLI reads it (a leading `/name`), so a later
 * output with no name of its own (`system/local_command_output`) can be named. The input itself
 * is never changed: a slash command goes to the CLI as the plain text the user typed (D52).
 */
export function slashCommandOf(input: UserInput): { name: string; args: string } | undefined {
  const first = input.parts[0];
  if (first === undefined || first.type !== 'text') return undefined;
  const m = /^\/([^\s/][^\s]*)(?:\s+([\s\S]*))?$/.exec(first.text.trimEnd());
  if (m === null) return undefined;
  return { name: m[1]!, args: (m[2] ?? '').trim() };
}

/** D55: one `McpServerStatus` (`SDK/sdk.d.ts:1294`). No config values beyond the transport kind. */
export function toMcpServerInfo(raw: Record<string, unknown>): McpServerInfo | undefined {
  const name = str(raw.name);
  if (name === undefined) return undefined;
  const info: McpServerInfo = { name, status: str(raw.status) ?? 'pending' };
  const error = str(raw.error);
  if (error) info.error = error;
  const scope = str(raw.scope);
  if (scope) info.scope = scope;
  const source = str(raw.source);
  if (source) info.source = source;
  if (isObject(raw.serverInfo)) {
    const n = str(raw.serverInfo.name);
    const v = str(raw.serverInfo.version);
    if (n) info.serverName = n;
    if (v) info.serverVersion = v;
  }
  if (isObject(raw.config)) {
    const t = str(raw.config.type);
    // A config with a command and no type is a stdio server (the CLI's default transport).
    if (t) info.transport = t;
    else if (str(raw.config.command) !== undefined) info.transport = 'stdio';
  }
  if (Array.isArray(raw.tools)) {
    info.tools = raw.tools.flatMap((t) => {
      if (!isObject(t)) return [];
      const n = str(t.name);
      if (n === undefined) return [];
      const tool: NonNullable<McpServerInfo['tools']>[number] = { name: n };
      const d = str(t.description);
      if (d) tool.description = d;
      const a = isObject(t.annotations) ? t.annotations : undefined;
      if (a?.readOnly === true) tool.readOnly = true;
      if (a?.destructive === true) tool.destructive = true;
      return [tool];
    });
  }
  return info;
}

export function toMcpServerList(raw: unknown): McpServerInfo[] {
  return Array.isArray(raw)
    ? raw.flatMap((r) => {
        const s = isObject(r) ? toMcpServerInfo(r) : undefined;
        return s === undefined ? [] : [s];
      })
    : [];
}

/** D55: the `mcp_authenticate` answer (**unverified** live). */
export function toMcpAuthStart(raw: unknown): McpAuthStart {
  const r = isObject(raw) ? raw : {};
  const out: McpAuthStart = {
    needsUserAction: r.requiresUserAction === true,
    callbackExpected: r.callbackExpected === true,
  };
  const url = str(r.authUrl);
  if (url) out.url = url;
  return out;
}

/** D54: the wire history, oldest first, at most the TUI's 20 (CLI 2.1.318: `.slice(-20)`). */
export function sideHistoryWire(history: SideExchange[]): Array<Record<string, string>> {
  return history.slice(-20).map((h) => {
    const e: Record<string, string> = { question: h.question, response: h.answer };
    if (h.fallbackNotice) e.fallback_notice = h.fallbackNotice;
    return e;
  });
}

/** D54: `askSideQuestion`'s answer. `null` stays `null` (cancelled). */
export function toSideAnswer(raw: unknown): SideAnswer | null {
  if (raw === null || raw === undefined) return null;
  const r = isObject(raw) ? raw : {};
  const text = str(r.response);
  if (text === undefined) return null;
  const out: SideAnswer = { text, synthetic: r.synthetic === true };
  const f = isObject(r.refusalFallback) ? r.refusalFallback : undefined;
  if (f !== undefined) {
    const originalModel = str(f.originalModel);
    const fallbackModel = str(f.fallbackModel);
    const content = str(f.content);
    if (originalModel !== undefined && fallbackModel !== undefined && content !== undefined)
      out.fallback = { originalModel, fallbackModel, content };
  }
  return out;
}
