export const BOARD_WIDTH = 10;
export const BOARD_HEIGHT = 20;
export const FULL_ROW = (1 << BOARD_WIDTH) - 1;

export const PIECE_TYPES = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'] as const;
export type PieceType = (typeof PIECE_TYPES)[number];
export type Rotation = 0 | 1 | 2 | 3;
export type Board = readonly number[];

export interface ActivePiece {
  readonly type: PieceType;
  readonly x: number;
  readonly y: number;
  readonly rotation: Rotation;
}

export interface GameSnapshot {
  readonly capturedAt: number;
  readonly playerId: string;
  readonly pieceVersion: string | number;
  readonly board: Board;
  readonly current: ActivePiece | null;
  readonly nextQueue: readonly PieceType[];
  readonly hold: PieceType | null;
  readonly canHold: boolean;
  readonly pendingGarbage: number;
  readonly combo: number;
  readonly backToBack: boolean;
  readonly lastAttack: number;
  readonly lastClear: number;
  readonly lastSpin: boolean;
  readonly eliminated: boolean;
}

export interface ValidationState {
  readonly board: Board;
  readonly clear: number;
  readonly attack: number;
  readonly spin: boolean;
  readonly pendingGarbage: number;
  readonly combo: number;
  readonly backToBack: boolean;
  readonly hold: PieceType | null;
  readonly nextQueue: readonly PieceType[];
}

export function isPieceType(value: unknown): value is PieceType {
  return typeof value === 'string' && (PIECE_TYPES as readonly string[]).includes(value.toUpperCase());
}

export function normalizePieceType(value: unknown): PieceType | null {
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return normalizePieceType(record.type ?? record.kind ?? record.name ?? record.piece ?? record.tetromino);
  }
  if (!isPieceType(value)) return null;
  return value.toUpperCase() as PieceType;
}

export function asRotation(value: unknown): Rotation {
  const number = Number(value);
  const normalized = Number.isFinite(number) ? ((Math.trunc(number) % 4) + 4) % 4 : 0;
  return normalized as Rotation;
}
