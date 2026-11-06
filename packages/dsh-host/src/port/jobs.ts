// Background tasks as DSH jobs (D47). A task becomes `ctx.jobs.start` under our preset's own
// scoped controller; each job keeps a pending `wait()` (1 h waits, a new one every 30 min, so two
// overlap), so a Host-level `tool-jobs` never turns its settlement into a model-facing notice
// (`P/dsh-tool-jobs/lib/index.js:366`). Job kill → the backend's per-task stop.

import type { TaskKind, TaskStatus } from '@dsh-raw-agent/core';
import type { JobLink, JobRefusal } from '../driver.js';
import type { DshJobHandle, DshJobOutcome, DshJobs } from './types.js';

export const JOB_WAIT_MS = 60 * 60 * 1000;
export const JOB_REWAIT_MS = 30 * 60 * 1000;
let waitMs = JOB_WAIT_MS;
let rewaitMs = JOB_REWAIT_MS;

/**
 * Test-only: shorter job waits, so a live suite can run a task that outlives one wait (S2). The
 * re-wait interval is half the wait, so two waits still overlap. `undefined` restores the defaults.
 */
export function setJobWaitForTests(ms: number | undefined): void {
  const ok = ms !== undefined && Number.isFinite(ms) && ms >= 50;
  waitMs = ok ? Math.floor(ms) : JOB_WAIT_MS;
  rewaitMs = ok ? Math.max(25, Math.floor(ms / 2)) : JOB_REWAIT_MS;
}

/** After a kill, how long the job waits for the task's own end before it settles anyway. */
export const JOB_KILL_GRACE_MS = 5000;

/**
 * Cancel reasons DSH uses when it tears jobs down, not when the user kills one
 * (`P/dsh-jobs-local/lib/index.js:813` "owner disposed", `:833` "jobs service disposed"; the
 * record's `settleCause` is set to `teardown` before `cancel` runs, `:848-850`). On teardown the
 * job settles locally at once and the task is NOT stopped (D47): an evicted agent or a DSH
 * shutdown must not kill background work through our own cancel hook (rules 6, 7).
 */
export const TEARDOWN_REASONS: readonly string[] = Object.freeze(['owner disposed', 'jobs service disposed']);

/**
 * DSH's per-owner limit refusal (`P/dsh-jobs-local/lib/index.js:419`: "background job limit reached
 * for this owner"). Its text names DSH's model tool `job_kill`, so it is never shown (D47 r4).
 */
export function isJobLimitError(message: string): boolean {
  return /job limit reached/i.test(message);
}

export function jobKind(kind: TaskKind): string {
  return `raw-agent-${kind}`;
}

export function startJob(
  jobs: DshJobs,
  owner: string,
  task: { taskId: string; kind: TaskKind; label: string },
  stop: () => void,
  warn: (note: string, detail?: unknown) => void,
  onTeardown?: () => void,
): JobLink | JobRefusal {
  let finish!: (o: DshJobOutcome) => void;
  let settled = false;
  const done = new Promise<DshJobOutcome>((r) => {
    finish = (o) => {
      if (settled) return;
      settled = true;
      clearInterval(rewait);
      r(o);
    };
  });
  let handle: DshJobHandle | undefined;
  let id: string;
  try {
    id = jobs.start({
      kind: jobKind(task.kind),
      label: task.label,
      owner,
      run(job) {
        handle = job;
        return {
          cancel(reason?: string) {
            if (reason !== undefined && TEARDOWN_REASONS.includes(reason)) {
              finish({ status: 'killed', detail: reason });
              try {
                onTeardown?.();
              } catch (error) {
                warn('job teardown hook failed', String(error));
              }
              return;
            }
            stop();
            const t = setTimeout(
              () => finish(reason ? { status: 'killed', detail: reason } : { status: 'killed' }),
              JOB_KILL_GRACE_MS,
            );
            t.unref?.();
          },
          done,
        };
      },
    });
  } catch (error) {
    // D47 (r4): the per-owner limit or a missing controller: the plugin's task list shows it.
    const message = String((error as Error)?.message ?? error);
    warn('could not start a job for a background task', message);
    return isJobLimitError(message) ? { refused: message, limit: true } : { refused: message };
  }
  // Overlapping waits (D47): a 1 h wait, a new one every 30 min. A wait must still be pending when
  // the job settles (that is what keeps a Host-level tool-jobs silent), and it resolves then.
  const wait = () => {
    if (settled) return;
    jobs.wait(id, waitMs, owner).catch(() => {});
  };
  wait();
  const rewait = setInterval(wait, rewaitMs);
  rewait.unref?.();
  return {
    progress(line: string) {
      handle?.updateProgress(line);
      handle?.append(`${line}\n`, { channel: 'log' });
    },
    end(status: TaskStatus, summary?: string) {
      const s: DshJobOutcome['status'] =
        status === 'completed' ? 'completed' : status === 'stopped' ? 'killed' : 'failed';
      if (summary) handle?.append(`${summary}\n`, { channel: 'log' });
      finish(summary ? { status: s, detail: summary } : { status: s });
    },
  };
}
