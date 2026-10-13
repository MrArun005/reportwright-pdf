// @ts-check
import { fail } from '../reader/budget.js';
import { kernel, reserve } from './wasm.js';
/**
 * The rasterizer: polygons (device pixels, y down) → anti-aliased coverage, a row at a time, by exact signed-area
 * accumulation (non-zero; even-odd folds the winding); axis-aligned rectangles directly. Coverage is handed to the
 * caller per row in spans of nonzero coverage (it composites), never held whole.
 * Also the stroker (width, caps, joins, miter limit, dashes) and curve flattening: strokes become polygons filled
 * non-zero, each one turned to positive winding so their union is the stroke.
 */

/** the most points one fill, stroke or flattening may make, and dash pieces one stroke may make */
export const MAX_POINTS = 4_000_000,
  MAX_DASHES = 100_000;

/** a reusable rasterizer for a W × H device @param {number} W @param {number} H */
/** tick: a budget step per row (time limits hold inside one huge fill) @param {(n: number) => void} [tick] */
/** wasm: false keeps to JS (the kernel, where there is one, gives the same coverage) */
export function rasterizer(W, H, tick = () => {}, wasm = true) {
  const covJs = new Float32Array(W + 1);
  /**
   * Fill polygons (each [x0, y0, x1, y1, …], closed implicitly). span(y, x0, x1, cov) gets each row's coverage 0–1
   * for x0 ≤ x < x1. @param {ArrayLike<number>[]} polys @param {boolean} evenOdd
   * @param {(y: number, x0: number, x1: number, cov: Float32Array) => void} span
   */
  function fill(polys, evenOdd, span) {
    if (polys.length === 1 && fillRect(polys[0], span)) return;
    fillNonZero(polys, span, !!evenOdd);
  }
  /** each band row's first and last touched cell */
  let rmin = new Int32Array(0),
    rmax = new Int32Array(0);
  /** the accumulation buffer: a band of rows, reused (at most BAND floats, whatever the page) */
  let acc = new Float32Array(0);
  /**
   * Non-zero fills by signed-area accumulation (as font-rs): each edge adds its exact area to the cells it crosses,
   * a row's running sum is its winding coverage, clamped to 1. No sorting, no sub-scanlines; a band of rows at a time.
   * @param {ArrayLike<number>[]} polys @param {(y: number, x0: number, x1: number, cov: Float32Array) => void} span
   */
  function fillNonZero(polys, span, evenOdd = false) {
    const cov = covJs;
    let total = 0;
    for (const p of polys) total += p.length >> 1;
    tick(1 + polys.length + (total >> 2)); // edge setup, before it is done
    if (total > MAX_POINTS) fail('E_BUDGET', `A fill has more than ${MAX_POINTS.toLocaleString('en')} points`);
    const k = wasm ? kernel() : null;
    if (k && !k.busy) {
      // the most this fill can need: segments, a band's cells, its row bounds, a coverage row and its spans
      const need = k.base + total * 40 + BAND * 4 + 8 * Math.min(H, BAND) + (W + 1) * 4 + (W + 2) * 8 + 64;
      if (reserve(k, need)) {
        k.busy = true;
        try {
          return fillWasm(k, polys, span, evenOdd, total, need);
        } finally {
          ((k.busy = false), (k.used = 0));
        }
      }
    }
    // segments (y down, top first): x0 y0 x1 y1 dir
    const S = new Float64Array(total * 5);
    let ns = 0,
      minx = Infinity,
      maxx = -Infinity,
      miny = Infinity,
      maxy = -Infinity;
    for (const p of polys) {
      const n = p.length >> 1;
      if (n < 2) continue;
      for (let i = 0; i < n; i++) {
        let x0 = p[2 * i],
          y0 = p[2 * i + 1],
          x1 = p[2 * ((i + 1) % n)],
          y1 = p[2 * ((i + 1) % n) + 1];
        if (!(Number.isFinite(x0) && Number.isFinite(y0) && Number.isFinite(x1) && Number.isFinite(y1))) continue;
        if (y0 === y1) continue;
        let d = 1;
        if (y0 > y1) ((d = x0), (x0 = x1), (x1 = d), (d = y0), (y0 = y1), (y1 = d), (d = -1));
        else d = 1;
        if (y1 <= 0 || y0 >= H) continue;
        const o = ns++ * 5;
        ((S[o] = x0), (S[o + 1] = y0), (S[o + 2] = x1), (S[o + 3] = y1), (S[o + 4] = d));
        if (x0 < minx) minx = x0;
        if (x1 < minx) minx = x1;
        if (x0 > maxx) maxx = x0;
        if (x1 > maxx) maxx = x1;
        if (y0 < miny) miny = y0;
        if (y1 > maxy) maxy = y1;
      }
    }
    if (!ns) return;
    const ox = Math.max(0, Math.floor(minx)),
      ex = Math.min(W, Math.ceil(maxx));
    if (ex <= ox) return; // all left of or right of the device (left of it covers nothing: winding starts at 0)
    const bw = ex - ox,
      stride = bw + 2;
    const r0 = Math.max(0, Math.floor(miny)),
      r1 = Math.min(H, Math.ceil(maxy));
    const rows = Math.max(1, Math.min(r1 - r0, Math.floor(BAND / stride)));
    if (acc.length < rows * stride) acc = new Float32Array(Math.min(BAND, Math.max(rows * stride, acc.length * 2)));
    const a = acc;
    for (let b0 = r0; b0 < r1; b0 += rows) {
      const b1 = Math.min(r1, b0 + rows);
      tick(1 + (ns >> 2) + (((b1 - b0) * stride) >> 6)); // the band's edges and cells, before the work
      a.fill(0, 0, (b1 - b0) * stride);
      if (rmin.length < b1 - b0) ((rmin = new Int32Array(rows)), (rmax = new Int32Array(rows)));
      rmin.fill(bw + 1, 0, b1 - b0);
      rmax.fill(-1, 0, b1 - b0);
      let cells = 0;
      for (let o = 0; o < ns * 5; o += 5) {
        const py0 = S[o + 1],
          py1 = S[o + 3];
        if (py1 <= b0 || py0 >= b1) continue;
        const px0 = S[o],
          dxdy = (S[o + 2] - px0) / (py1 - py0),
          dir = S[o + 4];
        const ya = Math.max(b0, Math.floor(py0)),
          yb = Math.min(b1, Math.ceil(py1));
        tick(1 + ((yb - ya) >> 3));
        for (let y = ya; y < yb; y++) {
          const t0 = y > py0 ? y : py0,
            t1 = y + 1 < py1 ? y + 1 : py1,
            dy = t1 - t0;
          if (dy <= 0) continue;
          let x = px0 + (t0 - py0) * dxdy - ox,
            xn = px0 + (t1 - py0) * dxdy - ox;
          // left of the window: the window's edge (the winding there is what counts); right: the spare cell
          x = x < 0 ? 0 : x > bw ? bw : x;
          xn = xn < 0 ? 0 : xn > bw ? bw : xn;
          const d = dy * dir,
            ls = (y - b0) * stride;
          const xl = x < xn ? x : xn,
            xr = x < xn ? xn : x;
          const xlf = Math.floor(xl),
            xli = xlf | 0,
            xri = Math.ceil(xr) | 0;
          cells += xri - xli;
          const ry = y - b0;
          if (xli < rmin[ry]) rmin[ry] = xli;
          if (xri + 1 > rmax[ry]) rmax[ry] = xri + 1;
          if (cells > 65536) (tick(cells >> 4), (cells = 0)); // a long, nearly flat edge crosses many cells
          if (xri <= xli + 1) {
            const xmf = 0.5 * (x + xn) - xlf;
            a[ls + xli] += d - d * xmf;
            a[ls + xli + 1] += d * xmf;
          } else {
            const sl = 1 / (xr - xl),
              x0f = xl - xlf,
              a0 = 0.5 * sl * (1 - x0f) * (1 - x0f),
              x1f = xr - xri + 1,
              am = 0.5 * sl * x1f * x1f;
            a[ls + xli] += d * a0;
            if (xri === xli + 2) a[ls + xli + 1] += d * (1 - a0 - am);
            else {
              const a1 = sl * (1.5 - x0f);
              a[ls + xli + 1] += d * (a1 - a0);
              for (let xi = xli + 2; xi < xri - 1; xi++) a[ls + xi] += d * sl;
              const a2 = a1 + (xri - xli - 3) * sl;
              a[ls + xri - 1] += d * (1 - a2 - am);
            }
            a[ls + xri] += d * am;
          }
        }
      }
      for (let y = b0; y < b1; y++) {
        const ls = (y - b0) * stride;
        const r0 = rmin[y - b0],
          r1 = Math.min(bw, rmax[y - b0] + 1);
        if (r0 > r1) continue; // no edge in this row: nothing (winding is 0 on both sides of the shapes)
        let run = 0,
          lo = -1,
          hi = -1;
        // the row's cells, only where edges touched it; each run of coverage handed on as its own span
        tick((r1 - r0) >> 4); // what the caller composites, at most
        let s0 = -1;
        for (let i = r0; i < r1; i++) {
          const ai = a[ls + i];
          if (ai === 0 && s0 < 0 && run === 0) continue; // outside the shapes, nothing added
          run += ai;
          let c = run < 0 ? -run : run;
          if (evenOdd) {
            // even-odd: the winding folded to 0–1 (exact where edges do not overlap within a pixel)
            c -= 2 * Math.floor(c / 2);
            if (c > 1) c = 2 - c;
          } else if (c > 1) c = 1;
          if (c < 1e-6) {
            if (s0 >= 0) (span(y, ox + s0, ox + i, cov), (s0 = -1));
            continue;
          }
          if (lo < 0) lo = i;
          if (s0 < 0) s0 = i;
          if (c === 1 && !evenOdd && a[ls + i + 1] === 0) {
            // inside: the cells up to the next edge add nothing, all covered
            let j = i + 1;
            while (j < r1 && a[ls + j] === 0) j++;
            cov.fill(1, ox + i, ox + j);
            ((hi = j - 1), (i = j - 1));
            continue;
          }
          hi = i;
          cov[ox + i] = c;
        }
        if (s0 >= 0) span(y, ox + s0, ox + hi + 1, cov);
      }
    }
  }
  /**
   * fillNonZero through the kernel: the same segments, bands and charges; the cells and coverage worked out there
   * @param {any} k @param {ArrayLike<number>[]} polys @param {(y: number, x0: number, x1: number, cov: Float32Array) => void} span
   * @param {boolean} evenOdd @param {number} total @param {number} need
   */
  function fillWasm(k, polys, span, evenOdd, total, need) {
    const buf = k.memory.buffer,
      B = k.base; // after the row area (a multiple of 64)
    // segments at B (y down, top first): x0 y0 x1 y1 dir
    const S = new Float64Array(buf, B, total * 5);
    let ns = 0,
      minx = Infinity,
      maxx = -Infinity,
      miny = Infinity,
      maxy = -Infinity;
    for (const p of polys) {
      const n = p.length >> 1;
      if (n < 2) continue;
      for (let i = 0; i < n; i++) {
        let x0 = p[2 * i],
          y0 = p[2 * i + 1],
          x1 = p[2 * ((i + 1) % n)],
          y1 = p[2 * ((i + 1) % n) + 1];
        if (!(Number.isFinite(x0) && Number.isFinite(y0) && Number.isFinite(x1) && Number.isFinite(y1))) continue;
        if (y0 === y1) continue;
        let d = 1;
        if (y0 > y1) ((d = x0), (x0 = x1), (x1 = d), (d = y0), (y0 = y1), (y1 = d), (d = -1));
        else d = 1;
        if (y1 <= 0 || y0 >= H) continue;
        const o = ns++ * 5;
        ((S[o] = x0), (S[o + 1] = y0), (S[o + 2] = x1), (S[o + 3] = y1), (S[o + 4] = d));
        if (x0 < minx) minx = x0;
        if (x1 < minx) minx = x1;
        if (x0 > maxx) maxx = x0;
        if (x1 > maxx) maxx = x1;
        if (y0 < miny) miny = y0;
        if (y1 > maxy) maxy = y1;
      }
    }
    if (!ns) return;
    const ox = Math.max(0, Math.floor(minx)),
      ex = Math.min(W, Math.ceil(maxx));
    if (ex <= ox) return;
    const bw = ex - ox,
      stride = bw + 2;
    const r0 = Math.max(0, Math.floor(miny)),
      r1 = Math.min(H, Math.ceil(maxy));
    const rows = Math.max(1, Math.min(r1 - r0, Math.floor(BAND / stride)));
    // the regions after the segments, every one inside what was reserved (checked here, not trusted there)
    const A = B + total * 40,
      RMIN = A + rows * stride * 4,
      RMAX = RMIN + rows * 4,
      COV = RMAX + rows * 4,
      SP = COV + (W + 1) * 4,
      end = SP + (bw + 2) * 8;
    if (end > need || end > buf.byteLength || rows * stride > BAND + stride || ox + bw > W)
      fail('E_BUDGET', 'rasterizer: kernel regions out of bounds');
    // composited by the kernel (span.solid): each row's pixels (and clip) copied into its row area and back
    const so = /** @type {any} */ (span).solid,
      kr = k.rows,
      sk =
        so &&
        !evenOdd &&
        kr &&
        kr.w === W &&
        kr.buffer === buf &&
        so.data.length === W * H * 4 &&
        (!so.clip || so.clip.length === W * H)
          ? so
          : null;
    k.used = end; // span callbacks may take scratch past it (wasm.js scratch)
    const rmin = new Int32Array(buf, RMIN, rows),
      rmax = new Int32Array(buf, RMAX, rows),
      cov = new Float32Array(buf, COV, W + 1),
      sp = new Int32Array(buf, SP, (bw + 2) * 2);
    for (let b0 = r0; b0 < r1; b0 += rows) {
      const b1 = Math.min(r1, b0 + rows);
      // charged as fillNonZero charges: the band, each segment's rows, and (a bound on) the cells they cross
      let t = 1 + (ns >> 2) + (((b1 - b0) * stride) >> 6),
        cells = 0;
      for (let o = 0; o < ns * 5; o += 5) {
        const py0 = S[o + 1],
          py1 = S[o + 3];
        if (py1 <= b0 || py0 >= b1) continue;
        const n = Math.min(b1, Math.ceil(py1)) - Math.max(b0, Math.floor(py0));
        t += 1 + (n >> 3);
        cells += 2 * n + Math.abs(S[o + 2] - S[o]);
      }
      tick(t + (cells >> 4));
      k.band(B, ns, b0, b1, ox, bw, stride, A, RMIN, RMAX);
      for (let y = b0; y < b1; y++) {
        const ry = y - b0,
          lo = rmin[ry],
          hi = Math.min(bw, rmax[ry] + 1);
        if (lo > hi) continue;
        if (lo < 0 || hi > bw + 1) fail('E_BUDGET', 'rasterizer: kernel row out of bounds');
        tick((hi - lo) >> 4);
        if (sk && hi - lo >= 48) {
          // the row's pixels from ox + lo to ox + hi (every span is inside) in, composited, out
          const xa = ox + lo,
            xb = Math.min(W, ox + hi + 1),
            o = y * W;
          kr.pix.set(sk.data.subarray((o + xa) * 4, (o + xb) * 4), xa * 4);
          if (sk.clip) kr.clip.set(sk.clip.subarray(o + xa, o + xb), xa);
          k.rowsolid(
            A + ry * stride * 4,
            lo,
            hi,
            COV,
            ox,
            SP,
            kr.pixOff,
            W,
            0,
            sk.alpha,
            sk.r,
            sk.g,
            sk.b,
            sk.px,
            sk.opaque,
            sk.clip ? kr.clipOff : 0,
          );
          sk.data.set(kr.pix.subarray(xa * 4, xb * 4), (o + xa) * 4);
          continue;
        }
        const n = k.row(A + ry * stride * 4, lo, hi, evenOdd ? 1 : 0, COV, ox, SP);
        for (let i = 0; i < n; i++) span(y, sp[2 * i], sp[2 * i + 1], cov);
      }
    }
  }
  /**
   * an axis-aligned rectangle (4 corners, or 5 closed) → its rows, coverage exact (the area in each pixel)
   * @param {ArrayLike<number>} q @param {(y: number, x0: number, x1: number, cov: Float32Array) => void} span
   */
  function fillRect(q, span) {
    const n = q.length;
    if (n !== 8 && !(n === 10 && q[8] === q[0] && q[9] === q[1])) return false;
    let xa, xb, ya, yb;
    if (q[0] === q[6] && q[2] === q[4] && q[1] === q[3] && q[5] === q[7]) {
      ((xa = q[0]), (xb = q[2]), (ya = q[1]), (yb = q[5]));
    } else if (q[0] === q[2] && q[4] === q[6] && q[1] === q[7] && q[3] === q[5]) {
      ((xa = q[0]), (xb = q[4]), (ya = q[1]), (yb = q[3]));
    } else return false;
    if (!(Number.isFinite(xa) && Number.isFinite(xb) && Number.isFinite(ya) && Number.isFinite(yb))) return false;
    if (xa > xb) ((n0 = xa), (xa = xb), (xb = n0));
    if (ya > yb) ((n0 = ya), (ya = yb), (yb = n0));
    if (xa < 0) xa = 0;
    if (xb > W) xb = W;
    if (ya < 0) ya = 0;
    if (yb > H) yb = H;
    tick(2);
    if (!(xb > xa && yb > ya)) return true;
    const x0 = Math.floor(xa),
      x1 = Math.ceil(xb),
      y0 = Math.floor(ya),
      y1 = Math.ceil(yb);
    tick(2 + (y1 - y0) * (1 + ((x1 - x0) >> 4)) + (((y1 - y0) * (x1 - x0 + 2)) >> 6)); // as fillNonZero charges its band and spans, before the work
    let last = -1;
    // a page held in kernel memory: the coverage row there too (the kernel composites it); else this one
    const kr = wasm ? kernel()?.rows : null,
      cov = kr && kr.w === W && kr.buffer === kernel().memory.buffer && !kernel().busy ? kr.row : covJs;
    const ix0 = Math.ceil(xa),
      ix1 = Math.max(ix0, Math.floor(xb));
    for (let y = y0; y < y1; y++) {
      const fy = Math.min(y + 1, yb) - Math.max(y, ya);
      if (fy !== last) {
        for (let x = x0; x < x1; x++) cov[x] = (Math.min(x + 1, xb) - Math.max(x, xa)) * fy;
        last = fy;
      }
      // [ix0, ix1): whole pixels (coverage 1), when the row is whole vertically
      span(y, x0, x1, cov, fy === 1 ? ix0 : 0, fy === 1 ? ix1 : 0);
    }
    return true;
  }
  let n0 = 0;
  return { fill };
}
/** the most floats the accumulation band holds (4 MB) */
const BAND = 1 << 20;

