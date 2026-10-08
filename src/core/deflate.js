// @ts-check
/**
 * zlib (Flate) compression. Async: Node's zlib on its thread pool (pages compress in parallel, off the main thread),
 * else the platform's CompressionStream (browsers), else fflate. Sync (the packed xref blocks, the xref stream):
 * fflate, bundled into dist (MIT, see THIRD-PARTY-NOTICES.md).
 */
import { zlibSync, deflateSync, inflateSync, Zlib } from 'fflate';

export { deflateSync, inflateSync, Zlib };

const NODE_ZLIB = /** @type {any} */ (globalThis).process?.getBuiltinModule?.('node:zlib');
// a few at a time: each zlib job holds ~260 KB of state; ponytail: 4 = libuv's default thread pool
const slots = { free: 4, wait: /** @type {(() => void)[]} */ ([]) };

/** @param {Uint8Array} bytes @returns {Promise<Uint8Array>} */
export async function deflate(bytes) {
  if (slots.free > 0) slots.free--; else await new Promise((ok) => slots.wait.push(/** @type {() => void} */ (ok)));
  try { return await now(bytes); } finally { const next = slots.wait.shift(); if (next) next(); else slots.free++; }
}
/** @param {Uint8Array} bytes @returns {Promise<Uint8Array>} */
async function now(bytes) {
  if (NODE_ZLIB) return new Promise((ok, fail) => NODE_ZLIB.deflate(bytes, { level: 6 }, (/** @type {any} */ e, /** @type {Uint8Array} */ z) => (e ? fail(e) : ok(z))));
  if (typeof CompressionStream === 'undefined') return zlibSync(bytes, { level: 6 });
  return new Uint8Array(await new Response(new Blob([/** @type {any} */ (bytes)]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
}
