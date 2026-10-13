// The tiling sampler in the kernel (kernel-tiling.wat, wasm-tiling.js) against the JS closure of render.js tiling():
// the same composited bytes, the same walk state across spans, and a fallback (null) for anything off.
import { describe, it, expect } from 'vitest';
import { KERNEL_BASE64 } from '../src/render/kernel.js';
import { tilingRows, tileFmod } from '../src/render/wasm-tiling.js';

const bin = Buffer.from(KERNEL_BASE64, 'base64');
const kernelExports = new WebAssembly.Instance(new WebAssembly.Module(bin)).exports;
const BASE = 1 << 20; // a free region in the kernel's fixed memory (no fill runs in these tests)

// deterministic PRNG
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];

/** JS reference: fmod through the JS % operator (the closure's own) */
const jsWrap = (u, step, k, n) => {
  u %= step;
  if (u < 0) u += step;
  let f = u * k - 0.5;
  if (f >= n - 0.5) f -= n;
  return f;
};

/**
 * the JS closure of render.js tiling() (sampler + paintWith's per-pixel composite), verbatim in its operations
 * @param {any} P
 */
function reference(P) {
  const { W, cw, ch, cell: c, aligned, im, xs, ys, kx, ky, bx0, by0, dFX, dFY, alpha, col } = P;
  const cr = [0, 0, 0],
    rr = [0, 0, 0];
  const colAt = (u, r) => {
    u %= xs;
    if (u < 0) u += xs;
    const fx = u * kx - 0.5,
      x0 = Math.floor(fx);
    ((r[0] = (x0 + cw) % cw), (r[1] = (x0 + 1 + cw) % cw), (r[2] = fx - x0));
  };
  const rowAt = (v, r) => {
    v %= ys;
    if (v < 0) v += ys;
    const fy = v * ky - 0.5,
      y0 = Math.floor(fy);
    ((r[0] = ((y0 + ch) % ch) * cw), (r[1] = ((y0 + 1 + ch) % ch) * cw), (r[2] = fy - y0));
  };
  let cols = null;
  if (aligned) {
    cols = new Float64Array(W * 3);
    for (let x = 0; x < W; x++) (colAt(im[0] * (x + 0.5) + im[4] - bx0, cr), cols.set(cr, x * 3));
  }
  let lastY = NaN,
    lastX = NaN,
    FX = 0,
    FY = 0;
  let lastRowY = NaN;
  const sample = (x, y, o) => {
    let X0, X1, tx, Y0, Y1, ty;
    if (aligned) {
      if (cols && x - 0.5 === (((x - 0.5) | 0)) && x >= 0.5 && x < W) {
        const k = (x - 0.5) * 3;
        ((X0 = cols[k]), (X1 = cols[k + 1]), (tx = cols[k + 2]));
      } else (colAt(im[0] * x + im[4] - bx0, cr), (X0 = cr[0]), (X1 = cr[1]), (tx = cr[2]));
      if (y !== lastRowY) (rowAt(im[3] * y + im[5] - by0, rr), (lastRowY = y));
      ((Y0 = rr[0]), (Y1 = rr[1]), (ty = rr[2]));
    } else {
      if (y === lastY && x === lastX + 1) {
        ((FX += dFX), (FY += dFY));
        if (FX >= cw - 0.5) FX -= cw;
        if (FY >= ch - 0.5) FY -= ch;
        if (!(FX >= -0.5 && FX < cw - 0.5 && FY >= -0.5 && FY < ch - 0.5)) {
          FX = jsWrap(im[0] * x + im[2] * y + im[4] - bx0, xs, kx, cw);
          FY = jsWrap(im[1] * x + im[3] * y + im[5] - by0, ys, ky, ch);
        }
      } else {
        FX = jsWrap(im[0] * x + im[2] * y + im[4] - bx0, xs, kx, cw);
        FY = jsWrap(im[1] * x + im[3] * y + im[5] - by0, ys, ky, ch);
      }
      ((lastX = x), (lastY = y));
      if (!(FX >= -0.5 && FX < cw - 0.5 && FY >= -0.5 && FY < ch - 0.5)) return ((lastY = NaN), false);
      const x0 = Math.floor(FX),
        y0 = Math.floor(FY);
      ((tx = FX - x0), (ty = FY - y0));
      ((X0 = x0 < 0 ? cw - 1 : x0), (X1 = x0 + 1 >= cw ? 0 : x0 + 1));
      ((Y0 = (y0 < 0 ? ch - 1 : y0) * cw), (Y1 = (y0 + 1 >= ch ? 0 : y0 + 1) * cw));
    }
    const i00 = (Y0 + X0) * 4,
      i10 = (Y0 + X1) * 4,
      i01 = (Y1 + X0) * 4,
      i11 = (Y1 + X1) * 4;
    const w00 = (1 - tx) * (1 - ty),
      w10 = tx * (1 - ty),
      w01 = (1 - tx) * ty,
      w11 = tx * ty;
    const a = c[i00 + 3] * w00 + c[i10 + 3] * w10 + c[i01 + 3] * w01 + c[i11 + 3] * w11;
    if (a < 0.5) return false;
    if (col) ((o[0] = col[0]), (o[1] = col[1]), (o[2] = col[2]));
    else {
      const k = 255 / a;
      for (let q = 0; q < 3; q++)
        o[q] = (c[i00 + q] * w00 + c[i10 + q] * w10 + c[i01 + q] * w01 + c[i11 + q] * w11) * k;
    }
    o[3] = a / 255;
    return true;
  };
  // paintWith's per-pixel composite
  const PX8 = new Uint8ClampedArray(4),
    PX32 = new Uint32Array(PX8.buffer);
  const o = [0, 0, 0, 1];
  return {
    /** one span, as paintWith's fill callback does it */
    row(py, xa, xb, cov, clip, data32, data) {
      for (let x = xa; x < xb; x++) {
        const p = (py * W + x) * 4;
        let a = cov[x] * alpha;
        if (clip) a *= clip[py * W + x] / 255;
        if (a <= 0) continue;
        if (!sample(x + 0.5, py + 0.5, o)) continue;
        a *= o[3];
        if (a <= 0) continue;
        if (a >= 1) {
          ((PX8[0] = o[0]), (PX8[1] = o[1]), (PX8[2] = o[2]), (PX8[3] = 255));
          data32[p >> 2] = PX32[0];
          continue;
        }
        data[p] += (o[0] - data[p]) * a;
        data[p + 1] += (o[1] - data[p + 1]) * a;
        data[p + 2] += (o[2] - data[p + 2]) * a;
        if (data[p + 3] < 255) data[p + 3] += (255 - data[p + 3]) * a;
      }
    },
  };
}

