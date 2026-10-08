// @ts-check
/**
 * page.textBox: paragraphs (split at \n) wrapped by word into a width, a long word broken where it overflows; aligned
 * left, right, centre or justified (word spacing: Tw for a standard font, TJ adjustments at spaces for an embedded
 * one). maxLines ends the last line with an ellipsis; height stops at the last whole line that fits and returns the
 * rest as overflow (to continue in another box). No hyphenation.
 */
import { num } from '../core/serialize.js';
import { segments, runWidth } from './runs.js';
import { fontsOf, textState, drawLine, MAX_TEXT } from './text.js';

const MAX_LINES = 100_000; // laid out at most per box (the rest is overflow)

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
  /** @type {Map<string, number>} widths of short strings (words, characters), measured once */
  const memo = new Map();
  const width = (/** @type {string} */ s) => {
    let w = memo.get(s);
    if (w === undefined) {
      w = 0;
      for (const g of segments(s, fonts, ro)) w += runWidth(g.run, size, sp);
      if (s.length <= 64 && memo.size < 10000) memo.set(s, w);
    }
    return w;
  };
  const text = String(str ?? '');
  if (text.length > MAX_TEXT) throw new RangeError(`page.textBox: the text is ${text.length} characters, more than ${MAX_TEXT}`);

  // Every step below is linear in the text it reads: each word is measured once, a long word is broken with its
  // characters' widths summed once, layout stops one line past what can be shown (that is enough to know the
  // overflow), and at most MAX_LINES lines are laid out.
  const stop = Math.min(max, MAX_LINES);
  /** @type {{ s: number, e: number, last: boolean }[]} lines as [s, e) of text; last: a paragraph's last line */
  const lines = [];
  const EPS = 1e-6;
  let p = 0;
  paras: for (const raw of text.split('\n')) {
    if (lines.length > stop) break;
    const base = p, first = lines.length, para = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    p += raw.length + 1;
    // greedy, a word at a time; a line's width is the sum of its words' and spaces' (ponytail: kerning across a
    // space is not counted, a few thousandths of an em at most)
    let s = -1, e = 0, lw = 0, q = 0;
    const commit = (/** @type {boolean} */ last) => { lines.push(s < 0 ? { s: base + q, e: base + q, last } : { s: base + s, e: base + e, last }); s = -1; lw = 0; };
    for (const word of para.split(' ')) {
      if (lines.length > stop) break paras;
      const ws = q, we = q + word.length;
      q = we + 1;
      if (!word && s < 0) continue; // a line does not start with the spaces it broke at
      const ww = width(word);
      if (s >= 0) {
        const add = width(' ') + ww;
        if (lw + add <= W + EPS) { e = we; lw += add; continue; }
        commit(false);
        if (!word) continue;
      }
      s = ws; e = we; lw = ww;
      if (lw <= W + EPS) continue;
      // a word longer than the line: broken where it overflows, at least one character a line, in one pass
      let acc = 0;
      e = s;
      for (const ch of word) {
        const cw = width(ch);
        if (acc + cw > W + EPS && e > s) {
          if (lines.length > stop) break paras;
          const at = e;
          commit(false);
          s = e = at; acc = 0;
        }
        acc += cw; e += ch.length;
      }
      lw = acc;
    }
    q = para.length;
    if (s < 0 && lines.length > first) lines[lines.length - 1].last = true; // only spaces were left
    else commit(true);
  }
  for (const l of lines) while (l.e > l.s && text[l.e - 1] === ' ') l.e--;

  const shown = lines.slice(0, stop);
  let overflow = lines.length > shown.length ? text.slice(lines[shown.length].s) : '';
  // maxLines (not height alone): the last line shown ends with an ellipsis when text is left
  const ellipsis = overflow && o.maxLines != null && shown.length === o.maxLines && shown.length > 0 && o.ellipsis !== false;
  /** @type {string[]} */
  const draw = shown.map((l) => text.slice(l.s, l.e));
  if (ellipsis) {
    const dots = fonts.some((f) => f.impl.has(0x2026)) ? '…' : '...';
    const l = shown[shown.length - 1], room = W - width(dots) + EPS;
    // the longest start of the line that fits with the dots: characters' widths summed once (linear)
    let cut = l.s, acc = 0;
    for (const ch of text.slice(l.s, l.e)) { acc += width(ch); if (acc > room) break; cut += ch.length; }
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
