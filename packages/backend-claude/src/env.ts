// Environment policy (rule 5, D17a, D7).
//
// Start from the DSH process env and delete only what belongs to a *host* Claude Code session.
// Never drop the user's tokens or keys. Re-check the list on every CLI upgrade: the names come
// from minified CLI code (raw-baseline §2 "Final list").

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
 * `query()` writes `CLAUDE_AGENT_SDK_VERSION` into the DSH process env (SDK/sdk.mjs `query()`),
 * which every later DSH child would inherit. Run `fn` and restore the previous value (D7).
 */
export function withSdkVersionEnvRestored<T>(fn: () => T, target: NodeJS.ProcessEnv = process.env): T {
  const had = Object.prototype.hasOwnProperty.call(target, 'CLAUDE_AGENT_SDK_VERSION');
  const before = target.CLAUDE_AGENT_SDK_VERSION;
  try {
    return fn();
  } finally {
    if (had) target.CLAUDE_AGENT_SDK_VERSION = before;
    else delete target.CLAUDE_AGENT_SDK_VERSION;
  }
}
