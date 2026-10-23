import type { GameSnapshot, PieceType, ValidationState } from '../types/game';
import type { ReachablePlacement } from '../move/ReachableMoveGenerator';

/** Values whose rules are server-specific and therefore must be supplied by
 * observed BuriburiLand evidence rather than silently guessed. */
export interface ResolvedServerOutcome {
  readonly attack: number;
  readonly pendingGarbage: number;
  readonly combo: number;
  readonly backToBack: boolean;
  readonly hold: PieceType | null;
  readonly nextQueue: readonly PieceType[];
}

export function buildPredictedValidationState(
  before: GameSnapshot,
  placement: ReachablePlacement,
  serverOutcome: ResolvedServerOutcome,
): ValidationState {
  void before;
  return {
    board: placement.board,
    clear: placement.cleared,
    attack: serverOutcome.attack,
    spin: placement.spin,
    pendingGarbage: serverOutcome.pendingGarbage,
    combo: serverOutcome.combo,
    backToBack: serverOutcome.backToBack,
    hold: serverOutcome.hold,
    nextQueue: serverOutcome.nextQueue,
  };
}
