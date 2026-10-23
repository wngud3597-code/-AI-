import type { PieceType } from '../types/game';

export interface HoldState {
  readonly current: PieceType;
  readonly hold: PieceType | null;
  readonly nextQueue: readonly PieceType[];
  readonly canHold: boolean;
}

export interface HoldResult extends HoldState {
  readonly consumedFromQueue: boolean;
}

export function applyHold(state: HoldState): HoldResult | null {
  if (!state.canHold) return null;
  if (state.hold !== null) {
    return {
      current: state.hold,
      hold: state.current,
      nextQueue: [...state.nextQueue],
      canHold: false,
      consumedFromQueue: false,
    };
  }
  const [next, ...remaining] = state.nextQueue;
  if (!next) return null;
  return {
    current: next,
    hold: state.current,
    nextQueue: remaining,
    canHold: false,
    consumedFromQueue: true,
  };
}

export function resetHoldAfterLock(state: HoldState): HoldState {
  return { ...state, canHold: true };
}
