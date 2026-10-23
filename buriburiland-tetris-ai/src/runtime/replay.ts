import { applyRuntimeAction, collides, lockPiece } from './engine';
import { runtimeCells } from './engine';
import { detectGarbageRise, type GarbageRise } from './board-transition';
import type { RecoveryEvidence, RuntimeRecord } from './control';
import type { ActivePiece, Board, MoveAction, RuntimeSnapshot } from './model';
import { RUNTIME_RULE_PROFILE } from './model';
export interface ReplayResult {
  line: number;
  status: 'display-consistent' | 'display-consistent-ambiguous' | 'hold-consistent' | 'observed-rise-consistent' | 'interrupted-replan' | 'divergence-unclassified' | 'cancelled' | 'incomplete' | 'shadow' | 'invalid' | 'unsupported-profile';
  board: 'match' | 'mismatch' | 'unknown';
  clear: 'match' | 'mismatch' | 'unknown';
  reason: string;
  differingCells?: number;
  synthetic: boolean;
}
const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((value, index) => value === b[index]);
function validBoard(board: unknown): board is Board {
  return Array.isArray(board) && board.length === 20 && Array.from(board).every((row, y) => Object.prototype.hasOwnProperty.call(board, y) && Number.isInteger(row) && row >= 0 && row <= 1023);
}
function validPose(pose: unknown): pose is ActivePiece {
  if (!pose || typeof pose !== 'object') return false;
  const p = pose as ActivePiece;
  return ['I', 'O', 'T', 'S', 'Z', 'J', 'L'].includes(p.type) && Number.isInteger(p.x) && Number.isInteger(p.y) && p.y >= -4 && p.y < 20 && [0, 1, 2, 3].includes(p.rotation);
}
function validObservation(value: unknown): value is RuntimeSnapshot {
  if (!value || typeof value !== 'object') return false;
  const observation = value as RuntimeSnapshot;
  const typeOK = (type: unknown) => typeof type === 'string' && ['I', 'O', 'T', 'S', 'Z', 'J', 'L'].includes(type);
  return validBoard(observation.board) && validPose(observation.current)
    && Array.isArray(observation.next) && observation.next.length <= 32 && Array.from(observation.next).every(typeOK)
    && (observation.hold === null || typeOK(observation.hold))
    && (observation.canHold === null || typeof observation.canHold === 'boolean')
    && ['fingerprint', 'session', 'player'].every((key) => typeof (value as Record<string, unknown>)[key] === 'string' && (value as Record<string, string>)[key]!.length > 0)
    && Number.isInteger(observation.observation) && observation.observation >= 0
    && Number.isFinite(observation.observedAt)
    && typeof observation.paused === 'boolean' && typeof observation.ended === 'boolean'
    && (observation.lines === null || Number.isInteger(observation.lines) && observation.lines >= 0)
    && (observation.incoming === null || Number.isInteger(observation.incoming) && observation.incoming >= 0)
    && (observation.rotationCandidates === undefined || Array.isArray(observation.rotationCandidates) && observation.rotationCandidates.length >= 1 && observation.rotationCandidates.length <= 4 && Array.from(observation.rotationCandidates).every(validPose));
}

