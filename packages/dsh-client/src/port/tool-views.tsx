// D19 (r4): the tool views of a backend's view pack, registered with DSH's keyed tool view slot.
// That slot is keyed only by the wire tool name, and an occupied key replaces the view in EVERY
// session (`P/dsh-client-ui-tool/lib/types/client/contract/slots.d.ts:10-20`). The keyed outlet
// has no fallback for a registered key (`P/dsh-client-ui-renderer/lib/client.js:1178-1181`), so a
// session that is not ours gets our own plain row, never a pack view. The port never registers an
// `mcp__*` name (DSH's MCP client uses the same names) or a key a DSH package registers.

import * as React from 'react';
import type { ToolView, ToolViewPack, ToolViewProps } from '@dsh-raw-agent/core';
import type { ChildLinks } from '../child-links.js';
import type { SessionStores } from '../session-store.js';

export const TOOL_VIEW_SLOT = 'tool.call.toolview';

/**
 * Every key DSH 0.2.2-rc.1's shipped client packages register in the tool view slot (grep of
 * `name: "tool.call.toolview"` in `P/dsh-client-ui-tool`, `-ui-skill`, `-ui-cordis`,
 * `-ui-deliverables`, `-ui-action-cards`). A pack name in this list is never registered.
 */
export const DSH_TOOL_VIEW_KEYS: readonly string[] = Object.freeze([
  'apply_patch', 'ask_user_question', 'bash', 'cordis_define', 'cordis_inspect_list', 'cordis_inspect_query',
  'cordis_inspect_self', 'cordis_run', 'cordis_stop', 'cordis_undefine', 'create_goal', 'edit', 'get_goal',
  'glob', 'grep', 'interrupt_agent', 'job_kill', 'job_list', 'job_output', 'list_agents', 'list_subagent_models',
  'lsp', 'present', 'propose_action', 'ralph', 'read', 'read_image', 'schedule_create', 'schedule_delete',
  'schedule_edit', 'schedule_list', 'schedule_update', 'schedule_view', 'send_message', 'session_event_read',
  'session_event_search', 'session_event_trace', 'session_search', 'session_trace', 'skill', 'spawn_teammate',
  'subagent', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update', 'terminal_close',
  'terminal_list', 'terminal_open', 'terminal_read', 'terminal_signal', 'todo_write', 'update_goal',
  'wait_agent', 'web_fetch', 'web_search', 'workflow', 'write',
]); // prettier-ignore

/** The names of a pack the port may register: no MCP names, no DSH keys. */
export function toolViewNames(pack: ToolViewPack): string[] {
  const dsh = new Set(DSH_TOOL_VIEW_KEYS);
  return Object.keys(pack.views).filter((n) => n !== '' && !n.startsWith('mcp__') && !dsh.has(n));
}

// ---- DSH's owner props → ToolViewProps -----------------------------------------------------------

/** What DSH passes a tool view (structural copy of `ToolCallOwnerProps`, P/dsh-client-ui-tool). */
interface ArgsReader {
  keys?(): readonly string[];
  value?(key: string): unknown;
  text?(key: string): string | undefined;
}
interface ToolBlock {
  callId?: string;
  name?: string;
  time?: number;
  args?: ArgsReader;
  argsRaw?: string;
  call?: { name: string; argsRaw: string } | null;
  callTime?: number | null;
  content?: ReadonlyArray<{ type?: string; text?: string }>;
  isError?: boolean;
}
export interface ToolOwner {
  callId: string;
  toolName: string;
  phase: 'preparing' | 'start' | 'result';
  block: ToolBlock;
  cwd?: string;
  home?: string;
  openFile?(path: string, options?: { line?: number }): void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseArgs(raw: string | undefined): Record<string, unknown> | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  try {
    const v: unknown = JSON.parse(raw);
    return isRecord(v) ? v : {};
  } catch {
    return undefined;
  }
}

