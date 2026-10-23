import type { RuntimePlan, RuntimeSnapshot } from './model';
import type { Planner } from './control';

declare const __WORKER_CODE__: string;
export class WorkerPlanner implements Planner {
  private worker: Worker | null = null;
  private serial = 0;
  private pending: { reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | null = null;
  plan(snapshot: RuntimeSnapshot, generation: number): Promise<RuntimePlan> {
    this.cancel();
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (id === this.serial) this.cancel(); }, 2500);
      this.pending = { reject, timer };
      try {
        const url = URL.createObjectURL(new Blob([__WORKER_CODE__], { type: 'text/javascript' }));
        try { this.worker = new Worker(url, { name: 'buriburiland-tetris-search' }); }
        finally { URL.revokeObjectURL(url); }
        this.worker.onerror = event => {
          if (id !== this.serial) return;
          event.preventDefault(); this.finish();
          reject(new Error('Worker 실행 실패. 브라우저 CSP·userscript 실행 설정을 확인하세요.'));
        };
        this.worker.onmessage = event => {
          const data = event.data as { id: number; generation: number; fingerprint: string; error?: string; plan?: RuntimePlan };
          if (!data || typeof data !== 'object') return;
          if (id !== this.serial || data.id !== id || data.generation !== generation || data.fingerprint !== snapshot.fingerprint) return;
          this.finish();
          if (data.error || !data.plan) reject(new Error(data.error ?? 'Worker 계획이 없습니다.'));
          else resolve(data.plan);
        };
        this.worker.postMessage({ id, generation, snapshot });
      } catch (error) { this.finish(); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  cancel(): void {
    this.serial++;
    const pending = this.pending;
    this.finish(); pending?.reject(new Error('Worker 요청이 취소되었거나 제한 시간을 초과했습니다.'));
  }
  private finish(): void {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null; this.worker?.terminate(); this.worker = null;
  }
}
