import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { search, spawnPiece } from '../src/runtime/engine';
import type { RuntimeRecord } from '../src/runtime/control';
import type { RuntimeSnapshot } from '../src/runtime/model';
import { RUNTIME_RULE_PROFILE } from '../src/runtime/model';
import { replayRecord } from '../src/runtime/replay';
function fixture(): unknown[] {
  const board = Array<number>(20).fill(0); board[19] = 1023 ^ (15 << 3);
  const before: RuntimeSnapshot = { board, current: { type: 'I', x: 3, y: 0, rotation: 0 }, next: ['J', 'O', 'T', 'S', 'L'], hold: null, canHold: false, fingerprint: 'synthetic-1', session: 'synthetic-fixture', player: 'synthetic', observedAt: 0, observation: 1, paused: false, ended: false, lines: 0, incoming: null };
  const plan = search(before, { depth: 1, now: () => 0 })!;
  const after: RuntimeSnapshot = { ...before, board: plan.expectedBoard, current: spawnPiece(plan.expectedBoard, 'J')!, next: ['O', 'T', 'S', 'L', 'Z'], fingerprint: 'synthetic-2', observedAt: 100, observation: 2, lines: plan.cleared };
  const record: RuntimeRecord & { evidence: 'synthetic' } = { schema: 2, type: 'placement', ruleProfile: RUNTIME_RULE_PROFILE.id, before, plan,
    actions: plan.path.map((action, index) => ({ action, at: index + 1 })), after, result: 'display-match',
    validation: {}, error: null, timings: { observationMs: 0, searchMs: 0, inputMs: 0, confirmationMs: 0 }, evidence: 'synthetic' };
  const divergentBoard = [...after.board]; divergentBoard[19] = (divergentBoard[19] ?? 0) | 1;
  return [record, { ...record, after: { ...after, board: divergentBoard }, result: 'unknown' }, { ...record, type: 'failure', result: 'cancelled' }];
}

export function main(): void {
  const args = process.argv.slice(2);
  const writeIndex = args.indexOf('--write-fixture');
  if (writeIndex >= 0) {
    const destination = resolve(args[writeIndex + 1] ?? 'replays/synthetic-example.jsonl');
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, fixture().map((record) => JSON.stringify(record)).join('\n') + '\n');
    console.log(JSON.stringify({ destination, evidence: 'synthetic; never live fidelity evidence' }));
    return;
  }
  const path = args[0];
  if (!path) throw new Error('Usage: npm run replay -- <JSONL path> OR --write-fixture <path>');
  const lines = readFileSync(resolve(path), 'utf8').split(/\r?\n/).filter(Boolean);
  const results = lines.map((line, index) => {
    try { return replayRecord(JSON.parse(line), index + 1); }
    catch (error) { return { line: index + 1, status: 'invalid', board: 'unknown', clear: 'unknown', reason: error instanceof Error ? error.message : String(error), synthetic: false }; }
  });
  const counts: Record<string, number> = {};
  for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1;
  console.log(JSON.stringify({ path: resolve(path), records: results.length, counts, limitations: ['Recomputed from copied before state and executed inputs; stored plan.expectedBoard ignored', 'Action timestamps are checked but gravity/lock-delay evolution is not simulated', 'Unknown attacks, spin, cancellation and external garbage are not scored as matches', 'Observed-rise consistency checks later display evidence; it is not a predicted full-board or server-order match', 'Interrupted replans, including HOLD recovery, are excluded from completed-lock and clear accuracy', 'A display-consistent record does not establish authoritative server fidelity'], results }, null, 2));
  if (results.some((result) => ['invalid', 'unsupported-profile', 'divergence-unclassified'].includes(result.status))) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

