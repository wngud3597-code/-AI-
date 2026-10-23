import { describe, expect, it } from 'vitest';
import { emptyBoard } from '../../src/physics/board';
import { ReachableMoveGenerator } from '../../src/move/ReachableMoveGenerator';
import { PIECE_TYPES } from '../../src/types/game';

describe('reachable placements', () => {
  const generator = new ReachableMoveGenerator();

  for (const piece of PIECE_TYPES) {
    it(`generates executable ${piece} placements from the actual spawn`, () => {
      const placements = generator.generate(emptyBoard(), { type: piece, x: 3, y: 0, rotation: 0 });
      expect(placements.length).toBeGreaterThan(0);
      expect(placements.every((placement) => placement.path.at(-1) === 'HARD_DROP')).toBe(true);
    });
  }

  it('does not silently reset an invalid actual state to spawn', () => {
    const board = emptyBoard();
    board[1] = 0b1111111111;
    expect(generator.generate(board, { type: 'T', x: 3, y: 0, rotation: 0 })).toEqual([]);
  });
});
