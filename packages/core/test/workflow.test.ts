// D48 workflow snapshot merge.
import { describe, expect, it } from 'vitest';
import { mergeWorkflowSnapshot, settleWorkflowSnapshot, type WorkflowAgent } from '@dsh-raw-agent/core';

const agent = (index: number, state: WorkflowAgent['state'], extra: Partial<WorkflowAgent> = {}): WorkflowAgent => ({
  index,
  label: `a${index}`,
  state,
  ...extra,
});

describe('mergeWorkflowSnapshot (D48)', () => {
  it('a frame replaces the previous one, sorted by index', () => {
    const a = mergeWorkflowSnapshot(undefined, {
      phases: [{ index: 1, title: 'One' }],
      agents: [agent(2, 'queued'), agent(1, 'running')],
    });
    expect(a.agents.map((x) => x.index)).toEqual([1, 2]);
    const b = mergeWorkflowSnapshot(a, {
      phases: [
        { index: 1, title: 'One' },
        { index: 2, title: 'Two' },
      ],
      agents: [agent(1, 'done', { tokens: 9 }), agent(2, 'running')],
    });
    expect(b.phases).toHaveLength(2);
    expect(b.agents).toEqual([agent(1, 'done', { tokens: 9 }), agent(2, 'running')]);
  });

  it('never moves a settled agent back to running in the same attempt; a retry may', () => {
    const done = mergeWorkflowSnapshot(undefined, {
      phases: [],
      agents: [agent(1, 'done', { attempt: 1, agentId: 'x' })],
    });
    const back = mergeWorkflowSnapshot(done, { phases: [], agents: [agent(1, 'running', { attempt: 1, tokens: 5 })] });
    expect(back.agents[0]).toMatchObject({ state: 'done', agentId: 'x', tokens: 5 });
    const retry = mergeWorkflowSnapshot(done, {
      phases: [],
      agents: [agent(1, 'running', { attempt: 2, agentId: 'y' })],
    });
    expect(retry.agents[0]).toMatchObject({ state: 'running', attempt: 2, agentId: 'y' });
  });

  it('keeps the newest attempt, the agent id, missing rows and earlier phases', () => {
    const two = mergeWorkflowSnapshot(undefined, {
      phases: [{ index: 1, title: 'P' }],
      agents: [agent(1, 'running', { attempt: 2, agentId: 'n' }), agent(2, 'done')],
    });
    const stale = mergeWorkflowSnapshot(two, { phases: [], agents: [agent(1, 'error', { attempt: 1 })] });
    expect(stale.phases).toEqual([{ index: 1, title: 'P' }]);
    expect(stale.agents).toHaveLength(2);
    expect(stale.agents[0]).toMatchObject({ state: 'running', attempt: 2 });
    const noId = mergeWorkflowSnapshot(two, { phases: [], agents: [agent(1, 'running', { attempt: 2 })] });
    expect(noId.agents[0]!.agentId).toBe('n');
  });

  it('settles open rows when the run ends', () => {
    const snap = { phases: [], agents: [agent(1, 'running'), agent(2, 'queued'), agent(3, 'done')] };
    expect(settleWorkflowSnapshot(snap, 'completed').agents.map((a) => a.state)).toEqual(['done', 'stopped', 'done']);
    expect(settleWorkflowSnapshot(snap, 'cancelled').agents.map((a) => a.state)).toEqual([
      'stopped',
      'stopped',
      'done',
    ]);
    expect(settleWorkflowSnapshot(snap, 'error').agents.map((a) => a.state)).toEqual(['error', 'stopped', 'done']);
  });
});
