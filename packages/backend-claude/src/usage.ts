// Usage, cost, context and plan limits for one Claude Code session (R8.1-R8.4; D57-D61, D70).
//
// Sources (CLI 2.1.318, SDK 0.3.318; docs/research/auth-usage.md; M5 probe `backend-usage`):
// - Per call (main thread): input and cache counts on `message_start`, the final output on
//   `message_delta` (the mapper builds the step's usage; the assistant frame's output is a
//   placeholder). Each call is counted once, by `message.id` (D57).
// - Per result: `modelUsage`, `total_cost_usd` and `duration_api_ms` are running totals of the
//   process (all agents). CLI 2.1.318 also sends the undeclared `model_usage_since_last_result`:
//   "Sum it over a conversation's results instead of subtracting modelUsage totals" (CLI binary).
//   We use it when present and difference the running totals otherwise (D9, D58).
// - `/clear`: a top-level `conversation_reset` frame, then the clear's own result with
//   `modelUsage: {}` and `total_cost_usd: 0`: the counters restart at 0 (live probe A).
// - Resume: the process restores the earlier totals before any turn (`cost-state` line); the
//   usage control returns them (live probe B2), so it is the baseline (D58).
// - Auth: `initializationResult().account.apiProvider` / `subscriptionType`, and
//   `system/init.apiKeySource` (live: Bedrock → `{apiProvider:'bedrock'}`, `apiKeySource:'none'`).
// - Plan limits: `rate_limit_event.rate_limit_info` (utilization is a FRACTION, resetsAt epoch
//   SECONDS; per-window `unifiedWindows` is @internal, CLI binary) and the usage control
//   (`rate_limits.*.utilization` is a PERCENT 0-100, `resets_at` ISO; SDK/sdk.d.ts:4433-4527).

import {
  addTokens,
  contextTokens,
  isZeroTokens,
  subtractTokens,
  worstCostBasis,
  zeroTokens,
  type AuthInfo,
  type BackendEvent,
  type ContextCategory,
  type ContextDetails,
  type ContextUsage,
  type CostBasis,
  type CostLabel,
  type ModelUsageTotals,
  type PlanLimit,
  type PlanLimitStatus,
  type PlanLimits,
  type TokenCounts,
  type TurnUsage,
  type UsageSnapshot,
  type UsageTotals,
} from '@dsh-raw-agent/core';
import { canonicalModel } from './model-id.js';
import { isObject, num, str } from './wire.js';

type Loose = Record<string, unknown>;

// ---- parsing ----

function costBasisOf(v: unknown): CostBasis | undefined {
  return v === 'list' || v === 'managed' || v === 'unknown' ? v : undefined;
}

/** One `ModelUsage` record (SDK/sdk.d.ts:1500-1533) in our shape. The display id never holds a raw key (D61). */
export function parseModelEntry(key: string, raw: unknown): ModelUsageTotals | undefined {
  if (!isObject(raw)) return undefined;
  const tokens: TokenCounts = {
    input: num(raw.inputTokens) ?? 0,
    output: num(raw.outputTokens) ?? 0,
    cacheRead: num(raw.cacheReadInputTokens) ?? 0,
    cacheWrite: num(raw.cacheCreationInputTokens) ?? 0,
  };
  const thinking = num(raw.thinkingTokens);
  if (thinking !== undefined) tokens.reasoning = thinking;
  const m: ModelUsageTotals = {
    model: canonicalModel(str(raw.canonicalModel) ?? key) ?? key,
    tokens,
    costUsd: num(raw.costUSD) ?? 0,
  };
  const web = num(raw.webSearchRequests);
  if (web !== undefined) m.webSearches = web;
  const window = num(raw.contextWindow);
  if (window !== undefined && window > 0) m.contextWindow = window;
  const maxOut = num(raw.maxOutputTokens);
  if (maxOut !== undefined && maxOut > 0) m.maxOutputTokens = maxOut;
  const basis = costBasisOf(raw.costBasis);
  if (basis !== undefined) m.costBasis = basis;
  const provider = str(raw.provider);
  if (provider !== undefined) m.provider = provider;
  return m;
}

