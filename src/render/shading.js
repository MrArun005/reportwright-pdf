// @ts-check
/**
 * Shadings (ISO 32000-1 §8.7.4.5), compiled once per document into what the painter samples, in shading space:
 * types 1 (function-based), 2 (axial) and 3 (radial) as a colour at a point; types 4 and 5 (Gouraud triangle meshes),
 * 6 (Coons) and 7 (tensor-product patches) as triangles with RGB at their corners (patches are split into a grid of
 * 3–20 × 3–20 cells, as pdf.js does, by their share of the mesh). Colours are converted to RGB at the vertices and
 * interpolated, as pdf.js does; axial and radial shadings read a 1,024-entry table of their function, function-based
 * ones a 128 × 128 grid of it (bilinear).
 *
 * HOSTILE: a mesh has at most MAX_VERTICES vertices (counted from its data length before any is read) and at most
 * MAX_PATCHES patches, and its triangles (patch grids included) are at most MAX_TRIANGLES, decided before they are
 * made; functions are bounded (functions.js); every vertex and evaluation is a budget step.
 */
import { PdfStream } from '../reader/lexer.js';
import { compile } from './functions.js';
import { loadedKernel } from './wasm.js';

export const MAX_VERTICES = 1_000_000,
  MAX_PATCHES = 100_000,
  MAX_TRIANGLES = 500_000,
  LUT = 1024,
  /** a function-based shading's samples a side */
  GRID = 128;

const bad = (/** @type {string} */ m) => new TypeError(`shading: ${m}`);

/**
 * @param {any} obj a shading dictionary or stream
 * @param {{ R: (v: any) => any, data: (s: PdfStream) => Uint8Array, tick: (n: number) => void, space: (v: any) => any }} ctx
 * @returns {any} { type, bbox, background, at?(x, y, out) → boolean, tris?: Float64Array (x y r g b per vertex) } or null
 */
