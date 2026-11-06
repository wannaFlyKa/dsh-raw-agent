// Usage, cost, context and plan-limit shapes (architecture §2.9, D57-D61, §7.2). Backend-neutral:
// no DSH and no agent-SDK imports. The backend fills them from its own reports; the DSH layer
// only shows them (rule 11: the numbers the agent reports, labelled honestly).

/** Token counts. Disjoint fields: input excludes cache reads and writes; reasoning is inside output. */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Thinking tokens, already counted in `output`. Absent when the agent does not report them. */
  reasoning?: number;
}

/**
 * How the agent priced a cost figure (D58). 'list': its built-in list price; 'managed': the
 * organisation's own pricing; 'unknown': no price matched, so the figure is a guess.
 */
export type CostBasis = 'list' | 'managed' | 'unknown';

/** One model's share of a total or of a turn. `model` is a display id (D61: no raw provider ids). */
export interface ModelUsageTotals {
  model: string;
  tokens: TokenCounts;
  costUsd: number;
  webSearches?: number;
  /** The model's context window, as the agent reports it. */
  contextWindow?: number;
  maxOutputTokens?: number;
  costBasis?: CostBasis;
  /** Who served the model, in the agent's words ('firstParty', 'bedrock', …). */
  provider?: string;
}

/** Running totals for one conversation (D58). Within one conversation they never go down. */
export interface UsageTotals {
  tokens: TokenCounts;
  costUsd: number;
  /** Time spent waiting for the model API. */
  apiDurationMs: number;
  models: ModelUsageTotals[];
  /** The least certain basis of the models' costs (unknown > managed > list). */
  costBasis: CostBasis;
}

/** What one turn used (D57, D58). */
export interface TurnUsage {
  /** Sum of the main thread's own model calls in this turn (one sample per call, D57). */
  main: TokenCounts;
  /** Everything else the agent counted for this turn: subagents, compaction, workflow agents. */
  other: TokenCounts;
  /** `main` + `other`: all tokens the agent counted for this turn. */
  total: TokenCounts;
  /** Main-thread model calls counted in `main`. */
  calls: number;
  costUsd: number;
  apiDurationMs: number;
  /** Wall time of the turn, as the agent reports it. */
  durationMs?: number;
  /** Time to the first token of the turn, as the agent reports it. */
  ttftMs?: number;
  models: ModelUsageTotals[];
  costBasis: CostBasis;
}

/**
 * How the user pays for the agent (R8.3). 'subscription': a plan with limits (Claude: a claude.ai
 * login); 'api-key': a pay-as-you-go key; 'bedrock' / 'vertex' / 'foundry': a cloud account;
 * 'cloud': another cloud provider; 'gateway': an enterprise gateway; 'unknown': not reported.
 */
export type AuthKind = 'subscription' | 'api-key' | 'bedrock' | 'vertex' | 'foundry' | 'cloud' | 'gateway' | 'unknown';

export interface AuthInfo {
  kind: AuthKind;
  /** Plain words for the UI ("Claude Max", "API key", "Amazon Bedrock"). */
  label: string;
  /** The agent's own provider word ('firstParty', 'bedrock', …). */
  provider?: string;
  /** The plan name ('pro', 'max', …), for subscriptions only. */
  subscriptionType?: string;
  /** Where the key came from, for API keys ('ANTHROPIC_API_KEY', 'apiKeyHelper', …). */
  apiKeySource?: string;
  /** When the login stops working (epoch ms), when the agent says so. */
  credentialExpiresAt?: number;
}

/** How to label a cost figure (D58). */
export interface CostLabel {
  /** Short words next to the amount: "estimate at list price", "API-equivalent", … */
  text: string;
  /** false: show the cost as a secondary figure (subscriptions: the plan limits matter more). */
  primary: boolean;
  /** One plain line on where the real bill is, if anywhere. */
  note?: string;
  /** Set when the figure may be wrong (no price matched the model). */
  warning?: string;
}

