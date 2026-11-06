import { describe, expect, it } from 'vitest';
import type { AgentBackendFactory } from '@dsh-raw-agent/core';
import { createRawAgentHost } from '@dsh-raw-agent/dsh-host';

const factory = (kind: string) =>
  ({
    kind,
    displayName: kind,
    staticCapabilities: {},
    open: async () => {
      throw new Error('x');
    },
  }) as unknown as AgentBackendFactory;

describe('backend registry (D80)', () => {
  it('takes a factory list and refuses duplicate kinds', () => {
    expect(createRawAgentHost({ factories: [factory('a'), factory('b')] }).factories).toHaveLength(2);
    expect(() => createRawAgentHost({ factories: [factory('a'), factory('a')] })).toThrow(/Duplicate/);
  });
});
