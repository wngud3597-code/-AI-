import type { ActivePiece, PieceType, RuntimeSnapshot } from './model';
import { cellsFor, collides } from './engine';
import { SCRIPT_VERSION } from './version';

type Cell = readonly [number, number];
export type DomReadFailure = 'selection' | 'transition' | 'invalid' | 'spectator' | 'inactive';

export class DomReadError extends Error {
  constructor(readonly kind: DomReadFailure, message: string) {
    super(message);
    this.name = 'DomReadError';
  }
}

export interface DomGameStatus {
  readonly playing: boolean;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly spectating: boolean;
  /** The site's ordinary movement controls expose its public input eligibility gate. */
  readonly inputEnabled: boolean;
}

// Verified in public chunk 847.a5a05f14ceb3f87d.js, fetched 2026-10-23.
// These are --cell-color values, not guessed screenshots or computed gradients.
const COLOR_TYPES: Readonly<Record<string, PieceType>> = {
  '#22d3ee': 'I', '#facc15': 'O', '#a78bfa': 'T', '#84cc16': 'S',
  '#fb7185': 'Z', '#60a5fa': 'J', '#fb923c': 'L',
};
const TYPES: readonly PieceType[] = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];
const STAGE = 'main.tetris-root > section.tetris-stage';
const BOARD = ':scope > section.tetris-board-panel > .tetris-board-wrap > .tetris-playfield.tetris-board.has-spawn-area';
const LEFT = ':scope > .tetris-left-panel:not(.tetris-opponents)';
// With four or five opponents, metrics also contains nested mobile opponent
// cards. Their compact gauges use the same role/label even when CSS hides them.
const OWN_INCOMING = `${LEFT} > .tetris-metrics > .tetris-garbage-gauge:not(.is-compact) > .tetris-garbage-gauge-track[role="meter"]`;

function fail(kind: DomReadFailure, message: string): never {
  throw new DomReadError(kind, message);
}

function one(parent: ParentNode, selector: string, description: string): HTMLElement {
  const matches = parent.querySelectorAll<HTMLElement>(selector);
  if (matches.length !== 1) fail('invalid', `${description}: expected one element, found ${matches.length}`);
  return matches[0]!;
}

function cellKey(cells: readonly Cell[]): string {
  return cells.map(([x, y]) => `${x},${y}`).sort().join(';');
}

/** Public cell geometry only. No rotation history or server generation is inferred. */
export function snapshotCells(piece: ActivePiece): readonly Cell[] {
  return Object.freeze(cellsFor(piece.type, piece.rotation).map(([x, y]) =>
    Object.freeze([piece.x + x, piece.y + y] as const)));
}

/** Keep indistinguishable I/S/Z/O rotations instead of inventing a rotation. */
export function posesForCells(type: PieceType, cells: readonly Cell[]): readonly ActivePiece[] {
  if (cells.length !== 4 || new Set(cells.map(([x, y]) => `${x},${y}`)).size !== 4 ||
      cells.some(([x, y]) => !Number.isInteger(x) || !Number.isInteger(y))) {
    return Object.freeze([]);
  }
  const minX = Math.min(...cells.map(([x]) => x));
  const minY = Math.min(...cells.map(([, y]) => y));
  const key = cellKey(cells);
  const poses: ActivePiece[] = [];
  for (const rotation of [0, 1, 2, 3] as const) {
    const shape = cellsFor(type, rotation);
    const x = minX - Math.min(...shape.map(([cx]) => cx));
    const y = minY - Math.min(...shape.map(([, cy]) => cy));
    const pose = Object.freeze({ type, x, y, rotation });
    if (cellKey(snapshotCells(pose)) === key) poses.push(pose);
  }
  return Object.freeze(poses);
}

function gridInteger(value: number, description: string): number {
  const rounded = Math.round(value);
  if (!Number.isFinite(value) || Math.abs(value - rounded) > 0.08) {
    fail('transition', `${description}: cell is between grid positions`);
  }
  return rounded;
}

