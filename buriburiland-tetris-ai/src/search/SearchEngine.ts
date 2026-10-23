import type { GameSnapshot, ValidationState } from '../types/game';
import type { PlacementDecision } from '../telemetry/JsonlTelemetry';

export interface SearchResult {
  readonly decision: PlacementDecision;
  readonly predictedAfter: ValidationState;
  readonly elapsedMs: number;
  readonly nodes: number;
}

/** Search policy remains behind the fidelity milestone. */
export interface SearchEngine {
  search(snapshot: GameSnapshot, deadline: number): SearchResult | null;
}
