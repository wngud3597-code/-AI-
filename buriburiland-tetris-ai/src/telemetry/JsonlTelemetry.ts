import type { GameSnapshot, ValidationState } from '../types/game';
import { PredictionValidator, type ValidationDiff } from './PredictionValidator';

export interface PlacementDecision {
  readonly pieceVersion: string | number;
  readonly piece: string;
  readonly useHold: boolean;
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly actions: readonly string[];
  readonly mode: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface PendingLockRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly type: 'lock-pending';
  readonly recordedAt: string;
  readonly actualBefore: GameSnapshot;
  readonly decision: PlacementDecision;
  readonly predictedAfter: ValidationState;
}

export interface CompletedLockRecord extends Omit<PendingLockRecord, 'type'> {
  readonly type: 'lock-validation';
  readonly actualAfter: GameSnapshot;
  readonly actualValidationState: ValidationState;
  readonly validation: ValidationDiff;
}

export type TelemetryRecord = PendingLockRecord | CompletedLockRecord;
export type JsonlSink = (jsonLine: string, record: TelemetryRecord) => void | Promise<void>;

export const consoleJsonlSink: JsonlSink = (jsonLine) => {
  console.info(jsonLine);
};

export function snapshotToValidationState(snapshot: GameSnapshot): ValidationState {
  return {
    board: snapshot.board,
    clear: snapshot.lastClear,
    attack: snapshot.lastAttack,
    spin: snapshot.lastSpin,
    pendingGarbage: snapshot.pendingGarbage,
    combo: snapshot.combo,
    backToBack: snapshot.backToBack,
    hold: snapshot.hold,
    nextQueue: snapshot.nextQueue,
  };
}

function makeId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `lock-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class MemoryJsonlSink {
  readonly lines: string[] = [];
  readonly records: TelemetryRecord[] = [];

  write: JsonlSink = (line, record) => {
    this.lines.push(line);
    this.records.push(record);
  };
}

export class JsonlTelemetry {
  private readonly pending = new Map<string, PendingLockRecord>();

  constructor(
    private readonly sink: JsonlSink,
    private readonly validator = new PredictionValidator(),
  ) {}

  async begin(
    actualBefore: GameSnapshot,
    decision: PlacementDecision,
    predictedAfter: ValidationState,
  ): Promise<string> {
    const record: PendingLockRecord = {
      schemaVersion: 1,
      id: makeId(),
      type: 'lock-pending',
      recordedAt: new Date().toISOString(),
      actualBefore,
      decision,
      predictedAfter,
    };
    this.pending.set(record.id, record);
    await this.write(record);
    return record.id;
  }

  async complete(id: string, actualAfter: GameSnapshot): Promise<CompletedLockRecord> {
    const pending = this.pending.get(id);
    if (!pending) throw new Error(`Unknown lock telemetry id: ${id}`);
    const actualValidationState = snapshotToValidationState(actualAfter);
    const record: CompletedLockRecord = {
      ...pending,
      type: 'lock-validation',
      actualAfter,
      actualValidationState,
      validation: this.validator.compare(pending.predictedAfter, actualValidationState),
    };
    this.pending.delete(id);
    await this.write(record);
    return record;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  private async write(record: TelemetryRecord): Promise<void> {
    await this.sink(JSON.stringify(record), record);
  }
}
