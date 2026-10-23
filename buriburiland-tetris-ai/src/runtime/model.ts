import type { ActivePiece, Board, PieceType, Rotation } from '../types/game';
import type { MoveAction } from '../move/ReachableMoveGenerator';

export type { ActivePiece, Board, PieceType, Rotation, MoveAction };
export type RuntimeAction = MoveAction | 'HOLD';

/** A copied DOM observation; observation is local and is not a server revision. */
export interface RuntimeSnapshot {
  readonly board: Board;
  /** Coordinates are the site's trimmed shape bounding box, not a SRS pivot. */
  readonly current: ActivePiece;
  readonly next: readonly PieceType[];
  readonly hold: PieceType | null;
  readonly canHold: boolean | null;
  readonly fingerprint: string;
  readonly session: string;
  readonly player: string;
  readonly observedAt: number;
  readonly observation: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly lines: number | null;
  readonly incoming: number | null;
  /** Ambiguous symmetric rotations remain explicit until input disambiguates them. */
  readonly rotationCandidates?: readonly ActivePiece[];
}

export interface RuntimeRuleProfile {
  readonly id: string;
  readonly evidence: string;
  readonly verifiedAt: string;
  readonly coordinateSpace: 'trimmed-bounding-box';
  readonly visibleRows: 20;
  readonly columns: 10;
  readonly spawn: 'x=3, rotation=0; first legal y in [0,-1,-2]';
  readonly rotation: 'client SRS with bounding-box offset correction';
  readonly rotation180: false;
  readonly attackPrediction: false;
  readonly spinPrediction: false;
  readonly futureGarbage: 'unknown; never invented';
}

export const RUNTIME_RULE_PROFILE: RuntimeRuleProfile = Object.freeze({
  id: 'buriburiland-client-847.a5a05f14ceb3f87d-2026-10-23',
  evidence: 'Public client chunk 847.a5a05f14ceb3f87d.js: K/en/ee/ei/eo/ea; server behavior still requires lock validation',
  verifiedAt: '2026-10-23',
  coordinateSpace: 'trimmed-bounding-box',
  visibleRows: 20,
  columns: 10,
  spawn: 'x=3, rotation=0; first legal y in [0,-1,-2]',
  rotation: 'client SRS with bounding-box offset correction',
  rotation180: false,
  attackPrediction: false,
  spinPrediction: false,
  futureGarbage: 'unknown; never invented',
});

export interface RuntimePlan {
  readonly kind: 'place' | 'hold';
  readonly path: readonly MoveAction[];
  readonly target: ActivePiece;
  /** For HOLD this is the unchanged board; a new observation must follow HOLD. */
  readonly expectedBoard: Board;
  readonly cleared: number;
  readonly score: number;
  readonly nodes: number;
  readonly elapsedMs: number;
  readonly fingerprint: string;
  readonly session: string;
  readonly player: string;
  readonly observation: number;
  readonly depth: number;
  readonly budgetExhausted: boolean;
  readonly ruleProfile: string;
  readonly assumptions: readonly string[];
}

export interface SearchOptions {
  readonly budgetMs?: number;
  readonly maxNodes?: number;
  readonly depth?: number;
  readonly beamWidth?: number;
  readonly maxStatesPerBoard?: number;
  readonly maxPathLength?: number;
  readonly allowHold?: boolean;
  readonly now?: () => number;
}

export interface RuntimeBoardFeatures {
  readonly heights: readonly number[];
  readonly aggregateHeight: number;
  readonly maxHeight: number;
  readonly holes: number;
  readonly coveredCells: number;
  readonly holeDepth: number;
  readonly bumpiness: number;
  readonly wells: number;
  readonly deepCanyon: number;
  readonly rowTransitions: number;
  readonly columnTransitions: number;
  readonly occupied: number;
}
