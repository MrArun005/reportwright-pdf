// @ts-check
/**
 * The outline (bookmarks), written at the end: entries nest by level (an entry is the child of the nearest one before
 * it at a lower level). Each points at a page with a fit (nav/dest.js) or at a named destination; open or closed
 * (/Count's sign), with a colour (/C, RGB) and bold/italic (/F). From ReportWright's writeOutline
 * (src/exporters/pdfstream.js).
 *
 * Bounds: MAX_ENTRIES entries, levels 0–MAX_LEVEL, titles of MAX_TITLE characters. Nothing recurses: counts are summed
 * bottom-up over the entries in reverse order, and every entry is written in one pass.
 */
import { text } from '../core/serialize.js';
import { device } from '../graphics/color.js';
import { pageIndex, fitOf, destArray, namedDests } from './dest.js';

export const MAX_ENTRIES = 100_000, MAX_LEVEL = 63, MAX_TITLE = 4096;

/**
 * @typedef {{ title: string, page?: number | import('../page.js').Page, dest?: string, level?: number, open?: boolean,
 *   color?: any, bold?: boolean, italic?: boolean, fit?: string, left?: number, top?: number, right?: number, bottom?: number, zoom?: number }} OutlineEntry
 * @typedef {{ title: string, i: number, d: import('./dest.js').Fit | null, named: string | null, level: number, open: boolean, C: string, F: number }} Entry
 * @typedef {{ ref: number, level: number, kids: Node[], e?: Entry, dest?: string, vis: number }} Node
 */

/** an outline colour: RGB (gray as RGB) → " /C [r g b]" @param {any} c */
function colorOf(c) {
  if (c == null) return '';
  const d = device(c);
  if (!d || d.comps.length === 4) throw new TypeError('pdf.outline: color is RGB (\'#rrggbb\', [r, g, b]) or a gray level');
  const v = d.comps.length === 1 ? [d.comps[0], d.comps[0], d.comps[0]] : d.comps;
  return ` /C [${v.map((x) => String(Math.round(x * 1000) / 1000)).join(' ')}]`;
}

/** @param {import('../document.js').Doc} doc */
export function createOutline(doc) {
  /** @type {Entry[]} */
  const entries = [];
  doc.onFinish(async () => {
    /** @type {Node} */
    const root = { ref: 0, level: -1, kids: [], vis: 0 };
    /** @type {Node[]} in order (each after its parent) */
    const all = [];
    const stack = [root];
    for (const e of entries) {
      let dest;
      if (e.named) dest = e.named;
      else {
        dest = destArray(doc, e.i, /** @type {any} */ (e.d));
        if (!dest) { doc.warn(`The outline entry "${e.title.slice(0, 80)}" points to page ${e.i + 1}, but the PDF has ${doc.pageCount} pages`); continue; }
      }
      while (stack[stack.length - 1].level >= e.level) stack.pop();
      /** @type {Node} */
      const node = { ref: doc.reserve(), level: e.level, kids: [], e, dest, vis: 0 };
      stack[stack.length - 1].kids.push(node);
      stack.push(node);
      all.push(node);
    }
    if (!root.kids.length) return;
    root.ref = doc.reserve();
    // visible descendants: an open entry's kids show, and theirs if they are open (summed bottom-up)
    for (let k = all.length - 1; k >= -1; k--) {
      const n = k < 0 ? root : all[k];
      for (const c of n.kids) n.vis += 1 + (c.e?.open ? c.vis : 0);
    }
    /** @param {Node} n */
    const children = (n) => (n.kids.length ? ` /First ${n.kids[0].ref} 0 R /Last ${n.kids[n.kids.length - 1].ref} 0 R /Count ${n === root || n.e?.open ? n.vis : -n.vis}` : '');
    for (const n of [root, ...all]) {
      for (let i = 0; i < n.kids.length; i++) {
        const c = n.kids[i], e = /** @type {Entry} */ (c.e);
        await doc.write(c.ref, `<< /Title ${text(e.title)} /Parent ${n.ref} 0 R /Dest ${c.dest}${i ? ` /Prev ${n.kids[i - 1].ref} 0 R` : ''}${i < n.kids.length - 1 ? ` /Next ${n.kids[i + 1].ref} 0 R` : ''}${children(c)}${e.C}${e.F ? ` /F ${e.F}` : ''} >>`);
      }
    }
    await doc.write(root.ref, `<< /Type /Outlines${children(root)} >>`);
    doc.catalog('Outlines', `${root.ref} 0 R`);
    doc.catalog('PageMode', '/UseOutlines');
  });
  /** @param {OutlineEntry | OutlineEntry[]} e */
  return (e) => {
    const list = Array.isArray(e) ? e : [e];
    if (entries.length + list.length > MAX_ENTRIES) throw new RangeError(`pdf.outline: at most ${MAX_ENTRIES} entries`);
    /** @type {Entry[]} */
    const add = [];
    for (const x of list) { // all checked before any is kept
      if (!x || typeof x.title !== 'string' || (x.page == null && x.dest == null)) throw new TypeError('pdf.outline: an entry is { title, page, top?, level? } or { title, dest: name }');
      if (x.title.length > MAX_TITLE) throw new RangeError(`pdf.outline: a title is at most ${MAX_TITLE} characters`);
      const level = x.level ?? 0;
      if (!(Number.isInteger(level) && level >= 0 && level <= MAX_LEVEL)) throw new RangeError(`pdf.outline: level is a whole number 0–${MAX_LEVEL}, not ${level}`);
      const named = x.dest != null ? namedDests(doc).use(x.dest, 'pdf.outline') : null;
      add.push({
        title: x.title, level, named, open: x.open !== false, C: colorOf(x.color), F: (x.italic ? 1 : 0) | (x.bold ? 2 : 0),
        i: named ? -1 : pageIndex(doc, x.page, 'pdf.outline'), d: named ? null : fitOf(x, 'pdf.outline'),
      });
    }
    for (const a of add) entries.push(a); // copies: later changes to the caller's objects are not written
  };
}
