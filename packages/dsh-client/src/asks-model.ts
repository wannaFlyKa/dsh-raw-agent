// Pure view logic for the interaction cards (D40-D43, D73, D77): previews, diffs, question and
// elicitation forms. No React, no DSH, no backend names: previews are chosen by the shape of the
// tool input, not by tool name, so another agent's tools render the same way.

import { lineDiff, numberDiff, splitLines, type DiffLine } from '@dsh-raw-agent/core';
import type { AskChoiceWire, AskWire, QuestionWire } from './api.js';
import { askWho } from './view-model.js';

// ---------------------------------------------------------------------------------------------
// Headings

const KIND_VERB: Record<AskWire['kind'], string> = {
  permission: 'asks for permission',
  question: 'asks you',
  plan: 'has a plan',
  elicitation: 'asks for input',
  trust: 'asks whether you trust this folder',
};

/** The card heading: who asks (the subagent by name, D77) and what. */
export function askHeading(ask: AskWire, displayName: string): string {
  if (ask.state === 'waiting') return `${askWho(ask, displayName)} waits for you to finish in the browser`;
  return `${askWho(ask, displayName)} ${KIND_VERB[ask.kind] ?? 'asks'}`;
}

/** The ask title without the subagent prefix the Host adds (the heading names the subagent). */
export function askTitle(ask: AskWire): string {
  const prefix = ask.agentLabel ? `${ask.agentLabel}: ` : undefined;
  return prefix && ask.title.startsWith(prefix) ? ask.title.slice(prefix.length) : ask.title;
}

// ---------------------------------------------------------------------------------------------
// Permission previews (D77: from the request's own input, before any tool/call is written)

export type { DiffLine } from '@dsh-raw-agent/core';
export { splitLines, lineDiff, diffHunks, diffText, numberDiff } from '@dsh-raw-agent/core';

export type Preview =
  | { kind: 'command'; text: string; note?: string }
  | { kind: 'diff'; path?: string; lines: DiffLine[]; note?: string }
  | { kind: 'text'; label: string; text: string; note?: string }
  | { kind: 'json'; text: string };

const str = (v: unknown): v is string => typeof v === 'string';
const rec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function pathOf(o: Record<string, unknown>): string | undefined {
  for (const k of ['file_path', 'notebook_path', 'path']) if (str(o[k]) && o[k] !== '') return o[k];
  return undefined;
}

function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

/**
 * What a permission card previews. A command shows the whole command; an edit shows its diff;
 * a new file shows its full text as added lines; anything else shows the whole input as JSON.
 */
export function permissionPreview(input: unknown): Preview | undefined {
  if (input === undefined || input === null) return undefined;
  if (!rec(input)) return { kind: 'json', text: prettyJson(input) };
  const path = pathOf(input);
  const note = str(input.description) && input.description !== '' ? input.description : undefined;
  if (str(input.command)) return { kind: 'command', text: input.command, ...(note ? { note } : {}) };
  if (str(input.old_string) && str(input.new_string)) {
    const lines = numberDiff(lineDiff(input.old_string, input.new_string));
    const all = input.replace_all === true ? 'Every match is replaced.' : undefined;
    return { kind: 'diff', ...(path ? { path } : {}), lines, ...(all ? { note: all } : {}) };
  }
  if (Array.isArray(input.edits) && input.edits.every((e) => rec(e) && str(e.old_string) && str(e.new_string))) {
    const lines: DiffLine[] = [];
    (input.edits as Array<{ old_string: string; new_string: string }>).forEach((e, i) => {
      if (i > 0) lines.push({ op: ' ', text: '⋯' });
      lines.push(...numberDiff(lineDiff(e.old_string, e.new_string)));
    });
    return { kind: 'diff', ...(path ? { path } : {}), lines };
  }
  if (str(input.content) && path) {
    return {
      kind: 'diff',
      path,
      lines: splitLines(input.content).map((text, i) => ({ op: '+', text, new: i + 1 })),
      note: 'New file content.',
    };
  }
  if (str(input.new_source)) {
    const mode = str(input.edit_mode) ? `Cell edit: ${input.edit_mode}.` : undefined;
    return {
      kind: 'diff',
      ...(path ? { path } : {}),
      lines: splitLines(input.new_source).map((text) => ({ op: '+', text })),
      ...(mode ? { note: mode } : {}),
    };
  }
  // Leftover M4: a workflow launch shows its script, not the input as JSON.
  if (str(input.script) && input.script !== '') {
    const name = str(input.name) && input.name !== '' ? `Workflow: ${input.name}` : undefined;
    return { kind: 'text', label: 'Script', text: input.script, ...(name ? { note: name } : {}) };
  }
  if (str(input.url)) {
    const prompt = str(input.prompt) ? input.prompt : undefined;
    return { kind: 'text', label: 'URL', text: input.url, ...(prompt ? { note: prompt } : {}) };
  }
  return { kind: 'json', text: prettyJson(input) };
}

