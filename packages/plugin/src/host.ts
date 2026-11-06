// Composition root (D80): the only place that imports backend-claude. It passes the factory
// list to dsh-host. The bundle (scripts/bundle.mjs) inlines our packages and keeps the SDK external.
//
// This is the Host entry (`dsh-raw-agent`): catalog providers. The agent entry
// (`dsh-raw-agent/agent`, src/agent.ts) is mounted by the preset row in cordis.patch.yml.

import { createClaudeFactory } from '@dsh-raw-agent/backend-claude';
import {
  createRawAgentHost,
  readUserConfig,
  setJobWaitForTests,
  type HostContext,
  type RawUserConfig,
} from '@dsh-raw-agent/dsh-host';

export const name = 'dsh-raw-agent';

// Test-only: `DSH_RAW_AGENT_TEST_MODELS=a,b` adds catalog rows so a live suite can pick a cheap
// model per session (D35 → setModel). Unset in normal use.
const seedModels = (process.env.DSH_RAW_AGENT_TEST_MODELS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Test-only: `DSH_RAW_AGENT_TEST_JOB_WAIT_MS=<ms>` shortens the job waits (D47) so a live suite can
// run a task longer than one wait. Unset in normal use (1 h waits).
const testJobWait = Number(process.env.DSH_RAW_AGENT_TEST_JOB_WAIT_MS ?? '');
if (testJobWait > 0) setJobWaitForTests(testJobWait);

// The Host entry's config (D87): `executablePath` and backend `options` (Claude: the bypass
// switch, D14). Read at every spawn, never cached. No Schemastery schema is exported yet (S7), so
// the loader hands the row's plain config; an edit through DSH's config surface remounts the entry.
let entryConfig: RawUserConfig | undefined;

const host = createRawAgentHost({
  factories: [createClaudeFactory()],
  seedModels,
  userConfig: () => readUserConfig(entryConfig),
});

export function apply(ctx: HostContext, config?: RawUserConfig): void {
  entryConfig = config;
  host.apply(ctx);
}
