import type { CompletedLockRecord } from '../telemetry/JsonlTelemetry';
import { PredictionValidator } from '../telemetry/PredictionValidator';

export interface ReplaySummary {
  readonly total: number;
  readonly matched: number;
  readonly mismatched: number;
  readonly mismatchIds: readonly string[];
}

export class ReplayHarness {
  constructor(private readonly validator = new PredictionValidator()) {}

  validate(records: readonly CompletedLockRecord[]): ReplaySummary {
    const mismatchIds: string[] = [];
    let matched = 0;
    for (const record of records) {
      const replayed = this.validator.compare(record.predictedAfter, record.actualValidationState);
      if (replayed.matches) matched += 1;
      else mismatchIds.push(record.id);
    }
    return { total: records.length, matched, mismatched: mismatchIds.length, mismatchIds };
  }
}
