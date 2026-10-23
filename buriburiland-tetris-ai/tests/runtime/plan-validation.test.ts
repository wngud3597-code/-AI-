import { describe, expect, it } from 'vitest';
import { applyRuntimeAction, lockPiece } from '../../src/runtime/engine';
import { RUNTIME_RULE_PROFILE, type ActivePiece, type MoveAction, type RuntimePlan, type RuntimeSnapshot } from '../../src/runtime/model';
import { rebaseGravityPlan } from '../../src/runtime/plan-validation';

const empty = () => Array<number>(20).fill(0);
const lockedO = (x = 3) => [...Array<number>(18).fill(0), 3 << x, 3 << x];
function snapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return { board: empty(), current: { type: 'O', x: 3, y: 0, rotation: 0 },
    next: ['I', 'T', 'S', 'Z', 'J'], hold: null, canHold: true,
    fingerprint: 'before', session: 'session', player: 'main', observation: 1,
    observedAt: 10, paused: false, ended: false, lines: 0, incoming: null, ...overrides };
}
function dropped(before: RuntimeSnapshot, amount = 1, overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  const down = (pose: ActivePiece) => ({ ...pose, y: pose.y + amount });
  return { ...before, current: down(before.current), fingerprint: 'fresh', observation: before.observation + 1,
    observedAt: before.observedAt + 50,
    ...(before.rotationCandidates ? { rotationCandidates: before.rotationCandidates.map(down) } : {}), ...overrides };
}
function placement(before: RuntimeSnapshot, overrides: Partial<RuntimePlan> = {}): RuntimePlan {
  return { kind: 'place', path: ['HARD_DROP'], target: { type: 'O', x: 3, y: 18, rotation: 0 },
    expectedBoard: lockedO(), cleared: 0, score: 0, nodes: 1, elapsedMs: 2,
    fingerprint: before.fingerprint, session: before.session, player: before.player,
    observation: before.observation, depth: 1, budgetExhausted: false,
    ruleProfile: RUNTIME_RULE_PROFILE.id, assumptions: [], ...overrides };
}
function calculatedPlan(before: RuntimeSnapshot, path: readonly MoveAction[]): RuntimePlan {
  let target = before.current;
  for (const action of path) {
    const next = applyRuntimeAction(before.board, target, action);
    if (!next) throw new Error('Test path is blocked');
    target = next;
  }
  const result = lockPiece(before.board, target.type, target.rotation, target.x, target.y)!;
  return placement(before, { path, target, expectedBoard: result.board, cleared: result.cleared });
}

