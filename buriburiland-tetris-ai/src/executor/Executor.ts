import type { GameAdapter } from '../adapter/GameAdapter';
import type { MoveAction } from '../move/ReachableMoveGenerator';
import type { GameSnapshot, ValidationState } from '../types/game';
import type { JsonlTelemetry, PlacementDecision, CompletedLockRecord } from '../telemetry/JsonlTelemetry';

export interface InputPort {
  tap(action: MoveAction | 'HOLD'): Promise<void>;
}

export interface ExecuteLockRequest {
  readonly decision: PlacementDecision;
  readonly actions: readonly (MoveAction | 'HOLD')[];
  readonly predictedAfter: ValidationState;
  readonly lockTimeoutMs?: number;
}

export class Executor {
  private inFlight = false;

  constructor(
    private readonly adapter: GameAdapter,
    private readonly input: InputPort,
    private readonly telemetry: JsonlTelemetry,
  ) {}

  async executeLock(request: ExecuteLockRequest): Promise<CompletedLockRecord> {
    if (this.inFlight) throw new Error('Duplicate execution prevented: a lock transaction is already in flight');
    this.inFlight = true;
    try {
      const before = this.adapter.capture();
      if (before.pieceVersion !== request.decision.pieceVersion) throw new Error('Decision is stale before execution');
      const telemetryId = await this.telemetry.begin(before, request.decision, request.predictedAfter);

      for (const action of request.actions) {
        const fresh = this.adapter.capture();
        if (fresh.pieceVersion !== before.pieceVersion) break;
        await this.input.tap(action);
      }

      const after = await this.waitForNextPiece(before, request.lockTimeoutMs ?? 500);
      return await this.telemetry.complete(telemetryId, after);
    } finally {
      this.inFlight = false;
    }
  }

  private async waitForNextPiece(before: GameSnapshot, timeoutMs: number): Promise<GameSnapshot> {
    const startedAt = performance.now();
    while (performance.now() - startedAt < timeoutMs) {
      const fresh = this.adapter.capture();
      if (fresh.pieceVersion !== before.pieceVersion) return fresh;
      await new Promise<void>((resolve) => setTimeout(resolve, 8));
    }
    throw new Error(`Lock was not observed within ${timeoutMs}ms`);
  }
}
