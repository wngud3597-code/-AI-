import { describe, expect, it } from 'vitest';
import { StrategyManager } from '../../src/strategy/StrategyManager';
import type { CompletedLockRecord } from '../../src/telemetry/JsonlTelemetry';

function record(id: string, matches: boolean): CompletedLockRecord {
  return {
    schemaVersion: 1,
    id,
    type: 'lock-validation',
    recordedAt: new Date(0).toISOString(),
    actualBefore: {} as CompletedLockRecord['actualBefore'],
    decision: {} as CompletedLockRecord['decision'],
    predictedAfter: {} as CompletedLockRecord['predictedAfter'],
    actualAfter: {} as CompletedLockRecord['actualAfter'],
    actualValidationState: {} as CompletedLockRecord['actualValidationState'],
    validation: { matches, differences: matches ? [] : [{ field: 'board', expected: [], actual: [] }], likelyCauses: matches ? [] : ['geometry_or_execution'] },
  };
}

describe('F-007 prediction fidelity gate', () => {
  it('downgrades immediately and requires a fresh evidence streak', () => {
    const strategy = new StrategyManager(3);
    strategy.observe(record('1', true));
    strategy.observe(record('2', true));
    expect(strategy.status().mode).toBe('CONSERVATIVE');
    strategy.observe(record('3', true));
    expect(strategy.status().mode).toBe('NORMAL');
    strategy.observe(record('bad-lock', false));
    expect(strategy.status()).toMatchObject({ mode: 'CONSERVATIVE', consecutiveMatches: 0, lastMismatchId: 'bad-lock' });
    expect(strategy.allowAggressiveStrategy()).toBe(false);
  });
});
