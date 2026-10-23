import { BOARD_HEIGHT, BOARD_WIDTH, FULL_ROW, PIECE_TYPES } from '../types/game';
import type { ActivePiece, Board, MoveAction, PieceType, Rotation, RuntimeBoardFeatures, RuntimePlan, RuntimeSnapshot, SearchOptions } from './model';
import { RUNTIME_RULE_PROFILE } from './model';
import { cellsFor as pivotCells, type Cell } from '../physics/tetrominoes';
import { collides as pivotCollision, hardDropY as pivotDropY, lockPiece as pivotLock, type LockResult } from '../physics/board';
import { rotateSrs as pivotRotate } from '../physics/srs';

// The client renders trimmed matrices. Keep the tested pivot-frame primitives and
// convert coordinates explicitly instead of treating CSS bounding boxes as pivots.
const offsets = new Map<string, Cell>();
const shapes = new Map<string, readonly Cell[]>();
for (const type of PIECE_TYPES) {
  for (const rotation of [0, 1, 2, 3] as const) {
    const cells = pivotCells(type, rotation);
    const offset: Cell = [Math.min(...cells.map(([x]) => x)), Math.min(...cells.map(([, y]) => y))];
    offsets.set(`${type}${rotation}`, offset);
    shapes.set(`${type}${rotation}`, cells.map(([x, y]) => [x - offset[0], y - offset[1]] as const));
  }
}

export function cellsFor(type: PieceType, rotation: Rotation): readonly Cell[] {
  return shapes.get(`${type}${rotation}`) ?? [];
}

function offsetFor(type: PieceType, rotation: Rotation): Cell {
  return offsets.get(`${type}${rotation}`) ?? [0, 0];
}

export function runtimeCells(piece: ActivePiece): readonly Cell[] {
  return cellsFor(piece.type, piece.rotation).map(([x, y]) => [piece.x + x, piece.y + y] as const);
}

export function collides(board: Board, type: PieceType, rotation: Rotation, x: number, y: number): boolean {
  const [offsetX, offsetY] = offsetFor(type, rotation);
  return pivotCollision(board, type, rotation, x - offsetX, y - offsetY);
}

export function hardDropY(board: Board, type: PieceType, rotation: Rotation, x: number, startY: number): number {
  const [offsetX, offsetY] = offsetFor(type, rotation);
  return pivotDropY(board, type, rotation, x - offsetX, startY - offsetY) + offsetY;
}

export function lockPiece(board: Board, type: PieceType, rotation: Rotation, x: number, y: number): LockResult | null {
  const [offsetX, offsetY] = offsetFor(type, rotation);
  return pivotLock(board, type, rotation, x - offsetX, y - offsetY);
}

export function rotateSrs(board: Board, piece: ActivePiece, direction: 1 | -1): ActivePiece | null {
  if (piece.type === 'O') return piece;
  const [fromX, fromY] = offsetFor(piece.type, piece.rotation);
  const rotated = pivotRotate(board, piece.type, {
    x: piece.x - fromX, y: piece.y - fromY, rotation: piece.rotation,
  }, direction);
  if (!rotated) return null;
  const [toX, toY] = offsetFor(piece.type, rotated.rotation);
  return { type: piece.type, x: rotated.x + toX, y: rotated.y + toY, rotation: rotated.rotation };
}

/** null means the action cannot legally change this pose. HOLD requires a fresh snapshot. */
export function applyRuntimeAction(board: Board, current: ActivePiece, action: MoveAction): ActivePiece | null {
  if (collides(board, current.type, current.rotation, current.x, current.y)) return null;
  if (action === 'ROTATE_CW' || action === 'ROTATE_CCW') {
    return rotateSrs(board, current, action === 'ROTATE_CW' ? 1 : -1);
  }
  if (action === 'HARD_DROP') {
    return { ...current, y: hardDropY(board, current.type, current.rotation, current.x, current.y) };
  }
  const next = { ...current, x: current.x + (action === 'LEFT' ? -1 : action === 'RIGHT' ? 1 : 0), y: current.y + (action === 'SOFT_DROP' ? 1 : 0) };
  return collides(board, next.type, next.rotation, next.x, next.y) ? null : next;
}

