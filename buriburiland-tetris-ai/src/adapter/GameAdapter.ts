import { parseBoard } from './boardParser';
import {
  asRotation,
  normalizePieceType,
  type ActivePiece,
  type GameSnapshot,
  type PieceType,
} from '../types/game';

export type UnknownRecord = Record<string, unknown>;
export type TetrisStateProvider = () => unknown;

const LOCAL_ID_KEYS = [
  'localPlayerId', 'myPlayerId', 'selfPlayerId', 'currentPlayerId', 'playerId', 'userId', 'ownerPlayerId',
] as const;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null ? value as UnknownRecord : null;
}

function parseClear(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.min(4, Math.trunc(value)));
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    const digit = normalized.match(/[1-4]/)?.[0];
    if (digit) return Number(digit);
    if (normalized.includes('single')) return 1;
    if (normalized.includes('double')) return 2;
    if (normalized.includes('triple')) return 3;
    if (normalized.includes('tetris') || normalized.includes('quad')) return 4;
  }
  const record = asRecord(value);
  if (record) {
    for (const key of ['lines', 'count', 'cleared', 'lineCount']) {
      const parsed = Number(record[key]);
      if (Number.isFinite(parsed)) return Math.max(0, Math.min(4, Math.trunc(parsed)));
    }
  }
  return 0;
}

function parseSpin(value: unknown): boolean {
  if (typeof value === 'string') return !['', 'none', 'false', '0', 'no'].includes(value.toLowerCase());
  return Boolean(value);
}

function parseQueue(value: unknown): PieceType[] {
  return Array.isArray(value) ? value.map(normalizePieceType).filter((piece): piece is PieceType => piece !== null) : [];
}

function looksLikePlayer(value: unknown): value is UnknownRecord {
  const player = asRecord(value);
  return Boolean(player && Array.isArray(player.board) && 'current' in player && 'pieceVersion' in player);
}

export class GameAdapter {
  private selectedPlayerId: string | null = null;

  constructor(private readonly stateProvider: TetrisStateProvider) {}

  selectPlayer(playerId: string): void {
    this.selectedPlayerId = playerId;
  }

  listPlayers(): readonly { id: string; nickname: string | null }[] {
    const players = this.readPlayers();
    return Object.entries(players)
      .filter((entry): entry is [string, UnknownRecord] => looksLikePlayer(entry[1]))
      .map(([id, player]) => ({ id, nickname: typeof player.nickname === 'string' ? player.nickname : null }));
  }

  capture(): GameSnapshot {
    // The provider is invoked for every capture. No React player object is cached.
    const state = this.readState();
    const players = this.readPlayers(state);
    const playerId = this.resolvePlayerId(state, players);
    const player = players[playerId];
    if (!looksLikePlayer(player)) throw new Error(`Player ${playerId} is unavailable or malformed`);
    this.selectedPlayerId = playerId;

    const currentRecord = asRecord(player.current);
    const currentType = normalizePieceType(currentRecord);
    const current: ActivePiece | null = currentRecord && currentType ? {
      type: currentType,
      x: Number(currentRecord.x ?? 3),
      y: Number(currentRecord.y ?? 0),
      rotation: asRotation(currentRecord.rotation),
    } : null;

    return {
      capturedAt: Date.now(),
      playerId,
      pieceVersion: typeof player.pieceVersion === 'string' || typeof player.pieceVersion === 'number'
        ? player.pieceVersion
        : String(player.pieceVersion),
      board: parseBoard(player.board),
      current,
      nextQueue: parseQueue(player.nextQueue),
      hold: normalizePieceType(player.hold),
      canHold: Boolean(player.canHold),
      pendingGarbage: Math.max(0, Number(player.pendingGarbage ?? 0)),
      combo: Math.max(0, Number(player.combo ?? 0)),
      backToBack: Boolean(player.backToBack),
      lastAttack: Math.max(0, Number(player.lastAttack ?? 0)),
      lastClear: parseClear(player.lastClear),
      lastSpin: parseSpin(player.lastSpin),
      eliminated: Boolean(player.eliminated),
    };
  }

  private readState(): UnknownRecord {
    const raw = this.stateProvider();
    const state = asRecord(raw);
    if (!state) throw new Error('Tetris state provider returned no object');
    return state;
  }

  private readPlayers(state = this.readState()): UnknownRecord {
    const players = asRecord(state.players);
    if (!players) throw new Error('Tetris state has no players map');
    return players;
  }

  private resolvePlayerId(state: UnknownRecord, players: UnknownRecord): string {
    if (this.selectedPlayerId && looksLikePlayer(players[this.selectedPlayerId])) return this.selectedPlayerId;
    for (const key of LOCAL_ID_KEYS) {
      const candidate = state[key];
      if (typeof candidate === 'string' && looksLikePlayer(players[candidate])) return candidate;
    }
    const valid = Object.entries(players).filter(([, player]) => looksLikePlayer(player));
    if (valid.length === 1 && valid[0]) return valid[0][0];
    throw new Error('Local player is ambiguous; call selectPlayer with an observed player id');
  }
}
