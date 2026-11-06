// Child-agent events never reach the root session's own turn (D45, D17): the hub takes them.
import { describe, expect, it } from 'vitest';
import { isChildEvent } from '../src/driver.js';

describe('isChildEvent', () => {
  const child = { kind: 'child', id: 'k' } as const;
  const main = { kind: 'main' } as const;
  it('marks child steps, results and agent events; keeps main ones and jobs', () => {
    expect(isChildEvent({ type: 'step-start', agent: child, stepId: 's', at: 1 })).toBe(true);
    expect(isChildEvent({ type: 'tool-result', agent: child, callId: 'c', isError: false, content: [] })).toBe(true);
    expect(isChildEvent({ type: 'agent-end', ref: child, status: 'completed' })).toBe(true);
    expect(isChildEvent({ type: 'team-message', from: 'a', to: 'b', text: 't', agent: child })).toBe(true);
    expect(isChildEvent({ type: 'step-start', agent: main, stepId: 's', at: 1 })).toBe(false);
    // A background agent's job still becomes a DSH job (D47).
    expect(isChildEvent({ type: 'task-start', taskId: 't', kind: 'agent', label: 'x', agent: child })).toBe(false);
  });
});
