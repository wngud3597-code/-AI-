// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { DomAdapter, DomReadError, posesForCells, snapshotCells } from '../../src/runtime/dom';
import type { PieceType, Rotation } from '../../src/runtime/model';
import { SCRIPT_VERSION } from '../../src/runtime/version';

// Independent public-client renderer fixtures, chunk 847.a5a05f14ceb3f87d.js.
// No engine shape, renderer, or rotation function is used to generate these cases.
const SHAPES: Record<PieceType, readonly string[]> = {
  I: ['1111', '1/1/1/1', '1111', '1/1/1/1'],
  O: ['11/11', '11/11', '11/11', '11/11'],
  T: ['010/111', '10/11/10', '111/010', '01/11/01'],
  S: ['011/110', '10/11/01', '011/110', '10/11/01'],
  Z: ['110/011', '01/11/10', '110/011', '01/11/10'],
  J: ['100/111', '11/10/10', '111/001', '01/01/11'],
  L: ['001/111', '10/10/11', '111/100', '11/01/01'],
};
const COLORS: Record<PieceType, string> = {
  I: '#22d3ee', O: '#facc15', T: '#a78bfa', S: '#84cc16',
  Z: '#fb7185', J: '#60a5fa', L: '#fb923c',
};

function points(type: PieceType, rotation: Rotation): readonly (readonly [number, number])[] {
  return SHAPES[type][rotation]!.split('/').flatMap((row, y) =>
    [...row].flatMap((filled, x) => filled === '1' ? [[x, y] as const] : []));
}

function preview(type: PieceType, compact = false): string {
  const matrix = SHAPES[type][0]!.split('/');
  const columns = compact ? matrix[0]!.length : 4;
  const rows = compact ? matrix.length : 4;
  const cells = Array.from({ length: rows }, (_, y) => Array.from({ length: columns }, (_, x) =>
    `<div class="tetris-cell${matrix[y]?.[x] === '1' ? ' is-filled' : ''}" style="--cell-color:${COLORS[type]}"></div>`).join('')).join('');
  return `<div class="tetris-next ${compact ? 'tetris-hold-preview' : 'tetris-queue-preview'}" style="--preview-cols:${columns}">${cells}</div>`;
}

function setRect(element: Element, x: number, y: number, width: number, height: number): void {
  element.getBoundingClientRect = () => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON() { return {}; } });
}

function fixture(type: PieceType = 'T', rotation: Rotation = 0, x = 3, y = 1): HTMLElement {
  const root = document.createElement('main');
  root.className = 'tetris-root';
  root.innerHTML = `<header class="tetris-header"><div class="tetris-status">속도 LV.1</div></header>
    <section class="tetris-stage is-solo-view">
      <aside class="tetris-left-panel"><div class="tetris-stack"><button class="tetris-hold-card"><strong>EMPTY</strong></button></div>
        <div class="tetris-metrics"><div class="tetris-card"><span>제거 줄</span><strong>2</strong></div><div class="tetris-card"><span>상태</span><strong>생존</strong></div></div></aside>
      <section class="tetris-board-panel"><div class="tetris-board-wrap"><div class="tetris-playfield tetris-board has-spawn-area">
        <div class="tetris-spawn-area"></div><div class="tetris-visible-board"><div class="tetris-grid">${'<div class="tetris-cell"></div>'.repeat(200)}</div>
          <div class="tetris-piece-layer is-ghost" data-piece-type="I"><div class="tetris-layer-cell is-ghost"></div></div>
          <div class="tetris-piece-layer" data-piece-type="${type}" style="transform:translate3d(${10 * x}%, ${5 * y}%, 0)">${points(type, rotation).map(([cx, cy]) => `<div class="tetris-cell tetris-layer-cell is-filled" style="left:${cx * 10}%;top:${cy * 5}%"></div>`).join('')}</div>
        </div></div></div></section>
      <aside class="tetris-right-panel"><div class="tetris-next-list">${(['J', 'O', 'S', 'Z', 'I'] as const).map(type => preview(type)).join('')}</div></aside>
      <div class="tetris-mobile-controls"><div class="tetris-mobile-move-group"><button>← 좌</button><button>↓ 아래</button><button>→ 우</button></div></div>
    </section>`;
  document.body.append(root);
  const stage = root.querySelector<HTMLElement>('.tetris-stage')!;
  const grid = stage.querySelector('.tetris-grid')!;
  setRect(grid, 200, 100, 300, 600);
  const activeCells = [...stage.querySelectorAll('.tetris-piece-layer:not(.is-ghost) > .tetris-layer-cell')];
  points(type, rotation).forEach(([cx, cy], index) => setRect(activeCells[index]!, 200 + (x + cx) * 30, 100 + (y + cy) * 30, 30, 30));
  return stage;
}

