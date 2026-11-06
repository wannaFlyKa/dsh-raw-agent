// Pure view logic for the context pill and the usage panel (R8.1-R8.4; D57-D61, D70). No React,
// no DSH. Every number shown is one the agent reported; a number the agent did not report is
// named as "not reported", never shown as 0 (rule 11).

import {
  cacheHitRatio,
  totalTokens,
  type CostLabel,
  type ModelUsageTotals,
  type TokenCounts,
} from '@dsh-raw-agent/core';
import { formatDuration } from './agents-model.js';
import type {
  ChildWire,
  ContextViewWire,
  SessionInfo,
  TurnUsageRowWire,
  UsageAnswerWire,
  UsageSummaryWire,
  UsageViewWire,
  WorkflowWire,
} from './api.js';
import { workflowTokens } from './workflow-model.js';

// ---- number formats ----

/** 950 → "950", 19_717 → "19.7k", 200_000 → "200k", 1_000_000 → "1M". */
export function formatCount(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const trim = (x: number) => String(Math.round(x * 10) / 10);
  if (a < 1000) return String(Math.round(n));
  if (a < 1_000_000) return `${a < 100_000 ? trim(n / 1000) : Math.round(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}

/** Exact count with thousands separators ("19,717"). */
export function exactCount(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** US dollars: small amounts keep 4 decimals, so a cheap turn does not read "$0.00". */
export function formatUsd(x: number | undefined): string {
  if (x === undefined || !Number.isFinite(x)) return '—';
  if (x === 0) return '$0.00';
  if (Math.abs(x) < 0.1) return `$${x.toFixed(4).replace(/0{1,2}$/, '')}`;
  if (Math.abs(x) < 100) return `$${x.toFixed(2)}`;
  return `$${Math.round(x)}`;
}

/** "in 2 h 5 min", "in 40 s", "now". */
export function formatIn(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  if (ms < 60_000) return `in ${Math.max(1, Math.round(ms / 1000))} s`;
  const min = Math.round(ms / 60_000);
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 === 0 ? `in ${h} h` : `in ${h} h ${min % 60} min`;
  return `in ${Math.round(h / 24)} days`;
}

/** A local clock time for a reset ("Mon 14:00"). */
export function formatClock(at: number): string {
  try {
    return new Date(at).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  } catch {
    return new Date(at).toISOString();
  }
}

/** "resets in 2 h 5 min (Mon 14:00)"; undefined when the agent gave no reset time. */
export function resetText(resetsAt: number | undefined, now: number): string | undefined {
  if (resetsAt === undefined || !Number.isFinite(resetsAt)) return undefined;
  return `resets ${formatIn(resetsAt - now)} (${formatClock(resetsAt)})`;
}

// ---- the context figure ----

/** The newer of the pill's summary figure and a report read from the context route. */
export function latestContext<T extends { at: number }>(...list: Array<T | undefined>): T | undefined {
  let best: T | undefined;
  for (const c of list) if (c !== undefined && (best === undefined || c.at >= best.at)) best = c;
  return best;
}

export type PillLevel = 'unknown' | 'ok' | 'warn' | 'high' | 'busy';

export interface ContextPillModel {
  /** "Context 12% · 24k/200k", or "Context —" when the agent has not reported it. */
  text: string;
  /** Short extras after the reading: plan window or cost, retry, limit reached, background. */
  extras: string[];
  /** The tooltip: what the numbers are and where they came from. */
  title: string;
  percent?: number;
  level: PillLevel;
  /** No process runs: the pill offers "Start <name>" (D4). */
  startable: boolean;
  /** Background tasks of the process still run (the session itself is free, rule 7). */
  background: number;
}

/** Share at which the pill turns amber (of the window) when no auto-compact point is known. */
export const CONTEXT_WARN_PERCENT = 70;
/** Share of the auto-compact point at which the pill turns red ("compacts soon"). */
export const CONTEXT_HIGH_OF_COMPACT = 0.9;

function contextLevel(c: Pick<ContextViewWire, 'used' | 'window' | 'percent' | 'autoCompactAt'>): PillLevel {
  if (c.autoCompactAt !== undefined && c.autoCompactAt > 0) {
    if (c.used >= c.autoCompactAt * CONTEXT_HIGH_OF_COMPACT) return 'high';
    if (c.used >= c.autoCompactAt * 0.75) return 'warn';
    return 'ok';
  }
  if (c.percent >= 90) return 'high';
  return c.percent >= CONTEXT_WARN_PERCENT ? 'warn' : 'ok';
}

const sourceNote = (source: ContextViewWire['source'], name: string): string =>
  source === 'report'
    ? `${name}'s own context report.`
    : source === 'compaction'
      ? `After the last compaction (${name}'s figure). The breakdown refills at the next report.`
      : `From the last model call (input + cache read + cache write), as ${name}'s status line counts it.`;

/** Percent text with one decimal below 10 % ("2.4%"), whole above ("42%"). */
export function percentText(p: number): string {
  if (!Number.isFinite(p)) return '—';
  return p < 10 ? `${Math.round(p * 10) / 10}%` : `${Math.round(p)}%`;
}

/**
 * The composer pill (D59). It replaces DSH's own context ring in our sessions (that ring stays
 * hidden: we never write `request/context`). `report` is a context route answer, if one was read.
 */
export function contextPill(info: SessionInfo, report?: ContextViewWire, now: number = Date.now()): ContextPillModel {
  const name = info.backend.displayName;
  const v = info.view;
  const s: UsageSummaryWire | undefined = v.usage;
  const c = latestContext(s?.context, report);
  const background = v.state.backgroundTasks ?? 0;
  const running = v.state.process !== 'none';
  const extras: string[] = [];
  const lines: string[] = [];
  let model: ContextPillModel;
  if (s?.compacting) {
    model = { text: 'Compacting…', extras, title: '', level: 'busy', startable: false, background };
    lines.push(`${name} is compacting the conversation.`);
  } else if (c === undefined) {
    const startable = !running && info.needsProcess.includes('context');
    model = { text: 'Context —', extras, title: '', level: 'unknown', startable, background };
    lines.push(
      running
        ? `${name} has not reported its context yet.`
        : `No ${name} process runs, so the context cannot be read. ${startable ? `Start ${name} to read it.` : ''}`.trim(),
    );
  } else {
    model = {
      text: `Context ${percentText(c.percent)} · ${formatCount(c.used)}/${formatCount(c.window)}`,
      extras,
      title: '',
      percent: c.percent,
      level: contextLevel(c),
      startable: false,
      background,
    };
    lines.push(`${exactCount(c.used)} of ${exactCount(c.window)} tokens in context (${percentText(c.percent)}).`);
    if (c.autoCompactAt !== undefined)
      lines.push(
        `Auto-compact at ${exactCount(c.autoCompactAt)} tokens (${percentText((c.autoCompactAt / c.window) * 100)}).`,
      );
    lines.push(sourceNote(c.source, name));
    if (!running) lines.push(`Last known figure: no ${name} process runs now.`);
  }
  // Plan window for subscriptions, cost for pay-per-use accounts (D58, D60): never both as primary.
  if (s?.blocked) extras.push('Limit reached');
  else if (s?.limit?.percent !== undefined) extras.push(`${s.limit.label} ${percentText(s.limit.percent)}`);
  else if (s?.costLabel?.primary === true && s.costUsd !== undefined && s.costUsd > 0)
    extras.push(formatUsd(s.costUsd));
  if (s?.limit?.percent !== undefined) {
    const reset = resetText(s.limit.resetsAt, now);
    lines.push(`Plan: ${s.limit.label} window ${percentText(s.limit.percent)} used${reset ? `, ${reset}` : ''}.`);
  }
  if (s?.costUsd !== undefined && s.costLabel)
    lines.push(
      `Cost so far: ${formatUsd(s.costUsd)} (${s.costLabel.text}).${s.costLabel.warning ? ` ${s.costLabel.warning}` : ''}`,
    );
  if (s?.retry) {
    extras.push(
      `Retrying${s.retry.maxRetries ? ` ${s.retry.attempt}/${s.retry.maxRetries}` : ` (${s.retry.attempt})`}`,
    );
    lines.push(`The model call is being retried: ${s.retry.error}`);
  }
  if (background > 0) {
    extras.push(`${background} in background`);
    lines.push(
      `${background === 1 ? 'A background task still runs' : `${background} background tasks still run`}; ` +
        `its tokens count when ${name} reports them.`,
    );
  }
  lines.push('Click for the usage panel.');
  model.title = lines.join('\n');
  return model;
}

// ---- the context breakdown (`/context`) ----

/**
 * Theme colour names the agent uses for its categories, as CSS colours. Unknown names get a
 * palette colour by position. Each category can be restyled with `--raw-agent-context-<id>` (D67).
 */
const THEME_COLORS: Record<string, string> = {
  promptBorder: '#8a8a8a',
  inactive: '#9e9e9e',
  permission: '#8c94e8',
  suggestion: '#8c94e8',
  remember: '#8c94e8',
  warning: '#e0a526',
  success: '#3fa34d',
  error: '#d9534f',
  text: '#6b6b6b',
  red: '#d9534f',
  green: '#3fa34d',
  blue: '#4a8fe7',
  purple: '#9b59b6',
  orange: '#e67e22',
  pink: '#e86fa8',
  cyan: '#20a5b8',
  yellow: '#d4b106',
};
const PALETTE = ['#4a8fe7', '#9b59b6', '#3fa34d', '#e0a526', '#e67e22', '#20a5b8', '#e86fa8', '#d9534f'];

export function categoryColor(color: string | undefined, index: number): string {
  if (color !== undefined) {
    const base = color.replace(/_FOR_SUBAGENTS_ONLY$/, '');
    const hit = THEME_COLORS[base];
    if (hit !== undefined) return hit;
    if (/^#[0-9a-f]{3,8}$/i.test(base)) return base;
  }
  return PALETTE[index % PALETTE.length] as string;
}

export interface ContextRow {
  key: string;
  name: string;
  tokens: number;
  /** Share of the window, 0-100. */
  percent: number;
  kind: 'used' | 'free' | 'buffer' | 'deferred';
  color: string;
}

export interface ContextBreakdown {
  /** "19.7k / 1M tokens (2%)". */
  head: string;
  model?: string;
  /** "Auto-compact at 167k (83%)", "Auto-compact is off", or undefined when not reported. */
  autoCompact?: string;
  source: string;
  /** In the agent's order: used categories, the auto-compact buffer and free space. */
  rows: ContextRow[];
  /** Deferred categories: listed, not loaded into the context (the agent's own split). */
  deferred: ContextRow[];
  /** Why there is no breakdown. */
  note?: string;
}

const kindOf = (k: string | undefined, id: string | undefined): ContextRow['kind'] => {
  if (k === 'free' || k === 'buffer' || k === 'deferred' || k === 'used') return k;
  if (id === 'free_space') return 'free';
  if (id === 'autocompact_buffer') return 'buffer';
  return 'used';
};

/** The panel's context section, like the agent's own `/context` (D59). */
export function contextBreakdown(c: ContextViewWire, name: string): ContextBreakdown {
  const out: ContextBreakdown = {
    head: `${formatCount(c.used)} / ${formatCount(c.window)} tokens (${percentText(c.percent)})`,
    source: sourceNote(c.source, name),
    rows: [],
    deferred: [],
  };
  if (c.model !== undefined) out.model = c.model;
  if (c.autoCompactEnabled === false) out.autoCompact = 'Auto-compact is off';
  else if (c.autoCompactAt !== undefined)
    out.autoCompact = `Auto-compact at ${formatCount(c.autoCompactAt)} (${percentText((c.autoCompactAt / c.window) * 100)})`;
  const cats = c.categories ?? [];
  if (cats.length === 0) {
    out.note =
      c.source === 'call'
        ? `${name} reported only a total for the last call. The breakdown shows after its next context report.`
        : `${name} reported no categories.`;
    return out;
  }
  cats.forEach((cat, i) => {
    const kind = kindOf(cat.kind, cat.id);
    const row: ContextRow = {
      key: cat.id ?? `${i}:${cat.name}`,
      name: cat.name,
      tokens: cat.tokens,
      percent: c.window > 0 ? (cat.tokens / c.window) * 100 : 0,
      kind,
      color: kind === 'free' ? 'transparent' : categoryColor(cat.color, i),
    };
    (kind === 'deferred' ? out.deferred : out.rows).push(row);
  });
  return out;
}

// ---- totals, models, turns ----

export interface TokenLine {
  label: string;
  value: string;
}

/** Input, cache read, cache write, output (and thinking when reported), exact. */
export function tokenLines(t: TokenCounts): TokenLine[] {
  const lines: TokenLine[] = [
    { label: 'Input', value: exactCount(t.input) },
    { label: 'Cache read', value: exactCount(t.cacheRead) },
    { label: 'Cache write', value: exactCount(t.cacheWrite) },
    { label: 'Output', value: exactCount(t.output) },
  ];
  if (t.reasoning !== undefined) lines.push({ label: 'of which thinking', value: exactCount(t.reasoning) });
  const hit = cacheHitRatio(t);
  if (hit !== undefined) lines.push({ label: 'Cache hit', value: percentText(hit * 100) });
  return lines;
}

/** "$0.0123 · estimate at list price"; subscriptions say "API-equivalent" (secondary, D58). */
export function costText(costUsd: number | undefined, label: CostLabel | undefined): string {
  if (costUsd === undefined) return 'Not reported';
  return label ? `${formatUsd(costUsd)} · ${label.text}` : formatUsd(costUsd);
}

export interface ModelRow {
  model: string;
  tokens: string;
  cost: string;
  details: string[];
}

const BASIS_TEXT = { list: 'list price', managed: 'managed price', unknown: 'unknown price' } as const;

export function modelRows(models: readonly ModelUsageTotals[]): ModelRow[] {
  return models.map((m) => {
    const details: string[] = [];
    details.push(
      `in ${exactCount(m.tokens.input)} · cache read ${exactCount(m.tokens.cacheRead)} · ` +
        `cache write ${exactCount(m.tokens.cacheWrite)} · out ${exactCount(m.tokens.output)}`,
    );
    if (m.contextWindow !== undefined) details.push(`context window ${formatCount(m.contextWindow)}`);
    if (m.maxOutputTokens !== undefined) details.push(`max output ${formatCount(m.maxOutputTokens)}`);
    if (m.webSearches !== undefined && m.webSearches > 0) details.push(`${m.webSearches} web searches`);
    if (m.costBasis !== undefined) details.push(BASIS_TEXT[m.costBasis]);
    if (m.provider !== undefined) details.push(`served by ${m.provider}`);
    return {
      model: m.model,
      tokens: `${formatCount(totalTokens(m.tokens))} tokens`,
      cost: formatUsd(m.costUsd),
      details,
    };
  });
}

export interface TurnRow {
  key: string;
  /** "Turn 4", or "Background" for an agent turn outside a host turn (a wake turn, D26). */
  label: string;
  total: string;
  main: TokenLine[];
  /** Subagents, compaction and workflow agents in this turn; undefined when there was none. */
  other?: string;
  cost: string;
  facts: string[];
  models: string;
}

export function turnRows(rows: readonly TurnUsageRowWire[], label: CostLabel | undefined): TurnRow[] {
  return [...rows].reverse().map((r, i) => {
    const u = r.usage;
    const facts: string[] = [`${u.calls} main-thread call${u.calls === 1 ? '' : 's'}`];
    facts.push(u.durationMs !== undefined ? `took ${formatDuration(u.durationMs) ?? '—'}` : 'duration not reported');
    if (u.apiDurationMs > 0) facts.push(`model time ${formatDuration(u.apiDurationMs) ?? '—'}`);
    facts.push(u.ttftMs !== undefined ? `first token after ${formatMs(u.ttftMs)}` : 'first-token time not reported');
    const otherTotal = totalTokens(u.other);
    const row: TurnRow = {
      key: `${r.at}:${i}`,
      label: r.hostTurn !== undefined ? `Turn ${r.hostTurn}` : 'Background',
      total: `${exactCount(totalTokens(u.total))} tokens`,
      main: tokenLines(u.main),
      cost: costText(u.costUsd, label),
      facts,
      models: u.models.map((m) => m.model).join(', ') || 'not reported',
    };
    if (otherTotal > 0)
      row.other =
        `${exactCount(otherTotal)} tokens (in ${exactCount(u.other.input)} · cache read ${exactCount(u.other.cacheRead)}` +
        ` · cache write ${exactCount(u.other.cacheWrite)} · out ${exactCount(u.other.output)})`;
    return row;
  });
}

const formatMs = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${Math.round(ms / 100) / 10} s`);

// ---- subagents and workflows ----

export interface AgentUsageRow {
  key: string;
  kind: 'subagent' | 'teammate' | 'workflow' | 'workflow-agent';
  label: string;
  tokens: string;
  facts: string[];
}

/**
 * Subagent, teammate and workflow rows with the agent's own numbers (D46, D48). The agent counts
 * a child's tokens as its last call's context plus output, not the sum of all its calls; what a
 * turn spent on children is in that turn's "other" figure.
 */
export function agentUsageRows(children: readonly ChildWire[], runs: readonly WorkflowWire[]): AgentUsageRow[] {
  const out: AgentUsageRow[] = [];
  for (const c of children) {
    if (c.role === 'workflow-agent') continue; // listed under its run
    const facts: string[] = [c.status];
    if (c.toolUses !== undefined) facts.push(`${c.toolUses} tool use${c.toolUses === 1 ? '' : 's'}`);
    const d = formatDuration(c.durationMs);
    if (d) facts.push(d);
    out.push({
      key: `c:${c.id}`,
      kind: c.role === 'teammate' ? 'teammate' : 'subagent',
      label: c.name ?? c.label,
      tokens: c.tokens !== undefined ? `${formatCount(c.tokens)} tokens` : 'tokens not reported yet',
      facts,
    });
  }
  for (const r of runs) {
    const t = workflowTokens(r);
    const facts: string[] = [r.status, `${r.agents.length} agent${r.agents.length === 1 ? '' : 's'}`];
    if (r.usage?.toolUses !== undefined) facts.push(`${r.usage.toolUses} tool uses`);
    out.push({
      key: `w:${r.taskId}`,
      kind: 'workflow',
      label: r.label ?? r.name,
      tokens: t !== undefined ? `${formatCount(t)} tokens` : 'tokens not reported yet',
      facts,
    });
    for (const a of r.agents)
      out.push({
        key: `w:${r.taskId}:${a.index}`,
        kind: 'workflow-agent',
        label: a.label,
        tokens: a.tokens !== undefined ? `${formatCount(a.tokens)} tokens` : 'not reported yet',
        facts: [a.state, ...(a.model ? [a.model] : [])],
      });
  }
  return out;
}

// ---- plan limits and account ----

export interface LimitRow {
  id: string;
  label: string;
  /** "23% used", or "not reported". */
  value: string;
  /** Bar width 0-100; undefined: no bar (never a made-up 0 %). */
  bar?: number;
  reset?: string;
  status?: string;
}

export interface LimitsModel {
  /** Plain words when there are no bars to show. */
  note?: string;
  rows: LimitRow[];
  blocked?: string;
  overage?: string;
}

const STATUS_TEXT = { allowed: undefined, allowed_warning: 'near the limit', rejected: 'limit reached' } as const;

/** Plan limits (D60): bars only for windows the agent reported, honest words otherwise. */
export function limitsModel(
  u: UsageViewWire | undefined,
  running: boolean,
  name: string,
  now: number = Date.now(),
): LimitsModel {
  const l = u?.limits;
  if (l === undefined || l.available === undefined)
    return {
      rows: [],
      note: running
        ? `${name} has not said yet whether this account has plan limits.`
        : `Not known yet. Start ${name} to read the account's plan limits.`,
    };
  if (l.available === false) {
    const who = u?.auth?.label;
    return { rows: [], note: l.note ?? `No plan limits for this account${who ? ` (${who})` : ''}.` };
  }
  const out: LimitsModel = { rows: [] };
  for (const w of l.limits) {
    const row: LimitRow = {
      id: w.id,
      label: w.label,
      value: w.percent !== undefined ? `${percentText(w.percent)} used` : 'not reported',
    };
    if (w.percent !== undefined) row.bar = Math.max(0, Math.min(100, w.percent));
    const reset = resetText(w.resetsAt, now);
    if (reset) row.reset = reset;
    const st = w.status ? STATUS_TEXT[w.status] : undefined;
    if (st) row.status = st;
    out.rows.push(row);
  }
  if (out.rows.length === 0)
    out.note = l.note ?? `${name} has not reported a plan window yet (it does after a request).`;
  if (l.blocked) {
    const reset = resetText(l.blocked.resetsAt, now);
    out.blocked = `Requests are refused until the limit resets${reset ? ` (${reset})` : ''}.`;
  }
  if (l.overage) {
    const o = l.overage;
    const parts = [
      o.inUse ? 'in use' : o.status === 'rejected' ? 'not available' : o.status ? 'available' : 'reported',
    ];
    const reset = resetText(o.resetsAt, now);
    if (reset) parts.push(reset);
    if (o.disabledReason) parts.push(o.disabledReason);
    out.overage = `Extra usage: ${parts.join(', ')}.`;
  }
  return out;
}

