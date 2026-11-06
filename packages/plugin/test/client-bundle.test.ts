// The client bundle in the exact format we ship (scripts/client-bundle.mjs): DSH's module-loader
// format with React from the factory's `require` (architecture §8). It must register one lazy
// factory whose id is the package name, keep React external, and mount the session controls.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs build script without types
import { CLIENT_ID, clientBuildOptions } from '../../../scripts/client-bundle.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const alias = {
  '@dsh-raw-agent/core': `${root}packages/core/src/index.ts`,
  '@dsh-raw-agent/dsh-client': `${root}packages/dsh-client/src/index.ts`,
};
const reactRequire = createRequire(`${root}packages/dsh-client/package.json`);

describe('client bundle (module-loader format)', () => {
  it('registers one factory named after the package and keeps React external', async () => {
    const result = await build({ ...clientBuildOptions({ root, alias, write: false }), logLevel: 'silent' });
    const js = result.outputFiles!.find((f) => f.path.endsWith('client.js'))!.text;
    expect(js.startsWith(`window.__ModuleLoader__.load({ id: "${CLIENT_ID}"`)).toBe(true);
    expect(CLIENT_ID).toBe('dsh-raw-agent');
    const inputs = Object.keys(result.metafile!.inputs);
    expect(inputs.some((p) => /node_modules\/.*react/.test(p))).toBe(false);
    expect(inputs.some((p) => p.includes('backend-claude') || p.includes('dsh-host'))).toBe(false);

    const requested: string[] = [];
    const loads: Array<{ id: string; factory: (req: (id: string) => unknown) => Record<string, unknown> }> = [];
    const window = { __ModuleLoader__: { load: (row: (typeof loads)[number]) => void loads.push(row) } };
    new Function('window', js)(window);
    expect(loads).toHaveLength(1);
    expect(loads[0]!.id).toBe('dsh-raw-agent');
    const mod = loads[0]!.factory((id) => {
      requested.push(id);
      return reactRequire(id);
    });
    expect([...new Set(requested)].sort()).toEqual(['react', 'react-dom']);
    expect(mod.name).toBe('dsh-raw-agent-client');
    expect(mod.inject).toEqual(['slots']);

    const slots: string[] = [];
    (mod.apply as (ctx: unknown) => void)({
      slots: {
        inject: (key: string, cb: () => unknown) => (slots.push(key), cb(), () => {}),
        register: (o: { name: string }) => (slots.push(`register ${o.name}`), () => {}),
      },
      get: () => undefined,
      effect: () => {},
    });
    expect(slots).toEqual(['conversation.input.left', 'register conversation.input.left']);
  });
});
