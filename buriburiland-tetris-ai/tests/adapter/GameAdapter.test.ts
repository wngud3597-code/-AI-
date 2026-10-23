import { describe, expect, it } from 'vitest';
import { GameAdapter } from '../../src/adapter/GameAdapter';
import { BoardParseError, parseBoard } from '../../src/adapter/boardParser';

function rawBoard(): unknown[][] {
  return Array.from({ length: 20 }, () => Array<unknown>(10).fill(null));
}

function player(version: number, board = rawBoard()) {
  return {
    board,
    current: { type: 'T', x: 3, y: 0, rotation: 0 },
    pieceVersion: version,
    nextQueue: ['I', 'O'],
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

describe('GameAdapter', () => {
  it('reads the provider afresh instead of retaining a stale player object', () => {
    let state = { localPlayerId: 'me', players: { me: player(1) } };
    const adapter = new GameAdapter(() => state);
    expect(adapter.capture().pieceVersion).toBe(1);
    state = { localPlayerId: 'me', players: { me: player(2) } };
    expect(adapter.capture().pieceVersion).toBe(2);
  });

  it('requires explicit selection when the local player is ambiguous', () => {
    const adapter = new GameAdapter(() => ({ players: { one: player(1), two: player(1) } }));
    expect(() => adapter.capture()).toThrow(/ambiguous/i);
    adapter.selectPlayer('two');
    expect(adapter.capture().playerId).toBe('two');
  });

  it('parses known cell encodings and rejects ambiguous objects', () => {
    const board = rawBoard();
    board[19]![0] = true;
    board[19]![1] = { type: 'I' };
    expect(parseBoard(board)[19]).toBe(3);
    board[0]![0] = { unexpected: 'value' };
    expect(() => parseBoard(board)).toThrow(BoardParseError);
  });
});