const AUTH_KIND_TEXT: Record<string, string> = {
  subscription: 'Subscription plan',
  'api-key': 'API key (pay as you go)',
  bedrock: 'Amazon Bedrock',
  vertex: 'Google Vertex AI',
  foundry: 'Microsoft Foundry',
  cloud: 'Cloud provider',
  gateway: 'Gateway',
  unknown: 'Not reported',
};

export interface AccountModel {
  lines: TokenLine[];
  /** How to read the cost figures, in plain words. */
  costNote: string[];
}

export function accountModel(u: UsageViewWire | undefined, name: string): AccountModel {
  const a = u?.auth;
  const lines: TokenLine[] = [];
  if (!a) lines.push({ label: 'Account', value: `${name} has not reported how this session is billed yet.` });
  else {
    lines.push({ label: 'Account', value: a.label });
    lines.push({ label: 'Type', value: AUTH_KIND_TEXT[a.kind] ?? a.kind });
    if (a.subscriptionType) lines.push({ label: 'Plan', value: a.subscriptionType });
    if (a.apiKeySource) lines.push({ label: 'Key from', value: a.apiKeySource });
    if (a.provider) lines.push({ label: 'Provider', value: a.provider });
    if (a.credentialExpiresAt !== undefined)
      lines.push({ label: 'Login valid until', value: formatClock(a.credentialExpiresAt) });
  }
  const costNote: string[] = [];
  const l = u?.costLabel;
  if (l) {
    costNote.push(
      l.primary
        ? `Cost is ${name}'s ${l.text}.`
        : `Cost is ${l.text}: what the same use would cost with an API key. The plan limits are what counts here.`,
    );
    if (l.note) costNote.push(l.note);
    if (l.warning) costNote.push(l.warning);
  } else costNote.push('How the cost is priced is not known yet.');
  return { lines, costNote };
}

