// M6 (R7.1-R7.4): the agent's own `/` menu, the side question (`/btw`), MCP state and local
// command outputs, as one session's runtime keeps them. DSH-neutral: the port serves the routes;
// the client's `/` source shows the menu (D52 r5); nothing here touches DSH.
//
// Nothing here writes the host log. The side-question history, the MCP list and the structured
// local outputs are in memory only (D24); after a restart they come back from the live process.

import {
  SideQuestionHistory,
  type CommandInfo,
  type ContextUsage,
  type LocalCommandStructured,
  type McpAuthStart,
  type McpServerInfo,
  type SideAnswer,
  type SideExchange,
} from '@dsh-raw-agent/core';

// ---- the `/` menu (R7.1, D36, D52) ----

/**
 * Names DSH keeps in our sessions (D36, D52): DSH's client `/model` and `/file` rows, the
 * `/permission` and `/feedback` popups keyed by name, and `/export`. A clashing agent command stays
 * in the list with {@link TAKEN_NOTE} and is never renamed; typed by hand it still runs DSH's command.
 */
export const DSH_KEPT_COMMANDS: readonly string[] = Object.freeze([
  'model',
  'file',
  'permission',
  'feedback',
  'export',
]);

/** D52: the note on an agent command whose name DSH already uses in this session. */
export const TAKEN_NOTE = 'taken by DSH in this session';

/**
 * How the plugin's client `/` source shows one agent command (D52 r5). No row is a DSH host
 * command: a pick only puts `/name ` in the composer and Enter sends the line as typed text, so
 * DSH writes no `command/run` record and the agent gets the exact line.
 */
export type MenuPlacement =
  /** Offered by our `/` source. */
  | 'listed'
  /** DSH uses the name in this session (D52): shown with the note; typed, DSH's command runs. */
  | 'taken'
  /** The agent says it runs only in its terminal app: shown with a note; typed, the agent answers. */
  | 'terminal-only'
  /** The side-question command (D54): claimed by the client source, never sent to the agent. */
  | 'side-question'
  /** The agent's MCP view command (D55): the bare command opens the plugin's MCP panel. */
  | 'mcp-panel'
  /** The agent's rewind menu command (D30, M7): bare, it opens the plugin's rewind dialog. */
  | 'rewind-panel';

export interface MenuRow extends CommandInfo {
  menu: MenuPlacement;
  note?: string;
}

export interface MenuPlan {
  rows: MenuRow[];
}

/**
 * D52: place every agent command. Names are kept byte for byte; nothing is renamed. `taken` holds
 * the names other DSH commands already use for this agent (the port reads them from DSH's
 * registry); {@link DSH_KEPT_COMMANDS} are always taken.
 */
export function planCommandMenu(
  list: readonly CommandInfo[],
  opts: {
    taken?: Iterable<string>;
    sideQuestionCommand?: string;
    mcpCommand?: string;
    rewindCommand?: string;
    displayName: string;
  },
): MenuPlan {
  const taken = new Set<string>([...DSH_KEPT_COMMANDS, ...(opts.taken ?? [])]);
  const seen = new Set<string>();
  const rows: MenuRow[] = [];
  for (const c of list) {
    if (typeof c?.name !== 'string' || c.name === '' || seen.has(c.name)) continue;
    seen.add(c.name);
    const row: MenuRow = { ...c, menu: 'listed' };
    if (c.name === opts.sideQuestionCommand) row.menu = 'side-question';
    else if (taken.has(c.name)) {
      row.menu = 'taken';
      row.note = TAKEN_NOTE;
    } else if (c.name === opts.rewindCommand) row.menu = 'rewind-panel';
    else if (c.terminalOnly) row.menu = 'terminal-only';
    else if (c.name === opts.mcpCommand) row.menu = 'mcp-panel';
    rows.push(row);
  }
  return { rows };
}

// ---- the side question (R7.3, D54) ----

/** Exchanges the side panel shows (the history sent to the agent has its own limit). */
export const SIDE_ENTRIES_KEPT = 20;
/** The longest side question accepted (characters). */
export const SIDE_QUESTION_MAX = 20_000;

