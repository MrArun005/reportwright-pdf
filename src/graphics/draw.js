// @ts-check
/**
 * Page methods for vector graphics: paths (page.path() → graphics/path.js), fill / stroke / fillAndStroke / clip,
 * page.svgPath, stroke styles, opacity and blend modes (ExtGState, one per distinct value in the document), transforms
 * (translate, rotate, scale, skew, transform) with save()/restore(), and page.figure() for tagged PDFs.
 *
 * Coordinates are top-left, y down. A user transform T (in that space) is written as the PDF matrix F·T·F, F the
 * page's flip (y → H − y), so every other module's operators (which convert y themselves) follow it too, and text is
 * not mirrored. The accumulated T is tracked per page: patterns (which ignore the CTM) get it in their /Matrix.
 *
 * save()/restore() nest at most MAX_DEPTH deep (27 in PDF/A, whose limit is 28 with the one this module adds around
 * a semi-transparent draw); a restore() without a save() throws; saves left open at the page's end are closed there
 * with a warning. Transparency (opacity < 1, a blend mode) gives the page a transparency group (/Group), as PDF/A-2
 * asks.
 */
import { num, pdfName } from '../core/serialize.js';
import { Path } from './path.js';
import { paintOp, shading } from './paint.js';

const MAX_DEPTH = 1000, MAX_DEPTH_PDFA = 27, MAX_DASH = 100;
export const BLEND_MODES = ['Normal', 'Multiply', 'Screen', 'Overlay', 'Darken', 'Lighten', 'ColorDodge', 'ColorBurn', 'HardLight', 'SoftLight', 'Difference', 'Exclusion', 'Hue', 'Saturation', 'Color', 'Luminosity'];
const BLEND = new Map(BLEND_MODES.map((m) => [m.toLowerCase(), m]));
const CAPS = ['butt', 'round', 'square'], JOINS = ['miter', 'round', 'bevel'];
const GROUP = '<< /Type /Group /S /Transparency /CS /DeviceRGB >>';

/** @typedef {[number, number, number, number, number, number]} Matrix  [a b c d e f], row vectors: p · M */
/** @typedef {{ m: Matrix, stack: Matrix[], transparent: boolean, watched: boolean }} State */

/** @type {WeakMap<object, State>} */
const states = new WeakMap();
/** @param {any} page @returns {State} */
export function state(page) {
  let s = states.get(page);
  if (!s) states.set(page, s = { m: [1, 0, 0, 1, 0, 0], stack: [], transparent: false, watched: false });
  return s;
}
/** A · B (A first) @param {Matrix} A @param {Matrix} B @returns {Matrix} */
export const mul = (A, B) => [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3],
  A[4] * B[0] + A[5] * B[2] + B[4], A[4] * B[1] + A[5] * B[3] + B[5]];
/** the flip between top-left space and PDF space for height H (its own inverse) @param {number} H @returns {Matrix} */
export const flip = (H) => [1, 0, 0, -1, 0, H];
/** a matrix coefficient: checked by num() (finite, < 1e9), written to 6 decimals (3 would skew rotations) @param {number} v */
export const num6 = (v) => (num(v), String(Math.round(v * 1e6) / 1e6 || 0));
/** @param {Matrix} m */
export const matrix = (m) => m.map(num6).join(' ');

/** the page uses transparency: its /Group (on the page the pattern cell belongs to, for a cell) @param {any} page */
export function transparent(page) { state(page).transparent = true; page.entries.set('Group', GROUP); }

/**
 * the ExtGState operator for o's opacity and blend mode, or '' when they change nothing
 * @param {any} page @param {{ opacity?: number, fillOpacity?: number, strokeOpacity?: number, blendMode?: string }} o
 */
function gstate(page, o) {
  const unit = (/** @type {any} */ v, /** @type {string} */ k) => {
    if (v == null) return 1;
    if (typeof v !== 'number' || !(v >= 0 && v <= 1)) throw new RangeError(`${k} is 0–1, not ${v}`);
    return v;
  };
  const all = unit(o.opacity, 'opacity'), ca = all * unit(o.fillOpacity, 'fillOpacity'), CA = all * unit(o.strokeOpacity, 'strokeOpacity');
  let bm = 'Normal';
  if (o.blendMode != null) {
    bm = BLEND.get(String(o.blendMode).replace(/-/g, '').toLowerCase()) ?? '';
    if (!bm) throw new TypeError(`blendMode is one of ${BLEND_MODES.join(', ')} (or as canvas: 'multiply', 'color-dodge'…), not ${JSON.stringify(o.blendMode)}`);
  }
  if (ca === 1 && CA === 1 && bm === 'Normal') return '';
  const gs = page.doc.resource('ExtGState', `<< /Type /ExtGState${ca !== 1 ? ` /ca ${num(ca)}` : ''}${CA !== 1 ? ` /CA ${num(CA)}` : ''}${bm !== 'Normal' ? ` /BM ${pdfName(bm)}` : ''} >>`);
  transparent(page);
  return `/${gs} gs\n`;
}

