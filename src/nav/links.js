// @ts-check
/**
 * Page method: a link annotation over a box, to a URL or to a page (which may not exist yet: its destination is
 * written when that page's height is known, else at the end). Tagged, the link gets a Link structure element.
 */
import { ascii, num, text as pdfText } from '../core/serialize.js';
import { unbrand } from '../core/brand.js';

/**
 * @this {import('../page.js').Page}
 * @param {number} x @param {number} y @param {number} w @param {number} h
 * @param {{ url?: string, page?: number | import('../page.js').Page, top?: number }} target
 * @param {{ alt?: string }} [o] alt: the description a screen reader says (default: the URL or "Page n")
 */
export function link(x, y, w, h, target, o = {}) {
  const doc = this.doc, H = this.height;
  const rect = `[${num(x)} ${num(H - y - h)} ${num(x + w)} ${num(H - y)}]`;
  /** @type {string | null} */
  let action = null, say = o.alt;
  /** @type {number} */
  let to = -1;
  if (typeof target?.url === 'string') { action = `/A << /Type /Action /S /URI /URI ${ascii(target.url)} >>`; say ??= target.url; }
  else if (target?.page != null) {
    to = typeof target.page === 'number' ? target.page - 1 : unbrand(target.page, 'page', doc, 'page'); // a forged page object is refused
    if (!(Number.isInteger(to) && to >= 0)) throw new RangeError('page.link: target.page is a whole number from 1');
    say ??= `Page ${to + 1}`;
  } else throw new TypeError('page.link: the target is { url } or { page, top? }');
  let key = -1;
  const ref = this.annotate((_ref, final) => {
    let dest = action;
    if (!dest) {
      const th = doc.pageHeight(to);
      if (th === undefined && !final) return undefined; // the page is not there yet: asked again at the end
      if (th === undefined) doc.warn(`A link points to page ${to + 1}, but the PDF has ${doc.pageCount} pages`);
      dest = th === undefined ? '' : `/Dest [${doc.pageRef(to)} 0 R ${target.top == null ? '/Fit' : `/XYZ null ${num(th - target.top)} null`}]`;
    }
    return `<< /Type /Annot /Subtype /Link /F 4 /Rect ${rect} /Border [0 0 0] ${dest} /Contents ${pdfText(say)}${key >= 0 ? ` /StructParent ${key}` : ''} >>`;
  });
  if (doc.tags) key = doc.tags.link(this, ref);
  return this;
}