export function compileShading(obj, ctx) {
  const { R } = ctx;
  obj = R(obj);
  const d = obj instanceof PdfStream ? obj.dict : obj;
  if (!(d instanceof Map)) return null;
  const type = R(d.get('ShadingType'));
  const cs = ctx.space(d.get('ColorSpace'));
  if (!cs) return null;
  const arr = (/** @type {string} */ k) => {
    const v = R(d.get(k));
    return Array.isArray(v)
      ? v.map((x) => R(x)).map((x) => (typeof x === 'number' ? x : typeof x === 'boolean' ? x : 0))
      : null;
  };
  const fn = d.has('Function') ? compile(d.get('Function'), ctx) : null;
  if (d.has('Function') && !fn) return null;
  const rgb = (/** @type {number[]} */ c) => cs.rgb(fn ? fn(c) : c).map((/** @type {number} */ v) => v * 255);
  const bg = arr('Background');
  const bb = arr('BBox');
  const out = {
    type,
    background: bg && bg.length >= cs.n ? cs.rgb(bg).map((/** @type {number} */ v) => v * 255) : null,
    bbox:
      bb && bb.length >= 4
        ? [Math.min(bb[0], bb[2]), Math.min(bb[1], bb[3]), Math.max(bb[0], bb[2]), Math.max(bb[1], bb[3])]
        : null,
  };

  if (type === 1) {
    if (!fn) return null;
    const dom = arr('Domain') ?? [0, 1, 0, 1];
    const m = arr('Matrix') ?? [1, 0, 0, 1, 0, 0];
    const det = m[0] * m[3] - m[1] * m[2];
    if (!det) return null;
    ctx.tick(GRID * GRID); // the function sampled once, before it is
    const grid = new Float32Array(GRID * GRID * 3);
    for (let j = 0; j < GRID; j++)
      for (let i = 0; i < GRID; i++) {
        const c = rgb([dom[0] + ((dom[1] - dom[0]) * i) / (GRID - 1), dom[2] + ((dom[3] - dom[2]) * j) / (GRID - 1)]);
        grid.set(c.slice(0, 3), (j * GRID + i) * 3);
      }
    const im = [
      m[3] / det,
      -m[1] / det,
      -m[2] / det,
      m[0] / det,
      (m[2] * m[5] - m[3] * m[4]) / det,
      (m[1] * m[4] - m[0] * m[5]) / det,
    ];
    return {
      ...out,
      /** @param {number} x @param {number} y @param {number[]} o */
      at(x, y, o) {
        const u = im[0] * x + im[2] * y + im[4],
          v = im[1] * x + im[3] * y + im[5];
        if (u < dom[0] || u > dom[1] || v < dom[2] || v > dom[3]) return false;
        // bilinear in a GRID × GRID table of the function over its domain (as pdf.js samples it)
        const gu = ((u - dom[0]) / (dom[1] - dom[0] || 1)) * (GRID - 1),
          gv = ((v - dom[2]) / (dom[3] - dom[2] || 1)) * (GRID - 1);
        const i = Math.min(GRID - 2, gu | 0),
          j = Math.min(GRID - 2, gv | 0),
          fu = gu - i,
          fv = gv - j;
        const p = (j * GRID + i) * 3,
          q = p + GRID * 3;
        for (let k = 0; k < 3; k++)
          o[k] =
            (grid[p + k] * (1 - fu) + grid[p + 3 + k] * fu) * (1 - fv) +
            (grid[q + k] * (1 - fu) + grid[q + 3 + k] * fu) * fv;
        return true;
      },
    };
  }
  if (type === 2 || type === 3) {
    const c = arr('Coords');
    if (!c || c.length < (type === 2 ? 4 : 6)) return null;
    const [t0, t1] = arr('Domain') ?? [0, 1];
    const ext = arr('Extend') ?? [false, false];
    const e0 = ext[0] === true,
      e1 = ext[1] === true;
    // the function as a table of RGB over t0..t1
    ctx.tick(LUT);
    const lut = new Float32Array(LUT * 3);
    for (let i = 0; i < LUT; i++) {
      const v = rgb([t0 + ((t1 - t0) * i) / (LUT - 1)]);
      ((lut[3 * i] = v[0]), (lut[3 * i + 1] = v[1]), (lut[3 * i + 2] = v[2]));
    }
    const put = (/** @type {number} */ s, /** @type {number[]} */ o) => {
      const i = Math.round((s < 0 ? 0 : s > 1 ? 1 : s) * (LUT - 1)) * 3;
      ((o[0] = lut[i]), (o[1] = lut[i + 1]), (o[2] = lut[i + 2]));
      return true;
    };
    /** fill buf (r g b ok per pixel) for device pixels xa..xb of row y; s(u, v) is the gradient position or NaN */
    // the table again as opaque device pixels (entry LUT is the Background), for spans written whole
    const px8 = new Uint8ClampedArray((LUT + 1) * 4),
      px = new Uint32Array(px8.buffer),
      bgc = out.background;
    const lutAll = new Float32Array((LUT + 1) * 3);
    lutAll.set(lut);
    if (bgc) lutAll.set(bgc.slice(0, 3), LUT * 3);
    for (let k = 0; k <= LUT; k++)
      ((px8[4 * k] = lutAll[3 * k]),
        (px8[4 * k + 1] = lutAll[3 * k + 1]),
        (px8[4 * k + 2] = lutAll[3 * k + 2]),
        (px8[4 * k + 3] = 255));
    /** fill idx with a table entry per device pixel xa..xb of row y (−1: not painted); s(u, v) is the position or NaN */
    const spanOf =
      (/** @type {(u: number, v: number) => number} */ s) =>
      (
        /** @type {number[]} */ im,
        /** @type {number} */ xa,
        /** @type {number} */ xb,
        /** @type {number} */ y,
        /** @type {number[] | null} */ bb,
        /** @type {boolean} */ useBg,
        /** @type {Int32Array} */ idx,
      ) => {
        const yc = y + 0.5;
        for (let x = xa, k = 0; x < xb; x++, k++) {
          const xc = x + 0.5,
            u = im[0] * xc + im[2] * yc + im[4],
            v = im[1] * xc + im[3] * yc + im[5];
          if (bb && (u < bb[0] || u > bb[2] || v < bb[1] || v > bb[3])) idx[k] = -1;
          else {
            const t = s(u, v);
            idx[k] = t === t ? Math.round((t < 0 ? 0 : t > 1 ? 1 : t) * (LUT - 1)) : useBg ? LUT : -1;
          }
        }
      };
    if (type === 2) {
      const [x0, y0, x1, y1] = c,
        dx = x1 - x0,
        dy = y1 - y0,
        L = dx * dx + dy * dy;
      const slow = spanOf((u, v) => {
        const s = L ? ((u - x0) * dx + (v - y0) * dy) / L : 0;
        return (s < 0 && !e0) || (s > 1 && !e1) ? NaN : s;
      });
      return {
        ...out,
        lut: lutAll,
        grad: { c, e0, e1 }, // for a canvas's own gradients
        px,
        // t is linear along a row: one add per pixel
        span(
          /** @type {number[]} */ im,
          /** @type {number} */ xa,
          /** @type {number} */ xb,
          /** @type {number} */ y,
          /** @type {number[] | null} */ bb,
          /** @type {boolean} */ useBg,
          /** @type {Int32Array} */ idx,
        ) {
          if (bb) return slow(im, xa, xb, y, bb, useBg, idx);
          const yc = y + 0.5,
            xc = xa + 0.5,
            u = im[0] * xc + im[2] * yc + im[4],
            v = im[1] * xc + im[3] * yc + im[5],
            k = L ? 1 / L : 0,
            dt = (im[0] * dx + im[1] * dy) * k,
            n = LUT - 1,
            out = useBg ? LUT : -1;
          let t = ((u - x0) * dx + (v - y0) * dy) * k;
          for (let i = 0, m = xb - xa; i < m; i++, t += dt)
            idx[i] = t < 0 ? (e0 ? 0 : out) : t > 1 ? (e1 ? n : out) : (t * n + 0.5) | 0;
        },
        /** @param {number} x @param {number} y @param {number[]} o */
        at(x, y, o) {
          const s = L ? ((x - x0) * dx + (y - y0) * dy) / L : 0;
          if ((s < 0 && !e0) || (s > 1 && !e1)) return false;
          return put(s, o);
        },
      };
    }
    const [x0, y0, r0, x1, y1, r1] = c;
    const cdx = x1 - x0,
      cdy = y1 - y0,
      dr = r1 - r0,
      a = cdx * cdx + cdy * cdy - dr * dr;
    const ok = (/** @type {number} */ s) => r0 + s * dr >= 0 && (s >= 0 || e0) && (s <= 1 || e1);
    /** the gradient position at (x, y), or NaN */
    const pos = (/** @type {number} */ x, /** @type {number} */ y) => {
      const px = x - x0,
        py = y - y0;
      const b = px * cdx + py * cdy + r0 * dr,
        cc = px * px + py * py - r0 * r0;
      if (Math.abs(a) < 1e-12) {
        if (!b) return NaN;
        const s = cc / (2 * b);
        return ok(s) ? s : NaN;
      }
      const disc = b * b - a * cc;
      if (disc < 0) return NaN;
      const q = Math.sqrt(disc);
      const s1 = (b + q) / a,
        s2 = (b - q) / a;
      const hi = Math.max(s1, s2),
        lo = Math.min(s1, s2);
      return ok(hi) ? hi : ok(lo) ? lo : NaN;
    };
    const slow = spanOf(pos);
    return {
      ...out,
      lut: lutAll,
      grad: { c, e0, e1 }, // for a canvas's own gradients
      px,
      // per row: the point moves by a constant step, b by one add; one square root per pixel
      span(
        /** @type {number[]} */ im,
        /** @type {number} */ xa,
        /** @type {number} */ xb,
        /** @type {number} */ y,
        /** @type {number[] | null} */ bb,
        /** @type {boolean} */ useBg,
        /** @type {Int32Array} */ idx,
      ) {
        if (bb || Math.abs(a) < 1e-12) return slow(im, xa, xb, y, bb, useBg, idx);
        const yc = y + 0.5,
          xc = xa + 0.5,
          sx = im[0],
          sy = im[1],
          n = LUT - 1,
          out = useBg ? LUT : -1,
          db = sx * cdx + sy * cdy,
          r00 = r0 * r0,
          ia = 1 / a;
        let px = im[0] * xc + im[2] * yc + im[4] - x0,
          py = im[1] * xc + im[3] * yc + im[5] - y0,
          b = px * cdx + py * cdy + r0 * dr;
        // idx in the kernel's memory: the row worked out there (the same operations)
        const k = idx.length >= xb - xa ? loadedKernel() : null;
        if (k && idx.buffer === k.memory.buffer && idx.byteOffset + (xb - xa) * 4 <= idx.buffer.byteLength)
          return k.radial(
            idx.byteOffset,
            xb - xa,
            px,
            py,
            b,
            sx,
            sy,
            db,
            a,
            ia,
            r00,
            r0,
            dr,
            e0 ? 1 : 0,
            e1 ? 1 : 0,
            n,
            out,
          );
        for (let i = 0, m = xb - xa; i < m; i++, px += sx, py += sy, b += db) {
          const disc = b * b - a * (px * px + py * py - r00);
          let t = NaN;
          if (disc >= 0) {
            const q = Math.sqrt(disc),
              s1 = (b + q) * ia,
              s2 = (b - q) * ia,
              hi = s1 > s2 ? s1 : s2,
              lo = s1 > s2 ? s2 : s1;
            // ok(s), inline: a non-negative radius, inside [0, 1] or extended
            t =
              r0 + hi * dr >= 0 && (hi >= 0 || e0) && (hi <= 1 || e1)
                ? hi
                : r0 + lo * dr >= 0 && (lo >= 0 || e0) && (lo <= 1 || e1)
                  ? lo
                  : NaN;
          }
          idx[i] = t === t ? (t < 0 ? 0 : t > 1 ? n : (t * n + 0.5) | 0) : out;
        }
      },
      /** @param {number} x @param {number} y @param {number[]} o */
      at(x, y, o) {
        // the largest s with |p − c(s)| = r(s) (the later circle is painted over the earlier)
        const px = x - x0,
          py = y - y0;
        const b = px * cdx + py * cdy + r0 * dr,
          cc = px * px + py * py - r0 * r0;
        if (Math.abs(a) < 1e-12) {
          if (!b) return false;
          const s = cc / (2 * b);
          return ok(s) ? put(s, o) : false;
        }
        const disc = b * b - a * cc;
        if (disc < 0) return false;
        const q = Math.sqrt(disc);
        const s1 = (b + q) / a,
          s2 = (b - q) / a;
        const hi = Math.max(s1, s2),
          lo = Math.min(s1, s2);
        if (ok(hi)) return put(hi, o);
        if (ok(lo)) return put(lo, o);
        return false;
      },
    };
  }
  if (type >= 4 && type <= 7 && obj instanceof PdfStream) return { ...out, tris: mesh(obj, d, type, cs, fn, rgb, ctx) };
  return null;
}

