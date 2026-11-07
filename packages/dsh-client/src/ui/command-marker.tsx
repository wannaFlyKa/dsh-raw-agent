// D70 and the M5 leftover: the /clear divider and the /compact marker in the chat. The agent
// answers both commands with no message of its own, so our node sits on the typed command (the
// user's own message in the log, D22) and draws only in our sessions. /compact shows its outcome
// from the Host's usage board (in memory; after a DSH restart the outcome is not known).

import * as React from 'react';
import { clearedText } from '../commands-model.js';
import { compactMarkerText, compactOutcome, type CommandMarker } from '../lifecycle-model.js';
import type { SessionControlStore } from '../session-store.js';
import type { UsageReader } from '../usage-reader.js';
import { formatCount } from '../usage-model.js';
import { Divider } from './local-command.js';

export interface CommandMarkerProps {
  marker: CommandMarker;
  store: SessionControlStore;
  /** The session's usage reader (the compaction rows); absent: the marker says it cannot tell. */
  reader?: UsageReader;
}

export function CommandMarkerView(props: CommandMarkerProps): React.ReactElement | null {
  const { marker, store, reader } = props;
  const snap = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const noReader = React.useCallback(() => () => {}, []);
  const none = React.useCallback(() => undefined, []);
  const read = React.useSyncExternalStore(
    reader?.subscribe ?? noReader,
    reader?.getSnapshot ?? none,
    reader?.getSnapshot ?? none,
  );
  const ours = snap.status === 'ready' && snap.info !== undefined;
  const compacting = snap.info?.view.usage?.compacting === true;
  const isCompact = marker.kind === 'compacted';
  // Read the usage board once, and again when a compaction ends. Never starts a process.
  React.useEffect(() => {
    if (!ours || !isCompact || !reader) return;
    void reader.read({ usage: true });
  }, [ours, isCompact, reader, compacting]);
  if (!ours || !snap.info) return null;
  const name = snap.info.backend.displayName;
  if (marker.kind === 'cleared') return <Divider text={clearedText(name)} testId="marker-cleared" />;
  if (reader && read?.usage === undefined && !read?.error) return null; // not read yet
  const outcome = compactOutcome(marker.time, read?.usage?.usage, compacting);
  return <Divider text={compactMarkerText(outcome, name, formatCount)} testId={`marker-compact-${outcome.state}`} />;
}
