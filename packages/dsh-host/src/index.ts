// Host half of the plugin. Imports only @dsh-raw-agent/core (rule 13); all DSH access goes
// through ./port (D79). This file holds no backend-specific names (D80).

import type { AgentBackendFactory, BackendUserConfig } from '@dsh-raw-agent/core';
import { SessionRegistry, SESSIONS_SERVICE } from './registry.js';
import {
  mountAgent,
  mountConfigRoutes,
  mountHost,
  mountLifecycleRoutes,
  type AgentMount,
  type AgentMountOptions,
  type HostContext,
} from './port/index.js';

export * from './port/index.js';
export { readUserConfig, type RawUserConfig } from './user-config.js';
export {
  AskDesk,
  inputSummary,
  DECLINE,
  KEEP_PLANNING,
  TRUST_ACCEPT,
  TRUST_DECLINE,
  type AskView,
  type AskChoice,
} from './asks.js';
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
  type ReturnedDraft,
  type SessionRegistryOptions,
  type RegisteredRuntime,
} from './registry.js';
export {
  SessionRuntime,
  SETTINGS_CHOICE,
  STOP_GRACE_MS,
  crashMessage,
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
} from './driver.js';

export interface RawAgentHostOptions {
  /** Passed by the composition root (packages/plugin), one per backend kind (D80). */
  factories: readonly AgentBackendFactory[];
  /** Test-only catalog rows (live suites pick a cheap model per session); empty in normal use. */
  seedModels?: readonly string[];
  /** Read at every spawn (D87). The composition root builds it from the volatile entry config. */
  userConfig?: () => BackendUserConfig;
  /** Idle-reap timeout in minutes (D6); off when unset or 0. Read at every check (volatile, D87). */
  idleReapMinutes?: () => number | undefined;
}

/** The agent row's config (D81): only the backend kind. */
export interface AgentEntryConfig {
  backend?: string;
}

export interface RawAgentHost {
  readonly factories: readonly AgentBackendFactory[];
  /** The Host entry's backend-session registry (D87), provided as the `rawAgentSessions` service. */
  readonly sessions: SessionRegistry;
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
  return {
    factories: options.factories,
    sessions,
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
