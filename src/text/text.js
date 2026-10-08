// @ts-check
/** Page method: one line of text. y is the top of the line box (the baseline is at y + font.ascent · size). */
import { colorOp } from '../graphics/color.js';
import { num } from '../core/serialize.js';
import { unbrand } from '../core/brand.js';

/**
 * @this {import('../page.js').Page}
 * @param {string} str
 * @param {{ x?: number, y?: number, font: import('../document.js').Font, size?: number, color?: any }} o
 */
export function text(str, o) {
  const font = o?.font;
  if (!font || typeof font.encode !== 'function') throw new TypeError('page.text: options.font is required (pdf.standardFont(name) or await pdf.embedFont(bytes))');
  unbrand(font, 'font', this.doc, 'font'); // a forged or copied font object (its own encode, name) is refused
  const size = o.size ?? 12, x = o.x ?? 0, y = o.y ?? 0;
  num(x); num(y); num(size); // finite, or it throws before anything is drawn
  const body = font.encode(String(str ?? ''));
  if (!body) return this;
  const c = this.content;
  c.draw();
  c.fill(colorOp(o.color ?? 0, false, this.doc));
  c.text(font.name, size, x, this.height - y - font.ascent * size, body);
  return this;
}
