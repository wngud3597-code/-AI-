import { describe, expect, it } from 'vitest';
import { emptyBoard } from '../../src/physics/board';
import { rotateSrs } from '../../src/physics/srs';
import { PIECE_TYPES } from '../../src/types/game';

describe('SRS rotation', () => {
  it('rotates every piece from every state in both directions on an empty center field', () => {
    for (const piece of PIECE_TYPES) {
      for (const rotation of [0, 1, 2, 3] as const) {
        for (const direction of [-1, 1] as const) {
          const result = rotateSrs(emptyBoard(), piece, { x: 3, y: 4, rotation }, direction);
          expect(result).not.toBeNull();
          expect(result?.kickIndex).toBe(0);
        }
      }
    }
  });

  it('uses a JLSTZ wall kick', () => {
    const result = rotateSrs(emptyBoard(), 'T', { x: -1, y: 0, rotation: 1 }, -1);
    expect(result).toMatchObject({ x: 0, y: 0, rotation: 0, kickIndex: 1 });
  });

  it('uses an I-specific wall kick', () => {
    const result = rotateSrs(emptyBoard(), 'I', { x: -2, y: 0, rotation: 1 }, -1);
    expect(result).toMatchObject({ x: 0, y: 0, rotation: 0, kickIndex: 1 });
  });

  it('uses a floor kick when the un-kicked rotation collides', () => {
    const result = rotateSrs(emptyBoard(), 'T', { x: 3, y: 18, rotation: 0 }, 1);
    expect(result).toMatchObject({ x: 2, y: 17, rotation: 1, kickIndex: 2 });
  });
});
