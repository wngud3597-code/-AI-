import { BOARD_HEIGHT, FULL_ROW, type Board } from '../types/game';

export interface GarbageRise {
  readonly rows: number;
  /** Hole columns, in the inserted rows' top-to-bottom order. */
  readonly holes: readonly number[];
  readonly insertedRows: readonly number[];
}

function isDenseBoard(board: Board): boolean {
  if (!Array.isArray(board) || board.length !== BOARD_HEIGHT) return false;
  for (let y = 0; y < BOARD_HEIGHT; y += 1) {
    if (!Object.prototype.hasOwnProperty.call(board, y)) return false;
    const row = board[y];
    if (typeof row !== 'number' || !Number.isInteger(row) || row < 0 || row > FULL_ROW) return false;
  }
  return true;
}

/**
 * Recognizes an observed upward board shift followed by single-hole garbage.
 * This is a display hypothesis, not proof of server event order or cancellation.
 * Discarding occupied top rows is rejected because the full transition is then
 * no longer recoverable from the visible board.
 */
export function detectGarbageRise(expected: Board, actual: Board): GarbageRise | null {
  if (!isDenseBoard(expected) || !isDenseBoard(actual)) return null;
  if (expected.every((row, y) => row === actual[y])) return null;

  for (let rows = 1; rows < BOARD_HEIGHT; rows += 1) {
    // Every larger shift would also discard this occupied row.
    if (expected[rows - 1] !== 0) break;
    const retainedRows = BOARD_HEIGHT - rows;
    let bodyMatches = true;
    for (let y = 0; y < retainedRows; y += 1) {
      if (actual[y] !== expected[y + rows]) {
        bodyMatches = false;
        break;
      }
    }
    if (!bodyMatches) continue;

    const insertedRows = actual.slice(retainedRows);
    const holes: number[] = [];
    for (const row of insertedRows) {
      const missing = FULL_ROW ^ row;
      // Exactly one missing bit means nine occupied cells and one hole.
      if (missing === 0 || (missing & (missing - 1)) !== 0) break;
      holes.push(Math.log2(missing));
    }
    if (holes.length !== rows) continue;
    return Object.freeze({
      rows,
      holes: Object.freeze(holes),
      insertedRows: Object.freeze(insertedRows),
    });
  }
  return null;
}
