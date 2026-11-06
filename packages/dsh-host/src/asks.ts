// The interaction channel's Host half (D39): pending asks from the agent (permission, question,
// plan, elicitation) and the workspace-trust question (D73), held until the USER answers (rules 3,
// 4). DSH-neutral and backend-neutral.
//
// - Nothing is ever answered for the user: no auto-reject, no auto-allow. Stop answers an open
//   main-thread ask the way the agent's own terminal app does on Esc (reject / decline / keep
//   planning), because Stop is a real user action; a background agent's ask stays open (rule 6).
// - It works with or without an open host turn (D39). The asks live in memory (D24): a page reload
//   replays them from here; a host restart ends the process that asked, so they end with it.
// - The first answer wins. A second browser's answer for the same ask gets "gone" (D39).
// - Every view carries the full request data (`form`) so a card can render previews, feedback
//   fields, question forms and elicitation forms (D40-D43, D77). Labels are the agent's own words.
// - The approval audit (D44) is reported through `AskHooks`; the runtime decides whether a host
//   turn is open to record it.

import type {
  AgentRef,
  ElicitationAnswer,
  InteractionHandler,
  PermissionAnswer,
  PermissionOption,
  PlanAnswer,
  QuestionAnswer,
  QuestionItem,
  TrustQuestion,
} from '@dsh-raw-agent/core';

/** One choice button. Optional fields tell the card what the choice needs or does. */
export interface AskChoice {
  id: string;
  label: string;
  /** Permission option kind (`allow-once`, `allow-always`, `reject-once`, …). */
  kind?: string;
  /** Where an "always" choice is saved, in plain words (D40). */
  destination?: string;
  /** What an "always" choice saves, one line each (the exact rule text). */
  effects?: string[];
  /** The choice takes an optional typed text (reject with feedback, keep planning). */
  feedback?: boolean;
  feedbackPlaceholder?: string;
  /** The choice submits a filled form: question `answers` or elicitation `content`. */
  submits?: 'answers' | 'content';
  /** With `submits: 'answers'`: the form may be partly filled or empty ("Chat about this"). */
  partial?: boolean;
  /** An "always" choice whose rule the user may edit first (the agent's suggestion and a hint). */
  editable?: { value: string; placeholder?: string; toolName: string };
}

/** The data a card renders, copied from the agent's request (wire-safe JSON). */
export type AskForm =
  | {
      type: 'permission';
      toolName: string;
      displayName?: string;
      /** The tool input, for the diff or command preview (D77). Absent when too large. */
      input?: unknown;
      inputTruncated?: boolean;
      description?: string;
      reason?: string;
      blockedPath?: string;
      defaultToNo?: boolean;
      mcpServer?: { name: string; source: string };
    }
  | { type: 'question'; questions: QuestionItem[]; previewFormat: 'markdown' | 'html'; otherLabel: string }
  | { type: 'plan'; plan: string; planFilePath?: string }
  | {
      type: 'elicitation';
      serverName: string;
      message: string;
      mode: 'form' | 'url';
      url?: string;
      requestedSchema?: unknown;
      title?: string;
      displayName?: string;
      description?: string;
    }
  | { type: 'trust'; directory: string; body: string };

export type AskKind = 'permission' | 'question' | 'plan' | 'elicitation' | 'trust';

/** What the UI shows for one pending ask (wire shape). */
export interface AskView {
  id: string;
  kind: AskKind;
  /** A subagent asked (`child`), or the main thread. */
  agent: 'main' | 'child';
  /** The subagent's id, when a subagent asked. */
  agentId?: string;
  /** The subagent's label (D77), when the agent named it. */
  agentLabel?: string;
  /** The tool call this ask is about (D77: attach the card to the tool card). */
  callId?: string;
  title: string;
  detail?: string;
  choices: AskChoice[];
  /** The choice Stop picks: the agent's own Esc answer (reject or decline). */
  stopChoice: string;
  at: number;
  /**
   * `waiting`: the user accepted a URL elicitation and the agent has not reported it done yet
   * (D43). The card stays open; its only choice closes it on this side.
   */
  state?: 'waiting';
  form?: AskForm;
}

