// Host half of the plugin. Imports only @dsh-raw-agent/core (rule 13); all DSH access goes
// through ./port (D79). This file holds no backend-specific names (D80).

import type { AgentBackendFactory } from '@dsh-raw-agent/core';
import { mountAgent, mountHost, type AgentMount, type AgentMountOptions, type HostContext } from './port/index.js';

export * from './port/index.js';
export {
  SessionRuntime,
  STOP_GRACE_MS,
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
}

/** The agent row's config (D81): only the backend kind. */
export interface AgentEntryConfig {
  backend?: string;
}

export interface RawAgentHost {
  readonly factories: readonly AgentBackendFactory[];
  /** The Host entry: catalog providers (D34). */
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
  return {
    factories: options.factories,
    apply(ctx) {
      mountHost(ctx, options.factories, options.seedModels ?? []);
    },
    applyAgent(ctx, config, extra) {
      const kind = config?.backend ?? options.factories[0]?.kind;
      const factory = options.factories.find((f) => f.kind === kind);
      if (!factory) throw new Error(`Unknown backend kind: ${String(kind)}`);
      // D76 needs our catalog row, which the Host entry registers when the llm service exists.
      const llm = ctx.get('llm') as { registerAdapter?: unknown } | undefined;
      return mountAgent(ctx, { factory, selectSettingsModel: typeof llm?.registerAdapter === 'function', ...extra });
    },
  };
}