export type SideEntryStatus = 'waiting' | 'asking' | 'answered' | 'failed' | 'cancelled';

export interface SideEntry {
  id: string;
  question: string;
  status: SideEntryStatus;
  at: number;
  answer?: string;
  /** The agent's own "no answer" text: shown, but not kept in the history it is sent. */
  synthetic?: boolean;
  fallback?: SideAnswer['fallback'];
  error?: string;
}

export interface SideView {
  entries: SideEntry[];
  /** Earlier exchanges the next question carries (the agent's own rule: non-synthetic, last 20). */
  historySize: number;
}

export type SideAskResult =
  | { ok: true; entry: SideEntry }
  | { ok: false; code: 'empty' | 'too-long' | 'busy' | 'unsupported'; error: string; entry?: SideEntry };

/** The live process's side-question control, or why there is none. */
export type SideControl =
  | { kind: 'ready'; ask: (q: string, history: SideExchange[], signal: AbortSignal) => Promise<SideAnswer | null> }
  | { kind: 'not-running' }
  | { kind: 'unsupported' };

export interface SideDeskDeps {
  displayName: string;
  control(): SideControl;
  notify(): void;
  now?: () => number;
}

/**
 * D54: one session's side questions. The history follows the agent's own rules
 * (`SideQuestionHistory`); `clear()` on a conversation reset (D70). One question at a time, as in
 * the terminal app. With no process the question waits ('waiting') and is asked right after the
 * user starts the agent (D4: a question never starts it).
 */
export class SideQuestionDesk {
  readonly #deps: SideDeskDeps;
  readonly #now: () => number;
  readonly #history = new SideQuestionHistory();
  #entries: SideEntry[] = [];
  readonly #aborts = new Map<string, AbortController>();
  #seq = 0;