/**
 * The stroke style operators (width, dash and phase, cap, join, miter limit), each set only when it changes. Checked
 * in full before anything is written. @param {any} c the page's Content @param {StrokeOptions} o
 * @typedef {{ width?: number, dash?: number[] | null, dashPhase?: number, cap?: string, join?: string, miterLimit?: number }} StrokeOptions
 */
function strokeStyle(c, o) {
  const w = o.width ?? 1;
  if (typeof w !== 'number' || !(w >= 0 && w < 1e9)) throw new RangeError(`stroke width is a number ≥ 0, not ${w}`);
  let dash = '[] 0';
  if (o.dash != null && o.dash.length) {
    if (!Array.isArray(o.dash) || o.dash.length > MAX_DASH) throw new RangeError(`dash is an array of at most ${MAX_DASH} lengths`);
    let sum = 0;
    for (const v of o.dash) { if (typeof v !== 'number' || !(v >= 0 && v < 1e9)) throw new RangeError(`a dash length is a number ≥ 0, not ${v}`); sum += v; }
    if (!(sum > 0)) throw new RangeError('dash: the lengths cannot all be 0 (PDF forbids it)');
    dash = `[${o.dash.map(num).join(' ')}] ${num(o.dashPhase ?? 0)}`;
  } else if (o.dashPhase != null) num(o.dashPhase);
  const cap = CAPS.indexOf(o.cap ?? 'butt'), join = JOINS.indexOf(o.join ?? 'miter'), ml = o.miterLimit ?? 10;
  if (cap < 0) throw new TypeError(`cap is butt, round or square, not ${JSON.stringify(o.cap)}`);
  if (join < 0) throw new TypeError(`join is miter, round or bevel, not ${JSON.stringify(o.join)}`);
  if (typeof ml !== 'number' || !(ml >= 1 && ml < 1e9)) throw new RangeError(`miterLimit is a number ≥ 1, not ${ml}`);
  return () => {
    c.lineWidth(w);
    if (dash !== c.st.dash) { c.s += `${dash} d\n`; c.st.dash = dash; }
    if (cap !== (c.st.cap ?? 0)) { c.s += `${cap} J\n`; c.st.cap = cap; }
    if (join !== (c.st.join ?? 0)) { c.s += `${join} j\n`; c.st.join = join; }
    if (ml !== (c.st.ml ?? 10)) { c.s += `${num(ml)} M\n`; c.st.ml = ml; }
  };
}

/**
 * Paint a path: mode 'f' fill, 'S' stroke, 'B' both. Everything is checked and built before the first operator is
 * written. @param {any} page @param {Path} path @param {'f' | 'S' | 'B'} mode @param {DrawOptions} o
 * @typedef {StrokeOptions & { fill?: any, stroke?: any, color?: any, rule?: 'nonzero' | 'evenodd', opacity?: number,
 *   fillOpacity?: number, strokeOpacity?: number, blendMode?: string }} DrawOptions
 */
function paint(page, path, mode, o = {}) {
  if (!(path instanceof Path)) throw new TypeError('Not a path: use page.path() (or page.svgPath(d, options))');
  const evenodd = rule(o.rule);
  // ponytail: a path of 3+ segments is written relative to its first point, inside q/cm: the same shape drawn
  // anywhere then has the same operators, which deflate to a back-reference (absolute coordinates never repeat)
  const H = page.height, local = path.ops.length >= 3;
  const ox = local ? Math.round(path.v[0] * 1000) / 1000 : 0, oy = local ? Math.round((H - path.v[1]) * 1000) / 1000 : 0;
  const ops = path.pdf(H, ox, oy);
  const c = page.content;
  const fill = mode !== 'S' ? paintOp(page, o.fill ?? o.color ?? 0, false) : '';
  const style = mode !== 'f' ? strokeStyle(c, o) : null;
  const stroke = mode !== 'f' ? paintOp(page, o.stroke ?? o.color ?? 0, true) : '';
  const gs = gstate(page, o);
  if (!ops) return page;
  c.draw(); c.et();
  if (gs) { c.q(); c.s += gs; }
  if (fill) c.fill(fill);
  if (stroke) c.stroke(stroke);
  style?.();
  // colours and styles are set before the q, so they outlive its Q (and are not set again by the next shape);
  // with an ExtGState the q above is reused (one q: PDF/A's nesting limit)
  const cm = local && (ox || oy) ? `1 0 0 1 ${num(ox)} ${num(oy)} cm ` : '';
  const wrap = cm && !gs;
  c.s += `${wrap ? 'q ' : ''}${cm}${ops}${mode}${evenodd && mode !== 'S' ? '*' : ''}${wrap ? ' Q' : ''}\n`;
  if (gs) c.Q();
  return page;
}
/** @param {any} r */
const rule = (r) => { if (r != null && r !== 'nonzero' && r !== 'evenodd') throw new TypeError(`rule is 'nonzero' or 'evenodd', not ${JSON.stringify(r)}`); return r === 'evenodd'; };

