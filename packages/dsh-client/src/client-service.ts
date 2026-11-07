// The Client service `rawAgentClient` for other browser plugins (R9.2, D66, architecture §7.3).
// The same calls as the Host service `rawAgent`, over the plugin's own routes, plus `prefill`.
//
// - `onEvent` follows the session store the controls use (it polls the Host while someone
//   listens); events are made by the same pure tracker as on the Host (core `PublicEventTracker`).
// - `prefill` only puts text into our composer (at the caret) or the side-question box; the user
//   presses Enter. It needs no grant.
// - `send`, `steer` and `askSideQuestion` need a grant token; the Host checks it.

import {
  PublicEventTracker,
  RAW_AGENT_API_VERSION,
  RawAgentServiceError,
  type PublicViewInput,
  type RawAgentBackendInfo,
  type RawAgentClientService,
  type RawAgentPublicEvent,
} from '@dsh-raw-agent/core';
import type { PluginApi } from './plugin-routes.js';
import type { PrefillTarget, SessionStores } from './session-store.js';

/** The longest prefill text (characters). */
export const PREFILL_MAX = 100_000;

export function createRawAgentClientService(stores: SessionStores, plugin: PluginApi): RawAgentClientService {
  // The backends this page has seen in our sessions (the browser has no list before a session).
  const backends: RawAgentBackendInfo[] = [];
  const noteBackend = (b: { kind: string; displayName: string }) => {
    if (!backends.some((x) => x.kind === b.kind)) backends.push({ kind: b.kind, displayName: b.displayName });
  };

  const service: RawAgentClientService = {
    apiVersion: RAW_AGENT_API_VERSION as 1,
    backends,
    async sessionInfo(sessionId) {
      const info = await plugin.sessionInfo(sessionId);
      if (info) noteBackend(info.backend);
      return info;
    },
    interrupt: (sessionId) => plugin.interrupt(sessionId),
    send: (sessionId, text, grant) => plugin.send(sessionId, text, grant, 'send'),
    steer: (sessionId, text, grant) => plugin.send(sessionId, text, grant, 'steer'),
    askSideQuestion: (sessionId, question, grant) => plugin.askSideQuestion(sessionId, question, grant),
    onEvent(sessionId, listener) {
      if (typeof sessionId !== 'string' || sessionId === '') return () => {};
      const store = stores.get(sessionId);
      let tracker: PublicEventTracker | undefined;
      let seen = false;
      let stopped = false;
      const emit = (events: RawAgentPublicEvent[]) => {
        for (const e of events) {
          if (stopped) return;
          try {
            listener(e);
          } catch (error) {
            console.warn('[raw-agent] a plugin event listener failed', error);
          }
        }
      };
      const look = () => {
        const snap = store.getSnapshot();
        if (snap.status === 'ready' && snap.info) {
          const b = snap.info.backend;
          noteBackend(b);
          tracker ??= new PublicEventTracker(sessionId, { kind: b.kind, displayName: b.displayName });
          seen = true;
          emit(tracker.update(snap.info.view as unknown as PublicViewInput));
        } else if (snap.status === 'absent' && seen && tracker) emit(tracker.end());
      };
      const off = store.subscribe(look);
      look();
      return () => {
        stopped = true;
        off();
      };
    },
    async prefill(sessionId, text, target = 'composer') {
      if (typeof text !== 'string' || text === '') throw new RawAgentServiceError('empty', 'the text is empty');
      if (text.length > PREFILL_MAX)
        throw new RawAgentServiceError('too-long', `the text is longer than ${PREFILL_MAX} characters`);
      const where: PrefillTarget = target === 'side-question' ? 'side-question' : 'composer';
      const store = stores.get(sessionId);
      if (store.getSnapshot().status !== 'ready') await store.refresh();
      const snap = store.getSnapshot();
      if (snap.status !== 'ready' || !snap.info) return false;
      noteBackend(snap.info.backend);
      store.requestPrefill(text, where);
      return true;
    },
  };
  return Object.freeze(service);
}
