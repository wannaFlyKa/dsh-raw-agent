// D8: the CLI runs in its own process group on POSIX, so what is left of it (tool children) can be
// ended when it dies. Uses a real `sh` with a background child; skipped on Windows.

import { describe, expect, it } from 'vitest';
import { createSpawner } from '@dsh-raw-agent/backend-claude';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(process.platform === 'win32')('process group cleanup (D8)', () => {
  it('killGroup ends the CLI and the children it left behind', async () => {
    const spawner = createSpawner({ PATH: process.env.PATH ?? '' });
    const child = spawner.spawn({
      command: 'sh',
      args: ['-c', 'sleep 30 & echo $!; wait'],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '' },
      signal: new AbortController().signal,
    } as never) as unknown as import('node:child_process').ChildProcess;
    const grandchild = await new Promise<number>((resolve) =>
      child.stdout!.once('data', (d: Buffer) => resolve(Number(String(d).trim()))),
    );
    expect(alive(grandchild)).toBe(true);
    expect(spawner.record?.pid).toBe(child.pid);
    spawner.killGroup('SIGKILL');
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(child.pid!)).toBe(false);
    expect(alive(grandchild)).toBe(false);
  });
});
