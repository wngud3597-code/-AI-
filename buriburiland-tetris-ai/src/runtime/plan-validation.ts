import { ACTIONS } from '../move/ReachableMoveGenerator';
import { BOARD_HEIGHT, BOARD_WIDTH, FULL_ROW, PIECE_TYPES } from '../types/game';
import { applyRuntimeAction, collides, lockPiece, runtimeCells, spawnPiece } from './engine';
import { RUNTIME_RULE_PROFILE, type ActivePiece, type Board, type RuntimePlan, type RuntimeSnapshot } from './model';

function equal<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validBoard(board: Board): boolean {
  return Array.isArray(board) && board.length === BOARD_HEIGHT
    && Array.from(board).every(row => Number.isInteger(row) && row >= 0 && row <= FULL_ROW);
}

function validPose(pose: ActivePiece): boolean {
  return !!pose && PIECE_TYPES.includes(pose.type)
    && Number.isInteger(pose.x) && pose.x >= -4 && pose.x < BOARD_WIDTH
    && Number.isInteger(pose.y) && pose.y >= -4 && pose.y < BOARD_HEIGHT
    && Number.isInteger(pose.rotation) && pose.rotation >= 0 && pose.rotation <= 3;
}

function cellKey(pose: ActivePiece): string {
  return runtimeCells(pose).map(([x, y]) => `${x},${y}`).sort().join(';');
}

function poseKey(pose: ActivePiece): string {
  return `${pose.type}/${pose.x}/${pose.y}/${pose.rotation}`;
}

function candidates(snapshot: RuntimeSnapshot): readonly ActivePiece[] {
  return snapshot.rotationCandidates ?? [snapshot.current];
}

function validSnapshot(snapshot: RuntimeSnapshot): boolean {
  const counter = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
  if (!snapshot || !validBoard(snapshot.board) || !validPose(snapshot.current)
    || snapshot.paused !== false || snapshot.ended !== false
    || ![snapshot.session, snapshot.player, snapshot.fingerprint].every(value => typeof value === 'string' && value.length > 0)
    || !counter(snapshot.observation) || !Number.isFinite(snapshot.observedAt) || snapshot.observedAt < 0
    || !Array.isArray(snapshot.next) || snapshot.next.length > 5 || !Array.from(snapshot.next).every(type => PIECE_TYPES.includes(type))
    || snapshot.hold !== null && !PIECE_TYPES.includes(snapshot.hold)
    || snapshot.canHold !== null && typeof snapshot.canHold !== 'boolean'
    || snapshot.lines !== null && !counter(snapshot.lines)
    || snapshot.incoming !== null && !counter(snapshot.incoming)) return false;
  const poses = candidates(snapshot);
  if (!Array.isArray(poses) || poses.length < 1 || poses.length > 4) return false;
  const occupied = cellKey(snapshot.current);
  if (!Array.from(poses).every(pose => validPose(pose) && pose.type === snapshot.current.type
    && cellKey(pose) === occupied && !collides(snapshot.board, pose.type, pose.rotation, pose.x, pose.y))) return false;
  const keys = poses.map(poseKey);
  return new Set(keys).size === keys.length && keys.includes(poseKey(snapshot.current));
}

function validPlacement(snapshot: RuntimeSnapshot, plan: RuntimePlan): boolean {
  if (!Array.isArray(plan.path) || plan.path.length < 1 || plan.path.length > 121
    || plan.path.at(-1) !== 'HARD_DROP' || plan.target.type !== snapshot.current.type
    || !Array.from(plan.path).every((action, index) => ACTIONS.includes(action)
      && (action !== 'HARD_DROP' || index === plan.path.length - 1))) return false;
  let poses = candidates(snapshot);
  for (const action of plan.path) {
    const advanced: ActivePiece[] = [];
    let occupied: string | null = null;
    for (const pose of poses) {
      const next = applyRuntimeAction(snapshot.board, pose, action);
      if (!next) return false;
      const cells = cellKey(next);
      if (occupied !== null && occupied !== cells) return false;
      occupied = cells;
      advanced.push(next);
    }
    poses = advanced;
  }
  const target = cellKey(plan.target);
  return poses.every(pose => {
    if (cellKey(pose) !== target) return false;
    const locked = lockPiece(snapshot.board, pose.type, pose.rotation, pose.x, pose.y);
    return locked !== null && !locked.topOut && locked.cleared === plan.cleared && equal(locked.board, plan.expectedBoard);
  });
}

/**
 * A changed observation may reuse a completed search only when gravity is the
 * entire change and its original path still proves the very same placement.
 * This never repairs, trims, or guesses an input path. Unproven changes replan.
 */
export function rebaseGravityPlan(before: RuntimeSnapshot, fresh: RuntimeSnapshot, plan: RuntimePlan): RuntimePlan | null {
  if (!validSnapshot(before) || !validSnapshot(fresh) || !plan
    || plan.ruleProfile !== RUNTIME_RULE_PROFILE.id
    || plan.session !== before.session || plan.player !== before.player
    || plan.fingerprint !== before.fingerprint || plan.observation !== before.observation
    || !validPose(plan.target) || !validBoard(plan.expectedBoard)
    || !Number.isInteger(plan.cleared) || plan.cleared < 0 || plan.cleared > 4
    || fresh.session !== before.session || fresh.player !== before.player
    || fresh.observation <= before.observation || fresh.observedAt < before.observedAt
    || !equal(before.board, fresh.board) || !equal(before.next, fresh.next)
    || before.hold !== fresh.hold || before.canHold !== fresh.canHold
    || before.lines !== fresh.lines || before.incoming !== fresh.incoming
    || before.current.type !== fresh.current.type) return null;

  const down = fresh.current.y - before.current.y;
  if (down <= 0 || cellKey({ ...before.current, y: before.current.y + down }) !== cellKey(fresh.current)) return null;
  const translated = candidates(before).map(pose => ({ ...pose, y: pose.y + down }));
  if (!equal(translated.map(poseKey).sort(), candidates(fresh).map(poseKey).sort())) return null;
  // Endpoints alone cannot prove gravity: never permit a teleport through a row.
  for (const pose of candidates(before)) {
    for (let amount = 1; amount <= down; amount += 1) {
      if (collides(before.board, pose.type, pose.rotation, pose.x, pose.y + amount)) return null;
    }
  }

  if (plan.kind === 'place') {
    if (!validPlacement(before, plan) || !validPlacement(fresh, plan)) return null;
  } else if (plan.kind === 'hold') {
    const replacement = before.hold ?? before.next[0];
    const spawn = replacement ? spawnPiece(before.board, replacement) : null;
    if (before.canHold !== true || !Array.isArray(plan.path) || plan.path.length !== 0
      || plan.cleared !== 0 || !equal(plan.expectedBoard, before.board)
      || !spawn || poseKey(spawn) !== poseKey(plan.target)) return null;
  } else return null;

  return { ...plan, fingerprint: fresh.fingerprint, session: fresh.session,
    player: fresh.player, observation: fresh.observation };
}
