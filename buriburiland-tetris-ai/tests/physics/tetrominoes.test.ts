import { describe, expect, it } from 'vitest';
import { PIECE_TYPES } from '../../src/types/game';
import { cellsFor } from '../../src/physics/tetrominoes';

describe('tetromino geometry', () => {
  for (const piece of PIECE_TYPES) {
    it(`${piece} has four unique cells in every rotation`, () => {
      for (const rotation of [0, 1, 2, 3] as const) {
        const cells = cellsFor(piece, rotation);
        expect(cells).toHaveLength(4);
        expect(new Set(cells.map(([x, y]) => `${x},${y}`)).size).toBe(4);
        for (const [x, y] of cells) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThan(4);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(y).toBeLessThan(4);
        }
      }
    });
  }
});