export function spawnPiece(board: Board, type: PieceType): ActivePiece | null {
  for (const y of [0, -1, -2]) {
    const piece: ActivePiece = { type, x: 3, y, rotation: 0 };
    if (!collides(board, type, 0, piece.x, piece.y)) return piece;
  }
  return null;
}

export function boardFeatures(board: Board): RuntimeBoardFeatures {
  const heights: number[] = [];
  let holes = 0, coveredCells = 0, holeDepth = 0, occupied = 0, columnTransitions = 0;
  for (let x = 0; x < BOARD_WIDTH; x += 1) {
    let first = BOARD_HEIGHT, blocksAbove = 0, previous = true;
    for (let y = 0; y < BOARD_HEIGHT; y += 1) {
      const filled = (((board[y] ?? 0) >> x) & 1) === 1;
      if (filled !== previous) columnTransitions += 1;
      previous = filled;
      if (filled) { first = Math.min(first, y); blocksAbove += 1; occupied += 1; }
      else if (blocksAbove > 0) { holes += 1; coveredCells += blocksAbove; holeDepth += y - first; }
    }
    if (!previous) columnTransitions += 1;
    heights.push(BOARD_HEIGHT - first);
  }
  let bumpiness = 0, wells = 0, deepCanyon = 0, rowTransitions = 0;
  for (let x = 0; x < BOARD_WIDTH; x += 1) {
    const height = heights[x] ?? 0;
    if (x > 0) bumpiness += Math.abs(height - (heights[x - 1] ?? 0));
    const left = x === 0 ? BOARD_HEIGHT : heights[x - 1] ?? 0;
    const right = x === BOARD_WIDTH - 1 ? BOARD_HEIGHT : heights[x + 1] ?? 0;
    const depth = Math.max(0, Math.min(left, right) - height);
    wells += depth * (depth + 1) / 2;
    // A single 4-cell edge well is usable by I; taller enclosed canyons are costly.
    deepCanyon += Math.max(0, depth - (x === 0 || x === BOARD_WIDTH - 1 ? 4 : 2)) ** 2;
  }
  for (let y = 0; y < BOARD_HEIGHT; y += 1) {
    let previous = true;
    for (let x = 0; x < BOARD_WIDTH; x += 1) {
      const filled = (((board[y] ?? 0) >> x) & 1) === 1;
      if (filled !== previous) rowTransitions += 1;
      previous = filled;
    }
    if (!previous) rowTransitions += 1;
  }
  return { heights, aggregateHeight: heights.reduce((sum, value) => sum + value, 0), maxHeight: Math.max(...heights), holes, coveredCells, holeDepth, bumpiness, wells, deepCanyon, rowTransitions, columnTransitions, occupied };
}

/** Survival heuristic only: attack, spin, and unknown garbage insertion are not predicted. */
export function evaluateBoard(board: Board, incoming: number | null = null): number {
  const f = boardFeatures(board);
  const pressure = incoming === null ? 0 : Math.min(12, Math.max(0, incoming));
  const projectedHeight = f.maxHeight + pressure;
  const danger = Math.max(0, projectedHeight - 12);
  return -f.holes * 21 - f.coveredCells * 1.8 - f.holeDepth * 1.5
    -f.aggregateHeight * 0.64 -f.maxHeight * 1.8 -f.bumpiness * 0.56
    -f.wells * 0.12 -f.deepCanyon * 2.8 -f.rowTransitions * 0.13
    -f.columnTransitions * 0.16 -danger * danger * 3.5;
}

interface Budget {
  readonly started: number;
  readonly deadline: number;
  readonly now: () => number;
  readonly maxNodes: number;
  nodes: number;
  exhausted: boolean;
}

function takeNode(budget: Budget): boolean {
  if (budget.nodes >= budget.maxNodes || budget.now() >= budget.deadline) {
    budget.exhausted = true;
    return false;
  }
  budget.nodes += 1;
  return true;
}

interface BfsState {
  readonly poses: readonly ActivePiece[];
  readonly parent: number;
  readonly action: MoveAction | null;
  readonly steps: number;
}

export interface RuntimePlacement {
  readonly target: ActivePiece;
  readonly path: readonly MoveAction[];
  readonly board: Board;
  readonly cleared: number;
}

const TRANSITIONS: readonly MoveAction[] = ['LEFT', 'RIGHT', 'ROTATE_CW', 'ROTATE_CCW', 'SOFT_DROP'];

