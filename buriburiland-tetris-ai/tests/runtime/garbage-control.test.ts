// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Controller, Recorder, type ControlUpdate, type KeyboardPort, type Planner, type Reader,
} from '../../src/runtime/control';
import { detectGarbageRise } from '../../src/runtime/board-transition';
import { applyRuntimeAction } from '../../src/runtime/engine';
import {
  RUNTIME_RULE_PROFILE, type RuntimeAction, type RuntimePlan, type RuntimeSnapshot,
} from '../../src/runtime/model';

type PublicSnapshot = Pick<RuntimeSnapshot,
  'board' | 'current' | 'next' | 'hold' | 'canHold' | 'lines' | 'incoming' | 'rotationCandidates'>;
type PublicPlan = Pick<RuntimePlan, 'kind' | 'path' | 'target' | 'expectedBoard' | 'cleared'>;
interface RegressionCase {
  caseId: string;
  kind: 'lock-rise' | 'movement-rise' | 'gravity';
  evidence: 'user-provided-public-dom-record';
  before: PublicSnapshot;
  plan: PublicPlan;
  after: PublicSnapshot;
  actions: RuntimeAction[];
  error: string;
}
const cases = JSON.parse(readFileSync(resolve('fixtures/garbage-regression.json'), 'utf8')) as RegressionCase[];
const lockCases = cases.filter(c => c.kind === 'lock-rise');
const movementCase = cases.find(c => c.kind === 'movement-rise')!;
const gravityCases = cases.filter(c => c.kind === 'gravity');

function copiedSnapshot(source: PublicSnapshot, overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  const copied = structuredClone(source);
  return {
    ...copied,
    // Runtime identity and clocks are generated locally; source account data and
    // browser-relative timestamps are deliberately absent from the fixture.
    session: 'garbage-regression-session', player: 'main',
    observation: 1, observedAt: Date.now(), paused: false, ended: false,
    fingerprint: JSON.stringify([copied.board, copied.current, copied.next, copied.hold, copied.canHold, copied.lines]),
    ...overrides,
  };
}
function chosenPlan(source: PublicPlan, before: RuntimeSnapshot): RuntimePlan {
  return {
    ...structuredClone(source), fingerprint: before.fingerprint,
    session: before.session, player: before.player, observation: before.observation,
    score: 0, nodes: 1, elapsedMs: 1, depth: 1, budgetExhausted: false,
    ruleProfile: RUNTIME_RULE_PROFILE.id, assumptions: ['sanitized public DOM regression'],
  };
}
function harness(record: RegressionCase, mode: 'single' | 'continuous' = 'single') {
  let current = copiedSnapshot(record.before);
  let observation = 0;
  const updates: ControlUpdate[] = [];
  const observations: RuntimeSnapshot[] = [];
  const sent: RuntimeAction[] = [];
  const reader: Reader = {
    read: vi.fn(() => ({ ...structuredClone(current), observation: ++observation, observedAt: Date.now() })),
    status: vi.fn(() => ({ inputEnabled: true, paused: false, ended: false, spectating: false })),
  };
  const planner: Planner = {
    plan: vi.fn(async seen => {
      observations.push(structuredClone(seen));
      // Inspect exactly one fresh plan after recovery without executing it.
      if (observations.length === 2) controller.stop('Regression observed the fresh plan');
      return chosenPlan(record.plan, seen);
    }),
    cancel: vi.fn(),
  };
  const keyboard: KeyboardPort = {
    tap: vi.fn(async (action, _token, onSent?: () => void) => {
      onSent?.(); sent.push(action);
      if (action === 'HARD_DROP') {
        current = copiedSnapshot(record.after);
      } else if (action !== 'HOLD') {
        const pose = applyRuntimeAction(current.board, current.current, action);
        if (!pose) throw new Error(`Regression attempted blocked ${action}`);
        current = copiedSnapshot({ ...current, current: pose, rotationCandidates: [pose] });
        if (record.kind !== 'lock-rise' && sent.length === record.actions.length) current = copiedSnapshot(record.after);
      }
    }),
    release: vi.fn(),
  };
  const recorder = new Recorder();
  const controller = new Controller(reader, planner, keyboard, recorder, update => updates.push(update), () => Date.now());
  return {
    record, mode, reader, planner, keyboard, recorder, controller, updates, observations, sent,
    set: (next: RuntimeSnapshot) => { current = structuredClone(next); },
    get: () => structuredClone(current),
    run: () => controller.start(mode),
  };
}
async function settle(work: Promise<void>): Promise<void> {
  await vi.runAllTimersAsync();
  await work;
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-23T00:00:00Z')); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('observed garbage board transformations', () => {
  it.each([
    ['log-onebased136', 1, [6]],
    ['log-onebased160', 1, [5]],
    ['log-onebased181', 1, [8]],
    ['log-onebased198', 4, [8, 8, 8, 8]],
    ['log-1792725492925-onebased38', 4, [8, 8, 8, 8]],
    ['log-1792725492925-onebased70', 2, [1, 1]],
    ['log-1792725492925-onebased79', 4, [5, 5, 5, 5]],
  ] as const)('recognizes the exact post-lock rise in %s', (caseId, rows, holes) => {
    const record = lockCases.find(c => c.caseId === caseId)!;
    expect(detectGarbageRise(record.plan.expectedBoard, record.after.board)).toEqual({
      rows, holes, insertedRows: record.after.board.slice(-rows),
    });
    expect(detectGarbageRise(record.before.board, record.after.board)).toBeNull();
  });

  it('recognizes the mid-movement rise against the original board', () => {
    expect(detectGarbageRise(movementCase.before.board, movementCase.after.board)).toEqual({ rows: 1, holes: [4], insertedRows: [1007] });
    expect(detectGarbageRise(movementCase.plan.expectedBoard, movementCase.after.board)).toBeNull();
  });

  it('rejects unchanged boards and arbitrary corrections', () => {
    const record = lockCases[2]!;
    expect(detectGarbageRise(record.plan.expectedBoard, record.plan.expectedBoard)).toBeNull();
    const correction = [...record.after.board];
    correction[17] = correction[17]! ^ 1;
    expect(detectGarbageRise(record.plan.expectedBoard, correction)).toBeNull();
  });
});

