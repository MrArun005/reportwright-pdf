// @ts-check
/**
 * Glyph outlines for the renderer, as paths (0 moveTo, 1 lineTo, 2 curveTo, 3 close) in font units: TrueType glyf
 * (simple and composite glyphs, quadratics as cubics) and CFF Type 2 charstrings (the table parseCff reads and checks).
 * The font is HOSTILE: every read is bounds-checked (a bad glyph draws as nothing), composites nest at most 8 deep,
 * charstrings walk at most 1,000,000 bytes and nest subroutines at most 10 deep (no recursion), the operand stack
 * holds at most 48. ponytail: no hinting, no seac accents, no CFF2 / variable fonts.
 */
import { parseCff } from '../fonts/cff.js';

/** @param {Uint8Array} b */
const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/**
 * A TrueType font's glyph(gid) → path. @param {Map<string, Uint8Array>} tables @param {number} indexToLocFormat
 * @param {number} numGlyphs
 */
export function glyfOutlines(tables, indexToLocFormat, numGlyphs) {
  const loca = dv(/** @type {Uint8Array} */ (tables.get('loca'))),
    glyfB = /** @type {Uint8Array} */ (tables.get('glyf')),
    glyf = dv(glyfB);
  const off = (/** @type {number} */ g) => (indexToLocFormat ? loca.getUint32(4 * g) : 2 * loca.getUint16(2 * g));
  let parts = 0;
  /** @param {number} g @param {number[]} out @param {number[]} m @param {number} depth */
  function one(g, out, m, depth) {
    if (g >= numGlyphs || depth > 8) return;
    if (++parts > MAX_PARTS) throw new RangeError('a composite glyph has too many parts');
    if (out.length > MAX_OUTLINE) throw new RangeError('a glyph outline is too large');
    const s = off(g),
      e = off(g + 1);
    if (e <= s || e > glyfB.length) return;
    const nc = glyf.getInt16(s);
    const T = (/** @type {number} */ x, /** @type {number} */ y) => [
      m[0] * x + m[2] * y + m[4],
      m[1] * x + m[3] * y + m[5],
    ];
    if (nc >= 0) {
      let p = s + 10;
      const ends = [];
      for (let i = 0; i < nc; i++, p += 2) ends.push(glyf.getUint16(p));
      const np = nc ? ends[nc - 1] + 1 : 0;
      p += 2 + glyf.getUint16(p);
      const flags = new Uint8Array(np);
      for (let i = 0; i < np;) {
        const f = glyf.getUint8(p++);
        flags[i++] = f;
        if (f & 8) for (let r = glyf.getUint8(p++); r > 0 && i < np; r--) flags[i++] = f;
      }
      const xs = new Int32Array(np),
        ys = new Int32Array(np);
      for (const [arr, short, same] of /** @type {[Int32Array, number, number][]} */ ([
        [xs, 2, 16],
        [ys, 4, 32],
      ])) {
        let v = 0;
        for (let i = 0; i < np; i++) {
          const f = flags[i];
          if (f & short) {
            const d = glyf.getUint8(p++);
            v += f & same ? d : -d;
          } else if (!(f & same)) {
            v += glyf.getInt16(p);
            p += 2;
          }
          arr[i] = v;
        }
      }
      if (p > e + 3) return; // ponytail: read past the glyph's own bytes (still inside glyf): drawn as nothing
      let first = 0;
      for (const last of ends) {
        if (last < first || last >= np) return;
        const n = last - first + 1;
        const on = (/** @type {number} */ k) => flags[first + (k % n)] & 1;
        const P = (/** @type {number} */ k) => T(xs[first + (k % n)], ys[first + (k % n)]);
        // start at an on-curve point, or the midpoint of the first two off-curve ones
        let k0 = 0;
        while (k0 < n && !on(k0)) k0++;
        let start;
        if (k0 === n) {
          const a = P(0),
            b = P(1);
          start = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          k0 = 0;
        } else start = P(k0);
        out.push(0, start[0], start[1]);
        let cx = start[0],
          cy = start[1];
        /** @type {number[] | null} */ let ctl = null;
        const quad = (/** @type {number[]} */ c, /** @type {number[]} */ t) => {
          out.push(
            2,
            cx + ((c[0] - cx) * 2) / 3,
            cy + ((c[1] - cy) * 2) / 3,
            t[0] + ((c[0] - t[0]) * 2) / 3,
            t[1] + ((c[1] - t[1]) * 2) / 3,
            t[0],
            t[1],
          );
          cx = t[0];
          cy = t[1];
        };
        for (let k = 1; k <= n; k++) {
          const i = k0 + k;
          const pt = k === n && on(k0) ? start : P(i);
          if (on(i) || k === n) {
            if (ctl) quad(ctl, k === n ? start : pt);
            else (out.push(1, pt[0], pt[1]), (cx = pt[0]), (cy = pt[1]));
            ctl = null;
          } else if (ctl) {
            const mid = [(ctl[0] + pt[0]) / 2, (ctl[1] + pt[1]) / 2];
            quad(ctl, mid);
            ctl = pt;
          } else ctl = pt;
        }
        out.push(3);
        first = last + 1;
      }
      return;
    }
    // composite
    let p = s + 10;
    for (let guard = 0; guard < 64; guard++) {
      const f = glyf.getUint16(p),
        sub = glyf.getUint16(p + 2);
      p += 4;
      let dx = 0,
        dy = 0;
      if (f & 1) {
        dx = glyf.getInt16(p);
        dy = glyf.getInt16(p + 2);
        p += 4;
      } else {
        dx = glyf.getInt8(p);
        dy = glyf.getInt8(p + 1);
        p += 2;
      }
      if (!(f & 2)) dx = dy = 0; // ponytail: point-matched components placed at the origin
      let a = 1,
        b = 0,
        c = 0,
        d = 1;
      const f2 = (/** @type {number} */ q) => glyf.getInt16(q) / 16384;
      if (f & 8) {
        a = d = f2(p);
        p += 2;
      } else if (f & 0x40) {
        a = f2(p);
        d = f2(p + 2);
        p += 4;
      } else if (f & 0x80) {
        a = f2(p);
        b = f2(p + 2);
        c = f2(p + 4);
        d = f2(p + 6);
        p += 8;
      }
      const cm = [
        a * m[0] + b * m[2],
        a * m[1] + b * m[3],
        c * m[0] + d * m[2],
        c * m[1] + d * m[3],
        dx * m[0] + dy * m[2] + m[4],
        dx * m[1] + dy * m[3] + m[5],
      ];
      one(sub, out, cm, depth + 1);
      if (!(f & 0x20)) break;
    }
  }
  return (/** @type {number} */ g) => {
    /** @type {number[]} */ const out = [];
    try {
      parts = 0;
      one(g, out, [1, 0, 0, 1, 0, 0], 0);
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      return [];
    }
    return out;
  };
}

