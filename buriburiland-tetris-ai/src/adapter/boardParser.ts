import { BOARD_HEIGHT, BOARD_WIDTH, type Board } from '../types/game';

export class BoardParseError extends Error {}

function cellFilled(value: unknown): 0 | 1 {
  if (value == null || value === false || value === 0 || value === '' || value === '0') return 0;
  if (value === true) return 1;
  if (typeof value === 'number') return value === 0 ? 0 : 1;
  if (typeof value === 'string') {
    if (['empty', 'none', 'null', 'false'].includes(value.toLowerCase())) return 0;
    return 1;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['filled', 'occupied', 'isFilled']) {
      if (key in record) return record[key] ? 1 : 0;
    }
    for (const key of ['type', 'piece', 'tetromino', 'color']) {
      if (key in record) return record[key] == null || record[key] === '' ? 0 : 1;
    }
    if (Object.keys(record).length === 0) return 0;
  }
  throw new BoardParseError(`Ambiguous board cell: ${String(value)}`);
}

export function parseBoard(raw: unknown): Board {
  if (!Array.isArray(raw) || raw.length !== BOARD_HEIGHT) {
    throw new BoardParseError(`Expected exactly ${BOARD_HEIGHT} board rows`);
  }
  return raw.map((rawRow, y) => {
    if (!Array.isArray(rawRow) || rawRow.length !== BOARD_WIDTH) {
      throw new BoardParseError(`Expected exactly ${BOARD_WIDTH} cells in row ${y}`);
    }
    let mask = 0;
    for (let x = 0; x < BOARD_WIDTH; x += 1) {
      if (cellFilled(rawRow[x])) mask |= 1 << x;
    }
    return mask;
  });
}