const same = (a, b) =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

describe('tile_fmod is the JS %', () => {
  it('10k random and extreme values, bit for bit', () => {
    const vals = [0, -0, 1, -1, 0.5, 5e-324, -5e-324, 2.2250738585072014e-308, 1e308, -1e308, Number.MAX_VALUE,
      1e-300, 3, 0.1, 1e15 + 0.5, 2 ** 53];
    const bad = [];
    for (let i = 0; i < 10000; i++) {
      const pow = (rnd() * 1400 - 700) | 0;
      const x = i < 2000 ? (rnd() - 0.5) * 2 ** pow : pick(vals) * (rnd() < 0.5 ? 1 : -1) * (1 + rnd() * 3);
      const y = i % 3 === 0 ? pick(vals.filter((v) => v > 0)) : rnd() * 2 ** ((rnd() * 60) | 0) + 1e-9;
      if (!(y > 0) || !Number.isFinite(y)) continue;
      const want = x % y;
      const got = tileFmod(kernelExports, x, y);
      if (!Object.is(got, want) && !(Number.isNaN(got) && Number.isNaN(want))) bad.push([x, y, want, got]);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });
  it('non-finite x and zero y give NaN (as JS)', () => {
    for (const [x, y] of [[Infinity, 2], [-Infinity, 2], [NaN, 2], [3, 0]])
      expect(Number.isNaN(tileFmod(kernelExports, x, y))).toBe(true);
  });
});

describe('tilingRows: byte-identical to the JS closure', () => {
  // one random case: a cell, a matrix (aligned or not), spans over a page; the reference and the kernel both walk it
  const caseOf = (i) => {
    const W = 3 + Math.floor(rnd() * 40),
      H = 2 + Math.floor(rnd() * 12);
    const cw = 1 + Math.floor(rnd() * 24),
      ch = 1 + Math.floor(rnd() * 24);
    const cell = new Uint8ClampedArray(cw * ch * 4);
    for (let j = 0; j < cell.length; j++) cell[j] = rnd() < 0.3 ? 0 : Math.floor(rnd() * 256);
    const aligned = rnd() < 0.5;
    const scale = pick([1, 0.5, 3, 1e-3, 1e3, 1e6]);
    const xs = pick([1, 2.5, 7, 1e-4, 1e6]) * (0.5 + rnd()) * scale;
    const ys = pick([1, 3, 0.25, 1e-4]) * (0.5 + rnd());
    const im = aligned
      ? [rnd() * 2 - 1, 0, 0, rnd() * 2 - 1, rnd() * 40 - 20, rnd() * 40 - 20]
      : [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 40 - 20, rnd() * 40 - 20];
    im.forEach((v, j) => (im[j] = v === 0 && rnd() < 0.5 ? 1e-9 : v));
    const kx = (cw / xs) * (rnd() < 0.5 ? 1 : 1.0000001),
      ky = ch / ys;
    const bx0 = rnd() * 4 - 2,
      by0 = rnd() * 4 - 2;
    const dFX = rnd() < 0.5 ? 0 : ((rnd() * 2 - 1) * cw) / 7;
    const dFY = rnd() < 0.5 ? 0 : ((rnd() * 2 - 1) * ch) / 5;
    const col = rnd() < 0.5 ? null : [rnd() * 255, rnd() * 255, rnd() * 255];
    const alpha = pick([1, 0.5, rnd(), 0.0001]);
    // pixel data, coverage, clip per row
    const rows = [];
    const page = new Uint8ClampedArray(W * H * 4);
    for (let j = 0; j < page.length; j++) page[j] = Math.floor(rnd() * 256);
    for (let y = 0; y < H; y++) {
      const spans = [];
      const rowCov = new Float32Array(W); // a full row indexed by device x, as fill passes it
      let x = 0;
      while (x < W) {
        const xb = Math.min(W, x + 1 + Math.floor(rnd() * W));
        for (let q = x; q < xb; q++) rowCov[q] = pick([0, 1, 0.5, rnd(), rnd(), 1e-6]);
        spans.push({ xa: x, xb, cov: rowCov });
        x = xb + (rnd() < 0.2 ? 1 : 0);
      }
      rows.push(spans);
    }
    const clip = rnd() < 0.5 ? null : Uint8Array.from({ length: W * H }, () => Math.floor(rnd() * 256));
    return { W, H, cw, ch, cell, aligned, im, xs, ys, kx, ky, bx0, by0, dFX, dFY, col, alpha, page, rows, clip };
  };

  it('200 random cells and matrices, spans in order (walk state crosses spans): same bytes', () => {
    const mismatches = [];
    let wasmCases = 0,
      painted = 0;
    for (let i = 0; i < 200; i++) {
      const cs = caseOf(i);
      const { W, H, cw, ch } = cs;
      const P = { ...cs, cols: null };
      const ref = reference(P);
      const refData = cs.page.slice(),
        refData32 = new Uint32Array(refData.buffer);
      wasmCases++;
      const wData = cs.page.slice();
      const K = kernelExports;
      // the aligned column table, as the closure builds it (the JS side computes it, once)
      let cols = null;
      if (cs.aligned) {
        cols = new Float64Array(W * 3);
        const cr = [0, 0, 0];
        for (let x = 0; x < W; x++) {
          const u0 = cs.im[0] * (x + 0.5) + cs.im[4] - cs.bx0;
          let u = u0 % cs.xs;
          if (u < 0) u += cs.xs;
          const fx = u * cs.kx - 0.5,
            x0 = Math.floor(fx);
          cr[0] = (x0 + cw) % cw;
          cr[1] = (x0 + 1 + cw) % cw;
          cr[2] = fx - x0;
          cols.set(cr, x * 3);
        }
      }
      const K2 = tilingRows(K, BASE, {
        W, cw, ch, cell: cs.cell, aligned: cs.aligned, cols, im: cs.im, xs: cs.xs, ys: cs.ys, kx: cs.kx, ky: cs.ky,
        bx0: cs.bx0, by0: cs.by0, dFX: cs.dFX, dFY: cs.dFY, alpha: cs.alpha, col: cs.col,
      });
      expect(K2).not.toBeNull();
      for (let py = 0; py < H; py++) {
        const rr = [0, 0, 0];
        if (cs.aligned) {
          const v = cs.im[3] * (py + 0.5) + cs.im[5] - cs.by0;
          let w = v % cs.ys;
          if (w < 0) w += cs.ys;
          const fy = w * cs.ky - 0.5,
            y0 = Math.floor(fy);
          rr[0] = ((y0 + ch) % ch) * cw;
          rr[1] = ((y0 + 1 + ch) % ch) * cw;
          rr[2] = fy - y0;
        }
        for (const sp of cs.rows[py]) {
          // the reference's span composite (its coverage indexed from xa)
          const cov = sp.cov;
          ref.row(py, sp.xa, sp.xb, cov, cs.clip, refData32, refData);
          const ok = K2.run(py, sp.xa, sp.xb, cov, cs.clip, wData, cs.aligned ? rr : null);
          expect(ok).toBe(true);
        }
      }
      if (!same(refData, wData)) mismatches.push(i);
      if (!same(refData, cs.page)) painted++;
    }
    expect(mismatches).toEqual([]);
    expect(wasmCases).toBe(200);
    expect(painted).toBeGreaterThanOrEqual(120); // the comparison is not of untouched pages
  });

  it('a tiny XStep (a huge column count per period) and an overflowing matrix: same bytes or null', () => {
    const cell = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 9, 9, 9, 255, 1, 2, 3, 255]);
    for (const xs of [1e-300, 5e-324, 1e-12]) {
      const t = tilingRows(kernelExports, BASE, {
        W: 8, cw: 2, ch: 2, cell, aligned: true, cols: new Float64Array(24), im: [1, 0, 0, 1, 0, 0], xs, ys: 1,
        kx: 2 / xs, ky: 2, bx0: 0, by0: 0, dFX: 0, dFY: 0, alpha: 1, col: null,
      });
      // a non-finite kx (the reciprocal overflows) is refused; a finite one is used
      expect(t === null || typeof t.run === 'function').toBe(true);
    }
    expect(
      tilingRows(kernelExports, BASE, {
        W: 8, cw: 2, ch: 2, cell, aligned: false, im: [1, 0, 0, 1, 0, 0], xs: 1, ys: 1, kx: Infinity, ky: 1,
        bx0: 0, by0: 0, dFX: 0, dFY: 0, alpha: 1, col: null,
      }),
    ).toBeNull();
  });
});