function mergeModel(a: ModelUsageTotals, b: ModelUsageTotals): ModelUsageTotals {
  const out: ModelUsageTotals = { ...a, ...b, tokens: addTokens(a.tokens, b.tokens), costUsd: a.costUsd + b.costUsd };
  if (a.webSearches !== undefined || b.webSearches !== undefined)
    out.webSearches = (a.webSearches ?? 0) + (b.webSearches ?? 0);
  // The latest request's fields win (CLI: "costBasis, canonicalModel and provider are the latest request's").
  const basis = b.costBasis ?? a.costBasis;
  if (basis !== undefined) out.costBasis = basis;
  else delete out.costBasis;
  return out;
}

/** A `modelUsage`-shaped record → models by display id. Undefined when it is not an object. */
export function parseModelUsage(raw: unknown): Map<string, ModelUsageTotals> | undefined {
  if (!isObject(raw)) return undefined;
  const out = new Map<string, ModelUsageTotals>();
  for (const [key, value] of Object.entries(raw)) {
    const m = parseModelEntry(key, value);
    if (m === undefined) continue;
    const prev = out.get(m.model);
    out.set(m.model, prev === undefined ? m : mergeModel(prev, m));
  }
  return out;
}

function sumModels(models: Iterable<ModelUsageTotals>): { tokens: TokenCounts; costUsd: number } {
  let tokens = zeroTokens();
  let costUsd = 0;
  for (const m of models) {
    tokens = addTokens(tokens, m.tokens);
    costUsd += m.costUsd;
  }
  return { tokens, costUsd };
}

/** `a - b` per model (counts clamped at 0). Models only in `b` are left out. */
function subtractModels(
  a: Map<string, ModelUsageTotals>,
  b: Map<string, ModelUsageTotals>,
): Map<string, ModelUsageTotals> {
  const out = new Map<string, ModelUsageTotals>();
  for (const [k, m] of a) {
    const p = b.get(k);
    if (p === undefined) {
      out.set(k, m);
      continue;
    }
    const d: ModelUsageTotals = {
      ...m,
      tokens: subtractTokens(m.tokens, p.tokens),
      costUsd: Math.max(0, m.costUsd - p.costUsd),
    };
    if (m.webSearches !== undefined) d.webSearches = Math.max(0, m.webSearches - (p.webSearches ?? 0));
    if (!isZeroTokens(d.tokens) || d.costUsd > 0) out.set(k, d);
  }
  return out;
}

const AUTH_PROVIDERS: Record<string, { kind: AuthInfo['kind']; label: string }> = {
  bedrock: { kind: 'bedrock', label: 'Amazon Bedrock' },
  vertex: { kind: 'vertex', label: 'Google Vertex AI' },
  foundry: { kind: 'foundry', label: 'Microsoft Foundry' },
  anthropicAws: { kind: 'cloud', label: 'Anthropic on AWS' },
  anthropicGoogleCloud: { kind: 'cloud', label: 'Anthropic on Google Cloud' },
  mantle: { kind: 'cloud', label: 'Mantle' },
  gateway: { kind: 'gateway', label: 'Claude apps gateway' },
};

/**
 * The auth type from the live process (R8.3): `account` from `initializationResult()` /
 * `accountInfo()` (SDK/sdk.d.ts:23-33) and `system/init.apiKeySource` (SDK/sdk.d.ts:133-135).
 * Email and organisation are never copied.
 */
export function authFromAccount(account: unknown, apiKeySource?: string): AuthInfo {
  const a = isObject(account) ? account : {};
  const provider = str(a.apiProvider);
  const known = provider === undefined ? undefined : AUTH_PROVIDERS[provider];
  if (known !== undefined) return { kind: known.kind, label: known.label, provider: provider! };
  const out: AuthInfo = { kind: 'unknown', label: 'Unknown account' };
  if (provider !== undefined) out.provider = provider;
  const sub = str(a.subscriptionType);
  const source = str(a.apiKeySource) ?? apiKeySource;
  if (sub !== undefined && sub !== '') {
    out.kind = 'subscription';
    out.label = `Claude ${sub.charAt(0).toUpperCase()}${sub.slice(1)}`;
    out.subscriptionType = sub;
  } else if (source !== undefined && source !== 'none') {
    out.kind = 'api-key';
    out.label = 'API key';
    out.apiKeySource = source;
  } else if (provider === 'firstParty') out.label = 'Anthropic account';
  else if (provider !== undefined) {
    out.kind = 'cloud';
    out.label = provider;
  }
  return out;
}