/** The user's answer from the UI. Only `choice` is required; the rest depends on the choice. */
export interface AskReply {
  choice: string;
  feedback?: string;
  answers?: Record<string, string | string[]>;
  notes?: Record<string, string>;
  content?: Record<string, unknown>;
  /** The edited rule of an `editable` choice. */
  rule?: string;
}

export type AskResult = { ok: true } | { ok: false; code: 'gone' | 'invalid'; error: string };

/** DSH's native approval outcomes (D44). "Always" is `allowed-once`: the rule is the agent's. */
export type AuditOutcome = 'allowed-once' | 'rejected' | 'cancelled';

/** What the audit pair names (D44 `approval/asked`). */
export interface AuditInfo {
  toolName: string;
  callId?: string;
  reason?: string;
}

/** Audit callbacks (D44). Called only for permission, question and plan asks. */
export interface AskHooks {
  opened?(view: AskView, info: AuditInfo): void;
  closed?(id: string, outcome: AuditOutcome): void;
}

interface Entry {
  view: AskView;
  /** Check the reply and answer the agent. Returns an error text for an invalid reply. */
  settle(reply: AskReply): string | undefined;
  /** The agent cancelled it, or the process ended: drop it, answer nothing. */
  drop(reason: string): void;
  audited: boolean;
}

const MAX_DETAIL = 600;
const MAX_TEXT = 20_000;
/** A tool input larger than this is not copied into the view (a huge Write, for example). */
const MAX_INPUT_JSON = 512 * 1024;

function clip(text: string): string {
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
}

/** A short, readable view of a tool input for the ask line. Never sent anywhere but the UI. */
export function inputSummary(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === 'string') return clip(input);
  if (typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const k of ['command', 'file_path', 'path', 'url', 'pattern', 'description'])
      if (typeof o[k] === 'string' && o[k] !== '') return clip(o[k]);
    try {
      return clip(JSON.stringify(input));
    } catch {
      return undefined;
    }
  }
  return clip(String(input));
}

/** A JSON copy of a value, or undefined when it cannot be copied or is too large. */
function jsonCopy(value: unknown, limit = MAX_INPUT_JSON): { value?: unknown; tooLarge?: boolean } {
  if (value === undefined) return {};
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return {};
    if (text.length > limit) return { tooLarge: true };
    return { value: JSON.parse(text) as unknown };
  } catch {
    return {};
  }
}

export const DECLINE = 'decline';
export const KEEP_PLANNING = 'keep-planning';
export const TRUST_ACCEPT = 'trust-accept';
export const TRUST_DECLINE = 'trust-decline';
/** Question: submit the filled form (`answers`, optional `notes`). */
export const SUBMIT = 'submit';
/** Question: talk it over instead (the agent's "Chat about this"); answers so far are optional. */
export const CHAT = 'chat';
/** Elicitation: accept (form: with `content`), decline, cancel (D43). */
export const ACCEPT = 'accept';
export const CANCEL = 'cancel';
/** A waiting URL elicitation: close the card on this side only. */
export const DISMISS = 'dismiss';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const okText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= MAX_TEXT;

/** Check optional feedback; undefined = fine. */
function feedbackError(reply: AskReply, allowed: boolean): string | undefined {
  if (reply.feedback === undefined) return undefined;
  if (typeof reply.feedback !== 'string' || reply.feedback.length > MAX_TEXT) return 'feedback must be text';
  if (!allowed && reply.feedback.trim() !== '') return 'this choice takes no feedback';
  return undefined;
}

