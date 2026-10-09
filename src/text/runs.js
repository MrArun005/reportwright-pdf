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
 * @typedef {{ b: string, w: number, a: number, dx: number, dy: number, sp: boolean, at?: string, n?: number, c?: boolean }} Item
 *   a glyph: its bytes (escaped), its PDF width and wanted advance, offsets (thousandths of the size), whether word
 *   spacing follows it, an ActualText for the n glyphs from here, and c: the glyph is drawn out of the flow, after
 *   the run, in a span of no text (a cluster's glyph other than the one standing for its text: fonts/embed.js)
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
const RTL_RANGES = '\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff';
/**
 * Right-to-left letters only (an Arabic or Hebrew run in a left-to-right line) are drawn as one right-to-left run;
 * anything mixed is drawn in the order given (ponytail: no UAX #9, the caller orders mixed runs).
 * @param {string} t @param {RunOptions} o
 */
const dirOf = (t, o) => (!o.rtl && maybeRtl(t) && RTL.test(t) && !LTR.test(t) ? { ...o, rtl: true } : o);
/** any code unit at or past U+0590 (a cheap test before the regular expressions) @param {string} t */
const maybeRtl = (t) => { for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) >= 0x590) return true; return false; };
const RTL = new RegExp(`[${RTL_RANGES}]`, 'u'), LTR = new RegExp(`(?![${RTL_RANGES}])[\\p{L}\\p{Nd}]`, 'u');

/**
 * The text split by font: each character in the first font that has it (white space stays in the run it is in);
 * a character no font has stays in the run it is in (the first font reports it). Right-to-left: segments reversed.
 * @param {string} str @param {{ font: any, impl: FontImpl }[]} fonts @param {RunOptions} o @returns {Seg[]}
 */
export function segments(str, fonts, o) {
  if (fonts.length === 1) { const f = fonts[0]; return [{ font: f.font, impl: f.impl, run: f.impl.items(str, dirOf(str, o)) }]; }
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
  const segs = parts.map(([k, s, e]) => { const t = str.slice(s, e), f = fonts[k]; return { font: f.font, impl: f.impl, run: f.impl.items(t, dirOf(t, o)) }; });
  return o.rtl ? segs.reverse() : segs;
}

/** a segment's advance in points (Tc, Tw and Tz applied) @param {Run} run @param {number} size @param {Spacing} sp */
export function runWidth(run, size, sp) {
  let a = 0, n = 0, s = 0;
  if (Array.isArray(run)) for (const it of run) { a += it.a; if (it.sp) s++; if (!it.c) n++; } // Tc: per glyph in the flow
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
 * for an embedded one (Identity-H codes are two bytes, which Tw does not touch). Glyphs out of the flow (Item.c) are
 * drawn after it, from the run's start again (0 0 Td), in an ActualText span of no text; there each glyph of the flow
 * is only its advance (and Tc, as the reader adds Tc to every glyph it draws).
 * @param {Run} run @param {number} size @param {number} rise the Ts in force @param {number} tw @param {boolean} standard
 * @param {number} [tc] the Tc in force
 */
export function runOps(run, size, rise, tw, standard, tc = 0) {
  if (!Array.isArray(run)) return run.body ? `(${run.body}) Tj\n` : '';
  const wsT = standard ? 0 : tw * 1000 / size, tcT = tc * 1000 / size;
  let s = '', arr = '', lit = '', cur = 0, pos = 0, r = rise, left = 0, adjusted = false, out = false;
  const endLit = () => { if (lit) { arr += `(${lit})`; lit = ''; } };
  const flush = () => { endLit(); if (arr) { s += adjusted ? `[${arr}] TJ\n` : `${arr} Tj\n`; arr = ''; adjusted = false; } };
  /** a glyph where it goes: Ts for its rise, a TJ adjustment for its offset @param {Item} it */
  const put = (it) => {
    const want = rise + it.dy * size / 1000;
    if (Math.abs(want - r) >= 0.0005) { flush(); s += `${num(want)} Ts\n`; r = want; }
    const d = cur - (pos + it.dx);
    if (Math.abs(d) >= 0.0005) { const q = num(d); endLit(); arr += ` ${q} `; adjusted = true; cur -= Number(q); }
    lit += it.b; cur += it.w;
  };
  for (const it of run) {
    if (it.c) { pos += it.a; out = true; continue; }
    if (it.at !== undefined) { flush(); s += `/Span << /ActualText ${textString(it.at)} >> BDC\n`; left = it.n || 1; }
    put(it);
    pos += it.a + (it.sp ? wsT : 0);
    if (left && --left === 0) { flush(); s += 'EMC\n'; }
  }
  flush();
  if (out) {
    s += `/Span << /ActualText ${textString('')} >> BDC\n0 0 Td\n`;
    cur = pos = 0;
    for (const it of run) {
      if (!it.c) { pos += it.a + (it.sp ? wsT : 0) + tcT; continue; }
      put(it);
      cur += tcT; pos += it.a;
    }
    flush();
    s += 'EMC\n';
  }
  if (r !== rise) s += `${num(rise)} Ts\n`;
  return s;
}
