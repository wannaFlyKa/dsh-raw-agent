// The usage board (D57-D61, D70, M5). DSH-neutral: it keeps what the backend reported about
// usage, context, compaction, plan limits, retries and auth, for the plugin's usage panel and
// context pill. It never writes the DSH log: per-call usage is already on each step's
// `assistant/message` (D57), and the native context ring stays hidden because `request/context`
// is legal only inside an open turn (D59 r2). Every number here is one the agent reported.

import type {
  AuthInfo,
  BackendEvent,
  BackendEventOf,
  ContextCategory,
  ContextUsage,
  CostLabel,
  PlanLimit,
  PlanLimits,
  TurnUsage,
  UsageSnapshot,
  UsageTotals,
} from '@dsh-raw-agent/core';

/** How many per-turn rows, compactions, retries and resets the board keeps. */
export const USAGE_TURNS_KEPT = 50;
export const USAGE_EVENTS_KEPT = 20;

/** The context pill's data (D59): the agent's own figures, never DSH's ring. */
export interface ContextView {
  used: number;
  window: number;
  autoCompactAt?: number;
  autoCompactEnabled?: boolean;
  /** used / window in percent (the agent's own percentage when it reports one). */
  percent: number;
  /** The agent's categories (only from a full or summary report, never from a call's usage). */
  categories?: ContextCategory[];
  model?: string;
  /**
   * Where the figure came from: 'call' = the last main-thread call's usage (the status-line
   * formula), 'report' = the agent's own context report, 'compaction' = after a compaction.
   */
  source: 'call' | 'report' | 'compaction';
  at: number;
}

export interface TurnUsageRow {
  /** The host turn the agent's turn ran in (absent: it ran outside a host turn). */
  hostTurn?: number;
  usage: TurnUsage;
  at: number;
}

export interface CompactionRow {
  phase: 'start' | 'end';
  trigger?: 'manual' | 'auto';
  preTokens?: number;
  postTokens?: number;
  error?: string;
  at: number;
}

export interface RetryRow {
  attempt: number;
  maxRetries?: number;
  delayMs?: number;
  error: string;
  httpStatus?: number;
  hostTurn?: number;
  at: number;
}

export interface ResetRow {
  trigger?: string;
  hostTurn?: number;
  at: number;
}

/** Everything the usage panel shows (D59, D60). Absent fields are not known yet: never a 0. */
export interface UsageView {
  totals?: UsageTotals;
  costLabel?: CostLabel;
  auth?: AuthInfo;
  limits?: PlanLimits;
  lastTurn?: TurnUsageRow;
  turns: TurnUsageRow[];
  context?: ContextView;
  /** The agent compacts right now. */
  compacting: boolean;
  compactions: CompactionRow[];
  /** Retries of the last model call; cleared when a call succeeds or a turn ends. */
  retries: RetryRow[];
  /** D70: conversation resets (Claude: `/clear`), newest last. */
  resets: ResetRow[];
  /** When the board last changed. */
  at?: number;
}

/** What the session view carries for the composer pill (small; the panel reads the route). */
export interface UsageSummary {
  context?: Pick<ContextView, 'used' | 'window' | 'percent' | 'autoCompactAt' | 'source' | 'at'>;
  compacting: boolean;
  tokens?: number;
  costUsd?: number;
  costLabel?: CostLabel;
  limitsAvailable?: boolean;
  blocked?: boolean;
  /** The plan window with the highest reported share (subscriptions; never a made-up 0 %). */
  limit?: Pick<PlanLimit, 'id' | 'label' | 'percent' | 'resetsAt' | 'status'>;
  /** How the user pays, so the pill can label numbers honestly (D58, D60). */
  auth?: Pick<AuthInfo, 'kind' | 'label'>;
  /** The latest retry of a model call still in progress. */
  retry?: Pick<RetryRow, 'attempt' | 'maxRetries' | 'error' | 'at'>;
  at?: number;
}

const percentOf = (used: number, window: number): number => (window > 0 ? Math.round((used / window) * 1000) / 10 : 0);

const keep = <T>(list: T[], n: number): T[] => (list.length > n ? list.slice(-n) : list);

