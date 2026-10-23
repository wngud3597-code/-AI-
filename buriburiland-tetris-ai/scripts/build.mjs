import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { SCRIPT_VERSION } from '../src/runtime/version.ts';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/runtime/worker-entry.ts'], bundle: true, format: 'iife', platform: 'browser', target: 'es2022', outfile: 'dist/tetris-ai.worker.js', legalComments: 'inline' });
const worker = await readFile('dist/tetris-ai.worker.js', 'utf8');
const banner = `// ==UserScript==
// @name         BuriburiLand Tetris AI — DOM Control
// @namespace    buriburiland-tetris-ai
// @version      ${SCRIPT_VERSION}
// @description  Explicit-start Worker search with display-level validation. F8 stop; F9 inspect.
// @match        https://buriburiland.com/*
// @match        https://www.buriburiland.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==`;
await build({ entryPoints: ['src/userscript/main.ts'], bundle: true, format: 'iife', platform: 'browser', target: 'es2022', outfile: 'dist/tetris-ai.user.js', define: { __WORKER_CODE__: JSON.stringify(worker) }, banner: { js: banner }, legalComments: 'inline' });
const manifest = {};
for (const file of ['tetris-ai.user.js', 'tetris-ai.worker.js']) {
  const bytes = await readFile(`dist/${file}`);
  manifest[file] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
await writeFile('dist/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
