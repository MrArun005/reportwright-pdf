// @ts-check
/**
 * The outline (bookmarks), written at the end: entries nest by level (an entry is the child of the nearest one before
 * it at a lower level). From ReportWright's writeOutline (src/exporters/pdfstream.js).
 */
import { num, text } from '../core/serialize.js';

/** @typedef {{ title: string, page: number | import('../page.js').Page, top?: number, level?: number }} OutlineEntry */

/** @param {import('../document.js').Doc} doc */
export function createOutline(doc) {
  /** @type {OutlineEntry[]} */
  const entries = [];
  doc.onFinish(async () => {
    /** @typedef {{ ref: number, level: number, kids: any[], title?: string, dest?: string }} Node */
    /** @type {Node} */
    const root = { ref: 0, level: -1, kids: [] };
    const stack = [root];
    for (const e of entries) {
      const i = typeof e.page === 'number' ? e.page - 1 : e.page.index;
      const h = doc.pageHeight(i);
      if (h === undefined) { doc.warn(`The outline entry "${e.title}" points to page ${i + 1}, but the PDF has ${doc.pageCount} pages`); continue; }
      const level = Math.max(0, Math.min(9, Number(e.level) || 0));
      while (stack[stack.length - 1].level >= level) stack.pop();
      /** @type {Node} */
      const node = { ref: doc.reserve(), level, kids: [], title: e.title, dest: `[${doc.pageRef(i)} 0 R ${e.top == null ? '/Fit' : `/XYZ null ${num(h - e.top)} null`}]` };
      stack[stack.length - 1].kids.push(node);
      stack.push(node);
    }
    if (!root.kids.length) return;
    root.ref = doc.reserve();
    /** @param {Node} n @returns {number} */
    const count = (n) => n.kids.reduce((t, c) => t + 1 + count(c), 0);
    /** @param {Node} n */
    const children = (n) => (n.kids.length ? ` /First ${n.kids[0].ref} 0 R /Last ${n.kids[n.kids.length - 1].ref} 0 R /Count ${count(n)}` : '');
    /** @param {Node} n @returns {Promise<void>} */
    const write = async (n) => {
      for (let i = 0; i < n.kids.length; i++) {
        const c = n.kids[i];
        await doc.write(c.ref, `<< /Title ${text(c.title)} /Parent ${n.ref} 0 R /Dest ${c.dest}${i ? ` /Prev ${n.kids[i - 1].ref} 0 R` : ''}${i < n.kids.length - 1 ? ` /Next ${n.kids[i + 1].ref} 0 R` : ''}${children(c)} >>`);
        await write(c);
      }
    };
    await write(root);
    await doc.write(root.ref, `<< /Type /Outlines${children(root)} >>`);
    doc.catalog('Outlines', `${root.ref} 0 R`);
    doc.catalog('PageMode', '/UseOutlines');
  });
  /** @param {OutlineEntry | OutlineEntry[]} e */
  return (e) => {
    for (const x of Array.isArray(e) ? e : [e]) {
      if (!x || typeof x.title !== 'string' || x.page == null) throw new TypeError('pdf.outline: an entry is { title, page, top?, level? }');
      entries.push(x);
    }
  };
}
