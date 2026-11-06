// Pure view logic for the Claude tool views (D19, D56): summaries, paths, checklists and diffs from
// a call's own input and result. No React and no DSH: the client port turns DSH's call record into
// `ToolViewProps` (core), and these functions read only that.

import { diffCounts, lineDiff, numberDiff, splitLines, type DiffLine, type ToolViewProps } from '@dsh-raw-agent/core';

export const str = (v: unknown): v is string => typeof v === 'string';
const rec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (str(v) && v.trim() !== '' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** A path as the user reads it: relative to the session folder, else `~` for the home folder. */
export function displayPath(path: string, cwd?: string, home?: string): string {
  const p = path.replace(/\\/g, '/');
  const strip = (base: string | undefined): string | undefined => {
    if (!base) return undefined;
    const b = base.replace(/\\/g, '/').replace(/\/+$/, '');
    if (b === '') return undefined;
    if (p === b) return '.';
    return p.startsWith(`${b}/`) ? p.slice(b.length + 1) : undefined;
  };
  const rel = strip(cwd);
  if (rel !== undefined) return rel;
  const h = strip(home);
  if (h !== undefined) return h === '.' ? '~' : `~/${h}`;
  return path;
}

/** The first non-empty line, cut to `max` characters. */
export function firstLine(value: string, max = 120): string {
  const line = value.split('\n').find((l) => l.trim() !== '') ?? '';
  const t = line.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** How the row's status reads. */
export type RowState = 'preparing' | 'running' | 'done' | 'error' | 'stopped';

/** The CLI's own text when the user stopped a tool (Phase 3 L3) or rejected it. */
const STOPPED = /^(?:The user doesn't want to proceed|\[Request interrupted by user)/;

export function rowState(p: ToolViewProps): RowState {
  if (p.phase === 'preparing') return 'preparing';
  if (!p.result) return 'running';
  if (p.result.isError) return STOPPED.test(p.result.text.trim()) ? 'stopped' : 'error';
  return 'done';
}

export const STATE_LABEL: Record<RowState, string> = {
  preparing: 'writing…',
  running: 'running…',
  done: '',
  error: 'failed',
  stopped: 'stopped',
};

// ---- Bash ----------------------------------------------------------------------------------------

export interface BashModel {
  command: string;
  description?: string;
  background: boolean;
  timeoutMs?: number;
}

export function bashModel(input: Record<string, unknown>): BashModel {
  const m: BashModel = {
    command: str(input.command) ? input.command : '',
    background: input.run_in_background === true,
  };
  const d = text(input.description);
  if (d) m.description = d;
  const t = num(input.timeout);
  if (t !== undefined) m.timeoutMs = t;
  return m;
}

// ---- Read ----------------------------------------------------------------------------------------

export interface ReadModel {
  path?: string;
  /** "lines 10–59", "page 3", … */
  range?: string;
  /** The first line the read starts at, for opening the file there. */
  line?: number;
}

export function readModel(input: Record<string, unknown>): ReadModel {
  const m: ReadModel = {};
  const path = text(input.file_path) ?? text(input.notebook_path) ?? text(input.path);
  if (path) m.path = path;
  const offset = num(input.offset);
  const limit = num(input.limit);
  if (offset !== undefined && limit !== undefined) m.range = `lines ${offset}–${offset + limit - 1}`;
  else if (offset !== undefined) m.range = `from line ${offset}`;
  else if (limit !== undefined) m.range = `first ${limit} lines`;
  if (text(input.pages)) m.range = `pages ${String(input.pages)}`;
  if (offset !== undefined && offset > 0) m.line = offset;
  return m;
}

/**
 * The lines of a Read result. The CLI numbers each line (`cat -n` form: spaces, the number, a tab
 * or `→`, the text); a line in that form is split into its number and text. Other lines (a system
 * note, an image notice) stay plain.
 */
export function readLines(result: string): Array<{ n?: number; text: string }> {
  return splitLines(result).map((l) => {
    const m = /^\s*(\d+)(?:\t|→)(.*)$/.exec(l);
    return m ? { n: Number(m[1]), text: m[2] ?? '' } : { text: l };
  });
}

// ---- Edit, MultiEdit, Write ----------------------------------------------------------------------

export interface EditModel {
  path?: string;
  lines: DiffLine[];
  added: number;
  removed: number;
  replaceAll: boolean;
  /** How many edits a MultiEdit holds. */
  edits: number;
}

/** The diff of an Edit or MultiEdit input, with line numbers counted from the edited text. */
export function editModel(input: Record<string, unknown>): EditModel {
  const path = text(input.file_path);
  const lines: DiffLine[] = [];
  let edits = 0;
  if (str(input.old_string) || str(input.new_string)) {
    edits = 1;
    lines.push(
      ...numberDiff(
        lineDiff(str(input.old_string) ? input.old_string : '', str(input.new_string) ? input.new_string : ''),
      ),
    );
  } else if (Array.isArray(input.edits)) {
    for (const e of input.edits) {
      if (!rec(e)) continue;
      if (edits > 0) lines.push({ op: ' ', text: '⋯' });
      edits++;
      lines.push(...numberDiff(lineDiff(str(e.old_string) ? e.old_string : '', str(e.new_string) ? e.new_string : '')));
    }
  }
  const { added, removed } = diffCounts(lines);
  const m: EditModel = { lines, added, removed, replaceAll: input.replace_all === true, edits };
  if (path) m.path = path;
  return m;
}

export function writeModel(input: Record<string, unknown>): { path?: string; lines: DiffLine[] } {
  const content = str(input.content) ? input.content : '';
  const lines = splitLines(content).map((t, i): DiffLine => ({ op: '+', text: t, new: i + 1 }));
  const path = text(input.file_path);
  return path ? { path, lines } : { lines };
}

// ---- Grep, Glob ----------------------------------------------------------------------------------

export function searchSummary(input: Record<string, unknown>, cwd?: string, home?: string): string {
  const parts: string[] = [];
  const pattern = text(input.pattern);
  if (pattern) parts.push(pattern);
  const path = text(input.path);
  if (path) parts.push(`in ${displayPath(path, cwd, home)}`);
  const glob = text(input.glob);
  if (glob) parts.push(`(${glob})`);
  const type = text(input.type);
  if (type) parts.push(`type ${type}`);
  return parts.join(' ');
}

/** The number of result lines (matches or files), when the result is a plain list. */
export function resultCount(result: string): number {
  return splitLines(result).filter((l) => l.trim() !== '').length;
}

// ---- Agent / Task --------------------------------------------------------------------------------

export interface AgentModel {
  agentType?: string;
  description?: string;
  prompt?: string;
  background: boolean;
  name?: string;
  model?: string;
}

export function agentModel(input: Record<string, unknown>): AgentModel {
  const m: AgentModel = { background: input.run_in_background === true };
  const t = text(input.subagent_type);
  if (t) m.agentType = t;
  const d = text(input.description);
  if (d) m.description = d;
  const p = text(input.prompt);
  if (p) m.prompt = p;
  const n = text(input.name);
  if (n) m.name = n;
  const mo = text(input.model);
  if (mo) m.model = mo;
  return m;
}

// ---- TodoWrite -----------------------------------------------------------------------------------

export interface TodoItem {
  text: string;
  status: 'pending' | 'in_progress' | 'completed' | (string & {});
}

export function todoItems(input: Record<string, unknown>): TodoItem[] {
  if (!Array.isArray(input.todos)) return [];
  const out: TodoItem[] = [];
  for (const t of input.todos) {
    if (!rec(t)) continue;
    const status = str(t.status) ? t.status : 'pending';
    // While a task runs, the agent's terminal shows its active form ("Running tests").
    const label = status === 'in_progress' ? (text(t.activeForm) ?? text(t.content)) : text(t.content);
    if (label) out.push({ text: label, status });
  }
  return out;
}

export function todoSummary(items: readonly TodoItem[]): string {
  if (items.length === 0) return '';
  const done = items.filter((t) => t.status === 'completed').length;
  const now = items.find((t) => t.status === 'in_progress');
  return `${done}/${items.length} done${now ? ` · ${now.text}` : ''}`;
}

// ---- Skill (R7.5, D56) ---------------------------------------------------------------------------

/** The skill a Skill call loads, from its input (`skill`, older CLIs: `command`). */
export function skillName(input: Record<string, unknown>): string | undefined {
  const n = text(input.skill) ?? text(input.command) ?? text(input.name);
  return n?.replace(/^\//, '');
}

// ---- AskUserQuestion -----------------------------------------------------------------------------

export interface QuestionModel {
  header?: string;
  question: string;
  options: string[];
  multiSelect: boolean;
}

export function questionModels(input: Record<string, unknown>): QuestionModel[] {
  if (!Array.isArray(input.questions)) return [];
  const out: QuestionModel[] = [];
  for (const q of input.questions) {
    if (!rec(q) || !str(q.question)) continue;
    const options = Array.isArray(q.options)
      ? q.options.map((o) => (rec(o) && str(o.label) ? o.label : str(o) ? o : '')).filter((o) => o !== '')
      : [];
    const m: QuestionModel = { question: q.question, options, multiSelect: q.multiSelect === true };
    const h = text(q.header);
    if (h) m.header = h;
    out.push(m);
  }
  return out;
}

// ---- ExitPlanMode --------------------------------------------------------------------------------

/** The plan's title: its first heading, else its first line. */
export function planTitle(plan: string): string {
  const heading = plan.split('\n').find((l) => /^#{1,6}\s+\S/.test(l));
  return firstLine(heading ? heading.replace(/^#{1,6}\s+/, '') : plan, 100);
}

// ---- WebFetch / WebSearch ------------------------------------------------------------------------

/** An http(s) address that is safe to link; anything else is shown as text. */
export function safeUrl(v: unknown): string | undefined {
  if (!str(v)) return undefined;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}
