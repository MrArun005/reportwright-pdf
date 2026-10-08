// @ts-check
/**
 * What a path is painted with: a colour (graphics/color.js), a gradient (axial or radial shading, any number of colour
 * stops: a Type 2 function, or a Type 3 stitching of them), or a tiling pattern drawn by a callback. Gradients and
 * patterns are pattern colours (/Pattern cs /P1 scn); a gradient also paints the clip area with page.shade().
 *
 * Patterns are laid out in the page's default space, not the current one, so each use carries the current transform
 * in its /Matrix: one Pattern resource per distinct (gradient, matrix), one tiling pattern stream per distinct
 * (pattern, matrix), written with the page that first uses it.
 *
 * Gradients and patterns are opaque handles (core/brand.js): their dictionaries and content live in a private map, so
 * a forged or copied object, or one from another document, is refused instead of written.
 *
 * A tiling pattern's cell is drawn once, by the callback, on a cell "page" (the same drawing methods, top-left space of
 * the cell) whose resources are recorded for the pattern's own /Resources. Text, links and tags are not drawn there.
 */
import { latin1, num, pdfName } from '../core/serialize.js';
import { colorOp } from './color.js';
import { flip, matrix, mul, num6, state, transparent } from './draw.js';
import { brand, kindOf, unbrand } from '../core/brand.js';

const MAX_STOPS = 256;

/** a colour as [r, g, b] 0–1 (gradients are RGB) @param {any} c */
function rgb(c) {
  const op = colorOp(c, false), v = op.split(' ');
  if (v[v.length - 1] === 'g') return [v[0], v[0], v[0]];
  if (v[v.length - 1] === 'rg') return v.slice(0, 3);
  throw new TypeError(`A gradient's colours are RGB or gray, not ${JSON.stringify(c)}`);
}

/**
 * @param {any} doc the document it belongs to @param {2 | 3} type @param {number[]} coords @param {any} stops [[offset, colour], …] or [{ offset, color }, …]
 * @param {{ extend?: boolean | [boolean, boolean] }} [o]
 */
function gradient(doc, type, coords, stops, o = {}) {
  coords.forEach((v) => num(v));
  if (type === 3 && (coords[2] < 0 || coords[5] < 0)) throw new RangeError('radialGradient: a radius cannot be negative');
  if (!Array.isArray(stops) || !stops.length || stops.length > MAX_STOPS) throw new RangeError(`A gradient has 1–${MAX_STOPS} colour stops: [[offset, colour], …]`);
  const list = stops.map((s, i) => {
    const [off, col] = Array.isArray(s) ? s : [s?.offset, s?.color];
    if (typeof off !== 'number' || Number.isNaN(off)) throw new RangeError(`A colour stop's offset is a number 0–1, not ${off}`);
    return { o: Math.round(Math.min(1, Math.max(0, off)) * 1e6) / 1e6, c: rgb(col).join(' '), i }; // clamped, 6 decimals
  }).sort((a, b) => a.o - b.o || a.i - b.i);
  if (list[0].o > 0) list.unshift({ o: 0, c: list[0].c, i: -1 });
  if (list[list.length - 1].o < 1) list.push({ o: 1, c: list[list.length - 1].c, i: -1 });
  const fns = [], bounds = [];
  for (let k = 0; k + 1 < list.length; k++) {
    if (list[k + 1].o <= list[k].o) continue; // a hard stop: no zero-width piece
    if (fns.length) bounds.push(num6(list[k].o));
    fns.push(`<< /FunctionType 2 /Domain [0 1] /C0 [${list[k].c}] /C1 [${list[k + 1].c}] /N 1 >>`);
  }
  const fn = fns.length === 1 ? fns[0] : `<< /FunctionType 3 /Domain [0 1] /Functions [${fns.join(' ')}] /Bounds [${bounds.join(' ')}] /Encode [${fns.map(() => '0 1').join(' ')}] >>`;
  const e = o.extend ?? true, [e0, e1] = Array.isArray(e) ? e : [e, e];
  const dict = `<< /ShadingType ${type} /ColorSpace /DeviceRGB /Coords [${coords.map(num).join(' ')}] /Function ${fn} /Extend [${!!e0} ${!!e1}] >>`;
  return brand(Object.freeze({ type: 'gradient' }), 'gradient', doc, dict);
}

/**
 * A linear gradient from (x0, y0) to (x1, y1), in the space current when it is painted (as canvas).
 * @this {any} @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 @param {any} stops @param {{ extend?: boolean | [boolean, boolean] }} [o]
 */
export function linearGradient(x0, y0, x1, y1, stops, o) { return gradient(base(this.doc), 2, [x0, y0, x1, y1], stops, o); }
/**
 * A radial gradient between the circles (x0, y0, r0) and (x1, y1, r1).
 * @this {any} @param {number} x0 @param {number} y0 @param {number} r0 @param {number} x1 @param {number} y1 @param {number} r1 @param {any} stops @param {{ extend?: boolean | [boolean, boolean] }} [o]
 */
