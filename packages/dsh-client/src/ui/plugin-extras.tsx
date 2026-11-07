// R9.1, D67: a list slot of our own in the composer row, for other plugins to fill (for example a
// button that uses the `rawAgentClient` service). This small entry declares the slot and renders
// whatever fills it, in our sessions only. It is separate from the session controls, so a
// restyle plugin that shadows the controls does not drop the slot, and a plugin that fills the
// slot cannot break the controls.

import * as React from 'react';
import type { SessionControlStore } from '../session-store.js';

/** What a filling entry gets as owner props (documented in docs/plugin-api.md §3.1). */
export interface PluginExtrasOwner {
  sessionId: string;
  backend: { kind: string; displayName: string };
}

export interface PluginExtrasProps {
  store: SessionControlStore;
  /** The slot key this entry declared (passed by the port). */
  slotKey: string;
  /** DSH's standard `renderSlot` prop of a component that declares child slots. */
  renderSlot?: (key: string, owner: PluginExtrasOwner) => React.ReactNode;
}

export function PluginExtras(props: PluginExtrasProps): React.ReactElement | null {
  const { store } = props;
  const snap = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const info = snap.info;
  if (snap.status !== 'ready' || !info || typeof props.renderSlot !== 'function') return null;
  const owner: PluginExtrasOwner = {
    sessionId: store.sessionId,
    backend: { kind: info.backend.kind, displayName: info.backend.displayName },
  };
  return (
    <span data-raw-agent="plugin-extras" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {props.renderSlot(props.slotKey, owner)}
    </span>
  );
}
