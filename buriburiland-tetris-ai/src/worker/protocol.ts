import type { GameSnapshot } from '../types/game';
import type { SearchResult } from '../search/SearchEngine';

export interface PlanRequest {
  readonly type: 'plan';
  readonly id: number;
  readonly snapshot: GameSnapshot;
  readonly deadline: number;
}

export interface PlanResponse {
  readonly type: 'plan-result';
  readonly id: number;
  readonly result: SearchResult | null;
}

export interface WorkerFailure {
  readonly type: 'error';
  readonly id: number;
  readonly error: string;
}

export type WorkerRequest = PlanRequest;
export type WorkerResponse = PlanResponse | WorkerFailure;
