// Background tasks as DSH jobs (D47). A task becomes `ctx.jobs.start` under our preset's own
// scoped controller; each job keeps a pending `wait()` (1 h waits, a new one every 30 min, so two
// overlap), so a Host-level `tool-jobs` never turns its settlement into a model-facing notice
// (`P/dsh-tool-jobs/lib/index.js:366`). Job kill → the backend's per-task stop.

import type { TaskKind, TaskStatus } from '@dsh-raw-agent/core';
import type { JobLink } from '../driver.js';
import type { DshJobHandle, DshJobOutcome, DshJobs } from './types.js';

export const JOB_WAIT_MS = 60 * 60 * 1000;
export const JOB_REWAIT_MS = 30 * 60 * 1000;
/** After a kill, how long the job waits for the task's own end before it settles anyway. */
export const JOB_KILL_GRACE_MS = 5000;

export function jobKind(kind: TaskKind): string {
  return `raw-agent-${kind}`;
}

export function startJob(
  jobs: DshJobs,
  owner: string,
  task: { taskId: string; kind: TaskKind; label: string },
  stop: () => void,
  warn: (note: string, detail?: unknown) => void,
): JobLink | undefined {
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
    // D47 (r4): the per-owner limit or a missing controller. The plugin task list is a later milestone.
    warn('could not start a job for a background task', String((error as Error)?.message ?? error));
    return undefined;
  }
  const wait = () => {
    if (settled) return;
    jobs.wait(id, JOB_WAIT_MS, owner).catch(() => {});
  };
  wait();
  const rewait = setInterval(wait, JOB_REWAIT_MS);
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
