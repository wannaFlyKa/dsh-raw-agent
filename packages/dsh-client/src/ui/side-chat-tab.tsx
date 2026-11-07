// 0.1.2 (D89, R7.3): the side chat as a tab of DSH's right sidebar. DSH keeps one sidebar
// layout per session, so each session has its own tab and the tab shows that session's side
// questions only. The tab never writes to the conversation and never starts a process: it asks
// through the same plugin route as `/btw` (the Host asks the live process, rule 9).

import * as React from 'react';
import type { RawAgentApi } from '../api.js';
import type { SessionStores } from '../session-store.js';
import { SidePanelBody, useSideAsk, useTick } from './side-panel.js';
import { css } from './style.js';

/** The parts of DSH's `useTabInfo()` this tab reads (structural, D65). */
export interface SideChatTabInfo {
  tab?: { visible?: boolean; navigation?: { revision?: number } };
}

export interface SideChatTabProps {
  /** Standard prop of a session slot: the session the tab is in. */
  sessionId?: string;
  stores: SessionStores;
  api: RawAgentApi;
  /** The agents' display names, for the note in a session that is not ours. */
  agentNames?: readonly string[];
  /** The side-question command, for the empty-tab hint (`/btw`). */
  command?: string;
  /** DSH's framework hook (`sidebar.right.pane.tab` hook context); absent in tests. */
  useTabInfo?: () => SideChatTabInfo;
}

const noTabInfo = (): SideChatTabInfo => ({});

/** The text of the tab in a session that is not one of ours. */
export function sideChatElsewhereText(agentNames: readonly string[] = []): string {
  const names = agentNames.length > 0 ? agentNames.join(' or ') : 'agent';
  return `Side chat works only in ${names} sessions. This session runs another agent.`;
}

export function SideChatTab(props: SideChatTabProps): React.ReactElement {
  const useInfo = props.useTabInfo ?? noTabInfo;
  const info = useInfo();
  const { sessionId, stores, api } = props;
  const store = React.useMemo(() => (sessionId ? stores.get(sessionId) : undefined), [stores, sessionId]);
  if (!store) return <Note text="Open a session to use the side chat." />;
  return <SideChatSession {...props} store={store} info={info} api={api} />;
}

function Note(props: { text: string }): React.ReactElement {
  return (
    <section aria-label="Side chat" data-raw-agent="side-chat-note" style={{ padding: 12, fontSize: 13 }}>
      <span style={css.hint}>{props.text}</span>
    </section>
  );
}

function SideChatSession(
  props: SideChatTabProps & { store: NonNullable<ReturnType<SessionStores['peek']>>; info: SideChatTabInfo },
): React.ReactElement {
  const { store, api, info } = props;
  const snap = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { busy, error, ask, cancel } = useSideAsk(store, api);
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null);
  // R9.2: side-question prefill text goes into this box once (the store remembers it was taken).
  const [prefill, setPrefill] = React.useState<{ text: string; seq: number } | undefined>();
  const prefillSeq = snap.prefillRequest?.seq;
  const ready = snap.status === 'ready' && snap.info !== undefined;
  React.useEffect(() => {
    if (!ready) return;
    const p = store.takeSidePrefill();
    if (p) setPrefill(p);
  }, [store, prefillSeq, ready]);
  // Each open of the tab (our button, `/btw`, a prefill) steps DSH's navigation revision: put the
  // caret in the box, so the keyboard user can type at once.
  const revision = info.tab?.navigation?.revision;
  const visible = info.tab?.visible !== false;
  React.useEffect(() => {
    if (ready && visible) inputRef.current?.focus?.();
  }, [revision, prefill?.seq, ready, visible]);
  const side = snap.info?.view.side;
  const now = useTick((side?.entries ?? []).some((e) => e.status === 'asking'));
  if (snap.status === 'absent') return <Note text={sideChatElsewhereText(props.agentNames)} />;
  if (!ready) return <Note text={snap.status === 'error' ? `Side chat: ${snap.error ?? 'no answer'}` : 'Loading…'} />;
  return (
    <SidePanelBody
      variant="tab"
      side={side}
      displayName={snap.info!.backend.displayName}
      {...(props.command ? { command: props.command } : {})}
      busy={busy}
      {...(error ? { error } : {})}
      now={now}
      onAsk={ask}
      onCancel={cancel}
      onStart={() => void store.start()}
      inputRef={inputRef}
      {...(prefill ? { prefill } : {})}
    />
  );
}
