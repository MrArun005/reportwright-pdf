// @ts-check
/**
 * A path, built like the Canvas 2D API's: moveTo, lineTo, bezierCurveTo, quadraticCurveTo, arc, arcTo, ellipse, rect,
 * roundedRect, closePath, plus svg(d) for SVG path data (graphics/svg.js). Coordinates are top-left, y down (as on a
 * page and in canvas), so angles turn clockwise on the page. A path belongs to no page: page.fill/stroke/clip write it
 * for the page they are given to (graphics/draw.js).
 *
 * Every coordinate is checked when it is added (finite, under 1e9 in size), so a bad number throws before anything is
 * drawn; a path holds at most MAX_SEGMENTS segments. Curves are cubic; quadratics and arcs are converted.
 */
import { num } from '../core/serialize.js';
import { parseSvgPath } from './svg.js';

export const MAX_SEGMENTS = 1_000_000;
const TAU = 2 * Math.PI;

/** a coordinate or length a path can use @param {number} v @param {string} what */
export function coord(v, what) {
  if (typeof v !== 'number' || !(Math.abs(v) < 1e9)) throw new RangeError(`${what}: ${v} is not a usable number (finite, under 1e9 in size)`);
  return v;
}

export class Path {
  constructor() {
    /** @type {string[]} m, l, c, h */ this.ops = [];
    /** @type {number[]} */ this.v = [];
    /** the current point, and the start of the current subpath */
    this.x = 0; this.y = 0; this.sx = 0; this.sy = 0;
    this.has = false;
  }
  get segments() { return this.ops.length; }
  /** @param {string} op @param {number[]} pts */
  #push(op, pts) {
    if (this.ops.length >= MAX_SEGMENTS) throw new RangeError(`A path has at most ${MAX_SEGMENTS.toLocaleString('en')} segments`);
    this.ops.push(op);
    for (const p of pts) this.v.push(p);
  }
  /** @param {number} x @param {number} y */
  moveTo(x, y) {
    coord(x, 'moveTo'); coord(y, 'moveTo');
    this.#push('m', [x, y]);
    this.x = this.sx = x; this.y = this.sy = y; this.has = true;
    return this;
  }
  /** with no current point, a moveTo (as canvas) @param {number} x @param {number} y */
  lineTo(x, y) {
    coord(x, 'lineTo'); coord(y, 'lineTo');
    if (!this.has) return this.moveTo(x, y);
    this.#push('l', [x, y]);
    this.x = x; this.y = y;
    return this;
  }
  /** @param {number} c1x @param {number} c1y @param {number} c2x @param {number} c2y @param {number} x @param {number} y */
  bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
    for (const v of [c1x, c1y, c2x, c2y, x, y]) coord(v, 'bezierCurveTo');
    if (!this.has) this.moveTo(c1x, c1y);
    this.#push('c', [c1x, c1y, c2x, c2y, x, y]);
    this.x = x; this.y = y;
    return this;
  }
  /** a quadratic Bézier, written as the equivalent cubic @param {number} cx @param {number} cy @param {number} x @param {number} y */
  quadraticCurveTo(cx, cy, x, y) {
    for (const v of [cx, cy, x, y]) coord(v, 'quadraticCurveTo');
    if (!this.has) this.moveTo(cx, cy);
    const x0 = this.x, y0 = this.y;
    return this.bezierCurveTo(x0 + (2 / 3) * (cx - x0), y0 + (2 / 3) * (cy - y0), x + (2 / 3) * (cx - x), y + (2 / 3) * (cy - y), x, y);
  }
  closePath() {
    if (!this.has) return this;
    this.#push('h', []);
    this.x = this.sx; this.y = this.sy;
    return this;
  }
  /**
   * An arc of an ellipse centred (cx, cy), radii rx, ry, rotated phi, from angle a0 turning by sweep (radians,
   * clockwise on the page when positive), in at most 90° cubic pieces. connect: a line from the current point to the
   * arc's start (canvas arc), else the arc starts there (SVG A, whose start is the current point).
   * @param {number} cx @param {number} cy @param {number} rx @param {number} ry @param {number} phi @param {number} a0 @param {number} sweep @param {boolean} [connect]
   */
  arcSegment(cx, cy, rx, ry, phi, a0, sweep, connect = true) {
    const cp = Math.cos(phi), sp = Math.sin(phi);
    const at = (/** @type {number} */ t, /** @type {number} */ dx = Math.cos(t), /** @type {number} */ dy = Math.sin(t)) => [cx + rx * dx * cp - ry * dy * sp, cy + rx * dx * sp + ry * dy * cp];
    const [x0, y0] = at(a0);
    if (connect || !this.has) { if (this.has) this.lineTo(x0, y0); else this.moveTo(x0, y0); }
    if (sweep === 0) return this;
    const n = Math.min(4, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9)), d = sweep / n, k = (4 / 3) * Math.tan(d / 4);
    for (let i = 0; i < n; i++) {
      const t0 = a0 + i * d, t1 = t0 + d, c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
      const [ax, ay] = at(0, c0 - k * s0, s0 + k * c0), [bx, by] = at(0, c1 + k * s1, s1 - k * c1), [ex, ey] = at(0, c1, s1);
      this.bezierCurveTo(ax, ay, bx, by, ex, ey);
    }
    return this;
  }
  /**
   * Canvas arc: centre (x, y), radius r, from start to end (radians, clockwise on the page), counterclockwise if ccw.
   * @param {number} x @param {number} y @param {number} r @param {number} start @param {number} end @param {boolean} [ccw]
   */
  arc(x, y, r, start, end, ccw = false) { return this.ellipse(x, y, r, r, 0, start, end, ccw); }
  /**
   * Canvas ellipse: centre (x, y), radii rx, ry, rotated by rotation, from start to end (radians).
   * @param {number} x @param {number} y @param {number} rx @param {number} ry @param {number} rotation @param {number} start @param {number} end @param {boolean} [ccw]
   */
  ellipse(x, y, rx, ry, rotation, start, end, ccw = false) {
    for (const v of [x, y, rx, ry, rotation, start, end]) coord(v, 'arc');
    if (rx < 0 || ry < 0) throw new RangeError(`arc: a radius cannot be negative (${rx < 0 ? rx : ry})`);
    let sweep;
    if (!ccw) sweep = end - start >= TAU ? TAU : ((end - start) % TAU + TAU) % TAU;
    else sweep = start - end >= TAU ? -TAU : -(((start - end) % TAU + TAU) % TAU);
    return this.arcSegment(x, y, rx, ry, rotation, start, sweep);
  }
  /**
   * Canvas arcTo: a line towards (x1, y1), rounded into the line to (x2, y2) by an arc of radius r.
   * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2 @param {number} r
   */
  arcTo(x1, y1, x2, y2, r) {
    for (const v of [x1, y1, x2, y2, r]) coord(v, 'arcTo');
    if (r < 0) throw new RangeError(`arcTo: the radius cannot be negative (${r})`);
    if (!this.has) return this.moveTo(x1, y1);
    const ux = this.x - x1, uy = this.y - y1, vx = x2 - x1, vy = y2 - y1;
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy), cross = ux * vy - uy * vx;
    if (r === 0 || lu === 0 || lv === 0 || Math.abs(cross) <= 1e-9 * lu * lv) return this.lineTo(x1, y1);
    const angle = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv))));
    const d = r / Math.tan(angle / 2), bx = ux / lu + vx / lv, by = uy / lu + vy / lv, bl = Math.hypot(bx, by), h = r / Math.sin(angle / 2);
    const cx = x1 + (bx / bl) * h, cy = y1 + (by / bl) * h;
    const t1x = x1 + (ux / lu) * d, t1y = y1 + (uy / lu) * d, t2x = x1 + (vx / lv) * d, t2y = y1 + (vy / lv) * d;
    const a0 = Math.atan2(t1y - cy, t1x - cx);
    let sweep = Math.atan2(t2y - cy, t2x - cx) - a0;
    if (sweep > Math.PI) sweep -= TAU; else if (sweep < -Math.PI) sweep += TAU;
    return this.arcSegment(cx, cy, r, r, 0, a0, sweep);
  }
  /** @param {number} x @param {number} y @param {number} w @param {number} h */
  rect(x, y, w, h) {
    for (const v of [x, y, w, h]) coord(v, 'rect');
    return this.moveTo(x, y).lineTo(x + w, y).lineTo(x + w, y + h).lineTo(x, y + h).closePath().moveTo(x, y);
  }
  /**
   * A rectangle with rounded corners. radii: one radius, or as canvas roundRect [all] | [tl+br, tr+bl] |
   * [tl, tr+bl, br] | [tl, tr, br, bl]; scaled down together when they do not fit.
   * @param {number} x @param {number} y @param {number} w @param {number} h @param {number | number[]} [radii]
   */
  roundedRect(x, y, w, h, radii = 0) {
    for (const v of [x, y, w, h]) coord(v, 'roundedRect');
    const r = typeof radii === 'number' ? [radii] : radii;
    if (!Array.isArray(r) || r.length < 1 || r.length > 4) throw new TypeError('roundedRect: radii is a number or an array of 1–4 numbers');
    for (const v of r) { coord(v, 'roundedRect'); if (v < 0) throw new RangeError(`roundedRect: a radius cannot be negative (${v})`); }
    let [tl, tr, br, bl] = r.length === 1 ? [r[0], r[0], r[0], r[0]] : r.length === 2 ? [r[0], r[1], r[0], r[1]] : r.length === 3 ? [r[0], r[1], r[2], r[1]] : r;
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    const f = Math.min(1, w / (tl + tr) || 1, w / (bl + br) || 1, h / (tl + bl) || 1, h / (tr + br) || 1);
    tl *= f; tr *= f; br *= f; bl *= f;
    const Q = Math.PI / 2;
    this.moveTo(x + tl, y).lineTo(x + w - tr, y);
    if (tr) this.arcSegment(x + w - tr, y + tr, tr, tr, 0, -Q, Q, false);
    this.lineTo(x + w, y + h - br);
    if (br) this.arcSegment(x + w - br, y + h - br, br, br, 0, 0, Q, false);
    this.lineTo(x + bl, y + h);
    if (bl) this.arcSegment(x + bl, y + h - bl, bl, bl, 0, Q, Q, false);
    this.lineTo(x, y + tl);
    if (tl) this.arcSegment(x + tl, y + tl, tl, tl, 0, Math.PI, Q, false);
    return this.closePath().moveTo(x, y);
  }
  /** append SVG path data ('M10 10 L20 20 A…'); see graphics/svg.js @param {string} d */
  svg(d) { parseSvgPath(d, this); return this; }
  /**
   * The path's operators in PDF space for a page (or pattern cell) of height H, relative to the PDF-space origin
   * (ox, oy) (the caller translates there with cm). A path of only moves draws nothing: ''.
   * @param {number} H @param {number} [ox] @param {number} [oy]
   */
  pdf(H, ox = 0, oy = 0) {
    const { ops, v } = this;
    const Y = H - oy;
    let s = '', j = 0, drawn = false;
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i];
      if (o === 'h') { s += 'h '; continue; }
      if (o === 'c') { s += `${num(v[j] - ox)} ${num(Y - v[j + 1])} ${num(v[j + 2] - ox)} ${num(Y - v[j + 3])} ${num(v[j + 4] - ox)} ${num(Y - v[j + 5])} c `; j += 6; drawn = true; continue; }
      if (o === 'm' && (i === ops.length - 1 || ops[i + 1] === 'm')) { j += 2; continue; } // a move with nothing after it draws nothing
      s += `${num(v[j] - ox)} ${num(Y - v[j + 1])} ${o} `; j += 2;
      if (o === 'l') drawn = true;
    }
    return drawn ? s : '';
  }
}