const CLOUD_BILL: Partial<Record<AuthInfo['kind'], string>> = {
  bedrock: 'Your bill is in your AWS account.',
  vertex: 'Your bill is in your Google Cloud account.',
  foundry: 'Your bill is in your Azure account.',
  cloud: 'Your bill is with your cloud provider.',
  gateway: 'Your organisation’s gateway decides what is billed.',
  'api-key': 'Your bill is in your Anthropic Console account.',
};

/** D58: how to label the cost for this account and price basis. */
export function costLabelFor(auth: AuthInfo | undefined, basis: CostBasis): CostLabel {
  const warning = basis === 'unknown' ? 'No price matched this model, so the figure is a guess.' : undefined;
  let label: CostLabel;
  if (auth?.kind === 'subscription')
    label = {
      text: 'API-equivalent',
      primary: false,
      note: 'Not a bill: your plan covers this use. Your plan limits are what count.',
    };
  else if (basis === 'managed')
    label = { text: 'managed price', primary: true, note: 'Priced at your organisation’s own rates.' };
  else if (basis === 'unknown') label = { text: 'unknown price', primary: true };
  else {
    label = { text: 'estimate at list price', primary: true };
    const note = auth === undefined ? undefined : CLOUD_BILL[auth.kind];
    if (note !== undefined) label.note = note;
  }
  if (warning !== undefined) label.warning = warning;
  return label;
}

const LIMIT_LABELS: Record<string, string> = {
  five_hour: '5-hour limit',
  seven_day: 'Weekly limit',
  seven_day_opus: 'Weekly limit (Opus)',
  seven_day_sonnet: 'Weekly limit (Sonnet)',
  seven_day_oauth_apps: 'Weekly limit (apps)',
  seven_day_overage_included: 'Weekly limit (extra usage included)',
  overage: 'Extra usage',
  extra_usage: 'Extra usage',
};

function limitLabel(id: string): string {
  if (id.startsWith('model:')) return `Weekly limit (${id.slice(6)})`;
  return LIMIT_LABELS[id] ?? id.replace(/_/g, ' ');
}

function statusOf(v: unknown): PlanLimitStatus | undefined {
  return v === 'allowed' || v === 'allowed_warning' || v === 'rejected' ? v : undefined;
}

/** What one `rate_limit_event` says (SDK/sdk.d.ts:5959-5996; `unifiedWindows` from the CLI binary). */
export interface RateLimitReport {
  limits: PlanLimit[];
  status?: PlanLimitStatus;
  rateLimitType?: string;
  resetsAt?: number;
  overage?: PlanLimits['overage'];
}

export function parseRateLimitInfo(info: unknown, at: number): RateLimitReport | undefined {
  if (!isObject(info)) return undefined;
  const report: RateLimitReport = { limits: [] };
  const status = statusOf(info.status);
  if (status !== undefined) report.status = status;
  const type = str(info.rateLimitType);
  if (type !== undefined) report.rateLimitType = type;
  const resetsAtS = num(info.resetsAt);
  if (resetsAtS !== undefined) report.resetsAt = resetsAtS * 1000;
  const seen = new Set<string>();
  if (isObject(info.unifiedWindows))
    for (const [id, w] of Object.entries(info.unifiedWindows)) {
      if (!isObject(w)) continue;
      const u = num(w.utilization);
      if (u === undefined) continue;
      const limit: PlanLimit = { id, label: limitLabel(id), percent: u * 100, source: 'event', at };
      const r = num(w.resetsAt);
      if (r !== undefined) limit.resetsAt = r * 1000;
      const s = statusOf(w.status);
      if (s !== undefined) limit.status = s;
      report.limits.push(limit);
      seen.add(id);
    }
  const u = num(info.utilization);
  if (type !== undefined && !seen.has(type) && (u !== undefined || (status !== undefined && status !== 'allowed'))) {
    const limit: PlanLimit = { id: type, label: limitLabel(type), source: 'event', at };
    if (u !== undefined) limit.percent = u * 100;
    if (report.resetsAt !== undefined) limit.resetsAt = report.resetsAt;
    if (status !== undefined) limit.status = status;
    report.limits.push(limit);
  }
  const overage: NonNullable<PlanLimits['overage']> = {};
  const os = statusOf(info.overageStatus);
  if (os !== undefined) overage.status = os;
  const or = num(info.overageResetsAt);
  if (or !== undefined) overage.resetsAt = or * 1000;
  const reason = str(info.overageDisabledReason);
  if (reason !== undefined) overage.disabledReason = reason;
  if (typeof info.isUsingOverage === 'boolean') overage.inUse = info.isUsingOverage;
  if (Object.keys(overage).length > 0) report.overage = overage;
  return report;
}