// ---- the whole panel ----

export interface UsagePanelModel {
  name: string;
  running: boolean;
  /** No process: the panel offers "Start <name>" (D4); figures are the last known ones. */
  startable: boolean;
  totals?: { tokens: TokenLine[]; total: string; cost: string; apiTime?: string };
  models: ModelRow[];
  turns: TurnRow[];
  agents: AgentUsageRow[];
  limits: LimitsModel;
  account: AccountModel;
  context?: ContextBreakdown;
  contextNote?: string;
  events: string[];
  background?: string;
  error?: string;
}

/** Everything the usage panel shows, from the session view and the two route answers. */
export function usagePanelModel(
  info: SessionInfo,
  answer: UsageAnswerWire | undefined,
  report: ContextViewWire | undefined,
  now: number = Date.now(),
): UsagePanelModel {
  const name = info.backend.displayName;
  const v = info.view;
  const running = answer?.running ?? v.state.process !== 'none';
  const u = answer?.usage;
  const m: UsagePanelModel = {
    name,
    running,
    startable: v.state.process === 'none' && info.needsProcess.includes('usage'),
    models: u?.totals ? modelRows(u.totals.models) : [],
    turns: turnRows(u?.turns ?? [], u?.costLabel),
    agents: agentUsageRows(v.children ?? [], v.workflows ?? []),
    limits: limitsModel(u, running, name, now),
    account: accountModel(u, name),
    events: [],
  };
  if (u?.totals) {
    const t = u.totals;
    m.totals = {
      tokens: tokenLines(t.tokens),
      total: `${exactCount(totalTokens(t.tokens))} tokens`,
      cost: costText(t.costUsd, u.costLabel),
    };
    if (t.apiDurationMs > 0) m.totals.apiTime = formatDuration(t.apiDurationMs) ?? '—';
  }
  const ctx = latestContext(u?.context, report);
  if (ctx) m.context = contextBreakdown(ctx, name);
  else
    m.contextNote = running
      ? `${name} has not reported its context yet.`
      : `No ${name} process runs. Start it to read the context.`;
  if (u?.compacting) m.events.push('Compacting now…');
  for (const c of [...(u?.compactions ?? [])].reverse()) {
    if (c.phase !== 'end') continue;
    const how = c.trigger === 'auto' ? 'Auto-compacted' : 'Compacted';
    m.events.push(
      c.error
        ? `${how}: failed (${c.error})`
        : `${how}${c.preTokens !== undefined ? ` from ${formatCount(c.preTokens)}` : ''}${c.postTokens !== undefined ? ` to ${formatCount(c.postTokens)}` : ''} tokens · ${formatClock(c.at)}`,
    );
  }
  for (const r of [...(u?.resets ?? [])].reverse())
    m.events.push(
      `Conversation cleared${r.trigger ? ` (${r.trigger})` : ''} · totals restart at 0 · ${formatClock(r.at)}`,
    );
  for (const r of u?.retries ?? [])
    m.events.push(
      `Retry ${r.attempt}${r.maxRetries ? `/${r.maxRetries}` : ''}: ${r.error}${r.httpStatus ? ` (HTTP ${r.httpStatus})` : ''}`,
    );
  const bg = v.state.backgroundTasks ?? 0;
  if (bg > 0)
    m.background = `${bg === 1 ? '1 background task runs' : `${bg} background tasks run`}. Its tokens count when ${name} reports them (when it ends, or at the next turn).`;
  if (answer?.error)
    m.error = `${name}'s usage report could not be read: ${answer.error}. The figures are the last known ones.`;
  return m;
}