  constructor(deps: SideDeskDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  view(): SideView {
    return { entries: this.#entries.map((e) => ({ ...e })), historySize: this.#history.size };
  }

  get busy(): boolean {
    return this.#entries.some((e) => e.status === 'asking');
  }

  /**
   * Ask now, or keep the question for the start. Resolves when the agent answered (or failed);
   * a waiting question resolves at once with status 'waiting'.
   */
  async ask(question: string, signal?: AbortSignal): Promise<SideAskResult> {
    const q = question.trim();
    if (q === '') return { ok: false, code: 'empty', error: 'Type a question first.' };
    if (q.length > SIDE_QUESTION_MAX)
      return { ok: false, code: 'too-long', error: `The question is longer than ${SIDE_QUESTION_MAX} characters.` };
    const control = this.#deps.control();
    if (control.kind === 'unsupported')
      return {
        ok: false,
        code: 'unsupported',
        error: `This ${this.#deps.displayName} version cannot answer side questions.`,
      };
    if (this.busy || this.#entries.some((e) => e.status === 'waiting'))
      return { ok: false, code: 'busy', error: 'Another side question is still open. Wait for its answer first.' };
    const entry: SideEntry = { id: `side-${++this.#seq}`, question: q, status: 'waiting', at: this.#now() };
    this.#push(entry);
    if (control.kind === 'not-running') {
      this.#deps.notify();
      return { ok: true, entry: { ...entry } };
    }
    return this.#run(entry, control.ask, signal);
  }

  /** The agent started: ask the waiting question, if any (D54: kept until the user's Start). */
  resume(): void {
    const entry = this.#entries.find((e) => e.status === 'waiting');
    if (!entry) return;
    const control = this.#deps.control();
    if (control.kind === 'ready') void this.#run(entry, control.ask);
    else if (control.kind === 'unsupported') {
      entry.status = 'failed';
      entry.error = `This ${this.#deps.displayName} version cannot answer side questions.`;
      this.#deps.notify();
    }
  }

  /**
   * The user's Start failed: a waiting question fails with the reason, so it does not block
   * every later question as "busy" until the user cancels it.
   */
  startFailed(reason: string): void {
    const entry = this.#entries.find((e) => e.status === 'waiting');
    if (!entry) return;
    entry.status = 'failed';
    entry.error = `${this.#deps.displayName} did not start: ${reason}`;
    this.#deps.notify();
  }

  /** Cancel one open question (asking or waiting). */
  cancel(id: string): boolean {
    const entry = this.#entries.find((e) => e.id === id);
    if (!entry || (entry.status !== 'asking' && entry.status !== 'waiting')) return false;
    this.#aborts.get(id)?.abort();
    this.#aborts.delete(id);
    entry.status = 'cancelled';
    this.#deps.notify();
    return true;
  }

  /** D70: the conversation was reset; earlier exchanges no longer belong to it. */
  clear(): void {
    // An open question's late answer must not land in the cleared history (a backend may ignore
    // the abort): mark it cancelled first, so `#run` drops whatever arrives.
    for (const e of this.#entries) if (e.status === 'asking' || e.status === 'waiting') e.status = 'cancelled';
    for (const a of this.#aborts.values()) a.abort();
    this.#aborts.clear();
    this.#history.clear();
    this.#entries = [];
    this.#deps.notify();
  }

  #push(entry: SideEntry): void {
    this.#entries = [...this.#entries, entry].slice(-SIDE_ENTRIES_KEPT);
  }

  async #run(entry: SideEntry, ask: Extract<SideControl, { kind: 'ready' }>['ask'], signal?: AbortSignal) {
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    this.#aborts.set(entry.id, abort);
    entry.status = 'asking';
    this.#deps.notify();
    try {
      const answer = await ask(entry.question, this.#history.list(), abort.signal);
      if (entry.status !== 'asking') return { ok: true as const, entry: { ...entry } }; // cancelled or cleared
      if (answer === null) entry.status = 'cancelled';
      else {
        entry.status = 'answered';
        entry.answer = answer.text;
        if (answer.synthetic) entry.synthetic = true;
        if (answer.fallback) entry.fallback = { ...answer.fallback };
        this.#history.record(entry.question, answer);
      }
    } catch (error) {
      if (entry.status === 'asking') {
        entry.status = abort.signal.aborted ? 'cancelled' : 'failed';
        if (!abort.signal.aborted) entry.error = String((error as Error)?.message ?? error);
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.#aborts.delete(entry.id);
      this.#deps.notify();
    }
    return { ok: true as const, entry: { ...entry } };
  }
}

// ---- MCP servers (R7.4, D55) and local outputs (R7.2, D69) ----

export interface McpAnswer {
  running: boolean;
  /** 'live': read from the process now; 'reported': the agent's own start report (always pending). */
  from: 'live' | 'reported' | 'none';
  servers: McpServerInfo[];
  /** The live read failed or is not supported; the list is the last known one. */
  reason?: string;
}

export type McpActionResult =
  | { ok: true; note?: string; auth?: McpAuthStart; mcp: McpAnswer }
  | { ok: false; code: 'not-running' | 'unsupported' | 'unknown-server' | 'failed'; error: string; mcp?: McpAnswer };

/** Structured local-command outputs kept for display (the text itself is in the host log). */
export const LOCAL_OUTPUTS_KEPT = 20;

/**
 * R7.2: a local command's structured twin has no host event type, so it is kept here for the
 * plugin view only (display-only path, documented in notes and §6). The host log keeps the
 * command's text as a native `assistant/message` whose binding names the output id.
 */
export class LocalOutputs {
  readonly #items = new Map<string, LocalCommandStructured>();
  #seq = 0;

  add(structured: LocalCommandStructured): string {
    const id = `local-${Date.now().toString(36)}-${++this.#seq}`;
    this.#items.set(id, structured);
    while (this.#items.size > LOCAL_OUTPUTS_KEPT) {
      const first = this.#items.keys().next().value;
      if (first === undefined) break;
      this.#items.delete(first);
    }
    return id;
  }

  get(id: string): LocalCommandStructured | undefined {
    return this.#items.get(id);
  }

  /** The last `/context` report, if any (for tests and the panel). */
  lastContext(): ContextUsage | undefined {
    const all = [...this.#items.values()];
    for (let i = all.length - 1; i >= 0; i--) if (all[i]!.kind === 'context') return all[i]!.context;
    return undefined;
  }
}
