// D75 (M7): the orphan guard. The CLI runs in its own process group (D8), so when DSH is killed
// hard (SIGKILL, a crash, the task manager) nothing ends it, and with a background task running
// it goes on by itself (re-parented to pid 1; it may even run a wake turn). A second process on
// the same Claude session would then race the next resume.
//
// The guard is a tiny Node watcher, one per CLI: no model call, no `claude` run, no file write.
// Its stdin is a pipe whose only writer is this DSH process, so the pipe ends the moment DSH dies,
// on every OS. Then it ends the CLI: POSIX `SIGTERM` to the CLI's process group, `SIGKILL` after a
// grace period; Windows `taskkill /T /F` on the CLI's process tree. It also polls: when the CLI is
// gone it exits; when its parent changed (POSIX re-parent) or died it ends the CLI.
//
// Limits (documented in the M7 notes): a guard killed together with DSH (one `kill -9` of both,
// a cgroup or job kill that spares the CLI) cannot act; a CLI child that left the CLI's process
// group (its own `setsid`) survives a POSIX group kill; on Windows `taskkill /T` follows the
// process tree only while parents are alive.

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

/** The watcher, run with `node -e`. Plain CommonJS; reads its settings from one env variable. */
export const ORPHAN_GUARD_SCRIPT = `
const c = JSON.parse(process.env.DSH_RAW_AGENT_GUARD || '{}');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } };
let done = false;
const quit = () => { if (done) return; done = true; process.exit(0); };
const target = () => (c.group ? -c.cli : c.cli);
const endCli = () => {
  if (done) return;
  done = true;
  if (!alive(c.cli)) process.exit(0);
  try {
    if (c.win) require('child_process').spawnSync('taskkill', ['/PID', String(c.cli), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(target(), 'SIGTERM');
  } catch (e) {}
  if (c.win) process.exit(0);
  setTimeout(() => { try { process.kill(target(), 'SIGKILL'); } catch (e) {} process.exit(0); }, c.grace);
};
process.stdin.on('data', (d) => { if (String(d).indexOf('stop') >= 0) quit(); });
process.stdin.on('end', endCli);
process.stdin.on('error', endCli);
process.stdin.resume();
setInterval(() => {
  if (!alive(c.cli)) quit();
  else if (!c.win && process.ppid !== c.host) endCli();
  else if (!alive(c.host)) endCli();
}, c.poll);
`;

export interface OrphanGuardSettings {
  /** The CLI's pid. */
  cli: number;
  /** This (DSH) process's pid: the watcher's parent. */
  host: number;
  /** POSIX: the CLI leads its own process group (D8), so the whole group is ended. */
  group: boolean;
  win: boolean;
  /** Poll period, ms. */
  poll: number;
  /** POSIX: SIGTERM → SIGKILL delay, ms. */
  grace: number;
}

export interface OrphanGuard {
  readonly pid: number | undefined;
  /** The CLI ended normally: the watcher exits without touching anything. */
  stop(): void;
}

export interface OrphanGuardOptions {
  cliPid: number;
  platform?: NodeJS.Platform;
  /** The Node binary that runs the watcher. Defaults to this process's. */
  execPath?: string;
  pollMs?: number;
  graceMs?: number;
  /** Test seam. */
  spawn?: typeof nodeSpawn;
  onError?: (error: unknown) => void;
}

export function guardSettings(o: OrphanGuardOptions): OrphanGuardSettings {
  const platform = o.platform ?? process.platform;
  return {
    cli: o.cliPid,
    host: process.pid,
    group: platform !== 'win32',
    win: platform === 'win32',
    poll: o.pollMs ?? 2000,
    grace: o.graceMs ?? 3000,
  };
}

/** Start the watcher for one CLI. Never throws; without a watcher it returns a no-op guard. */
export function startOrphanGuard(o: OrphanGuardOptions): OrphanGuard {
  const settings = guardSettings(o);
  const env: Record<string, string> = { DSH_RAW_AGENT_GUARD: JSON.stringify(settings) };
  // Windows needs these to start a process at all; nothing of the user's NODE_OPTIONS runs here.
  for (const k of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR'])
    if (process.env[k] !== undefined) env[k] = process.env[k] as string;
  let child: ChildProcess;
  try {
    child = (o.spawn ?? nodeSpawn)(o.execPath ?? process.execPath, ['-e', ORPHAN_GUARD_SCRIPT], {
      stdio: ['pipe', 'ignore', 'ignore'],
      env,
      // Its own group on POSIX, so a signal to DSH's group does not take the watcher with it.
      detached: !settings.win,
      windowsHide: true,
    });
  } catch (error) {
    o.onError?.(error);
    return { pid: undefined, stop() {} };
  }
  child.on('error', (error) => o.onError?.(error));
  child.stdin?.on('error', () => {});
  // Never keep DSH running for the watcher.
  child.unref();
  (child.stdin as unknown as { unref?: () => void } | null)?.unref?.();
  let stopped = false;
  return {
    get pid() {
      return child.pid;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        child.stdin?.end('stop\n');
      } catch {
        // already gone
      }
    },
  };
}
