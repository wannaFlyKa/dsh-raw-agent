// Bundles the published plugin (architecture §8). Our workspace packages are inlined; the Claude
// Agent SDK stays external (a normal dependency of the plugin, D11), and DSH / Cordis are never
// bundled (D65: no runtime import at all). Node built-ins stay external.
import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { clientBuildOptions } from './client-bundle.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const plugin = `${root}packages/plugin`;

const external = [
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/claude-agent-sdk/*',
  '@deepseek-ai/*',
  'cordis',
  '@cordisjs/*',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

const entries = [
  { in: `${plugin}/src/host.ts`, out: `${plugin}/lib/host.js`, platform: 'node' },
  // The agent entry (`dsh-raw-agent/agent`) mounted by the preset row. Its own bundle, so it never
  // depends on sharing module state with the Host entry across loader generations.
  { in: `${plugin}/src/agent.ts`, out: `${plugin}/lib/agent.js`, platform: 'node' },
];

// The client entry (lib/client.js): see scripts/client-bundle.mjs.

const alias = {
  '@dsh-raw-agent/core/node': `${root}packages/core/src/node.ts`,
  '@dsh-raw-agent/core': `${root}packages/core/src/index.ts`,
  '@dsh-raw-agent/backend-claude': `${root}packages/backend-claude/src/index.ts`,
  '@dsh-raw-agent/dsh-host': `${root}packages/dsh-host/src/index.ts`,
  '@dsh-raw-agent/dsh-client': `${root}packages/dsh-client/src/index.ts`,
};

function checkInputs(result, out) {
  const inputs = Object.keys(result.metafile.inputs);
  const bad = inputs.filter(
    (p) =>
      p.includes('node_modules/@anthropic-ai/') ||
      p.includes('node_modules/@deepseek-ai/') ||
      /node_modules\/(?:\.pnpm\/)?react(?:-dom)?[@/]/.test(p),
  );
  if (bad.length > 0) throw new Error(`bundle inlined an external package: ${bad.join(', ')}`);
  console.log(`bundled ${out.slice(root.length)} (${inputs.length} inputs)`);
}

for (const e of entries) {
  if (!existsSync(e.in)) continue;
  const result = await build({
    entryPoints: [e.in],
    outfile: e.out,
    bundle: true,
    format: 'esm',
    platform: e.platform,
    target: 'node24',
    sourcemap: true,
    external,
    // Bundle our packages from source so the bundle never depends on a stale lib/.
    conditions: ['source'],
    alias,
    logLevel: 'warning',
    metafile: true,
  });
  checkInputs(result, e.out);
}

const clientIn = `${plugin}/src/client.ts`;
if (existsSync(clientIn)) {
  const options = clientBuildOptions({ root, alias });
  checkInputs(await build(options), options.outfile);
}
