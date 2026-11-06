// Pure view logic for child agents, teams, background tasks, the main-thread agent picker and the
// wake trigger (R6.1-R6.4; D15, D26, D45-D47, D50, D51, D77). No React, no DSH.

import {
  SETTINGS,
  type AskWire,
  type ChildWire,
  type SessionInfo,
  type SessionViewWire,
  type TaskWire,
} from './api.js';
import { START_OPTION, type SelectModel, type SelectOption } from './view-model.js';

// --- the child tree (R6.1) ------------------------------------------------------------------------

export interface TreeRow {
  child: ChildWire;
  /** 0 for a child of the main agent, 1 for its child, and so on. */
  level: number;
  hasChildren: boolean;
}

/**
 * The children as a tree, in start order: each child under its parent (D45: nesting follows the
 * agent's spawn depth). A child whose parent is unknown shows at the top.
 */
export function childTree(children: readonly ChildWire[]): TreeRow[] {
  const ids = new Set(children.map((c) => c.id));
  const byParent = new Map<string, ChildWire[]>();
  for (const c of children) {
    const parent = c.parent !== 'main' && ids.has(c.parent) && c.parent !== c.id ? c.parent : 'main';
    byParent.set(parent, [...(byParent.get(parent) ?? []), c]);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.startedAt - b.startedAt);
  const out: TreeRow[] = [];
  const seen = new Set<string>();
  const walk = (parent: string, level: number) => {
    for (const child of byParent.get(parent) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push({ child, level, hasChildren: (byParent.get(child.id) ?? []).length > 0 });
      walk(child.id, level + 1);
    }
  };
  walk('main', 0);
  // A parent cycle (never sent by a sane Host) still shows every child once.
  for (const c of children) if (!seen.has(c.id)) out.push({ child: c, level: 0, hasChildren: false });
  return out;
}

export function isRunning(c: { status: string }): boolean {
  return c.status === 'running' || c.status === 'starting';
}

const STATUS_TEXT: Record<string, string> = {
  starting: 'Starting',
  running: 'Running',
  completed: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
};

export function childStatusText(c: ChildWire): string {
  if (c.stopping && isRunning(c)) return 'Stopping…';
  return STATUS_TEXT[c.status] ?? c.status;
}

export function taskStatusText(t: TaskWire): string {
  return STATUS_TEXT[t.status] ?? t.status;
}

/** What kind of child this is, in words. */
export function childRoleText(c: ChildWire): string {
  const kind =
    c.role === 'teammate'
      ? 'Teammate'
      : c.role === 'workflow-agent'
        ? 'Workflow agent'
        : c.background
          ? 'Background agent'
          : 'Subagent';
  return c.agentType && c.agentType !== c.label ? `${kind} · ${c.agentType}` : kind;
}

/** 950 → "950 tokens", 12_345 → "12.3k tokens", 1_234_567 → "1.2M tokens". */
export function formatTokens(n: number | undefined): string | undefined {
  if (n === undefined || !Number.isFinite(n) || n < 0) return undefined;
  if (n < 1000) return `${Math.round(n)} tokens`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k tokens`;
  return `${(n / 1_000_000).toFixed(1)}M tokens`;
}

/** 42_000 → "42 s", 185_000 → "3 min 5 s", 3_720_000 → "1 h 2 min". */
export function formatDuration(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m} min` : `${m} min ${s % 60} s`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
}

/**
 * The numbers of one child row: tokens and tool uses from the agent's task progress (D46, D68;
 * child steps carry no usage), and the time it has run.
 */
export function childStats(c: ChildWire, now: number): string {
  const parts: string[] = [];
  const tokens = formatTokens(c.tokens);
  if (tokens) parts.push(tokens);
  if (c.toolUses !== undefined) parts.push(`${c.toolUses} ${c.toolUses === 1 ? 'tool use' : 'tool uses'}`);
  // The CLI's run time can lag (it comes with task progress); never show less than the wall time.
  const ms = isRunning(c)
    ? now - c.startedAt
    : c.endedAt !== undefined
      ? Math.max(c.durationMs ?? 0, c.endedAt - c.startedAt)
      : (c.durationMs ?? now - c.startedAt);
  const d = formatDuration(Math.max(0, ms));
  if (d) parts.push(d);
  return parts.join(' · ');
}

