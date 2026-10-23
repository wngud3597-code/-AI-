import type { ActivePiece, RuntimeAction, RuntimePlan, RuntimeSnapshot } from './model';
import { applyRuntimeAction, runtimeCells, spawnPiece } from './engine';
import { detectGarbageRise, type GarbageRise } from './board-transition';
import { DomReadError } from './dom';
import { SCRIPT_VERSION } from './version';
import { rebaseGravityPlan } from './plan-validation';

export type ControlState = 'STOPPED' | 'OBSERVING' | 'PLANNING' | 'EXECUTING' | 'AWAITING_RESULT' | 'VALIDATING' | 'PAUSED' | 'RESYNC' | 'ERROR';
export interface Reader {
  read(): RuntimeSnapshot;
  status(): { inputEnabled: boolean; paused: boolean; ended: boolean; spectating: boolean };
}
export interface Planner { plan(snapshot: RuntimeSnapshot, generation: number): Promise<RuntimePlan>; cancel(): void }
export interface KeyboardPort { tap(action: RuntimeAction, token: Cancellation, onSent?: () => void): Promise<void>; release(): void }
export interface ControlUpdate { state: ControlState; message: string; locks: number; resyncs: number; plan: RuntimePlan | null }
export interface RecoveryEvidence {
  reason: 'garbage-rise' | 'gravity-advance';
  phase: 'before-input' | 'movement' | 'after-lock' | 'after-hold';
  rise: GarbageRise | null;
  reference: 'before' | 'predicted-lock';
  completedAction: 'HARD_DROP' | 'HOLD' | null;
}
class ReplanRequired extends Error {
  constructor(readonly snapshot: RuntimeSnapshot, readonly recovery: RecoveryEvidence) {
    super(recovery.reason === 'garbage-rise' ? `공격 줄 형태의 보드 ${recovery.rise!.rows}줄 상승을 관측해 경로를 다시 계획합니다.`
      : '자연 낙하로 경로가 달라져 현재 조각에서 다시 계획합니다.');
  }
}
export class Cancelled extends Error { constructor() { super('Stopped'); } }
export class Cancellation {
  cancelled = false;
  private sleepers = new Map<ReturnType<typeof setTimeout>, () => void>();
  check(): void { if (this.cancelled) throw new Cancelled(); }
  cancel(): void {
    this.cancelled = true;
    for (const [timer, reject] of this.sleepers) { clearTimeout(timer); reject(); }
    this.sleepers.clear();
  }
  async wait(ms: number): Promise<void> {
    this.check();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.sleepers.delete(timer); resolve(); }, ms);
      this.sleepers.set(timer, () => reject(new Cancelled()));
    });
    this.check();
  }
}

const keys: Record<RuntimeAction, readonly [string, string, number]> = {
  LEFT: ['ArrowLeft', 'ArrowLeft', 37], RIGHT: ['ArrowRight', 'ArrowRight', 39],
  SOFT_DROP: ['ArrowDown', 'ArrowDown', 40], ROTATE_CW: ['x', 'KeyX', 88],
  ROTATE_CCW: ['z', 'KeyZ', 90], HARD_DROP: [' ', 'Space', 32], HOLD: ['c', 'KeyC', 67],
};
export function isEditable(element: Element | null): boolean {
  return Boolean(element?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]'));
}
/** The public client registers its game input on window. Dispatch exactly once. */
export class WindowKeyboard implements KeyboardPort {
  private pressed = new Set<RuntimeAction>();
  constructor(private readonly target: Window, private readonly guard: () => void, private readonly intervalMs = 45) {}
  async tap(action: RuntimeAction, token: Cancellation, onSent?: () => void): Promise<void> {
    token.check(); this.guard(); token.check();
    this.pressed.add(action);
    this.dispatch('keydown', action);
    onSent?.();
    try { await token.wait(8); }
    finally { if (this.pressed.delete(action)) this.dispatch('keyup', action); }
    await token.wait(Math.max(35, this.intervalMs - 8));
  }
  release(): void {
    for (const action of this.pressed) this.dispatch('keyup', action);
    this.pressed.clear();
  }
  private dispatch(type: 'keydown' | 'keyup', action: RuntimeAction): void {
    const [key, code, keyCode] = keys[action];
    this.target.dispatchEvent(new KeyboardEvent(type, { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, repeat: false }));
  }
}

