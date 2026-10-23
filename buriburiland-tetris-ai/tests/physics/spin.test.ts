import { describe, expect, it } from 'vitest';
import { emptyBoard, lockPiece } from '../../src/physics/board';
import { detectTSpin } from '../../src/physics/spin';

describe('T-spin detection boundary', () => {
  it('requires a T, a final rotation flag, and three occupied pivot corners', () => {
    const board = emptyBoard();
    board[17] = (1 << 3) | (1 << 5);
    board[19] = (1 << 3) | (1 << 5);
    const locked = lockPiece(board, 'T', 0, 3, 17);
    expect(locked).not.toBeNull();
    expect(detectTSpin(locked!.preClearBoard, 'T', 0, 3, 17, true)).toBe(true);
    expect(detectTSpin(locked!.preClearBoard, 'T', 0, 3, 17, false)).toBe(false);
    expect(detectTSpin(locked!.preClearBoard, 'L', 0, 3, 17, true)).toBe(false);
  });
});
