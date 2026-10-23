import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main as replayMain } from '../../scripts/replay';
import { replayRecord } from '../../src/runtime/replay';
import { RUNTIME_RULE_PROFILE, type RuntimeSnapshot } from '../../src/runtime/model';
import type { RecoveryEvidence } from '../../src/runtime/control';

function record() {
  const before: RuntimeSnapshot = { board: Array<number>(20).fill(0), current: { type: 'O', x: 3, y: 0, rotation: 0 }, next: ['I', 'J', 'L', 'S', 'T'],
    hold: null, canHold: true, fingerprint: 'before', session: 'one-room', player: 'local-display', observedAt: 10, observation: 1, paused: false, ended: false, lines: 0, incoming: null };
  const after: RuntimeSnapshot = { ...before, board: [...Array<number>(18).fill(0), 24, 24], current: { type: 'I', x: 3, y: 0, rotation: 0 }, next: ['J', 'L', 'S', 'T', 'Z'], fingerprint: 'after', observedAt: 20, observation: 2 };
  return { schema: 2, type: 'placement', ruleProfile: RUNTIME_RULE_PROFILE.id, before,
    // Deliberately bogus stored prediction: recomputation must ignore it.
    plan: { ruleProfile: RUNTIME_RULE_PROFILE.id, session: before.session, player: before.player, fingerprint: before.fingerprint, observation: before.observation, expectedBoard: Array<number>(20).fill(1023), cleared: 99 },
    actions: [{ action: 'HARD_DROP', at: 15 }], after, result: 'display-match', evidence: 'synthetic' };
}

describe('action-based offline replay', () => {
  it('recomputes the actual O lock independently of a tampered stored predicted board', () => {
    expect(replayRecord(record())).toMatchObject({ status: 'display-consistent', board: 'match', clear: 'match', differingCells: 0, synthetic: true });
  });
  it('does not count an actual board copied from a bogus stored prediction as validation', () => {
    const input = record();
    input.after = { ...input.after, board: [...input.plan.expectedBoard] };
    expect(replayRecord(input)).toMatchObject({ status: 'divergence-unclassified', board: 'mismatch' });
  });
  it('reports board divergence without inventing a garbage, input, or physics cause', () => {
    const input = record(); const board = [...input.after.board]; board[19] = 25;
    input.after = { ...input.after, board };
    expect(replayRecord(input)).toMatchObject({ status: 'divergence-unclassified', board: 'mismatch', differingCells: 1 });
  });
  it('keeps unknown clear counters unknown', () => {
    const input = record(); input.before = { ...input.before, lines: null }; input.after = { ...input.after, lines: null };
    expect(replayRecord(input)).toMatchObject({ status: 'display-consistent', board: 'match', clear: 'unknown' });
  });
  it('separates cancellation, failure, shadow, and unsupported rule versions', () => {
    const input = record();
    expect(replayRecord({ ...input, result: 'cancelled' }).status).toBe('cancelled');
    expect(replayRecord({ ...input, type: 'failure', result: 'unknown' }).status).toBe('incomplete');
    expect(replayRecord({ ...input, type: 'shadow', after: null, actions: [] }).status).toBe('shadow');
    expect(replayRecord({ ...input, ruleProfile: 'some-other-client' }).status).toBe('unsupported-profile');
  });
  it('requires matching session, player, plan observation, and monotonic action time', () => {
    const input = record();
    expect(replayRecord({ ...input, after: { ...input.after, session: 'another-room' } }).status).toBe('invalid');
    expect(replayRecord({ ...input, after: { ...input.after, player: 'opponent' } }).status).toBe('invalid');
    expect(replayRecord({ ...input, plan: { ...input.plan, observation: 99 } }).status).toBe('invalid');
    expect(replayRecord({ ...input, actions: [{ action: 'HARD_DROP', at: 1 }] }).status).toBe('invalid');
    expect(replayRecord({ ...input, actions: [{ action: 'HARD_DROP', at: 100 }] }).status).toBe('invalid');
  });
  it('rejects corrupted shape, board, queue, and action schemas', () => {
    const input = record();
    expect(replayRecord({ ...input, after: undefined }).status).toBe('invalid');
    expect(replayRecord({ ...input, before: { ...input.before, board: [0] } }).status).toBe('invalid');
    expect(replayRecord({ ...input, before: { ...input.before, next: ['bad'] } }).status).toBe('invalid');
    expect(replayRecord({ ...input, actions: [null] }).status).toBe('invalid');
    expect(replayRecord({ ...input, actions: [{ action: 'ROTATE_180', at: 15 }] }).status).toBe('invalid');
    expect(replayRecord({ ...input, actions: [{ action: 'LEFT', at: 15 }] }).status).toBe('invalid');
  });
  it('recomputes empty HOLD without claiming a completed placement', () => {
    const input = record();
    const hold = { ...input, type: 'hold', actions: [{ action: 'HOLD', at: 15 }], after: { ...input.after, board: input.before.board, current: { type: 'I', x: 3, y: 0, rotation: 0 }, hold: 'O', canHold: false }, result: 'hold-observed' };
    expect(replayRecord(hold)).toMatchObject({ status: 'hold-consistent', board: 'match', clear: 'match' });
    expect(replayRecord({ ...hold, before: { ...input.before, canHold: null } }).status).toBe('invalid');
  });
});

