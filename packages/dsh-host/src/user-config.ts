// Backend user config from a Cordis entry config (D87). Runtime-editable fields are volatile in
// the entry's Schemastery schema, so the loader hands them over as references with `get()`
// (`P/cosmokit/lib/index.js` `createVolatile`; `P/cordis-plugin-loader/README.md` "Volatile
// configuration"). We read them at every spawn and never cache the value, so an edit applies to
// the next spawn and never remounts the entry (rules 6, 7). Plain values (tests, a non-volatile
// schema) are read the same way.

import type { BackendUserConfig } from '@dsh-raw-agent/core';

/** The raw entry config shape: each field may be a plain value or a volatile reference. */
export interface RawUserConfig {
  executablePath?: unknown;
  options?: unknown;
}

function current(v: unknown): unknown {
  if (v !== null && typeof v === 'object' && typeof (v as { get?: unknown }).get === 'function')
    return (v as { get(): unknown }).get();
  return v;
}

export function readUserConfig(raw: RawUserConfig | undefined): BackendUserConfig {
  const out: BackendUserConfig = { options: {} };
  if (!raw) return out;
  const path = current(raw.executablePath);
  if (typeof path === 'string' && path.trim() !== '') out.executablePath = path;
  const opts = current(raw.options);
  if (opts !== null && typeof opts === 'object' && !Array.isArray(opts)) {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(opts as Record<string, unknown>)) o[k] = current(v);
    out.options = o;
  }
  return out;
}
