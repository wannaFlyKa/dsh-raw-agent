// File checkpoints (D16). The TUI checkpoints files by default; SDK mode does so only with
// `enableFileCheckpointing`. We pass it unless the user turned checkpoints off where the CLI
// reads that choice. All reads are read-only (D63); we never write these files (rule 2).

import * as path from 'node:path';

export interface CheckpointReadDeps {
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  homedir: string;
  cwd: string;
  /** File text, or undefined when missing or unreadable. */
  readText(p: string): string | undefined;
}

export interface CheckpointDecision {
  enabled: boolean;
  /** Where the "off" came from, for the panel and tests. */
  disabledBy?: string;
}

/**
 * Managed (policy) settings file per OS. **Unverified** for CLI 2.1.318 (architecture §12 Q4).
 * Policy that arrives through OS management profiles or remote managed settings is not read.
 */
export function managedSettingsPath(platform: NodeJS.Platform): string | undefined {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (platform === 'linux') return '/etc/claude-code/managed-settings.json';
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json';
  return undefined;
}

/** The CLI's config folder: `CLAUDE_CONFIG_DIR` when set, else `~/.claude`. */
export function claudeConfigDir(env: CheckpointReadDeps['env'], homedir: string, platform: NodeJS.Platform): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dir = env.CLAUDE_CONFIG_DIR;
  return dir !== undefined && dir !== '' ? dir : p.join(homedir, '.claude');
}

/**
 * The CLI's global config file (`~/.claude.json`). With `CLAUDE_CONFIG_DIR` set the CLI keeps it
 * inside that folder (**unverified** for 2.1.318).
 */
export function claudeGlobalConfigPath(
  env: CheckpointReadDeps['env'],
  homedir: string,
  platform: NodeJS.Platform,
): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dir = env.CLAUDE_CONFIG_DIR;
  return dir !== undefined && dir !== '' ? p.join(dir, '.claude.json') : p.join(homedir, '.claude.json');
}

function envTruthy(v: string | undefined): boolean {
  if (v === undefined) return false;
  const s = v.trim().toLowerCase();
  return s !== '' && s !== '0' && s !== 'false' && s !== 'no' && s !== 'off';
}

function readJson(deps: CheckpointReadDeps, file: string): Record<string, unknown> | undefined {
  const text = deps.readText(file);
  if (text === undefined) return undefined;
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function decideFileCheckpointing(deps: CheckpointReadDeps): CheckpointDecision {
  if (envTruthy(deps.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING)) {
    return { enabled: false, disabledBy: 'env:CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING' };
  }
  const p = deps.platform === 'win32' ? path.win32 : path.posix;
  const configDir = claudeConfigDir(deps.env, deps.homedir, deps.platform);
  const sources: Array<[string, string | undefined]> = [
    ['user', p.join(configDir, 'settings.json')],
    ['project', p.join(deps.cwd, '.claude', 'settings.json')],
    ['local', p.join(deps.cwd, '.claude', 'settings.local.json')],
    ['policy', managedSettingsPath(deps.platform)],
    ['global-config', claudeGlobalConfigPath(deps.env, deps.homedir, deps.platform)],
  ];
  for (const [label, file] of sources) {
    if (file === undefined) continue;
    const json = readJson(deps, file);
    if (json?.fileCheckpointingEnabled === false) return { enabled: false, disabledBy: label };
  }
  return { enabled: true };
}
