// Browser half of the plugin (D79, D80). Imports only @dsh-raw-agent/core; every DSH touch point is
// in ./port. The composition root (packages/plugin) builds the client entry from this.

import { mountClient, type ClientContext, type MountClientOptions } from './port/index.js';

export * from './api.js';
export * from './view-model.js';
export * from './asks-model.js';
export * from './agents-model.js';
export * from './workflow-model.js';
export * from './usage-model.js';
export * from './commands-model.js';
export { UsageReader, UsageReaders, type UsageReadSnapshot } from './usage-reader.js';
export {
  ContextPill,
  ContextPillView,
  ContextSection,
  UsagePanel,
  type ContextPillProps,
  type UsagePanelProps,
} from './ui/usage-panel.js';
export { TaskOutputReader, type TaskOutputSnapshot } from './task-output.js';
export { ChildLinks, ChildLinkStore, CHILD_LINK_RETRY_MS, type ChildLinkSnapshot } from './child-links.js';
export {
  AgentsPanel,
  AgentsButton,
  TaskOutputView,
  TaskOutputBody,
  canStopChild,
  AgentsHeader,
  ChildRow,
  ChildStrip,
  TeamRoster,
  type AgentsHeaderProps,
  type ChildRowProps,
} from './ui/agents-panel.js';
export { WakeTriggerCard } from './ui/wake-card.js';
export { SidePanel, SidePanelBody, SideEntryView, type SidePanelProps } from './ui/side-panel.js';
export { McpPanel, McpServerRow, CommandList, type McpPanelProps } from './ui/mcp-panel.js';
export {
  LocalCommandView,
  LocalCommandText,
  LocalContextView,
  Divider,
  type LocalCommandNodeProps,
} from './ui/local-command.js';
export {
  TOOL_VIEW_SLOT,
  DSH_TOOL_VIEW_KEYS,
  toolViewNames,
  toolViewPropsOf,
  useSessionKind,
  PlainToolRow,
  ScopedToolView,
  registerToolViews,
  type ToolOwner,
  type ScopedToolViewProps,
} from './port/tool-views.js';
export {
  WorkflowAgentRow,
  WorkflowNodeView,
  WorkflowRunCard,
  WorkflowRuns,
  type WorkflowAgentRowProps,
  type WorkflowNodeViewProps,
  type WorkflowRunCardProps,
} from './ui/workflow-panel.js';
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
  CONTEXT_PILL_SLOT,
  CONTEXT_PILL_ENTRY_ID,
  CONTEXT_PILL_ORDER,
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
  AGENTS_SLOT,
  AGENTS_ENTRY_ID,
  CHILD_CHAT_ADDRESS,
  CHILD_CHAT_TAB_KIND,
  childChatAddress,
  WAKE_NODE_KIND,
  WAKE_DEFINITION_KIND,
  wakeDefinition,
  WakeNode,
  WORKFLOW_NODE_KIND,
  WORKFLOW_DEFINITION_KIND,
  WORKFLOW_RUN_START_EVENT,
  WORKFLOW_RUN_END_EVENT,
  workflowDefinition,
  WorkflowNode,
  ASSISTANT_MESSAGE_EVENT,
  LOCAL_COMMAND_NODE_KIND,
  LOCAL_COMMAND_DEFINITION_KIND,
  localCommandDefinition,
  LOCAL_COMMAND_GROUP_TREE,
  LocalCommandNode,
  type WorkflowNodeData,
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
export { agentCommandSource, COMMAND_SOURCE_NAME, type AgentCommandSource } from './port/command-source.js';
