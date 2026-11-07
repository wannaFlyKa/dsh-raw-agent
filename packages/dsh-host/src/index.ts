// Host half of the plugin. Imports only @dsh-raw-agent/core (rule 13); all DSH access goes
// through ./port (D79). This file holds no backend-specific names (D80).

import type { AgentBackendFactory, BackendUserConfig } from '@dsh-raw-agent/core';
import { SessionRegistry, SESSIONS_SERVICE } from './registry.js';
import {
  mountAgent,
  mountConfigRoutes,
  mountHost,
  mountLifecycleRoutes,
  mountServices,
  type AgentMount,
  type HostConfigAccess,
  type MountedServices,
  type AgentMountOptions,
  type HostContext,
} from './port/index.js';

export * from './port/index.js';
export { readUserConfig, type RawUserConfig } from './user-config.js';
export {
  GrantStore,
  hashToken,
  parseGrantRecords,
  GRANT_TOKEN_PREFIX,
  GRANTS_MAX,
  type GrantRecord,
  type GrantView,
  type GrantPersistence,
  type GrantStoreOptions,
} from './grants.js';
export {
  createRawAgentService,
  backendInfos,
  type PluginMessage,
  type PluginAgentOps,
  type PluginServiceDeps,
} from './plugin-service.js';
export {
  AskDesk,
  inputSummary,
  fallbackVerb,
  DECLINE,
  KEEP_PLANNING,
  TRUST_ACCEPT,
  TRUST_DECLINE,
  SUBMIT,
  CHAT,
  ACCEPT,
  CANCEL,
  DISMISS,
  checkQuestionReply,
  checkElicitationContent,
  type AskView,
  type AskChoice,
  type AskForm,
  type AskKind,
  type AskReply,
  type AskResult,
  type AskHooks,
  type AuditInfo,
  type AuditOutcome,
} from './asks.js';
export {
  runModeCommand,
  findMode,
  isDshPresetName,
  presetAnswer,
  modeCommandDescription,
  type ModeCommandResult,
  type ModeCommandRuntime,
} from './mode-command.js';
export {
  DSH_KEPT_COMMANDS,
  TAKEN_NOTE,
  SIDE_ENTRIES_KEPT,
  SIDE_QUESTION_MAX,
  LOCAL_OUTPUTS_KEPT,
  planCommandMenu,
  SideQuestionDesk,
  LocalOutputs,
  type MenuPlacement,
  type MenuRow,
  type MenuPlan,
  type SideEntry,
  type SideEntryStatus,
  type SideView,
  type SideAskResult,
  type SideControl,
  type McpAnswer,
  type McpActionResult,
} from './agent-commands.js';
export {
  listConfigFiles,
  previewConfigFile,
  MAX_PREVIEW_BYTES,
  type ConfigPreviewDeps,
  type ConfigFilePreview,
  type ConfigFileListItem,
} from './config-preview.js';
export {
  SessionRegistry,
  SESSIONS_SERVICE,
  REAP_CHECK_MS,
  isSessionRegistry,
  PLUGIN_MESSAGES_KEPT,
  type PluginSender,
  type ReturnedDraft,
  type SessionRegistryOptions,
  type RegisteredRuntime,
} from './registry.js';
export {
  ChildHub,
  CHILD_STOP_WAIT_MS,
  TEAM_MESSAGES_KEPT,
  CHILD_LAST_CHARS,
  lastOutput,
  type ChildSpec,
  type ChildHandle,
  type ChildRunner,
  type ChildOutcome,
  type ChildStatus,
  type ChildView,
  type TeamView,
  type TeamMessageView,
  type ChildHubDeps,
} from './children.js';
export {
  WorkflowRecorder,
  WORKFLOW_RUNS_KEPT,
  WORKFLOW_CHILD_WAIT_MS,
  memberOutcomeOfState,
  memberOutcomeOfStatus,
  type WorkflowRecord,
  type WorkflowDeps,
  type WorkflowView,
  type WorkflowAgentView,
  type WorkflowRunStatus,
  type WorkflowMemberOutcome,
  type WorkflowStopReason,
  type OpenWorkflowRun,
} from './workflows.js';
export {
  SessionRuntime,
  WORKFLOW_STOP_WAIT_MS,
  TASK_OUTPUT_MAX_CHARS,
  TASK_KINDS_KEPT,
  JOB_LIMIT_CONFIG_KEY,
  type JobLink,
  type JobRefusal,
  type TaskView,
  SETTINGS_CHOICE,
  STOP_GRACE_MS,
  crashMessage,
  recoveryTrigger,
  recoveryItems,
  endedByStopNotice,
  childForkNotice,
  type LifecycleView,
  type RecoveryCause,
  type RewindOptions,
  type RewindFilesAnswer,
  type RewindPoint,
  imageUnavailableText,
  type SinkResultContent,
  type RuntimeState,
  type SessionView,
  type ChoiceView,
  type ChoiceResult,
  type LiveInfo,
  type HostSessionPort,
  type HostBinding,
  type TurnSink,
  type TurnInput,
  type TurnOutcome,
  type UsageAnswer,
  type ContextAnswer,
  type CommandsAnswer,
  CONTEXT_REPORT_MIN_MS,
} from './driver.js';
export {
  forkCut,
  droppedHumanMessage,
  tasksEndedByStop,
  rewindPoints,
  REWIND_TEXT_MAX,
  REWIND_DRAFT_MAX,
  REWIND_POINTS_MAX,
  type ForkCut,
} from './port/lifecycle.js';
export {
  UsageBoard,
  USAGE_TURNS_KEPT,
  USAGE_EVENTS_KEPT,
  type UsageView,
  type UsageSummary,
  type ContextView,
  type TurnUsageRow,
  type CompactionRow,
  type RetryRow,
  type ResetRow,
} from './usage.js';

