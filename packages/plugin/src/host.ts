// Composition root (D80): the only place that imports backend-claude. It passes the factory
// list to dsh-host. The bundle (scripts/bundle.mjs) inlines our packages and keeps the SDK external.
//
// This is the Host entry (`dsh-raw-agent`): catalog providers. The agent entry
// (`dsh-raw-agent/agent`, src/agent.ts) is mounted by the preset row in cordis.patch.yml.

import { createClaudeFactory } from '@dsh-raw-agent/backend-claude';
import { createRawAgentHost, type HostContext } from '@dsh-raw-agent/dsh-host';

export const name = 'dsh-raw-agent';

// Test-only: `DSH_RAW_AGENT_TEST_MODELS=a,b` adds catalog rows so a live suite can pick a cheap
// model per session (D35 → setModel). Unset in normal use.
const seedModels = (process.env.DSH_RAW_AGENT_TEST_MODELS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const host = createRawAgentHost({ factories: [createClaudeFactory()], seedModels });

export function apply(ctx: HostContext): void {
  host.apply(ctx);
}
