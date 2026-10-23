import type { Board, PieceType, Rotation } from '../types/game';
import { collides, hardDropY, lockPiece, type LockResult } from './board';

export class PhysicsEngine {
  collides(board: Board, type: PieceType, rotation: Rotation, x: number, y: number): boolean {
    return collides(board, type, rotation, x, y);
  }

  hardDropY(board: Board, type: PieceType, rotation: Rotation, x: number, y: number): number {
    return hardDropY(board, type, rotation, x, y);
  }

  lock(board: Board, type: PieceType, rotation: Rotation, x: number, y: number): LockResult | null {
    return lockPiece(board, type, rotation, x, y);
  }
}