/** a matrix [a b c d e f] times a point @param {ArrayLike<number>} m */
export const apply = (m, /** @type {number} */ x, /** @type {number} */ y) => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

/**
 * A path (ops: 0 x y moveTo, 1 x y lineTo, 2 x1 y1 x2 y2 x3 y3 curveTo, 3 close) flattened to polylines in its own
 * space; tol is the flatness in the same units. @param {number[]} p @param {number} tol
 * @returns {{ pts: number[], closed: boolean }[]}
 */
export function flatten(p, tol) {
  /** @type {{ pts: number[], closed: boolean }[]} */
  const out = [];
  /** @type {number[] | null} */ let cur = null;
  let x = 0,
    y = 0,
    sx = 0,
    sy = 0;
  const start = () => {
    if (!cur) {
      cur = [x, y];
      out.push({ pts: cur, closed: false });
    }
    return cur;
  };
  let made = 0;
  const room = (/** @type {number} */ n) => {
    if ((made += n) > MAX_POINTS)
      fail('E_BUDGET', `A path flattens to more than ${MAX_POINTS.toLocaleString('en')} points`);
  };
  for (let i = 0; i < p.length;) {
    const op = p[i++];
    room(1);
    if (op === 0) {
      x = sx = p[i++];
      y = sy = p[i++];
      cur = null;
      start();
    } else if (op === 1) {
      const c = start();
      x = p[i++];
      y = p[i++];
      c.push(x, y);
    } else if (op === 2) {
      const c = start();
      const [x1, y1, x2, y2, x3, y3] = [p[i], p[i + 1], p[i + 2], p[i + 3], p[i + 4], p[i + 5]];
      i += 6;
      const d = Math.hypot(x1 - x, y1 - y) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
      const n = Math.max(1, Math.min(100, Math.ceil(Math.sqrt(d / tol) * 0.6)) || 1);
      room(n); // before the points are made
      for (let k = 1; k <= n; k++) {
        const t = k / n,
          u = 1 - t;
        const a = u * u * u,
          b = 3 * u * u * t,
          cc = 3 * u * t * t,
          e = t * t * t;
        c.push(a * x + b * x1 + cc * x2 + e * x3, a * y + b * y1 + cc * y2 + e * y3);
      }
      x = x3;
      y = y3;
    } else if (op === 3) {
      if (cur) {
        out[out.length - 1].closed = true;
        x = sx;
        y = sy;
      }
      cur = null;
    } else break;
  }
  return out;
}