export interface ActionEvidence { action: RuntimeAction; at: number }
export interface RuntimeRecord {
  schema: 2; type: 'placement' | 'hold' | 'failure' | 'shadow' | 'resync';
  scriptVersion?: string;
  ruleProfile: string; before: RuntimeSnapshot; plan: RuntimePlan;
  actions: ActionEvidence[]; after: RuntimeSnapshot | null;
  result: 'display-match' | 'hold-observed' | 'unknown' | 'cancelled' | 'shadow' | 'resynced';
  recovery?: RecoveryEvidence;
  validation: Record<string, 'match' | 'mismatch' | 'unknown'>;
  error: string | null; timings: { observationMs: number; searchMs: number; inputMs: number; confirmationMs: number };
}
export class Recorder {
  readonly records: RuntimeRecord[] = [];
  dropped = 0;
  add(record: RuntimeRecord): void {
    this.records.push(structuredClone(record));
    if (this.records.length > 1000) { this.records.shift(); this.dropped++; }
  }
  jsonl(): string { return this.records.map(r => JSON.stringify(r)).join('\n'); }
}
const sameBoard = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const sameQueue = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const cellKey = (p: ActivePiece) => runtimeCells(p).map(([x, y]) => `${x},${y}`).sort().join(';');
const samePiece = (a: ActivePiece, b: ActivePiece) => a.type === b.type && cellKey(a) === cellKey(b);
function sameContext(a: RuntimeSnapshot, b: RuntimeSnapshot): boolean {
  return samePieceContext(a, b) && sameBoard(a.board, b.board);
}
function samePieceContext(a: RuntimeSnapshot, b: RuntimeSnapshot): boolean {
  return a.session === b.session && a.player === b.player && a.current.type === b.current.type
    && a.hold === b.hold && sameQueue(a.next, b.next) && a.lines === b.lines && a.canHold === b.canHold;
}
function sameShapeAtOrBelow(expected: ActivePiece, actual: ActivePiece): boolean {
  return actual.y >= expected.y && samePiece({ ...expected, y: actual.y }, actual);
}

