import { describe, expect, it } from 'vitest';
import { applyRuntimeAction, boardFeatures, cellsFor, collides, evaluateBoard, hardDropY, lockPiece, reachablePlacements, rotateSrs, runtimeCells, search, spawnPiece } from '../../src/runtime/engine';
import type { ActivePiece, Board, PieceType, Rotation, RuntimePlan, RuntimeSnapshot } from '../../src/runtime/model';
import { RUNTIME_RULE_PROFILE } from '../../src/runtime/model';
import { PIECE_TYPES } from '../../src/types/game';

// Independent matrices copied from the public client, not generated from the
// production geometry/lock functions. These catch the old pivot/bbox mismatch.
const MATRICES: Record<PieceType, readonly (readonly string[])[]> = {
  I: [['1111'], ['1', '1', '1', '1'], ['1111'], ['1', '1', '1', '1']],
  J: [['100', '111'], ['11', '10', '10'], ['111', '001'], ['01', '01', '11']],
  L: [['001', '111'], ['10', '10', '11'], ['111', '100'], ['11', '01', '01']],
  O: [['11', '11'], ['11', '11'], ['11', '11'], ['11', '11']],
  S: [['011', '110'], ['10', '11', '01'], ['011', '110'], ['10', '11', '01']],
  T: [['010', '111'], ['10', '11', '10'], ['111', '010'], ['01', '11', '01']],
  Z: [['110', '011'], ['01', '11', '10'], ['110', '011'], ['01', '11', '10']],
};

function empty(): number[] { return Array<number>(20).fill(0); }
function referenceCells(piece: ActivePiece): readonly (readonly [number, number])[] {
  return MATRICES[piece.type][piece.rotation]!.flatMap((row, y) => [...row].flatMap((cell, x) => cell === '1' ? [[piece.x + x, piece.y + y] as const] : []));
}
function referenceCollision(board: Board, piece: ActivePiece): boolean {
  return referenceCells(piece).some(([x, y]) => x < 0 || x >= 10 || y >= 20 || y >= 0 && (((board[y] ?? 0) >> x) & 1) !== 0);
}
const NORMAL_KICKS: Record<string, readonly (readonly [number, number])[]> = {
  '0>1': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]], '1>0': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '1>2': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]], '2>1': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '2>3': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]], '3>2': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '3>0': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]], '0>3': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
};
const I_KICKS: Record<string, readonly (readonly [number, number])[]> = {
  '0>1': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]], '1>0': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  '1>2': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]], '2>1': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  '2>3': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]], '3>2': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  '3>0': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]], '0>3': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
};
function referenceRotate(board: Board, piece: ActivePiece, direction: 1 | -1): ActivePiece | null {
  if (piece.type === 'O') return piece;
  const rotation = ((piece.rotation + direction + 4) % 4) as Rotation;
  const offsets: readonly (readonly [number, number])[] = piece.type === 'I' ? [[0, 1], [2, 0], [0, 2], [1, 0]] : [[0, 0], [1, 0], [0, 1], [0, 0]];
  const from = offsets[piece.rotation]!, to = offsets[rotation]!;
  for (const [kickX, kickY] of (piece.type === 'I' ? I_KICKS : NORMAL_KICKS)[`${piece.rotation}>${rotation}`]!) {
    const candidate = { ...piece, rotation, x: piece.x + kickX + to[0] - from[0], y: piece.y + kickY + to[1] - from[1] };
    if (!referenceCollision(board, candidate)) return candidate;
  }
  return null;
}
function referenceLock(board: Board, piece: ActivePiece): { board: number[]; cleared: number } | null {
  if (referenceCollision(board, piece) || referenceCells(piece).some(([, y]) => y < 0)) return null;
  const matrix = board.map((row) => Array.from({ length: 10 }, (_, x) => (row >> x) & 1));
  for (const [x, y] of referenceCells(piece)) matrix[y]![x] = 1;
  const remaining = matrix.filter((row) => row.some((cell) => cell === 0));
  const cleared = 20 - remaining.length;
  while (remaining.length < 20) remaining.unshift(Array<number>(10).fill(0));
  return { board: remaining.map((row) => row.reduce((mask, cell, x) => mask | (cell << x), 0)), cleared };
}
function snapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return { board: empty(), current: { type: 'T', x: 3, y: 0, rotation: 0 }, next: ['I', 'O', 'J', 'L', 'S'], hold: null, canHold: false, fingerprint: 'board-and-piece', session: 'session-1', player: 'local-player', observedAt: 123, observation: 1, paused: false, ended: false, lines: 0, incoming: null, ...overrides };
}
function verifyPlan(before: RuntimeSnapshot, plan: RuntimePlan): void {
  expect(plan.kind).toBe('place');
  let pose = before.current;
  for (const action of plan.path) {
    const next = applyRuntimeAction(before.board, pose, action);
    expect(next).not.toBeNull();
    pose = next!;
    expect(referenceCollision(before.board, pose)).toBe(false);
  }
  expect(pose).toEqual(plan.target);
  const expected = referenceLock(before.board, pose);
  expect(expected).not.toBeNull();
  expect(plan.expectedBoard).toEqual(expected!.board);
  expect(plan.cleared).toBe(expected!.cleared);
}
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
}