/** a mesh shading's triangles, x y r g b per vertex, in shading space */
function mesh(
  /** @type {PdfStream} */ st,
  /** @type {Map<string, any>} */ d,
  /** @type {number} */ type,
  /** @type {any} */ cs,
  /** @type {any} */ fn,
  /** @type {(c: number[]) => number[]} */ rgb,
  /** @type {any} */ ctx,
) {
  const { R } = ctx;
  const bc = R(d.get('BitsPerCoordinate')),
    bcomp = R(d.get('BitsPerComponent')),
    bf = type === 5 ? 0 : R(d.get('BitsPerFlag'));
  if (![1, 2, 4, 8, 12, 16, 24, 32].includes(bc) || ![1, 2, 4, 8, 12, 16].includes(bcomp)) throw bad('bad bit sizes');
  if (type !== 5 && ![2, 4, 8].includes(bf)) throw bad('bad BitsPerFlag');
  const nc = fn ? 1 : cs.n;
  const dec = R(d.get('Decode'));
  if (!Array.isArray(dec) || dec.length < 4 + 2 * nc) throw bad('no Decode');
  const D = dec.map((v) => Number(R(v)) || 0);
  const data = ctx.data(st);
  const vertBits = bf + 2 * bc + nc * bcomp;
  // the most vertices the data can hold, before any is read
  const most = Math.floor((data.length * 8) / (type === 6 || type === 7 ? 2 * bc : vertBits));
  if (type <= 5 && most > MAX_VERTICES) throw bad(`more than ${MAX_VERTICES.toLocaleString('en')} vertices`);
  let pos = 0; // in bits
  const bits = (/** @type {number} */ n) => {
    let v = 0;
    for (let k = 0; k < n;) {
      const byte = data[pos >> 3],
        off = pos & 7,
        take = Math.min(8 - off, n - k);
      v = v * (1 << take) + ((byte >> (8 - off - take)) & ((1 << take) - 1));
      pos += take;
      k += take;
    }
    return v;
  };
  const maxc = 2 ** bc - 1,
    maxk = 2 ** bcomp - 1;
  const has = (/** @type {number} */ n) => pos + n <= data.length * 8;
  const point = () => [D[0] + (bits(bc) * (D[1] - D[0])) / maxc, D[2] + (bits(bc) * (D[3] - D[2])) / maxc];
  const colour = () => {
    const c = [];
    for (let i = 0; i < nc; i++) c.push(D[4 + 2 * i] + (bits(bcomp) * (D[5 + 2 * i] - D[4 + 2 * i])) / maxk);
    return rgb(c);
  };
  /** @type {number[]} */ const T = [];
  const tri = (/** @type {number[][]} */ a, /** @type {number[][]} */ b, /** @type {number[][]} */ c) => {
    if (T.length / 15 >= MAX_TRIANGLES) throw bad(`more than ${MAX_TRIANGLES.toLocaleString('en')} triangles`);
    T.push(a[0][0], a[0][1], ...a[1], b[0][0], b[0][1], ...b[1], c[0][0], c[0][1], ...c[1]);
  };
  if (type === 4) {
    /** @type {[number[], number[]][]} */ const V = [];
    let need = 0;
    while (has(vertBits)) {
      ctx.tick(1);
      const f = bits(bf);
      const v = /** @type {[number[], number[]]} */ ([point(), colour()]);
      pos = (pos + 7) & ~7; // each vertex starts on a byte
      if (need === 0) {
        if (f === 0) {
          V.length = 0;
          need = 3;
        } else if (V.length >= 3) {
          const [a, b, c] = V.slice(-3);
          V.length = 0;
          V.push(f === 1 ? b : a, c);
          need = 1;
        } else continue;
      }
      V.push(v);
      if (--need === 0) tri(V[V.length - 3], V[V.length - 2], V[V.length - 1]);
    }
  } else if (type === 5) {
    const per = R(d.get('VerticesPerRow'));
    if (!Number.isInteger(per) || per < 2) throw bad('bad VerticesPerRow');
    /** @type {[number[], number[]][]} */ let prev = [],
      row = [];
    while (has(vertBits)) {
      ctx.tick(1);
      row.push([point(), colour()]);
      if (row.length === per) {
        if (prev.length)
          for (let i = 0; i + 1 < per; i++) {
            tri(prev[i], prev[i + 1], row[i]);
            tri(prev[i + 1], row[i + 1], row[i]);
          }
        prev = row;
        row = [];
      }
    }
  } else {
    // Coons (12 points) and tensor (16) patches; flags 1–3 share an edge with the previous patch
    const tensor = type === 7;
    /** @type {{ p: number[][], c: number[][] }[]} */ const patches = [];
    /** @type {number[][] | null} */ let P = null;
    /** @type {number[][] | null} */ let Cc = null;
    while (has(bf + 8)) {
      const f = bits(bf);
      const np = (f === 0 ? 12 : 8) + (tensor ? 4 : 0),
        ncol = f === 0 ? 4 : 2;
      if (!has(np * 2 * bc + ncol * nc * bcomp)) break;
      if (patches.length >= MAX_PATCHES) throw bad(`more than ${MAX_PATCHES.toLocaleString('en')} patches`);
      ctx.tick(np);
      const pts = [];
      for (let i = 0; i < np; i++) pts.push(point());
      const cols = [];
      for (let i = 0; i < ncol; i++) cols.push(colour());
      // p[i][j], i along u, j along v: the 12 boundary points run p00 p01 p02 p03 p13 p23 p33 p32 p31 p30 p20 p10
      /** @type {number[][]} */ let edge, ce;
      if (f === 0) ((edge = []), (ce = []));
      else {
        if (!P || !Cc) break;
        const b = P;
        edge = f === 1 ? b.slice(3, 7) : f === 2 ? b.slice(6, 10) : [b[9], b[10], b[11], b[0]];
        ce = f === 1 ? [Cc[1], Cc[2]] : f === 2 ? [Cc[2], Cc[3]] : [Cc[3], Cc[0]];
      }
      const all = [...edge, ...pts];
      const c4 = [...ce, ...cols]; // c00 c03 c33 c30
      const p = Array.from({ length: 4 }, () => /** @type {number[][]} */ (Array(4)));
      const order = [
        [0, 0],
        [0, 1],
        [0, 2],
        [0, 3],
        [1, 3],
        [2, 3],
        [3, 3],
        [3, 2],
        [3, 1],
        [3, 0],
        [2, 0],
        [1, 0],
      ];
      order.forEach(([i, j], k) => (p[i][j] = all[k]));
      if (tensor) {
        p[1][1] = all[12];
        p[1][2] = all[13];
        p[2][2] = all[14];
        p[2][1] = all[15];
      } else {
        for (const [i, j, a, b1, b2, c1, c2, e1, e2, f1] of /** @type {const} */ ([
          [1, 1, [0, 0], [0, 1], [1, 0], [0, 3], [3, 0], [3, 1], [1, 3], [3, 3]],
          [1, 2, [0, 3], [0, 2], [1, 3], [0, 0], [3, 3], [3, 2], [1, 0], [3, 0]],
          [2, 1, [3, 0], [3, 1], [2, 0], [3, 3], [0, 0], [0, 1], [2, 3], [0, 3]],
          [2, 2, [3, 3], [3, 2], [2, 3], [3, 0], [0, 3], [0, 2], [2, 0], [0, 0]],
        ])) {
          const P_ = (/** @type {readonly number[]} */ q) => p[q[0]][q[1]];
          p[i][j] = [0, 1].map(
            (k) =>
              (-4 * P_(a)[k] +
                6 * (P_(b1)[k] + P_(b2)[k]) -
                2 * (P_(c1)[k] + P_(c2)[k]) +
                3 * (P_(e1)[k] + P_(e2)[k]) -
                P_(f1)[k]) /
              9,
          );
        }
      }
      P = [...order.map(([i, j]) => p[i][j])];
      Cc = c4;
      patches.push({ p, c: c4 });
    }
    if (!patches.length) return new Float64Array(0);
    // grid size per patch, by its share of the whole mesh (as pdf.js), within the triangle cap
    let mx0 = Infinity,
      my0 = Infinity,
      mx1 = -Infinity,
      my1 = -Infinity;
    for (const { p } of patches)
      for (const row of p)
        for (const q of row)
          ((mx0 = Math.min(mx0, q[0])),
            (mx1 = Math.max(mx1, q[0])),
            (my0 = Math.min(my0, q[1])),
            (my1 = Math.max(my1, q[1])));
    const cap = Math.max(1, Math.floor(Math.sqrt(MAX_TRIANGLES / 2 / patches.length)));
    for (const { p, c } of patches) {
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (const row of p)
        for (const q of row)
          ((x0 = Math.min(x0, q[0])), (x1 = Math.max(x1, q[0])), (y0 = Math.min(y0, q[1])), (y1 = Math.max(y1, q[1])));
      const nu = Math.min(cap, Math.max(3, Math.min(20, Math.ceil(((x1 - x0) * 20) / (mx1 - mx0 || 1))))),
        nv = Math.min(cap, Math.max(3, Math.min(20, Math.ceil(((y1 - y0) * 20) / (my1 - my0 || 1)))));
      ctx.tick(nu * nv);
      const grid = [];
      for (let a = 0; a <= nu; a++)
        for (let b = 0; b <= nv; b++) {
          const u = a / nu,
            v = b / nv;
          grid.push([surface(p, u, v), bilerp(c, u, v)]);
        }
      const at = (/** @type {number} */ a, /** @type {number} */ b) => grid[a * (nv + 1) + b];
      for (let a = 0; a < nu; a++)
        for (let b = 0; b < nv; b++) {
          tri(at(a, b), at(a + 1, b), at(a, b + 1));
          tri(at(a + 1, b), at(a + 1, b + 1), at(a, b + 1));
        }
    }
  }
  return Float64Array.from(T);
}

/** cubic Bernstein @param {number} t */
const bern = (t) => [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];
/** a point on a tensor patch p[i][j] (i along u, j along v) @param {number[][][]} p @param {number} u @param {number} v */
function surface(p, u, v) {
  const bu = bern(u),
    bv = bern(v);
  let x = 0,
    y = 0;
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      const w = bu[i] * bv[j];
      x += w * p[i][j][0];
      y += w * p[i][j][1];
    }
  return [x, y];
}
/** corner colours c00 c03 c33 c30 → the colour at (u, v) @param {number[][]} c @param {number} u @param {number} v */
const bilerp = (c, u, v) =>
  [0, 1, 2].map((k) => (1 - u) * (1 - v) * c[0][k] + (1 - u) * v * c[1][k] + u * v * c[2][k] + u * (1 - v) * c[3][k]);
