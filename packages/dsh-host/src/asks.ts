// Pending asks from the agent (permission, question, plan, elicitation) and the workspace-trust
// question (D73), held until the USER answers (rules 3, 4). DSH-neutral and backend-neutral.
//
// This is the M1 interim of the interaction channel (D39). The full cards (diff previews,
// feedback, question forms, "attached to the tool card", D40-D43, D77) are R5. Until then an ask
// is shown in the plugin's composer row with one button per choice, and nothing is ever answered
// for the user: no auto-reject, no auto-allow. Stop answers an open ask the way the agent's own
// terminal app does when the user presses Esc on it (reject / decline), because Stop is a real
// user action. Only the main thread's asks: a background agent's ask stays open (rule 6). A plugin-made "the user said no" never reaches the model (maintainer Q1: the
// agent's reject text only for a real user reject).

import type {
  ElicitationAnswer,
  InteractionHandler,
  PermissionAnswer,
  PlanAnswer,
  QuestionAnswer,
  TrustQuestion,
} from '@dsh-raw-agent/core';

/** One choice button. */
export interface AskChoice {
  id: string;
  label: string;
}

/** What the UI shows for one pending ask (wire shape). */
export interface AskView {
  id: string;
  kind: 'permission' | 'question' | 'plan' | 'elicitation' | 'trust';
  /** A subagent asked (`child`), or the main thread. */
  agent: 'main' | 'child';
  title: string;
  detail?: string;
  choices: AskChoice[];
  /** The choice Stop picks: the agent's own Esc answer (reject or decline). */
  stopChoice: string;
  at: number;
}

interface Entry {
  view: AskView;
  answer(choiceId: string): void;
  /** The agent cancelled it (its abort signal): drop it, answer nothing. */
  drop(): void;
}

const MAX_DETAIL = 600;

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

export const DECLINE = 'decline';
export const KEEP_PLANNING = 'keep-planning';
export const TRUST_ACCEPT = 'trust-accept';
export const TRUST_DECLINE = 'trust-decline';

/** The open asks of one session. `onChange` runs after every add and remove. */
export class AskDesk {
  readonly #open = new Map<string, Entry>();
  readonly #onChange: () => void;
  readonly #now: () => number;
  #seq = 0;

  constructor(onChange: () => void, now: () => number = Date.now) {
    this.#onChange = onChange;
    this.#now = now;
  }

  get size(): number {
    return this.#open.size;
  }