function poseKey(piece: ActivePiece): string { return `${piece.x}/${piece.y}/${piece.rotation}`; }
function cellKey(piece: ActivePiece): string {
  return runtimeCells(piece).map(([x, y]) => y * 32 + x).sort((a, b) => a - b).join('/');
}

function buildPath(queue: readonly BfsState[], index: number): MoveAction[] {
  const path: MoveAction[] = ['HARD_DROP'];
  let cursor = index;
  while (cursor >= 0) {
    const state = queue[cursor];
    if (!state) break;
    if (state.action) path.push(state.action);
    cursor = state.parent;
  }
  return path.reverse();
}

function generate(
  board: Board,
  initial: readonly ActivePiece[],
  budget: Budget,
  options: SearchOptions,
  accept?: (placement: RuntimePlacement) => void,
): readonly RuntimePlacement[] {
  const current = initial[0];
  if (!current || initial.some((piece) => collides(board, piece.type, piece.rotation, piece.x, piece.y))) return [];
  const initialCellKey = cellKey(current);
  if (initial.some((piece) => piece.type !== current.type || cellKey(piece) !== initialCellKey)) return [];
  const maxStates = positiveInteger(options.maxStatesPerBoard, 1_600, 20_000);
  const maxPathLength = positiveInteger(options.maxPathLength, 60, 120);
  const queue: BfsState[] = [{ poses: initial, parent: -1, action: null, steps: 0 }];
  const visited = new Set<string>([initial.map(poseKey).join('|')]);
  const placements = new Map<string, RuntimePlacement>();
  for (let index = 0; index < queue.length && index < maxStates; index += 1) {
    if (!takeNode(budget)) break;
    const state = queue[index];
    const piece = state?.poses[0];
    if (!state || !piece) continue;
    const target: ActivePiece = { ...piece, y: hardDropY(board, piece.type, piece.rotation, piece.x, piece.y) };
    const lock = lockPiece(board, target.type, target.rotation, target.x, target.y);
    if (lock && !lock.topOut) {
      const key = lock.board.join(',');
      if (!placements.has(key)) {
        const placement: RuntimePlacement = { target, path: buildPath(queue, index), board: lock.board, cleared: lock.cleared };
        placements.set(key, placement);
        accept?.(placement);
      }
    }
    if (state.steps >= maxPathLength) continue;
    for (const action of TRANSITIONS) {
      const nextPoses: ActivePiece[] = [];
      let nextCellKey: string | null = null;
      let legal = true;
      for (const pose of state.poses) {
        const next = applyRuntimeAction(board, pose, action);
        if (!next || next.y < Math.min(-4, current.y)) { legal = false; break; }
        if (state.poses.length > 1) {
          const occupied = cellKey(next);
          if (nextCellKey !== null && occupied !== nextCellKey) { legal = false; break; }
          nextCellKey = occupied;
        }
        nextPoses.push(next);
      }
      if (!legal) continue;
      const key = nextPoses.map(poseKey).join('|');
      if (visited.has(key) || visited.size >= maxStates) continue;
      visited.add(key);
      queue.push({ poses: nextPoses, parent: index, action, steps: state.steps + 1 });
    }
  }
  return [...placements.values()];
}

/** Public deterministic reachability helper, with the same bounded BFS as every search ply. */
export function reachablePlacements(board: Board, current: ActivePiece, options: SearchOptions = {}): readonly RuntimePlacement[] {
  const now = options.now ?? (() => performance.now());
  const started = now();
  return generate(board, [current], { started, deadline: started + finitePositive(options.budgetMs, 100), now, maxNodes: positiveInteger(options.maxNodes, 10_000, 1_000_000), nodes: 0, exhausted: false }, options);
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value))) : fallback;
}
function finitePositive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

interface BeamNode {
  readonly board: Board;
  readonly queue: readonly PieceType[];
  readonly hold: PieceType | null;
  readonly first: RuntimePlacement;
  readonly kind: 'place' | 'hold';
  readonly rootHoldTarget: ActivePiece | null;
  readonly reward: number;
  readonly score: number;
}

