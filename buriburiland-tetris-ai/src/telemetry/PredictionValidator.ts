import { boardEquals, differingCells } from '../physics/board';
import type { ValidationState } from '../types/game';

export type ValidationField =
  | 'board'
  | 'clear'
  | 'attack'
  | 'spin'
  | 'pendingGarbage'
  | 'combo'
  | 'backToBack'
  | 'hold'
  | 'nextQueue';

export interface FieldDifference {
  readonly field: ValidationField;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly cells?: ReturnType<typeof differingCells>;
}

export interface ValidationDiff {
  readonly matches: boolean;
  readonly differences: readonly FieldDifference[];
  readonly likelyCauses: readonly string[];
}

function queueEquals(expected: readonly string[], actual: readonly string[]): boolean {
  return expected.length === actual.length && expected.every((piece, index) => piece === actual[index]);
}

export class PredictionValidator {
  compare(predicted: ValidationState, actual: ValidationState): ValidationDiff {
    const differences: FieldDifference[] = [];
    if (!boardEquals(predicted.board, actual.board)) {
      differences.push({
        field: 'board',
        expected: predicted.board,
        actual: actual.board,
        cells: differingCells(predicted.board, actual.board),
      });
    }

    for (const field of ['clear', 'attack', 'spin', 'pendingGarbage', 'combo', 'backToBack', 'hold'] as const) {
      if (predicted[field] !== actual[field]) {
        differences.push({ field, expected: predicted[field], actual: actual[field] });
      }
    }
    if (!queueEquals(predicted.nextQueue, actual.nextQueue)) {
      differences.push({ field: 'nextQueue', expected: predicted.nextQueue, actual: actual.nextQueue });
    }

    return {
      matches: differences.length === 0,
      differences,
      likelyCauses: classifyLikelyCauses(differences),
    };
  }
}

function classifyLikelyCauses(differences: readonly FieldDifference[]): readonly string[] {
  const causes = new Set<string>();
  const fields = new Set(differences.map((difference) => difference.field));
  if (fields.has('board')) causes.add('geometry_or_execution');
  if (fields.has('board') && fields.has('clear')) causes.add('line_clear');
  if (fields.has('spin')) causes.add('spin');
  if (fields.has('attack')) causes.add('attack_table');
  if (fields.has('pendingGarbage')) causes.add('garbage_cancel_or_insert');
  if (fields.has('combo') || fields.has('backToBack')) causes.add('chain_state');
  if (fields.has('hold') || fields.has('nextQueue')) causes.add('hold_or_queue_progression');
  if (causes.size === 0 && differences.length > 0) causes.add('unknown');
  return [...causes];
}