export class Controller {
  private generation = 0;
  private token: Cancellation | null = null;
  private busy = false;
  private locks = 0;
  private resyncs = 0;
  state: ControlState = 'STOPPED';
  private lastPlan: RuntimePlan | null = null;
  private orientation: RuntimeSnapshot | null = null;
  constructor(
    private readonly reader: Reader, private readonly planner: Planner, private readonly keyboard: KeyboardPort,
    readonly recorder = new Recorder(), private readonly onUpdate: (update: ControlUpdate) => void = () => {},
    private readonly now = () => performance.now(),
  ) {}
  stop(message = '사용자가 중지했습니다.'): void {
    this.generation++; this.token?.cancel(); this.planner.cancel(); this.keyboard.release(); this.orientation = null;
    this.update('STOPPED', message);
  }
  async start(mode: 'single' | 'continuous' | 'shadow'): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const generation = ++this.generation;
    const token = new Cancellation(); this.token = token;
    let runSession: string | null = null; let runPlayer: string | null = null;
    try {
      do {
        token.check(); this.guard();
        this.update('OBSERVING', '자기 보드를 관측합니다.');
        const observed = this.now(); const ready = this.readReadySnapshot(token);
        let before = ready instanceof Promise ? await ready : ready;
        token.check(); this.guard();
        const observationMs = this.now() - observed;
        if (runSession !== null && (before.session !== runSession || before.player !== runPlayer)) {
          throw new Error('방·게임·플레이어가 변경되었습니다. 상태 점검 후 직접 다시 시작하세요.');
        }
        runSession = before.session; runPlayer = before.player;
        this.update('PLANNING', 'Worker에서 합법 배치를 탐색합니다.');
        let plan = await this.planner.plan(before, generation);
        token.check(); this.guard(); this.lastPlan = plan;
        const refreshed = this.readReadySnapshot(token);
        const fresh = refreshed instanceof Promise ? await refreshed : refreshed;
        token.check(); this.guard();
        if (plan.session !== before.session || plan.player !== before.player || plan.fingerprint !== before.fingerprint
          || fresh.fingerprint !== before.fingerprint || !sameContext(before, fresh) || !samePiece(before.current, fresh.current)) {
          const rebased = rebaseGravityPlan(before, fresh, plan);
          if (rebased) {
            before = fresh;
            plan = { ...rebased, assumptions: [...rebased.assumptions, 'Path revalidated from observed gravity advance; terminal placement unchanged'] };
            this.lastPlan = plan;
          } else {
            this.update('RESYNC', '탐색 중 상태가 바뀌어 새로 관측합니다.');
            if (mode === 'continuous') { await token.wait(20); continue; }
            throw new Error('탐색 중 상태가 바뀌었습니다. 상태 점검 후 다시 한 수를 실행하세요.');
          }
        }
        if (mode === 'shadow') {
          this.recorder.add(this.record(before, plan, [], null, 'shadow', 'shadow', null, observationMs, 0, 0));
          this.update('STOPPED', `관측·탐색 완료: 깊이 ${plan.depth}, ${plan.elapsedMs.toFixed(1)}ms. 게임 입력 0회.`);
          return;
        }
        try { await this.execute(before, plan, token, observationMs); }
        catch (error) {
          if (!(error instanceof ReplanRequired)) throw error;
          token.check(); this.guard(); this.planner.cancel(); this.keyboard.release(); this.orientation = null;
          this.resyncs++;
          if (mode !== 'continuous') {
            this.update('STOPPED', `${error.message} 한 수 실행을 마쳤습니다. 새 관측에서 다시 실행할 수 있습니다.`);
            return;
          }
          this.update('RESYNC', error.message);
          await this.settleForReplan(error.snapshot, token);
          token.check();
          continue;
        }
        token.check();
        if (mode !== 'continuous') { this.update('STOPPED', '한 수 검증 완료. DOM 표시 결과와 일치했습니다.'); return; }
        await token.wait(250);
      } while (true);
    } catch (error) {
      if (!(error instanceof Cancelled) && !token.cancelled) this.update(this.state === 'PAUSED' ? 'PAUSED' : 'ERROR', error instanceof Error ? error.message : String(error));
    } finally {
      token.cancel(); this.planner.cancel(); this.keyboard.release();
      this.busy = false;
      if (this.token === token) this.token = null;
    }
  }
  private guard(): void {
    const state = this.reader.status();
    if (state.spectating) throw new Error('관전 중에는 제어할 수 없습니다.');
    if (state.ended) throw new Error('게임이 종료되었습니다.');
    if (state.paused) { this.update('PAUSED', '게임 일시정지'); throw new Error('일시정지를 해제하고 다시 시작하세요.'); }
    if (!state.inputEnabled) throw new Error('게임 입력이 활성화되어 있지 않습니다.');
  }
  private async execute(before: RuntimeSnapshot, plan: RuntimePlan, token: Cancellation, observationMs: number): Promise<void> {
    const actions: ActionEvidence[] = [];
    let last = before; let inputMs = 0; let confirmationStarted = this.now(); let nonIdempotentSent = false;
    try {
      this.update('EXECUTING', plan.kind === 'hold' ? 'HOLD 한 번 전송 후 새 상태를 확인합니다.' : '입력과 조각 이동을 확인합니다.');
      if (plan.kind === 'hold') {
        if (before.canHold !== true) throw new Error('HOLD 가능 여부가 확인되지 않았습니다.');
        token.check(); this.guard();
        const ready = this.readReadySnapshot(token);
        last = ready instanceof Promise ? await ready : ready;
        token.check(); this.guard();
        if (!sameContext(before, last) || !samePiece(before.current, last.current)) {
          this.checkExternalRise(before, last, 'before-input');
          if (sameContext(before, last) && sameShapeAtOrBelow(before.current, last.current)
            && last.current.y > before.current.y) this.replanForGravity(last, 'before-input');
          throw new Error('HOLD 전 상태가 변경되었습니다.');
        }
        const t = this.now();
        await this.keyboard.tap('HOLD', token, () => { nonIdempotentSent = true; actions.push({ action: 'HOLD', at: this.now() }); }); token.check(); inputMs += this.now() - t;
        this.update('AWAITING_RESULT', 'HOLD 결과를 확인합니다. 재전송하지 않습니다.');
        confirmationStarted = this.now();
        last = await this.waitUntil(token, snapshot => {
          if (snapshot.session !== before.session || snapshot.player !== before.player) throw new Error('HOLD 확인 중 방·플레이어가 바뀌었습니다.');
          const expectedType = before.hold ?? before.next[0];
          const queueOK = before.hold !== null ? sameQueue(snapshot.next, before.next)
            : sameQueue(snapshot.next.slice(0, 4), before.next.slice(1, 5));
          const holdOK = snapshot.hold === before.current.type && snapshot.current.type === expectedType && snapshot.canHold === false && queueOK
            && snapshot.lines === before.lines;
          if (!sameBoard(snapshot.board, before.board)) {
            // An observed HOLD and an observed rise are independent facts. A
            // board rise by itself never acknowledges the non-idempotent HOLD.
            if (holdOK && detectGarbageRise(before.board, snapshot.board)) return true;
            if (!detectGarbageRise(before.board, snapshot.board)) throw new Error('HOLD 중 설명되지 않는 보드 변화가 발생했습니다.');
            return false;
          }
          return holdOK;
        }, 1000, 100);
        const holdRise = detectGarbageRise(before.board, last.board);
        if (holdRise) throw new ReplanRequired(last, { reason: 'garbage-rise', phase: 'after-hold', rise: holdRise, reference: 'before', completedAction: 'HOLD' });
        this.recorder.add(this.record(before, plan, actions, last, 'hold', 'hold-observed', null, observationMs, inputMs, this.now() - confirmationStarted));
        this.rememberSpawn(last);
        this.update('VALIDATING', 'HOLD 전이를 확인했습니다. 다음 계획은 새 관측에서 만듭니다.');
        return;
      }
      if (plan.path.length === 0 || plan.path.at(-1) !== 'HARD_DROP' || plan.path.slice(0, -1).includes('HARD_DROP')) throw new Error('하드드롭 경로 계약 위반');
      for (const action of plan.path) {
        token.check(); this.guard();
        const ready = this.readReadySnapshot(token);
        const fresh = ready instanceof Promise ? await ready : ready;
        token.check(); this.guard();
        if (!sameContext(before, fresh)) {
          this.checkExternalRise(before, fresh, 'before-input');
          throw new Error('보드·큐·조각이 바뀌어 오래된 경로를 중단했습니다.');
        }
        if (!sameShapeAtOrBelow(last.current, fresh.current)) throw new Error('조각 위치가 바뀌어 오래된 경로를 중단했습니다.');
        if (fresh.current.y > last.current.y) this.replanForGravity(fresh, 'before-input');
        const expected = applyRuntimeAction(fresh.board, fresh.current, action);
        if (!expected) throw new Error(`실행 전 ${action} 충돌을 발견했습니다.`);
        if (action === 'HARD_DROP') {
          // Recheck the landing from the actual pose immediately before the irreversible input.
          if (!samePiece(expected, plan.target)) throw new Error('현재 착지가 계획한 배치와 달라 하드드롭을 취소했습니다.');
        }
        const t = this.now();
        await this.keyboard.tap(action, token, () => { if (action === 'HARD_DROP') nonIdempotentSent = true; actions.push({ action, at: this.now() }); }); token.check(); inputMs += this.now() - t;
        if (action !== 'HARD_DROP') {
          last = await this.waitUntil(token, s => {
            if (!sameContext(before, s)) {
              this.checkExternalRise(before, s, 'movement');
              throw new Error('이동 확인 중 보드·큐가 변경되었습니다.');
            }
            return sameShapeAtOrBelow(expected, s.current);
          }, 600);
          if (last.current.y > expected.y) this.replanForGravity(last, 'movement');
          // An acknowledged input can carry orientation forward even when the
          // displayed symmetric shape alone cannot distinguish rotations.
          this.orientation = this.withOrientation(last, { ...expected, y: last.current.y });
        }
      }
      this.update('AWAITING_RESULT', '고정 보드·줄·공개 큐 결과를 확인합니다.');
      confirmationStarted = this.now();
      last = await this.waitUntil(token, s => {
        if (s.session !== before.session || s.player !== before.player) throw new Error('고정 결과 확인 중 방·플레이어가 바뀌었습니다.');
        const nextOK = s.current.type === before.next[0] && sameQueue(s.next.slice(0, 4), before.next.slice(1, 5));
        const linesOK = before.lines === null || s.lines === null || s.lines - before.lines === plan.cleared;
        const transitionEvidence = !sameBoard(s.board, before.board) || (s.lines !== null && before.lines !== null && s.lines > before.lines)
          || !sameQueue(s.next, before.next);
        const lockOK = s.hold === before.hold && s.canHold === true && nextOK && linesOK && transitionEvidence;
        return lockOK && (sameBoard(s.board, plan.expectedBoard) || detectGarbageRise(plan.expectedBoard, s.board) !== null);
      }, 1200, 100);
      const lockRise = detectGarbageRise(plan.expectedBoard, last.board);
      if (lockRise) throw new ReplanRequired(last, { reason: 'garbage-rise', phase: 'after-lock', rise: lockRise, reference: 'predicted-lock', completedAction: 'HARD_DROP' });
      this.update('VALIDATING', 'DOM 표시 전이를 비교합니다. 서버 확정 여부는 알 수 없습니다.');
      this.locks++;
      this.recorder.add(this.record(before, plan, actions, last, 'placement', 'display-match', null, observationMs, inputMs, this.now() - confirmationStarted));
      this.rememberSpawn(last);
    } catch (error) {
      this.orientation = null;
      if (error instanceof ReplanRequired && !token.cancelled) {
        const entry = this.record(before, plan, actions, error.snapshot, 'resync', 'resynced', null, observationMs, inputMs, this.now() - confirmationStarted);
        entry.recovery = error.recovery;
        // External rows are observed after the action. Do not score their
        // existence as a deterministic or authoritative prediction match.
        entry.validation.observedRise = error.recovery.rise ? 'match' : 'unknown';
        if (error.recovery.completedAction !== null) {
          entry.validation.hold = 'match'; entry.validation.queue = 'match';
          if (before.lines !== null && error.snapshot.lines !== null) entry.validation.clear = 'match';
        }
        this.recorder.add(entry);
        throw error;
      }
      try { last = this.reader.read(); } catch { /* Retain last valid copied snapshot. */ }
      const message = error instanceof Error ? error.message : String(error);
      this.recorder.add(this.record(before, plan, actions, last, 'failure', token.cancelled ? 'cancelled' : 'unknown',
        `${message}${nonIdempotentSent ? ' 비멱등 입력은 재전송하지 않았습니다.' : ''}`, observationMs, inputMs, this.now() - confirmationStarted));
      throw error;
    }
  }
  private checkExternalRise(before: RuntimeSnapshot, after: RuntimeSnapshot, phase: 'before-input' | 'movement'): void {
    if (!samePieceContext(before, after)) return;
    const rise = detectGarbageRise(before.board, after.board);
    if (rise) throw new ReplanRequired(after, { reason: 'garbage-rise', phase, rise, reference: 'before', completedAction: null });
  }
  private replanForGravity(snapshot: RuntimeSnapshot, phase: 'before-input' | 'movement'): never {
    throw new ReplanRequired(snapshot, { reason: 'gravity-advance', phase, rise: null, reference: 'before', completedAction: null });
  }
  private async settleForReplan(anchor: RuntimeSnapshot, token: Cancellation): Promise<void> {
    let stableSince: number | null = null; let stableBoard = '';
    await this.waitUntil(token, snapshot => {
      if (!samePieceContext(anchor, snapshot)) throw new Error('재계획 확인 중 방·플레이어·조각 전이가 달라져 중지했습니다.');
      if (!sameBoard(anchor.board, snapshot.board) && !detectGarbageRise(anchor.board, snapshot.board)) throw new Error('재계획 확인 중 설명되지 않는 보드 변화가 발생했습니다.');
      const key = snapshot.board.join(',');
      if (stableSince === null || key !== stableBoard) { stableSince = this.now(); stableBoard = key; }
      return this.now() - stableSince >= 80;
    }, 800);
  }
  private async waitUntil(token: Cancellation, accept: (snapshot: RuntimeSnapshot) => boolean, timeoutMs = 1000, stableMs = 0): Promise<RuntimeSnapshot> {
    const start = this.now(); let stableSince: number | null = null; let stableKey = '';
    while (this.now() - start < timeoutMs) {
      token.check(); this.guard();
      let snapshot: RuntimeSnapshot | null = null;
      try { snapshot = this.readSnapshot(); }
      catch { /* A transient spawn/clear render is not a successful acknowledgement. */ }
      if (snapshot && accept(snapshot)) {
        const key = `${snapshot.board.join(',')}/${snapshot.next.join('')}/${snapshot.hold}/${snapshot.lines}`;
        if (stableSince === null || key !== stableKey) { stableSince = this.now(); stableKey = key; }
        if (this.now() - stableSince >= stableMs) return snapshot;
      } else stableSince = null;
      await token.wait(12);
    }
    throw new Error('처리 결과를 확인하지 못해 중지했습니다. 상태 점검·기록을 확인하세요.');
  }
  private withOrientation(snapshot: RuntimeSnapshot, pose: ActivePiece): RuntimeSnapshot {
    const current = Object.freeze(pose);
    return Object.freeze({ ...snapshot, current, rotationCandidates: Object.freeze([current]),
      fingerprint: `${snapshot.fingerprint.split(':r')[0]}:r${pose.rotation}` });
  }
  /** Keep a valid synchronous observation adjacent to its checks and input. */
  private readReadySnapshot(token: Cancellation): RuntimeSnapshot | Promise<RuntimeSnapshot> {
    token.check(); this.guard();
    try { return this.readSnapshot(); }
    catch (error) {
      if (!(error instanceof DomReadError) || error.kind !== 'transition') throw error;
      return this.retrySnapshot(token, error);
    }
  }
  private async retrySnapshot(token: Cancellation, initial: DomReadError): Promise<RuntimeSnapshot> {
    const started = this.now(); let last = initial;
    this.update(this.state, '조각 생성·고정 표시가 끝나기를 기다립니다.');
    while (this.now() - started < 1200) {
      await token.wait(24);
      token.check(); this.guard();
      try { return this.readSnapshot(); }
      catch (error) {
        if (!(error instanceof DomReadError) || error.kind !== 'transition') throw error;
        last = error;
      }
    }
    throw new DomReadError('transition', `1.2초 동안 현재 조각을 읽지 못했습니다. F9 상태 점검에서 게임 상태를 확인하세요. (${last.message})`);
  }
  private readSnapshot(): RuntimeSnapshot {
    const fresh = this.reader.read();
    if (this.orientation && sameContext(this.orientation, fresh) && sameShapeAtOrBelow(this.orientation.current, fresh.current)) {
      return this.withOrientation(fresh, { ...fresh.current, rotation: this.orientation.current.rotation });
    }
    this.orientation = null;
    return fresh;
  }
  private rememberSpawn(snapshot: RuntimeSnapshot): void {
    const spawn = spawnPiece(snapshot.board, snapshot.current.type);
    if (spawn && sameShapeAtOrBelow(spawn, snapshot.current)) this.orientation = this.withOrientation(snapshot, { ...snapshot.current, rotation: 0 });
    else this.orientation = null;
  }
  private record(before: RuntimeSnapshot, plan: RuntimePlan, actions: ActionEvidence[], after: RuntimeSnapshot | null,
    type: RuntimeRecord['type'], result: RuntimeRecord['result'], error: string | null,
    observationMs: number, inputMs: number, confirmationMs: number): RuntimeRecord {
    const matched = result === 'display-match'; const held = result === 'hold-observed';
    return { schema: 2, scriptVersion: SCRIPT_VERSION, type, ruleProfile: plan.ruleProfile, before, plan, actions, after, result, error,
      validation: { board: matched || held ? 'match' : 'unknown', clear: matched && before.lines !== null && after?.lines !== null ? 'match' : 'unknown',
        hold: matched || held ? 'match' : 'unknown', queue: matched || held ? 'match' : 'unknown',
        spin: 'unknown', attack: 'unknown', cancel: 'unknown', insertion: 'unknown', authoritative: 'unknown' },
      timings: { observationMs, searchMs: plan.elapsedMs, inputMs, confirmationMs } };
  }
  private update(state: ControlState, message: string): void {
    this.state = state; this.onUpdate({ state, message, locks: this.locks, resyncs: this.resyncs, plan: this.lastPlan });
  }
}
