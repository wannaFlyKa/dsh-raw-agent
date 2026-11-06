// Agent entry (`dsh-raw-agent/agent`), mounted by the `raw-agent-<kind>` preset row (D81). It
// registers the driver, the prepend guard and the scoped job controller. It is its own bundle
// (lib/agent.js): it owns the backend sessions of the agents composed under its preset.

import { createClaudeFactory } from '@dsh-raw-agent/backend-claude';
import { createRawAgentHost, type AgentEntryConfig, type HostContext } from '@dsh-raw-agent/dsh-host';

export const name = 'dsh-raw-agent-driver';

const host = createRawAgentHost({ factories: [createClaudeFactory()] });

export function apply(ctx: HostContext, config?: AgentEntryConfig): void {
  host.applyAgent(ctx, config);
}
