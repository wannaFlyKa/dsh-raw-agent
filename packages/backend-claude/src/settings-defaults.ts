// Read-only preview of what the user's own settings pick for a new session (R1.4, D83). Display only:
// the plugin passes no model, effort or mode at spawn (rule 4); the CLI applies its own settings.
//
// Precedence as we understand the CLI (**unverified** in detail for 2.1.318):
// - model: `ANTHROPIC_MODEL` (process env, then a settings `env` block) > `model` in local > project
//   > user settings;
// - effort: `CLAUDE_CODE_EFFORT_LEVEL` (same env order) > `effortLevel` in local > project > user;
// - permission mode: `permissions.defaultMode` in local > project > user.
// Managed (policy) settings and flag settings are not read; the live process reports the truth.

import type { ConfigFileInfo, SettingsDefaults, SettingsKeySource } from '@dsh-raw-agent/core';

type Json = Record<string, unknown>;

/** Strip comments and trailing commas, then parse. Undefined when the text is not an object. */
export function parseSettingsText(text: string): Json | undefined {
  let out = '';
  for (let i = 0; i < text.length;) {
    const c = text[i]!;
    if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 2;
    } else out += text[i++];
  }
  try {
    const v: unknown = JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
  } catch {
    return undefined;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const obj = (v: unknown): Json | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;

/**
 * @param files - the three files from `claudeConfigFiles`, any order.
 * @param readText - read-only file read; undefined when missing.
 * @param env - the env the CLI would get (after the env policy).
 */
export function readSettingsDefaults(
  files: readonly ConfigFileInfo[],
  readText: (p: string) => string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): SettingsDefaults {
  const order = ['local', 'project', 'user'];
  const parsed = order
    .map((scope) => files.find((f) => f.scope === scope))
    .filter((f): f is ConfigFileInfo => f !== undefined)
    .map((f) => {
      const text = readText(f.path);
      return { scope: f.scope, json: text === undefined ? undefined : parseSettingsText(text) };
    });
  const out: SettingsDefaults = { sources: {} };
  const fromEnv = (name: string): { value: string; source: string } | undefined => {
    const direct = str(env[name]);
    if (direct !== undefined) return { value: direct, source: 'env' };
    for (const p of parsed) {
      const v = str(obj(p.json?.env)?.[name]);
      if (v !== undefined) return { value: v, source: `${p.scope} env` };
    }
    return undefined;
  };
  const fromFiles = (pick: (j: Json) => unknown): { value: string; source: string } | undefined => {
    for (const p of parsed) {
      const v = p.json ? str(pick(p.json)) : undefined;
      if (v !== undefined) return { value: v, source: p.scope };
    }
    return undefined;
  };
  const model = fromEnv('ANTHROPIC_MODEL') ?? fromFiles((j) => j.model);
  if (model) {
    out.model = model.value;
    out.sources.model = model.source;
  }
  const effort = fromEnv('CLAUDE_CODE_EFFORT_LEVEL') ?? fromFiles((j) => j.effortLevel);
  if (effort) {
    out.effort = effort.value;
    out.sources.effort = effort.source;
  }
  const mode = fromFiles((j) => obj(j.permissions)?.defaultMode);
  if (mode) {
    out.permissionMode = mode.value;
    out.sources.permissionMode = mode.source;
  }
  const keys = settingsKeySources(parsed);
  if (keys.length > 0) out.keys = keys;
  return out;
}

/**
 * D63: which layer sets each top-level key (local > project > user). Object and list values set
 * in more than one layer are `merged`: the CLI combines them (for example `permissions.allow`
 * lists). The exact merge rules of CLI 2.1.318 are **unverified**; this is a display aid only.
 */
export function settingsKeySources(
  parsed: ReadonlyArray<{ scope: string; json: Json | undefined }>,
): SettingsKeySource[] {
  const map = new Map<string, { scopes: string[]; objects: number }>();
  for (const p of parsed) {
    if (!p.json) continue;
    for (const [key, value] of Object.entries(p.json)) {
      if (key === '$schema') continue;
      const e = map.get(key) ?? { scopes: [], objects: 0 };
      e.scopes.push(p.scope);
      if (value !== null && typeof value === 'object') e.objects++;
      map.set(key, e);
    }
  }
  return [...map]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, e]) => {
      const k: SettingsKeySource = { key, scopes: e.scopes };
      if (e.scopes.length > 1 && e.objects > 1) k.merged = true;
      return k;
    });
}
