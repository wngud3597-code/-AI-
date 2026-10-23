import { describe, expect, it } from 'vitest';
import { applyHold, resetHoldAfterLock } from '../../src/physics/hold';

describe('hold transitions', () => {
  it('consumes next when hold is empty', () => {
    expect(applyHold({ current: 'T', hold: null, nextQueue: ['I', 'O'], canHold: true })).toEqual({
      current: 'I', hold: 'T', nextQueue: ['O'], canHold: false, consumedFromQueue: true,
    });
  });

  it('swaps without consuming next when hold is occupied', () => {
    expect(applyHold({ current: 'T', hold: 'L', nextQueue: ['I'], canHold: true })).toEqual({
      current: 'L', hold: 'T', nextQueue: ['I'], canHold: false, consumedFromQueue: false,
    });
  });

  it('rejects a second hold until lock', () => {
    const state = { current: 'T' as const, hold: 'L' as const, nextQueue: ['I' as const], canHold: false };
    expect(applyHold(state)).toBeNull();
    expect(resetHoldAfterLock(state).canHold).toBe(true);
  });
});