export type PlanLimitStatus = 'allowed' | 'allowed_warning' | 'rejected';

/** One plan window (D60). Only windows the agent reported; never a made-up 0 %. */
export interface PlanLimit {
  /** Stable key: 'five_hour', 'seven_day', 'seven_day_opus', 'model:<name>', 'extra_usage', … */
  id: string;
  label: string;
  /** Share of the window used, 0-100 (it can pass 100). Absent: not reported. */
  percent?: number;
  /** When the window resets (epoch ms). */
  resetsAt?: number;
  status?: PlanLimitStatus;
  /** Where the value came from: a live event or the agent's usage control. */
  source: 'event' | 'usage-api';
  /** When it was observed (epoch ms). */
  at: number;
}

/** The plan limits of the account (D60). */
export interface PlanLimits {
  /**
   * true: the account has plan limits and `limits` holds what is known. false: it has none (API
   * key, Bedrock, Vertex, …); show `note` and never a 0 % bar. undefined: not known yet.
   */
  available?: boolean;
  limits: PlanLimit[];
  /** The agent says requests are refused right now (a rejected limit), until `resetsAt`. */
  blocked?: { resetsAt?: number; limitId?: string };
  /** Extra (pay-per-use) usage beyond the plan, when the plan has it. */
  overage?: { status?: PlanLimitStatus; resetsAt?: number; disabledReason?: string; inUse?: boolean };
  /** Plain words when there is nothing to show ("No plan limits for this account"). */
  note?: string;
}

/** One row of the agent's own context breakdown (Claude: `/context`). Classify on `id`/`kind`. */
export interface ContextCategory {
  id?: string;
  name: string;
  tokens: number;
  kind?: 'used' | 'free' | 'buffer' | 'deferred';
  color?: string;
}

/** Everything the usage panel shows at one time (D59, D60). */
export interface UsageSnapshot {
  totals: UsageTotals;
  costLabel: CostLabel;
  auth?: AuthInfo;
  limits: PlanLimits;
  lastTurn?: TurnUsage;
  at: number;
}

export function zeroTokens(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  const out: TokenCounts = {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
  if (a.reasoning !== undefined || b.reasoning !== undefined) out.reasoning = (a.reasoning ?? 0) + (b.reasoning ?? 0);
  return out;
}

/** `a - b`, each field clamped at 0 (a count never goes negative). */
export function subtractTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  const out: TokenCounts = {
    input: Math.max(0, a.input - b.input),
    output: Math.max(0, a.output - b.output),
    cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
    cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite),
  };
  if (a.reasoning !== undefined) out.reasoning = Math.max(0, a.reasoning - (b.reasoning ?? 0));
  return out;
}

/** All tokens: input + output + cache read + cache write (reasoning is inside output). */
export function totalTokens(t: TokenCounts): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

export function isZeroTokens(t: TokenCounts): boolean {
  return totalTokens(t) === 0;
}

/** Tokens a call sent as context: input + cache read + cache write (the status-line formula, D59). */
export function contextTokens(t: TokenCounts): number {
  return t.input + t.cacheRead + t.cacheWrite;
}

/** Share of the context that came from the cache, 0-1. Undefined when nothing was sent. */
export function cacheHitRatio(t: TokenCounts): number | undefined {
  const sent = contextTokens(t);
  return sent > 0 ? t.cacheRead / sent : undefined;
}

const BASIS_RANK: Record<CostBasis, number> = { list: 0, managed: 1, unknown: 2 };

/** The least certain of some cost bases ('list' when there are none). */
export function worstCostBasis(bases: Iterable<CostBasis | undefined>): CostBasis {
  let worst: CostBasis = 'list';
  for (const b of bases) if (b !== undefined && BASIS_RANK[b] > BASIS_RANK[worst]) worst = b;
  return worst;
}