describe('gravity-only completed plan validation', () => {
  it('reuses the same placement after natural descent and binds fresh observation metadata', () => {
    const before = snapshot(), fresh = dropped(before, 3), plan = placement(before);
    const original = JSON.stringify({ before, fresh, plan });
    const result = rebaseGravityPlan(before, fresh, plan);
    expect(result).toEqual({ ...plan, fingerprint: fresh.fingerprint, observation: fresh.observation });
    expect(result).not.toBe(plan);
    expect(JSON.stringify({ before, fresh, plan })).toBe(original);
  });

  it('revalidates lateral movement and line clears from the descended pose', () => {
    const board = empty(); board[18] = 1023 ^ 12; board[19] = 1023 ^ 12;
    const before = snapshot({ board });
    const plan = placement(before, { path: ['LEFT', 'HARD_DROP'], target: { type: 'O', x: 2, y: 18, rotation: 0 }, expectedBoard: empty(), cleared: 2 });
    expect(rebaseGravityPlan(before, dropped(before, 8), plan)).not.toBeNull();
  });

  it('accepts a path preserving the occupied cells for all symmetric candidates', () => {
    const current: ActivePiece = { type: 'I', x: 3, y: 0, rotation: 0 };
    const before = snapshot({ current, rotationCandidates: [current, { ...current, rotation: 2 }] });
    const plan = calculatedPlan(before, ['LEFT', 'HARD_DROP']);
    expect(rebaseGravityPlan(before, dropped(before), plan)).not.toBeNull();
  });

  it('rejects rotations diverging across visually identical I candidates', () => {
    const current: ActivePiece = { type: 'I', x: 3, y: 2, rotation: 0 };
    const before = snapshot({ current, rotationCandidates: [current, { ...current, rotation: 2 }] });
    const plan = calculatedPlan(before, ['ROTATE_CW', 'HARD_DROP']);
    expect(rebaseGravityPlan(before, dropped(before), plan)).toBeNull();
  });

  it('rejects a formerly legal soft drop that is blocked after gravity reaches the floor', () => {
    const before = snapshot({ current: { type: 'O', x: 3, y: 17, rotation: 0 } });
    const plan = placement(before, { path: ['SOFT_DROP', 'HARD_DROP'] });
    expect(rebaseGravityPlan(before, dropped(before), plan)).toBeNull();
  });

  it('rejects a route that can no longer move past an obstacle after descent', () => {
    const board = empty(); board[2] = 1 << 2;
    const before = snapshot({ board });
    const plan = calculatedPlan(before, ['LEFT', 'HARD_DROP']);
    expect(rebaseGravityPlan(before, dropped(before), plan)).toBeNull();
  });

  it('rejects changed kick outcomes even when every fresh action remains legal', () => {
    const before = snapshot({ current: { type: 'T', x: 3, y: 16, rotation: 0 } });
    const plan = calculatedPlan(before, ['ROTATE_CW', 'HARD_DROP']);
    // Near the floor the ordered client kick changes the occupied landing cells.
    const fresh = dropped(before, 2);
    const freshPlan = calculatedPlan(fresh, plan.path);
    expect(freshPlan.target).not.toEqual(plan.target);
    expect(rebaseGravityPlan(before, fresh, plan)).toBeNull();
  });

  it.each([
    ['board', { board: [...Array<number>(19).fill(0), 1] }],
    ['NEXT', { next: ['L', 'T', 'S', 'Z', 'J'] }],
    ['hold', { hold: 'J' }], ['canHold', { canHold: false }],
    ['lines', { lines: 1 }], ['incoming', { incoming: 1 }],
    ['room', { session: 'another-room' }], ['player', { player: 'spectator' }],
    ['paused', { paused: true }], ['ended', { ended: true }],
    ['old observation', { observation: 1 }], ['old time', { observedAt: 9 }],
  ] as const)('rejects changed %s instead of treating it as gravity', (_label, changes) => {
    const before = snapshot();
    expect(rebaseGravityPlan(before, dropped(before, 1, changes), placement(before))).toBeNull();
  });

  it.each([
    ['fingerprint', { fingerprint: 'wrong' }], ['session', { session: 'wrong' }],
    ['player', { player: 'wrong' }], ['observation', { observation: 0 }],
    ['rules', { ruleProfile: 'different-physics' }],
  ])('rejects a plan with stale %s binding', (_label, changes) => {
    const before = snapshot();
    expect(rebaseGravityPlan(before, dropped(before), placement(before, changes as Partial<RuntimePlan>))).toBeNull();
  });

  it.each([0, -1])('does not rebase a vertical delta of %s', amount => {
    const before = snapshot({ current: { type: 'O', x: 3, y: 3, rotation: 0 } });
    expect(rebaseGravityPlan(before, dropped(before, amount), placement(before))).toBeNull();
  });

  it('rejects horizontal drift, changed type, and changed possible rotations', () => {
    const before = snapshot();
    for (const current of [
      { ...before.current, x: 4, y: 1 },
      { ...before.current, type: 'T' as const, y: 1 },
    ]) expect(rebaseGravityPlan(before, dropped(before, 1, { current }), placement(before))).toBeNull();
    const fresh = dropped(before);
    expect(rebaseGravityPlan(before, { ...fresh, rotationCandidates: [fresh.current, { ...fresh.current, rotation: 2 }] }, placement(before))).toBeNull();
  });

  it('rejects a teleport across a filled row even with valid endpoints', () => {
    const board = empty(); board[4] = 3 << 3;
    const before = snapshot({ board });
    const plan = calculatedPlan(before, ['HARD_DROP']);
    expect(rebaseGravityPlan(before, dropped(before, 6), plan)).toBeNull();
  });

  it.each([
    [], ['LEFT'], ['HARD_DROP', 'LEFT'], ['HARD_DROP', 'HARD_DROP'], ['HOLD', 'HARD_DROP'], ['UNKNOWN', 'HARD_DROP'],
  ].map(path => ({ path })))('rejects an illegal placement path $path', ({ path }) => {
    const before = snapshot();
    expect(rebaseGravityPlan(before, dropped(before), placement(before, { path: path as MoveAction[] }))).toBeNull();
  });

  it('rejects wrong target, predicted board, or clear count', () => {
    const before = snapshot();
    for (const changes of [
      { target: { type: 'O' as const, x: 4, y: 18, rotation: 0 as const } },
      { expectedBoard: lockedO(4) }, { cleared: 1 }, { target: { type: 'I' as const, x: 3, y: 19, rotation: 0 as const } },
    ]) expect(rebaseGravityPlan(before, dropped(before), placement(before, changes))).toBeNull();
  });

  it('rejects a top-out even if its partial board matches the prediction', () => {
    const board = empty(); board[0] = 1023;
    const before = snapshot({ board, current: { type: 'I', x: 3, y: -2, rotation: 0 } });
    const plan = calculatedPlan(before, ['HARD_DROP']);
    expect(plan.target.y).toBe(-1);
    expect(rebaseGravityPlan(before, dropped(before), plan)).toBeNull();
  });

  it('rejects malformed snapshots and malformed plan arrays without throwing', () => {
    const before = snapshot();
    for (const changes of [
      { board: Array<number>(20) }, { board: [...Array<number>(19).fill(0), NaN] },
      { current: { ...before.current, y: Infinity } }, { rotationCandidates: [] },
      { next: Array(5) }, { incoming: -1 },
    ]) expect(rebaseGravityPlan(before, dropped(before, 1, changes), placement(before))).toBeNull();
    expect(rebaseGravityPlan(before, dropped(before), placement(before, { path: Array(2) }))).toBeNull();
  });
});

describe('gravity-only HOLD validation', () => {
  function holdPlan(before: RuntimeSnapshot, overrides: Partial<RuntimePlan> = {}): RuntimePlan {
    return placement(before, { kind: 'hold', path: [], expectedBoard: before.board, cleared: 0,
      target: { type: before.hold ?? before.next[0]!, x: 3, y: 0, rotation: 0 }, ...overrides });
  }

  it.each([null, 'L'] as const)('preserves a legal HOLD transition with held piece %s', hold => {
    const before = snapshot({ hold });
    expect(rebaseGravityPlan(before, dropped(before, 2), holdPlan(before))).toMatchObject({ kind: 'hold', observation: 2 });
  });

  it('rejects HOLD when capability, replacement target, board, or empty path is unproven', () => {
    const before = snapshot();
    for (const changes of [
      { path: ['HARD_DROP'] as const }, { expectedBoard: lockedO() }, { cleared: 1 },
      { target: { type: 'I' as const, x: 4, y: 0, rotation: 0 as const } },
    ]) expect(rebaseGravityPlan(before, dropped(before), holdPlan(before, changes))).toBeNull();
    const unavailable = snapshot({ canHold: false });
    expect(rebaseGravityPlan(unavailable, dropped(unavailable), holdPlan(unavailable))).toBeNull();
  });
});