/** The question form's answer (D41): keyed by question text; validated against the request. */
export function checkQuestionReply(
  questions: readonly QuestionItem[],
  reply: AskReply,
  allowEmpty = false,
): { answers: Record<string, string | string[]>; notes?: Record<string, string> } | string {
  if (allowEmpty && reply.answers === undefined) reply = { ...reply, answers: {} };
  if (!isRecord(reply.answers)) return 'answers must be an object keyed by question text';
  const byText = new Map(questions.map((q) => [q.question, q]));
  const answers: Record<string, string | string[]> = {};
  for (const [text, value] of Object.entries(reply.answers)) {
    const q = byText.get(text);
    if (!q) return `not a question of this ask: ${text}`;
    const labels = new Set(q.options.map((o) => o.label));
    const known = (v: string) => labels.has(v) || q.allowsOther;
    if (typeof value === 'string') {
      if (!okText(value)) return `the answer to "${text}" is empty or too long`;
      if (!known(value)) return `"${value}" is not an option of "${text}"`;
      answers[text] = value;
    } else if (Array.isArray(value)) {
      if (!q.multiSelect) return `"${text}" takes one answer`;
      if (value.length === 0 || !value.every(okText)) return `the answers to "${text}" must be non-empty texts`;
      const unknown = value.find((v) => !known(v));
      if (unknown !== undefined) return `"${unknown}" is not an option of "${text}"`;
      answers[text] = [...value];
    } else return `the answer to "${text}" must be text or a list of texts`;
  }
  if (Object.keys(answers).length === 0 && !allowEmpty) return 'answer at least one question';
  const out: { answers: Record<string, string | string[]>; notes?: Record<string, string> } = { answers };
  if (reply.notes !== undefined) {
    if (!isRecord(reply.notes)) return 'notes must be an object keyed by question text';
    const notes: Record<string, string> = {};
    for (const [text, note] of Object.entries(reply.notes)) {
      if (!byText.has(text)) return `not a question of this ask: ${text}`;
      if (typeof note !== 'string' || note.length > MAX_TEXT) return 'a note must be text';
      if (note.trim() !== '') notes[text] = note;
    }
    if (Object.keys(notes).length > 0) out.notes = notes;
  }
  return out;
}

/**
 * An elicitation form's content (D43). The MCP server validates the values itself; here only the
 * shape: a JSON object, keys from `requestedSchema.properties` when it lists them, required keys
 * present, and plain values (text, number, boolean, or a list of texts).
 */
export function checkElicitationContent(schema: unknown, content: unknown): Record<string, unknown> | string {
  if (!isRecord(content)) return 'content must be an object';
  const copy = jsonCopy(content, 256 * 1024);
  if (copy.tooLarge) return 'content is too large';
  if (!isRecord(copy.value)) return 'content must be JSON';
  const value = copy.value;
  const props = isRecord(schema) && isRecord(schema.properties) ? schema.properties : undefined;
  for (const [k, v] of Object.entries(value)) {
    if (props && !Object.hasOwn(props, k)) return `not a field of this form: ${k}`;
    const plain = ['string', 'number', 'boolean'].includes(typeof v);
    const texts = Array.isArray(v) && v.every((x) => typeof x === 'string');
    if (!plain && !texts) return `the value of ${k} must be text, a number, true/false, or a list of texts`;
  }
  const required = isRecord(schema) && Array.isArray(schema.required) ? schema.required : [];
  for (const k of required) if (typeof k === 'string' && !Object.hasOwn(value, k)) return `${k} is required`;
  return value;
}

/** The open asks of one session. `onChange` runs after every add and remove. */
export class AskDesk {
  readonly #open = new Map<string, Entry>();
  readonly #onChange: () => void;
  readonly #now: () => number;
  readonly #hooks: AskHooks;
  #seq = 0;

  constructor(onChange: () => void, now: () => number = Date.now, hooks: AskHooks = {}) {
    this.#onChange = onChange;
    this.#now = now;
    this.#hooks = hooks;
  }

  get size(): number {
    return this.#open.size;
  }

