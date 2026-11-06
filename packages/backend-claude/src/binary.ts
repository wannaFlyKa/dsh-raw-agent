// Binary resolution (rule 1, D10). We always set `pathToClaudeCodeExecutable`, so the SDK never
// looks for its bundled CLI.
//
// Order: the configured path, else the first `claude` on PATH, else `~/.local/bin/claude`.
// On Windows the PATH search also tries `claude.exe`, and an npm `claude.cmd` shim is followed
// to its target. All file access is injected, so the logic is testable on every OS.

import * as path from 'node:path';

export interface BinaryResolveDeps {
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  homedir: string;
  /** True when `p` is an existing regular file (and executable on POSIX). */
  isExecutable(p: string): boolean;
  /** File text, or undefined when it cannot be read. Used for the Windows npm shim. */
  readText(p: string): string | undefined;
}

export type BinarySource = 'configured' | 'path' | 'local-bin';

export interface ResolvedBinary {
  path: string;
  source: BinarySource;
}

export class ClaudeBinaryNotFoundError extends Error {
  constructor(
    message: string,
    readonly tried: string[],
  ) {
    super(message);
    this.name = 'ClaudeBinaryNotFoundError';
  }
}

function envGet(env: BinaryResolveDeps['env'], name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[name];
  const upper = name.toUpperCase();
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() === upper) return v;
  return undefined;
}

/**
 * Follow an npm `.cmd` shim to the file it runs. npm shims end with a line such as
 * `"%_prog%"  "%dp0%\node_modules\@anthropic-ai\claude-code\cli.js" %*` or reference a `.exe`.
 * **Unverified** for every npm version; when the target cannot be found we return the shim
 * itself, which the SDK cannot run, so the caller keeps looking.
 */
export function npmShimTarget(shimPath: string, text: string): string | undefined {
  const dir = path.win32.dirname(shimPath);
  const re = /"%~?dp0%?\\([^"]+\.(?:exe|js|mjs|cjs))"/gi;
  let match: RegExpExecArray | null;
  let last: string | undefined;
  while ((match = re.exec(text)) !== null) last = match[1];
  return last === undefined ? undefined : path.win32.join(dir, last);
}

/**
 * The configured path as the user typed it in the plugin settings (D87): surrounding spaces and
 * quotes removed, a leading `~` expanded to the home folder. Empty means "not configured".
 */
export function normalizeConfiguredPath(
  configured: string | undefined,
  homedir: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (configured === undefined) return undefined;
  let c = configured.trim();
  if (c.length >= 2 && ((c.startsWith('"') && c.endsWith('"')) || (c.startsWith("'") && c.endsWith("'"))))
    c = c.slice(1, -1).trim();
  if (c === '') return undefined;
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (c === '~') return homedir;
  if (c.startsWith('~/') || (platform === 'win32' && c.startsWith('~\\'))) return p.join(homedir, c.slice(2));
  return c;
}

export function resolveClaudeBinary(configured: string | undefined, deps: BinaryResolveDeps): ResolvedBinary {
  const tried: string[] = [];
  const p = deps.platform === 'win32' ? path.win32 : path.posix;

  const c = normalizeConfiguredPath(configured, deps.homedir, deps.platform);
  if (c !== undefined) {
    tried.push(c);
    if (deps.isExecutable(c)) return { path: c, source: 'configured' };
    throw new ClaudeBinaryNotFoundError(
      `The configured Claude Code path does not exist or is not executable: ${c}`,
      tried,
    );
  }

  const pathVar = envGet(deps.env, 'PATH', deps.platform) ?? '';
  const sep = deps.platform === 'win32' ? ';' : ':';
  const names = deps.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  for (const dir of pathVar.split(sep)) {
    if (dir === '') continue;
    for (const name of names) {
      const candidate = p.join(dir, name);
      tried.push(candidate);
      if (!deps.isExecutable(candidate)) continue;
      if (name.endsWith('.cmd')) {
        const text = deps.readText(candidate);
        const target = text === undefined ? undefined : npmShimTarget(candidate, text);
        if (target !== undefined && deps.isExecutable(target)) return { path: target, source: 'path' };
        continue;
      }
      return { path: candidate, source: 'path' };
    }
  }

  const localNames = deps.platform === 'win32' ? ['claude.exe', 'claude'] : ['claude'];
  for (const name of localNames) {
    const candidate = p.join(deps.homedir, '.local', 'bin', name);
    tried.push(candidate);
    if (deps.isExecutable(candidate)) return { path: candidate, source: 'local-bin' };
  }

  throw new ClaudeBinaryNotFoundError(
    'Claude Code was not found. Install it, or set the path to your `claude` in the plugin settings.',
    tried,
  );
}
