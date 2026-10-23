import { describe, expect, it } from 'vitest';
import { collides, emptyBoard, hardDropY, lockPiece } from '../../src/physics/board';
import { PIECE_TYPES } from '../../src/types/game';

describe('board physics', () => {
  it('detects walls, floor, and occupied cells', () => {
    const board = emptyBoard();
    board[19] = 1 << 4;
    expect(collides(board, 'T', 0, -1, 0)).toBe(true);
    expect(collides(board, 'T', 0, 3, 19)).toBe(true);
    expect(collides(board, 'O', 0, 2, 18)).toBe(true);
    expect(collides(board, 'T', 0, 3, 0)).toBe(false);
  });

  it('hard-drops deterministically on an empty board', () => {
    expect(hardDropY(emptyBoard(), 'T', 0, 3, 0)).toBe(18);
    expect(hardDropY(emptyBoard(), 'I', 1, 3, 0)).toBe(16);
  });

  it('hard-drops and locks all seven pieces in all four rotations', () => {
    for (const piece of PIECE_TYPES) {
      for (const rotation of [0, 1, 2, 3] as const) {
        const board = emptyBoard();
        const y = hardDropY(board, piece, rotation, 3, 0);
        const result = lockPiece(board, piece, rotation, 3, y);
        expect(result?.topOut).toBe(false);
        const occupied = result?.board.reduce((count, row) => count + row.toString(2).replaceAll('0', '').length, 0);
        expect(occupied).toBe(4);
      }
    }
  });

  it('clears a completed row and preserves board height', () => {
    const board = emptyBoard();
    board[19] = 0b0000111111;
    const result = lockPiece(board, 'I', 0, 6, 18);
    expect(result).not.toBeNull();
    expect(result?.cleared).toBe(1);
    expect(result?.clearedRows).toEqual([19]);
    expect(result?.board).toHaveLength(20);
    expect(result?.board.every((row) => row === 0)).toBe(true);
  });
});
