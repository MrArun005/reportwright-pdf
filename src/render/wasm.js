// @ts-check
/**
 * The rasterizer's WASM kernel (kernel.wat), compiled once on first use; null where WebAssembly or its 128-bit SIMD
 * is missing (the JS rasterizer is used, with the same output). One instance, one caller at a time (busy): a fill
 * started from inside a fill's span callback uses JS. Its memory only grows, at most MAX_KERNEL_BYTES.
 */
import { KERNEL_BASE64 } from './kernel.js';

export const MAX_KERNEL_BYTES = 64 * 1024 * 1024;
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
      radial: e.radial,
      layer: e.layer,
      reset: e.reset,
      memory: e.memory,
      busy: false,
      rows: /** @type {any} */ (null),
      base: 0,
      used: 0, // bytes in use by the running fill (its segments, cells, rows and spans)
      le: new Uint8Array(new Uint32Array([1]).buffer)[0] === 1, // pixels as words: little-endian, as WASM is
    };
  } catch {
    K = null;
  }
  return K;
}
/**
 * whether the kernel's memory holds n bytes: it is a fixed 64 MB, never grown (growing detaches its ArrayBuffer, and
 * in V8 a single detached buffer slows every typed-array access in the process); a bigger need uses JS
 * @param {any} k @param {number} n
 */
export function reserve(k, n) {
  return n <= k.memory.buffer.byteLength;
}

/**
 * The kernel's row area for a page W pixels wide, at the start of its memory: a row of ones (a rectangle's coverage),
 * a coverage row (cached glyphs, rectangles), a pixel row and a clip row. Pixels stay in the caller's own arrays (JS
 * code never works on kernel memory, so it stays as fast as without it): a span is copied in, composited, copied back.
 * Fills use the memory after it (k.base). @param {any} k @param {number} w @param {(n: number) => void} tick
 */
export function rowsFor(k, w, tick) {
  const r = k.rows;
  if (r && r.w === w && r.buffer === k.memory.buffer) return r;
  const cov = (w + 1) * 4,
    size = Math.ceil((2 * cov + w * 4 + w + 64 + w * 4 + w * 4) / 64) * 64;
  if (!reserve(k, size + (1 << 20))) return null;
  const buf = k.memory.buffer;
  k.base = size;
  k.rows = {
    w,
    buffer: buf,
    ones: new Float32Array(buf, 0, w + 1),
    row: new Float32Array(buf, cov, w + 1),
    pixOff: 2 * cov,
    pix: new Uint8ClampedArray(buf, 2 * cov, w * 4),
    clipOff: 2 * cov + w * 4,
    clip: new Uint8Array(buf, 2 * cov + w * 4, w),
    // a row of shading table entries (paintSpans)
    idx: new Int32Array(buf, Math.ceil((2 * cov + w * 5) / 4) * 4, w),
    // a layer's pixel row (composite)
    lrowOff: Math.ceil((2 * cov + w * 5) / 4) * 4 + w * 4,
    lrow: new Uint8ClampedArray(buf, Math.ceil((2 * cov + w * 5) / 4) * 4 + w * 4, w * 4),
  };
  if (!r || r.w !== w || k.rows.ones[0] !== 1) k.rows.ones.fill(1);
  return k.rows;
}

/**
 * a scratch block of n bytes in kernel memory past what the current fill uses (k.used; the row area when no fill is
 * running), 16-byte aligned, charged first; null when it does not fit (the caller uses JS). Valid until the next
 * call that takes scratch or starts a fill. @param {any} k @param {number} n @param {(n: number) => void} tick
 */
export function scratch(k, n, tick) {
  if (!(Number.isInteger(n) && n >= 0)) return null;
  const off = Math.ceil(Math.max(k.used || 0, k.base || 0) / 16) * 16;
  if (off + n > k.memory.buffer.byteLength) return null;
  tick(1 + (n >> 10));
  return off;
}
