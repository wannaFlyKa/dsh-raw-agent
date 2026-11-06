// Our `spawnClaudeCodeProcess` (D7, D8). It puts the user's NODE_OPTIONS and DEBUG back, starts
// the CLI in its own process group on POSIX (so D8 can clean up what is left when it dies), and
// records the pid. It never kills anything on Stop (rule 6).

import { spawn as nodeSpawn } from 'node:child_process';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { restoreSdkDeletedVars } from './env.js';

export interface SpawnRecord {
  pid: number | undefined;
  command: string;
  args: string[];
  /** The env the CLI really got, for the S9 raw audit. */
  env: Record<string, string>;
}

export interface ClaudeSpawner {
  spawn: (options: SpawnOptions) => SpawnedProcess;
  /** Set after the SDK has spawned the CLI. */
  readonly record: SpawnRecord | undefined;
  /** POSIX: signal the whole process group (D8). Used only after the CLI has died, or on force stop. */
  killGroup(signal?: NodeJS.Signals): void;
}

export function createSpawner(ourEnv: Readonly<Record<string, string>>, platform = process.platform): ClaudeSpawner {
  let record: SpawnRecord | undefined;
  const spawnFn = (o: SpawnOptions): SpawnedProcess => {
    const env = restoreSdkDeletedVars(o.env, ourEnv);
    const child = nodeSpawn(o.command, o.args, {
      cwd: o.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: o.signal,
      windowsHide: true,
      // Own process group on POSIX (D8). The SDK closes stdin to end the CLI; we do not unref.
      detached: platform !== 'win32',
    });
    // The CLI's stderr is drained so a full pipe never blocks it. Shown only on exit errors (later).
    child.stderr?.on('data', () => {});
    record = { pid: child.pid, command: o.command, args: [...o.args], env };
    // ChildProcess satisfies SpawnedProcess structurally (stdin, stdout, killed, exitCode, kill, on, once, off).
    return child as unknown as SpawnedProcess;
  };
  return {
    spawn: spawnFn,
    get record() {
      return record;
    },
    killGroup(signal: NodeJS.Signals = 'SIGTERM') {
      const pid = record?.pid;
      if (pid === undefined) return;
      try {
        if (platform === 'win32') process.kill(pid, signal);
        else process.kill(-pid, signal);
      } catch {
        // Already gone.
      }
    },
  };
}