function clearReward(cleared: number): number { return [0, 5, 13, 24, 38][cleared] ?? cleared * 10; }
function validRuntimePose(value: unknown): value is ActivePiece {
  if (!value || typeof value !== 'object') return false;
  const piece = value as ActivePiece;
  return PIECE_TYPES.includes(piece.type)
    && Number.isInteger(piece.x) && piece.x >= -4 && piece.x < BOARD_WIDTH
    && Number.isInteger(piece.y) && piece.y >= -4 && piece.y < BOARD_HEIGHT
    && Number.isInteger(piece.rotation) && piece.rotation >= 0 && piece.rotation <= 3;
}

/** Validate the structured-clone boundary too; never coerce malformed fields. */
function validSnapshot(value: unknown): value is RuntimeSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as RuntimeSnapshot;
  const counter = (number: unknown): boolean => typeof number === 'number' && Number.isSafeInteger(number) && number >= 0;
  if (typeof snapshot.paused !== 'boolean' || typeof snapshot.ended !== 'boolean' || snapshot.paused || snapshot.ended
    || !Array.isArray(snapshot.board) || snapshot.board.length !== BOARD_HEIGHT
    || !Array.from(snapshot.board).every((row) => Number.isInteger(row) && row >= 0 && row <= FULL_ROW)
    || !validRuntimePose(snapshot.current)
    || !Array.isArray(snapshot.next) || snapshot.next.length > 5 || !Array.from(snapshot.next).every((type) => PIECE_TYPES.includes(type))
    || snapshot.hold !== null && !PIECE_TYPES.includes(snapshot.hold)
    || snapshot.canHold !== null && typeof snapshot.canHold !== 'boolean'
    || !['session', 'player', 'fingerprint'].every((key) => typeof (value as Record<string, unknown>)[key] === 'string' && (value as Record<string, string>)[key]!.length > 0)
    || !Number.isFinite(snapshot.observedAt) || snapshot.observedAt < 0 || !counter(snapshot.observation)
    || snapshot.lines !== null && !counter(snapshot.lines)
    || snapshot.incoming !== null && !counter(snapshot.incoming)) return false;
  if (snapshot.rotationCandidates === undefined) return true;
  if (!Array.isArray(snapshot.rotationCandidates) || snapshot.rotationCandidates.length < 1 || snapshot.rotationCandidates.length > 4) return false;
  const candidates = Array.from(snapshot.rotationCandidates);
  const currentCells = cellKey(snapshot.current);
  if (!candidates.every((piece) => validRuntimePose(piece) && piece.type === snapshot.current.type && cellKey(piece) === currentCells)) return false;
  const keys = candidates.map(poseKey);
  return new Set(keys).size === keys.length && keys.includes(poseKey(snapshot.current));
}

/**
 * Anytime CPU search. A legal one-ply result is retained before future BFS work.
 * All plies share one clock/node budget; expired work never replaces a completed depth.
 */