/** The first `max` lines, and how many more there are (the card offers "Show all"). */
export function clipLines<T>(
  lines: readonly T[],
  max: number,
  expanded: boolean,
): { shown: readonly T[]; hidden: number } {
  if (expanded || lines.length <= max) return { shown: lines, hidden: 0 };
  return { shown: lines.slice(0, max), hidden: lines.length - max };
}

/** The permission choices, grouped as the card shows them. */
export function permissionGroups(choices: readonly AskChoiceWire[]): {
  allow: AskChoiceWire[];
  always: AskChoiceWire[];
  reject: AskChoiceWire[];
} {
  const allow: AskChoiceWire[] = [];
  const always: AskChoiceWire[] = [];
  const reject: AskChoiceWire[] = [];
  for (const c of choices) {
    if (c.kind?.startsWith('reject')) reject.push(c);
    else if (c.kind === 'allow-always' || c.destination !== undefined || (c.effects?.length ?? 0) > 0) always.push(c);
    else allow.push(c);
  }
  return { allow, always, reject };
}

// ---------------------------------------------------------------------------------------------
// AskUserQuestion (D41)

export interface QuestionDraft {
  /** Picked option labels (one for single select). */
  picked: string[];
  /** The "Other" field is on, and its text. */
  otherOn: boolean;
  other: string;
  note: string;
}

export const emptyDraft = (): QuestionDraft => ({ picked: [], otherOn: false, other: '', note: '' });

/** Pick or unpick one option. Single select: one option or "Other", not both. */
export function toggleOption(q: QuestionWire, d: QuestionDraft, label: string): QuestionDraft {
  if (q.multiSelect) {
    const picked = d.picked.includes(label) ? d.picked.filter((l) => l !== label) : [...d.picked, label];
    return { ...d, picked };
  }
  return { ...d, picked: [label], otherOn: false };
}

/** Turn "Other" on or off. Single select: "Other" replaces the picked option. */
export function toggleOther(q: QuestionWire, d: QuestionDraft, on: boolean): QuestionDraft {
  return q.multiSelect ? { ...d, otherOn: on } : { ...d, otherOn: on, picked: on ? [] : d.picked };
}

/** One question's answer, or undefined while unanswered. */
export function draftAnswer(q: QuestionWire, d: QuestionDraft): string | string[] | undefined {
  const other = d.otherOn && q.allowsOther && d.other.trim() !== '' ? d.other.trim() : undefined;
  if (q.multiSelect) {
    const all = [...d.picked.filter((l) => q.options.some((o) => o.label === l)), ...(other ? [other] : [])];
    return all.length > 0 ? all : undefined;
  }
  if (other) return other;
  const label = d.picked[0];
  return label !== undefined && q.options.some((o) => o.label === label) ? label : undefined;
}

/**
 * The form's reply (D41): answers keyed by question text, multi select as a list, "Other" as the
 * typed text, notes only where typed. `missing` lists the unanswered questions.
 */
