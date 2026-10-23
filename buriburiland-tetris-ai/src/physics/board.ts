import { BOARD_HEIGHT, BOARD_WIDTH, FULL_ROW, type Board, type PieceType, type Rotation } from '../types/game';
import { cellsFor } from './tetrominoes';

export function emptyBoard(): number[] {
  return Array<number>(BOARD_HEIGHT).fill(0);
}

export function assertBoard(board: Board): void {
  if (board.length !== BOARD_HEIGHT) throw new Error(`Expected ${BOARD_HEIGHT} rows, received ${board.length}`);
  for (const row of board) {
    if (!Number.isInteger(row) || row < 0 || row > FULL_ROW) throw new Error(`Invalid board row mask: ${row}`);
  }
}

export function collides(board: Board, type: PieceType, rotation: Rotation, x: number, y: number): boolean {
  for (const [cellX, cellY] of cellsFor(type, rotation)) {
    const boardX = x + cellX;
    const boardY = y + cellY;
    if (boardX < 0 || boardX >= BOARD_WIDTH || boardY >= BOARD_HEIGHT) return true;
    if (boardY >= 0 && ((board[boardY] ?? 0) & (1 << boardX)) !== 0) return true;
  }
  return false;
}

export function hardDropY(
  board: Board,
  type: PieceType,
  rotation: Rotation,
  x: number,
  startY: number,
): number {
  if (collides(board, type, rotation, x, startY)) throw new Error('Cannot hard-drop a colliding piece');
  let y = startY;
  while (!collides(board, type, rotation, x, y + 1)) y += 1;
  return y;
}

export interface LockResult {
  readonly board: Board;
  readonly preClearBoard: Board;
  readonly cleared: number;
  readonly clearedRows: readonly number[];
  readonly topOut: boolean;
}

export function lockPiece(
  board: Board,
  type: PieceType,
  rotation: Rotation,
  x: number,
  y: number,
): LockResult | null {
  if (collides(board, type, rotation, x, y)) return null;

  const placed = [...board];
  let topOut = false;
  for (const [cellX, cellY] of cellsFor(type, rotation)) {
    const boardX = x + cellX;
    const boardY = y + cellY;
    if (boardY < 0) {
      topOut = true;
      continue;
    }
    placed[boardY] = (placed[boardY] ?? 0) | (1 << boardX);
  }

  const clearedRows: number[] = [];
  for (let row = 0; row < BOARD_HEIGHT; row += 1) {
    if (((placed[row] ?? 0) & FULL_ROW) === FULL_ROW) clearedRows.push(row);
  }
  const clearedSet = new Set(clearedRows);
  const after = placed.filter((_, index) => !clearedSet.has(index));
  while (after.length < BOARD_HEIGHT) after.unshift(0);

  return { board: after, preClearBoard: placed, cleared: clearedRows.length, clearedRows, topOut };
}

export function boardEquals(left: Board, right: Board): boolean {
  return left.length === right.length && left.every((row, index) => row === right[index]);
}

export function differingCells(left: Board, right: Board): readonly { x: number; y: number; expected: 0 | 1; actual: 0 | 1 }[] {
  const differences: { x: number; y: number; expected: 0 | 1; actual: 0 | 1 }[] = [];
  for (let y = 0; y < BOARD_HEIGHT; y += 1) {
    const expectedRow = left[y] ?? 0;
    const actualRow = right[y] ?? 0;
    const xor = expectedRow ^ actualRow;
    for (let x = 0; x < BOARD_WIDTH; x += 1) {
      if ((xor & (1 << x)) !== 0) {
        differences.push({
          x,
          y,
          expected: (expectedRow & (1 << x)) !== 0 ? 1 : 0,
          actual: (actualRow & (1 << x)) !== 0 ? 1 : 0,
        });
      }
    }
  }
  return differences;
}
