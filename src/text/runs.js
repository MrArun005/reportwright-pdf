// @ts-check
/**
 * Text runs: a string becomes segments (one per font, the first of the font and its fallbacks that has each
 * character), each a run of glyphs from its font (fonts/embed.js, fonts/standard.js: kerned, or shaped), measured and
 * turned into operators here. A run with nothing between its glyphs is one string ((…) Tj); otherwise a TJ array
 * places every glyph where the kerning, the shaper's advances and offsets and the word spacing put it (the PDF's own
 * advance is the /W width; the difference goes between the glyphs), with Ts for vertical offsets and an ActualText
 * span where a glyph cluster is not one glyph standing for its text (ligatures of reordered marks, conjuncts).
 *
 * Positions are kept in thousandths of the font size (as TJ counts); Tc and Tz are left to the reader, which applies
 * them to every glyph the same way, so they need no adjustment here, only in measuring.
 */
import { num, text as textString } from '../core/serialize.js';

/**
 * @typedef {{ b: string, w: number, a: number, dx: number, dy: number, sp: boolean, at?: string, n?: number }} Item
 *   a glyph: its bytes (escaped), its PDF width and wanted advance, offsets (thousandths of the size), whether word
 *   spacing follows it, and an ActualText for the n glyphs from here
 * @typedef {Item[] | { body: string, a: number, n: number, sp: number }} Run  a plain run is one string
 * @typedef {{ kerning?: boolean, rtl?: boolean, ws?: number, measure?: boolean }} RunOptions  measure: record nothing (no glyph for the subset, no warning)
 * @typedef {{ standard: boolean, ascent: number, lineHeight: number, has(cp: number): boolean, items(text: string, o: RunOptions): Run }} FontImpl
 * @typedef {{ kerning?: boolean, characterSpacing?: number, wordSpacing?: number, horizontalScaling?: number, direction?: 'ltr' | 'rtl' }} MeasureOptions
 * @typedef {{ tc: number, tw: number, tz: number }} Spacing  Tc, Tw (points), Tz (percent)
 * @typedef {{ font: any, impl: FontImpl, run: Run }} Seg
 */

/** the spacing options, checked @param {any} o @returns {Spacing} */
export function spacing(o) {
  const tc = o?.characterSpacing ?? 0, tw = o?.wordSpacing ?? 0, tz = o?.horizontalScaling ?? 100;
  num(tc); num(tw); num(tz); // finite, or it throws
  if (!(tz > 0)) throw new RangeError(`horizontalScaling is a percentage above 0, not ${tz}`);
  return { tc, tw, tz };
}

const WS = /^\s$/u;

/**
 * The text split by font: each character in the first font that has it (white space stays in the run it is in);
 * a character no font has stays in the run it is in (the first font reports it). Right-to-left: segments reversed.
 * @param {string} str @param {{ font: any, impl: FontImpl }[]} fonts @param {RunOptions} o @returns {Seg[]}
 */
export function segments(str, fonts, o) {
  if (fonts.length === 1) return [{ ...fonts[0], run: fonts[0].impl.items(str, o) }];
  /** @type {[number, number, number][]} font, start, end */
  const parts = [];
  let cur = -1, start = 0, i = 0;
  for (const ch of str) {
    const cp = /** @type {number} */ (ch.codePointAt(0));
    let k = cur >= 0 && WS.test(ch) && fonts[cur].impl.has(cp) ? cur : fonts.findIndex((f) => f.impl.has(cp));
    if (k < 0) k = cur >= 0 ? cur : 0;
    if (k !== cur) { if (cur >= 0) parts.push([cur, start, i]); cur = k; start = i; }
    i += ch.length;
  }
  if (cur >= 0) parts.push([cur, start, i]);
  const segs = parts.map(([k, s, e]) => ({ ...fonts[k], run: fonts[k].impl.items(str.slice(s, e), o) }));
  return o.rtl ? segs.reverse() : segs;
}

/** a segment's advance in points (Tc, Tw and Tz applied) @param {Run} run @param {number} size @param {Spacing} sp */
export function runWidth(run, size, sp) {
  let a = 0, n = 0, s = 0;
  if (Array.isArray(run)) { n = run.length; for (const it of run) { a += it.a; if (it.sp) s++; } }
  else ({ a, n, sp: s } = run);
  return (a * size / 1000 + n * sp.tc + s * sp.tw) * sp.tz / 100;
}

/** font.widthOfText: one run in one font @param {FontImpl} impl @param {string} str @param {number} size @param {MeasureOptions} [o] */
export function measure(impl, str, size, o) {
  num(size);
  const sp = spacing(o);
  return runWidth(impl.items(str, { kerning: o?.kerning, rtl: o?.direction === 'rtl', ws: sp.tw, measure: true }), size, sp);
}

/**
 * A run's operators (after Tf and Td): `(…) Tj`, or TJ arrays with the adjustments, Ts for vertical offsets and
 * ActualText spans. Word spacing is Tw for a standard font (single-byte code 32) and goes into the TJ adjustments
 * for an embedded one (Identity-H codes are two bytes, which Tw does not touch).
 * @param {Run} run @param {number} size @param {number} rise the Ts in force @param {number} tw @param {boolean} standard
 */
export function runOps(run, size, rise, tw, standard) {
  if (!Array.isArray(run)) return run.body ? `(${run.body}) Tj\n` : '';
  const wsT = standard ? 0 : tw * 1000 / size;
  let s = '', arr = '', lit = '', cur = 0, pos = 0, r = rise, left = 0, adjusted = false;
  const endLit = () => { if (lit) { arr += `(${lit})`; lit = ''; } };
  const flush = () => { endLit(); if (arr) { s += adjusted ? `[${arr}] TJ\n` : `${arr} Tj\n`; arr = ''; adjusted = false; } };
  for (const it of run) {
    if (it.at !== undefined) { flush(); s += `/Span << /ActualText ${textString(it.at)} >> BDC\n`; left = it.n || 1; }
    const want = rise + it.dy * size / 1000;
    if (Math.abs(want - r) >= 0.0005) { flush(); s += `${num(want)} Ts\n`; r = want; }
    const d = cur - (pos + it.dx);
    if (Math.abs(d) >= 0.0005) { const q = num(d); endLit(); arr += ` ${q} `; adjusted = true; cur -= Number(q); }
    lit += it.b; cur += it.w; pos += it.a + (it.sp ? wsT : 0);
    if (left && --left === 0) { flush(); s += 'EMC\n'; }
  }
  flush();
  if (r !== rise) s += `${num(rise)} Ts\n`;
  return s;
}