describe('garbage recovery from sanitized real-game records', () => {
  it.each(lockCases)('acknowledges the completed lock in $caseId without replaying hard drop', async record => {
    const f = harness(record);
    await settle(f.run());
    expect(f.controller.state).toBe('STOPPED');
    expect(f.sent).toEqual(record.plan.path);
    expect(f.planner.plan).toHaveBeenCalledOnce();
    expect(f.recorder.records).toHaveLength(1);
    expect(f.recorder.records[0]).toMatchObject({
      type: 'resync', result: 'resynced', error: null,
      recovery: {
        reason: 'garbage-rise', phase: 'after-lock', reference: 'predicted-lock', completedAction: 'HARD_DROP',
        rise: detectGarbageRise(record.plan.expectedBoard, record.after.board),
      },
    });
  });

  it.each(lockCases)('replans from the observed risen board after $caseId in continuous mode', async record => {
    const f = harness(record, 'continuous');
    await settle(f.run());
    expect(f.controller.state).toBe('STOPPED');
    expect(f.observations).toHaveLength(2);
    expect(f.observations[1]).toMatchObject({
      board: record.after.board, current: record.after.current, next: record.after.next,
      hold: record.after.hold, canHold: true, lines: record.after.lines,
    });
    expect(f.sent).toEqual(record.plan.path);
    expect(f.sent.filter(action => action === 'HARD_DROP')).toHaveLength(1);
    expect(f.recorder.records[0]).toMatchObject({ type: 'resync', result: 'resynced' });
  });

  it.each(['single', 'continuous'] as const)('cancels the remaining movement path after a rise in %s mode', async mode => {
    const f = harness(movementCase, mode);
    await settle(f.run());
    expect(f.controller.state).toBe('STOPPED');
    expect(f.sent).toEqual(movementCase.actions);
    expect(f.sent).not.toContain('HARD_DROP');
    expect(f.observations).toHaveLength(mode === 'continuous' ? 2 : 1);
    if (mode === 'continuous') expect(f.observations[1]).toMatchObject({ board: movementCase.after.board, current: movementCase.after.current });
    expect(f.recorder.records[0]).toMatchObject({
      type: 'resync', result: 'resynced',
      recovery: {
        reason: 'garbage-rise', phase: 'movement', reference: 'before', completedAction: null,
        rise: { rows: 1, holes: [4], insertedRows: [1007] },
      },
    });
  });

  it.each(gravityCases)('abandons the expired path in $caseId before sending a blocked soft drop', async record => {
    const f = harness(record, 'continuous');
    await settle(f.run());
    expect(f.controller.state).toBe('STOPPED');
    expect(f.observations).toHaveLength(2);
    expect(f.observations[1]).toMatchObject({ board: record.after.board, current: record.after.current });
    expect(f.sent).toEqual(record.actions);
    expect(f.sent).not.toContain('HARD_DROP');
    expect(f.recorder.records[0]).toMatchObject({
      type: 'resync', result: 'resynced',
      recovery: { reason: 'gravity-advance', phase: 'movement', reference: 'before', rise: null, completedAction: null },
    });
  });

  it('F8 during recovery ends the wait and sends no more inputs', async () => {
    const f = harness(movementCase, 'continuous');
    const work = f.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.controller.state).toBe('RESYNC');
    expect(f.sent).toEqual(movementCase.actions);
    f.controller.stop('F8');
    await settle(work);
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.controller.state).toBe('STOPPED');
    expect(f.sent).toEqual(movementCase.actions);
    expect(f.planner.plan).toHaveBeenCalledOnce();
    expect(f.keyboard.release).toHaveBeenCalled();
  });

  it.each(['garbage-rise', 'gravity-advance'] as const)('replans for %s before the first input without dispatching the old path', async reason => {
    const f = harness(movementCase, 'continuous');
    const original = vi.mocked(f.reader.read).getMockImplementation()!;
    let reads = 0;
    vi.mocked(f.reader.read).mockImplementation(() => {
      if (++reads === 3) f.set(copiedSnapshot({
        ...movementCase.before,
        board: reason === 'garbage-rise' ? movementCase.after.board : movementCase.before.board,
        current: { ...movementCase.before.current, y: reason === 'gravity-advance' ? movementCase.before.current.y + 1 : movementCase.before.current.y },
      }));
      return original();
    });
    await settle(f.run());
    expect(f.controller.state).toBe('STOPPED');
    expect(f.sent).toEqual([]);
    expect(f.observations).toHaveLength(2);
    expect(f.recorder.records[0]).toMatchObject({
      type: 'resync', result: 'resynced', actions: [],
      recovery: { reason, phase: 'before-input', reference: 'before', completedAction: null },
    });
  });

  it('acknowledges HOLD independently of an accompanying garbage rise', async () => {
    const record = structuredClone(lockCases[2]!);
    record.plan = { ...record.plan, kind: 'hold', path: [], expectedBoard: record.before.board, cleared: 0 };
    record.after = {
      ...record.before, board: [...record.before.board.slice(1), 767],
      current: { type: record.before.hold!, x: 3, y: 0, rotation: 0 },
      rotationCandidates: [{ type: record.before.hold!, x: 3, y: 0, rotation: 0 }],
      hold: record.before.current.type, canHold: false,
    };
    const f = harness(record, 'continuous');
    vi.mocked(f.keyboard.tap).mockImplementation(async (action, _token, onSent?: () => void) => {
      onSent?.(); f.sent.push(action); f.set(copiedSnapshot(record.after));
    });
    await settle(f.run());
    expect(f.controller.state).toBe('STOPPED');
    expect(f.sent).toEqual(['HOLD']);
    expect(f.observations).toHaveLength(2);
    expect(f.observations[1]).toMatchObject({ board: record.after.board, current: record.after.current, hold: 'O', canHold: false });
    expect(f.recorder.records[0]).toMatchObject({
      type: 'resync', result: 'resynced',
      recovery: {
        reason: 'garbage-rise', phase: 'after-hold', reference: 'before', completedAction: 'HOLD',
        rise: { rows: 1, holes: [8], insertedRows: [767] },
      },
    });
  });

  it('does not treat a garbage rise alone as acknowledgement of HOLD', async () => {
    const record = structuredClone(lockCases[2]!);
    record.plan = { ...record.plan, kind: 'hold', path: [], expectedBoard: record.before.board, cleared: 0 };
    const f = harness(record, 'continuous');
    vi.mocked(f.keyboard.tap).mockImplementation(async (action, _token, onSent?: () => void) => {
      onSent?.(); f.sent.push(action);
      f.set(copiedSnapshot({ ...record.before, board: [...record.before.board.slice(1), 767] }));
    });
    await settle(f.run());
    expect(f.controller.state).toBe('ERROR');
    expect(f.sent).toEqual(['HOLD']);
    expect(f.observations).toHaveLength(1);
    expect(f.recorder.records[0]).toMatchObject({ type: 'failure', result: 'unknown' });
  });

  it('uses the latest board when another attack rises during recovery', async () => {
    const f = harness(movementCase, 'continuous');
    const work = f.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.controller.state).toBe('RESYNC');
    const board = [...movementCase.after.board.slice(1), 991];
    f.set(copiedSnapshot({ ...movementCase.after, board }));
    await settle(work);
    expect(f.controller.state).toBe('STOPPED');
    expect(f.observations).toHaveLength(2);
    expect(f.observations[1]?.board).toEqual(board);
    expect(f.sent).toEqual(movementCase.actions);
  });

  it.each(['session', 'board'] as const)('sends no new input if %s becomes invalid during recovery', async invalid => {
    const f = harness(movementCase, 'continuous');
    const work = f.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.controller.state).toBe('RESYNC');
    const changed = f.get();
    const board = [...changed.board]; board[4] = board[4]! ^ 1;
    f.set(invalid === 'session' ? { ...changed, session: 'other-context' } : { ...changed, board });
    await settle(work);
    expect(f.controller.state).toBe('ERROR');
    expect(f.sent).toEqual(movementCase.actions);
    expect(f.observations).toHaveLength(1);
  });

  it('does not resume for a correction that changes one cell beyond the rise', async () => {
    const correction = structuredClone(movementCase);
    const board = [...correction.after.board]; board[4] = board[4]! ^ 1;
    correction.after = { ...correction.after, board };
    const f = harness(correction, 'continuous');
    await settle(f.run());
    expect(f.controller.state).toBe('ERROR');
    expect(f.sent).toEqual(correction.actions);
    expect(f.planner.plan).toHaveBeenCalledOnce();
    expect(f.recorder.records[0]).toMatchObject({ type: 'failure', result: 'unknown' });
  });

  it.each(['session', 'player'] as const)('does not recover into a different %s', async field => {
    const f = harness(movementCase, 'continuous');
    const original = vi.mocked(f.keyboard.tap).getMockImplementation()!;
    vi.mocked(f.keyboard.tap).mockImplementation(async (...args) => {
      await original(...args);
      if (f.sent.length === movementCase.actions.length) f.set({ ...f.get(), [field]: 'other-context' });
    });
    await settle(f.run());
    expect(f.controller.state).toBe('ERROR');
    expect(f.sent).toEqual(movementCase.actions);
    expect(f.planner.plan).toHaveBeenCalledOnce();
    expect(f.recorder.records[0]).toMatchObject({ type: 'failure', result: 'unknown' });
  });

  it.each(['queue', 'canHold', 'lines'] as const)('does not retry hard drop when %s fails to prove lock completion', async invalid => {
    const record = structuredClone(lockCases[2]!);
    if (invalid === 'queue') record.after = { ...record.after, next: record.before.next };
    if (invalid === 'canHold') record.after = { ...record.after, canHold: false };
    if (invalid === 'lines') record.after = { ...record.after, lines: record.before.lines };
    const f = harness(record, 'continuous');
    await settle(f.run());
    expect(f.controller.state).toBe('ERROR');
    expect(f.planner.plan).toHaveBeenCalledOnce();
    expect(f.sent).toEqual(record.plan.path);
    expect(f.sent.filter(action => action === 'HARD_DROP')).toHaveLength(1);
    expect(f.recorder.records[0]).toMatchObject({ type: 'failure', result: 'unknown' });
  });
});
