import type { Board, PieceType } from '../types/game';
import { rotateSrs, type RotationResult, type RotationState } from './srs';

export class SRSEngine {
  rotate(
    board: Board,
    type: PieceType,
    state: RotationState,
    direction: 1 | -1,
  ): RotationResult | null {
    return rotateSrs(board, type, state, direction);
  }
}
