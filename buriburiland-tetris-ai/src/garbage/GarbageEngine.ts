import type { Board } from '../types/game';

export interface GarbageResolution {
  readonly cancelled: number;
  readonly remainingIncoming: number;
  readonly outgoing: number;
  readonly inserted: number;
  readonly board: Board;
}

/**
 * Contract only. Cancellation timing, insertion timing, hole generation and
 * top-out behavior require BuriburiLand lock telemetry before implementation.
 */
export interface GarbageEngine {
  resolve(board: Board, pendingGarbage: number, attack: number): GarbageResolution;
}