/** the simple glyphs one composite glyph may draw (nesting × fan-out cannot multiply past it) */
export const MAX_PARTS = 256,
  /** numbers one glyph's outline may hold */
  MAX_OUTLINE = 1_000_000;

const bias = (/** @type {number} */ n) => (n < 1240 ? 107 : n < 33900 ? 1131 : 32768);

/** A CFF table's glyph(gid) → path, and cid → gid. @param {Uint8Array} t */
export function cffOutlines(t) {
  const c = parseCff(t, -1);
  /** @type {Map<number, number> | null} */
  let byCid = null;
  if (c.cids) {
    byCid = new Map();
    for (let g = 0; g < c.cids.length; g++) byCid.set(c.cids[g], g);
  }
  /** @param {number} g */
  const glyph = (g) => {
    /** @type {number[]} */ const out = [];
    if (!(g >= 0 && g < c.cs.count)) return out;
    const local = c.subrsFor(g);
    let [p, e] = c.cs.at(g);
    /** @type {[number, number][]} */ const calls = [];
    const S = [];
    let x = 0,
      y = 0,
      stems = 0,
      first = true,
      open = false,
      budget = 1_000_000;
    const move = (/** @type {number} */ dx, /** @type {number} */ dy) => {
      if (open) out.push(3);
      x += dx;
      y += dy;
      out.push(0, x, y);
      open = true;
    };
    const line = (/** @type {number} */ dx, /** @type {number} */ dy) => {
      x += dx;
      y += dy;
      out.push(1, x, y);
    };
    /** @param {number} a @param {number} b @param {number} cc @param {number} d @param {number} ee @param {number} f */
    const curve = (a, b, cc, d, ee, f) => {
      const x1 = x + a,
        y1 = y + b,
        x2 = x1 + cc,
        y2 = y1 + d;
      x = x2 + ee;
      y = y2 + f;
      out.push(2, x1, y1, x2, y2, x, y);
    };
    /** drop the width, the first stack-clearing operator's extra operand @param {boolean} extra */
    const width = (extra) => {
      if (first && extra) S.shift();
      first = false;
    };
    for (;;) {
      if (p >= e) {
        if (!calls.length) break;
        [p, e] = /** @type {[number, number]} */ (calls.pop());
        continue;
      }
      if (--budget < 0 || out.length > MAX_OUTLINE) return [];
      const b = t[p];
      if (b >= 32 || b === 28) {
        if (S.length >= 48) return [];
        if (b === 28) {
          S.push(((t[p + 1] << 24) | (t[p + 2] << 16)) >> 16);
          p += 3;
        } else if (b <= 246) {
          S.push(b - 139);
          p++;
        } else if (b <= 250) {
          S.push((b - 247) * 256 + t[p + 1] + 108);
          p += 2;
        } else if (b <= 254) {
          S.push(-(b - 251) * 256 - t[p + 1] - 108);
          p += 2;
        } else {
          S.push(((t[p + 1] << 24) | (t[p + 2] << 16) | (t[p + 3] << 8) | t[p + 4]) / 65536);
          p += 5;
        }
        continue;
      }
      p++;
      const n = S.length;
      switch (b) {
        case 1:
        case 3:
        case 18:
        case 23:
          width(n % 2 === 1);
          stems += S.length >> 1;
          S.length = 0;
          break;
        case 19:
        case 20:
          width(n % 2 === 1);
          stems += S.length >> 1;
          p += (stems + 7) >> 3;
          S.length = 0;
          break;
        case 21:
          width(n > 2);
          move(S[0] ?? 0, S[1] ?? 0);
          S.length = 0;
          break;
        case 22:
          width(n > 1);
          move(S[0] ?? 0, 0);
          S.length = 0;
          break;
        case 4:
          width(n > 1);
          move(0, S[0] ?? 0);
          S.length = 0;
          break;
        case 5:
          for (let i = 0; i + 1 < n; i += 2) line(S[i], S[i + 1]);
          S.length = 0;
          break;
        case 6:
        case 7:
          for (let i = 0, h = b === 6; i < n; i++, h = !h) h ? line(S[i], 0) : line(0, S[i]);
          S.length = 0;
          break;
        case 8:
          for (let i = 0; i + 5 < n; i += 6) curve(S[i], S[i + 1], S[i + 2], S[i + 3], S[i + 4], S[i + 5]);
          S.length = 0;
          break;
        case 27: {
          let i = 0,
            dy1 = n % 2 ? S[i++] : 0;
          for (; i + 3 < n; i += 4, dy1 = 0) curve(S[i], dy1, S[i + 1], S[i + 2], S[i + 3], 0);
          S.length = 0;
          break;
        }
        case 26: {
          let i = 0,
            dx1 = n % 2 ? S[i++] : 0;
          for (; i + 3 < n; i += 4, dx1 = 0) curve(dx1, S[i], S[i + 1], S[i + 2], 0, S[i + 3]);
          S.length = 0;
          break;
        }
        case 30:
        case 31: {
          let h = b === 31;
          for (let i = 0; i + 3 < n; h = !h) {
            const last = n - i === 5 ? S[i + 4] : 0;
            if (h) curve(S[i], 0, S[i + 1], S[i + 2], last, S[i + 3]);
            else curve(0, S[i], S[i + 1], S[i + 2], S[i + 3], last);
            i += n - i === 5 ? 5 : 4;
          }
          S.length = 0;
          break;
        }
        case 24: {
          let i = 0;
          for (; i + 7 < n; i += 6) curve(S[i], S[i + 1], S[i + 2], S[i + 3], S[i + 4], S[i + 5]);
          if (i + 1 < n) line(S[i], S[i + 1]);
          S.length = 0;
          break;
        }
        case 25: {
          let i = 0;
          for (; i + 7 < n; i += 2) line(S[i], S[i + 1]);
          if (i + 5 < n) curve(S[i], S[i + 1], S[i + 2], S[i + 3], S[i + 4], S[i + 5]);
          S.length = 0;
          break;
        }
        case 10:
        case 29: {
          const subrs = b === 10 ? local : c.gsubrs;
          const i = /** @type {number} */ (S.pop()) + bias(subrs?.count ?? 0);
          if (!subrs || !(i >= 0 && i < subrs.count) || calls.length >= 10) return [];
          calls.push([p, e]);
          [p, e] = subrs.at(i);
          break;
        }
        case 11:
          if (!calls.length) return [];
          [p, e] = /** @type {[number, number]} */ (calls.pop());
          break;
        case 14:
          width(n === 1 || n === 5);
          if (open) out.push(3);
          return out; // ponytail: seac (endchar with 4 operands) draws no accent
        case 12: {
          const op = t[p++];
          if (op === 35 && n >= 12) {
            curve(S[0], S[1], S[2], S[3], S[4], S[5]);
            curve(S[6], S[7], S[8], S[9], S[10], S[11]);
          } else if (op === 34 && n >= 7) {
            curve(S[0], 0, S[1], S[2], S[3], 0);
            curve(S[4], 0, S[5], -S[2], S[6], 0);
          } else if (op === 36 && n >= 9) {
            curve(S[0], S[1], S[2], S[3], S[4], 0);
            curve(S[5], 0, S[6], S[7], S[8], -(S[1] + S[3] + S[7]));
          } else if (op === 37 && n >= 11) {
            const sx = x,
              sy = y;
            curve(S[0], S[1], S[2], S[3], S[4], S[5]);
            const x1 = x + S[6],
              y1 = y + S[7],
              x2 = x1 + S[8],
              y2 = y1 + S[9];
            const dx = x2 - sx,
              dy = y2 - sy;
            if (Math.abs(dx) > Math.abs(dy)) {
              x = x2 + S[10];
              y = sy;
            } else {
              x = sx;
              y = y2 + S[10];
            }
            out.push(2, x1, y1, x2, y2, x, y);
          }
          S.length = 0;
          break;
        }
        default:
          S.length = 0;
      }
    }
    if (open) out.push(3);
    return out;
  };
  return { glyph, gidOf: (/** @type {number} */ cid) => (byCid ? (byCid.get(cid) ?? 0) : cid) };
}