function riseRecord() {
  const input = record();
  const recovery: RecoveryEvidence = { reason: 'garbage-rise', phase: 'after-lock',
    reference: 'predicted-lock', completedAction: 'HARD_DROP', rise: { rows: 1, holes: [4], insertedRows: [1007] } };
  return { ...input, type: 'resync', result: 'resynced', recovery,
    after: { ...input.after, board: [
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 24, 24, 1007,
    ] } };
}
function interruptedRecord(reason: 'garbage-rise' | 'gravity-advance' = 'garbage-rise') {
  const input = riseRecord();
  const recovery: RecoveryEvidence = { reason, phase: 'movement', reference: 'before', completedAction: null,
    rise: reason === 'garbage-rise' ? { rows: 1, holes: [4], insertedRows: [1007] } : null };
  return { ...input, recovery, actions: [{ action: 'LEFT', at: 15 }],
    after: { ...input.before, fingerprint: 'interrupted', observedAt: 20, observation: 2,
      current: { ...input.before.current, x: 2, y: reason === 'gravity-advance' ? 2 : 0 },
      board: reason === 'garbage-rise' ? [
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1007,
      ] : input.before.board } };
}

describe('offline recovery evidence', () => {
  it('recomputes a lock plus observed rise without counting a full-board prediction match', () => {
    const result = replayRecord(riseRecord());
    expect(result).toMatchObject({ status: 'observed-rise-consistent', board: 'unknown', clear: 'match', synthetic: true });
    expect(result).not.toHaveProperty('differingCells');
    expect(result.reason).toContain('post-observation');
    expect(result.reason).toContain('not a predicted full-board match');
  });

  it('allows changing observed holes and keeps missing clear counters unknown', () => {
    const input = riseRecord();
    input.recovery.rise = { rows: 3, holes: [0, 4, 9], insertedRows: [1022, 1007, 511] };
    input.after = { ...input.after, lines: null, board: [
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 24, 24, 1022, 1007, 511,
    ] };
    expect(replayRecord(input)).toMatchObject({ status: 'observed-rise-consistent', board: 'unknown', clear: 'unknown' });
  });

  it('checks the recomputed line clear before accepting an observed rise', () => {
    const input = riseRecord();
    input.before = { ...input.before, board: [
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 903,
    ], current: { type: 'I', x: 3, y: 0, rotation: 0 } };
    input.after = { ...input.after, lines: 1, board: [
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1007,
    ] };
    expect(replayRecord(input)).toMatchObject({ status: 'observed-rise-consistent', board: 'unknown', clear: 'match' });
    input.after = { ...input.after, lines: 0 };
    expect(replayRecord(input)).toMatchObject({ status: 'divergence-unclassified', board: 'unknown', clear: 'mismatch' });
  });

  it('rejects a recovery whose actual board merely copies a forged stored prediction', () => {
    const input = riseRecord();
    input.plan.expectedBoard = [...Array<number>(19).fill(0), 1007];
    input.after = { ...input.after, board: input.plan.expectedBoard };
    expect(replayRecord(input).status).toBe('divergence-unclassified');
  });

  it('rejects unrelated board edits and incorrect rise metadata', () => {
    const input = riseRecord();
    const board = [...input.after.board]; board[17] = 25;
    expect(replayRecord({ ...input, after: { ...input.after, board } }).status).toBe('divergence-unclassified');
    for (const rise of [
      { rows: 2, holes: [4, 4], insertedRows: [1007, 1007] },
      { rows: 1, holes: [9], insertedRows: [1007] },
      { rows: 1, holes: [4], insertedRows: [511] },
    ]) {
      expect(replayRecord({ ...input, recovery: { ...input.recovery, rise } }).status).toBe('divergence-unclassified');
    }
  });

  it('requires correct post-lock queue, hold, eligibility, and known clear delta', () => {
    const input = riseRecord();
    for (const after of [
      { ...input.after, next: input.before.next }, { ...input.after, current: input.before.current },
      { ...input.after, hold: 'T' }, { ...input.after, canHold: false }, { ...input.after, canHold: null },
      { ...input.after, lines: 1 },
    ]) expect(replayRecord({ ...input, after }).status).toBe('divergence-unclassified');
  });

  it('requires an explicit well-formed resync record and a completed final hard drop', () => {
    const input = riseRecord();
    for (const changes of [
      { result: 'unknown' }, { recovery: null }, { type: 'placement' },
      { recovery: { ...input.recovery, phase: 'bad' } },
      { recovery: { ...input.recovery, reference: 'before' } },
      { recovery: { ...input.recovery, completedAction: null } },
      { recovery: { ...input.recovery, rise: { rows: 1, holes: [Number.NaN], insertedRows: [1007] } } },
      { actions: [] }, { actions: [{ action: 'HOLD', at: 15 }] },
      { actions: [{ action: 'HARD_DROP', at: 15 }, { action: 'LEFT', at: 16 }] },
      { actions: [{ action: 'HARD_DROP', at: 15 }, { action: 'HARD_DROP', at: 16 }] },
    ]) expect(replayRecord({ ...input, ...changes }).status).toBe('invalid');
  });

  it('does not promote old failures into successful recovery evidence', () => {
    const input = riseRecord();
    expect(replayRecord({ ...input, type: 'failure', result: 'unknown' })).toMatchObject({
      status: 'incomplete', board: 'unknown', clear: 'unknown',
    });
  });

  it('keeps interrupted movement and before-input rises outside completed-lock accuracy', () => {
    const input = interruptedRecord();
    expect(replayRecord(input)).toMatchObject({ status: 'interrupted-replan', board: 'unknown', clear: 'unknown' });
    expect(replayRecord({ ...input, actions: [], recovery: { ...input.recovery, phase: 'before-input' } }))
      .toMatchObject({ status: 'interrupted-replan', board: 'unknown', clear: 'unknown' });
  });

  it('rejects interrupted rises with a completed action or changed transition context', () => {
    const input = interruptedRecord();
    for (const action of ['HOLD', 'HARD_DROP']) {
      expect(replayRecord({ ...input, actions: [{ action, at: 15 }] }).status).toBe('invalid');
    }
    expect(replayRecord({ ...input, recovery: { ...input.recovery, phase: 'before-input' } }).status).toBe('invalid');
    for (const after of [
      { ...input.after, next: ['I', 'J', 'L', 'S', 'Z'] }, { ...input.after, hold: 'T' },
      { ...input.after, canHold: false }, { ...input.after, lines: 1 },
      { ...input.after, current: { ...input.after.current, type: 'T' } },
      { ...input.after, board: input.before.board },
    ]) expect(replayRecord({ ...input, after }).status).toBe('divergence-unclassified');
  });

  it('labels a compatible downward shape as interrupted without replaying gravity timing', () => {
    const input = interruptedRecord('gravity-advance');
    const result = replayRecord(input);
    expect(result).toMatchObject({ status: 'interrupted-replan', board: 'unknown', clear: 'unknown' });
    expect(result.reason).toContain('gravity timing was not replayed');
  });

  it('rejects claimed gravity when the shape has not descended or changed context/board', () => {
    const input = interruptedRecord('gravity-advance');
    for (const after of [
      { ...input.after, current: { ...input.after.current, y: 0 } },
      { ...input.after, current: { ...input.after.current, x: 5 } },
      { ...input.after, board: interruptedRecord().after.board },
      { ...input.after, lines: 1 },
    ]) expect(replayRecord({ ...input, after }).status).toBe('divergence-unclassified');
    expect(replayRecord({ ...input, recovery: { ...input.recovery, phase: 'after-lock', reference: 'predicted-lock', completedAction: 'HARD_DROP' } }).status).toBe('invalid');
  });

  it('checks a HOLD plus board rise without counting it as a completed lock', () => {
    const input = interruptedRecord();
    const after: RuntimeSnapshot = { ...input.after, current: { type: 'I', x: 3, y: 0, rotation: 0 },
      hold: 'O', canHold: false, next: ['J', 'L', 'S', 'T', 'Z'] };
    const hold = { ...input, after, actions: [{ action: 'HOLD', at: 15 }],
      recovery: { ...input.recovery, phase: 'after-hold', completedAction: 'HOLD' } };
    expect(replayRecord(hold)).toMatchObject({ status: 'interrupted-replan', board: 'unknown', clear: 'unknown' });
    expect(replayRecord(hold).reason).toContain('HOLD transition');
    for (const badAfter of [
      { ...after, canHold: true }, { ...after, hold: null }, { ...after, next: input.before.next }, { ...after, lines: 1 },
    ]) expect(replayRecord({ ...hold, after: badAfter }).status).toBe('divergence-unclassified');
    expect(replayRecord({ ...hold, before: { ...input.before, canHold: null } }).status).toBe('divergence-unclassified');
  });

  it('checks a filled HOLD swap without consuming NEXT', () => {
    const input = interruptedRecord();
    const before: RuntimeSnapshot = { ...input.before, hold: 'T' };
    const after: RuntimeSnapshot = { ...input.after, current: { type: 'T', x: 3, y: 0, rotation: 0 },
      hold: 'O', canHold: false, next: input.before.next };
    expect(replayRecord({ ...input, before, after, actions: [{ action: 'HOLD', at: 15 }],
      recovery: { ...input.recovery, phase: 'after-hold', completedAction: 'HOLD' } }))
      .toMatchObject({ status: 'interrupted-replan', board: 'unknown', clear: 'unknown' });
  });

  it('rejects malformed after observations and bounds copied simulation work', () => {
    const input = riseRecord(); const sparse = [...input.after.board]; delete sparse[0];
    for (const after of [
      { ...input.after, board: sparse }, { ...input.after, board: [...input.after.board.slice(0, 19), Number.NaN] },
      { ...input.after, ended: true }, { ...input.after, paused: true },
      { ...input.after, current: { ...input.after.current, y: 19 } },
    ]) expect(replayRecord({ ...input, after }).status).toBe('invalid');
    expect(replayRecord({ ...input, actions: Array.from({ length: 122 }, () => ({ action: 'LEFT', at: 15 })) }).status).toBe('invalid');
    expect(replayRecord({ ...input, before: { ...input.before, rotationCandidates: Array.from({ length: 5 }, () => input.before.current) } }).status).toBe('invalid');
  });

  it('lets the replay CLI accept recovery statuses while keeping their metadata and limitations explicit', () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'tetris-replay-resync-'));
    const path = join(temporaryDirectory, 'synthetic.jsonl');
    const originalArgv = process.argv; const originalExitCode = process.exitCode;
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      writeFileSync(path, [riseRecord(), interruptedRecord('gravity-advance')].map(value => JSON.stringify(value)).join('\n'));
      process.argv = [originalArgv[0]!, originalArgv[1]!, path]; process.exitCode = undefined;
      replayMain();
      expect(process.exitCode).toBeUndefined();
      const report = JSON.parse(output.mock.calls[0]![0] as string);
      expect(report.counts).toEqual({ 'observed-rise-consistent': 1, 'interrupted-replan': 1 });
      expect(report.results).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'observed-rise-consistent', board: 'unknown', synthetic: true }),
        expect.objectContaining({ status: 'interrupted-replan', board: 'unknown', clear: 'unknown', synthetic: true }),
      ]));
      expect(report.limitations).toContain('Observed-rise consistency checks later display evidence; it is not a predicted full-board or server-order match');
    } finally {
      process.argv = originalArgv; process.exitCode = originalExitCode; output.mockRestore();
      rmSync(path, { force: true }); rmdirSync(temporaryDirectory);
    }
  });
});
