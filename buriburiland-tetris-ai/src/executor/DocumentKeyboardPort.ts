import type { InputPort } from './Executor';
import type { MoveAction } from '../move/ReachableMoveGenerator';

const KEY_MAP: Record<MoveAction | 'HOLD', readonly [key: string, code: string, keyCode: number]> = {
  LEFT: ['ArrowLeft', 'ArrowLeft', 37],
  RIGHT: ['ArrowRight', 'ArrowRight', 39],
  SOFT_DROP: ['ArrowDown', 'ArrowDown', 40],
  ROTATE_CW: ['ArrowUp', 'ArrowUp', 38],
  ROTATE_CCW: ['z', 'KeyZ', 90],
  HARD_DROP: [' ', 'Space', 32],
  HOLD: ['c', 'KeyC', 67],
};

export class DocumentKeyboardPort implements InputPort {
  constructor(
    private readonly target: Document = document,
    private readonly keyHoldMs = 8,
  ) {}

  async tap(action: MoveAction | 'HOLD'): Promise<void> {
    const [key, code, keyCode] = KEY_MAP[action];
    this.dispatch('keydown', key, code, keyCode);
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, this.keyHoldMs));
    } finally {
      this.dispatch('keyup', key, code, keyCode);
    }
  }

  private dispatch(type: 'keydown' | 'keyup', key: string, code: string, keyCode: number): void {
    this.target.dispatchEvent(new KeyboardEvent(type, {
      key,
      code,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
      composed: true,
      repeat: false,
    }));
  }
}