/** The child's latest output line, as the row shows it. */
export function childLastLine(c: ChildWire): string | undefined {
  const l = c.last;
  if (!l || l.text === '') return undefined;
  if (l.kind === 'tool') return `Calling ${l.text}`;
  if (l.kind === 'reasoning') return `Thinking: ${l.text}`;
  return l.text;
}

/** The asks of one child agent (its permission, question or plan asks, D77). */
export function asksForChild(asks: readonly AskWire[] | undefined, childId: string): AskWire[] {
  return (asks ?? []).filter((a) => a.agent === 'child' && a.agentId === childId);
}

export interface AgentCounts {
  children: number;
  running: number;
  /** Child asks waiting for the user. */
  waiting: number;
  tasks: number;
  tasksRunning: number;
  teammates: number;
}

export function agentCounts(view: SessionViewWire): AgentCounts {
  const children = view.children ?? [];
  const tasks = view.tasks ?? [];
  return {
    children: children.length,
    running: children.filter(isRunning).length,
    waiting: (view.asks ?? []).filter((a) => a.agent === 'child').length,
    tasks: tasks.length,
    tasksRunning: tasks.filter((t) => t.status === 'running').length,
    teammates: children.filter((c) => c.role === 'teammate').length,
  };
}

/** The header button's text: "Agents 3 · 1 running · 1 waiting". */
export function agentsButtonText(counts: AgentCounts): string {
  if (counts.children === 0 && counts.tasks > 0)
    return counts.tasksRunning > 0 ? `Tasks ${counts.tasks} · ${counts.tasksRunning} running` : `Tasks ${counts.tasks}`;
  const parts = [`Agents ${counts.children}`];
  if (counts.running > 0) parts.push(`${counts.running} running`);
  if (counts.waiting > 0) parts.push(`${counts.waiting} waiting`);
  if (counts.tasksRunning > 0) parts.push(`${counts.tasksRunning} ${counts.tasksRunning === 1 ? 'task' : 'tasks'}`);
  return parts.join(' · ');
}

/** The address DSH opens a child session by (`P/dsh-client-ui-subagent`, one-shot rows). */
export interface ChildAddress {
  parentSessionId: string;
  childSessionId: string;
  mode: 'one-shot';
}

/**
 * The DSH address of one child session. Its parent is the main session, or the host session of
 * its parent child (nested agents are children of their parent child, D45). Undefined while the
 * Host has no child session for it.
 */
export function childAddress(
  sessionId: string,
  children: readonly ChildWire[],
  child: ChildWire,
): ChildAddress | undefined {
  if (!child.hostSessionId) return undefined;
  let parentSessionId: string | undefined = sessionId;
  if (child.parent !== 'main') parentSessionId = children.find((c) => c.id === child.parent)?.hostSessionId;
  if (!parentSessionId) return undefined;
  return { parentSessionId, childSessionId: child.hostSessionId, mode: 'one-shot' };
}

// --- the team roster (R6.3, D50) ----------------------------------------------------------------

export interface RosterTeam {
  name: string;
  members: ChildWire[];
}

export interface RosterMessage {
  from: string;
  to: string;
  text: string;
  summary?: string;
  at: number;
}

export interface RosterModel {
  teams: RosterTeam[];
  messages: RosterMessage[];
  messaging: boolean;
  /** Why the "Message" box is off (D50), in words. */
  messagingNote?: string;
}

/** Who a sender id is: the main agent, or a child by its name (D50). */
export function senderName(id: string, children: readonly ChildWire[], displayName: string): string {
  if (id === 'main') return `${displayName} (main)`;
  const c = children.find((x) => x.id === id);
  return c ? (c.name ?? c.label) : id;
}

export function rosterModel(view: SessionViewWire, displayName: string): RosterModel | undefined {
  const team = view.team;
  if (!team) return undefined;
  const children = view.children ?? [];
  const teams = team.teams.map((t) => ({
    name: t.name === '' ? 'Team' : t.name,
    members: t.members.map((id) => children.find((c) => c.id === id)).filter((c): c is ChildWire => c !== undefined),
  }));
  const messages = team.messages.map((m) => {
    const r: RosterMessage = {
      from: m.from !== '' ? m.from : senderName(m.sender, children, displayName),
      to: m.to,
      text: m.text,
      at: m.at,
    };
    if (m.summary !== undefined) r.summary = m.summary;
    return r;
  });
  const model: RosterModel = { teams, messages, messaging: team.messaging };
  if (!team.messaging)
    model.messagingNote = `This version of ${displayName} does not take a message to a teammate from here. Teammates still message each other, and you can ask the main agent to pass a message on.`;
  return model;
}

