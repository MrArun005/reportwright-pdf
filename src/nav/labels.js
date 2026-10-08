// @ts-check
/**
 * pdf.pageLabels(ranges): the labels viewers show for pages (i, ii, iii, then 1, 2, 3; "A-1"…), written at the end to
 * the catalog's /PageLabels number tree. Each range starts at a 0-based page index with a style (D decimal, r/R
 * roman, a/A letters, or none: the prefix alone), a prefix and a first number. A tree needs page 0, so a decimal range
 * is added there when the caller's ranges start later. At most MAX_RANGES ranges; prefixes of MAX_PREFIX characters.
 */
import { num, text } from '../core/serialize.js';
import { writeTree } from './trees.js';

const STYLES = ['D', 'r', 'R', 'a', 'A'];
export const MAX_RANGES = 10_000, MAX_PREFIX = 1024;

/** @param {import('../document.js').Doc} doc */
export function createPageLabels(doc) {
  /** @type {[number, string][] | null} */
  let ranges = null;
  doc.onFinish(async () => {
    if (!ranges) return;
    const all = ranges[0][0] === 0 ? ranges : [/** @type {[number, string]} */ ([0, '<< /S /D >>']), ...ranges];
    doc.catalog('PageLabels', `${await writeTree(doc, 'Nums', all.map(([k, v]) => [String(k), v]))} 0 R`);
  });
  /** @param {{ start: number, style?: string | null, prefix?: string, first?: number }[]} list */
  return (list) => {
    const who = 'pdf.pageLabels';
    if (!Array.isArray(list) || !list.length || list.length > MAX_RANGES) throw new TypeError(`${who}: an array of 1–${MAX_RANGES} ranges { start, style, prefix, first }`);
    /** @type {[number, string][]} */
    const out = [];
    for (const r of list) {
      const start = r?.start;
      if (!(Number.isInteger(start) && start >= 0 && start < 1e8)) throw new RangeError(`${who}: start is a 0-based page index, not ${start}`);
      if (r.style != null && !STYLES.includes(r.style)) throw new TypeError(`${who}: style is one of ${STYLES.join(', ')} (or none), not ${JSON.stringify(r.style)}`);
      if (r.prefix != null && (typeof r.prefix !== 'string' || r.prefix.length > MAX_PREFIX)) throw new TypeError(`${who}: prefix is a string of at most ${MAX_PREFIX} characters`);
      if (r.first != null && !(Number.isInteger(r.first) && r.first >= 1 && r.first < 1e8)) throw new RangeError(`${who}: first is a whole number from 1, not ${r.first}`);
      out.push([start, `<< /Type /PageLabel${r.style ? ` /S /${r.style}` : ''}${r.prefix ? ` /P ${text(r.prefix)}` : ''}${r.first != null && r.first !== 1 ? ` /St ${num(r.first)}` : ''} >>`]);
    }
    out.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < out.length; i++) if (out[i][0] === out[i - 1][0]) throw new RangeError(`${who}: two ranges start at page index ${out[i][0]}`);
    ranges = out; // a later call replaces the labels
  };
}
