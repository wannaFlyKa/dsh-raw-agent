import { describe, expect, it } from 'vitest';
import {
  addTokens,
  cacheHitRatio,
  contextTokens,
  isZeroTokens,
  subtractTokens,
  totalTokens,
  worstCostBasis,
  zeroTokens,
} from '@dsh-raw-agent/core';

describe('token math (D57, D58)', () => {
  it('adds, subtracts with a floor at zero, and keeps reasoning only when reported', () => {
    const a = { input: 2, output: 74, cacheRead: 14051, cacheWrite: 13176 };
    const b = { input: 2, output: 3, cacheRead: 27227, cacheWrite: 81, reasoning: 1 };
    expect(addTokens(a, b)).toEqual({ input: 4, output: 77, cacheRead: 41278, cacheWrite: 13257, reasoning: 1 });
    expect(addTokens(a, a)).not.toHaveProperty('reasoning');
    expect(subtractTokens(a, b)).toEqual({ input: 0, output: 71, cacheRead: 0, cacheWrite: 13095 });
    expect(totalTokens(a)).toBe(2 + 74 + 14051 + 13176);
    expect(isZeroTokens(zeroTokens())).toBe(true);
  });

  it('context is input + cache (the status-line formula) and the cache-hit share', () => {
    const t = { input: 2, output: 6, cacheRead: 27370, cacheWrite: 690 };
    expect(contextTokens(t)).toBe(28062); // auth-usage answer 4
    expect(cacheHitRatio(t)).toBeCloseTo(27370 / 28062);
    expect(cacheHitRatio(zeroTokens())).toBeUndefined();
  });

  it('the least certain cost basis wins; none means list', () => {
    expect(worstCostBasis([])).toBe('list');
    expect(worstCostBasis(['list', undefined, 'managed'])).toBe('managed');
    expect(worstCostBasis(['managed', 'unknown', 'list'])).toBe('unknown');
  });
});
