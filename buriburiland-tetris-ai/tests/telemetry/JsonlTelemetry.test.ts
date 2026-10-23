import { describe, expect, it } from 'vitest';
import { emptyBoard } from '../../src/physics/board';
import { JsonlTelemetry, MemoryJsonlSink, snapshotToValidationState } from '../../src/telemetry/JsonlTelemetry';
import type { GameSnapshot } from '../../src/types/game';

function snapshot(version: number): GameSnapshot {
  return {
    capturedAt: version,
    playerId: 'me',
    pieceVersion: version,
    board: emptyBoard(),
    current: { type: 'T', x: 3, y: 0, rotation: 0 },
    nextQueue: ['I'],
    hold: null,
    canHold: true,
    pendingGarbage: 0,
    combo: 0,
    backToBack: false,
    lastAttack: 0,
    lastClear: 0,
    lastSpin: false,
    eliminated: false,
  };
}

describe('JsonlTelemetry', () => {
  it('records before, decision, predicted after, actual after, and diff', async () => {
    const sink = new MemoryJsonlSink();
    const telemetry = new JsonlTelemetry(sink.write);
    const before = snapshot(1);
    const id = await telemetry.begin(before, {
      pieceVersion: 1,
      piece: 'T',
      useHold: false,
      x: 3,
      y: 18,
      rotation: 0,
      actions: ['HARD_DROP'],
      mode: 'CONSERVATIVE',
    }, snapshotToValidationState(snapshot(2)));
    const record = await telemetry.complete(id, snapshot(2));
    expect(record.validation.matches).toBe(true);
    expect(sink.records.map(({ type }) => type)).toEqual(['lock-pending', 'lock-validation']);
    expect(sink.lines.every((line) => JSON.parse(line))).toBeTruthy();
    expect(telemetry.pendingCount()).toBe(0);
  });
});