export function questionReply(
  questions: readonly QuestionWire[],
  drafts: readonly QuestionDraft[],
): { answers: Record<string, string | string[]>; notes?: Record<string, string>; missing: string[] } {
  const answers: Record<string, string | string[]> = {};
  const notes: Record<string, string> = {};
  const missing: string[] = [];
  questions.forEach((q, i) => {
    const d = drafts[i] ?? emptyDraft();
    const a = draftAnswer(q, d);
    if (a === undefined) missing.push(q.question);
    else answers[q.question] = a;
    if (d.note.trim() !== '') notes[q.question] = d.note.trim();
  });
  return Object.keys(notes).length > 0 ? { answers, notes, missing } : { answers, missing };
}

/**
 * The preview to show beside a single-select question: the picked option's, else the first
 * option that has one (as the TUI shows the focused option's). Multi select shows none (D41).
 */
export function questionPreview(q: QuestionWire, d: QuestionDraft, focused?: string): string | undefined {
  if (q.multiSelect) return undefined;
  const by = (label: string | undefined) => q.options.find((o) => o.label === label)?.preview;
  return by(focused) ?? by(d.picked[0]) ?? q.options.find((o) => o.preview !== undefined)?.preview;
}

// ---------------------------------------------------------------------------------------------
// Elicitation forms (D43): `requestedSchema` is MCP's flat object schema of primitive fields.

export type FieldValue = string | boolean | string[];

export interface FieldModel {
  key: string;
  title: string;
  description?: string;
  required: boolean;
  kind: 'text' | 'number' | 'integer' | 'boolean' | 'select' | 'multi';
  /** HTML input type for text fields (MCP string formats). */
  inputType: 'text' | 'email' | 'url' | 'date' | 'datetime-local';
  options: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  default?: FieldValue;
}

const FORMAT_INPUT: Record<string, FieldModel['inputType']> = {
  email: 'email',
  uri: 'url',
  date: 'date',
  'date-time': 'datetime-local',
};

function enumOptions(s: Record<string, unknown>): Array<{ value: string; label: string }> | undefined {
  if (Array.isArray(s.enum)) {
    const names = Array.isArray(s.enumNames) ? s.enumNames : [];
    return s.enum.filter(str).map((v, i) => ({ value: v, label: str(names[i]) ? names[i] : v }));
  }
  for (const k of ['oneOf', 'anyOf'])
    if (Array.isArray(s[k]))
      return (s[k] as unknown[])
        .filter((o): o is Record<string, unknown> => rec(o) && str(o.const))
        .map((o) => ({ value: o.const as string, label: str(o.title) ? o.title : (o.const as string) }));
  return undefined;
}

/** The form's fields in property order. Unknown shapes become a plain text field. */
export function elicitationFields(schema: unknown): FieldModel[] {
  if (!rec(schema) || !rec(schema.properties)) return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter(str) : []);
  return Object.entries(schema.properties).map(([key, raw]) => {
    const s = rec(raw) ? raw : {};
    const f: FieldModel = {
      key,
      title: str(s.title) && s.title !== '' ? s.title : key,
      required: required.has(key),
      kind: 'text',
      inputType: 'text',
      options: [],
    };
    if (str(s.description) && s.description !== '') f.description = s.description;
    const opts = enumOptions(s);
    if (s.type === 'array') {
      const items = rec(s.items) ? s.items : {};
      f.kind = 'multi';
      f.options = enumOptions(items) ?? [];
      if (Array.isArray(s.default)) f.default = s.default.filter(str);
    } else if (opts) {
      f.kind = 'select';
      f.options = opts;
      if (str(s.default)) f.default = s.default;
    } else if (s.type === 'boolean') {
      f.kind = 'boolean';
      if (typeof s.default === 'boolean') f.default = s.default;
    } else if (s.type === 'number' || s.type === 'integer') {
      f.kind = s.type;
      if (typeof s.default === 'number') f.default = String(s.default);
    } else {
      if (str(s.format) && FORMAT_INPUT[s.format]) f.inputType = FORMAT_INPUT[s.format]!;
      if (str(s.default)) f.default = s.default;
    }
    for (const k of ['minimum', 'maximum', 'minLength', 'maxLength'] as const) {
      const v = s[k];
      if (typeof v !== 'number') continue;
      if (k === 'minimum') f.min = v;
      else if (k === 'maximum') f.max = v;
      else f[k] = v;
    }
    return f;
  });
}

