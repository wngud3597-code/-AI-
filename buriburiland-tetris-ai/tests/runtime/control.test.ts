// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Cancellation, Cancelled, Controller, Recorder, WindowKeyboard,
  type ControlUpdate, type KeyboardPort, type Planner, type Reader,
} from '../../src/runtime/control';
import { RUNTIME_RULE_PROFILE, type RuntimePlan, type RuntimeSnapshot } from '../../src/runtime/model';
import { DomReadError } from '../../src/runtime/dom';
import { SCRIPT_VERSION } from '../../src/runtime/version';

// Handwritten display fixtures keep the control assertions independent of the
// planner's board prediction. An O at bbox (3,18) fills bits 3 and 4 twice.
const empty = () => Array<number>(20).fill(0);
const lockedO = (x = 3) => [...Array<number>(18).fill(0), 3 << x, 3 << x];
function snapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    board: empty(), current: { type: 'O', x: 3, y: 0, rotation: 0 },
    next: ['I', 'T', 'S', 'Z', 'J'], hold: null, canHold: true,
    fingerprint: 'fixture-before', session: 'fixture-session', player: 'main',
    observation: 1, observedAt: 0, paused: false, ended: false,
    lines: 0, incoming: null, ...overrides,
  };
}
function placement(before: RuntimeSnapshot, overrides: Partial<RuntimePlan> = {}): RuntimePlan {
  return {
    kind: 'place', path: ['HARD_DROP'], target: { type: 'O', x: 3, y: 18, rotation: 0 },
    expectedBoard: lockedO(), cleared: 0, score: 0, nodes: 1, elapsedMs: 2,
    fingerprint: before.fingerprint, session: before.session, player: before.player,
    observation: before.observation, depth: 1, budgetExhausted: false,
    ruleProfile: RUNTIME_RULE_PROFILE.id, assumptions: ['display-only fixture'], ...overrides,
  };
}
function afterPlacement(before: RuntimeSnapshot, overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return snapshot({
    ...before, board: lockedO(), current: { type: 'I', x: 3, y: 0, rotation: 0 },
    next: ['T', 'S', 'Z', 'J', 'L'], fingerprint: 'fixture-after', observation: 2, ...overrides,
  });
}
function fixture(before = snapshot(), chosen = placement(before)) {
  let current = before;
  const status = { inputEnabled: true, paused: false, ended: false, spectating: false };
  const reader: Reader = { read: vi.fn(() => current), status: vi.fn(() => status) };
  const planner: Planner = { plan: vi.fn(async () => chosen), cancel: vi.fn() };
  const keyboard: KeyboardPort = { tap: vi.fn(async (_action, _token, onSent?: () => void) => { onSent?.(); }), release: vi.fn() };
  const recorder = new Recorder();
  const controller = new Controller(reader, planner, keyboard, recorder, () => {}, () => Date.now());
  return { before, chosen, status, reader, planner, keyboard, recorder, controller,
    set: (next: RuntimeSnapshot) => { current = next; }, get: () => current };
}
async function settle(work: Promise<void>): Promise<void> {
  await vi.runAllTimersAsync();
  await work;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('runtime control transactions', () => {
  it('executes one placement and labels its board agreement as display-only', async () => {
    const f = fixture();
    vi.mocked(f.keyboard.tap).mockImplementation(async (action, _token, onSent?: () => void) => {
      onSent?.();
      if (action === 'HARD_DROP') f.set(afterPlacement(f.before));
    });
    await settle(f.controller.start('single'));
    expect(f.controller.state).toBe('STOPPED');
    expect(vi.mocked(f.keyboard.tap).mock.calls.map(([action]) => action)).toEqual(['HARD_DROP']);
    expect(f.recorder.records).toHaveLength(1);
    expect(f.recorder.records[0]).toMatchObject({
      scriptVersion: SCRIPT_VERSION, type: 'placement', result: 'display-match',
      validation: { board: 'match', clear: 'match', queue: 'match', attack: 'unknown', spin: 'unknown', authoritative: 'unknown', cancel: 'unknown', insertion: 'unknown' },
    });
  });

  it('produces a shadow decision without sending any input', async () => {
    const f = fixture();
    await f.controller.start('shadow');
    expect(f.keyboard.tap).not.toHaveBeenCalled();
    expect(f.recorder.records[0]).toMatchObject({ type: 'shadow', result: 'shadow', actions: [], after: null });
  });

  it('requires explicit restart if the room changes between continuous placements', async () => {
    const f = fixture();
    const updates: ControlUpdate[] = [];
    const controller = new Controller(f.reader, f.planner, f.keyboard, f.recorder, update => updates.push(update), () => Date.now());
    vi.mocked(f.keyboard.tap).mockImplementation(async (_action, _token, onSent?: () => void) => {
      onSent?.(); f.set(afterPlacement(f.before));
    });
    const work = controller.start('continuous');
    // The first display confirmation is complete, while the 250 ms pause
    // before another placement is still pending.
    await vi.advanceTimersByTimeAsync(120);
    expect(f.recorder.records[0]?.result).toBe('display-match');
    expect(f.planner.plan).toHaveBeenCalledOnce();
    f.set(snapshot({ session: 'new-room', fingerprint: 'new-room-observation' }));
    await settle(work);
    expect(controller.state).toBe('ERROR');
    expect(updates.at(-1)?.message).toContain('직접 다시 시작');
    expect(f.planner.plan).toHaveBeenCalledOnce();
    expect(vi.mocked(f.keyboard.tap).mock.calls.map(([action]) => action)).toEqual(['HARD_DROP']);
    expect(f.recorder.records).toHaveLength(1);
  });

  it.each(['I', 'S', 'Z'] as const)('carries observed %s spawn orientation into the next plan and clears it on stop', async type => {
    const before = snapshot({ next: [type, 'T', 'J', 'L', 'O'] });
    const f = fixture(before);
    const spawned = { type, x: 3, y: 0, rotation: 0 as const };
    const ambiguous = [spawned, { ...spawned, rotation: 2 as const }];
    const after = afterPlacement(before, { current: spawned, next: ['T', 'J', 'L', 'O', 'I'], rotationCandidates: ambiguous });
    const observations: RuntimeSnapshot[] = [];
    vi.mocked(f.planner.plan).mockImplementation(async seen => {
      observations.push(seen);
      // Inspect the next request without executing a second placement.
      if (observations.length === 2) f.controller.stop('F8 after first confirmed spawn');
      return placement(seen);
    });
    vi.mocked(f.keyboard.tap).mockImplementation(async (_action, _token, onSent?: () => void) => {
      onSent?.(); f.set(after);
    });
    await settle(f.controller.start('continuous'));
    expect(observations).toHaveLength(2);
    expect(observations[1]?.rotationCandidates).toEqual([spawned]);
    expect(f.recorder.records[0]?.result).toBe('display-match');
    expect(vi.mocked(f.keyboard.tap).mock.calls.map(([action]) => action)).toEqual(['HARD_DROP']);

    // The raw DOM stays ambiguous. Explicit stop prevents using old orientation
    // knowledge if a human plays before restarting the controller.
    await f.controller.start('shadow');
    expect(observations[2]?.rotationCandidates).toEqual(ambiguous);
    expect(f.keyboard.tap).toHaveBeenCalledTimes(1);
  });

  it('preserves symmetric rotation ambiguity when first attached', async () => {
    const current = { type: 'I' as const, x: 3, y: 0, rotation: 0 as const };
    const before = snapshot({ current, rotationCandidates: [current, { ...current, rotation: 2 }] });
    const f = fixture(before);
    await f.controller.start('shadow');
    expect(vi.mocked(f.planner.plan).mock.calls[0]?.[0].rotationCandidates).toEqual(before.rotationCandidates);
    expect(f.keyboard.tap).not.toHaveBeenCalled();
  });

  it('discards a planner response arriving after stop', async () => {
    const f = fixture();
    let resolve!: (plan: RuntimePlan) => void;
    vi.mocked(f.planner.plan).mockImplementation(() => new Promise(done => { resolve = done; }));
    const work = f.controller.start('single');
    expect(f.controller.state).toBe('PLANNING');
    f.controller.stop('F8');
    resolve(f.chosen);
    await work;
    expect(f.controller.state).toBe('STOPPED');
    expect(f.keyboard.tap).not.toHaveBeenCalled();
    expect(f.recorder.records).toHaveLength(0);
    expect(f.planner.cancel).toHaveBeenCalled();
  });

  it('rejects a changed observation after planning before any input', async () => {
    const f = fixture();
    vi.mocked(f.planner.plan).mockImplementation(async () => {
      f.set(snapshot({ fingerprint: 'new-generation', next: ['T', 'S', 'Z', 'J', 'L'] }));
      return f.chosen;
    });
    await f.controller.start('single');
    expect(f.controller.state).toBe('ERROR');
    expect(f.keyboard.tap).not.toHaveBeenCalled();
  });

  it.each(['board', 'queue'] as const)('abandons the old path if %s changes before hard drop', async field => {
    const before = snapshot();
    const plan = placement(before, { path: ['LEFT', 'HARD_DROP'], target: { type: 'O', x: 2, y: 18, rotation: 0 }, expectedBoard: lockedO(2) });
    const f = fixture(before, plan);
    vi.mocked(f.keyboard.tap).mockImplementation(async (action, _token, onSent?: () => void) => {
      onSent?.();
      if (action === 'LEFT') f.set(snapshot({
        current: { ...before.current, x: 2 }, fingerprint: 'changed-after-left',
        ...(field === 'board' ? { board: [...Array<number>(19).fill(0), 1] } : { next: ['T', 'I', 'S', 'Z', 'J'] }),
      }));
    });
    await settle(f.controller.start('single'));
    expect(f.controller.state).toBe('ERROR');
    expect(vi.mocked(f.keyboard.tap).mock.calls.map(([action]) => action)).toEqual(['LEFT']);
    expect(f.recorder.records[0]).toMatchObject({ result: 'unknown', actions: [{ action: 'LEFT' }] });
  });

  it('discards the remaining path when gravity advances during an acknowledged input', async () => {
    const before = snapshot();
    const plan = placement(before, { path: ['LEFT', 'HARD_DROP'], target: { type: 'O', x: 2, y: 18, rotation: 0 }, expectedBoard: lockedO(2) });
    const f = fixture(before, plan);
    vi.mocked(f.keyboard.tap).mockImplementation(async (action, _token, onSent?: () => void) => {
      onSent?.();
      if (action === 'LEFT') f.set(snapshot({ current: { ...before.current, x: 2, y: 8 }, fingerprint: 'gravity-during-input' }));
      if (action === 'HARD_DROP') f.set(afterPlacement(before, { board: lockedO(2) }));
    });
    await settle(f.controller.start('single'));
    expect(f.controller.state).toBe('STOPPED');
    expect(f.recorder.records[0]).toMatchObject({ result: 'resynced', recovery: { reason: 'gravity-advance', phase: 'movement', completedAction: null } });
    expect(vi.mocked(f.keyboard.tap).mock.calls.map(([action]) => action)).toEqual(['LEFT']);
  });

  it('does not drop a replacement piece that appears while confirming movement', async () => {
    const before = snapshot();
    const f = fixture(before, placement(before, { path: ['LEFT', 'HARD_DROP'] }));
    vi.mocked(f.keyboard.tap).mockImplementation(async (_action, _token, onSent?: () => void) => {
      onSent?.();
      f.set(snapshot({ current: { type: 'T', x: 3, y: 0, rotation: 0 }, fingerprint: 'replacement-piece' }));
    });
    await settle(f.controller.start('single'));
    expect(f.controller.state).toBe('ERROR');
    expect(vi.mocked(f.keyboard.tap).mock.calls.map(([action]) => action)).toEqual(['LEFT']);
  });

  it('recognizes a same-type full HOLD using canHold transition', async () => {
    const before = snapshot({ hold: 'O' });
    const f = fixture(before, placement(before, { kind: 'hold', path: [], expectedBoard: before.board }));
    vi.mocked(f.keyboard.tap).mockImplementation(async (_action, _token, onSent?: () => void) => {
      onSent?.();
      f.set(snapshot({ ...before, canHold: false, fingerprint: 'same-type-held', observation: 2 }));
    });
    await settle(f.controller.start('single'));
    expect(vi.mocked(f.keyboard.tap).mock.calls.map(([action]) => action)).toEqual(['HOLD']);
    expect(f.recorder.records[0]).toMatchObject({ type: 'hold', result: 'hold-observed', validation: { hold: 'match', authoritative: 'unknown' } });
  });

  it('recognizes an empty HOLD whose replacement has the same type', async () => {
    const before = snapshot({ next: ['O', 'O', 'T', 'S', 'Z'] });
    const f = fixture(before, placement(before, { kind: 'hold', path: [], expectedBoard: before.board }));
    vi.mocked(f.keyboard.tap).mockImplementation(async (_action, _token, onSent?: () => void) => {
      onSent?.();
      f.set(snapshot({ ...before, next: ['O', 'T', 'S', 'Z', 'J'], hold: 'O', canHold: false, fingerprint: 'same-type-empty-hold', observation: 2 }));
    });
    await settle(f.controller.start('single'));
    expect(f.controller.state).toBe('STOPPED');
    expect(f.recorder.records[0]?.result).toBe('hold-observed');
  });

  it.each(['HOLD', 'HARD_DROP'] as const)('does not retry an unconfirmed %s', async action => {
    const before = snapshot({ hold: 'O' });
    const plan = placement(before, action === 'HOLD' ? { kind: 'hold', path: [], expectedBoard: before.board } : {});
    const f = fixture(before, plan);
    // A delivered synthetic event without changed display is not an ack.
    await settle(f.controller.start('single'));
    expect(f.controller.state).toBe('ERROR');
    expect(vi.mocked(f.keyboard.tap).mock.calls.map(([sent]) => sent)).toEqual([action]);
    expect(f.recorder.records[0]).toMatchObject({ type: 'failure', result: 'unknown' });
    expect(f.recorder.records[0]?.error).toContain('재전송하지 않았습니다');
  });

  it.each(['spectating', 'paused', 'ended'] as const)('sends no input while %s', async reason => {
    const f = fixture();
    f.status[reason] = true;
    await f.controller.start('single');
    expect(f.controller.state).toBe(reason === 'paused' ? 'PAUSED' : 'ERROR');
    expect(f.keyboard.tap).not.toHaveBeenCalled();
    expect(f.planner.plan).not.toHaveBeenCalled();
  });

  it.each(['session', 'player'] as const)('rejects a matching-looking lock from another %s', async field => {
    const f = fixture();
    vi.mocked(f.keyboard.tap).mockImplementation(async (_action, _token, onSent?: () => void) => {
      onSent?.();
      f.set(afterPlacement(f.before, { [field]: 'different-context' }));
    });
    await settle(f.controller.start('single'));
    expect(f.controller.state).toBe('ERROR');
    expect(f.recorder.records[0]?.result).toBe('unknown');
    expect(vi.mocked(f.keyboard.tap).mock.calls.map(([action]) => action)).toEqual(['HARD_DROP']);
  });

  it.each(['session', 'player'] as const)('rejects a matching-looking HOLD from another %s', async field => {
    const before = snapshot({ hold: 'O' });
    const f = fixture(before, placement(before, { kind: 'hold', path: [], expectedBoard: before.board }));
    vi.mocked(f.keyboard.tap).mockImplementation(async (_action, _token, onSent?: () => void) => {
      onSent?.();
      f.set(snapshot({ ...before, canHold: false, [field]: 'different-context', fingerprint: 'other-held' }));
    });
    await settle(f.controller.start('single'));
    expect(f.controller.state).toBe('ERROR');
    expect(f.recorder.records[0]?.result).toBe('unknown');
  });
});

describe('gravity during completed search', () => {
  function fallen(before: RuntimeSnapshot, y = before.current.y + 1): RuntimeSnapshot {
    return snapshot({ ...before, current: { ...before.current, y },
      fingerprint: `gravity-${before.observation + 1}`, observation: before.observation + 1,
      observedAt: before.observedAt + 50 });
  }

  it('makes a first continuous placement when gravity advances during every planner request', async () => {
    const f = fixture();
    vi.mocked(f.planner.plan).mockImplementation(async seen => {
      f.set(fallen(seen));
      return placement(seen);
    });
    vi.mocked(f.keyboard.tap).mockImplementation(async (action, _token, onSent) => {
      onSent?.();
      if (action === 'HARD_DROP') f.set(afterPlacement(f.get(), { observation: 3, observedAt: 100 }));
    });
    const work = f.controller.start('continuous');
    await vi.advanceTimersByTimeAsync(180);
    f.controller.stop('F8 after first placement');
    await settle(work);
    expect(f.planner.plan).toHaveBeenCalledOnce();
    expect(vi.mocked(f.keyboard.tap).mock.calls.map(([action]) => action)).toEqual(['HARD_DROP']);
    expect(f.recorder.records).toHaveLength(1);
    expect(f.recorder.records[0]).toMatchObject({
      type: 'placement', result: 'display-match',
      before: { current: { y: 1 }, fingerprint: 'gravity-2', observation: 2, observedAt: 50 },
      plan: { fingerprint: 'gravity-2', observation: 2, target: f.chosen.target, expectedBoard: f.chosen.expectedBoard },
      actions: [{ action: 'HARD_DROP' }],
    });
    expect(f.recorder.records[0]?.plan.assumptions).toContain('Path revalidated from observed gravity advance; terminal placement unchanged');
    expect(f.before.current.y).toBe(0);
    expect(f.chosen.fingerprint).toBe('fixture-before');
  });

  it('binds a rebased shadow decision to the fresh pose while sending zero inputs', async () => {
    const f = fixture();
    const fresh = fallen(f.before, 4);
    vi.mocked(f.planner.plan).mockImplementation(async () => { f.set(fresh); return f.chosen; });
    await f.controller.start('shadow');
    expect(f.controller.state).toBe('STOPPED');
    expect(f.keyboard.tap).not.toHaveBeenCalled();
    expect(f.recorder.records).toHaveLength(1);
    expect(f.recorder.records[0]).toMatchObject({
      type: 'shadow', result: 'shadow', before: fresh, actions: [], after: null,
      plan: { fingerprint: fresh.fingerprint, observation: fresh.observation, target: f.chosen.target },
    });
  });

  it('revalidates HOLD after search-time gravity and confirms it from exactly one input', async () => {
    const before = snapshot({ hold: 'T' });
    const chosen = placement(before, { kind: 'hold', path: [], expectedBoard: before.board,
      target: { type: 'T', x: 3, y: 0, rotation: 0 } });
    const f = fixture(before, chosen);
    const fresh = fallen(before);
    vi.mocked(f.planner.plan).mockImplementation(async () => { f.set(fresh); return chosen; });
    vi.mocked(f.keyboard.tap).mockImplementation(async (action, _token, onSent) => {
      onSent?.();
      if (action === 'HOLD') f.set(snapshot({ ...fresh, current: chosen.target, hold: 'O', canHold: false,
        fingerprint: 'held-after-gravity', observation: 3, observedAt: 100 }));
    });
    await settle(f.controller.start('single'));
    expect(f.controller.state).toBe('STOPPED');
    expect(vi.mocked(f.keyboard.tap).mock.calls.map(([action]) => action)).toEqual(['HOLD']);
    expect(f.recorder.records).toHaveLength(1);
    expect(f.recorder.records[0]).toMatchObject({
      type: 'hold', result: 'hold-observed', before: fresh,
      plan: { fingerprint: fresh.fingerprint, observation: fresh.observation },
      validation: { hold: 'match', queue: 'match', authoritative: 'unknown' },
    });
  });

  it('rejects a formerly legal path that gravity has moved against the floor', async () => {
    const before = snapshot({ current: { type: 'O', x: 3, y: 17, rotation: 0 } });
    const chosen = placement(before, { path: ['SOFT_DROP', 'HARD_DROP'] });
    const f = fixture(before, chosen);
    vi.mocked(f.planner.plan).mockImplementation(async () => { f.set(fallen(before)); return chosen; });
    await f.controller.start('single');
    expect(f.controller.state).toBe('ERROR');
    expect(f.keyboard.tap).not.toHaveBeenCalled();
    expect(f.recorder.records).toHaveLength(0);
  });

  it('replans gravity immediately before HOLD without sending the stale HOLD', async () => {
    const before = snapshot({ hold: 'T' });
    const chosen = placement(before, { kind: 'hold', path: [], expectedBoard: before.board,
      target: { type: 'T', x: 3, y: 0, rotation: 0 } });
    const f = fixture(before, chosen);
    const fresh = fallen(before);
    let reads = 0;
    vi.mocked(f.reader.read).mockImplementation(() => ++reads >= 3 ? fresh : before);
    await f.controller.start('single');
    expect(f.controller.state).toBe('STOPPED');
    expect(f.keyboard.tap).not.toHaveBeenCalled();
    expect(f.recorder.records).toHaveLength(1);
    expect(f.recorder.records[0]).toMatchObject({
      type: 'resync', result: 'resynced', actions: [], before, after: fresh,
      recovery: { reason: 'gravity-advance', phase: 'before-input', completedAction: null },
      validation: { hold: 'unknown', queue: 'unknown', authoritative: 'unknown' },
    });
  });
});

describe('current-piece render transitions', () => {
  const missingPiece = () => new DomReadError('transition', 'Current piece is absent during spawn, lock, or game end');

  it('waits for the initial piece before making a shadow decision with zero inputs', async () => {
    const f = fixture();
    let ready = false;
    vi.mocked(f.reader.read).mockImplementation(() => {
      if (!ready) throw missingPiece();
      return f.get();
    });
    const work = f.controller.start('shadow');
    await vi.advanceTimersByTimeAsync(48);
    expect(f.planner.plan).not.toHaveBeenCalled();
    expect(f.keyboard.tap).not.toHaveBeenCalled();
    ready = true;
    await settle(work);
    expect(f.controller.state).toBe('STOPPED');
    expect(f.planner.plan).toHaveBeenCalledOnce();
    expect(f.keyboard.tap).not.toHaveBeenCalled();
    expect(f.recorder.records).toHaveLength(1);
    expect(f.recorder.records[0]).toMatchObject({ type: 'shadow', actions: [], after: null });
  });

  it.each(['single', 'continuous'] as const)('recovers an initially absent piece and completes one %s placement', async mode => {
    const f = fixture();
    let ready = false;
    vi.mocked(f.reader.read).mockImplementation(() => {
      if (!ready) throw missingPiece();
      return f.get();
    });
    vi.mocked(f.keyboard.tap).mockImplementation(async (action, _token, onSent) => {
      onSent?.();
      if (action === 'HARD_DROP') f.set(afterPlacement(f.before));
    });
    const work = f.controller.start(mode);
    await vi.advanceTimersByTimeAsync(48);
    expect(f.planner.plan).not.toHaveBeenCalled();
    ready = true;
    // Confirm the first lock before the continuous-mode pause expires.
    await vi.advanceTimersByTimeAsync(180);
    expect(f.recorder.records).toHaveLength(1);
    expect(f.recorder.records[0]?.result).toBe('display-match');
    expect(vi.mocked(f.keyboard.tap).mock.calls.map(([action]) => action)).toEqual(['HARD_DROP']);
    if (mode === 'continuous') f.controller.stop('F8 after recovered placement');
    await settle(work);
    expect(f.controller.state).toBe('STOPPED');
    expect(f.planner.plan).toHaveBeenCalledOnce();
  });

  it.each([
    { phase: 'after planning', failedRead: 2 },
    { phase: 'before the first input', failedRead: 3 },
  ])('waits through a transient absence $phase without duplicating an input', async ({ failedRead }) => {
    const f = fixture();
    let reads = 0;
    vi.mocked(f.reader.read).mockImplementation(() => {
      if (++reads === failedRead) throw missingPiece();
      return f.get();
    });
    vi.mocked(f.keyboard.tap).mockImplementation(async (action, _token, onSent) => {
      onSent?.();
      if (action === 'HARD_DROP') f.set(afterPlacement(f.before));
    });
    await settle(f.controller.start('single'));
    expect(f.controller.state).toBe('STOPPED');
    expect(f.planner.plan).toHaveBeenCalledOnce();
    expect(vi.mocked(f.keyboard.tap).mock.calls.map(([action]) => action)).toEqual(['HARD_DROP']);
    expect(f.recorder.records[0]?.result).toBe('display-match');
  });

  it('cancels F8 during initial observation without planning, input, or surviving timers', async () => {
    const f = fixture();
    vi.mocked(f.reader.read).mockImplementation(() => { throw missingPiece(); });
    const work = f.controller.start('continuous');
    await vi.advanceTimersByTimeAsync(48);
    expect(f.planner.plan).not.toHaveBeenCalled();
    expect(f.controller.state).not.toBe('ERROR');
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    f.controller.stop('F8');
    await work;
    const readsAtStop = vi.mocked(f.reader.read).mock.calls.length;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.controller.state).toBe('STOPPED');
    expect(f.reader.read).toHaveBeenCalledTimes(readsAtStop);
    expect(f.planner.plan).not.toHaveBeenCalled();
    expect(f.keyboard.tap).not.toHaveBeenCalled();
    expect(f.recorder.records).toHaveLength(0);
  });

  it('bounds a permanently absent piece and preserves the original diagnostic', async () => {
    const f = fixture();
    const updates: ControlUpdate[] = [];
    const controller = new Controller(f.reader, f.planner, f.keyboard, f.recorder, update => updates.push(update), () => Date.now());
    vi.mocked(f.reader.read).mockImplementation(() => { throw missingPiece(); });
    const started = Date.now();
    await settle(controller.start('continuous'));
    expect(controller.state).toBe('ERROR');
    expect(Date.now() - started).toBeGreaterThanOrEqual(1200);
    expect(Date.now() - started).toBeLessThanOrEqual(1224);
    expect(updates.at(-1)?.message).toContain(missingPiece().message);
    expect(vi.mocked(f.reader.read).mock.calls.length).toBeGreaterThan(1);
    expect(vi.mocked(f.reader.read).mock.calls.length).toBeLessThanOrEqual(55);
    expect(f.planner.plan).not.toHaveBeenCalled();
    expect(f.keyboard.tap).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['invalid', 'selection', 'inactive', 'spectator'] as const)('fails immediately for a %s observation instead of retrying', async kind => {
    const f = fixture();
    const updates: ControlUpdate[] = [];
    const controller = new Controller(f.reader, f.planner, f.keyboard, f.recorder, update => updates.push(update), () => Date.now());
    vi.mocked(f.reader.read).mockImplementation(() => { throw new DomReadError(kind, `fixture ${kind}`); });
    await controller.start('continuous');
    expect(controller.state).toBe('ERROR');
    expect(updates.at(-1)?.message).toBe(`fixture ${kind}`);
    expect(f.reader.read).toHaveBeenCalledOnce();
    expect(f.planner.plan).not.toHaveBeenCalled();
    expect(f.keyboard.tap).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops retrying when a transient absence becomes an invalid observation', async () => {
    const f = fixture();
    const updates: ControlUpdate[] = [];
    const controller = new Controller(f.reader, f.planner, f.keyboard, f.recorder, update => updates.push(update), () => Date.now());
    vi.mocked(f.reader.read)
      .mockImplementationOnce(() => { throw missingPiece(); })
      .mockImplementation(() => { throw new DomReadError('invalid', 'Malformed active piece'); });
    const started = Date.now();
    await settle(controller.start('continuous'));
    expect(controller.state).toBe('ERROR');
    expect(updates.at(-1)?.message).toBe('Malformed active piece');
    expect(Date.now() - started).toBeLessThan(1200);
    expect(f.reader.read).toHaveBeenCalledTimes(2);
    expect(f.planner.plan).not.toHaveBeenCalled();
    expect(f.keyboard.tap).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('observes pause while waiting for the piece and sends no input', async () => {
    const f = fixture();
    vi.mocked(f.reader.read).mockImplementation(() => { throw missingPiece(); });
    const work = f.controller.start('continuous');
    await vi.advanceTimersByTimeAsync(24);
    f.status.paused = true;
    await settle(work);
    expect(f.controller.state).toBe('PAUSED');
    expect(f.planner.plan).not.toHaveBeenCalled();
    expect(f.keyboard.tap).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['session', 'player'] as const)('rejects a %s change after a post-planning transition without sending input', async field => {
    const f = fixture();
    let waiting = false;
    vi.mocked(f.planner.plan).mockImplementation(async () => {
      waiting = true;
      return f.chosen;
    });
    vi.mocked(f.reader.read).mockImplementation(() => {
      if (waiting) throw missingPiece();
      return f.get();
    });
    const work = f.controller.start('single');
    await vi.advanceTimersByTimeAsync(48);
    expect(f.planner.plan).toHaveBeenCalledOnce();
    expect(f.controller.state).not.toBe('ERROR');
    expect(f.keyboard.tap).not.toHaveBeenCalled();
    // Keep the fingerprint unchanged so the independent context checks matter.
    f.set(snapshot({ [field]: 'different-context' }));
    waiting = false;
    await settle(work);
    expect(f.controller.state).toBe('ERROR');
    expect(f.keyboard.tap).not.toHaveBeenCalled();
    expect(f.recorder.records).toHaveLength(0);
  });
});

describe('window keyboard and cancellation', () => {
  it('dispatches one keydown and one keyup through the window listener', async () => {
    const observed: string[] = [];
    const onKey = (event: KeyboardEvent) => { observed.push(`${event.type}/${event.key}/${event.code}`); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    try {
      const keyboard = new WindowKeyboard(window, () => {});
      await settle(keyboard.tap('HARD_DROP', new Cancellation()));
      expect(observed).toEqual(['keydown/ /Space', 'keyup/ /Space']);
    } finally {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    }
  });

  it('F8 during a held key releases it and starts no further game input', async () => {
    const before = snapshot();
    const f = fixture(before, placement(before, { path: ['LEFT', 'HARD_DROP'] }));
    const events: string[] = [];
    const listener = (event: KeyboardEvent) => { events.push(`${event.type}/${event.code}`); };
    window.addEventListener('keydown', listener);
    window.addEventListener('keyup', listener);
    const keyboard = new WindowKeyboard(window, () => {});
    const controller = new Controller(f.reader, f.planner, keyboard, f.recorder, () => {}, () => Date.now());
    try {
      const work = controller.start('single');
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toEqual(['keydown/ArrowLeft']);
      controller.stop('F8');
      await settle(work);
      await vi.advanceTimersByTimeAsync(3000);
      expect(controller.state).toBe('STOPPED');
      expect(events.filter(event => event.startsWith('keydown'))).toEqual(['keydown/ArrowLeft']);
      expect(events.filter(event => event.startsWith('keyup'))).toEqual(['keyup/ArrowLeft']);
      expect(f.recorder.records[0]).toMatchObject({ result: 'cancelled', actions: [{ action: 'LEFT' }] });
    } finally {
      window.removeEventListener('keydown', listener);
      window.removeEventListener('keyup', listener);
    }
  });

  it('does not record a game action when the final keyboard guard refuses dispatch', async () => {
    const f = fixture();
    const keydown = vi.fn();
    window.addEventListener('keydown', keydown);
    const keyboard = new WindowKeyboard(window, () => { throw new Error('Focus moved into chat'); });
    const controller = new Controller(f.reader, f.planner, keyboard, f.recorder, () => {}, () => Date.now());
    try {
      await controller.start('single');
      expect(controller.state).toBe('ERROR');
      expect(keydown).not.toHaveBeenCalled();
      expect(f.recorder.records[0]).toMatchObject({ result: 'unknown', actions: [] });
    } finally { window.removeEventListener('keydown', keydown); }
  });

  it('starts no keydown if stopped by the final input guard', async () => {
    const f = fixture();
    const keydown = vi.fn();
    window.addEventListener('keydown', keydown);
    let controller!: Controller;
    const keyboard = new WindowKeyboard(window, () => controller.stop('Stopped before dispatch'));
    controller = new Controller(f.reader, f.planner, keyboard, f.recorder, () => {}, () => Date.now());
    try {
      await settle(controller.start('single'));
      expect(controller.state).toBe('STOPPED');
      expect(keydown).not.toHaveBeenCalled();
      expect(f.recorder.records[0]).toMatchObject({ result: 'cancelled', actions: [] });
    } finally { window.removeEventListener('keydown', keydown); }
  });

  it('cancels timer waits immediately without waiting for their deadline', async () => {
    const token = new Cancellation();
    const pending = token.wait(10000);
    const rejected = expect(pending).rejects.toBeInstanceOf(Cancelled);
    token.cancel();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
