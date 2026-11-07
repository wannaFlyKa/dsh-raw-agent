// M8 (R9.2): pure helpers of the public service API.

import { describe, expect, it } from 'vitest';
import {
  PublicEventTracker,
  RawAgentServiceError,
  checkGrantLabel,
  isRawAgentServiceError,
  sessionInfoFromView,
  type PublicViewInput,
} from '@dsh-raw-agent/core';

const base: PublicViewInput = {
  state: { process: 'none', turn: false, backgroundTasks: 0 },
  live: {},
  choice: { pendingMode: 'plan' },
};

describe('public service helpers', () => {
  it('session info: a pending mode shows until the agent reports one', () => {
    const b = { kind: 'k', displayName: 'Agent' };
    expect(sessionInfoFromView('s', b, base)).toEqual({
      sessionId: 's',
      backend: b,
      process: 'none',
      running: false,
      busy: false,
      backgroundTasks: 0,
      waitingForUser: 0,
      mode: 'plan',
    });
    expect(sessionInfoFromView('s', b, { ...base, live: { mode: 'default', version: '2' } })).toMatchObject({
      mode: 'default',
      backend: { version: '2' },
    });
  });

  it('the tracker sends each kind once per change and ends once', () => {
    const t = new PublicEventTracker('s', { kind: 'k', displayName: 'A' });
    expect(t.update(base).map((e) => e.type)).toEqual(['state']);
    expect(t.update(base)).toEqual([]);
    const withUsage: PublicViewInput = {
      ...base,
      usage: { compacting: false, tokens: 10, costUsd: 0.01, context: { used: 5, window: 100, percent: 5 } },
      workflows: [{ taskId: 't', runId: 'r', name: 'w', status: 'running', phases: [], agents: [], startedAt: 1 }],
    };
    expect(t.update(withUsage).map((e) => e.type)).toEqual(['usage', 'workflows']);
    // A list that goes away is reported once as empty.
    expect(t.update({ ...withUsage, workflows: undefined })).toEqual([{ type: 'workflows', sessionId: 's', runs: [] }]);
    expect(t.end()).toEqual([{ type: 'ended', sessionId: 's' }]);
    expect(t.end()).toEqual([]);
    expect(t.update(withUsage)).toEqual([]);
  });

  it('never copies ask choices or forms', () => {
    const t = new PublicEventTracker('s', { kind: 'k', displayName: 'A' });
    const view = {
      ...base,
      asks: [{ id: 'a', kind: 'plan', agent: 'main', title: 'Plan', at: 1, choices: [{ id: 'yes' }], form: {} }],
    } as unknown as PublicViewInput;
    const e = t.update(view).find((x) => x.type === 'asks');
    expect(e).toEqual({
      type: 'asks',
      sessionId: 's',
      asks: [{ id: 'a', kind: 'plan', agent: 'main', title: 'Plan', at: 1 }],
    });
  });

  it('grant labels and coded errors', () => {
    expect(checkGrantLabel(' a  b ')).toEqual({ ok: true, label: 'a b' });
    expect(checkGrantLabel('').ok).toBe(false);
    const e = new RawAgentServiceError('bad-grant', 'no');
    expect(isRawAgentServiceError(e)).toBe(true);
    const copy = Object.assign(new Error('x'), { name: 'RawAgentServiceError', code: 'busy' });
    expect(isRawAgentServiceError(copy)).toBe(true);
    expect(isRawAgentServiceError(new Error('x'))).toBe(false);
  });
});