export interface RawAgentHostOptions {
  /** Passed by the composition root (packages/plugin), one per backend kind (D80). */
  factories: readonly AgentBackendFactory[];
  /** Test-only catalog rows (live suites pick a cheap model per session); empty in normal use. */
  seedModels?: readonly string[];
  /** Read at every spawn (D87). The composition root builds it from the volatile entry config. */
  userConfig?: () => BackendUserConfig;
  /** Idle-reap timeout in minutes (D6); off when unset or 0. Read at every check (volatile, D87). */
  idleReapMinutes?: () => number | undefined;
  /**
   * The Host entry config (R9.2, D66): plugin grants are stored in its `grants` field without a
   * restart. Without it, grants are kept in memory for one DSH run.
   */
  hostConfig?: HostConfigAccess;
}

/** The agent row's config (D81): only the backend kind. */
export interface AgentEntryConfig {
  backend?: string;
}

export interface RawAgentHost {
  readonly factories: readonly AgentBackendFactory[];
  /** The Host entry's backend-session registry (D87), provided as the `rawAgentSessions` service. */
  readonly sessions: SessionRegistry;
  /** The public services (R9.2), once `apply` ran. */
  readonly services: MountedServices | undefined;
  /** The Host entry: catalog providers (D34) and the settings-preview routes (D63). */
  apply(ctx: HostContext): void;
  /** The agent entry mounted by a `raw-agent-<kind>` preset row (D81). */
  applyAgent(ctx: HostContext, config: AgentEntryConfig | undefined, extra?: Partial<AgentMountOptions>): AgentMount;
}

export function createRawAgentHost(options: RawAgentHostOptions): RawAgentHost {
  const kinds = new Set<string>();
  for (const f of options.factories) {
    if (kinds.has(f.kind)) throw new Error(`Duplicate backend kind: ${f.kind}`);
    kinds.add(f.kind);
  }
  const minutes = options.idleReapMinutes;
  const registryOpts: ConstructorParameters<typeof SessionRegistry>[0] = {};
  if (minutes) registryOpts.idleReapMs = () => Math.max(0, Number(minutes() ?? 0)) * 60_000;
  if (options.userConfig) registryOpts.userConfig = options.userConfig;
  const sessions = new SessionRegistry(registryOpts);
  let services: MountedServices | undefined;
  return {
    factories: options.factories,
    sessions,
    get services() {
      return services;
    },
    apply(ctx) {
      mountHost(ctx, options.factories, options.seedModels ?? []);
      // Settings quick access (D63): masked, read-only, only the factory's own files.
      mountConfigRoutes(ctx, options.factories);
      // D87: the Host entry owns the processes; agent mounts attach to this registry.
      try {
        ctx.provide?.(SESSIONS_SERVICE, sessions);
      } catch (error) {
        ctx.logger?.warn('[raw-agent] could not provide the session registry', String(error));
      }
      mountLifecycleRoutes(ctx, sessions, { factories: options.factories, seedModels: options.seedModels ?? [] });
      // R9.2, D66: `rawAgent` for other Host plugins, and the routes of `rawAgentClient`.
      try {
        services = mountServices(ctx, {
          registry: sessions,
          factories: options.factories,
          ...(options.hostConfig ? { hostConfig: options.hostConfig } : {}),
        });
      } catch (error) {
        ctx.logger?.warn('[raw-agent] could not mount the plugin services', String(error));
      }
      ctx.effect(() => {
        const stop = sessions.startReaper();
        return () => {
          stop();
          void sessions.disposeAll();
        };
      }, 'raw-agent: session registry');
    },
    applyAgent(ctx, config, extra) {
      const kind = config?.backend ?? options.factories[0]?.kind;
      const factory = options.factories.find((f) => f.kind === kind);
      if (!factory) throw new Error(`Unknown backend kind: ${String(kind)}`);
      // D76 needs our catalog row, which the Host entry registers when the llm service exists.
      const llm = ctx.get('llm') as { registerAdapter?: unknown } | undefined;
      const mountOpts: AgentMountOptions = { factory, selectSettingsModel: typeof llm?.registerAdapter === 'function' };
      if (options.userConfig) mountOpts.userConfig = options.userConfig;
      return mountAgent(ctx, { ...mountOpts, ...extra });
    },
  };
}