export function radialGradient(x0, y0, r0, x1, y1, r1, stops, o) { return gradient(base(this.doc), 3, [x0, y0, r0, x1, y1, r1], stops, o); }

/** a gradient's shading dictionary @param {any} page @param {any} g */
export const shading = (page, g) => unbrand(g, 'gradient', base(page.doc), 'gradient (page.linearGradient / radialGradient)');

/** the document (a pattern cell's page has a stand-in for it) @param {any} doc */
const base = (doc) => doc.base ?? doc;

/**
 * The operator that sets a fill (or stroke) to a colour, gradient or tiling pattern on this page (or cell).
 * @param {any} page @param {any} v @param {boolean} stroke @returns {string}
 */
export function paintOp(page, v, stroke) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return colorOp(v, stroke); // '#rgb', [r, g, b], a gray level
  const doc = base(page.doc), what = 'gradient or pattern (page.linearGradient / radialGradient / tilingPattern)';
  const m = mul(state(page).m, flip(page.height));
  let value;
  if (kindOf(v) !== 'tiling') value = `<< /Type /Pattern /PatternType 2 /Shading ${unbrand(v, 'gradient', doc, what)} /Matrix [${matrix(m)}] >>`;
  else {
    v = unbrand(v, 'tiling', doc, what);
    const pm = matrix(mul(flip(v.h), m)), key = pm;
    let ref = v.refs.get(key);
    if (ref === undefined) {
      v.refs.set(key, ref = doc.reserve());
      const dict = `<< /Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 ${num(v.w)} ${num(v.h)}] /XStep ${num(v.xs)} /YStep ${num(v.ys)} /Resources ${v.res} /Matrix [${pm}] >>`;
      const content = v.content, r = ref;
      page.onWrite(() => doc.writeStream(r, dict, latin1(content)));
    }
    value = `${ref} 0 R`;
    if (v.transparent) transparent(page);
  }
  const name = page.doc.resource('Pattern', value);
  return stroke ? `/Pattern CS /${name} SCN` : `/Pattern cs /${name} scn`;
}

/**
 * A tiling pattern: draw(cell) draws one cell of width × height (top-left space of the cell) with the page's drawing
 * methods; cells repeat every width + spacing (spacing: a number or [x, y]).
 * @this {any} @param {{ width: number, height: number, spacing?: number | [number, number] }} o @param {(cell: any) => any} draw
 */
export function tilingPattern(o, draw) {
  const page = this, doc = base(page.doc);
  const w = o?.width, h = o?.height, sp = o?.spacing ?? 0, [sx, sy] = Array.isArray(sp) ? sp : [sp, sp];
  for (const v of [w, h]) if (typeof v !== 'number' || !(v > 0 && v < 1e6)) throw new RangeError(`tilingPattern: width and height are numbers > 0, not ${v}`);
  for (const v of [sx, sy]) if (typeof v !== 'number' || !(v >= 0 && v < 1e6)) throw new RangeError(`tilingPattern: spacing is a number ≥ 0, not ${v}`);
  if (typeof draw !== 'function') throw new TypeError('tilingPattern(options, draw): draw(cell) draws one cell');
  /** @type {Map<string, Map<string, string>>} the cell's resources: kind → name → value */
  const used = new Map();
  const proxy = Object.create(doc, {
    base: { value: doc },
    tags: { value: null },
    resource: { value(/** @type {any} */ kind, /** @type {string} */ value, /** @type {string} */ name) {
      const r = doc.resource(kind, value, name);
      let m = used.get(kind);
      if (!m) used.set(kind, m = new Map());
      m.set(r, value);
      return r;
    } },
  });
  const cell = new page.constructor(proxy, page.index, w, h);
  const no = (/** @type {string} */ what) => () => { throw new TypeError(`page.${what} cannot be used in a tiling pattern's cell (shapes, gradients and patterns can)`); };
  Object.assign(cell, {
    cell: true, number: page.number, entries: page.entries,
    onWrite: (/** @type {any} */ fn) => page.onWrite(fn),
    text: no('text'), link: no('link'), annotate: no('annotate'), end: no('end'),
    tag: (/** @type {any} */ _t, /** @type {() => any} */ fn) => fn(), figure: (/** @type {any} */ _o, /** @type {() => any} */ fn) => fn(),
  });
  const r = draw(cell);
  if (r && typeof r.then === 'function') throw new TypeError('tilingPattern: draw must be synchronous (no async function)');
  const left = state(cell).stack.length;
  if (left) doc.warn(`A tiling pattern's cell: ${left} save() without a restore(); restored at the end of the cell`);
  const res = `<< ${[...used].map(([k, m]) => `${pdfName(k)} << ${[...m].map(([n, v]) => `/${n} ${v}`).join(' ')} >>`).join(' ')} >>`;
  const data = { w, h, xs: w + sx, ys: h + sy, content: cell.content.end(), res, transparent: state(cell).transparent, refs: new Map() };
  return brand(Object.freeze({ type: 'tiling' }), 'tiling', doc, data);
}