function readActive(grid: HTMLElement, visible: HTMLElement): { poses: readonly ActivePiece[]; layer: HTMLElement } {
  const layers = visible.querySelectorAll<HTMLElement>(':scope > .tetris-piece-layer:not(.is-ghost)');
  if (layers.length === 0) fail('transition', 'Current piece is absent during spawn, lock, or game end');
  if (layers.length !== 1) fail('invalid', 'Multiple current piece layers in the selected board');
  const layer = layers[0]!;
  const typeValue = layer.getAttribute('data-piece-type');
  if (!TYPES.includes(typeValue as PieceType)) fail('invalid', 'Current piece has an unknown type');
  const cells = [...layer.querySelectorAll<HTMLElement>(':scope > .tetris-layer-cell')];
  if (cells.length !== 4 || layer.children.length !== 4) fail('invalid', `Current piece must have four cells, found ${cells.length}`);
  const rect = grid.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0) || !Number.isFinite(rect.left + rect.top + rect.width + rect.height)) {
    fail('inactive', 'Selected board has no measurable visible grid');
  }
  const unitX = rect.width / 10;
  const unitY = rect.height / 20;
  const absolute: Cell[] = cells.map(cell => {
    if (cell.classList.contains('is-ghost') || !cell.classList.contains('is-filled')) {
      fail('invalid', 'Current layer contains an unfilled or ghost cell');
    }
    const bounds = cell.getBoundingClientRect();
    if (Math.abs(bounds.width / unitX - 1) > 0.08 || Math.abs(bounds.height / unitY - 1) > 0.08) {
      fail('invalid', 'Current cell dimensions do not match the selected 10 by 20 grid');
    }
    const x = gridInteger((bounds.left - rect.left) / unitX, 'Current x');
    const y = gridInteger((bounds.top - rect.top) / unitY, 'Current y');
    if (x < 0 || x > 9 || y < -4 || y > 19) fail('invalid', 'Current cell lies outside the visible/spawn board');
    return [x, y] as const;
  });
  const poses = posesForCells(typeValue as PieceType, absolute);
  if (poses.length === 0) fail('invalid', 'Current four cells do not match the declared tetromino');
  return { poses, layer };
}

function previewType(preview: HTMLElement, compact: boolean): PieceType {
  const cells = [...preview.querySelectorAll<HTMLElement>(':scope > .tetris-cell')];
  const columns = compact ? Number(preview.style.getPropertyValue('--preview-cols').trim()) : 4;
  if (!Number.isInteger(columns) || columns < 1 || columns > 4 || cells.length === 0 ||
      cells.length > 16 || preview.children.length !== cells.length || cells.length % columns !== 0 || (!compact && cells.length !== 16)) {
    fail('invalid', 'HOLD/NEXT preview dimensions do not match the public DOM contract');
  }
  const filled: Cell[] = [];
  const types: PieceType[] = [];
  cells.forEach((cell, index) => {
    if (cell.classList.contains('is-ghost')) fail('invalid', 'Unexpected ghost in HOLD/NEXT preview');
    if (!cell.classList.contains('is-filled')) return;
    const type = COLOR_TYPES[cell.style.getPropertyValue('--cell-color').trim().toLowerCase()];
    if (!type) fail('invalid', 'HOLD/NEXT uses an unrecognized piece color');
    types.push(type);
    filled.push([index % columns, Math.floor(index / columns)]);
  });
  if (filled.length !== 4 || types.some(type => type !== types[0])) {
    fail('invalid', 'HOLD/NEXT must contain exactly four cells of one verified color');
  }
  const type = types[0]!;
  if (posesForCells(type, filled).length === 0) fail('invalid', 'HOLD/NEXT color and tetromino shape disagree');
  return type;
}

function optionalMetric(stage: HTMLElement, label: string): number | null {
  const matches = [...stage.querySelectorAll<HTMLElement>(`${LEFT} > .tetris-metrics > .tetris-card`)]
    .filter(card => card.querySelector(':scope > span')?.textContent?.trim() === label);
  if (matches.length === 0) return null;
  if (matches.length !== 1) fail('invalid', `Duplicate ${label} metric`);
  const text = matches[0]!.querySelector(':scope > strong')?.textContent?.trim() ?? '';
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) fail('invalid', `Invalid ${label} metric`);
  return Number(text);
}

function readIncoming(stage: HTMLElement): number | null {
  const gauges = stage.querySelectorAll<HTMLElement>(OWN_INCOMING);
  if (gauges.length === 0) return null; // Solo mode does not render this metric.
  if (gauges.length !== 1) fail('invalid', 'Multiple incoming garbage gauges in the selected board');
  // aria-valuenow is capped at 8; the label displays the full amount.
  const match = /^받은 공격 (\d+)줄$/.exec(gauges[0]!.getAttribute('aria-label') ?? '');
  if (!match || !Number.isSafeInteger(Number(match[1]))) fail('invalid', 'Incoming garbage label is unreadable');
  return Number(match[1]);
}

