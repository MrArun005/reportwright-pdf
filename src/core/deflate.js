// @ts-check
/**
 * zlib (Flate) compression. Async: Node's zlib on its thread pool (pages compress in parallel, off the main thread),
 * else the platform's CompressionStream (browsers), else fflate. Sync (the packed xref blocks, the xref stream):
 * fflate, bundled into dist (MIT, see THIRD-PARTY-NOTICES.md).
 */
import { zlibSync, deflateSync, inflateSync } from 'fflate';

export { deflateSync, inflateSync, zlibSync };

const NODE_ZLIB = /** @type {any} */ (globalThis).process?.getBuiltinModule?.('node:zlib');
// a few at a time: each zlib job holds ~260 KB of state; ponytail: 4 = libuv's default thread pool
const SMALL = 32 * 1024; // ponytail: below this, a sync deflate takes well under a millisecond
const slots = { free: 4, wait: /** @type {(() => void)[]} */ ([]) };

/** @param {Uint8Array} bytes @returns {Promise<Uint8Array>} */
export async function deflate(bytes, level = 6) {
  // small inputs: the same zlib, synchronously (same bytes); a thread-pool round trip costs more than the work
  if (NODE_ZLIB && bytes.length <= SMALL) return new Uint8Array(NODE_ZLIB.deflateSync(bytes, { level }));
  if (slots.free > 0) slots.free--; else await new Promise((ok) => slots.wait.push(/** @type {() => void} */ (ok)));
  try { return await now(bytes, level); } finally { const next = slots.wait.shift(); if (next) next(); else slots.free++; }
}
/** @param {Uint8Array} bytes @param {number} level @returns {Promise<Uint8Array>} */
async function now(bytes, level) {
  if (NODE_ZLIB) return new Promise((ok, fail) => NODE_ZLIB.deflate(bytes, { level }, (/** @type {any} */ e, /** @type {Uint8Array} */ z) => (e ? fail(e) : ok(z))));
  if (typeof CompressionStream === 'undefined' || level !== 6) return zlibSync(bytes, { level: /** @type {any} */ (level) });
  return new Uint8Array(await new Response(new Blob([/** @type {any} */ (bytes)]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
}

/**
 * A zlib stream fed a piece at a time, for data too big to hold whole (a decoded image): push(bytes) resolves once the
 * stream is done with the bytes (the caller may then reuse them), end() → the compressed stream, abort() on an error.
 * Node: zlib's Deflate stream; browsers: CompressionStream; else the pieces are copied and deflated at the end
 * (ponytail: fflate's streaming Zlib is not used, see objects.js; that fallback holds the data).
 * It takes no slot: a stream lives for a whole image, and two images each holding one would wait on each other.
 * @returns {{ push(b: Uint8Array): Promise<void>, end(): Promise<Uint8Array>, abort(): void }}
 */
export function deflateStream(level = 6) {
  /** @type {Uint8Array[]} */
  const out = [];
  const join = () => { let n = 0; for (const c of out) n += c.length; const z = new Uint8Array(n); n = 0; for (const c of out) { z.set(c, n); n += c.length; } return z; };
  if (NODE_ZLIB) {
    const z = NODE_ZLIB.createDeflate({ level, chunkSize: 1 << 20 }) // a big output buffer: zlib runs through a ~1 MB strip without waiting on the main thread every 16 KB;
    const ended = new Promise((ok, fail) => { z.on('data', (/** @type {Uint8Array} */ c) => out.push(c)); z.on('end', ok); z.on('error', fail); });
    ended.catch(() => {}); // seen by whoever awaits it
    return {
      push: (b) => Promise.race([new Promise((ok, fail) => z.write(b, (/** @type {any} */ e) => (e ? fail(e) : ok(undefined)))), ended]).then(() => {}),
      async end() { z.end(); await ended; return join(); },
      abort() { z.destroy(); },
    };
  }
  if (typeof CompressionStream === 'undefined') return { async push(b) { out.push(b.slice()); }, async end() { return zlibSync(join(), { level: /** @type {any} */ (level) }); }, abort() {} };
  // ponytail: CompressionStream has no level; it is used at the default only, else fflate on the joined pieces
  if (level !== 6) return { async push(b) { out.push(b.slice()); }, async end() { return zlibSync(join(), { level: /** @type {any} */ (level) }); }, abort() {} };
  const cs = new CompressionStream('deflate'), w = cs.writable.getWriter();
  const result = new Response(cs.readable).arrayBuffer();
  result.catch(() => {});
  return {
    async push(b) { await w.ready; await w.write(/** @type {any} */ (b)); },
    async end() { await w.close(); return new Uint8Array(await result); },
    abort() { w.abort().catch(() => {}); },
  };
}
