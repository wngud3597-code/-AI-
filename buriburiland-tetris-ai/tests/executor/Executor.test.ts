import { describe, expect, it } from 'vitest';
import { GameAdapter } from '../../src/adapter/GameAdapter';
import { Executor, type InputPort } from '../../src/executor/Executor';
import { emptyBoard, lockPiece } from '../../src/physics/board';
import { JsonlTelemetry, MemoryJsonlSink } from '../../src/telemetry/JsonlTelemetry';
import type { MoveAction } from '../../src/move/ReachableMoveGenerator';

function rawBoard(masks: readonly number[]): unknown[][] {
  return masks.map((mask) => Array.from({ length: 10 }, (_, x) => (mask & (1 << x)) !== 0));
}

function rawPlayer(version: number, masks: readonly number[] = emptyBoard()) {
  return {
    board: rawBoard(masks),
    current: { type: version === 1 ? 'T' : 'I', x: 3, y: 0, rotation: 0 },
    pieceVersion: version,
    nextQueue: ['I'], hold: null, canHold: true, pendingGarbage: 0,
    combo: 0, backToBack: false, lastAttack: 0, lastClear: 0, lastSpin: false, eliminated: false,
  };
}

describe('Executor lock transaction', () => {
  it('captures and validates a complete observed lock', async () => {
    const locked = lockPiece(emptyBoard(), 'T', 0, 3, 18)!;
    let state = { localPlayerId: 'me', players: { me: rawPlayer(1) } };
    const input: InputPort = {
      async tap(action: MoveAction | 'HOLD') {
        if (action === 'HARD_DROP') state = { localPlayerId: 'me', players: { me: rawPlayer(2, locked.board) } };
      },
    };
    const adapter = new GameAdapter(() => state);
    const sink = new MemoryJsonlSink();
    const executor = new Executor(adapter, input, new JsonlTelemetry(sink.write));
    const result = await executor.executeLock({
      decision: {
        pieceVersion: 1, piece: 'T', useHold: false, x: 3, y: 18, rotation: 0,
        actions: ['HARD_DROP'], mode: 'CONSERVATIVE',
      },
      actions: ['HARD_DROP'],
      predictedAfter: {
        board: locked.board, clear: 0, attack: 0, spin: false, pendingGarbage: 0,
        combo: 0, backToBack: false, hold: null, nextQueue: ['I'],
      },
    });
    expect(result.validation.matches).toBe(true);
    expect(sink.records).toHaveLength(2);
  });

  it('rejects a stale decision before sending input', async () => {
    let taps = 0;
    const adapter = new GameAdapter(() => ({ localPlayerId: 'me', players: { me: rawPlayer(2) } }));
    const input: InputPort = { async tap() { taps += 1; } };
    const executor = new Executor(adapter, input, new JsonlTelemetry(new MemoryJsonlSink().write));
    await expect(executor.executeLock({
      decision: { pieceVersion: 1, piece: 'T', useHold: false, x: 3, y: 18, rotation: 0, actions: ['HARD_DROP'], mode: 'CONSERVATIVE' },
      actions: ['HARD_DROP'],
      predictedAfter: { board: emptyBoard(), clear: 0, attack: 0, spin: false, pendingGarbage: 0, combo: 0, backToBack: false, hold: null, nextQueue: ['I'] },
    })).rejects.toThrow(/stale/i);
    expect(taps).toBe(0);
  });
});