function failure(adapter: DomAdapter): DomReadError {
  try { adapter.read(); } catch (error) {
    expect(error).toBeInstanceOf(DomReadError);
    return error as DomReadError;
  }
  throw new Error('Expected a DOM read failure');
}

function garbageGauge(amount: string, capped = '8'): string {
  return `<div class="tetris-garbage-gauge"><div class="tetris-garbage-gauge-track" role="meter" aria-valuenow="${capped}" aria-label="받은 공격 ${amount}줄"></div></div>`;
}

// The public client nests mobile opponents below the local player's metrics in
// multiplayer rooms. CSS may hide them, but their meters remain in the DOM.
function appendMobileOpponents(stage: HTMLElement, count: number, hidden = false): HTMLElement {
  const slot = document.createElement('div');
  slot.className = 'tetris-mobile-opponent-slot';
  if (hidden) slot.style.display = 'none';
  slot.innerHTML = Array.from({ length: count }, (_, index) =>
    `<article class="tetris-opponent-board"><div class="tetris-metrics"><div class="tetris-card"><span>제거 줄</span><strong>${80 + index}</strong></div><div class="tetris-card"><span>상태</span><strong>탈락</strong></div>${garbageGauge(String(index + 1), String(index + 1))}</div></article>`).join('');
  stage.querySelector(':scope > .tetris-left-panel > .tetris-metrics')!.append(slot);
  return slot;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('public local-player DOM adapter', () => {
  it.each(Object.keys(SHAPES) as PieceType[])('recovers all four %s orientations from four absolute cell rectangles', type => {
    for (const rotation of [0, 1, 2, 3] as const) {
      document.body.innerHTML = '';
      fixture(type, rotation, 4, -1);
      const read = new DomAdapter().read();
      expect(read.rotationCandidates).toContainEqual({ type, rotation, x: 4, y: -1 });
      expect(snapshotCells(read.current)).toEqual(expect.arrayContaining(points(type, rotation).map(([x, y]) => [x + 4, y - 1])));
      expect(read.current.x).toBe(4);
      expect(read.current.y).toBe(-1);
      expect(read.rotationCandidates!.length).toBe(type === 'O' ? 4 : ['I', 'S', 'Z'].includes(type) ? 2 : 1);
    }
  });

  it('copies only fixed grid cells and the selected stage queue; ignores ghosts and opponents', () => {
    const stage = fixture();
    stage.querySelector('.tetris-grid')!.children[199]!.classList.add('is-filled');
    const opponent = document.createElement('aside');
    opponent.className = 'tetris-opponents tetris-left-panel';
    opponent.innerHTML = `<div class="tetris-playfield tetris-mini"><div class="tetris-grid">${'<div class="tetris-cell is-filled"></div>'.repeat(200)}</div></div>${preview('T')}`;
    stage.prepend(opponent);
    const adapter = new DomAdapter();
    const read = adapter.read();
    expect(adapter.candidates()).toEqual([stage]);
    expect(read.board).toEqual([...Array<number>(19).fill(0), 512]);
    expect(read.next).toEqual(['J', 'O', 'S', 'Z', 'I']);
    expect(read.hold).toBeNull();
    expect(read.canHold).toBe(true);
    expect(read.lines).toBe(2);
    expect(read.incoming).toBeNull();
    stage.querySelector('.tetris-grid')!.children[199]!.classList.remove('is-filled');
    expect(read.board[19]).toBe(512);
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(read.board)).toBe(true);
    expect(Object.isFrozen(read.current)).toBe(true);
    expect(Object.isFrozen(read.rotationCandidates)).toBe(true);
  });

  it('requires an explicit choice when two supported main stages exist and rejects a stale choice', () => {
    const first = fixture('I');
    const second = fixture('O');
    const adapter = new DomAdapter();
    expect(failure(adapter).kind).toBe('selection');
    adapter.select(second.querySelector<HTMLElement>('.tetris-grid')!);
    expect(adapter.selected()).toBe(second);
    expect(adapter.read().current.type).toBe('O');
    second.parentElement!.remove();
    expect(failure(adapter).kind).toBe('selection');
    adapter.select(first);
    expect(adapter.read().current.type).toBe('I');
  });

  it('blocks a one-player spectator even without a spectator switch', () => {
    const stage = fixture();
    stage.parentElement!.querySelector('.tetris-status')!.textContent = 'private-nickname 관전 중';
    const adapter = new DomAdapter();
    expect(adapter.status().spectating).toBe(true);
    expect(failure(adapter).kind).toBe('spectator');
    expect(JSON.stringify(adapter.report())).not.toContain('private-nickname');
  });

  it('does not mistake pause-disabled HOLD for a used HOLD; validates tR through movement controls', () => {
    const stage = fixture();
    const hold = stage.querySelector<HTMLButtonElement>('.tetris-hold-card')!;
    hold.disabled = true;
    const adapter = new DomAdapter();
    expect(adapter.read().canHold).toBe(false);
    stage.querySelector<HTMLButtonElement>('.tetris-mobile-move-group > button')!.disabled = true;
    expect(adapter.status().inputEnabled).toBe(false);
    expect(adapter.read().canHold).toBeNull();
    stage.parentElement!.querySelector('.tetris-status')!.textContent = '일시정지';
    expect(adapter.read()).toMatchObject({ paused: true, canHold: null });
  });

  it('recognizes compact HOLD and reads incoming above the capped meter value', () => {
    const stage = fixture();
    stage.querySelector('.tetris-hold-card')!.innerHTML = preview('L', true);
    stage.querySelector('.tetris-metrics')!.insertAdjacentHTML('beforeend', '<div class="tetris-garbage-gauge"><div class="tetris-garbage-gauge-track" role="meter" aria-valuenow="8" aria-label="받은 공격 17줄"></div></div>');
    expect(new DomAdapter().read()).toMatchObject({ hold: 'L', incoming: 17 });
  });

  it.each([
    { count: 0, hidden: false },
    { count: 1, hidden: false },
    { count: 2, hidden: false },
    { count: 1, hidden: true },
    { count: 2, hidden: true },
  ])('reads only the local incoming amount with $count mobile opponent gauges (hidden=$hidden)', ({ count, hidden }) => {
    const stage = fixture();
    stage.querySelector('.tetris-metrics')!.insertAdjacentHTML('beforeend', garbageGauge('17'));
    stage.querySelector('.tetris-grid')!.children[199]!.classList.add('is-filled');
    appendMobileOpponents(stage, count, hidden);
    const adapter = new DomAdapter();
    expect(adapter.read()).toMatchObject({
      incoming: 17, lines: 2, canHold: true, hold: null,
      board: [...Array<number>(19).fill(0), 512], next: ['J', 'O', 'S', 'Z', 'I'],
      paused: false, ended: false,
    });
    expect(adapter.status()).toMatchObject({ playing: true, inputEnabled: true });
  });

  it.each([false, true])('ignores opponent gauge updates in the local fingerprint (hidden=%s)', hidden => {
    const stage = fixture();
    stage.querySelector('.tetris-metrics')!.insertAdjacentHTML('beforeend', garbageGauge('17'));
    const slot = appendMobileOpponents(stage, 2, hidden);
    const adapter = new DomAdapter();
    const first = adapter.read();
    slot.querySelectorAll('.tetris-garbage-gauge-track').forEach((gauge, index) => {
      gauge.setAttribute('aria-label', `받은 공격 ${30 + index}줄`);
      gauge.setAttribute('aria-valuenow', '8');
    });
    slot.querySelector('strong')!.textContent = '200';
    const second = adapter.read();
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.incoming).toBe(17);
    expect(second.lines).toBe(2);
    expect(second.observation).toBeGreaterThan(first.observation);
    stage.querySelector(':scope > .tetris-left-panel > .tetris-metrics > .tetris-garbage-gauge > .tetris-garbage-gauge-track')!.setAttribute('aria-label', '받은 공격 18줄');
    expect(adapter.read().fingerprint).not.toBe(first.fingerprint);
  });

  it.each([
    { count: 1, hidden: false }, { count: 2, hidden: false },
    { count: 1, hidden: true }, { count: 2, hidden: true },
  ])('keeps incoming unknown when only $count nested opponent gauges exist (hidden=$hidden)', ({ count, hidden }) => {
    const stage = fixture();
    appendMobileOpponents(stage, count, hidden);
    expect(new DomAdapter().read().incoming).toBeNull();
  });

  it.each(['', '-1', '1.5', '9007199254740992'])('rejects an unreadable local amount %j even when an opponent has a valid meter', amount => {
    const stage = fixture();
    stage.querySelector('.tetris-metrics')!.insertAdjacentHTML('beforeend', garbageGauge(amount));
    appendMobileOpponents(stage, 1);
    expect(failure(new DomAdapter())).toMatchObject({ kind: 'invalid', message: 'Incoming garbage label is unreadable' });
  });

  it.each(['17', '4'])('rejects duplicate direct local gauges with amounts 17 and %s', secondAmount => {
    const stage = fixture();
    stage.querySelector('.tetris-metrics')!.insertAdjacentHTML('beforeend', garbageGauge('17') + garbageGauge(secondAmount));
    appendMobileOpponents(stage, 2);
    expect(failure(new DomAdapter())).toMatchObject({ kind: 'invalid', message: 'Multiple incoming garbage gauges in the selected board' });
  });

  it.each([false, true])('ignores a compact opponent gauge directly below metrics (local meter present=%s)', hasLocalMeter => {
    const stage = fixture();
    const metrics = stage.querySelector('.tetris-metrics')!;
    if (hasLocalMeter) metrics.insertAdjacentHTML('beforeend', garbageGauge('17'));
    metrics.insertAdjacentHTML('beforeend', garbageGauge('4').replace('class="tetris-garbage-gauge"', 'class="tetris-garbage-gauge is-compact"'));
    expect(new DomAdapter().read().incoming).toBe(hasLocalMeter ? 17 : null);
  });

  it('never converts a malformed preview or missing HOLD into a successful empty value', () => {
    const stage = fixture();
    const adapter = new DomAdapter();
    const hold = stage.querySelector('.tetris-hold-card')!;
    hold.innerHTML = '';
    expect(failure(adapter).kind).toBe('invalid');
    hold.innerHTML = preview('L', true);
    hold.querySelector<HTMLElement>('.is-filled')!.style.setProperty('--cell-color', '#abcdef');
    expect(failure(adapter).message).toContain('unrecognized');
    hold.innerHTML = '<strong>EMPTY</strong>';
    stage.querySelector('.tetris-queue-preview')!.remove();
    expect(failure(adapter).kind).toBe('transition');
  });

  it('rejects color/shape disagreement and unknown current piece types', () => {
    const stage = fixture();
    const adapter = new DomAdapter();
    stage.querySelectorAll<HTMLElement>('.tetris-queue-preview:first-child > .is-filled').forEach(cell => cell.style.setProperty('--cell-color', COLORS.I));
    expect(failure(adapter).message).toContain('disagree');
    stage.querySelector('.tetris-piece-layer:not(.is-ghost)')!.setAttribute('data-piece-type', 'garbage');
    expect(failure(adapter).message).toContain('unknown type');
  });

  it('separates absent spawn cells and overlap from malformed fixed boards', () => {
    const stage = fixture();
    const adapter = new DomAdapter();
    stage.querySelector('.tetris-grid')!.children[14]!.classList.add('is-filled');
    expect(failure(adapter).kind).toBe('transition');
    stage.querySelector('.tetris-grid')!.children[14]!.classList.remove('is-filled');
    stage.querySelector('.tetris-piece-layer:not(.is-ghost)')!.remove();
    expect(failure(adapter).kind).toBe('transition');
    stage.querySelector('.tetris-grid')!.lastElementChild!.remove();
    expect(failure(adapter).kind).toBe('invalid');
  });

  it('rejects fractional geometry instead of silently rounding an in-flight animation', () => {
    const stage = fixture();
    const cell = stage.querySelector('.tetris-piece-layer:not(.is-ghost) > .tetris-layer-cell')!;
    const rect = cell.getBoundingClientRect();
    setRect(cell, rect.left + 7.5, rect.top, 30, 30);
    expect(failure(new DomAdapter()).kind).toBe('transition');
  });

  it.each(['playing', 'paused', 'ended'] as const)('retains %s status and visible-layer counts when the current piece is missing', phase => {
    const stage = fixture();
    stage.querySelector('.tetris-piece-layer:not(.is-ghost)')!.remove();
    stage.parentElement!.querySelector('.tetris-status')!.textContent =
      phase === 'paused' ? '일시정지' : phase === 'ended' ? '게임 종료' : '속도 LV.1';
    expect(new DomAdapter().report()).toMatchObject({
      scriptVersion: SCRIPT_VERSION, candidates: 1, kind: 'transition',
      error: 'Current piece is absent during spawn, lock, or game end',
      status: { playing: phase === 'playing', paused: phase === 'paused', ended: phase === 'ended', inputEnabled: phase === 'playing' },
      render: { currentLayers: 0, ghostLayers: 1, fixedCells: 200 },
    });
  });

  it('uses a local observation counter, stable evidence fingerprint, and local DOM identity', () => {
    const stage = fixture();
    const adapter = new DomAdapter();
    const first = adapter.read();
    const second = adapter.read();
    expect(second.observation).toBe(first.observation + 1);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.session).toBe(first.session);
    expect(second.session).toMatch(/^local-dom-session-/);
    stage.querySelector('.tetris-grid')!.children[199]!.classList.add('is-filled');
    expect(adapter.read().fingerprint).not.toBe(first.fingerprint);
  });

  it('changes local session for SPA route changes and observed restarts, while pause preserves it', () => {
    const stage = fixture();
    const adapter = new DomAdapter();
    const status = stage.parentElement!.querySelector('.tetris-status')!;
    const first = adapter.read();
    status.textContent = '일시정지';
    expect(adapter.read().session).toBe(first.session);
    status.textContent = '속도 LV.1';
    expect(adapter.read().session).toBe(first.session);
    status.textContent = '게임 종료';
    adapter.status();
    status.textContent = '속도 LV.1';
    const restarted = adapter.read();
    expect(restarted.session).not.toBe(first.session);
    const previousUrl = window.location.href;
    try {
      window.history.replaceState(null, '', '/room-new?private-invite=secret-value');
      const moved = adapter.read();
      expect(moved.session).not.toBe(restarted.session);
      expect(JSON.stringify(adapter.report())).not.toMatch(/private-invite|secret-value|room-new/);
    } finally {
      window.history.replaceState(null, '', previousUrl);
    }
    status.textContent = '대기 중';
    expect(failure(adapter).kind).toBe('inactive');
    status.textContent = '속도 LV.1';
    expect(adapter.read().session).not.toBe(restarted.session);
  });

  it('reports waiting/game over and protects missing status instead of presuming active play', () => {
    const stage = fixture();
    const status = stage.parentElement!.querySelector('.tetris-status')!;
    const adapter = new DomAdapter();
    status.textContent = '대기 중';
    expect(failure(adapter).kind).toBe('inactive');
    status.textContent = '게임 종료';
    expect(adapter.status()).toMatchObject({ ended: true, inputEnabled: false });
    expect(adapter.read().ended).toBe(true);
    status.remove();
    expect(failure(adapter).kind).toBe('invalid');
  });

  it('refuses duplicate or nonintegral cell coordinates in the exported pose matcher', () => {
    expect(posesForCells('I', [[1, 0], [1, 0], [2, 0], [3, 0]])).toEqual([]);
    expect(posesForCells('I', [[0.2, 0], [1, 0], [2, 0], [3, 0]])).toEqual([]);
  });
});
