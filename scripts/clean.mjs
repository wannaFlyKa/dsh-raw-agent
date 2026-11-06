// Remove build output of every workspace package (lib/ only).
import { readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkgs = fileURLToPath(new URL('../packages/', import.meta.url));
for (const name of readdirSync(pkgs)) rmSync(`${pkgs}${name}/lib`, { recursive: true, force: true });