/** Starting values: each field's default, else empty. */
export function initialValues(fields: readonly FieldModel[]): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const f of fields) out[f.key] = f.default ?? (f.kind === 'boolean' ? false : f.kind === 'multi' ? [] : '');
  return out;
}

/**
 * The typed `content` to send, or the first problem. Empty optional fields are left out; the
 * MCP server checks the values itself, this only catches what the user can fix here.
 */
export function elicitationContent(
  fields: readonly FieldModel[],
  values: Readonly<Record<string, FieldValue>>,
): { content: Record<string, unknown> } | { error: string } {
  const content: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (f.kind === 'boolean') {
      // An untouched optional checkbox with no default is left out (the server's default stands).
      if (v === true || f.required || f.default !== undefined) content[f.key] = v === true;
      continue;
    }
    if (f.kind === 'multi') {
      const list = Array.isArray(v) ? v : [];
      if (list.length === 0) {
        if (f.required) return { error: `${f.title} is required` };
        continue;
      }
      content[f.key] = [...list];
      continue;
    }
    const text = str(v) ? v.trim() : '';
    if (text === '') {
      if (f.required) return { error: `${f.title} is required` };
      continue;
    }
    if (f.kind === 'number' || f.kind === 'integer') {
      const n = Number(text);
      if (!Number.isFinite(n)) return { error: `${f.title} must be a number` };
      if (f.kind === 'integer' && !Number.isInteger(n)) return { error: `${f.title} must be a whole number` };
      if (f.min !== undefined && n < f.min) return { error: `${f.title} must be at least ${f.min}` };
      if (f.max !== undefined && n > f.max) return { error: `${f.title} must be at most ${f.max}` };
      content[f.key] = n;
      continue;
    }
    if (f.kind === 'select' && !f.options.some((o) => o.value === text))
      return { error: `Pick a value for ${f.title}` };
    if (f.minLength !== undefined && text.length < f.minLength)
      return { error: `${f.title} needs at least ${f.minLength} characters` };
    if (f.maxLength !== undefined && text.length > f.maxLength)
      return { error: `${f.title} takes at most ${f.maxLength} characters` };
    content[f.key] = text;
  }
  return { content };
}

/** A link the card may open: http(s) only. Any other scheme is shown as text, never opened. */
export function safeHttpUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Markdown (plans and question previews). A small, safe subset rendered to React elements by
// ./ui/markdown.tsx: never raw HTML.

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'code'; text: string }
  | { t: 'strong'; children: Inline[] }
  | { t: 'em'; children: Inline[] }
  | { t: 'link'; href?: string; children: Inline[] };

export type Block =
  | { t: 'heading'; level: number; children: Inline[] }
  | { t: 'paragraph'; children: Inline[] }
  | { t: 'list'; ordered: boolean; items: Inline[][] }
  | { t: 'code'; lang?: string; text: string }
  | { t: 'quote'; children: Inline[] }
  | { t: 'rule' }
  | { t: 'table'; rows: Inline[][][] };

/** Inline markdown: `code`, **strong**, *em* / _em_, [text](url). Unmatched marks stay text. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let plain = '';
  const flush = () => {
    if (plain !== '') out.push({ t: 'text', text: plain });
    plain = '';
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^`([^`]+)`/.exec(rest))) {
      flush();
      out.push({ t: 'code', text: m[1]! });
      i += m[0].length;
    } else if ((m = /^\*\*(.+?)\*\*/.exec(rest)) || (m = /^__(.+?)__/.exec(rest))) {
      flush();
      out.push({ t: 'strong', children: parseInline(m[1]!) });
      i += m[0].length;
    } else if (
      (m = /^\*(?!\s)(.+?)\*/.exec(rest)) ||
      (!/[A-Za-z0-9]/.test(text[i - 1] ?? '') && (m = /^_(?!\s)(.+?)_(?![A-Za-z0-9])/.exec(rest)))
    ) {
      flush();
      out.push({ t: 'em', children: parseInline(m[1]!) });
      i += m[0].length;
    } else if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest))) {
      flush();
      const href = safeHttpUrl(m[2]);
      out.push({ t: 'link', ...(href ? { href } : {}), children: parseInline(m[1]!) });
      i += m[0].length;
    } else {
      plain += text[i];
      i++;
    }
  }
  flush();
  return out;
}