/** How a teammate was woken, in words ("woken 2 times, last by alice"). */
export function wakeText(c: ChildWire): string | undefined {
  if (c.wakes <= 0) return undefined;
  const times = c.wakes === 1 ? 'once' : `${c.wakes} times`;
  return c.wokenBy ? `woken ${times}, last by ${c.wokenBy}` : `woken ${times}`;
}

// --- the main-thread agent picker (R6.4, D15, D51) ----------------------------------------------

/**
 * The main-thread agent picker. Only for a new session (D15): after the first message it shows the
 * seated agent, read-only, or nothing when there is none. The list is the agent's own
 * (`supportedAgents()` for Claude: user, project and plugin agents); before a process runs it is
 * a recent list for this folder, or "Start <name> to list agents" (D4).
 */
export function agentSelect(info: SessionInfo): (SelectModel & { locked: boolean }) | undefined {
  if (info.mainAgentPicker === undefined || info.mainAgentPicker === 'none') return undefined;
  const v = info.view;
  const name = info.backend.displayName;
  const agents = info.agents ?? [];
  const label = (n: string) => `Agent: ${n}`;
  if (v.choice.agentLocked === true) {
    const seated = v.live.agent ?? v.choice.agent;
    if (seated === undefined) return undefined;
    return {
      value: seated,
      options: [{ value: seated, label: label(seated) }],
      title: `The main-thread agent of this session. ${name} cannot change it after the first message.`,
      locked: true,
    };
  }
  const options: SelectOption[] = [{ value: SETTINGS, label: 'Agent: none' }];
  for (const a of agents) {
    const o: SelectOption = { value: a.name, label: label(a.name) };
    const hint = [a.description, a.model && a.model !== 'inherit' ? `Model: ${a.model}` : undefined]
      .filter((x): x is string => x !== undefined && x !== '')
      .join(' ');
    if (hint !== '') o.hint = hint;
    options.push(o);
  }
  const chosen = v.choice.agent;
  if (chosen !== undefined && !options.some((o) => o.value === chosen))
    options.push({ value: chosen, label: label(chosen) });
  if (agents.length === 0 && v.state.process === 'none')
    options.push({ value: START_OPTION, label: `Start ${name} to list agents` });
  const title =
    info.agentsFrom === 'recent'
      ? `Main-thread agent for this new session only. The list is from another session in this folder and may differ.`
      : `Main-thread agent for this new session only (like --agent). It cannot change after the first message.`;
  return { value: chosen ?? SETTINGS, options, title, locked: false };
}

// --- the wake trigger (D26) ---------------------------------------------------------------------

/** The Host's source kind of a wake turn's trigger (dsh-host `WAKE_SOURCE_KIND`). */
export const WAKE_SOURCE_KIND = 'raw-agent-wake';

export interface WakeTrigger {
  seq: number;
  time: number;
  /** The whole trigger text ("<name> continued on its own after: …"). */
  text: string;
  /** What ended in the background, one line each (may be empty). */
  items: string[];
}

interface EventLike {
  type: string;
  seq: number;
  time: number;
  data: unknown;
}

const record = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/**
 * Read the wake trigger out of one DSH session event: the Host writes it as a native
 * `developer/message` with our source kind (D26). Anything else gives null.
 */
export function wakeTriggerOf(event: EventLike): WakeTrigger | null {
  if (event.type !== 'developer/message') return null;
  const message = record(record(event.data)?.message);
  const source = record(message?.source);
  if (!message || source?.kind !== WAKE_SOURCE_KIND) return null;
  const content = Array.isArray(message.content) ? message.content : [];
  const text = content
    .map((c) => record(c))
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c!.text as string)
    .join('\n')
    .trim();
  const items = Array.isArray(source.items)
    ? source.items.filter((i): i is string => typeof i === 'string' && i !== '').slice(0, 20)
    : [];
  const summary = typeof source.summary === 'string' ? source.summary : '';
  return { seq: event.seq, time: event.time, text: text || summary, items };
}

/** The card's heading: who woke up (the part before " after: "). */
export function wakeHeading(t: WakeTrigger): string {
  const i = t.text.indexOf(' after: ');
  return i > 0 ? t.text.slice(0, i) : t.text;
}