export function search(snapshot: RuntimeSnapshot, options: SearchOptions = {}): RuntimePlan | null {
  if (!validSnapshot(snapshot)) return null;
  const now = options.now ?? (() => performance.now());
  const started = now();
  const budget: Budget = { started, deadline: started + finitePositive(options.budgetMs, 45), now, maxNodes: positiveInteger(options.maxNodes, 12_000, 1_000_000), nodes: 0, exhausted: false };
  const requestedDepth = positiveInteger(options.depth, 2, 5);
  const beamWidth = positiveInteger(options.beamWidth, 8, 64);
  const roots: BeamNode[] = [];
  const makeRoot = (placement: RuntimePlacement, kind: 'place' | 'hold', queue: readonly PieceType[], hold: PieceType | null, rootHoldTarget: ActivePiece | null): void => {
    const reward = clearReward(placement.cleared) - placement.path.length * 0.025 - (kind === 'hold' ? 0.4 : 0);
    roots.push({ board: placement.board, queue, hold, first: placement, kind, rootHoldTarget, reward, score: evaluateBoard(placement.board, snapshot.incoming) + reward });
  };
  const poses = snapshot.rotationCandidates && snapshot.rotationCandidates.length > 0 ? snapshot.rotationCandidates : [snapshot.current];
  generate(snapshot.board, poses, budget, options, (placement) => makeRoot(placement, 'place', snapshot.next, snapshot.hold, null));
  if (snapshot.canHold === true && options.allowHold !== false && !budget.exhausted) {
    const replacement = snapshot.hold ?? snapshot.next[0];
    if (replacement) {
      const spawn = spawnPiece(snapshot.board, replacement);
      const next = snapshot.hold === null ? snapshot.next.slice(1) : snapshot.next;
      if (spawn) generate(snapshot.board, [spawn], budget, options, (placement) => makeRoot(placement, 'hold', next, snapshot.current.type, spawn));
    }
  }
  if (roots.length === 0) return null;
  // Empty HOLD consumes one visible NEXT entry. Use the same known horizon for
  // every root, rather than rewarding a branch merely for running out of data.
  const depthLimit = Math.min(requestedDepth, 1 + Math.min(...roots.map((root) => root.queue.length)));
  roots.sort(compareNodes);
  let selected = roots[0]!;
  let completedDepth = 1;
  let beam = roots.slice(0, beamWidth);
  // Iterative beam expansion: do not compare a partially expanded depth against
  // untouched roots, which would bias plans toward whichever root was visited first.
  for (let depth = 2; depth <= depthLimit && !budget.exhausted; depth += 1) {
    const children: BeamNode[] = [];
    const transpositions = new Map<string, number>();
    let complete = true;
    for (const parent of beam) {
      const nextType = parent.queue[0];
      if (!nextType) { children.push(parent); continue; }
      const choices: { type: PieceType; queue: readonly PieceType[]; hold: PieceType | null; cost: number }[] = [{ type: nextType, queue: parent.queue.slice(1), hold: parent.hold, cost: 0 }];
      if (options.allowHold !== false) {
        const replacement = parent.hold ?? parent.queue[1];
        if (replacement && replacement !== nextType) choices.push({ type: replacement, queue: parent.hold === null ? parent.queue.slice(2) : parent.queue.slice(1), hold: nextType, cost: 0.4 });
      }
      for (const choice of choices) {
        const spawn = spawnPiece(parent.board, choice.type);
        if (!spawn) continue;
        generate(parent.board, [spawn], budget, options, (placement) => {
          const reward = parent.reward + clearReward(placement.cleared) * 0.92 ** (depth - 1) - placement.path.length * 0.012 - choice.cost;
          const score = evaluateBoard(placement.board, snapshot.incoming) + reward;
          const key = `${placement.board.join(',')}:${choice.hold ?? '-'}:${choice.queue.join('')}`;
          if ((transpositions.get(key) ?? -Infinity) >= score) return;
          transpositions.set(key, score);
          children.push({ ...parent, board: placement.board, queue: choice.queue, hold: choice.hold, reward, score });
        });
        if (budget.exhausted) { complete = false; break; }
      }
      if (!complete) break;
    }
    if (!complete || children.length === 0) break;
    children.sort(compareNodes);
    beam = children.slice(0, beamWidth);
    selected = beam[0]!;
    completedDepth = depth;
  }
  const assumptions = ['Public client physics; server corrections and lock timing require observed validation', 'No attack, spin, or random future garbage prediction'];
  if (poses.length > 1) assumptions.push('Ambiguous rotation: path must produce identical occupied cells for every candidate');
  if (completedDepth > 1) assumptions.push('Future pieces use the public client spawn rule and only the visible queue');
  if (selected.kind === 'hold') assumptions.push('HOLD is a separate transition; reobserve before planning any placement');
  return {
    kind: selected.kind,
    path: selected.kind === 'place' ? selected.first.path : [],
    target: selected.kind === 'place' ? selected.first.target : selected.rootHoldTarget!,
    expectedBoard: selected.kind === 'place' ? selected.first.board : [...snapshot.board],
    cleared: selected.kind === 'place' ? selected.first.cleared : 0,
    score: selected.score,
    nodes: budget.nodes,
    elapsedMs: Math.max(0, now() - started),
    fingerprint: snapshot.fingerprint,
    session: snapshot.session,
    player: snapshot.player,
    observation: snapshot.observation,
    depth: completedDepth,
    budgetExhausted: budget.exhausted,
    ruleProfile: RUNTIME_RULE_PROFILE.id,
    assumptions,
  };
}

function compareNodes(left: BeamNode, right: BeamNode): number {
  return right.score - left.score || (left.kind === 'place' ? 0 : 1) - (right.kind === 'place' ? 0 : 1)
    || left.first.path.length - right.first.path.length || left.first.target.x - right.first.target.x
    || left.first.target.rotation - right.first.target.rotation;
}
