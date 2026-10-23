import { asRotation, type Board, type PieceType, type Rotation } from '../types/game';
import { collides } from './board';

type Kick = readonly [x: number, y: number];

const JLSTZ_KICKS: Readonly<Record<string, readonly Kick[]>> = {
  '0>1': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '1>0': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '1>2': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '2>1': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '2>3': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '3>2': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '3>0': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '0>3': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
};

const I_KICKS: Readonly<Record<string, readonly Kick[]>> = {
  '0>1': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  '1>0': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  '1>2': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
  '2>1': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  '2>3': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  '3>2': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  '3>0': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  '0>3': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
};

export interface RotationState {
  readonly x: number;
  readonly y: number;
  readonly rotation: Rotation;
}

export interface RotationResult extends RotationState {
  readonly kickIndex: number;
  readonly kick: Kick;
}

export function rotateSrs(
  board: Board,
  type: PieceType,
  state: RotationState,
  direction: 1 | -1,
): RotationResult | null {
  const to = asRotation(state.rotation + direction);
  if (type === 'O') return { ...state, rotation: to, kickIndex: 0, kick: [0, 0] };
  const table = type === 'I' ? I_KICKS : JLSTZ_KICKS;
  const kicks = table[`${state.rotation}>${to}`] ?? [[0, 0]];
  for (let kickIndex = 0; kickIndex < kicks.length; kickIndex += 1) {
    const kick = kicks[kickIndex];
    if (!kick) continue;
    const [offsetX, offsetY] = kick;
    const x = state.x + offsetX;
    const y = state.y + offsetY;
    if (!collides(board, type, to, x, y)) return { x, y, rotation: to, kickIndex, kick };
  }
  return null;
}