/** The usage control's answer (SDK/sdk.d.ts:4433-4527): plan windows in percent, ISO resets. */
export function parseUsageLimits(resp: unknown, at: number): { available: boolean; limits: PlanLimit[] } | undefined {
  if (!isObject(resp) || typeof resp.rate_limits_available !== 'boolean') return undefined;
  const limits: PlanLimit[] = [];
  const rl = isObject(resp.rate_limits) ? resp.rate_limits : undefined;
  const push = (id: string, w: unknown) => {
    if (!isObject(w)) return;
    const percent = num(w.utilization);
    if (percent === undefined) return; // never a made-up 0 % (D60)
    const limit: PlanLimit = { id, label: limitLabel(id), percent, source: 'usage-api', at };
    const resets = str(w.resets_at);
    const t = resets === undefined ? NaN : Date.parse(resets);
    if (Number.isFinite(t)) limit.resetsAt = t;
    limits.push(limit);
  };
  if (rl !== undefined) {
    for (const id of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps'])
      push(id, rl[id]);
    if (Array.isArray(rl.model_scoped))
      for (const w of rl.model_scoped) if (isObject(w) && str(w.display_name)) push(`model:${str(w.display_name)}`, w);
    const extra = rl.extra_usage;
    if (isObject(extra) && extra.is_enabled === true) push('extra_usage', extra);
  }
  return { available: resp.rate_limits_available, limits };
}

/** `getContextUsage` (SDK/sdk.d.ts:4099-4227) in our shape. */
export function parseContextUsage(r: unknown): ContextUsage {
  const raw = isObject(r) ? r : {};
  // The control answers in camelCase (live M5 probe A); the `/context` local command's twin on
  // its synthetic message is snake_case (`context_usage`, probe5; `SDK/sdk.d.ts:4099`).
  const used = num(raw.totalTokens) ?? num(raw.total_tokens) ?? 0;
  const window = num(raw.maxTokens) ?? num(raw.raw_max_tokens) ?? num(raw.rawMaxTokens) ?? 0;
  const out: ContextUsage = { used, window };
  const auto = num(raw.autoCompactThreshold);
  if (auto !== undefined) out.autoCompactAt = auto;
  if (typeof raw.isAutoCompactEnabled === 'boolean') out.autoCompactEnabled = raw.isAutoCompactEnabled;
  const pct = num(raw.percentage);
  if (pct !== undefined) out.percent = pct;
  const model = canonicalModel(str(raw.model));
  if (model !== undefined) out.model = model;
  if (Array.isArray(raw.categories)) {
    const cats: ContextCategory[] = [];
    for (const c of raw.categories) {
      if (!isObject(c)) continue;
      const name = str(c.name);
      const tokens = num(c.tokens);
      if (name === undefined || tokens === undefined) continue;
      const cat: ContextCategory = { name, tokens };
      const id = str(c.id);
      if (id !== undefined) cat.id = id;
      const kind = c.kind;
      if (kind === 'used' || kind === 'free' || kind === 'buffer' || kind === 'deferred') cat.kind = kind;
      else if (c.isDeferred === true) cat.kind = 'deferred';
      const color = str(c.color);
      if (color !== undefined) cat.color = color;
      cats.push(cat);
    }
    out.categories = cats;
  }
  const details = parseContextDetails(raw);
  if (details !== undefined) out.details = details;
  return out;
}

/** R7.2: the item tables of `/context`, from either answer shape. Paths and ids beyond these are dropped. */
function parseContextDetails(raw: Record<string, unknown>): ContextDetails | undefined {
  const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObject) : []);
  const d: ContextDetails = {};
  const mcp = rows(raw.mcpTools ?? raw.mcp_tools).flatMap((t) => {
    const name = str(t.name);
    const server = str(t.serverName) ?? str(t.server_name);
    const tokens = num(t.tokens);
    return name !== undefined && server !== undefined && tokens !== undefined ? [{ name, server, tokens }] : [];
  });
  if (mcp.length > 0) d.mcpTools = mcp;
  const memory = rows(raw.memoryFiles ?? raw.memory_files).flatMap((f) => {
    const path = str(f.path);
    const type = str(f.type);
    const tokens = num(f.tokens);
    return path !== undefined && type !== undefined && tokens !== undefined ? [{ path, type, tokens }] : [];
  });
  if (memory.length > 0) d.memoryFiles = memory;
  const agents = rows(raw.agents).flatMap((a) => {
    const name = str(a.agentType) ?? str(a.agent_type);
    const source = str(a.source);
    const tokens = num(a.tokens);
    return name !== undefined && source !== undefined && tokens !== undefined ? [{ name, source, tokens }] : [];
  });
  if (agents.length > 0) d.agents = agents;
  // The control nests the rows (`skills.skillFrontmatter`); the twin lists them directly.
  const skillRows = Array.isArray(raw.skills) ? raw.skills : isObject(raw.skills) ? raw.skills.skillFrontmatter : [];
  const skills = rows(skillRows).flatMap((s) => {
    const name = str(s.name);
    const source = str(s.source);
    const tokens = num(s.tokens);
    if (name === undefined || source === undefined || tokens === undefined) return [];
    const row: NonNullable<ContextDetails['skills']>[number] = { name, source, tokens };
    const plugin = str(s.pluginName) ?? str(s.plugin_name);
    if (plugin !== undefined) row.plugin = plugin;
    return [row];
  });
  if (skills.length > 0) d.skills = skills;
  return Object.keys(d).length > 0 ? d : undefined;
}