  list(): AskView[] {
    return [...this.#open.values()].map((e) => structuredClone(e.view));
  }

  /** The user's answer: a bare choice id (no feedback or form). */
  answer(id: string, choiceId: string): boolean {
    return this.respond(id, { choice: choiceId }).ok;
  }

  /** The user's answer from the UI. The first answer wins; a later one gets `gone`. */
  respond(id: string, reply: AskReply): AskResult {
    const e = this.#open.get(id);
    if (!e) return { ok: false, code: 'gone', error: 'that question is no longer open' };
    if (typeof reply.choice !== 'string' || !e.view.choices.some((c) => c.id === reply.choice))
      return { ok: false, code: 'invalid', error: 'that choice is not offered' };
    const error = e.settle(reply);
    return error === undefined ? { ok: true } : { ok: false, code: 'invalid', error };
  }

  /**
   * The user pressed Stop: open asks get their Esc answer (reject / decline), as in the agent's
   * terminal app. `kinds` limits it (the trust question while the process starts); `agents`
   * limits whose asks (Stop passes `['main']`). A subagent's ask is not the turn's: Stop
   * interrupts only the main turn (rule 6), and a background agent keeps running, so its ask stays
   * open for the user. A foreground subagent's ask is dropped when the agent cancels it.
   */
  stop(kinds?: ReadonlyArray<AskKind>, agents?: ReadonlyArray<AskView['agent']>): number {
    let n = 0;
    for (const [, e] of [...this.#open]) {
      if (e.view.state === 'waiting') continue;
      if (kinds && !kinds.includes(e.view.kind)) continue;
      if (agents && !agents.includes(e.view.agent)) continue;
      if (e.settle({ choice: e.view.stopChoice }) === undefined) n++;
    }
    return n;
  }

  /** The agent finished one interaction (D43: a URL elicitation completed). */
  done(id: string): boolean {
    const e = this.#open.get(id);
    if (!e) return false;
    e.drop('the agent finished it');
    return true;
  }

  /** The agent withdrew one interaction (its abort signal fires too). */
  cancel(id: string): boolean {
    const e = this.#open.get(id);
    if (!e) return false;
    e.drop('the ask was cancelled');
    return true;
  }

  /** The process ended: nobody waits for these answers any more. */
  dropAll(): void {
    for (const [, e] of [...this.#open]) e.drop('the session ended');
  }

  #remove(id: string, outcome?: AuditOutcome): void {
    const e = this.#open.get(id);
    if (!e) return;
    this.#open.delete(id);
    if (e.audited && outcome !== undefined) this.#safe(() => this.#hooks.closed?.(id, outcome));
    this.#onChange();
  }

  #safe(fn: () => void): void {
    try {
      fn();
    } catch {
      // An audit failure never blocks the user's answer (the agent's transcript has the outcome).
    }
  }

  #newId(wanted: string | undefined): string {
    if (wanted !== undefined && wanted !== '' && !this.#open.has(wanted)) return wanted;
    let id: string;
    do id = `ask-${++this.#seq}`;
    while (this.#open.has(id));
    return id;
  }

  /**
   * Hold one ask until the user answers or the signal aborts. `map` turns a valid reply into the
   * agent's answer, or returns `{error}`; `outcome` names the audit outcome of a reply.
   */
  #hold<T>(
    view: Omit<AskView, 'at' | 'id'> & { id?: string },
    map: (reply: AskReply) => { value: T } | { error: string },
    signal?: AbortSignal,
    audit?: { info: AuditInfo; outcome(reply: AskReply): AuditOutcome },
    after?: (reply: AskReply, id: string) => void,
  ): Promise<T> {
    const id = this.#newId(view.id);
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('the ask was cancelled'));
        return;
      }
      const onAbort = () => entry.drop('the ask was cancelled');
      const entry: Entry = {
        view: { ...view, id, at: this.#now() },
        audited: false,
        settle: (reply) => {
          if (this.#open.get(id) !== entry) return 'that question is no longer open';
          const r = map(reply);
          if ('error' in r) return r.error;
          signal?.removeEventListener('abort', onAbort);
          this.#remove(id, audit?.outcome(reply));
          resolve(r.value);
          after?.(reply, id);
          return undefined;
        },
        drop: (reason) => {
          if (this.#open.get(id) !== entry) return;
          signal?.removeEventListener('abort', onAbort);
          this.#remove(id, 'cancelled');
          reject(new Error(reason));
        },
      };
      this.#open.set(id, entry);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (audit) {
        entry.audited = true;
        this.#safe(() => this.#hooks.opened?.(structuredClone(entry.view), audit.info));
      }
      this.#onChange();
    });
  }

  /** D43: an accepted URL elicitation stays as a waiting card until the agent reports it done. */
  #wait(view: AskView): void {
    const id = view.id;
    const entry: Entry = {
      view: { ...view, state: 'waiting', choices: [{ id: DISMISS, label: 'Close' }], stopChoice: DISMISS },
      audited: false,
      settle: () => {
        this.#remove(id);
        return undefined;
      },
      drop: () => this.#remove(id),
    };
    if (this.#open.has(id)) return;
    this.#open.set(id, entry);
    this.#onChange();
  }

