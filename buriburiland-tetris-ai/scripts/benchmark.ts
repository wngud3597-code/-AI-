import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { boardFeatures, search, spawnPiece } from '../src/runtime/engine';
import { PIECE_TYPES } from '../src/types/game';
import type { PieceType, RuntimeSnapshot } from '../src/runtime/model';

const args = process.argv.slice(2);
function option(name: string, fallback: number): number {
  const index = args.indexOf(name);
  const value = index < 0 ? fallback : Number(args[index + 1]);
  if (!Number.isFinite(value) || value < 1) throw new Error(`Invalid ${name}`);
  return Math.floor(value);
}
const seeds = option('--seeds', 8);
const pieces = option('--pieces', 80);
const budgetMs = option('--budget-ms', 10);
const maxNodes = option('--max-nodes', 6_000);
const outputIndex = args.indexOf('--output');
const output = resolve(outputIndex < 0 ? 'logs/benchmark-latest.json' : args[outputIndex + 1]!);
const seedPool = [731, 1777, 20261, 34057, 49157, 65537, 104729, 130363];
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
}
function sequence(seed: number, count: number): PieceType[] {
  const rng = random(seed);
  const result: PieceType[] = [];
  while (result.length < count) {
    const bag = [...PIECE_TYPES];
    for (let index = bag.length - 1; index > 0; index--) {
      const other = Math.floor(rng() * (index + 1));
      [bag[index], bag[other]] = [bag[other]!, bag[index]!];
    }
    result.push(...bag);
  }
  return result;
}
interface Run {
  seed: number; partition: string; scenario: string; variant: string; locks: number;
  lines: number; topout: boolean; newHoles: number; maxHeight: number;
  holds: number; decisions: number; nodes: number; latencies: number[];
  depths: Record<string, number>; timedOut: number;
}
function simulate(seed: number, index: number, scenario: 'stacking' | 'synthetic-garbage', depth: number): Run {
  const rng = random(seed ^ 0x5017);
  const queue = sequence(seed, pieces * 3 + 30);
  let cursor = 0;
  let type = queue[cursor++]!;
  let hold: PieceType | null = null;
  let board = Array<number>(20).fill(0);
  let canHold = true;
  const run: Run = { seed, partition: index < 4 ? 'development-seed (no tuning performed)' : 'held-out-seed', scenario, variant: depth === 1 ? 'depth-1 baseline' : 'depth-3 beam-2', locks: 0, lines: 0, topout: false, newHoles: 0, maxHeight: 0, holds: 0, decisions: 0, nodes: 0, latencies: [], depths: {}, timedOut: 0 };
  const limit = scenario === 'stacking' ? pieces : Math.min(pieces, 60);
  while (run.locks < limit) {
    const current = spawnPiece(board, type);
    if (!current) { run.topout = true; break; }
    const beforeHoles = boardFeatures(board).holes;
    const incoming = scenario === 'synthetic-garbage' && (run.locks + 1) % 16 === 0 ? 2 : 0;
    const snapshot: RuntimeSnapshot = { board, current, next: queue.slice(cursor, cursor + 5), hold, canHold,
      fingerprint: `synthetic-${seed}-${run.locks}-${run.holds}`, session: 'synthetic-local-benchmark', player: 'synthetic',
      observedAt: performance.now(), observation: run.decisions, paused: false, ended: false, lines: run.lines, incoming };
    const plan = search(snapshot, { depth, beamWidth: 2, budgetMs, maxNodes, maxStatesPerBoard: 1_500, maxPathLength: 14, allowHold: true });
    if (!plan) { run.topout = true; break; }
    run.decisions++;
    run.latencies.push(plan.elapsedMs);
    run.nodes += plan.nodes;
    run.depths[plan.depth] = (run.depths[plan.depth] ?? 0) + 1;
    run.timedOut += Number(plan.budgetExhausted);
    if (plan.kind === 'hold') {
      if (!canHold) throw new Error('Invalid repeated HOLD');
      const oldType = type;
      type = hold ?? queue[cursor++]!;
      hold = oldType; canHold = false; run.holds++;
      continue;
    }
    board = [...plan.expectedBoard];
    run.lines += plan.cleared; run.locks++; canHold = true;
    run.newHoles += Math.max(0, boardFeatures(board).holes - beforeHoles);
    if (incoming > 0) {
      // This is an exogenous stress fixture, not a claim about site insertion,
      // cancellation, attack routing, timing, or random hole distributions.
      if (board.slice(0, incoming).some(Boolean)) { run.topout = true; break; }
      const hole = Math.floor(rng() * 10);
      board = [...board.slice(incoming), ...Array<number>(incoming).fill(1023 ^ (1 << hole))];
    }
    run.maxHeight = Math.max(run.maxHeight, boardFeatures(board).maxHeight);
    type = queue[cursor++]!;
  }
  return run;
}
function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!.toFixed(3));
}
const started = performance.now();
const runs: Run[] = [];
for (const scenario of ['stacking', 'synthetic-garbage'] as const) {
  const count = scenario === 'stacking' ? seeds : Math.min(seeds, 4);
  for (let index = 0; index < count; index++) {
    const seed = seedPool[index % seedPool.length]! + Math.floor(index / seedPool.length) * 15485863;
    for (const depth of [1, 3]) runs.push(simulate(seed, index, scenario, depth));
  }
}
const summaries = [...new Set(runs.map((run) => `${run.scenario}/${run.variant}/${run.partition}`))].map((key) => {
  const selected = runs.filter((run) => `${run.scenario}/${run.variant}/${run.partition}` === key);
  const latencies = selected.flatMap((run) => run.latencies);
  const decisions = selected.reduce((sum, run) => sum + run.decisions, 0);
  const depthHistogram: Record<string, number> = {};
  for (const run of selected) for (const [depth, count] of Object.entries(run.depths)) depthHistogram[depth] = (depthHistogram[depth] ?? 0) + count;
  return { key, runs: selected.length, locks: selected.reduce((sum, run) => sum + run.locks, 0),
    lines: selected.reduce((sum, run) => sum + run.lines, 0), topouts: selected.filter((run) => run.topout).length,
    newHoles: selected.reduce((sum, run) => sum + run.newHoles, 0), maxHeight: Math.max(...selected.map((run) => run.maxHeight)),
    decisions, holds: selected.reduce((sum, run) => sum + run.holds, 0),
    meanNodes: Math.round(selected.reduce((sum, run) => sum + run.nodes, 0) / Math.max(1, decisions)),
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99), max: percentile(latencies, 1) },
    exhaustedDecisions: selected.reduce((sum, run) => sum + run.timedOut, 0), depthHistogram };
});
const result = { schema: 1, evidence: 'local synthetic CPU simulation only', generatedAt: new Date().toISOString(),
  settings: { seeds, pieces, budgetMs, maxNodes, beamWidth: 2, maxPathLength: 14, visibleQueue: 5, orientation: 'known from simulated spawn; initial ambiguous DOM orientation is not benchmarked' },
  limitations: ['No live room, browser input, authoritative server physics, or human matches', 'Depth-1 baseline is the same current engine, not the historical v4 userscript', 'No weight tuning performed; four seed identities designated held-out before running', 'Synthetic garbage inserts two rows every sixteen locks without modeling cancellation', 'Wall-clock budgets can alter search results between runs; node caps and seeds are recorded', 'Search latency is CPU time, not end-to-end decision latency or gameplay PPS'],
  elapsedMs: Number((performance.now() - started).toFixed(1)), summaries, runs };
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ output, elapsedMs: result.elapsedMs, settings: result.settings, summaries }, null, 2));
