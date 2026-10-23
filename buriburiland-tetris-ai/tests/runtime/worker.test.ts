import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerPlanner } from '../../src/runtime/worker-client';
import { RUNTIME_RULE_PROFILE, type RuntimePlan, type RuntimeSnapshot } from '../../src/runtime/model';

const before: RuntimeSnapshot = {
  board: Array<number>(20).fill(0), current: { type: 'O', x: 3, y: 0, rotation: 0 },
  next: ['I', 'T', 'S', 'Z', 'J'], hold: null, canHold: true,
  fingerprint: 'worker-fixture', session: 'fixture-session', player: 'main',
  observation: 1, observedAt: 0, paused: false, ended: false, lines: 0, incoming: null,
};
function result(snapshot = before): RuntimePlan {
  return {
    kind: 'place', path: ['HARD_DROP'], target: { ...snapshot.current, y: 18 },
    expectedBoard: [...Array<number>(18).fill(0), 24, 24], cleared: 0,
    score: 0, nodes: 1, elapsedMs: 2, fingerprint: snapshot.fingerprint,
    session: snapshot.session, player: snapshot.player, observation: snapshot.observation,
    depth: 1, budgetExhausted: false, ruleProfile: RUNTIME_RULE_PROFILE.id, assumptions: [],
  };
}
interface Request { id: number; generation: number; snapshot: RuntimeSnapshot }
class MockWorker {
  static instances: MockWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  request!: Request;
  postMessage = vi.fn((request: Request) => { this.request = request; });
  terminate = vi.fn();
  constructor(readonly url: string, readonly options: WorkerOptions) { MockWorker.instances.push(this); }
  emit(overrides: Record<string, unknown> = {}): void {
    this.onmessage?.({ data: {
      id: this.request.id, generation: this.request.generation,
      fingerprint: this.request.snapshot.fingerprint, plan: result(this.request.snapshot), ...overrides,
    } } as MessageEvent);
  }
  fail(): void { this.onerror?.({ preventDefault: vi.fn() } as unknown as ErrorEvent); }
}
const created = () => {
  const worker = MockWorker.instances.at(-1);
  if (!worker) throw new Error('Expected a worker to be created');
  return worker;
};
let createURL: ReturnType<typeof vi.fn>;
let revokeURL: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  MockWorker.instances = [];
  createURL = vi.fn(() => `blob:worker-fixture-${MockWorker.instances.length + 1}`);
  revokeURL = vi.fn();
  vi.stubGlobal('__WORKER_CODE__', '/* test worker body; no game or network code */');
  vi.stubGlobal('Worker', MockWorker);
  vi.stubGlobal('URL', { createObjectURL: createURL, revokeObjectURL: revokeURL });
  vi.stubGlobal('Blob', class {
    constructor(readonly parts: BlobPart[], readonly options: BlobPropertyBag) {}
  });
});
afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('worker planner lifecycle', () => {
  it('posts one snapshot and releases its worker and blob URL after a result', async () => {
    const planner = new WorkerPlanner();
    const promise = planner.plan(before, 7);
    const worker = created();
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(worker.request).toMatchObject({ generation: 7, snapshot: before });
    expect(createURL).toHaveBeenCalledOnce();
    expect(revokeURL).toHaveBeenCalledWith(worker.url);
    worker.emit();
    await expect(promise).resolves.toEqual(result());
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps only the newest request and terminates the old computation', async () => {
    const planner = new WorkerPlanner();
    const first = planner.plan(before, 1);
    const firstRejected = expect(first).rejects.toBeInstanceOf(Error);
    const oldWorker = created();
    const nextSnapshot = { ...before, fingerprint: 'second-request' };
    const second = planner.plan(nextSnapshot, 2);
    const newWorker = created();
    await firstRejected;
    expect(oldWorker.terminate).toHaveBeenCalledOnce();
    expect(newWorker).not.toBe(oldWorker);
    expect(newWorker.terminate).not.toHaveBeenCalled();
    newWorker.emit();
    await expect(second).resolves.toEqual(result(nextSnapshot));
    expect(newWorker.terminate).toHaveBeenCalledOnce();
  });

  it('cancel rejects pending work and actually terminates the Worker', async () => {
    const planner = new WorkerPlanner();
    const promise = planner.plan(before, 1);
    const rejected = expect(promise).rejects.toBeInstanceOf(Error);
    const worker = created();
    planner.cancel();
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    planner.cancel();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('times out work after its limit and stops its computation', async () => {
    const planner = new WorkerPlanner();
    const promise = planner.plan(before, 1);
    const rejected = expect(promise).rejects.toBeInstanceOf(Error);
    const worker = created();
    await vi.advanceTimersByTimeAsync(2499);
    expect(worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['id', 'generation', 'fingerprint'] as const)('ignores a response with stale %s', async field => {
    const planner = new WorkerPlanner();
    const promise = planner.plan(before, 8);
    const worker = created();
    let settled = false;
    void promise.then(() => { settled = true; });
    worker.emit({ [field]: field === 'fingerprint' ? 'stale-fingerprint' : -1 });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.emit();
    await expect(promise).resolves.toEqual(result());
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('ignores an old Worker response after a new generation starts', async () => {
    const planner = new WorkerPlanner();
    const first = planner.plan(before, 1);
    const rejected = expect(first).rejects.toBeInstanceOf(Error);
    const oldWorker = created();
    const second = planner.plan(before, 2);
    const newWorker = created();
    await rejected;
    oldWorker.emit();
    expect(newWorker.terminate).not.toHaveBeenCalled();
    newWorker.emit();
    await expect(second).resolves.toEqual(result());
  });

  it('ignores late onerror from a terminated Worker without ending a new request', async () => {
    const planner = new WorkerPlanner();
    const first = planner.plan(before, 1);
    const rejected = expect(first).rejects.toBeInstanceOf(Error);
    const oldWorker = created();
    const second = planner.plan(before, 2);
    const newWorker = created();
    await rejected;
    oldWorker.fail();
    expect(newWorker.terminate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    newWorker.emit();
    await expect(second).resolves.toEqual(result());
    expect(newWorker.terminate).toHaveBeenCalledOnce();
  });

  it('rejects the current Worker error and clears the timeout', async () => {
    const planner = new WorkerPlanner();
    const promise = planner.plan(before, 1);
    const rejected = expect(promise).rejects.toBeInstanceOf(Error);
    const worker = created();
    worker.fail();
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('revokes the blob URL and clears pending work if CSP blocks Worker creation', async () => {
    vi.stubGlobal('Worker', class { constructor() { throw new Error('CSP blocked blob worker'); } });
    const planner = new WorkerPlanner();
    await expect(planner.plan(before, 1)).rejects.toThrow('CSP blocked');
    expect(createURL).toHaveBeenCalledOnce();
    expect(revokeURL).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
