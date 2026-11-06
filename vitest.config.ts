import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against sources, so `pnpm test` needs no prior build.
    alias: [
      {
        find: /^@dsh-raw-agent\/core\/node$/,
        replacement: fileURLToPath(new URL('./packages/core/src/node.ts', import.meta.url)),
      },
      { find: /^@dsh-raw-agent\/core$/, replacement: src('core') },
      { find: /^@dsh-raw-agent\/backend-claude$/, replacement: src('backend-claude') },
      { find: /^@dsh-raw-agent\/dsh-host$/, replacement: src('dsh-host') },
      { find: /^@dsh-raw-agent\/dsh-client$/, replacement: src('dsh-client') },
      { find: /^@dsh-raw-agent\/views-claude$/, replacement: src('views-claude') },
      { find: /^@dsh-raw-agent\/testkit$/, replacement: src('testkit') },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
  },
});