function validRecovery(value: unknown): value is RecoveryEvidence {
  if (!value || typeof value !== 'object') return false;
  const recovery = value as RecoveryEvidence;
  if (!['garbage-rise', 'gravity-advance'].includes(recovery.reason)
    || !['before-input', 'movement', 'after-lock', 'after-hold'].includes(recovery.phase)
    || !['before', 'predicted-lock'].includes(recovery.reference)
    || ![null, 'HARD_DROP', 'HOLD'].includes(recovery.completedAction)) return false;
  if (recovery.reason === 'gravity-advance') return recovery.rise === null;
  const rise = recovery.rise;
  return !!rise && typeof rise === 'object' && Number.isInteger(rise.rows) && rise.rows >= 1 && rise.rows < 20
    && Array.isArray(rise.holes) && rise.holes.length === rise.rows
    && Array.from(rise.holes).every(hole => Number.isInteger(hole) && hole >= 0 && hole < 10)
    && Array.isArray(rise.insertedRows) && rise.insertedRows.length === rise.rows
    && Array.from(rise.insertedRows).every(row => Number.isInteger(row) && row >= 0 && row <= 1023);
}
function sameRise(left: GarbageRise | null, right: GarbageRise | null): boolean {
  return left !== null && right !== null && left.rows === right.rows && same(left.holes, right.holes) && same(left.insertedRows, right.insertedRows);
}
const cellKey = (pose: ActivePiece) => runtimeCells(pose).map(([x, y]) => `${x},${y}`).sort().join(';');
function initialPoses(before: RuntimeSnapshot): readonly ActivePiece[] | null {
  const poses = before.rotationCandidates?.length ? before.rotationCandidates : [before.current];
  return poses.every(pose => validPose(pose) && pose.type === before.current.type && cellKey(pose) === cellKey(before.current)) ? poses : null;
}
function replayPoses(before: RuntimeSnapshot, actions: readonly MoveAction[], poses: readonly ActivePiece[]): readonly ActivePiece[] {
  const result: ActivePiece[] = [];
  for (const initial of poses) {
    let pose: ActivePiece | null = initial;
    for (const action of actions) {
      pose = applyRuntimeAction(before.board, pose, action);
      if (!pose) break;
    }
    if (pose) result.push(pose);
  }
  return result;
}
function sameCounters(before: RuntimeSnapshot, after: RuntimeSnapshot): boolean {
  return before.lines === null || after.lines === null || before.lines === after.lines;
}
function sameUnfinishedContext(before: RuntimeSnapshot, after: RuntimeSnapshot): boolean {
  return before.hold === after.hold && before.canHold === after.canHold && same(before.next, after.next) && sameCounters(before, after);
}
function holdTransition(before: RuntimeSnapshot, after: RuntimeSnapshot): boolean {
  const expectedType = before.hold ?? before.next[0];
  const expectedQueue = before.hold === null ? before.next.slice(1) : before.next;
  const queueOK = before.hold === null
    ? before.next.length > 0 && after.next.length === before.next.length && same(after.next.slice(0, expectedQueue.length), expectedQueue)
    : same(after.next, expectedQueue);
  return before.canHold === true && expectedType === after.current.type && after.hold === before.current.type
    && after.canHold === false && queueOK && sameCounters(before, after);
}
function lockTransition(before: RuntimeSnapshot, after: RuntimeSnapshot): boolean {
  return before.next.length > 0 && after.current.type === before.next[0]
    && after.next.length === before.next.length && same(after.next.slice(0, before.next.length - 1), before.next.slice(1))
    && after.hold === before.hold && after.canHold === true;
}
function compareBoard(left: Board, right: Board): number {
  let differences = 0;
  for (let row = 0; row < 20; row++) {
    let mask = left[row]! ^ right[row]!;
    while (mask) { differences += mask & 1; mask >>>= 1; }
  }
  return differences;
}