/** The fields the lazy argument reader knows now (a preparing call grows in place). */
function readArgs(args: ArgsReader | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!args || typeof args.keys !== 'function') return out;
  try {
    for (const k of args.keys()) {
      const v = typeof args.value === 'function' ? args.value(k) : undefined;
      if (v !== undefined) out[k] = v;
      else if (typeof args.text === 'function') {
        const t = args.text(k);
        if (t !== undefined) out[k] = t;
      }
    }
  } catch {
    // a reader of another DSH version: show what was read
  }
  return out;
}

export function toolViewPropsOf(owner: ToolOwner): ToolViewProps {
  const b = owner.block ?? {};
  const input =
    owner.phase === 'start'
      ? (parseArgs(b.argsRaw) ?? readArgs(b.args))
      : owner.phase === 'result'
        ? (parseArgs(b.call?.argsRaw) ?? readArgs(b.args))
        : readArgs(b.args);
  const p: ToolViewProps = {
    callId: owner.callId,
    toolName: owner.toolName,
    phase: owner.phase === 'preparing' ? 'preparing' : owner.phase === 'start' ? 'running' : 'done',
    input,
  };
  if (owner.phase === 'result') {
    const content = Array.isArray(b.content) ? b.content : [];
    const result: NonNullable<ToolViewProps['result']> = {
      text: content
        .filter((c) => c?.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n'),
      isError: b.isError === true,
      images: content.filter((c) => c?.type === 'image').length,
    };
    if (typeof b.callTime === 'number' && typeof b.time === 'number' && b.time >= b.callTime)
      result.durationMs = b.time - b.callTime;
    p.result = result;
  }
  if (typeof owner.cwd === 'string') p.cwd = owner.cwd;
  if (typeof owner.home === 'string') p.home = owner.home;
  if (typeof owner.openFile === 'function') {
    const open = owner.openFile;
    p.openFile = (path, line) => open(path, line !== undefined ? { line } : undefined);
  }
  return p;
}

// ---- whose session -------------------------------------------------------------------------------

const noop = () => () => {};
const undef = () => undefined;

/**
 * The backend kind of a session: its own (one of our sessions), or its parent's (a child session
 * of ours, D45). `null`: not ours. `undefined`: not known yet.
 */
export function useSessionKind(
  sessionId: string | undefined,
  stores: SessionStores,
  links?: ChildLinks,
): string | null | undefined {
  const store = sessionId ? stores.get(sessionId) : undefined;
  const snap = React.useSyncExternalStore(
    store?.subscribe ?? noop,
    store?.getSnapshot ?? undef,
    store?.getSnapshot ?? undef,
  );
  const absent = snap?.status === 'absent';
  const link = absent && sessionId && links ? links.get(sessionId) : undefined;
  const linkSnap = React.useSyncExternalStore(
    link?.subscribe ?? noop,
    link?.getSnapshot ?? undef,
    link?.getSnapshot ?? undef,
  );
  const parentId = linkSnap?.status === 'found' ? linkSnap.link?.parentSession : undefined;
  const parent = parentId ? stores.get(parentId) : undefined;
  const parentSnap = React.useSyncExternalStore(
    parent?.subscribe ?? noop,
    parent?.getSnapshot ?? undef,
    parent?.getSnapshot ?? undef,
  );
  if (!store) return null;
  if (snap?.status === 'ready' && snap.info) return snap.info.backend.kind;
  if (!absent) return undefined;
  if (!links || linkSnap?.status === 'none') return null;
  if (linkSnap?.status !== 'found') return undefined;
  if (parentSnap?.status === 'ready' && parentSnap.info) return parentSnap.info.backend.kind;
  return parentSnap?.status === 'absent' ? null : undefined;
}

// ---- the plain row (other sessions, and a view that failed) --------------------------------------

const muted = 'var(--raw-agent-muted, var(--dsw-alias-label-secondary, GrayText))';
const plain = {
  head: {
    display: 'flex',
    gap: 6,
    alignItems: 'baseline',
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    padding: 0,
    font: 'inherit',
    color: 'inherit',
    textAlign: 'left',
    width: '100%',
    minWidth: 0,
  },
  summary: { color: muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  pre: {
    fontFamily: 'var(--raw-agent-mono, ui-monospace, monospace)',
    fontSize: 12,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    margin: '4px 0 0 12px',
    maxHeight: 320,
    overflow: 'auto',
  },
} satisfies Record<string, React.CSSProperties>;

function plainSummary(input: Record<string, unknown>): string {
  for (const k of ['description', 'command', 'file_path', 'path', 'pattern', 'url', 'query', 'skill']) {
    const v = input[k];
    if (typeof v === 'string' && v.trim() !== '') return v.split('\n')[0]!.slice(0, 160);
  }
  return '';
}

/** A neutral row: the tool name, a short summary, and the input and result on click. */
export function PlainToolRow(props: { call: ToolViewProps }): React.ReactElement {
  const { call } = props;
  const [open, setOpen] = React.useState(false);
  const state = call.phase !== 'done' ? 'running…' : call.result?.isError ? 'failed' : '';
  let input: string;
  try {
    input = JSON.stringify(call.input, null, 2);
  } catch {
    input = String(call.input);
  }
  return (
    <div data-raw-agent="tool-plain" data-tool={call.toolName}>
      <button type="button" style={plain.head} onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>Tool call · {call.toolName}</span>
        <span style={plain.summary}>{plainSummary(call.input)}</span>
        {state && <span style={{ fontSize: 11, color: muted }}>{state}</span>}
      </button>
      {open && <pre style={plain.pre}>{input}</pre>}
      {open && call.result && <pre style={plain.pre}>{call.result.text}</pre>}
    </div>
  );
}

class ViewBoundary extends React.Component<{ call: ToolViewProps; children: React.ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): React.ReactNode {
    return this.state.failed ? <PlainToolRow call={this.props.call} /> : this.props.children;
  }
}

export interface ScopedToolViewProps extends ToolOwner {
  sessionId?: string;
  stores: SessionStores;
  links?: ChildLinks;
  kind: string;
  view: ToolView;
}

/**
 * One registered tool view: the pack's view in a session of the pack's backend (or a child session
 * of one), the plain row everywhere else and while that is not known yet.
 */
export function ScopedToolView(props: ScopedToolViewProps): React.ReactElement {
  const kind = useSessionKind(props.sessionId, props.stores, props.links);
  const call = toolViewPropsOf(props);
  if (kind !== props.kind) return <PlainToolRow call={call} />;
  const View = props.view as unknown as React.ComponentType<ToolViewProps>;
  return (
    <ViewBoundary call={call}>
      <View {...call} />
    </ViewBoundary>
  );
}

interface SlotsLike {
  inject(key: string, callback: () => (() => void) | Iterable<() => void>): () => void;
  register(options: Record<string, unknown>, component: React.ComponentType<never>): () => void;
}

/** D19: register every allowed name of every pack (one entry per name, the port's only path). */
export function registerToolViews(
  slots: SlotsLike,
  packs: readonly ToolViewPack[],
  stores: SessionStores,
  links?: ChildLinks,
): string[] {
  const done: string[] = [];
  const entries: Array<{ name: string; kind: string; view: ToolView }> = [];
  for (const pack of packs)
    for (const name of toolViewNames(pack)) {
      if (done.includes(name)) continue; // first pack wins; one key, one entry
      done.push(name);
      entries.push({ name, kind: pack.kind, view: pack.views[name]! });
    }
  if (entries.length === 0) return done;
  slots.inject(TOOL_VIEW_SLOT, function* () {
    for (const e of entries)
      yield slots.register(
        {
          name: TOOL_VIEW_SLOT,
          key: e.name,
          // A strict session slot passes the session id to `inject` (P/dsh-client-ui-renderer, runInject).
          inject: (sessionId: string) => ({ sessionId, stores, links, kind: e.kind, view: e.view }),
        },
        ScopedToolView as React.ComponentType<never>,
      );
  });
  return done;
}