/** @this {any} */
export function path() { return new Path(); }
/** @this {any} @param {Path} p @param {DrawOptions} [o] */
export function fill(p, o) { return paint(this, p, 'f', o); }
/** @this {any} @param {Path} p @param {DrawOptions} [o] */
export function stroke(p, o) { return paint(this, p, 'S', o); }
/** @this {any} @param {Path} p @param {DrawOptions} [o] */
export function fillAndStroke(p, o) { return paint(this, p, 'B', o); }
/**
 * SVG path data drawn as rect() draws: fill, stroke or both; neither: filled black. @this {any} @param {string} d @param {DrawOptions} [o]
 */
export function svgPath(d, o = {}) {
  const p = new Path().svg(d);
  return paint(this, p, o.fill != null && o.stroke != null ? 'B' : o.stroke != null ? 'S' : 'f', o);
}
/**
 * Clip what is drawn next to the path (intersected with the current clip) until the enclosing restore(). An empty path
 * clips everything away. @this {any} @param {Path} p @param {'nonzero' | 'evenodd'} [r]
 */
export function clip(p, r) {
  if (!(p instanceof Path)) throw new TypeError('clip: not a path (use page.path())');
  const evenodd = rule(r);
  this.content.op(`${p.pdf(this.height) || '0 0 0 0 re '}W${evenodd ? '*' : ''} n`);
  return this;
}
/**
 * Paint a gradient over the current clip (the PDF sh operator), following the transform. @this {any} @param {any} g a gradient (page.linearGradient / radialGradient)
 */
export function shade(g) {
  const sh = this.doc.resource('Shading', shading(this, g));
  this.content.op(`q 1 0 0 -1 0 ${num(this.height)} cm /${sh} sh Q`);
  return this;
}

/** @this {any} */
export function save() {
  const s = state(this), max = this.doc.pdfa ? MAX_DEPTH_PDFA : MAX_DEPTH;
  if (s.stack.length >= max) throw new RangeError(`page.save: at most ${max} nested saves${this.doc.pdfa ? ' in PDF/A' : ''}; restore() some first`);
  if (!s.watched && this.ref != null && !this.cell) {
    s.watched = true;
    this.onWrite(() => { if (s.stack.length) this.doc.warn(`Page ${this.number}: ${s.stack.length} page.save() without a page.restore(); restored at the end of the page`); });
  }
  this.content.q();
  s.stack.push(s.m);
  return this;
}
/** @this {any} */
export function restore() {
  const s = state(this);
  if (!s.stack.length) throw new Error('page.restore: there is no page.save() to restore');
  this.content.Q();
  s.m = /** @type {Matrix} */ (s.stack.pop());
  return this;
}
/** Multiply the current transform by [a b c d e f] (as canvas transform()). @this {any} @param {number} a @param {number} b @param {number} c @param {number} d @param {number} e @param {number} f */
export function transform(a, b, c, d, e, f) {
  /** @type {Matrix} */ const T = [a, b, c, d, e, f];
  T.forEach((v) => { if (typeof v !== 'number' || !(Math.abs(v) < 1e9)) throw new RangeError(`transform: ${v} is not a usable number`); });
  const H = this.height;
  const pdf = /** @type {Matrix} */ ([a, -b, -c, d, c * H + e, H - d * H - f]);
  const s = state(this);
  const m = mul(T, s.m);
  this.content.op(`${matrix(pdf)} cm`);
  s.m = m;
  return this;
}
/** @this {any} @param {number} x @param {number} y */
export function translate(x, y) { return transform.call(this, 1, 0, 0, 1, x, y); }
/** clockwise on the page, in radians (as canvas) @this {any} @param {number} angle */
export function rotate(angle) { num(angle); return transform.call(this, Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0); }
/** @this {any} @param {number} sx @param {number} [sy] */
export function scale(sx, sy = sx) { return transform.call(this, sx, 0, 0, sy, 0, 0); }
/** skew by angles (radians) along x and y (as CSS skew(ax, ay)) @this {any} @param {number} ax @param {number} [ay] */
export function skew(ax, ay = 0) { num(ax); num(ay); return transform.call(this, 1, Math.tan(ay), Math.tan(ax), 1, 0, 0); }

/**
 * What fn draws is a Figure with alternate text (tagged PDFs; alt is required there). Without tagged it just runs fn.
 * Graphics drawn outside a figure (or another tag) are artifacts. @this {any} @template T @param {{ alt: string }} o @param {() => T} fn @returns {T}
 */
export function figure(o, fn) {
  if (typeof fn !== 'function') throw new TypeError('page.figure({ alt }, fn): fn draws the figure');
  if (this.doc.tagged && !(typeof o?.alt === 'string' && o.alt.trim())) throw new TypeError('page.figure: a tagged PDF needs alt text for a figure ({ alt: "…" })');
  return this.tag('Figure', fn, { alt: o?.alt });
}