function fingerprint(parts: unknown): string {
  const text = JSON.stringify(parts);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `dom-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/** Reads one synchronous, immutable copy of the public, local-player DOM. */
export class DomAdapter {
  private selection: HTMLElement | null = null;
  private readonly identities = new WeakMap<HTMLElement, number>();
  private identity = 0;
  private observation = 0;
  private generation = 0;
  private scopeStage: HTMLElement | null = null;
  private scopeRoute = '';
  private previousPhase: 'playing' | 'paused' | 'ended' | 'waiting' | null = null;

  constructor(private readonly doc: Document = document) {}

  candidates(): HTMLElement[] {
    return [...this.doc.querySelectorAll<HTMLElement>(STAGE)].filter(stage => stage.querySelectorAll(BOARD).length === 1);
  }

  select(element: HTMLElement): void {
    const stage = element.matches(STAGE) ? element : element.closest<HTMLElement>(STAGE);
    if (!stage || !this.candidates().includes(stage)) fail('selection', 'Select the main player board with its HOLD and NEXT panels');
    this.selection = stage;
  }

  selected(): HTMLElement | null {
    if (this.selection) return this.selection.isConnected && this.candidates().includes(this.selection) ? this.selection : null;
    const candidates = this.candidates();
    return candidates.length === 1 ? candidates[0]! : null;
  }

  private requireStage(): HTMLElement {
    const stage = this.selected();
    if (!stage) {
      if (this.selection && !this.selection.isConnected) fail('selection', 'Selected board was replaced; select the current board again');
      fail('selection', this.candidates().length === 0 ? 'No supported main Tetris board is visible' : 'Multiple main boards exist; select your player board');
    }
    return stage;
  }

  status(): DomGameStatus {
    const stage = this.requireStage();
    const status = this.statusFor(stage);
    this.updateGeneration(stage, status);
    return status;
  }

  private routeIdentity(): string {
    const location = this.doc.defaultView?.location;
    // Retained only in memory for equality checks; never included in snapshots or diagnostics.
    return location ? location.pathname + location.search : '';
  }

  private updateGeneration(stage: HTMLElement, status: DomGameStatus): number {
    const route = this.routeIdentity();
    const phase = status.paused ? 'paused' : status.ended ? 'ended' : status.playing ? 'playing' : 'waiting';
    if (stage !== this.scopeStage || route !== this.scopeRoute ||
        (phase === 'playing' && (this.previousPhase === 'ended' || this.previousPhase === 'waiting'))) {
      this.generation += 1;
    }
    this.scopeStage = stage;
    this.scopeRoute = route;
    // Pause/resume preserves the current session. Waiting/game-over observations do not.
    if (phase !== 'paused') this.previousPhase = phase;
    return this.generation;
  }

  private statusFor(stage: HTMLElement): DomGameStatus {
    const root = stage.parentElement!;
    const status = one(root, ':scope > .tetris-header .tetris-status', 'Game status').textContent?.trim() ?? '';
    const spectating = status.endsWith(' 관전 중') || Boolean(root.querySelector(':scope > .tetris-header .tetris-spectator-switch'));
    const paused = status === '일시정지' || Boolean(stage.querySelector(':scope > .tetris-board-panel > .tetris-pause-overlay'));
    const life = [...stage.querySelectorAll<HTMLElement>(`${LEFT} > .tetris-metrics > .tetris-card`)]
      .find(card => card.querySelector(':scope > span')?.textContent?.trim() === '상태')?.querySelector(':scope > strong')?.textContent?.trim();
    const ended = status === '게임 종료' || life === '탈락' || Boolean(root.querySelector(':scope > .tetris-result'));
    const playing = /^속도 LV\.\d+$/.test(status) && !paused && !ended && !spectating;
    const movement = [...stage.querySelectorAll<HTMLButtonElement>(':scope > .tetris-mobile-controls .tetris-mobile-move-group > button')];
    const inputEnabled = playing && movement.length === 3 && movement.every(button => !button.disabled);
    return Object.freeze({ playing, paused, ended, spectating, inputEnabled });
  }

  read(): RuntimeSnapshot {
    const stage = this.requireStage();
    const status = this.statusFor(stage);
    const generation = this.updateGeneration(stage, status);
    const route = this.routeIdentity();
    if (status.spectating) fail('spectator', 'Spectator board is not a controllable local-player board');
    if (!status.playing && !status.paused && !status.ended) fail('inactive', 'Game is waiting or has an unrecognized status');
    const boardElement = one(stage, BOARD, 'Main board');
    const visible = one(boardElement, ':scope > .tetris-visible-board', 'Visible board');
    const grid = one(visible, ':scope > .tetris-grid', 'Fixed grid');
    const fixedCells = [...grid.querySelectorAll<HTMLElement>(':scope > .tetris-cell')];
    if (fixedCells.length !== 200 || grid.children.length !== 200) fail('invalid', `Fixed grid must have 200 cells, found ${fixedCells.length}`);
    const board = Array<number>(20).fill(0);
    fixedCells.forEach((cell, index) => {
      if (cell.classList.contains('is-ghost') || cell.classList.contains('tetris-layer-cell')) fail('invalid', 'Fixed board contains an active or ghost cell');
      if (cell.classList.contains('is-filled')) board[Math.floor(index / 10)]! |= 1 << (index % 10);
    });
    const active = readActive(grid, visible);
    if (active.poses.some(pose => collides(board, pose.type, pose.rotation, pose.x, pose.y))) {
      fail('transition', 'Current piece overlaps the fixed board during a lock or correction');
    }
    const holdButton = one(stage, `${LEFT} button.tetris-hold-card`, 'HOLD control') as HTMLButtonElement;
    const previews = holdButton.querySelectorAll<HTMLElement>(':scope > .tetris-hold-preview');
    let hold: PieceType | null;
    if (previews.length === 1) hold = previewType(previews[0]!, true);
    else if (previews.length === 0 && holdButton.children.length === 1 &&
        holdButton.querySelector(':scope > strong')?.textContent?.trim() === 'EMPTY') hold = null;
    else fail('invalid', 'HOLD cannot be read; an absent preview is not an empty HOLD');
    const nextList = one(stage, ':scope > .tetris-right-panel .tetris-next-list', 'NEXT list');
    const nextPreviews = [...nextList.querySelectorAll<HTMLElement>(':scope > .tetris-queue-preview')];
    if (nextPreviews.length < 5) fail('transition', `Visible NEXT queue is incomplete (${nextPreviews.length}/5)`);
    if (nextPreviews.length > 5) fail('invalid', 'NEXT has more than five visible previews');
    if (nextList.children.length !== nextPreviews.length) fail('invalid', 'NEXT list contains an unsupported preview element');
    const next = Object.freeze(nextPreviews.map(preview => previewType(preview, false)));
    const canHold = status.paused || status.ended || !status.inputEnabled ? null : !holdButton.disabled;
    const lines = optionalMetric(stage, '제거 줄');
    const incoming = readIncoming(stage);
    // DOM work is synchronous. Guard against disconnected/replaced nodes and a changed status.
    const after = this.statusFor(stage);
    if (!stage.isConnected || grid !== visible.querySelector(':scope > .tetris-grid') ||
        active.layer !== visible.querySelector(':scope > .tetris-piece-layer:not(.is-ghost)') ||
        route !== this.routeIdentity() || JSON.stringify(status) !== JSON.stringify(after)) fail('transition', 'DOM changed during observation');
    let id = this.identities.get(stage);
    if (id === undefined) { id = ++this.identity; this.identities.set(stage, id); }
    const current = active.poses[0]!;
    const session = `local-dom-session-${id}-${generation}`;
    const player = `local-dom-player-${id}`;
    return Object.freeze({
      board: Object.freeze(board), current, next, hold, canHold,
      fingerprint: fingerprint([session, player, board, snapshotCells(current), next, hold, canHold, status.paused, status.ended, lines, incoming]),
      session, player, observedAt: this.doc.defaultView?.performance.now() ?? performance.now(),
      observation: ++this.observation, paused: status.paused, ended: status.ended, lines, incoming,
      rotationCandidates: active.poses,
    });
  }

  /** F9-safe diagnostics: only public game fields; no URLs, nicknames, cookies, or framework objects. */
  report(): object {
    let status: DomGameStatus | null = null;
    const stage = this.selected();
    const visible = stage?.querySelector(`${BOARD} > .tetris-visible-board`);
    const render = {
      ownIncomingGauges: stage?.querySelectorAll(OWN_INCOMING).length ?? 0,
      currentLayers: visible?.querySelectorAll(':scope > .tetris-piece-layer:not(.is-ghost)').length ?? 0,
      ghostLayers: visible?.querySelectorAll(':scope > .tetris-piece-layer.is-ghost').length ?? 0,
      fixedCells: visible?.querySelectorAll(':scope > .tetris-grid > .tetris-cell').length ?? 0,
    };
    const base = { scriptVersion: SCRIPT_VERSION, adapter: 'public-dom', authority: 'display-only', candidates: this.candidates().length, render };
    try {
      status = this.status();
      return { ...base, status, snapshot: this.read(),
        unknown: ['serverRevision', 'pieceVersion', 'lockDeadline', 'rotationHistory', 'combo', 'backToBack', 'attack'] };
    } catch (error) {
      return { ...base, status,
        error: error instanceof Error ? error.message : String(error),
        kind: error instanceof DomReadError ? error.kind : 'invalid' };
    }
  }
}
