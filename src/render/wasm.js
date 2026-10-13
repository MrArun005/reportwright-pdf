// @ts-check
/**
 * The rasterizer's WASM kernel (kernel.wat), compiled once on first use; null where WebAssembly or its 128-bit SIMD
 * is missing (the JS rasterizer is used, with the same output). One instance, one caller at a time (busy): a fill
 * started from inside a fill's span callback uses JS. Its memory only grows, at most MAX_KERNEL_BYTES.
 */
import { KERNEL_BASE64 } from './kernel.js';

export const MAX_KERNEL_BYTES = 256 * 1024 * 1024;
/** @type {any} */
let K;
/** @returns {any} */
export function kernel() {
  if (K !== undefined) return K;
  K = null;
  try {
    const W = /** @type {any} */ (globalThis).WebAssembly;
    if (!W) return K;
    const bin = typeof atob === 'function' ? Uint8Array.from(atob(KERNEL_BASE64), (c) => c.charCodeAt(0)) : null;
    if (!bin || !W.validate(bin)) return K; // no SIMD (or bulk memory): the JS path
    const e = new W.Instance(new W.Module(bin)).exports;
    K = {
      band: e.band,
      row: e.row,
      solid: e.solid,
      rowsolid: e.rowsolid,
      reset: e.reset,
      memory: e.memory,
      busy: false,
      page: /** @type {{ off: number, len: number } | null} */ (null),
      le: new Uint8Array(new Uint32Array([1]).buffer)[0] === 1, // pixels as words: little-endian, as WASM is
    };
  } catch {
    K = null;
  }
  return K;
}
/** memory of at least n bytes (n ≤ MAX_KERNEL_BYTES, checked by the caller); the growth charged first @param {any} k @param {number} n @param {(n: number) => void} tick */
export function reserve(k, n, tick) {
  const have = k.memory.buffer.byteLength;
  if (n <= have) return;
  const pages = Math.ceil((n - have) / 65536);
  tick(1 + ((pages * 65536) >> 10)); // the bytes added, before they are
  k.memory.grow(pages);
}

/** room for a fill's segments, cells and rows below a page held in kernel memory (bigger fills use JS) */
export const SCRATCH_BYTES = 24 * 1024 * 1024,
  /** a page held in kernel memory at most (bigger pages are plain arrays) */
  MAX_PAGE_BYTES = 128 * 1024 * 1024,
  /** clip masks held after the page at most */
  CLIP_BYTES = 32 * 1024 * 1024;
/**
 * a page's pixels in kernel memory (so spans are composited there), or null; memory never grows while it is held
 * @param {number} bytes @param {(n: number) => void} tick
 */
export function holdPage(bytes, w, tick) {
  const k = kernel();
  const rowBytes = Math.ceil((w + 1) / 4) * 4 * 4;
  if (!k || !k.le || k.busy || k.page || bytes > MAX_PAGE_BYTES || bytes & 3 || 2 * rowBytes > SCRATCH_BYTES / 4)
    return null;
  // after the page: room for its first clip masks (bytes / 4 each), so they are in kernel memory too
  const clips = Math.min(bytes * 2, CLIP_BYTES);
  reserve(k, SCRATCH_BYTES + bytes + clips, tick);
  const buf = k.memory.buffer,
    rowOff = SCRATCH_BYTES - rowBytes,
    onesOff = rowOff - rowBytes;
  // below the page: a row of ones (a rectangle's coverage) and a row for cached glyph coverage; fills go below them
  k.page = {
    off: SCRATCH_BYTES,
    len: bytes,
    limit: onesOff,
    ones: new Float32Array(buf, onesOff, w + 1).fill(1),
    row: new Float32Array(buf, rowOff, w + 1),
    clipAt: SCRATCH_BYTES + bytes,
    clipEnd: SCRATCH_BYTES + bytes + clips,
  };
  return new Uint8ClampedArray(buf, SCRATCH_BYTES, bytes);
}
/** a zeroed clip mask of n bytes in kernel memory (while a page is held, and room is left), or null @param {number} n */
export function kernelClip(n) {
  const p = K?.page;
  if (!p || p.clipAt + n > p.clipEnd) return null;
  const m = new Uint8Array(K.memory.buffer, p.clipAt, n).fill(0);
  p.clipAt += n;
  return m;
}
export function releasePage() {
  if (K) K.page = null;
}
