import type { CompletedLockRecord } from '../telemetry/JsonlTelemetry';

export type StrategyMode = 'CONSERVATIVE' | 'NORMAL' | 'AGGRESSIVE';

export interface FidelityStatus {
  readonly mode: StrategyMode;
  readonly consecutiveMatches: number;
  readonly totalMatches: number;
  readonly totalMismatches: number;
  readonly lastMismatchId: string | null;
}

/** Prediction fidelity gate only; gameplay mode selection is deliberately deferred. */
export class StrategyManager {
  private mode: StrategyMode = 'CONSERVATIVE';
  private consecutiveMatches = 0;
  private totalMatches = 0;
  private totalMismatches = 0;
  private lastMismatchId: string | null = null;

  constructor(private readonly matchesRequiredForNormal = 100) {}

  observe(record: CompletedLockRecord): FidelityStatus {
    if (!record.validation.matches) {
      this.mode = 'CONSERVATIVE';
      this.consecutiveMatches = 0;
      this.totalMismatches += 1;
      this.lastMismatchId = record.id;
      return this.status();
    }
    this.consecutiveMatches += 1;
    this.totalMatches += 1;
    if (this.consecutiveMatches >= this.matchesRequiredForNormal) this.mode = 'NORMAL';
    return this.status();
  }

  allowAggressiveStrategy(): boolean {
    return this.mode === 'AGGRESSIVE';
  }

  status(): FidelityStatus {
    return {
      mode: this.mode,
      consecutiveMatches: this.consecutiveMatches,
      totalMatches: this.totalMatches,
      totalMismatches: this.totalMismatches,
      lastMismatchId: this.lastMismatchId,
    };
  }
}
