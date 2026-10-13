// @ts-check
/**
 * The tiling sampler's rows in the kernel (kernel-tiling.wat): one span of a row at a time, composited in WASM with the
 * JS closure's operations and order. Everything the kernel reads is laid out here at `base` in the kernel's memory:
 * the parameter block (32 f64 slots, see PB below), the cell (cw × ch × 4 bytes), the column table (aligned only), and
 * the span's coverage, clip and pixels. Every offset, length and step is validated before any call; anything off
 * returns null and the caller uses the JS sampler (no state is shared between the two, so a fallback is clean).
 */

/** parameter block slots (byte offset = 8 × slot) */
const PB = {
  alpha: 0,
  cw: 8,
  ch: 16,
  hasCol: 24,
  col: 32, // 3 slots
  Y0: 56,
  Y1: 64,
  ty: 72,
  im: 80, // im0..im5 (6 slots)
  xs: 128,
  ys: 136,
  kx: 144,
  ky: 152,
  bx0: 160,
  by0: 168,
  dFX: 176,
  dFY: 184,
  FX: 192,
  FY: 200,
  lastX: 208,
  lastY: 216,
  out: 224, // r, g, b, alpha / 255 (4 slots)
};
const PB_BYTES = 256;
const MAX_CELL_PIXELS = 1 << 20;

const finite = (/** @type {any} */ v) => typeof v === 'number' && Number.isFinite(v);
const int = (/** @type {any} */ v, lo = 0) => Number.isSafeInteger(v) && v >= lo;
const up8 = (/** @type {number} */ n) => Math.ceil(n / 8) * 8;

/**
 * the bytes a sampler's layout takes (the caller reserves them in the kernel's memory)
 * @param {number} W @param {number} cw @param {number} ch @param {boolean} aligned
 */
export function tilingBytes(W, cw, ch, aligned) {
  return PB_BYTES + up8(cw * ch * 4) + (aligned ? up8(24 * W) : 0) + up8(4 * W) * 2 + up8(W);
}

/**
 * Lays a tiling sampler out at base in k's memory: k needs memory and the kernel exports tile_fmod, tile_aligned and
 * tile_affine. Returns { run(py, xa, xb, cov, clip, data, row), bytes } or null (the JS path). `row` (aligned only) is
 * [Y0, Y1, ty] for device row py, from the sampler's rowAt.
 * @param {any} k the kernel (memory + the tile_* exports)
 * @param {number} base byte offset (multiple of 8, > 0) of a free region of kernel memory
 * @param {{ W: number, cw: number, ch: number, cell: Uint8ClampedArray, aligned: boolean, cols?: Float64Array | null,
 *   im: number[], xs: number, ys: number, kx: number, ky: number, bx0: number, by0: number, dFX: number, dFY: number,
 *   alpha: number, col: number[] | null }} s
 */