  /** The workspace-trust question (D73). Resolves true only on the user's accept click. */
  trust(q: TrustQuestion, directory: string, signal?: AbortSignal): Promise<boolean> {
    return this.#hold<boolean>(
      {
        kind: 'trust',
        agent: 'main',
        title: `${q.title} ${directory}`,
        detail: q.body,
        choices: [
          { id: TRUST_ACCEPT, label: q.acceptLabel },
          { id: TRUST_DECLINE, label: q.declineLabel },
        ],
        stopChoice: TRUST_DECLINE,
        form: { type: 'trust', directory, body: q.body },
      },
      (r): { value: boolean } | { error: string } =>
        r.feedback ? { error: 'this choice takes no feedback' } : { value: r.choice === TRUST_ACCEPT },
      signal,
    );
  }

  /** The handler the backend calls. Every answer comes from a user click or Stop. */
  handler(): InteractionHandler {
    const who = (agent: AgentRef | undefined, label?: string) => {
      const out: Pick<AskView, 'agent' | 'agentId' | 'agentLabel'> = {
        agent: agent?.kind === 'child' ? 'child' : 'main',
      };
      if (agent?.kind === 'child') out.agentId = agent.id;
      if (label !== undefined) out.agentLabel = label;
      return out;
    };
    return {
      permission: (req, signal) => {
        const reject =
          req.options.find((o) => o.kind === 'reject-once') ?? req.options.find((o) => o.kind.startsWith('reject'));
        const title = req.title ?? `${req.displayName ?? req.toolName} ${fallbackVerb(req.input)}`;
        // The TUI shows what will run (the command, file or URL) with the tool's own description
        // under it. The description alone hides the command, so it is never shown without it.
        const what = inputSummary(req.input) ?? req.blockedPath;
        const detail =
          what !== undefined && req.description !== undefined && req.description !== what
            ? `${what} — ${req.description}`
            : (what ?? req.description);
        const form: Extract<AskForm, { type: 'permission' }> = { type: 'permission', toolName: req.toolName };
        const input = jsonCopy(req.input);
        if (input.value !== undefined) form.input = input.value;
        if (input.tooLarge) form.inputTruncated = true;
        if (req.displayName !== undefined) form.displayName = req.displayName;
        if (req.description !== undefined) form.description = req.description;
        if (req.reason !== undefined) form.reason = req.reason;
        if (req.blockedPath !== undefined) form.blockedPath = req.blockedPath;
        if (req.defaultToNo === true) form.defaultToNo = true;
        if (req.mcpServer !== undefined) form.mcpServer = { ...req.mcpServer };
        const view: Omit<AskView, 'at' | 'id'> & { id?: string } = {
          id: req.id,
          kind: 'permission',
          ...who(req.agent, req.agentLabel),
          title: req.agentLabel ? `${req.agentLabel}: ${title}` : title,
          choices: req.options.map(permissionChoice),
          stopChoice: reject?.id ?? req.options.at(-1)?.id ?? 'reject',
          form,
        };
        if (req.callId !== undefined) view.callId = req.callId;
        if (detail !== undefined) view.detail = detail;
        const kindOf = (id: string) => req.options.find((o) => o.id === id)?.kind ?? '';
        const info: AuditInfo = { toolName: req.toolName };
        if (req.callId !== undefined) info.callId = req.callId;
        if (req.reason !== undefined) info.reason = req.reason;
        return this.#hold<PermissionAnswer>(
          view,
          (r) => {
            const option = req.options.find((o) => o.id === r.choice);
            const bad = feedbackError(r, option?.acceptsFeedback === true);
            if (bad) return { error: bad };
            const a: PermissionAnswer = { optionId: r.choice };
            if (r.feedback !== undefined && r.feedback.trim() !== '') a.feedback = r.feedback;
            if (r.rule !== undefined) {
              if (!option?.editableRule) return { error: 'this choice saves no editable rule' };
              const rule = typeof r.rule === 'string' ? r.rule.trim() : '';
              if (rule === '' || rule.length > 1000 || /[\r\n]/.test(rule))
                return { error: 'the rule must be one line of text' };
              if (rule !== option.editableRule.ruleContent) a.ruleContent = rule;
            }
            return { value: a };
          },
          signal,
          { info, outcome: (r) => (kindOf(r.choice).startsWith('allow') ? 'allowed-once' : 'rejected') },
        );
      },
      question: (req, signal) => {
        // A one-question, single-select ask also keeps one button per option (the M1 path);
        // every ask can be submitted as a full form (D41) or declined (the agent's Esc answer).
        const only = req.questions.length === 1 ? req.questions[0] : undefined;
        const text = only?.question;
        const single = only !== undefined && !only.multiSelect;
        const labels = single ? only.options.map((o) => o.label).filter(Boolean) : [];
        const choices: AskChoice[] = labels.map((label, i) => ({ id: `option-${i}`, label }));
        choices.push({ id: SUBMIT, label: 'Submit answers', submits: 'answers' });
        if (req.chatLabel !== undefined)
          choices.push({ id: CHAT, label: req.chatLabel, submits: 'answers', partial: true });
        choices.push({ id: DECLINE, label: 'Decline' });
        const titles = req.questions.map((q) => q.question);
        const questions = jsonCopy(req.questions).value as QuestionItem[] | undefined;
        const view: Omit<AskView, 'at' | 'id'> & { id?: string } = {
          id: req.id,
          kind: 'question',
          ...who(req.agent, req.agentLabel),
          title: titles.join(' / ') || 'A question for you',
          choices,
          stopChoice: DECLINE,
          form: {
            type: 'question',
            questions: questions ?? [],
            previewFormat: req.previewFormat,
            otherLabel: req.otherLabel,
          },
        };
        if (req.callId !== undefined) view.callId = req.callId;
        const info: AuditInfo = { toolName: 'AskUserQuestion' };
        if (req.callId !== undefined) info.callId = req.callId;
        return this.#hold<QuestionAnswer>(
          view,
          (r) => {
            const bad = feedbackError(r, false);
            if (bad) return { error: bad };
            if (r.choice === DECLINE) return { value: null };
            if (r.choice === SUBMIT) {
              const checked = checkQuestionReply(req.questions, r);
              return typeof checked === 'string' ? { error: checked } : { value: checked };
            }
            if (r.choice === CHAT && req.chatLabel !== undefined) {
              const checked = checkQuestionReply(req.questions, r, true);
              return typeof checked === 'string' ? { error: checked } : { value: { ...checked, chat: true } };
            }
            const m = /^option-(\d+)$/.exec(r.choice);
            const label = m ? labels[Number(m[1])] : undefined;
            return label !== undefined && text !== undefined
              ? { value: { answers: { [text]: label } } }
              : { error: 'that choice is not offered' };
          },
          signal,
          { info, outcome: (r) => (r.choice === DECLINE || r.choice === CHAT ? 'rejected' : 'allowed-once') },
        );
      },
      plan: (req, signal) => {
        const form: Extract<AskForm, { type: 'plan' }> = { type: 'plan', plan: req.plan };
        if (req.planFilePath !== undefined) form.planFilePath = req.planFilePath;
        const keep: AskChoice = { id: KEEP_PLANNING, label: req.keepPlanning.label, feedback: true };
        if (req.keepPlanning.feedbackPlaceholder !== undefined)
          keep.feedbackPlaceholder = req.keepPlanning.feedbackPlaceholder;
        const view: Omit<AskView, 'at' | 'id'> & { id?: string } = {
          id: req.id,
          kind: 'plan',
          ...who(req.agent, req.agentLabel),
          title: 'Ready to code? Here is the plan',
          detail: clip(req.plan),
          choices: [...req.choices.map((c) => ({ id: c.id, label: c.label })), keep],
          stopChoice: KEEP_PLANNING,
          form,
        };
        if (req.callId !== undefined) view.callId = req.callId;
        const info: AuditInfo = { toolName: 'ExitPlanMode' };
        if (req.callId !== undefined) info.callId = req.callId;
        return this.#hold<PlanAnswer>(
          view,
          (r) => {
            const bad = feedbackError(r, r.choice === KEEP_PLANNING);
            if (bad) return { error: bad };
            if (r.choice !== KEEP_PLANNING) return { value: { kind: 'approve', choiceId: r.choice } };
            const a: PlanAnswer = { kind: 'keep-planning' };
            if (r.feedback !== undefined && r.feedback.trim() !== '') a.feedback = r.feedback;
            return { value: a };
          },
          signal,
          { info, outcome: (r) => (r.choice === KEEP_PLANNING ? 'rejected' : 'allowed-once') },
        );
      },
      elicitation: (req, signal) => {
        const mode: 'form' | 'url' = req.mode ?? (req.url !== undefined ? 'url' : 'form');
        const form: Extract<AskForm, { type: 'elicitation' }> = {
          type: 'elicitation',
          serverName: req.serverName,
          message: req.message,
          mode,
        };
        if (req.url !== undefined) form.url = req.url;
        const schema = jsonCopy(req.requestedSchema, 256 * 1024).value;
        if (schema !== undefined) form.requestedSchema = schema;
        if (req.title !== undefined) form.title = req.title;
        if (req.displayName !== undefined) form.displayName = req.displayName;
        if (req.description !== undefined) form.description = req.description;
        const view: Omit<AskView, 'at' | 'id'> & { id?: string } = {
          id: req.id,
          kind: 'elicitation',
          // The backend's best guess (D44); unknown counts as the main thread for the UI only.
          // Stop never answers an elicitation: the agent cancels the ones its interrupt ends.
          ...who(req.agent, req.agentLabel),
          title: `${req.displayName ?? req.serverName}: ${req.message}`,
          choices: [
            mode === 'url'
              ? { id: ACCEPT, label: 'Open and continue' }
              : { id: ACCEPT, label: 'Submit', submits: 'content' },
            { id: DECLINE, label: 'Decline' },
            { id: CANCEL, label: 'Cancel' },
          ],
          stopChoice: DECLINE,
          form,
        };
        if (req.url !== undefined) view.detail = req.url;
        return this.#hold<ElicitationAnswer>(
          view,
          (r) => {
            const bad = feedbackError(r, false);
            if (bad) return { error: bad };
            // MCP: only a form accept carries content; a URL accept, decline and cancel have none.
            if (r.content !== undefined && (mode === 'url' || r.choice !== ACCEPT))
              return { error: 'content is only sent with a form' };
            if (r.choice === DECLINE) return { value: { action: 'decline' } };
            if (r.choice === CANCEL) return { value: { action: 'cancel' } };
            if (r.content === undefined) {
              // A URL elicitation is accepted with no content; a form needs its fields (D43).
              const needs = isRecord(schema) && Array.isArray(schema.required) && schema.required.length > 0;
              return mode === 'url' || !needs
                ? { value: { action: 'accept' } }
                : { error: 'the form is not filled in' };
            }
            const content = checkElicitationContent(schema, r.content);
            return typeof content === 'string' ? { error: content } : { value: { action: 'accept', content } };
          },
          signal,
          undefined,
          (r, id) => {
            // D43: a URL card stays open after accept, until `interaction-done` or a dismiss.
            if (mode === 'url' && r.choice === ACCEPT) {
              const v: AskView = { ...structuredClone(view as AskView), id, at: this.#now() };
              this.#wait(v);
            }
          },
        );
      },
    };
  }
}

