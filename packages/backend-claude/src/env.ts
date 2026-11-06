// Environment policy (rule 5, D17a, D7).
//
// Start from the DSH process env and delete only what belongs to a *host* Claude Code session.
// Never drop the user's tokens or keys. Re-check the list on every CLI upgrade: the names come
// from minified CLI code (raw-baseline §2 "Final list"). Re-verified against CLI 2.1.318 in M1:
// the child-marker builder (`udt`) still sets exactly CLAUDECODE, CLAUDE_CODE_SESSION_ID,
// CLAUDE_CODE_CHILD_SESSION, CLAUDE_CODE_SESSION_ATTENDED, CLAUDE_PID, AI_AGENT, CLAUDE_EFFORT and
// TRACEPARENT; `pnpm test:cli-constants` repeats the check against the installed binary.

/** Always deleted (case-insensitive on Windows). */
export const HOST_SESSION_VARS: readonly string[] = Object.freeze([
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_KIND',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_DESKTOP_APP_VERSION',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
]);

/** Deleted only under a condition (see `buildClaudeEnv`). */
export const CONDITIONAL_HOST_VARS: readonly string[] = Object.freeze(['AI_AGENT', 'TRACEPARENT', 'TRACESTATE']);

/**
 * Names a host Claude Code session puts into its tool children that we keep on purpose. They are
 * not CLI inputs, or the CLI sets the same value itself (CLI 2.1.318 binary: Bash env builder,
 * MCP env builder, startup). `pnpm test:cli-constants` fails on any new marker name that is in
 * none of the three lists, so a CLI upgrade cannot add one silently.
 */
export const KEPT_HOST_MARKERS: readonly string[] = Object.freeze([
  // Set for Bash, hook and MCP children; the CLI never reads it from its own env (no env
  // accessor in 2.1.318) and overwrites it for its own children.
  'CLAUDE_PROJECT_DIR',
  // Set for MCP children only; read only to gate the Chrome MCP server. A DSH started as a
  // Claude Code MCP server is not a supported setup.
  'CLAUDE_CODE_CHROME_MCP_ORG_DENIED',
  'GIT_EDITOR',
  'COREPACK_ENABLE_AUTO_PIN',
  'NoDefaultCurrentDirectoryInExePath',
  'SHELL',
]);

const DSH_SECRET = /KEY|PASSWORD|SECRET|TOKEN/i;

export type RemovalReason = 'host-session' | 'host-agent-marker' | 'host-trace' | 'dsh-secret';

export interface ClaudeEnvResult {
  env: Record<string, string>;
  removed: Array<{ name: string; reason: RemovalReason }>;
}

/**
 * Build the env for the CLI. Names are compared case-insensitively on Windows, where env names
 * are case-insensitive. Values that are `undefined` are dropped (they cannot be passed on).
 */
export function buildClaudeEnv(
  source: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): ClaudeEnvResult {
  const norm = (n: string) => (platform === 'win32' ? n.toUpperCase() : n);
  const always = new Set(HOST_SESSION_VARS.map(norm));
  const hadClaudeCode = Object.keys(source).some((k) => norm(k) === norm('CLAUDECODE') && source[k] !== undefined);

  const env: Record<string, string> = {};
  const removed: ClaudeEnvResult['removed'] = [];
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const n = norm(name);
    let reason: RemovalReason | undefined;
    if (always.has(n)) reason = 'host-session';
    else if (n === norm('AI_AGENT') && value.startsWith('claude-code')) reason = 'host-agent-marker';
    else if ((n === norm('TRACEPARENT') || n === norm('TRACESTATE')) && hadClaudeCode) reason = 'host-trace';
    else if (name.toUpperCase().startsWith('DSH_') && DSH_SECRET.test(name)) reason = 'dsh-secret';
    if (reason !== undefined) removed.push({ name, reason });
    else env[name] = value;
  }
  return { env, removed };
}

/** Names the SDK deletes from the env it hands to the spawner; our spawner puts them back (D7). */
export const SDK_DELETED_VARS: readonly string[] = Object.freeze(['NODE_OPTIONS', 'DEBUG']);

/**
 * The env the CLI really gets: the SDK's env (ours plus its own additions) with the user's
 * `NODE_OPTIONS` and `DEBUG` restored. When the user had none, the SDK's choice stands.
 */
export function restoreSdkDeletedVars(
  sdkEnv: Readonly<Record<string, string | undefined>>,
  ours: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sdkEnv)) if (v !== undefined) out[k] = v;
  for (const name of SDK_DELETED_VARS) {
    const v = ours[name];
    if (v !== undefined) out[name] = v;
  }
  return out;
}

/**
 * Names the SDK writes into the env of the *DSH process* (not only the CLI's env), which every
 * later DSH child (Standard-session shells, the DSH terminal, a `claude` the user starts there)
 * would inherit (D7):
 * - `CLAUDE_AGENT_SDK_VERSION`: written by every `query()` call (SDK/sdk.mjs `query()`).
 * - `NoDefaultCurrentDirectoryInExePath=1`: written once at SDK module load, on every OS
 *   (SDK/sdk.mjs top level; verified live with SDK 0.3.318: unset before `import()`, `1` after).
 *   Only Windows reads it: `cmd.exe` and `CreateProcess` stop searching the current folder for
 *   executables. The CLI sets the same value on its own process at startup (CLI 2.1.318 binary,
 *   main entry), so restoring it in the DSH process changes nothing for Claude Code.
 */
export const SDK_PROCESS_ENV_WRITES: readonly string[] = Object.freeze([
  'CLAUDE_AGENT_SDK_VERSION',
  'NoDefaultCurrentDirectoryInExePath',
]);

function snapshotEnv(names: readonly string[], target: NodeJS.ProcessEnv): () => void {
  const saved = names.map((n) => [n, Object.prototype.hasOwnProperty.call(target, n), target[n]] as const);
  return () => {
    for (const [n, had, v] of saved) {
      if (had && v !== undefined) target[n] = v;
      else delete target[n];
    }
  };
}

/** Run `fn` and put the listed names of `target` back as they were, also when `fn` throws. */
export function withProcessEnvRestored<T>(
  names: readonly string[],
  fn: () => T,
  target: NodeJS.ProcessEnv = process.env,
): T {
  const restore = snapshotEnv(names, target);
  let result: T;
  try {
    result = fn();
  } catch (e) {
    restore();
    throw e;
  }
  if (result instanceof Promise) {
    return result.finally(restore) as T;
  }
  restore();
  return result;
}

/**
 * `query()` writes `CLAUDE_AGENT_SDK_VERSION` into the DSH process env (SDK/sdk.mjs `query()`),
 * which every later DSH child would inherit. Run `fn` and restore the previous value (D7).
 */
export function withSdkVersionEnvRestored<T>(fn: () => T, target: NodeJS.ProcessEnv = process.env): T {
  return withProcessEnvRestored(['CLAUDE_AGENT_SDK_VERSION'], fn, target);
}
