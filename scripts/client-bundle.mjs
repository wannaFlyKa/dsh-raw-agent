// esbuild options for the client entry (packages/plugin/lib/client.js). Shared by bundle.mjs and
// the bundle test, so the test checks the exact format we ship.
//
// Format: DSH's module-loader format, a lazy factory whose id is the package name
// (P/dsh-client-modules README, "Lazy-CJS model"): `window.__ModuleLoader__.load({id,
// factory(require)})`. The body is CommonJS; React and react-dom come from DSH's shared module
// table through the factory's `require` (architecture §8), never bundled. JSX is the classic
// transform, so only `require('react')` is needed (no `react/jsx-runtime`).

export const CLIENT_ID = 'dsh-raw-agent';
export const CLIENT_EXTERNAL = ['react', 'react-dom', 'react/*', 'react-dom/*'];

/** @param {{ root: string, alias: Record<string, string>, write?: boolean }} o */
export function clientBuildOptions({ root, alias, write = true }) {
  return {
    entryPoints: [`${root}packages/plugin/src/client.ts`],
    outfile: `${root}packages/plugin/lib/client.js`,
    bundle: true,
    write,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    jsx: 'transform',
    external: [...CLIENT_EXTERNAL, '@deepseek-ai/*', 'cordis', '@cordisjs/*'],
    conditions: ['source'],
    alias,
    banner: {
      js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_ID)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
    },
    footer: { js: 'return module.exports; } });' },
    logLevel: 'warning',
    metafile: true,
  };
}
