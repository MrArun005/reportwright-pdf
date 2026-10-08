// @ts-check
/**
 * page.textBox: paragraphs (split at \n) wrapped by word into a width, a long word broken where it overflows; aligned
 * left, right, centre or justified (word spacing: Tw for a standard font, TJ adjustments at spaces for an embedded
 * one). maxLines ends the last line with an ellipsis; height stops at the last whole line that fits and returns the
 * rest as overflow (to continue in another box). No hyphenation.
 */
import { num } from '../core/serialize.js';
import { segments, runWidth } from './runs.js';
import { fontsOf, textState, drawLine } from './text.js';

/**
 * @this {import('../page.js').Page}
 * @param {string} str
 * @param {import('./text.js').TextOptions & { width: number, height?: number, align?: 'left' | 'right' | 'center' | 'justify',
 *   lineHeight?: number, maxLines?: number, ellipsis?: boolean }} o
 * @returns {{ height: number, lines: number, overflow: string }}
 */
export function textBox(str, o) {
  const fonts = fontsOf(this, o, 'page.textBox');
  const size = o.size ?? 12, x = o.x ?? 0, y = o.y ?? 0, W = o.width;
  num(x); num(y); num(size); num(W);
  if (!(W > 0)) throw new RangeError(`page.textBox: width is above 0, not ${W}`);
  const ts = textState(o), sp = ts.sp;
  const main = fonts[0].impl;
  const lh = o.lineHeight ?? main.lineHeight * size;
  num(lh);
  if (!(lh > 0)) throw new RangeError(`page.textBox: lineHeight is above 0, not ${lh}`);
  const align = o.align ?? (o.direction === 'rtl' ? 'right' : 'left');
  if (!['left', 'right', 'center', 'justify'].includes(align)) throw new RangeError(`page.textBox: align is left, right, center or justify, not ${JSON.stringify(align)}`);
  if (o.height != null) num(o.height);
  if (o.maxLines != null && !(Number.isInteger(o.maxLines) && o.maxLines >= 0)) throw new RangeError(`page.textBox: maxLines is a whole number, not ${o.maxLines}`);
  const byHeight = o.height != null ? Math.max(0, Math.floor(o.height / lh + 1e-9)) : Infinity;
  const max = Math.min(o.maxLines ?? Infinity, byHeight);
  const ro = { kerning: o.kerning, rtl: o.direction === 'rtl', ws: sp.tw, measure: true };
  /** @type {Map<string, number>} */
  const memo = new Map();
  const width = (/** @type {string} */ s) => {
    let w = memo.get(s);
    if (w === undefined) {
      w = 0;
      for (const g of segments(s, fonts, ro)) w += runWidth(g.run, size, sp);
      if (memo.size < 10000) memo.set(s, w);
    }
    return w;
  };
  const text = String(str ?? '');

  /** @type {{ s: number, e: number, last: boolean }[]} lines as [s, e) of text; last: a paragraph's last line */
  const lines = [];
  const EPS = 1e-6;
  let p = 0;
  for (const raw of text.split('\n')) {
    if (lines.length > max) break; // one line past max is enough to know where the overflow starts
    const base = p, first = lines.length, para = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    p += raw.length + 1;
    // greedy, a word at a time; a line's width is the sum of its words' and spaces' (ponytail: kerning across a
    // space is not counted, a few thousandths of an em at most)
    let s = -1, e = 0, lw = 0, q = 0;
    const commit = (/** @type {boolean} */ last) => { lines.push(s < 0 ? { s: base + q, e: base + q, last } : { s: base + s, e: base + e, last }); s = -1; lw = 0; };
    for (const word of para.split(' ')) {
      const ws = q, we = q + word.length;
      q = we + 1;
      if (s < 0) {
        if (!word) continue; // a line does not start with the spaces it broke at
        s = ws; e = we; lw = width(word);
      } else {
        const add = width(' ') + width(word);
        if (lw + add <= W + EPS) { e = we; lw += add; continue; }
        commit(false);
        if (!word) continue;
        s = ws; e = we; lw = width(word);
      }
      while (lw > W + EPS) { // a word longer than the line: break it where it overflows (at least one character a line)
        let k = s, acc = 0;
        for (const ch of para.slice(s, e)) {
          const cw = width(ch);
          if (acc + cw > W + EPS && k > s) break;
          acc += cw; k += ch.length;
        }
        if (k >= e) break;
        const end = e;
        e = k; commit(false);
        s = k; e = end; lw = width(para.slice(s, e));
      }
    }
    q = para.length;
    if (s < 0 && lines.length > first) lines[lines.length - 1].last = true; // only spaces were left
    else commit(true);
  }
  for (const l of lines) while (l.e > l.s && text[l.e - 1] === ' ') l.e--;

  const shown = lines.slice(0, max);
  let overflow = lines.length > shown.length ? text.slice(lines[shown.length].s) : '';
  // maxLines (not height alone): the last line shown ends with an ellipsis when text is left
  const ellipsis = overflow && o.maxLines != null && shown.length === o.maxLines && shown.length > 0 && o.ellipsis !== false;
  /** @type {string[]} */
  const draw = shown.map((l) => text.slice(l.s, l.e));
  if (ellipsis) {
    const dots = fonts.some((f) => f.impl.has(0x2026)) ? '…' : '...';
    const l = shown[shown.length - 1];
    let cut = l.e;
    while (cut > l.s && width(text.slice(l.s, cut).trimEnd() + dots) > W + EPS) cut -= cut - 2 >= l.s && /[\udc00-\udfff]/.test(text[cut - 1]) ? 2 : 1;
    const kept = text.slice(l.s, cut).trimEnd();
    draw[draw.length - 1] = kept + dots;
    overflow = text.slice(l.s + kept.length).replace(/^ +/, '');
    l.last = true; // not justified
  }
  const ascent = main.ascent * size;
  draw.forEach((s, i) => {
    const l = shown[i];
    if (!s) return;
    const w = width(s);
    let dx = 0, line = ts;
    if (align === 'right') dx = W - w;
    else if (align === 'center') dx = (W - w) / 2;
    else if (align === 'justify' && !l.last) {
      const gaps = s.split(' ').length - 1;
      if (gaps && W > w) line = { ...ts, sp: { ...sp, tw: sp.tw + (W - w) / gaps / (sp.tz / 100) } };
    }
    drawLine(this, fonts, s, x + dx, y + i * lh + ascent, size, line, o);
  });
  return { height: shown.length * lh, lines: shown.length, overflow };
}
