// Browser half of the plugin (D79, D80). Imports only @dsh-raw-agent/core; every DSH touch point is
// in ./port. The composition root (packages/plugin) builds the client entry from this.

import { mountClient, type ClientContext, type MountClientOptions } from './port/index.js';

export * from './api.js';
export * from './view-model.js';
export * from './asks-model.js';
export { restoreReturnedDrafts, type DraftTarget, type RestoreResult } from './drafts.js';
export {
  SessionControlStore,
  SessionStores,
  POLL_MS,
  CHANNEL_RETRY_MS,
  type SessionSnapshot,
  type TimerApi,
} from './session-store.js';
export { AskCard, AskPanel, PreviewView, PREVIEW_LINES, type AskCardProps } from './ui/ask-cards.js';
export { Markdown } from './ui/markdown.js';
export type { HostActions } from './ui/actions.js';
export { SessionControls, type ControlsProps } from './ui/controls.js';
export { SettingsPanel, type SettingsPanelProps } from './ui/settings-panel.js';
export {
  mountClient,
  hostActions,
  fileResourceAddress,
  CONTROLS_SLOT,
  CONTROLS_ENTRY_ID,
  TERMINAL_TAB_KIND,
  TESTED_DSH_VERSIONS,
  NATIVE_PERMISSION_SLOT,
  SEAT_HIDDEN_ATTR,
  hideNativeSeat,
  markToolCard,
  findToolCard,
  publishAsks,
  selectAsk,
  modeKeyHandler,
  guardPresetDecoration,
  isOurSession,
  PRESET_DECORATION,
  AskComposer,
  ASK_INTERACTION_KIND,
  ASK_INTERACTION_PRECEDENCE,
  MODE_SHORTCUT_ID,
  TOOL_CALL_ATTR,
  TOOL_WAITING_ATTR,
  type AskInteraction,
  type ComposerOwner,
  type FixedInput,
  type MarkDocument,
  type PublishInteraction,
  type SeatDocument,
  type SeatElement,
  type ClientContext,
  type MountClientOptions,
} from './port/index.js';

export interface RawAgentClient {
  readonly name: string;
  /** Required client services. `sidebarRight` is optional and read with `ctx.get`. */
  readonly inject: string[];
  apply(ctx: ClientContext): void;
}

export function createRawAgentClient(options: MountClientOptions & { name?: string } = {}): RawAgentClient {
  return {
    name: options.name ?? 'dsh-raw-agent-client',
    inject: ['slots'],
    apply(ctx) {
      mountClient(ctx, options);
    },
  };
}
