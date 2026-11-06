// Settings quick access, Host side (R1.3, D63). Backend-neutral: the file list, format and
// masking come from the factory (`configFiles`, `maskConfig`), so this module knows no agent and
// no file format. It serves ONLY the files `configFiles(cwd)` names for the cwd of a live DSH
// session, read-only. It never writes any file (rule 2) and never takes a path from the request
// (rule 12: no route that serves arbitrary files). Unmasked text is never sent in bulk: one
// hidden value at a time, only on an explicit reveal.

import type { AgentBackendFactory, ConfigFileInfo, ConfigSecret } from '@dsh-raw-agent/core';

/** Larger files are not previewed (a settings file is a few KB). */
export const MAX_PREVIEW_BYTES = 1024 * 1024;

export interface ConfigPreviewDeps {
  factories: readonly AgentBackendFactory[];
  /** The cwd of a live DSH session, or undefined when no such session exists. */
  cwdOf(sessionId: string): string | undefined;
  /** Read-only file read. `missing` when the file does not exist. */
  readFile(p: string):
    | { kind: 'ok'; text: string; mtimeMs: number; size: number }
    | { kind: 'missing' }
    | {
        kind: 'error';
        message: string;
      };
}

export interface ConfigPreviewResponse {
  status: number;
  body: unknown;
}

export interface ConfigFileListItem extends ConfigFileInfo {
  exists: boolean;
}

export interface ConfigFilePreview extends ConfigFileInfo {
  exists: boolean;
  /** Masked text; absent when the file does not exist or is too large. */
  masked?: string;
  secrets?: Array<Omit<ConfigSecret, 'sourceStart' | 'sourceEnd'>>;
  mtimeMs?: number;
  size?: number;
  tooLarge?: boolean;
  error?: string;
}

const fail = (status: number, error: string): ConfigPreviewResponse => ({ status, body: { error } });

function pickFactory(deps: ConfigPreviewDeps, kind: string | null): AgentBackendFactory | undefined {
  if (kind === null || kind === '') return deps.factories.find((f) => f.configFiles !== undefined);
  return deps.factories.find((f) => f.kind === kind);
}

async function filesFor(
  url: URL,
  deps: ConfigPreviewDeps,
): Promise<{ factory: AgentBackendFactory; files: ConfigFileInfo[] } | ConfigPreviewResponse> {
  const sessionId = url.searchParams.get('session');
  if (sessionId === null || sessionId === '') return fail(400, 'missing session');
  const factory = pickFactory(deps, url.searchParams.get('backend'));
  if (!factory?.configFiles) return fail(404, 'no settings files for this backend');
  const cwd = deps.cwdOf(sessionId);
  if (cwd === undefined) return fail(404, 'no live session with a folder');
  return { factory, files: await factory.configFiles(cwd) };
}

/** `GET …/config-files?session=<id>[&backend=<kind>]`: the files and whether each exists. */
export async function listConfigFiles(url: URL, deps: ConfigPreviewDeps): Promise<ConfigPreviewResponse> {
  const r = await filesFor(url, deps);
  if ('status' in r) return r;
  const items: ConfigFileListItem[] = r.files.map((f) => ({ ...f, exists: deps.readFile(f.path).kind !== 'missing' }));
  return { status: 200, body: { backend: r.factory.kind, files: items } };
}

/**
 * `GET …/config-file?session=<id>&scope=<scope>[&backend=<kind>][&reveal=<n>]`: one file, masked.
 * With `reveal=<n>` the answer is only the n-th hidden value (`{ index, key, value }`).
 */
export async function previewConfigFile(url: URL, deps: ConfigPreviewDeps): Promise<ConfigPreviewResponse> {
  const r = await filesFor(url, deps);
  if ('status' in r) return r;
  const scope = url.searchParams.get('scope');
  const file = r.files.find((f) => f.scope === scope);
  if (!file) return fail(404, 'unknown settings scope');
  const read = deps.readFile(file.path);
  if (read.kind === 'missing') return { status: 200, body: { ...file, exists: false } satisfies ConfigFilePreview };
  if (read.kind === 'error') return { status: 200, body: { ...file, exists: true, error: read.message } };
  if (read.size > MAX_PREVIEW_BYTES)
    return { status: 200, body: { ...file, exists: true, tooLarge: true, size: read.size, mtimeMs: read.mtimeMs } };

  const masked = r.factory.maskConfig
    ? r.factory.maskConfig({ path: file.path, format: file.format }, read.text)
    : undefined;
  // Without a masker, nothing is known to be safe: show no text at all.
  if (!masked) return { status: 200, body: { ...file, exists: true, error: 'this backend cannot mask this file' } };

  const reveal = url.searchParams.get('reveal');
  if (reveal !== null) {
    const index = Number(reveal);
    const s = Number.isInteger(index) ? masked.secrets[index] : undefined;
    if (!s) return fail(404, 'no such hidden value');
    return { status: 200, body: { index, key: s.key, value: read.text.slice(s.sourceStart, s.sourceEnd) } };
  }
  const body: ConfigFilePreview = {
    ...file,
    exists: true,
    masked: masked.masked,
    secrets: masked.secrets.map(({ start, end, key }) => (key === undefined ? { start, end } : { start, end, key })),
    mtimeMs: read.mtimeMs,
    size: read.size,
  };
  return { status: 200, body };
}
