// The only module in dsh-host that touches DSH (D79): the loop seam and listener order, the
// inbox splice, session append with the writer's rule asserts and stream self-check, the job
// controller, the catalog provider. DSH types are local structural copies (./types.ts); there is
// no runtime import of DSH (D65).

export type { CordisContext as HostContext } from './types.js';
export type * from './types.js';
export {
  mountAgent,
  PERMISSION_COMMAND,
  presetIdFor,
  WAKE_SOURCE_KIND,
  AttachmentInputError,
  toInput,
  toResultBlocks,
  saveResultImages,
  type AgentMount,
  type AgentMountOptions,
} from './loop.js';
export { AgentCommandMenus, type DshCommands, type DshCommandResult } from './commands.js';
export { mountHost, catalogAdapter, SETTINGS_MODEL } from './catalog.js';
export {
  TurnLog,
  WriterAssertError,
  spliceInbox,
  type InboxSplice,
  REPAIR_STARTED_TEXT,
  UNTIMED_SKEW_MS,
  MAX_PLAUSIBLE_TOKENS_PER_SECOND,
  MIN_TIMED_DECODE_MS,
  WRITER_EVENT_TYPES,
  type LiveChannel,
  type LiveFrame,
  type ToolResultBlock,
} from './writer.js';
export { StreamRecorder, replayStream, expandRecords } from './stream.js';
export {
  mountConfigRoutes,
  configRoutes,
  readFileForPreview,
  CONFIG_FILES_ROUTE,
  CONFIG_FILE_ROUTE,
  lifecycleRoutes,
  mountLifecycleRoutes,
  START_ROUTE,
  FORCE_STOP_ROUTE,
  STATE_ROUTE,
  CHILD_STOP_ROUTE,
  TASK_STOP_ROUTE,
  CHILD_OF_ROUTE,
  WORKFLOW_STOP_ROUTE,
  WORKFLOW_AGENT_STOP_ROUTE,
  TASK_OUTPUT_ROUTE,
  USAGE_ROUTE,
  CONTEXT_ROUTE,
  usageRoutes,
  rewindRoutes,
  REWIND_ROUTE,
  REWIND_RESTORE_ROUTE,
  REWIND_FILES_ROUTE,
  commandRoutes,
  COMMANDS_ROUTE,
  SIDE_QUESTION_ROUTE,
  SIDE_QUESTION_CANCEL_ROUTE,
  MCP_ROUTE,
  MCP_RECONNECT_ROUTE,
  MCP_TOGGLE_ROUTE,
  MCP_AUTH_ROUTE,
  MCP_AUTH_CALLBACK_ROUTE,
  LOCAL_OUTPUT_ROUTE,
  SESSION_ROUTE,
  CHOICE_ROUTE,
  ANSWER_ROUTE,
  INTERACTIONS_ROUTE,
  INTERACTIONS_PING_MS,
  interactionsRoute,
  channelLine,
  sessionControlRoutes,
  parseChoice,
  parseAnswer,
  type SessionControlDeps,
} from './routes.js';
export {
  startJob,
  jobKind,
  isJobLimitError,
  setJobWaitForTests,
  JOB_WAIT_MS,
  JOB_REWAIT_MS,
  TEARDOWN_REASONS,
} from './jobs.js';
export {
  mountServices,
  pluginRoutes,
  agentOps,
  statusOf,
  onlyRuntimeFieldsChanged,
  RUNTIME_CONFIG_FIELDS,
  configGrantPersistence,
  PLUGIN_SESSION_INFO_ROUTE,
  PLUGIN_INTERRUPT_ROUTE,
  PLUGIN_SEND_ROUTE,
  PLUGIN_SIDE_QUESTION_ROUTE,
  GRANTS_ROUTE,
  GRANT_CREATE_ROUTE,
  GRANT_REVOKE_ROUTE,
  type HostConfigShape,
  type HostConfigAccess,
  type MountServicesOptions,
  type MountedServices,
} from './services.js';
export { createChildSession, childPreStep, liveChildCount, type ChildPortOptions } from './children.js';
export { WORKFLOW_EVENT_TYPES, workflowEventData, appendWorkflowRecord, openWorkflowRuns } from './workflows.js';

/** DSH versions this port was tested against (D79). */
export const TESTED_DSH_VERSIONS: readonly string[] = Object.freeze(['0.2.2-rc.1']);
