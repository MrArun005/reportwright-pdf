// @ts-check
/**
 * The rasterizer: polygons (device pixels, y down) → anti-aliased coverage, a row at a time. Each pixel row is
 * sampled on SS sub-scanlines; on each, the edges' crossings are sorted and the inside spans (non-zero or even-odd)
 * add their exact horizontal coverage. Coverage is handed to the caller per row (it composites), never held whole.
 * Also the stroker (width, caps, joins, miter limit, dashes) and curve flattening: strokes become polygons filled
 * non-zero, each one turned to positive winding so their union is the stroke.
 */

/** sub-scanlines per pixel row. ponytail: 4 vertical samples, exact horizontally; 16 if text edges look stepped */
export const SS = 4;

/** a reusable rasterizer for a W × H device @param {number} W @param {number} H */
export function rasterizer(W, H) {
  const part = new Float32Array(W + 2),
    diff = new Float32Array(W + 2),
    cov = new Float32Array(W + 1);
  /** @type {number[]} */ let xs = [];
  /** @type {number[]} */ let ds = [];
  /**
   * Fill polygons (each [x0, y0, x1, y1, …], closed implicitly). span(y, x0, x1, cov) gets each row's coverage 0–1
   * for x0 ≤ x < x1. @param {ArrayLike<number>[]} polys @param {boolean} evenOdd
   * @param {(y: number, x0: number, x1: number, cov: Float32Array) => void} span
   */
  function fill(polys, evenOdd, span) {
    // edges: yTop, yBot, x at yTop, dx/dy, direction
    /** @type {number[]} */ const E = [];
    let ymin = Infinity,
      ymax = -Infinity;
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
        if (y0 > y1) {
          [x0, y0, x1, y1] = [x1, y1, x0, y0];
          d = -1;
        }
        if (y1 <= 0 || y0 >= H) continue;
        E.push(y0, y1, x0, (x1 - x0) / (y1 - y0), d);
        if (y0 < ymin) ymin = y0;
        if (y1 > ymax) ymax = y1;
      }
    }
    if (!E.length) return;
    const ne = E.length / 5;
    const order = Array.from({ length: ne }, (_, i) => i).sort((a, b) => E[5 * a] - E[5 * b]);
    /** @type {number[]} */ let active = [];
    let next = 0;
    const r0 = Math.max(0, Math.floor(ymin)),
      r1 = Math.min(H, Math.ceil(ymax));
    for (let y = r0; y < r1; y++) {
      let lo = W,
        hi = -1;
      for (let s = 0; s < SS; s++) {
        const sy = y + (s + 0.5) / SS;
        while (next < ne && E[5 * order[next]] <= sy) active.push(order[next++]);
        let k = 0;
        xs.length = 0;
        ds.length = 0;
        for (let i = 0; i < active.length; i++) {
          const e = active[i] * 5;
          if (E[e + 1] <= sy) continue; // ended
          active[k++] = active[i];
          if (E[e] > sy) continue;
          const x = E[e + 2] + (sy - E[e]) * E[e + 3];
          // insertion sort by x (crossings per sub-scanline are few)
          let j = xs.length;
          xs.push(x);
          ds.push(E[e + 4]);
          while (j > 0 && xs[j - 1] > x) {
            xs[j] = xs[j - 1];
            ds[j] = ds[j - 1];
            j--;
          }
          xs[j] = x;
          ds[j] = E[e + 4];
        }
        active.length = k;
        let w = 0;
        for (let i = 0; i + 1 < xs.length; i++) {
          w += ds[i];
          if (evenOdd ? (i + 1) & 1 : w !== 0) {
            let xa = xs[i],
              xb = xs[i + 1];
            if (xa < 0) xa = 0;
            if (xb > W) xb = W;
            if (!(xb > xa)) continue;
            const ia = xa | 0,
              ib = xb | 0;
            if (ia < lo) lo = ia;
            if (ib > hi) hi = ib;
            if (ia === ib) part[ia] += xb - xa;
            else {
              part[ia] += ia + 1 - xa;
              diff[ia + 1] += 1;
              diff[ib] -= 1;
              part[ib] += xb - ib;
            }
          }
        }
      }
      if (hi < 0) continue;
      const x1 = Math.min(W, hi + 1);
      let run = 0;
      for (let x = lo; x < x1; x++) {
        run += diff[x];
        const c = (run + part[x]) / SS;
        cov[x] = c > 1 ? 1 : c < 0 ? 0 : c;
      }
      part.fill(0, lo, hi + 2);
      diff.fill(0, lo, hi + 2);
      span(y, lo, x1, cov);
    }
  }
  return { fill };
}

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
  for (let i = 0; i < p.length;) {
    const op = p[i++];
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
      const n = Math.max(1, Math.min(100, Math.ceil(Math.sqrt(d / tol) * 0.6)));
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
        if (++guard > 1e6) return out; // ponytail: a 1e-9 dash on a long line stops here, not in a billion pieces
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