// ---- the ledger ----

interface Cumulative {
  models: Map<string, ModelUsageTotals>;
  costUsd: number;
  apiDurationMs: number;
}

function zeroCumulative(): Cumulative {
  return { models: new Map(), costUsd: 0, apiDurationMs: 0 };
}

export interface UsageLedgerOptions {
  now?: () => number;
  /**
   * 'new': the process counters start at 0. Otherwise (resume, fork) the process restores earlier
   * totals; until the baseline is read, the first result's running totals cannot be differenced.
   */
  startedAs?: 'new' | 'resumed' | 'forked';
}

/**
 * Turns the CLI's usage reports into honest per-call, per-turn and per-conversation numbers
 * (D57, D58, D60, D70). Pure: it holds no process; the mapper and the session feed it.
 */
export class UsageLedger {
  readonly #now: () => number;
  /** The conversation's running totals (D58): baseline + every counted delta; reset on D70. */
  #conv: Cumulative = zeroCumulative();
  /** The process's last running totals (to difference when the CLI sends no delta). */
  #prev: Cumulative | undefined;
  /** Main-thread calls since the last result (D57). */
  #main: TokenCounts = zeroTokens();
  #calls = 0;
  readonly #counted = new Set<string>();
  #resultSeen = false;
  #resetPending = false;
  #lastTurn: TurnUsage | undefined;
  #account: unknown;
  #apiKeySource: string | undefined;
  #credentialExpiresAt: number | undefined;
  #auth: AuthInfo | undefined;
  #authKey: string | undefined;
  readonly #windows = new Map<string, number>();
  #ctx: { window: number; autoCompactAt?: number; model?: string } | undefined;
  #lastContext: { used: number; window: number } | undefined;
  #limits: PlanLimits = { limits: [] };
  #limitsKey = '';

  constructor(options: UsageLedgerOptions = {}) {
    this.#now = options.now ?? Date.now;
    if ((options.startedAs ?? 'new') === 'new') this.#prev = zeroCumulative();
  }

  // ---- reads ----

  totals(): UsageTotals {
    return this.#totalsOf(this.#conv);
  }

  get lastTurn(): TurnUsage | undefined {
    return this.#lastTurn;
  }

  get auth(): AuthInfo | undefined {
    return this.#auth;
  }

