import type { Board } from '../types/game';

export interface EvaluationContext {
  readonly board: Board;
  readonly pendingGarbage: number;
  readonly combo: number;
  readonly backToBack: boolean;
}

export interface EvaluationResult {
  readonly score: number;
  readonly features: Readonly<Record<string, number>>;
}

/** Deliberately unimplemented until prediction fidelity clears its gate. */
export interface Evaluator {
  evaluate(context: EvaluationContext): EvaluationResult;
}
