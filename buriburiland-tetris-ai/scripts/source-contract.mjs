import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { CLIENT_SOURCE, createClientHelpers, loadClientSource } from './public-client.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const reportPath = new URL('../reports/source-contract.json', import.meta.url);
const started = performance.now();
const report = {
  kind: 'public-client-source-differential',
  source: CLIENT_SOURCE,
  authority: 'Public client helpers compared offline; server authority and live browser behavior unverified',
  normalization: [
    'Bit rows compare occupied cells to positive numeric client matrix cells; block colors do not affect collision.',
    'A runtime blocked action returns null; the client returns the unchanged piece. Both compare as no movement.',
    'Runtime lock topOut:true normalizes to client lock:null when any occupied cell remains above row zero.',
  ],
  excluded: ['180-degree rotation is disabled in runtime', 'server reconciliation', 'spin', 'attack', 'garbage insertion/cancellation timing', 'live play'],
  scenarioCounts: {},
  comparisons: {},
  divergences: [],
  status: 'running',
};

function matrix(rows) {
  return rows.map(row => Array.from({ length: 10 }, (_, x) => (row & (1 << x)) !== 0 ? 8 : 0));
}
function masks(board) {
  return Array.from(board, row => Array.from(row).reduce((mask, cell, x) => cell > 0 ? mask | (1 << x) : mask, 0));
}
function pose(piece) {
  return piece ? { type: piece.type, rotation: piece.rotation, x: piece.x, y: piece.y } : null;
}
function cellKey(cells) {
  return Array.from(cells, ([x, y]) => `${x},${y}`).sort().join(';');
}
function clientCells(client, piece) {
  return Array.from(client.shape(piece)).flatMap((row, y) => Array.from(row).flatMap((cell, x) => cell ? [[x, y]] : []));
}
function clientLock(value) {
  return value ? { board: masks(value.board), lines: value.lines } : null;
}
function runtimeLock(value) {
  return value && !value.topOut ? { board: [...value.board], lines: value.cleared } : null;
}
function compare(category, expected, actual, context) {
  const counter = report.comparisons[category] ??= { compared: 0, matched: 0, mismatched: 0 };
  counter.compared += 1;
  if (JSON.stringify(expected) === JSON.stringify(actual)) counter.matched += 1;
  else {
    counter.mismatched += 1;
    if (report.divergences.length < 20) report.divergences.push({ category, context, expected, actual });
  }
}

function rng(seed) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}

function fixtures() {
  const boards = [
    { name: 'empty', seed: null, rows: Array(20).fill(0) },
    { name: 'four-line-right-well', seed: null, rows: [...Array(16).fill(0), ...Array(4).fill(511)] },
    { name: 'spawn-blocked', seed: null, rows: [1023, 1023, 1023, ...Array(17).fill(0)] },
    { name: 'left-wall-tower', seed: null, rows: [...Array(4).fill(0), ...Array(16).fill(1)] },
    { name: 'right-wall-tower', seed: null, rows: [...Array(4).fill(0), ...Array(16).fill(512)] },
  ];
  for (let seed = 1; seed <= 48; seed += 1) {
    const random = rng(0x9e3779b9 ^ seed);
    const rows = Array(20).fill(0);
    const heights = Array.from({ length: 10 }, () => 2 + Math.floor(random() * 15));
    for (let x = 0; x < 10; x += 1) {
      for (let y = 20 - heights[x]; y < 20; y += 1) if (random() > 0.2) rows[y] |= 1 << x;
    }
    boards.push({ name: 'irregular-holes-overhangs', seed, rows });
    const garbage = Array(20).fill(0);
    const amount = 1 + Math.floor(random() * 12);
    let hole = Math.floor(random() * 10);
    for (let y = 20 - amount; y < 20; y += 1) {
      if (seed % 2 === 0 && random() < 0.5) hole = Math.floor(random() * 10);
      garbage[y] = 1023 ^ (1 << hole);
    }
    // Some ordinary blocks cover the garbage entrance; others leave it accessible.
    for (let x = 0; x < 10; x += 1) if (random() < 0.35) garbage[19 - amount] |= 1 << x;
    boards.push({ name: seed % 2 === 0 ? 'garbage-changing-hole' : 'garbage-fixed-hole', seed, rows: garbage });
  }
  return boards;
}