describe('tilingRows: anything off falls back (null), nothing is written', () => {
  const cell = new Uint8ClampedArray(2 * 2 * 4);
  const good = {
    W: 4, cw: 2, ch: 2, cell, aligned: false, im: [1, 0, 0, 1, 0, 0], xs: 2, ys: 2, kx: 1, ky: 1, bx0: 0, by0: 0,
    dFX: 0, dFY: 0, alpha: 1, col: null,
  };
  const refuse = (patch, base = BASE) => tilingRows(kernelExports, base, { ...good, ...patch });
  it('valid input is accepted', () => expect(refuse({})).not.toBeNull());
  it('NaN / Infinity in the matrix, steps, offsets, alpha or colour', () => {
    expect(refuse({ im: [NaN, 0, 0, 1, 0, 0] })).toBeNull();
    expect(refuse({ im: [1, 0, 0, Infinity, 0, 0] })).toBeNull();
    expect(refuse({ xs: Infinity })).toBeNull();
    expect(refuse({ ys: NaN })).toBeNull();
    expect(refuse({ xs: 0 })).toBeNull();
    expect(refuse({ kx: 0 })).toBeNull();
    expect(refuse({ bx0: NaN })).toBeNull();
    expect(refuse({ dFX: Infinity })).toBeNull();
    expect(refuse({ alpha: NaN })).toBeNull();
    expect(refuse({ col: [1, NaN, 2] })).toBeNull();
  });
  it('bad sizes and cell', () => {
    expect(refuse({ cw: 0 })).toBeNull();
    expect(refuse({ cw: 1.5 })).toBeNull();
    expect(refuse({ W: -1 })).toBeNull();
    expect(refuse({ cell: new Uint8ClampedArray(3) })).toBeNull();
    expect(refuse({ cw: 2048, ch: 2048 })).toBeNull(); // over the cell cap
  });
  it('aligned needs a finite column table of W × 3', () => {
    expect(refuse({ aligned: true, cols: null })).toBeNull();
    expect(refuse({ aligned: true, cols: new Float64Array(5) })).toBeNull();
    expect(refuse({ aligned: true, cols: new Float64Array(12).fill(NaN) })).toBeNull();
  });
  it('the region must be aligned, positive and inside the memory', () => {
    expect(refuse({}, 0)).toBeNull();
    expect(refuse({}, 3)).toBeNull();
    expect(refuse({}, 64 * 1024 * 1024 - 8)).toBeNull();
  });
  it('a span out of range is refused by run (nothing written)', () => {
    const t = refuse({});
    const data = new Uint8ClampedArray(4 * 4 * 4).fill(7);
    const cov = new Float32Array(4).fill(1);
    expect(t.run(0, 3, 2, cov, null, data, null)).toBe(false);
    expect(t.run(0, 0, 5, cov, null, data, null)).toBe(false);
    expect(t.run(0.5, 0, 2, cov, null, data, null)).toBe(false);
    expect(data.every((v) => v === 7)).toBe(true);
  });
});