/** a polygon with positive (counter-clockwise in y-up) winding @param {number[]} p */
function positive(p) {
  let a = 0;
  for (let i = 0, n = p.length; i < n; i += 2) {
    const j = (i + 2) % n;
    a += p[i] * p[j + 1] - p[j] * p[i + 1];
  }
  if (a >= 0) return p;
  const r = [];
  for (let i = p.length - 2; i >= 0; i -= 2) r.push(p[i], p[i + 1]);
  return r;
}

/** a circle polygon, n sides @param {number} cx @param {number} cy @param {number} r @param {number} n */
function circle(cx, cy, r, n) {
  const p = [];
  for (let k = 0; k < n; k++) {
    const a = (2 * Math.PI * k) / n;
    p.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return p;
}

/**
 * Split polylines by a dash pattern. @param {{ pts: number[], closed: boolean }[]} lines @param {number[]} dash
 * @param {number} phase
 */
export function dashed(lines, dash, phase) {
  const total = dash.reduce((a, b) => a + b, 0);
  if (!(total > 0) || dash.some((d) => !(d >= 0))) return lines;
  /** @type {{ pts: number[], closed: boolean }[]} */
  const out = [];
  for (const { pts, closed } of lines) {
    const P = closed ? [...pts, pts[0], pts[1]] : pts;
    let i = 0,
      left = ((phase % total) + total) % total;
    while (left >= dash[i % dash.length] && dash[i % dash.length] >= 0) {
      left -= dash[i % dash.length];
      i++;
      if (i > 10000) break;
    }
    let on = i % 2 === 0,
      rem = dash[i % dash.length] - left;
    /** @type {number[] | null} */ let cur = on ? [P[0], P[1]] : null;
    let guard = 0;
    for (let k = 0; k + 3 < P.length; k += 2) {
      let x0 = P[k],
        y0 = P[k + 1];
      const x1 = P[k + 2],
        y1 = P[k + 3];
      let L = Math.hypot(x1 - x0, y1 - y0);
      while (L > rem) {
        if (++guard > MAX_DASHES)
          fail('E_BUDGET', `A dashed line makes more than ${MAX_DASHES.toLocaleString('en')} dashes`);
        const t = rem / L;
        x0 += (x1 - x0) * t;
        y0 += (y1 - y0) * t;
        L -= rem;
        if (on && cur) {
          cur.push(x0, y0);
          out.push({ pts: cur, closed: false });
          cur = null;
        } else cur = [x0, y0];
        on = !on;
        i++;
        rem = dash[i % dash.length];
      }
      rem -= L;
      if (on && cur) cur.push(x1, y1);
    }
    if (on && cur && cur.length >= 4) out.push({ pts: cur, closed: false });
  }
  return out;
}

/**
 * Stroke polylines into polygons to fill non-zero. hw: half the width; cap 0 butt 1 round 2 square; join 0 miter
 * 1 round 2 bevel; seg: sides of a full circle. @param {{ pts: number[], closed: boolean }[]} lines
 * @param {number} hw @param {number} cap @param {number} join @param {number} miter @param {number} seg
 */
export function stroke(lines, hw, cap, join, miter, seg) {
  /** @type {number[][]} */
  const out = [];
  let made = 0;
  const push = out.push.bind(out);
  // each piece is at most a seg-sided circle: the running total stops a stroke before its pieces pile up
  out.push = (/** @type {number[]} */ p) => {
    if ((made += p.length >> 1) > MAX_POINTS)
      fail('E_BUDGET', `A stroke expands to more than ${MAX_POINTS.toLocaleString('en')} points`);
    return push(p);
  };
  for (const line of lines) {
    // drop repeated points
    const q = [line.pts[0], line.pts[1]];
    for (let i = 2; i + 1 < line.pts.length; i += 2)
      if (Math.abs(line.pts[i] - q[q.length - 2]) > 1e-9 || Math.abs(line.pts[i + 1] - q[q.length - 1]) > 1e-9)
        q.push(line.pts[i], line.pts[i + 1]);
    const closed = line.closed && q.length > 4;
    if (closed && Math.abs(q[0] - q[q.length - 2]) < 1e-9 && Math.abs(q[1] - q[q.length - 1]) < 1e-9) q.length -= 2;
    const n = q.length >> 1;
    if (n === 1) {
      if (cap === 1) out.push(circle(q[0], q[1], hw, seg));
      else if (cap === 2)
        out.push([q[0] - hw, q[1] - hw, q[0] + hw, q[1] - hw, q[0] + hw, q[1] + hw, q[0] - hw, q[1] + hw]);
      continue;
    }
    const segs = closed ? n : n - 1;
    /** @type {number[]} unit directions per segment */
    const D = [];
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      const dx = q[2 * j] - q[2 * i],
        dy = q[2 * j + 1] - q[2 * i + 1],
        L = Math.hypot(dx, dy);
      D.push(dx / L, dy / L);
      const nx = (-dy / L) * hw,
        ny = (dx / L) * hw;
      out.push(
        positive([
          q[2 * i] + nx,
          q[2 * i + 1] + ny,
          q[2 * j] + nx,
          q[2 * j + 1] + ny,
          q[2 * j] - nx,
          q[2 * j + 1] - ny,
          q[2 * i] - nx,
          q[2 * i + 1] - ny,
        ]),
      );
    }
    // joins
    for (let v = closed ? 0 : 1; v < (closed ? n : n - 1); v++) {
      const a = (v - 1 + segs) % segs,
        b = v % segs;
      const d0x = D[2 * a],
        d0y = D[2 * a + 1],
        d1x = D[2 * b],
        d1y = D[2 * b + 1];
      const cross = d0x * d1y - d0y * d1x,
        dot = d0x * d1x + d0y * d1y;
      if (Math.abs(cross) < 1e-9 && dot > 0) continue;
      const x = q[2 * v],
        y = q[2 * v + 1];
      if (join === 1) {
        out.push(circle(x, y, hw, seg));
        continue;
      }
      const s = cross > 0 ? -1 : 1;
      const p0x = x - s * d0y * hw,
        p0y = y + s * d0x * hw,
        p1x = x - s * d1y * hw,
        p1y = y + s * d1x * hw;
      const ratio = 1 / Math.sqrt(Math.max(1e-12, (1 + dot) / 2));
      if (join === 0 && ratio <= miter) {
        let mx = -d0y - d1y,
          my = d0x + d1x;
        const m = Math.hypot(mx, my) || 1;
        mx = (mx / m) * s * hw * ratio;
        my = (my / m) * s * hw * ratio;
        out.push(positive([x, y, p0x, p0y, x + mx, y + my, p1x, p1y]));
      } else out.push(positive([x, y, p0x, p0y, p1x, p1y]));
    }
    if (!closed && cap) {
      for (const [i, dx, dy] of [
        [0, -D[0], -D[1]],
        [n - 1, D[2 * segs - 2], D[2 * segs - 1]],
      ]) {
        const x = q[2 * i],
          y = q[2 * i + 1];
        if (cap === 1) out.push(circle(x, y, hw, seg));
        else {
          const nx = -dy * hw,
            ny = dx * hw,
            ex = dx * hw,
            ey = dy * hw;
          out.push(positive([x + nx, y + ny, x + nx + ex, y + ny + ey, x - nx + ex, y - ny + ey, x - nx, y - ny]));
        }
      }
    }
  }
  return out;
}