try {
  const source = await loadClientSource();
  const client = createClientHelpers(source.instrumentedSource);
  const bundle = await build({ absWorkingDir: root, entryPoints: ['src/runtime/engine.ts'], bundle: true,
    platform: 'node', target: 'node22', format: 'esm', write: false, logLevel: 'silent',
    tsconfigRaw: { compilerOptions: { target: 'ES2022', useDefineForClassFields: true } } });
  const engine = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
  const types = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
  const rotations = [0, 1, 2, 3];
  const xs = [-2, 0, 1, 3, 6, 8, 9, 10];
  const ys = [-3, -2, -1, 0, 4, 10, 15, 17, 18, 19, 20];
  const actionPairs = [
    ['move_left', 'LEFT'], ['move_right', 'RIGHT'], ['soft_drop', 'SOFT_DROP'],
    ['rotate_cw', 'ROTATE_CW'], ['rotate_ccw', 'ROTATE_CCW'],
  ];
  for (const type of types) for (const rotation of rotations) {
    compare('shape', cellKey(clientCells(client, { type, rotation })), cellKey(engine.cellsFor(type, rotation)), { type, rotation });
  }
  for (const fixture of fixtures()) {
    const { rows, name, seed } = fixture;
    report.scenarioCounts[name] = (report.scenarioCounts[name] ?? 0) + 1;
    const board = matrix(rows);
    for (const type of types) {
      compare('spawn', pose(client.spawn(type, board)), pose(engine.spawnPiece(rows, type)), { name, seed, type });
      for (const rotation of rotations) for (const x of xs) for (const y of ys) {
        const current = { type, rotation, x, y };
        const context = { name, seed, current };
        const valid = client.valid(board, current);
        compare('collision', valid, !engine.collides(rows, type, rotation, x, y), context);
        if (!valid) continue; // Inputs must start from a legal observed pose.
        for (const [clientAction, runtimeAction] of actionPairs) {
          compare(clientAction, pose(client.apply(clientAction, board, current)),
            pose(engine.applyRuntimeAction(rows, current, runtimeAction) ?? current), context);
        }
        const dropped = client.drop(board, current);
        const runtimeDrop = engine.applyRuntimeAction(rows, current, 'HARD_DROP');
        compare('hard_drop', pose(dropped), pose(runtimeDrop), context);
        compare('lock', clientLock(client.lock(board, current)), runtimeLock(engine.lockPiece(rows, type, rotation, x, y)), context);
        compare('hard_drop_lock', clientLock(client.lock(board, dropped)),
          runtimeLock(engine.lockPiece(rows, type, rotation, runtimeDrop.x, runtimeDrop.y)), context);
      }
    }
  }
  for (const [key, code, action] of [
    ['ArrowLeft', 'ArrowLeft', 'move_left'], ['ArrowRight', 'ArrowRight', 'move_right'],
    ['ArrowDown', 'ArrowDown', 'soft_drop'], ['x', 'KeyX', 'rotate_cw'], ['z', 'KeyZ', 'rotate_ccw'],
    ['a', 'KeyA', 'rotate_180'], [' ', 'Space', 'hard_drop'], ['c', 'KeyC', 'hold'],
  ]) compare('key_mapping', action, client.key(key, code), { key, code });
  compare('piece_colors', ['#22d3ee', '#facc15', '#a78bfa', '#84cc16', '#fb7185', '#60a5fa', '#fb923c'], Array.from(client.colors).slice(1, 8), {});
  const total = Object.values(report.comparisons).reduce((sum, counter) => sum + counter.compared, 0);
  const mismatches = Object.values(report.comparisons).reduce((sum, counter) => sum + counter.mismatched, 0);
  report.totalCompared = total;
  report.totalMismatches = mismatches;
  report.status = mismatches === 0 ? 'passed' : 'failed';
  if (mismatches > 0) process.exitCode = 1;
} catch (error) {
  report.status = 'failed';
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
}
report.elapsedMs = Math.round((performance.now() - started) * 100) / 100;
await mkdir(new URL('../reports/', import.meta.url), { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`Public client source contract: ${report.status}; ${report.totalCompared ?? 0} comparisons; ${report.totalMismatches ?? 'unknown'} mismatches; ${report.elapsedMs} ms.`);
console.log('Report: reports/source-contract.json. Live site and server authority remain unverified.');
if (report.error) console.error(report.error);
if (report.divergences.length > 0) console.error(JSON.stringify(report.divergences.slice(0, 3), null, 2));