/**
 * The verb of a permission heading when the agent sends no title. Chosen by input shape, not tool
 * name (D80): a file change "wants to edit", a new file "wants to write", a fetch "wants to fetch",
 * anything else "wants to run".
 */
export function fallbackVerb(input: unknown): string {
  if (!isRecord(input)) return 'wants to run';
  const hasPath = typeof input.file_path === 'string' || typeof input.notebook_path === 'string';
  if (hasPath && (typeof input.old_string === 'string' || Array.isArray(input.edits) || 'new_source' in input))
    return 'wants to edit';
  if (hasPath && typeof input.content === 'string') return 'wants to write';
  if (typeof input.url === 'string' && typeof input.command !== 'string') return 'wants to fetch';
  return 'wants to run';
}

function permissionChoice(o: PermissionOption): AskChoice {
  const c: AskChoice = { id: o.id, label: o.label, kind: o.kind };
  if (o.destination !== undefined) c.destination = o.destination;
  if (o.effects !== undefined) c.effects = [...o.effects];
  if (o.acceptsFeedback === true) c.feedback = true;
  if (o.feedbackPlaceholder !== undefined) c.feedbackPlaceholder = o.feedbackPlaceholder;
  if (o.editableRule !== undefined)
    c.editable = {
      value: o.editableRule.ruleContent,
      toolName: o.editableRule.toolName,
      ...(o.editableRule.placeholder !== undefined ? { placeholder: o.editableRule.placeholder } : {}),
    };
  return c;
}
