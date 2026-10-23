import { asRotation, type ActivePiece, type Board, type Rotation } from '../types/game';
import { collides, hardDropY, lockPiece, type LockResult } from '../physics/board';
import { rotateSrs } from '../physics/srs';
import { detectTSpin } from '../physics/spin';

export const ACTIONS = ['LEFT', 'RIGHT', 'SOFT_DROP', 'ROTATE_CW', 'ROTATE_CCW', 'HARD_DROP'] as const;
export type MoveAction = (typeof ACTIONS)[number];

interface SearchState {
  readonly x: number;
  readonly y: number;
  readonly rotation: Rotation;
  readonly path: readonly MoveAction[];
  readonly lastMoveWasRotation: boolean;
}

export interface ReachablePlacement extends LockResult {
  readonly x: number;
  readonly y: number;
  readonly rotation: Rotation;
  readonly path: readonly MoveAction[];
  readonly lastMoveWasRotation: boolean;
  readonly spin: boolean;
}

export interface ReachabilityLimits {
  readonly maxStates?: number;
  readonly maxPathLength?: number;
}

function stateKey(state: SearchState): string {
  return `${state.x},${state.y},${state.rotation},${state.lastMoveWasRotation ? 1 : 0}`;
}

function placementKey(placement: ReachablePlacement): string {
  return `${placement.x},${placement.y},${placement.rotation},${placement.spin ? 1 : 0}`;
}

export class ReachableMoveGenerator {
  generate(board: Board, current: ActivePiece, limits: ReachabilityLimits = {}): readonly ReachablePlacement[] {
    const maxStates = limits.maxStates ?? 10_000;
    const maxPathLength = limits.maxPathLength ?? 64;
    if (collides(board, current.type, current.rotation, current.x, current.y)) return [];

    const initial: SearchState = {
      x: current.x,
      y: current.y,
      rotation: current.rotation,
      path: [],
      lastMoveWasRotation: false,
    };
    const queue: SearchState[] = [initial];
    const visited = new Set<string>([stateKey(initial)]);
    const placements = new Map<string, ReachablePlacement>();

    for (let index = 0; index < queue.length && visited.size <= maxStates; index += 1) {
      const state = queue[index];
      if (!state) continue;
      const landingY = hardDropY(board, current.type, state.rotation, state.x, state.y);
      const locked = lockPiece(board, current.type, state.rotation, state.x, landingY);
      if (locked && !locked.topOut) {
        const spin = detectTSpin(
          locked.preClearBoard,
          current.type,
          state.rotation,
          state.x,
          landingY,
          state.lastMoveWasRotation,
        );
        const candidate: ReachablePlacement = {
          ...locked,
          x: state.x,
          y: landingY,
          rotation: state.rotation,
          path: [...state.path, 'HARD_DROP'],
          lastMoveWasRotation: state.lastMoveWasRotation,
          spin,
        };
        const key = placementKey(candidate);
        const previous = placements.get(key);
        if (!previous || candidate.path.length < previous.path.length) placements.set(key, candidate);
      }

      if (state.path.length >= maxPathLength) continue;
      const nextStates: SearchState[] = [];
      if (!collides(board, current.type, state.rotation, state.x - 1, state.y)) {
        nextStates.push({ ...state, x: state.x - 1, path: [...state.path, 'LEFT'], lastMoveWasRotation: false });
      }
      if (!collides(board, current.type, state.rotation, state.x + 1, state.y)) {
        nextStates.push({ ...state, x: state.x + 1, path: [...state.path, 'RIGHT'], lastMoveWasRotation: false });
      }
      if (!collides(board, current.type, state.rotation, state.x, state.y + 1)) {
        nextStates.push({ ...state, y: state.y + 1, path: [...state.path, 'SOFT_DROP'], lastMoveWasRotation: false });
      }
      for (const [direction, action] of [[1, 'ROTATE_CW'], [-1, 'ROTATE_CCW']] as const) {
        const rotated = rotateSrs(board, current.type, state, direction);
        if (rotated) {
          nextStates.push({
            x: rotated.x,
            y: rotated.y,
            rotation: asRotation(rotated.rotation),
            path: [...state.path, action],
            lastMoveWasRotation: true,
          });
        }
      }
      for (const next of nextStates) {
        const key = stateKey(next);
        if (visited.has(key)) continue;
        visited.add(key);
        queue.push(next);
      }
    }
    return [...placements.values()];
  }
}
