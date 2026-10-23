import { describe, expect, it } from 'vitest';
import { emptyBoard } from '../../src/physics/board';
import { PredictionValidator } from '../../src/telemetry/PredictionValidator';
import type { ValidationState } from '../../src/types/game';

function state(): ValidationState {
  return {
    board: emptyBoard(), clear: 0, attack: 0, spin: false, pendingGarbage: 0,
    combo: 0, backToBack: false, hold: null, nextQueue: ['I', 'O'],
  };
}

describe('PredictionValidator', () => {
  it('compares every required lock field', () => {
    expect(new PredictionValidator().compare(state(), state())).toEqual({
      matches: true, differences: [], likelyCauses: [],
    });
  });

  it('retains cell-level evidence and classifies divergent systems', () => {
    const predicted = state();
    const actual: ValidationState = {
      ...state(),
      board: [...emptyBoard().slice(0, 19), 1],
      clear: 1,
      attack: 2,
      spin: true,
      pendingGarbage: 3,
      combo: 1,
      backToBack: true,
      hold: 'T',
      nextQueue: ['O'],
    };
    const diff = new PredictionValidator().compare(predicted, actual);
    expect(diff.matches).toBe(false);
    expect(diff.differences.map(({ field }) => field)).toEqual([
      'board', 'clear', 'attack', 'spin', 'pendingGarbage', 'combo', 'backToBack', 'hold', 'nextQueue',
    ]);
    expect(diff.differences[0]?.cells).toEqual([{ x: 0, y: 19, expected: 0, actual: 1 }]);
    expect(diff.likelyCauses).toContain('garbage_cancel_or_insert');
  });
});