/** Recompute from before + actual recorded actions; stored predicted boards are ignored. */
export function replayRecord(value: unknown, line = 1): ReplayResult {
  const fallback: ReplayResult = { line, status: 'invalid', board: 'unknown', clear: 'unknown', reason: '', synthetic: false };
  if (!value || typeof value !== 'object') return { ...fallback, reason: 'Expected a schema-2 object' };
  const raw = value as Record<string, unknown>;
  fallback.synthetic = raw.evidence === 'synthetic' || raw.evidence === 'local-browser-fixture';
  const record = value as RuntimeRecord;
  if (record.schema !== 2 || !record.before || !record.plan || !Array.isArray(record.actions) || record.actions.length > 121) return { ...fallback, reason: 'Missing schema-2 before, plan, or bounded executed actions' };
  if (record.ruleProfile !== RUNTIME_RULE_PROFILE.id || record.plan.ruleProfile !== record.ruleProfile) return { ...fallback, status: 'unsupported-profile', reason: 'This replay engine does not implement the recorded rule profile' };
  if (record.type === 'shadow') return { ...fallback, status: 'shadow', reason: 'No executed inputs; no fidelity claim' };
  if (record.result === 'cancelled') return { ...fallback, status: 'cancelled', reason: 'Cancelled execution; partial actions are not treated as a completed lock' };
  const { before, after, plan } = record;
  if (record.type === 'failure' || after === null) return { ...fallback, status: 'incomplete', reason: 'Failure or missing after observation; no completed-lock validation' };
  if (record.type !== 'resync' && (record.recovery !== undefined || record.result === 'resynced')) return { ...fallback, reason: 'Recovery metadata requires an explicit resync record' };
  if (!validObservation(before) || !validObservation(after)) return { ...fallback, reason: 'Invalid observation dimensions, masks, pose, queue, counters, or identifiers' };
  if (before.session !== after.session || before.player !== after.player || plan.session !== before.session || plan.player !== before.player
    || plan.fingerprint !== before.fingerprint || plan.observation !== before.observation || after.observation <= before.observation) {
    return { ...fallback, reason: 'Session/player/local-observation context changed or plan does not belong to before' };
  }
  if (!Number.isFinite(before.observedAt) || !Number.isFinite(after.observedAt) || after.observedAt < before.observedAt) return { ...fallback, reason: 'Invalid observation clock order' };
  let previousAt = before.observedAt;
  const actions: MoveAction[] = [];
  for (const evidence of record.actions) {
    if (!evidence || typeof evidence !== 'object') return { ...fallback, reason: 'Invalid action evidence' };
    if (!Number.isFinite(evidence.at) || evidence.at < previousAt || evidence.at > after.observedAt) return { ...fallback, reason: 'Missing or non-monotonic action timestamps' };
    previousAt = evidence.at;
    if (evidence.action !== 'HOLD' && !['LEFT', 'RIGHT', 'SOFT_DROP', 'ROTATE_CW', 'ROTATE_CCW', 'HARD_DROP'].includes(evidence.action)) return { ...fallback, reason: 'Unsupported executed action' };
    if (evidence.action !== 'HOLD') actions.push(evidence.action);
  }
  const poses = initialPoses(before);
  if (!poses) return { ...fallback, reason: 'Invalid ambiguous pose or cells do not match the before display' };
  let recovery: RecoveryEvidence | null = null;
  if (record.type === 'resync') {
    if (record.result !== 'resynced' || !validRecovery(record.recovery)) return { ...fallback, reason: 'Invalid resync result or recovery metadata' };
    recovery = record.recovery;
    if (after.paused || after.ended || collides(before.board, before.current.type, before.current.rotation, before.current.x, before.current.y)
      || collides(after.board, after.current.type, after.current.rotation, after.current.x, after.current.y)) {
      return { ...fallback, reason: 'Recovery requires legal before/after poses and a live after observation' };
    }
    const isAfterLock = recovery.phase === 'after-lock';
    if (recovery.reference !== (isAfterLock ? 'predicted-lock' : 'before')
      || recovery.completedAction !== (isAfterLock ? 'HARD_DROP' : recovery.phase === 'after-hold' ? 'HOLD' : null)
      || (recovery.reason === 'gravity-advance' && (isAfterLock || recovery.phase === 'after-hold'))) {
      return { ...fallback, reason: 'Recovery phase, reference, completed action, and reason disagree' };
    }
    if (recovery.phase === 'after-hold') {
      if (record.actions.length !== 1 || record.actions[0]!.action !== 'HOLD') return { ...fallback, reason: 'After-HOLD recovery requires exactly one recorded HOLD' };
      const rise = detectGarbageRise(before.board, after.board);
      if (!sameRise(rise, recovery.rise)) return { ...fallback, status: 'divergence-unclassified', reason: 'After-HOLD rise does not match recomputed board shift and recorded row/hole evidence' };
      if (!holdTransition(before, after)) return { ...fallback, status: 'divergence-unclassified', reason: 'After-HOLD recovery has an inconsistent hold, queue, eligibility, or known clear counter' };
      return { ...fallback, status: 'interrupted-replan', reason: 'Observed board rise and HOLD transition agree; no completed lock is scored, and server order, cancellation, and gravity timing were not replayed' };
    }
    if (!isAfterLock) {
      if (record.actions.some(action => action.action === 'HOLD' || action.action === 'HARD_DROP')
        || (recovery.phase === 'before-input' && record.actions.length !== 0)) {
        return { ...fallback, reason: 'Interrupted movement cannot contain a completed HOLD or hard drop; before-input must contain no inputs' };
      }
      if (!sameUnfinishedContext(before, after) || before.current.type !== after.current.type) {
        return { ...fallback, status: 'divergence-unclassified', reason: 'Interrupted recovery changed queue, hold, eligibility, piece type, or known clear counter' };
      }
      if (recovery.reason === 'garbage-rise') {
        if (!sameRise(detectGarbageRise(before.board, after.board), recovery.rise)) {
          return { ...fallback, status: 'divergence-unclassified', reason: 'Interrupted rise does not match recomputed board shift and recorded row/hole evidence' };
        }
        return { ...fallback, status: 'interrupted-replan', reason: 'Interrupted inputs followed an observed garbage-shaped board rise; partial pose/timing, server order, and cancellation remain unknown, and no lock or clear accuracy is scored' };
      }
      const moved = replayPoses(before, actions, poses);
      const lowerShape = moved.some(pose => after.current.y > pose.y && cellKey({ ...pose, y: after.current.y }) === cellKey(after.current));
      if (!same(before.board, after.board) || !lowerShape) {
        return { ...fallback, status: 'divergence-unclassified', reason: 'Gravity recovery requires unchanged board/context and the recomputed shape strictly farther down' };
      }
      return { ...fallback, status: 'interrupted-replan', reason: 'Interrupted inputs ended with the same shape farther down; gravity timing was not replayed and no completed lock or clear accuracy is scored' };
    }
    if (record.actions.some(action => action.action === 'HOLD') || actions.at(-1) !== 'HARD_DROP' || actions.filter(action => action === 'HARD_DROP').length !== 1) {
      return { ...fallback, reason: 'After-lock recovery requires exactly one final recorded hard drop and no HOLD' };
    }
  }
  if (record.actions.length === 1 && record.actions[0]!.action === 'HOLD') {
    if (before.canHold !== true) return { ...fallback, reason: 'HOLD eligibility was not known true before execution' };
    const expectedType = before.hold ?? before.next[0];
    const expectedQueue = before.hold === null ? before.next.slice(1) : before.next;
    const queueOK = same(after.next.slice(0, expectedQueue.length), expectedQueue);
    const boardOK = same(before.board, after.board);
    const clearOK = before.lines === null || after.lines === null ? null : before.lines === after.lines;
    const matched = boardOK && clearOK !== false && expectedType === after.current.type && after.hold === before.current.type && after.canHold === false && queueOK;
    return { ...fallback, status: matched ? 'hold-consistent' : 'divergence-unclassified', board: boardOK ? 'match' : 'mismatch', clear: clearOK === null ? 'unknown' : clearOK ? 'match' : 'mismatch', reason: matched ? 'Recomputed HOLD transition matches displayed state' : 'HOLD display divergence; timing/server/exogenous cause is not established' };
  }
  if (record.actions.some((action) => action.action === 'HOLD') || actions.at(-1) !== 'HARD_DROP' || actions.filter((action) => action === 'HARD_DROP').length !== 1) return { ...fallback, reason: 'Placement must have exactly one final hard drop and no mixed HOLD' };
  const expected = new Map<string, { board: Board; cleared: number }>();
  let legalCandidates = 0;
  for (const pose of replayPoses(before, actions, poses)) {
    const locked = lockPiece(before.board, pose.type, pose.rotation, pose.x, pose.y);
    if (locked && !locked.topOut) { legalCandidates++; expected.set(`${locked.board.join(',')}/${locked.cleared}`, { board: locked.board, cleared: locked.cleared }); }
  }
  if (expected.size === 0) return { ...fallback, reason: 'Recorded inputs produce no legal non-top-out lock from the copied before pose' };
  const candidates = [...expected.values()];
  if (recovery !== null) {
    const risen = candidates.find(candidate => sameRise(detectGarbageRise(candidate.board, after.board), recovery.rise));
    if (!risen) return { ...fallback, status: 'divergence-unclassified', reason: 'After-lock recovery does not match any recomputed lock plus the recorded rise rows/holes; stored predictions are ignored' };
    const knownClear = before.lines !== null && after.lines !== null;
    const clearOK = !knownClear || after.lines! - before.lines! === risen.cleared;
    if (!lockTransition(before, after) || !clearOK) {
      return { ...fallback, status: 'divergence-unclassified', clear: knownClear ? clearOK ? 'match' : 'mismatch' : 'unknown', reason: 'After-lock rise has inconsistent next, hold, eligibility, or known clear delta' };
    }
    return { ...fallback, status: 'observed-rise-consistent', clear: knownClear ? 'match' : 'unknown',
      reason: 'Before + recorded inputs recompute a lock whose later displayed garbage-shaped rise agrees; this is post-observation consistency, not a predicted full-board match, authoritative server order, or cancellation validation' };
  }
  const match = candidates.find((candidate) => same(candidate.board, after.board));
  const closest = match ?? [...candidates].sort((a, b) => compareBoard(a.board, after.board) - compareBoard(b.board, after.board))[0]!;
  const clearKnown = before.lines !== null && after.lines !== null;
  const clearOK = clearKnown && after.lines! - before.lines! === closest.cleared;
  const consistent = match !== undefined && (!clearKnown || clearOK);
  return { ...fallback, status: consistent ? expected.size > 1 || legalCandidates < poses.length ? 'display-consistent-ambiguous' : 'display-consistent' : 'divergence-unclassified',
    board: match ? 'match' : 'mismatch', clear: clearKnown ? clearOK ? 'match' : 'mismatch' : 'unknown', differingCells: compareBoard(closest.board, after.board),
    reason: consistent ? 'Before + executed actions recomputed; displayed board/known clear delta agree (not authoritative server validation)'
      : 'Recomputed board/clear differs; gravity timing, server correction, input loss, and external garbage remain unclassified without event evidence' };
}


