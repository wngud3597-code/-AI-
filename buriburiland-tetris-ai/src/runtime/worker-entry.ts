import { search } from './engine';
import type { RuntimeSnapshot } from './model';

interface WorkerRequest { id: number; generation: number; snapshot: RuntimeSnapshot }
// Compiled as an independent, self-contained artifact. Cancellation terminates
// the Worker, including a search currently occupying its event loop.
const scope = self as unknown as { onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null; postMessage(value: unknown): void };
scope.onmessage = event => {
  const { id, generation, snapshot } = event.data;
  try {
    const plan = search(snapshot, { budgetMs: 100, depth: 3, beamWidth: 10, maxNodes: 40_000, maxStatesPerBoard: 1500, maxPathLength: 14, allowHold: true });
    scope.postMessage({ id, generation, fingerprint: snapshot.fingerprint, plan });
  } catch (error) {
    scope.postMessage({ id, generation, fingerprint: snapshot.fingerprint, error: error instanceof Error ? error.message : String(error) });
  }
};
