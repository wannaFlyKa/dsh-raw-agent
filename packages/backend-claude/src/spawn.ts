// Our `spawnClaudeCodeProcess` (D7, D8). It puts the user's NODE_OPTIONS and DEBUG back, starts
// the CLI in its own process group on POSIX (so D8 can clean up what is left when it dies), and
// records the pid. It never kills anything on Stop (rule 6).

import { spawn as nodeSpawn } from 'node:child_process';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { restoreSdkDeletedVars } from './env.js';
import type { ProcessExit } from './lifecycle.js';
import { startOrphanGuard, type OrphanGuard, type OrphanGuardOptions } from './orphan-guard.js';

/** How much of the CLI's stderr is kept for the exit report (R3.6). */
export const STDERR_KEEP_BYTES = 16 * 1024;

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
  /**
   * R3.6: how the latest CLI ended (code, signal, the end of its stderr). Waits up to `waitMs`
   * for the exit to be seen; undefined when no CLI was spawned or it is still running.
   */
  exitInfo(waitMs?: number): Promise<ProcessExit | undefined>;
  /**
   * M8: a new CLI is about to start (the plain restart after a refused fork cut, D29). Until it
   * spawns, `exitInfo` knows no exit: the old CLI's end never stands for the new one's.
   */
  expectNew(): void;
}

/** One spawned CLI: its own exit, never shared with another spawn (M8). */
interface ChildExit {
  exit: Promise<ProcessExit>;
  exited?: ProcessExit;
}

export interface SpawnerOptions {
  /** D75: start an orphan guard per CLI (default true). */
  orphanGuard?: boolean;
  /** Test seam and tuning for the guard. */
  guard?: Omit<OrphanGuardOptions, 'cliPid'>;
  /** Test seam: the process spawn. */
  spawn?: typeof nodeSpawn;
}

export function createSpawner(
  ourEnv: Readonly<Record<string, string>>,
  platform = process.platform,
  options: SpawnerOptions = {},
): ClaudeSpawner {
  let record: SpawnRecord | undefined;
  /** The newest CLI's exit; undefined before the first spawn and after `expectNew`. */
  let current: ChildExit | undefined;
  const spawnFn = (o: SpawnOptions): SpawnedProcess => {
    const env = restoreSdkDeletedVars(o.env, ourEnv);
    const child = (options.spawn ?? nodeSpawn)(o.command, o.args, {
      cwd: o.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: o.signal,
      windowsHide: true,
      // Own process group on POSIX (D8). The SDK closes stdin to end the CLI; we do not unref.
      detached: platform !== 'win32',
    });
    // The CLI's stderr is drained so a full pipe never blocks it; its end is kept for the exit
    // report (R3.6). Its last lines show in the plugin UI only; the host log gets a short reason (M8).
    let stderr = '';
    child.stderr?.on('data', (d: Buffer | string) => {
      stderr += String(d);
      if (stderr.length > STDERR_KEEP_BYTES * 2) stderr = stderr.slice(-STDERR_KEEP_BYTES);
    });
    record = { pid: child.pid, command: o.command, args: [...o.args], env };
    let guard: OrphanGuard | undefined;
    if (options.orphanGuard !== false && child.pid !== undefined) {
      const g: OrphanGuardOptions = { ...options.guard, cliPid: child.pid, platform };
      guard = startOrphanGuard(g);
    }
    // Each CLI keeps its own exit: a late close of an older CLI (a refused fork cut, D29) only
    // settles that CLI's record and never stands for the newest one.
    let settle!: (info: ProcessExit) => void;
    const own: ChildExit = { exit: new Promise<ProcessExit>((resolve) => (settle = resolve)) };
    {
      let done = false;
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (done) return;
        done = true;
        guard?.stop();
        const info = { code, signal, stderr: stderr.slice(-STDERR_KEEP_BYTES) };
        own.exited = info;
        settle(info);
      };
      // 'close' comes after stdio ends, so the last stderr is in; 'exit' is the fallback.
      child.once('close', (code, signal) => finish(code, signal));
      child.once('exit', (code, signal) => setTimeout(() => finish(code, signal), 200));
      child.once('error', () => finish(child.exitCode, child.signalCode));
    }
    current = own;
    // ChildProcess satisfies SpawnedProcess structurally (stdin, stdout, killed, exitCode, kill, on, once, off).
    return child as unknown as SpawnedProcess;
  };
  return {
    spawn: spawnFn,
    get record() {
      return record;
    },
    expectNew() {
      current = undefined;
    },
    async exitInfo(waitMs = 1000) {
      const c = current;
      if (!c) return undefined;
      if (c.exited) return c.exited;
      const exit = c.exit;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), waitMs);
      });
      try {
        return await Promise.race([exit, timeout]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
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
