import { BOARD_HEIGHT, BOARD_WIDTH, type Board, type PieceType, type Rotation } from '../types/game';

function occupiedOrWall(board: Board, x: number, y: number): boolean {
  if (x < 0 || x >= BOARD_WIDTH || y >= BOARD_HEIGHT) return true;
  if (y < 0) return false;
  return (((board[y] ?? 0) & (1 << x)) !== 0);
}

/**
 * Guideline-style T three-corner check. Mini/full classification and
 * BuriburiLand-specific all-spin rules remain intentionally unimplemented.
 */
export function detectTSpin(
  preClearBoard: Board,
  type: PieceType,
  rotation: Rotation,
  x: number,
  y: number,
  lastMoveWasRotation: boolean,
): boolean {
  void rotation;
  if (type !== 'T' || !lastMoveWasRotation) return false;
  const pivotX = x + 1;
  const pivotY = y + 1;
  const corners = [
    [pivotX - 1, pivotY - 1],
    [pivotX + 1, pivotY - 1],
    [pivotX - 1, pivotY + 1],
    [pivotX + 1, pivotY + 1],
  ] as const;
  return corners.filter(([cornerX, cornerY]) => occupiedOrWall(preClearBoard, cornerX, cornerY)).length >= 3;
}