export function tilingRows(k, base, s) {
  const mem = k?.memory;
  if (!mem || typeof k.tile_aligned !== 'function' || typeof k.tile_affine !== 'function') return null;
  const { W, cw, ch, cell, aligned, cols, im, xs, ys, kx, ky, bx0, by0, dFX, dFY, alpha, col } = s;
  if (!int(W, 1) || !int(cw, 1) || !int(ch, 1) || cw * ch > MAX_CELL_PIXELS) return null;
  if (!(cell instanceof Uint8ClampedArray) || cell.length !== cw * ch * 4) return null;
  if (!finite(alpha) || !finite(xs) || !finite(ys) || !finite(bx0) || !finite(by0)) return null;
  if (!(xs > 0 && ys > 0 && finite(kx) && finite(ky) && kx > 0 && ky > 0)) return null;
  if (!finite(dFX) || !finite(dFY) || !Array.isArray(im) || im.length !== 6 || !im.every(finite)) return null;
  if (col !== null && !(Array.isArray(col) && col.length === 3 && col.every(finite))) return null;
  if (aligned) {
    if (!(cols instanceof Float64Array) || cols.length !== 3 * W || !cols.every(finite)) return null;
  }
  // the layout: parameter block, cell, column table (aligned), coverage, pixels, clip
  const cellOff = base + PB_BYTES,
    colsOff = cellOff + up8(cell.length),
    covOff = colsOff + (aligned ? up8(24 * W) : 0),
    pixOff = covOff + up8(4 * W),
    clipOff = pixOff + up8(4 * W),
    end = base + tilingBytes(W, cw, ch, aligned);
  if (!int(base, 8) || base % 8 !== 0 || base === 0 || end > mem.buffer.byteLength) return null;
  const buf = mem.buffer;
  const pb = new Float64Array(buf, base, PB_BYTES / 8);
  const cellView = new Uint8ClampedArray(buf, cellOff, cell.length);
  const covView = new Float32Array(buf, covOff, W);
  const pixView = new Uint8Array(buf, pixOff, 4 * W);
  const clipView = new Uint8Array(buf, clipOff, W);
  // constants of this sampler
  pb.fill(0);
  pb[PB.alpha / 8] = alpha;
  pb[PB.cw / 8] = cw;
  pb[PB.ch / 8] = ch;
  pb[PB.hasCol / 8] = col ? 1 : 0;
  if (col) for (let q = 0; q < 3; q++) pb[PB.col / 8 + q] = col[q];
  for (let q = 0; q < 6; q++) pb[PB.im / 8 + q] = im[q];
  pb[PB.xs / 8] = xs;
  pb[PB.ys / 8] = ys;
  pb[PB.kx / 8] = kx;
  pb[PB.ky / 8] = ky;
  pb[PB.bx0 / 8] = bx0;
  pb[PB.by0 / 8] = by0;
  pb[PB.dFX / 8] = dFX;
  pb[PB.dFY / 8] = dFY;
  pb[PB.lastX / 8] = NaN; // the walk starts with no previous pixel (as the JS closure)
  pb[PB.lastY / 8] = NaN;
  cellView.set(cell);
  if (aligned) new Float64Array(buf, colsOff, 3 * W).set(/** @type {Float64Array} */ (cols));
  const pbOff = base;
  const colsPtr = aligned ? colsOff : 0;
  return {
    bytes: end - base,
    /**
     * composite device row py, pixels xa..xb (coverage cov[xa..xb], clip clip[py*W + x] or null, pixels data),
     * with the row's (aligned) Y0, Y1, ty. Returns false (nothing written) when the span is out of range.
     * @param {number} py @param {number} xa @param {number} xb @param {ArrayLike<number>} cov
     * @param {Uint8Array | null} clip @param {Uint8ClampedArray} data @param {number[] | null} row
     */
    run(py, xa, xb, cov, clip, data, row) {
      if (mem.buffer !== buf) return false; // the memory moved (never in the kernel): the caller uses JS
      if (!int(py) || !int(xa) || !int(xb) || xb < xa || xb > W) return false;
      const n = xb - xa;
      if (n === 0) return true;
      if (aligned) {
        if (!row || row.length !== 3 || !row.every(finite)) return false;
        pb[PB.Y0 / 8] = row[0];
        pb[PB.Y1 / 8] = row[1];
        pb[PB.ty / 8] = row[2];
      }
      const p0 = (py * W + xa) * 4;
      if (p0 < 0 || p0 + 4 * n > data.length || cov.length < xb) return false;
      covView.set(cov.subarray ? /** @type {Float32Array} */ (cov).subarray(xa, xb) : Array.from(cov).slice(xa, xb));
      let clipPtr = 0;
      if (clip) {
        if (clip.length < py * W + xb) return false;
        clipView.set(clip.subarray(py * W + xa, py * W + xb));
        clipPtr = clipOff;
      }
      pixView.set(data.subarray(p0, p0 + 4 * n));
      if (aligned) k.tile_aligned(pixOff, n, covOff, clipPtr, colsPtr, cellOff, pbOff, xa);
      else k.tile_affine(pixOff, n, covOff, clipPtr, cellOff, pbOff, xa, py + 0.5);
      data.set(pixView.subarray(0, 4 * n), p0);
      return true;
    },
  };
}

/**
 * x % y exactly as JS (the kernel's fmod), for tests and checks. NaN for a non-finite x or a zero y.
 * @param {any} k @param {number} x @param {number} y
 */
export function tileFmod(k, x, y) {
  return k.tile_fmod(x, y);
}