  costLabel(): CostLabel {
    return costLabelFor(this.#auth, worstCostBasis([...this.#conv.models.values()].map((m) => m.costBasis)));
  }

  limits(): PlanLimits {
    const now = this.#now();
    // A window past its reset time says nothing about now: drop it (status-line rule).
    const limits = this.#limits.limits.filter((l) => l.resetsAt === undefined || l.resetsAt > now);
    const out: PlanLimits = { ...this.#limits, limits };
    if (out.blocked?.resetsAt !== undefined && out.blocked.resetsAt <= now) delete out.blocked;
    if (out.available === false && out.note === undefined)
      out.note = `No plan limits for this account${this.#auth ? ` (${this.#auth.label})` : ''}.`;
    return out;
  }

  snapshot(): UsageSnapshot {
    const s: UsageSnapshot = {
      totals: this.totals(),
      costLabel: this.costLabel(),
      limits: this.limits(),
      at: this.#now(),
    };
    if (this.#auth !== undefined) s.auth = this.#auth;
    if (this.#lastTurn !== undefined) s.lastTurn = this.#lastTurn;
    return s;
  }

  // ---- inputs ----

  /**
   * One main-thread model call's final usage (D57), once per `message.id`. Returns the `context`
   * event for it when the model's window is known.
   */
  mainCall(messageId: string, usage: TokenCounts, model?: string): BackendEvent[] {
    if (this.#counted.has(messageId)) return [];
    this.#counted.add(messageId);
    this.#main = addTokens(this.#main, usage);
    this.#calls++;
    return this.#context(contextTokens(usage), model);
  }

  /** `initializationResult().account` / `accountInfo()`. */
  account(account: unknown): BackendEvent[] {
    this.#account = account;
    return this.#authChanged();
  }

  /** `system/init.apiKeySource`. */
  apiKeySource(source: string | undefined): BackendEvent[] {
    if (source === undefined || source === this.#apiKeySource) return [];
    this.#apiKeySource = source;
    return this.#authChanged();
  }

  /**
   * The usage control's answer. Before the first result of this process it is the baseline
   * (resumed totals, D58); its plan windows always update the limits (D60).
   */
  usageControl(resp: unknown): BackendEvent[] {
    const out: BackendEvent[] = [];
    if (!isObject(resp)) return out;
    const session = isObject(resp.session) ? resp.session : undefined;
    const models = parseModelUsage(session?.model_usage);
    if (session !== undefined && models !== undefined && !this.#resultSeen) {
      const base: Cumulative = {
        models,
        costUsd: num(session.total_cost_usd) ?? sumModels(models.values()).costUsd,
        apiDurationMs: num(session.total_api_duration_ms) ?? 0,
      };
      this.#prev = base;
      this.#conv = { models: new Map(models), costUsd: base.costUsd, apiDurationMs: base.apiDurationMs };
      this.#noteWindows(models);
      if (models.size > 0) out.push(this.#usageEvent());
    }
    const sub = str(resp.subscription_type);
    if (sub !== undefined && sub !== '' && this.#auth?.kind !== 'subscription') {
      this.#account = { ...(isObject(this.#account) ? this.#account : {}), subscriptionType: sub };
      out.push(...this.#authChanged());
    }
    const parsed = parseUsageLimits(resp, this.#now());
    if (parsed !== undefined) {
      const next: PlanLimits = { ...this.#limits, available: parsed.available };
      if (!parsed.available) next.limits = [];
      else {
        const byId = new Map(this.#limits.limits.map((l) => [l.id, l]));
        for (const l of parsed.limits) byId.set(l.id, l);
        next.limits = [...byId.values()];
      }
      this.#limits = next;
      out.push(...this.#limitsChanged());
    }
    return out;
  }

  /** `rate_limit_event` (D60): live plan windows. Only plan accounts get one. */
  rateLimit(info: unknown): BackendEvent[] {
    const report = parseRateLimitInfo(info, this.#now());
    if (report === undefined) return [];
    const byId = new Map(this.#limits.limits.map((l) => [l.id, l]));
    for (const l of report.limits) byId.set(l.id, { ...byId.get(l.id), ...l });
    const next: PlanLimits = { ...this.#limits, available: true, limits: [...byId.values()] };
    delete next.note;
    if (report.status === 'rejected') {
      next.blocked = {};
      if (report.resetsAt !== undefined) next.blocked.resetsAt = report.resetsAt;
      if (report.rateLimitType !== undefined) next.blocked.limitId = report.rateLimitType;
    } else delete next.blocked;
    if (report.overage !== undefined) next.overage = report.overage;
    this.#limits = next;
    return this.#limitsChanged();
  }

  /** `getContextUsage` answered: the window and auto-compact point for later `context` events. */
  contextReport(c: ContextUsage): void {
    if (c.window <= 0) return;
    this.#ctx = { window: c.window };
    if (c.autoCompactAt !== undefined) this.#ctx.autoCompactAt = c.autoCompactAt;
    if (c.model !== undefined) this.#ctx.model = c.model;
  }

  /** A compaction finished: the context is now `postTokens` (D59). */
  compacted(postTokens: number | undefined): BackendEvent[] {
    if (postTokens === undefined) return [];
    return this.#context(postTokens, this.#ctx?.model);
  }

  /**
   * D70: the conversation was reset. The CLI's counters restart at 0. After `/clear` the clear's
   * own result still states calls counted before it, so that reset applies after that result.
   */
  conversationReset(trigger: string | undefined): BackendEvent[] {
    if (trigger === 'clear') {
      this.#resetPending = true;
      return [];
    }
    return this.#applyReset();
  }

  /** A `result` frame. Returns the `usage` event (before the turn's end), if anything changed. */
  result(msg: Loose): BackendEvent[] {
    const out: BackendEvent[] = [];
    const cumulative = parseModelUsage(msg.modelUsage);
    const sinceRaw = msg.model_usage_since_last_result;
    const since = parseModelUsage(sinceRaw);
    const cost = num(msg.total_cost_usd);
    const apiMs = num(msg.duration_api_ms);
    const expires = str(msg.credential_expires_at);
    if (expires !== undefined) {
      const t = Date.parse(expires);
      if (Number.isFinite(t) && t !== this.#credentialExpiresAt) {
        this.#credentialExpiresAt = t;
        out.push(...this.#authChanged());
      }
    }
    const zeroed =
      msg.subtype !== 'success' &&
      cumulative !== undefined &&
      cumulative.size === 0 &&
      (cost ?? 0) === 0 &&
      this.#prev !== undefined &&
      this.#prev.costUsd > 0 &&
      !this.#resetPending;
    if (cumulative === undefined || zeroed) {
      // A crash or start-up result with zeros: keep the last good totals (auth-usage answer 8).
      this.#main = zeroTokens();
      this.#calls = 0;
      return out;
    }
    const local = str(msg.local_command) !== undefined;
    // A local command's result (`/context`, `/compact`, `/clear`) says `duration_api_ms: 0`, but the
    // next real result is again the process's running total (M5 verify). So a lower figure on a local
    // result is not a counter restart: keep the last total.
    const prevApi = this.#prev?.apiDurationMs;
    const keepApi = prevApi !== undefined && (apiMs === undefined || (local && apiMs < prevApi));
    const now: Cumulative = {
      models: cumulative,
      costUsd: cost ?? sumModels(cumulative.values()).costUsd,
      apiDurationMs: keepApi ? prevApi : (apiMs ?? 0),
    };
    this.#noteWindows(cumulative);
    let delta: Map<string, ModelUsageTotals> | undefined;
    if (since !== undefined) delta = since;
    else if (this.#prev !== undefined) delta = subtractModels(now.models, this.#prev.models);
    let deltaCost: number | undefined;
    if (since !== undefined) deltaCost = sumModels(since.values()).costUsd;
    else if (this.#prev !== undefined) deltaCost = Math.max(0, now.costUsd - this.#prev.costUsd);
    let apiDelta = 0;
    if (this.#prev !== undefined)
      apiDelta =
        now.apiDurationMs >= this.#prev.apiDurationMs
          ? now.apiDurationMs - this.#prev.apiDurationMs
          : now.apiDurationMs;

    let turn: TurnUsage | undefined;
    if (delta !== undefined) {
      for (const [k, m] of delta) {
        const c = this.#conv.models.get(k);
        this.#conv.models.set(k, c === undefined ? m : mergeModel(c, m));
      }
      this.#conv.costUsd += deltaCost ?? 0;
      this.#conv.apiDurationMs += apiDelta;
      let total = sumModels(delta.values()).tokens;
      // The main calls are part of the total; a lower total (lost delta) never makes "other" negative.
      total = {
        ...total,
        input: Math.max(total.input, this.#main.input),
        output: Math.max(total.output, this.#main.output),
        cacheRead: Math.max(total.cacheRead, this.#main.cacheRead),
        cacheWrite: Math.max(total.cacheWrite, this.#main.cacheWrite),
      };
      turn = {
        main: this.#main,
        other: subtractTokens(total, this.#main),
        total,
        calls: this.#calls,
        costUsd: deltaCost ?? 0,
        apiDurationMs: apiDelta,
        models: [...delta.values()],
        costBasis: worstCostBasis([...delta.values()].map((m) => m.costBasis)),
      };
      const d = num(msg.duration_ms);
      if (d !== undefined) turn.durationMs = d;
      const ttft = num(msg.ttft_ms);
      if (ttft !== undefined) turn.ttftMs = ttft;
    } else {
      // Resumed or forked with no baseline: the process's totals are the conversation's; this
      // turn alone cannot be told apart, so no turn figure (never a wrong one).
      this.#conv = { models: new Map(now.models), costUsd: now.costUsd, apiDurationMs: now.apiDurationMs };
    }
    this.#prev = now;
    this.#resultSeen = true;
    this.#main = zeroTokens();
    this.#calls = 0;
    const counted = turn !== undefined && (!isZeroTokens(turn.total) || turn.costUsd > 0);
    if (turn !== undefined && (counted || !local)) {
      this.#lastTurn = turn;
      out.push(this.#usageEvent(turn));
    } else if (turn === undefined) out.push(this.#usageEvent());
    if (this.#resetPending) out.push(...this.#applyReset());
    return out;
  }

  // ---- internals ----

  #applyReset(): BackendEvent[] {
    this.#resetPending = false;
    this.#conv = zeroCumulative();
    this.#prev = zeroCumulative();
    this.#main = zeroTokens();
    this.#calls = 0;
    this.#lastTurn = undefined;
    this.#lastContext = undefined;
    return [this.#usageEvent()];
  }

  #totalsOf(c: Cumulative): UsageTotals {
    const models = [...c.models.values()];
    return {
      tokens: sumModels(models).tokens,
      costUsd: c.costUsd,
      apiDurationMs: c.apiDurationMs,
      models,
      costBasis: worstCostBasis(models.map((m) => m.costBasis)),
    };
  }

  #usageEvent(turn?: TurnUsage): BackendEvent {
    const e: Extract<BackendEvent, { type: 'usage' }> = {
      type: 'usage',
      cumulative: this.totals(),
      costLabel: this.costLabel(),
    };
    if (turn !== undefined) e.turn = turn;
    return e;
  }

  #noteWindows(models: Map<string, ModelUsageTotals>): void {
    for (const m of models.values()) if (m.contextWindow !== undefined) this.#windows.set(m.model, m.contextWindow);
  }

  #context(used: number, model: string | undefined): BackendEvent[] {
    const window =
      (model === undefined ? undefined : this.#windows.get(model)) ??
      (this.#ctx !== undefined && (model === undefined || this.#ctx.model === undefined || this.#ctx.model === model)
        ? this.#ctx.window
        : undefined) ??
      (this.#windows.size === 1 ? [...this.#windows.values()][0] : undefined);
    if (window === undefined || window <= 0) return [];
    if (this.#lastContext?.used === used && this.#lastContext.window === window) return [];
    this.#lastContext = { used, window };
    const e: Extract<BackendEvent, { type: 'context' }> = { type: 'context', used, window };
    if (this.#ctx?.autoCompactAt !== undefined && this.#ctx.window === window)
      e.autoCompactAt = this.#ctx.autoCompactAt;
    return [e];
  }

  #authChanged(): BackendEvent[] {
    if (this.#account === undefined && this.#apiKeySource === undefined) return [];
    const auth = authFromAccount(this.#account, this.#apiKeySource);
    if (this.#credentialExpiresAt !== undefined) auth.credentialExpiresAt = this.#credentialExpiresAt;
    const key = JSON.stringify(auth);
    if (key === this.#authKey) return [];
    this.#authKey = key;
    this.#auth = auth;
    if (
      auth.kind !== 'subscription' &&
      auth.kind !== 'gateway' &&
      auth.kind !== 'unknown' &&
      this.#limits.available === undefined
    ) {
      // API key and cloud accounts have no plan limits (D60); the usage control confirms it.
      this.#limits = { ...this.#limits, available: false };
    }
    return [{ type: 'auth', auth, costLabel: this.costLabel() }, ...this.#limitsChanged()];
  }

  #limitsChanged(): BackendEvent[] {
    const limits = this.limits();
    const key = JSON.stringify({ ...limits, limits: limits.limits.map((l) => ({ ...l, at: 0 })) });
    if (key === this.#limitsKey) return [];
    this.#limitsKey = key;
    return [{ type: 'limits', limits }];
  }
}
