import { bench, describe } from 'vitest';
import { ReachableMoveGenerator } from '../../src/move/ReachableMoveGenerator';
import { emptyBoard } from '../../src/physics/board';

describe('reachable placement benchmark', () => {
  const generator = new ReachableMoveGenerator();
  const board = emptyBoard();
  board[19] = 0b1011011011;
  board[18] = 0b0010010011;

  bench('T piece on uneven stack', () => {
    generator.generate(board, { type: 'T', x: 3, y: 0, rotation: 0 });
  });
});
