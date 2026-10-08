// @ts-check
/**
 * Page method: one line of text. y is the top of the line box (the baseline is at y + font.ascent · size). Kerned by
 * default, through the font's shaper when it has one, with fallback fonts, spacing, scaling, rise, render modes and
 * rotation. text/runs.js makes the runs and their operators; text/box.js wraps paragraphs with drawLine.
 */
import { colorOp } from '../graphics/color.js';
import { num } from '../core/serialize.js';
import { unbrand } from '../core/brand.js';
import { segments, spacing, runWidth, runOps } from './runs.js';

/** the longest text page.text and page.textBox take (characters) */
export const MAX_TEXT = 10_000_000;

const MODES = { fill: 0, stroke: 1, fillStroke: 2, invisible: 3, fillClip: 4, strokeClip: 5, fillStrokeClip: 6, clip: 7 };

/**
 * @typedef {{ x?: number, y?: number, font: import('../document.js').Font, size?: number, color?: any,
 *   kerning?: boolean, characterSpacing?: number, wordSpacing?: number, horizontalScaling?: number, rise?: number,
 *   renderMode?: number | keyof typeof MODES, strokeColor?: any, strokeWidth?: number, rotate?: number,
 *   fallback?: import('../document.js').Font[], direction?: 'ltr' | 'rtl' }} TextOptions
 */

/**
 * The font and its fallbacks, each looked up in the brand table (a forged or copied font is refused; its private
 * metrics come from there, never from the object). @param {any} page @param {any} o @param {string} who
 * @returns {{ font: any, impl: import('./runs.js').FontImpl }[]}
 */
export function fontsOf(page, o, who) {
  const font = o?.font;
  if (!font || typeof font.encode !== 'function') throw new TypeError(`${who}: options.font is required (pdf.standardFont(name) or await pdf.embedFont(bytes))`);
  const fb = o.fallback ?? [];
  if (!Array.isArray(fb) || fb.length > 16) throw new TypeError(`${who}: fallback is an array of at most 16 fonts`);
  return [font, ...fb].map((f) => ({ font: f, impl: unbrand(f, 'font', page.doc, 'font') }));
}

/** the text state of the options, checked @param {any} o */
export function textState(o) {
  const sp = spacing(o);
  const rise = o?.rise ?? 0;
  num(rise);
  const m = o?.renderMode ?? 0, Tr = typeof m === 'string' ? (Object.hasOwn(MODES, m) ? /** @type {any} */ (MODES)[m] : -1) : m;
  if (!Number.isInteger(Tr) || Tr < 0 || Tr > 7) throw new RangeError(`renderMode is 0–7 or one of ${Object.keys(MODES).join(', ')}, not ${JSON.stringify(m)}`);
  return { sp, rise, Tr };
}

/**
 * Draw str with its baseline's start at (x, base) (top-left space: base is from the top); returns its advance.
 * @param {any} page @param {{ font: any, impl: import('./runs.js').FontImpl }[]} fonts @param {string} str
 * @param {number} x @param {number} base @param {number} size @param {ReturnType<typeof textState>} ts @param {any} o
 */
export function drawLine(page, fonts, str, x, base, size, ts, o) {
  const segs = segments(str, fonts, { kerning: o.kerning, rtl: o.direction === 'rtl', ws: ts.sp.tw });
  const c = page.content;
  c.draw();
  c.fill(colorOp(o.color ?? 0, false, page.doc));
  if (ts.Tr % 4 === 1 || ts.Tr % 4 === 2) { // the stroking modes
    c.stroke(colorOp(o.strokeColor ?? o.color ?? 0, true, page.doc));
    const w = o.strokeWidth ?? 1;
    num(w);
    if (w < 0) throw new RangeError(`strokeWidth is 0 or more, not ${w}`);
    c.lineWidth(w);
  }
  let at = x;
  for (const s of segs) {
    const ops = runOps(s.run, size, ts.rise, ts.sp.tw, s.impl.standard);
    // Tw only for one-byte fonts: Identity-H gets its word spacing in the TJ adjustments (a reader that also applied
    // Tw to the two-byte code <0020> would space twice)
    if (ops) c.run(s.font.name, size, at, page.height - base, ops, { Tc: ts.sp.tc, Tw: s.impl.standard ? ts.sp.tw : 0, Tz: ts.sp.tz, Ts: ts.rise, Tr: ts.Tr });
    at += runWidth(s.run, size, ts.sp);
  }
  return at - x;
}

/**
 * @this {import('../page.js').Page}
 * @param {string} str
 * @param {TextOptions} o
 */
export function text(str, o) {
  const fonts = fontsOf(this, o, 'page.text');
  const size = o.size ?? 12, x = o.x ?? 0, y = o.y ?? 0;
  num(x); num(y); num(size); // finite, or it throws before anything is drawn
  const ts = textState(o);
  const s = String(str ?? '');
  if (s.length > MAX_TEXT) throw new RangeError(`page.text: the text is ${s.length} characters, more than ${MAX_TEXT}`);
  if (!s) return this;
  if (o.rotate) { // clockwise, in radians, about the line box's top-left corner (as page.rotate)
    num(o.rotate);
    const pg = /** @type {any} */ (this); // save, translate, rotate, restore: installed by graphics/draw.js
    pg.save(); pg.translate(x, y); pg.rotate(o.rotate);
    try { drawLine(this, fonts, s, 0, fonts[0].impl.ascent * size, size, ts, o); } finally { pg.restore(); }
  } else drawLine(this, fonts, s, x, y + fonts[0].impl.ascent * size, size, ts, o);
  return this;
}