export class UsageBoard {
  readonly #now: () => number;
  #totals: UsageTotals | undefined;
  #costLabel: CostLabel | undefined;
  #auth: AuthInfo | undefined;
  #limits: PlanLimits | undefined;
  #turns: TurnUsageRow[] = [];
  #context: ContextView | undefined;
  #compacting = false;
  #compactions: CompactionRow[] = [];
  #retries: RetryRow[] = [];
  #resets: ResetRow[] = [];
  #at: number | undefined;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** The event types this board takes. */
  static handles(e: BackendEvent): boolean {
    switch (e.type) {
      case 'usage':
      case 'context':
      case 'compaction':
      case 'limits':
      case 'retry':
      case 'auth':
      case 'conversation-reset':
        return true;
      default:
        return false;
    }
  }

  /** Take one backend event. `hostTurn`: the open host turn, if any. Returns true when it changed. */
  apply(e: BackendEvent, hostTurn?: number): boolean {
    const at = this.#now();
    switch (e.type) {
      case 'usage':
        return this.#usage(e, hostTurn, at);
      case 'context': {
        if (!(e.window > 0) || !(e.used >= 0)) return false;
        const prior = this.#context;
        const c: ContextView = {
          used: e.used,
          window: e.window,
          percent: percentOf(e.used, e.window),
          source: 'call',
          at,
        };
        const compactAt = e.autoCompactAt ?? prior?.autoCompactAt;
        if (compactAt !== undefined) c.autoCompactAt = compactAt;
        if (prior?.autoCompactEnabled !== undefined) c.autoCompactEnabled = prior.autoCompactEnabled;
        if (prior?.model !== undefined) c.model = prior.model;
        this.#context = c;
        this.#retries = []; // a call got through
        break;
      }
      case 'compaction': {
        const row: CompactionRow = { phase: e.phase, at };
        if (e.trigger !== undefined) row.trigger = e.trigger;
        if (e.preTokens !== undefined) row.preTokens = e.preTokens;
        if (e.postTokens !== undefined) row.postTokens = e.postTokens;
        if (e.error !== undefined) row.error = e.error;
        this.#compactions = keep([...this.#compactions, row], USAGE_EVENTS_KEPT);
        this.#compacting = e.phase === 'start';
        if (e.phase === 'end' && e.error === undefined && e.postTokens !== undefined && this.#context) {
          const c = this.#context;
          this.#context = {
            ...c,
            used: e.postTokens,
            percent: percentOf(e.postTokens, c.window),
            source: 'compaction',
            at,
          };
          delete this.#context.categories; // the breakdown is stale now; the next report refills it
        }
        break;
      }
      case 'limits':
        this.#limits = structuredClone(e.limits);
        break;
      case 'retry': {
        const row: RetryRow = { attempt: e.attempt, error: e.error, at };
        if (e.maxRetries !== undefined) row.maxRetries = e.maxRetries;
        if (e.delayMs !== undefined) row.delayMs = e.delayMs;
        if (e.httpStatus !== undefined) row.httpStatus = e.httpStatus;
        if (hostTurn !== undefined) row.hostTurn = hostTurn;
        this.#retries = keep([...this.#retries, row], USAGE_EVENTS_KEPT);
        break;
      }
      case 'auth':
        this.#auth = structuredClone(e.auth);
        this.#costLabel = structuredClone(e.costLabel);
        break;
      case 'conversation-reset': {
        // D70: Claude starts fresh. The context meter empties until the next call or report;
        // the backend sends the restarted totals itself (its ledger re-bases, D58).
        const row: ResetRow = { at };
        if (e.trigger !== undefined) row.trigger = e.trigger;
        if (hostTurn !== undefined) row.hostTurn = hostTurn;
        this.#resets = keep([...this.#resets, row], USAGE_EVENTS_KEPT);
        this.#context = undefined;
        this.#compacting = false;
        break;
      }
      default:
        return false;
    }
    this.#at = at;
    return true;
  }

  #usage(e: BackendEventOf<'usage'>, hostTurn: number | undefined, at: number): boolean {
    this.#totals = structuredClone(e.cumulative);
    this.#costLabel = structuredClone(e.costLabel);
    if (e.turn !== undefined) {
      const row: TurnUsageRow = { usage: structuredClone(e.turn), at };
      if (hostTurn !== undefined) row.hostTurn = hostTurn;
      // One agent turn can report once per host turn; a second report for the same host turn
      // (a queued input run in the same host turn, D27) is its own row.
      this.#turns = keep([...this.#turns, row], USAGE_TURNS_KEPT);
    }
    this.#at = at;
    return true;
  }

  /** The agent's own context report (Claude: `getContextUsage`). */
  report(r: ContextUsage): ContextView | undefined {
    if (!(r.window > 0) || !(r.used >= 0)) return this.#context;
    const at = this.#now();
    const c: ContextView = {
      used: r.used,
      window: r.window,
      percent: r.percent !== undefined && Number.isFinite(r.percent) ? r.percent : percentOf(r.used, r.window),
      source: 'report',
      at,
    };
    if (r.autoCompactAt !== undefined) c.autoCompactAt = r.autoCompactAt;
    if (r.autoCompactEnabled !== undefined) c.autoCompactEnabled = r.autoCompactEnabled;
    if (r.categories !== undefined) c.categories = structuredClone(r.categories);
    else if (this.#context?.categories !== undefined && this.#context.used === r.used)
      c.categories = this.#context.categories;
    if (r.model !== undefined) c.model = r.model;
    this.#context = c;
    this.#at = at;
    return c;
  }

  /** The agent's usage control answer (D58, D60): totals, label, auth and limits. */
  snapshot(s: UsageSnapshot): void {
    this.#totals = structuredClone(s.totals);
    this.#costLabel = structuredClone(s.costLabel);
    if (s.auth !== undefined) this.#auth = structuredClone(s.auth);
    this.#limits = structuredClone(s.limits);
    this.#at = this.#now();
  }

  /** A turn ended: retries of its calls are over. */
  turnEnded(): boolean {
    if (this.#retries.length === 0) return false;
    this.#retries = [];
    return true;
  }

  get context(): ContextView | undefined {
    return this.#context === undefined ? undefined : structuredClone(this.#context);
  }

  view(): UsageView {
    const v: UsageView = {
      turns: structuredClone(this.#turns),
      compacting: this.#compacting,
      compactions: structuredClone(this.#compactions),
      retries: structuredClone(this.#retries),
      resets: structuredClone(this.#resets),
    };
    if (this.#totals !== undefined) v.totals = structuredClone(this.#totals);
    if (this.#costLabel !== undefined) v.costLabel = structuredClone(this.#costLabel);
    if (this.#auth !== undefined) v.auth = structuredClone(this.#auth);
    if (this.#limits !== undefined) v.limits = structuredClone(this.#limits);
    const last = this.#turns.at(-1);
    if (last !== undefined) v.lastTurn = structuredClone(last);
    if (this.#context !== undefined) v.context = structuredClone(this.#context);
    if (this.#at !== undefined) v.at = this.#at;
    return v;
  }

  /** The small part the session view carries, or undefined when nothing is known yet. */
  summary(): UsageSummary | undefined {
    if (this.#at === undefined) return undefined;
    const s: UsageSummary = { compacting: this.#compacting, at: this.#at };
    const c = this.#context;
    if (c !== undefined) {
      s.context = { used: c.used, window: c.window, percent: c.percent, source: c.source, at: c.at };
      if (c.autoCompactAt !== undefined) s.context.autoCompactAt = c.autoCompactAt;
    }
    const t = this.#totals;
    if (t !== undefined) {
      s.tokens = t.tokens.input + t.tokens.output + t.tokens.cacheRead + t.tokens.cacheWrite;
      s.costUsd = t.costUsd;
    }
    if (this.#costLabel !== undefined) s.costLabel = structuredClone(this.#costLabel);
    if (this.#limits?.available !== undefined) s.limitsAvailable = this.#limits.available;
    if (this.#limits?.blocked !== undefined) s.blocked = true;
    if (this.#limits?.available === true) {
      let top: PlanLimit | undefined;
      for (const l of this.#limits.limits)
        if (l.percent !== undefined && Number.isFinite(l.percent) && (top?.percent ?? -1) < l.percent) top = l;
      if (top !== undefined) {
        s.limit = { id: top.id, label: top.label, percent: top.percent as number };
        if (top.resetsAt !== undefined) s.limit.resetsAt = top.resetsAt;
        if (top.status !== undefined) s.limit.status = top.status;
      }
    }
    if (this.#auth !== undefined) s.auth = { kind: this.#auth.kind, label: this.#auth.label };
    const r = this.#retries.at(-1);
    if (r !== undefined) {
      s.retry = { attempt: r.attempt, error: r.error, at: r.at };
      if (r.maxRetries !== undefined) s.retry.maxRetries = r.maxRetries;
    }
    return s;
  }
}
