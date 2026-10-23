import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export const CLIENT_SOURCE = Object.freeze({
  file: '847.a5a05f14ceb3f87d.js',
  url: 'https://buriburiland.com/_next/static/chunks/847.a5a05f14ceb3f87d.js',
  sha256: '223960D0C6DD0E4E5F3E8C421B12FF9DB504CF0EF0FD4E248E873D50C4DF6538',
  verifiedAt: '2026-10-23',
});

export function verifyClientSource(source) {
  const sha256 = createHash('sha256').update(source).digest('hex').toUpperCase();
  if (sha256 !== CLIENT_SOURCE.sha256) {
    throw new Error(`Public client SHA256 mismatch: expected ${CLIENT_SOURCE.sha256}, received ${sha256}`);
  }
  return sha256;
}

/** Exposes only public, pure rendering/physics/key helpers in a verified local copy. */
export function instrumentClientSource(source) {
  verifyClientSource(source);
  if (!source.trimEnd().endsWith('}}]);')) throw new Error('Verified client module wrapper is not recognized');
  const ending = source.lastIndexOf('}}]);');
  return source.slice(0, ending) +
    ';globalThis.__client={shape:K,apply:U,spawn:ei,drop:er,lock:ea,valid:eo,key:es,colors:N};' +
    source.slice(ending);
}

/** Original public assets remain outside the repository and are never bundled into the userscript. */
export async function loadClientSource() {
  const path = fileURLToPath(new URL(`../../.cache/buriburiland-public-2026-10-23/${CLIENT_SOURCE.file}`, import.meta.url));
  let source;
  try { source = await readFile(path, 'utf8'); }
  catch (error) {
    throw new Error(`Cached public client is unavailable; fetch ${CLIENT_SOURCE.url} to the workspace .cache directory. ${error.code ?? ''}`);
  }
  const sha256 = verifyClientSource(source);
  return Object.freeze({ source, sha256, path, sourceUrl: CLIENT_SOURCE.url,
    instrumentedSource: instrumentClientSource(source) });
}

/** Executes no component renders, timers, network calls, or service methods. */
export function createClientHelpers(instrumentedSource) {
  const sandbox = { self: { webpackChunk_N_E: [] } };
  vm.createContext(sandbox);
  vm.runInContext(instrumentedSource, sandbox, { timeout: 3000, filename: CLIENT_SOURCE.file });
  const chunk = sandbox.self.webpackChunk_N_E.find(([ids]) => ids.includes(847));
  const module = chunk?.[1]?.[847];
  if (typeof module !== 'function') throw new Error('Client module 847 was not registered');
  const requireStub = () => ({ memo: component => component });
  requireStub.r = () => {};
  requireStub.d = () => {};
  module({}, {}, requireStub);
  const client = sandbox.__client;
  for (const name of ['shape', 'apply', 'spawn', 'drop', 'lock', 'valid', 'key']) {
    if (typeof client?.[name] !== 'function') throw new Error(`Public client helper ${name} is unavailable`);
  }
  return client;
}