const tableCells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => parseInline(c.trim()));

/** Block markdown: ATX headings, lists, fenced code, quotes, rules, pipe tables, paragraphs. */
export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: Block[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length > 0) out.push({ t: 'paragraph', children: parseInline(para.join(' ')) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let m: RegExpExecArray | null;
    if ((m = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/.exec(line))) {
      flushPara();
      const fence = m[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence)) body.push(lines[i++]!);
      out.push({ t: 'code', ...(m[2] ? { lang: m[2] } : {}), text: body.join('\n') });
    } else if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
      flushPara();
      out.push({ t: 'heading', level: m[1]!.length, children: parseInline(m[2]!) });
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      out.push({ t: 'rule' });
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flushPara();
      const ordered = /^\s*\d/.test(line);
      const items: Inline[][] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]!)) {
        const item = lines[i]!.replace(/^\s*([-*+]|\d+[.)])\s+/, '');
        const indent = /^(\s*)/.exec(lines[i]!)![1]!.length;
        items.push(parseInline(indent > 0 ? `${'\u00a0'.repeat(Math.min(indent, 8))}${item}` : item));
        i++;
      }
      i--;
      out.push({ t: 'list', ordered, items });
    } else if (/^\s*>/.test(line)) {
      flushPara();
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ''));
      i--;
      out.push({ t: 'quote', children: parseInline(body.join(' ')) });
    } else if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      flushPara();
      const rows: Inline[][][] = [tableCells(line)];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) rows.push(tableCells(lines[i++]!));
      i--;
      out.push({ t: 'table', rows });
    } else if (line.trim() === '') flushPara();
    else para.push(line.trim());
  }
  flushPara();
  return out;
}

// ---------------------------------------------------------------------------------------------
// Keyboard keys on a card (R5.2-R5.4): as in the agent's terminal app, a number picks a choice,
// Up/Down move between choices, and Esc gives the agent's Esc answer (the ask's `stopChoice`).

/** The one-click choices of a card in the order the card shows them (numbered 1, 2, …). */
export function numberedChoices(ask: AskWire): AskChoiceWire[] {
  if (ask.state === 'waiting') return [];
  if (ask.kind === 'permission') {
    const g = permissionGroups(ask.choices);
    return [...g.allow, ...g.always, ...g.reject];
  }
  if (ask.kind === 'plan') {
    const keep = ask.choices.find((c) => c.feedback);
    return [...ask.choices.filter((c) => c !== keep), ...(keep ? [keep] : [])];
  }
  // Questions and elicitations are forms: their choices need the fields, so no numbers.
  if (ask.kind === 'question' || ask.kind === 'elicitation') return [];
  return ask.choices.filter((c) => c.submits === undefined);
}

export type CardKey = { type: 'choose'; choice: AskChoiceWire } | { type: 'move'; by: 1 | -1 } | undefined;

/**
 * What one key press on a card does. `inText`: the focus is in a text field (feedback, Other,
 * a form field), where keys are typing and only Esc acts after the field is left.
 */
export function cardKey(ask: AskWire, key: string, mods: { inText: boolean; modified: boolean }): CardKey {
  if (mods.modified) return undefined;
  if (key === 'Escape') {
    if (mods.inText || ask.state === 'waiting') return undefined;
    const stop = ask.choices.find((c) => c.id === ask.stopChoice && c.submits === undefined);
    return stop ? { type: 'choose', choice: stop } : undefined;
  }
  if (mods.inText) return undefined;
  if (key === 'ArrowDown') return { type: 'move', by: 1 };
  if (key === 'ArrowUp') return { type: 'move', by: -1 };
  if (/^[1-9]$/.test(key)) {
    const c = numberedChoices(ask)[Number(key) - 1];
    return c ? { type: 'choose', choice: c } : undefined;
  }
  return undefined;
}