  list(): AskView[] {
    return [...this.#open.values()].map((e) => ({ ...e.view, choices: e.view.choices.map((c) => ({ ...c })) }));
  }

  /** The user's answer. False when the ask is gone or the choice is not one of its own. */
  answer(id: string, choiceId: string): boolean {
    const e = this.#open.get(id);
    if (!e || !e.view.choices.some((c) => c.id === choiceId)) return false;
    this.#remove(id);
    e.answer(choiceId);
    return true;
  }

  /**
   * The user pressed Stop: open asks get their Esc answer (reject / decline), as in the agent's
   * terminal app. `kinds` limits it (the trust question while the process starts); `agents`
   * limits whose asks (Stop passes `['main']`). A subagent's ask is not the turn's: Stop
   * interrupts only the main turn (rule 6), and a background agent keeps running, so its ask stays
   * open for the user. A foreground subagent's ask is dropped when the agent cancels it.
   */
  stop(kinds?: ReadonlyArray<AskView['kind']>, agents?: ReadonlyArray<AskView['agent']>): number {
    let n = 0;
    for (const [id, e] of [...this.#open]) {
      if (kinds && !kinds.includes(e.view.kind)) continue;
      if (agents && !agents.includes(e.view.agent)) continue;
      this.#remove(id);
      e.answer(e.view.stopChoice);
      n++;
    }
    return n;
  }

  /** The process ended: nobody waits for these answers any more. */
  dropAll(): void {
    for (const [id, e] of [...this.#open]) {
      this.#remove(id);
      e.drop();
    }
  }

  #remove(id: string): void {
    if (this.#open.delete(id)) this.#onChange();
  }

  /** Hold one ask until the user answers or the signal aborts. */
  #hold<T>(
    view: Omit<AskView, 'at' | 'id'> & { id?: string },
    map: (choiceId: string) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    const id = this.#open.has(view.id ?? '') || view.id === undefined ? `ask-${++this.#seq}` : view.id;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        if (!this.#open.has(id)) return;
        this.#remove(id);
        reject(new Error('the ask was cancelled'));
      };
      const entry: Entry = {
        view: { ...view, id, at: this.#now() },
        answer: (choiceId) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(map(choiceId));
        },
        drop: () => {
          signal?.removeEventListener('abort', onAbort);
          reject(new Error('the session ended'));
        },
      };
      if (signal?.aborted) {
        reject(new Error('the ask was cancelled'));
        return;
      }
      this.#open.set(id, entry);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#onChange();
    });
  }

  /** The workspace-trust question (D73). Resolves true only on the user's accept click. */
  trust(q: TrustQuestion, directory: string, signal?: AbortSignal): Promise<boolean> {
    return this.#hold(
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
      },
      (c) => c === TRUST_ACCEPT,
      signal,
    );
  }

  /** The handler the backend calls. Every answer comes from a user click or Stop. */
  handler(): InteractionHandler {
    return {
      permission: (req, signal) => {
        const reject =
          req.options.find((o) => o.kind === 'reject-once') ?? req.options.find((o) => o.kind.startsWith('reject'));
        const title = req.title ?? `${req.displayName ?? req.toolName} wants to run`;
        // The TUI shows what will run (the command, file or URL) with the tool's own description
        // under it. The description alone hides the command, so it is never shown without it.
        const what = inputSummary(req.input) ?? req.blockedPath;
        const detail =
          what !== undefined && req.description !== undefined && req.description !== what
            ? `${what} — ${req.description}`
            : (what ?? req.description);
        const view: Omit<AskView, 'at' | 'id'> & { id?: string } = {
          id: req.id,
          kind: 'permission',
          agent: req.agent.kind === 'child' ? 'child' : 'main',
          title: req.agentLabel ? `${req.agentLabel}: ${title}` : title,
          choices: req.options.map((o) => ({ id: o.id, label: o.label })),
          stopChoice: reject?.id ?? req.options.at(-1)?.id ?? 'reject',
        };
        if (detail !== undefined) view.detail = detail;
        return this.#hold<PermissionAnswer>(view, (optionId) => ({ optionId }), signal);
      },
      question: (req, signal) => {
        // A one-question, single-select ask can be answered with its own options; anything else
        // waits for the R5.3 form and can only be declined (the agent's own Esc answer).
        const only = req.questions.length === 1 ? (req.questions[0] as Record<string, unknown>) : undefined;
        const text = typeof only?.question === 'string' ? only.question : undefined;
        const options = Array.isArray(only?.options) ? (only.options as Array<Record<string, unknown>>) : [];
        const single = only !== undefined && only.multiSelect !== true && text !== undefined;
        const labels = single ? options.map((o) => (typeof o.label === 'string' ? o.label : '')).filter(Boolean) : [];
        const choices: AskChoice[] = labels.map((label, i) => ({ id: `option-${i}`, label }));
        choices.push({ id: DECLINE, label: 'Decline' });
        const titles = req.questions
          .map((q) => (q as Record<string, unknown>).question)
          .filter((q): q is string => typeof q === 'string');
        const view: Omit<AskView, 'at' | 'id'> & { id?: string } = {
          id: req.id,
          kind: 'question',
          agent: req.agent.kind === 'child' ? 'child' : 'main',
          title: titles.join(' / ') || 'A question for you',
          choices,
          stopChoice: DECLINE,
        };
        if (!single)
          view.detail = 'This question needs the full question form (not built yet); you can only decline it.';
        return this.#hold<QuestionAnswer>(
          view,
          (c) => {
            const m = /^option-(\d+)$/.exec(c);
            const label = m ? labels[Number(m[1])] : undefined;
            return label !== undefined && text !== undefined ? { answers: { [text]: label } } : null;
          },
          signal,
        );
      },
      plan: (req, signal) => {
        const view: Omit<AskView, 'at' | 'id'> & { id?: string } = {
          id: req.id,
          kind: 'plan',
          agent: req.agent.kind === 'child' ? 'child' : 'main',
          title: 'Ready to code? Here is the plan',
          detail: clip(req.plan),
          choices: [
            ...req.choices.map((c) => ({ id: c.id, label: c.label })),
            { id: KEEP_PLANNING, label: 'No, keep planning' },
          ],
          stopChoice: KEEP_PLANNING,
        };
        return this.#hold<PlanAnswer>(
          view,
          (c) => (c === KEEP_PLANNING ? { kind: 'keep-planning' } : { kind: 'approve', choiceId: c }),
          signal,
        );
      },
      elicitation: (req, signal) => {
        const view: Omit<AskView, 'at' | 'id'> & { id?: string } = {
          id: req.id,
          kind: 'elicitation',
          agent: 'main',
          title: `${req.serverName}: ${req.message}`,
          choices: [{ id: DECLINE, label: 'Decline' }],
          stopChoice: DECLINE,
        };
        if (req.url !== undefined) view.detail = req.url;
        return this.#hold<ElicitationAnswer>(view, () => ({ action: 'decline' }), signal);
      },
    };
  }
}
