import { describe, expect, it } from 'vitest';
import { detectGarbageRise } from '../../src/runtime/board-transition';
import type { Board } from '../../src/types/game';

// Literal observations deliberately do not use a garbage insertion simulator.
const base: Board = Object.freeze([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 24, 25,
]);
const oneRow: Board = Object.freeze([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 24, 25, 1022,
]);
const alignedRows: Board = Object.freeze([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 24, 25, 1007, 1007, 1007,
]);
const changingHoles: Board = Object.freeze([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 24, 25, 1022, 1007, 511,
]);

describe('observed garbage board rise', () => {
  it('recognizes one inserted row even if its hole is covered by the retained stack', () => {
    expect(detectGarbageRise(base, oneRow)).toEqual({ rows: 1, holes: [0], insertedRows: [1022] });
  });

  it('recognizes several inserted rows with aligned holes', () => {
    expect(detectGarbageRise(base, alignedRows)).toEqual({
      rows: 3, holes: [4, 4, 4], insertedRows: [1007, 1007, 1007],
    });
  });

  it('allows the hole to change between inserted rows', () => {
    expect(detectGarbageRise(base, changingHoles)).toEqual({
      rows: 3, holes: [0, 4, 9], insertedRows: [1022, 1007, 511],
    });
  });

  it.each([
    [1022, 0], [1021, 1], [1019, 2], [1015, 3], [1007, 4],
    [991, 5], [959, 6], [895, 7], [767, 8], [511, 9],
  ])('recognizes mask %i as having its hole in column %i', (mask, hole) => {
    const actual = [...oneRow];
    actual[19] = mask!;
    expect(detectGarbageRise(base, actual)?.holes).toEqual([hole]);
  });

  it('recognizes the largest visible shift while retaining the last original row', () => {
    const before = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 24];
    const after = [24, 1022, 1022, 1022, 1022, 1022, 1022, 1022, 1022, 1022,
      1022, 1022, 1022, 1022, 1022, 1022, 1022, 1022, 1022, 511];
    expect(detectGarbageRise(before, after)).toEqual({
      rows: 19, holes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9],
      insertedRows: [1022, 1022, 1022, 1022, 1022, 1022, 1022, 1022, 1022, 1022,
        1022, 1022, 1022, 1022, 1022, 1022, 1022, 1022, 511],
    });
  });

  it('returns a frozen independent result without mutating either input', () => {
    const before = [...base];
    const after = [...changingHoles];
    const result = detectGarbageRise(before, after);
    expect(before).toEqual(base);
    expect(after).toEqual(changingHoles);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.holes)).toBe(true);
    expect(Object.isFrozen(result?.insertedRows)).toBe(true);
    after[17] = 0;
    expect(result?.insertedRows).toEqual([1022, 1007, 511]);
  });

  it('does not classify equality as an insertion even when garbage is already present', () => {
    expect(detectGarbageRise(base, [...base])).toBeNull();
    expect(detectGarbageRise(alignedRows, [...alignedRows])).toBeNull();
  });

  it('rejects a shift that loses occupied cells above the visible board', () => {
    const before = [...base];
    before[0] = 1;
    expect(detectGarbageRise(before, oneRow)).toBeNull();
    before[0] = 0;
    before[2] = 8;
    expect(detectGarbageRise(before, changingHoles)).toBeNull();
  });

  it('rejects a changed retained body despite otherwise valid garbage rows', () => {
    const after = [...changingHoles];
    after[15] = 8;
    expect(detectGarbageRise(base, after)).toBeNull();
  });

  it.each([0, 1, 1006, 1020, 1023])('rejects arbitrary appended row mask %i', mask => {
    const after = [...oneRow];
    after[19] = mask;
    expect(detectGarbageRise(base, after)).toBeNull();
  });

  it('rejects ordinary placements and downward board changes', () => {
    expect(detectGarbageRise(base, [
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 24, 24, 24, 25,
    ])).toBeNull();
    expect(detectGarbageRise(oneRow, base)).toBeNull();
  });

  it('rejects an entirely replaced board with no retained original row', () => {
    expect(detectGarbageRise(Array<number>(20).fill(0), Array<number>(20).fill(1022))).toBeNull();
  });

  it.each([-1, 1024, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects invalid masks %s in either input', mask => {
      const before = [...base];
      before[0] = mask;
      const after = [...oneRow];
      after[0] = mask;
      expect(detectGarbageRise(before, oneRow)).toBeNull();
      expect(detectGarbageRise(base, after)).toBeNull();
    },
  );

  it('rejects non-board values, missing entries, and incorrect lengths', () => {
    const sparse = [...base];
    delete sparse[0];
    const sparseActual = [...oneRow];
    delete sparseActual[0];
    const invalid: unknown[] = [null, undefined, {}, '0'.repeat(20), new Uint16Array(20),
      base.slice(1), [...base, 0], sparse, [...base.slice(0, 19), undefined]];
    for (const value of invalid) {
      expect(detectGarbageRise(value as Board, oneRow)).toBeNull();
      expect(detectGarbageRise(base, value as Board)).toBeNull();
    }
    expect(detectGarbageRise(base, sparseActual)).toBeNull();
  });
});