describe('runtime client coordinate fidelity', () => {
  for (const type of PIECE_TYPES) {
    for (const rotation of [0, 1, 2, 3] as const) {
      it(`${type}/${rotation} uses the public trimmed matrix`, () => {
        const pose: ActivePiece = { type, rotation, x: 2, y: 4 };
        expect(runtimeCells(pose)).toEqual(referenceCells(pose));
        expect(Math.min(...cellsFor(type, rotation).map(([x]) => x))).toBe(0);
        expect(Math.min(...cellsFor(type, rotation).map(([, y]) => y))).toBe(0);
        expect(collides(empty(), type, rotation, -1, 0)).toBe(true);
        const y = hardDropY(empty(), type, rotation, 2, 0);
        expect(referenceCollision(empty(), { ...pose, y })).toBe(false);
        expect(referenceCollision(empty(), { ...pose, y: y + 1 })).toBe(true);
        expect(lockPiece(empty(), type, rotation, 2, y)?.board).toEqual(referenceLock(empty(), { ...pose, y })!.board);
      });
    }
  }

  it('converts CW/CCW coordinates with exact bbox offsets', () => {
    const i: ActivePiece = { type: 'I', x: 3, y: 0, rotation: 0 };
    expect(rotateSrs(empty(), i, 1)).toEqual({ type: 'I', x: 5, y: -1, rotation: 1 });
    expect(rotateSrs(empty(), i, -1)).toEqual({ type: 'I', x: 4, y: -1, rotation: 3 });
    const t: ActivePiece = { type: 'T', x: 3, y: 0, rotation: 0 };
    expect(rotateSrs(empty(), t, 1)).toEqual({ type: 'T', x: 4, y: 0, rotation: 1 });
    expect(rotateSrs(empty(), t, -1)).toEqual({ type: 'T', x: 3, y: 0, rotation: 3 });
    expect(rotateSrs(empty(), { type: 'O', x: 3, y: 0, rotation: 0 }, 1)).toEqual({ type: 'O', x: 3, y: 0, rotation: 0 });
  });

  it('matches independent ordered client kicks at walls, floors, and seeded obstacles', () => {
    const rng = random(0x45ac2);
    let checked = 0;
    for (let sample = 0; sample < 25; sample++) {
      const board = empty();
      if (sample > 0) for (let y = 12; y < 20; y++) for (let x = 0; x < 10; x++) if (rng() < 0.3) board[y] = (board[y] ?? 0) | (1 << x);
      for (const type of PIECE_TYPES) for (const rotation of [0, 1, 2, 3] as const) {
        for (const x of [0, 3, 7, 8, 9]) for (const y of [0, 11, 16, 17, 18, 19]) {
          const piece = { type, rotation, x, y };
          if (referenceCollision(board, piece)) continue;
          for (const direction of [1, -1] as const) {
            expect(rotateSrs(board, piece, direction)).toEqual(referenceRotate(board, piece, direction));
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(10_000);
  });

  it('uses client spawn fallback without silently resetting an invalid observed pose', () => {
    const board = empty();
    board[1] = 1 << 3;
    expect(spawnPiece(board, 'I')).toEqual({ type: 'I', x: 3, y: 0, rotation: 0 });
    board[0] = 1 << 3;
    expect(spawnPiece(board, 'I')).toEqual({ type: 'I', x: 3, y: -1, rotation: 0 });
    expect(search(snapshot({ board, current: { type: 'I', x: 3, y: 0, rotation: 0 } }))).toBeNull();
  });

  it('flags an above-board lock as top-out and never searches it as a valid placement', () => {
    const board = empty(); board[0] = 1023;
    expect(lockPiece(board, 'I', 0, 3, -1)?.topOut).toBe(true);
    expect(reachablePlacements(board, { type: 'I', x: 3, y: -1, rotation: 0 }, { now: () => 0 })).toEqual([]);
  });

  it('matches independent collision/drop/clear on 70 seeded messy boards', () => {
    const rng = random(0x7492);
    for (let sample = 0; sample < 70; sample += 1) {
      const board = empty();
      for (let y = 10; y < 20; y += 1) for (let x = 0; x < 10; x += 1) if (rng() < 0.42) board[y] = (board[y] ?? 0) | (1 << x);
      const type = PIECE_TYPES[sample % 7]!;
      const rotation = (sample % 4) as Rotation;
      for (let x = -1; x < 10; x += 1) {
        const piece: ActivePiece = { type, rotation, x, y: 0 };
        expect(collides(board, type, rotation, x, 0)).toBe(referenceCollision(board, piece));
        if (referenceCollision(board, piece)) continue;
        let y = 0;
        while (!referenceCollision(board, { ...piece, y: y + 1 })) y += 1;
        expect(hardDropY(board, type, rotation, x, 0)).toBe(y);
        const locked = lockPiece(board, type, rotation, x, y)!;
        expect({ board: locked.board, cleared: locked.cleared }).toEqual(referenceLock(board, { ...piece, y }));
      }
    }
  });
});

describe('bounded runtime search', () => {
  it('keeps an executable depth-one result at the global node budget', () => {
    const before = snapshot();
    const result = search(before, { maxNodes: 1, now: () => 0, depth: 5 })!;
    expect(result.nodes).toBe(1);
    expect(result.budgetExhausted).toBe(true);
    expect(result.depth).toBe(1);
    expect(result.path).toEqual(['HARD_DROP']);
    verifyPlan(before, result);
  });

  it('enforces the deadline inside root BFS, not only between search depths', () => {
    let clock = 0;
    const result = search(snapshot(), { budgetMs: 5, now: () => clock++, maxNodes: 100_000 })!;
    expect(result).not.toBeNull();
    expect(result.nodes).toBe(4);
    expect(result.budgetExhausted).toBe(true);
    expect(result.depth).toBe(1);
  });

  it('returns null without input for paused, ended, malformed, or already-colliding observations', () => {
    expect(search(snapshot({ paused: true }))).toBeNull();
    expect(search(snapshot({ ended: true }))).toBeNull();
    expect(search(snapshot({ board: [0] }))).toBeNull();
    expect(search(snapshot({ current: { type: 'I', x: 3, y: -1_000_000, rotation: 0 } }))).toBeNull();
    const board = empty(); board[0] = 1023;
    expect(search(snapshot({ board }))).toBeNull();
  });

  it('rejects malformed Worker snapshots before any search clock or physics work', () => {
    const invalid: unknown[] = [null, undefined, [], {},
      snapshot({ incoming: NaN }), snapshot({ incoming: Infinity }), snapshot({ incoming: -1 }), snapshot({ incoming: 1.5 }),
      snapshot({ lines: NaN }), snapshot({ lines: -1 }), snapshot({ observedAt: NaN }), snapshot({ observedAt: Infinity }), snapshot({ observedAt: -1 }),
      snapshot({ observation: -1 }), snapshot({ observation: 1.5 }), snapshot({ observation: Number.MAX_SAFE_INTEGER + 1 }),
      snapshot({ fingerprint: '' }), snapshot({ session: '' }), snapshot({ player: '' }),
      snapshot({ current: { type: 'I', x: -5, y: 0, rotation: 0 } }),
      snapshot({ current: { type: 'I', x: 10, y: 0, rotation: 0 } }),
      snapshot({ current: { type: 'I', x: 3, y: Infinity, rotation: 0 } }),
      snapshot({ current: { type: 'I', x: 3, y: -1_000_000_000, rotation: 0 } }),
      snapshot({ board: Array<number>(20) }), snapshot({ next: Array<PieceType>(5) }),
      { ...snapshot(), canHold: 'false' }, { ...snapshot(), paused: 'false' }, { ...snapshot(), ended: 0 },
      { ...snapshot(), current: null }, { ...snapshot(), hold: 'bad' }, { ...snapshot(), next: null },
      { ...snapshot(), next: ['I', 'O', 'T', 'S', 'Z', 'J'] },
      { ...snapshot(), rotationCandidates: null }, { ...snapshot(), rotationCandidates: [] },
      { ...snapshot(), rotationCandidates: [null] },
      { ...snapshot(), rotationCandidates: [{ type: 'T', x: NaN, y: 0, rotation: 0 }] },
      { ...snapshot(), rotationCandidates: [{ type: 'T', x: 3, y: 0, rotation: '0' }] },
      { ...snapshot(), rotationCandidates: [{ type: 'J', x: 3, y: 0, rotation: 0 }] },
      { ...snapshot(), rotationCandidates: [{ type: 'T', x: 4, y: 0, rotation: 0 }] },
      { ...snapshot(), rotationCandidates: [snapshot().current, snapshot().current] },
    ];
    for (const value of invalid) {
      const clock = () => { throw new Error('Invalid data reached search execution'); };
      expect(search(value as RuntimeSnapshot, { now: clock })).toBeNull();
    }
  });

  it('accepts explicit unknown counters, an empty visible queue, and a valid candidate pose', () => {
    const before = snapshot({ next: [], canHold: null, lines: null, incoming: null });
    expect(search({ ...before, rotationCandidates: [before.current] }, { maxNodes: 1, now: () => 0 })).not.toBeNull();
  });

  it('clears a four-line well with an executable I path', () => {
    const board = empty();
    for (let y = 16; y < 20; y += 1) board[y] = 1023 ^ (1 << 9);
    const before = snapshot({ board, current: { type: 'I', x: 3, y: 0, rotation: 0 } });
    const result = search(before, { depth: 1, allowHold: false, now: () => 0 })!;
    verifyPlan(before, result);
    expect(result.cleared).toBe(4);
    expect(result.expectedBoard).toEqual(empty());
    expect(result.ruleProfile).toBe(RUNTIME_RULE_PROFILE.id);
  });

  it('makes occupied and empty HOLD a separate transition with an unchanged board', () => {
    const board = empty();
    for (let y = 16; y < 20; y += 1) board[y] = 1023 ^ (1 << 9);
    for (const hold of ['I', null] as const) {
      const before = snapshot({ board, current: { type: 'O', x: 3, y: 0, rotation: 0 }, hold, canHold: true, next: ['I', 'O'] });
      const result = search(before, { depth: 1, now: () => 0 })!;
      expect(result.kind).toBe('hold');
      expect(result.path).toEqual([]);
      expect(result.target).toEqual({ type: 'I', x: 3, y: 0, rotation: 0 });
      expect(result.expectedBoard).toEqual(board);
      expect(result.cleared).toBe(0);
      expect(search({ ...before, canHold: false }, { depth: 1, now: () => 0 })!.kind).toBe('place');
      expect(search({ ...before, canHold: null }, { depth: 1, now: () => 0 })!.kind).toBe('place');
    }
  });

  it('only emits paths that work for every ambiguous symmetric orientation', () => {
    for (const type of ['I', 'S', 'Z'] as const) {
      const initial: ActivePiece = { type, x: 3, y: 0, rotation: 0 };
      const alternatives: ActivePiece[] = [initial, { ...initial, rotation: 2 }];
      const before = snapshot({ current: initial, rotationCandidates: alternatives });
      const result = search(before, { depth: 1, now: () => 0 })!;
      verifyPlan(before, result);
      const targets = alternatives.map((pose) => {
        let current = pose;
        for (const action of result.path) current = applyRuntimeAction(before.board, current, action)!;
        return referenceCells(current).map(([x, y]) => `${x}:${y}`).sort();
      });
      expect(targets[0]).toEqual(targets[1]);
      expect(result.assumptions.some((value) => value.includes('Ambiguous rotation'))).toBe(true);
    }
  });

  it('uses reachable future plies and keeps deterministic results', () => {
    const before = snapshot();
    const options = { depth: 2, beamWidth: 3, maxNodes: 30_000, allowHold: false, now: () => 0 } as const;
    const first = search(before, options)!;
    expect(first.depth).toBe(2);
    expect(first).toEqual(search(before, options));
    verifyPlan(before, first);
  });

  it('does not invent future pieces or claim an unobserved search depth', () => {
    const result = search(snapshot({ next: [] }), { depth: 5, now: () => 0 })!;
    expect(result.depth).toBe(1);
    const holdConsumesLastKnown = search(snapshot({ next: ['I'], canHold: true }), { depth: 5, now: () => 0 })!;
    expect(holdConsumesLastKnown.depth).toBe(1);
  });

  it('retains executable results across seeded incoming-garbage stress boards', () => {
    const rng = random(0x6712);
    for (let sample = 0; sample < 16; sample += 1) {
      const board = empty();
      const height = 1 + sample % 9;
      let hole = Math.floor(rng() * 10);
      for (let y = 20 - height; y < 20; y += 1) {
        if (rng() < 0.25) hole = Math.floor(rng() * 10);
        board[y] = 1023 ^ (1 << hole);
      }
      const before = snapshot({ board, current: { type: PIECE_TYPES[sample % 7]!, x: 3, y: 0, rotation: 0 }, incoming: sample % 8 });
      const result = search(before, { maxNodes: 1_200, depth: 3, allowHold: false, now: () => 0 });
      expect(result).not.toBeNull();
      expect(result!.nodes).toBeLessThanOrEqual(1_200);
      verifyPlan(before, result!);
    }
  });

  it('penalizes new holes, covered cells, deep canyons, and incoming height pressure', () => {
    const open = empty(); open[19] = 0b1111111100;
    const covered = [...open]; covered[18] = 1 << 1;
    expect(boardFeatures(covered).holes).toBeGreaterThan(boardFeatures(open).holes);
    expect(evaluateBoard(covered)).toBeLessThan(evaluateBoard(open));
    const high = empty(); for (let y = 8; y < 20; y += 1) high[y] = 0b1111100000;
    expect(evaluateBoard(high, 6)).toBeLessThan(evaluateBoard(high, 0));
  });
});
