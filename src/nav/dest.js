// @ts-check
/**
 * Destinations: a page and how the viewer fits it (XYZ with a zoom, Fit, FitH, FitV, FitR, FitB, FitBH, FitBV), in
 * the library's top-left space; and named destinations (pdf.destination(name, page, fit)), written at the end to the
 * catalog's Names tree as a balanced name tree, which links, outline entries and the open action may name.
 *
 * Bounds: at most MAX_NAMES names of at most MAX_NAME_BYTES UTF-8 bytes; a name defined twice throws. Names are
 * written as hex strings of their UTF-8 bytes (and compared and sorted as those bytes, as readers do).
 */
import { num } from '../core/serialize.js';
import { unbrand } from '../core/brand.js';
import { writeTree, setNames } from './trees.js';

export const FITS = ['XYZ', 'Fit', 'FitH', 'FitV', 'FitR', 'FitB', 'FitBH', 'FitBV'];
export const MAX_NAMES = 100_000, MAX_NAME_BYTES = 1024;

/**
 * @typedef {{ fit: string, left: number | null, top: number | null, right: number | null, bottom: number | null, zoom: number | null }} Fit
 */

/** a page (1-based number or a page handle) as its 0-based index @param {any} doc @param {any} page @param {string} who */
export function pageIndex(doc, page, who) {
  if (typeof page === 'number') {
    if (!(Number.isInteger(page) && page >= 1)) throw new RangeError(`${who}: page is a whole number from 1`);
    return page - 1;
  }
  return unbrand(page, 'page', doc, 'page'); // a forged page object is refused
}

/**
 * How to fit the page, from { fit, left, top, right, bottom, zoom } or a fit name. Without fit: XYZ when left, top or
 * zoom is given, else Fit. Coordinates are top-left (y down); zoom is a factor (1 = 100%). @param {any} o @param {string} who @returns {Fit}
 */
export function fitOf(o, who) {
  if (typeof o === 'string') o = { fit: o };
  const f = o?.fit ?? (o?.left != null || o?.top != null || o?.zoom != null ? 'XYZ' : 'Fit');
  if (!FITS.includes(f)) throw new TypeError(`${who}: fit is one of ${FITS.join(', ')}, not ${JSON.stringify(f)}`);
  const n = (/** @type {string} */ k) => { const v = o?.[k]; if (v == null) return null; num(v); return /** @type {number} */ (v); };
  const d = { fit: f, left: n('left'), top: n('top'), right: n('right'), bottom: n('bottom'), zoom: n('zoom') };
  if (d.zoom != null && !(d.zoom >= 0 && d.zoom <= 64)) throw new RangeError(`${who}: zoom is a factor 0–64 (1 = 100%, 0 = keep), not ${d.zoom}`);
  if (f === 'FitR' && !(d.left != null && d.top != null && d.right != null && d.bottom != null && d.right > d.left && d.bottom > d.top)) throw new RangeError(`${who}: FitR needs left < right and top < bottom (top-left space)`);
  return d;
}

/** the destination array for page i, or null when the PDF has no page i @param {any} doc @param {number} i @param {Fit} d @returns {string | null} */
export function destArray(doc, i, d) {
  const h = doc.pageHeight(i);
  if (h === undefined) return null;
  const x = (/** @type {number | null} */ v) => (v == null ? 'null' : num(v)), y = (/** @type {number | null} */ v) => (v == null ? 'null' : num(h - v));
  const r = `${doc.pageRef(i)} 0 R /${d.fit}`;
  switch (d.fit) {
    case 'XYZ': return `[${r} ${x(d.left)} ${y(d.top)} ${d.zoom ? num(d.zoom) : 'null'}]`;
    case 'FitH': case 'FitBH': return `[${r} ${y(d.top)}]`;
    case 'FitV': case 'FitBV': return `[${r} ${x(d.left)}]`;
    case 'FitR': return `[${r} ${x(d.left)} ${y(d.bottom)} ${x(d.right)} ${y(d.top)}]`;
    default: return `[${r}]`;
  }
}

const UTF8 = new TextEncoder();
/** a name's key: its UTF-8 bytes as a latin1 string (sorts as the bytes) @param {any} name @param {string} who */
function keyOf(name, who) {
  if (typeof name !== 'string' || !name) throw new TypeError(`${who}: a destination name is a non-empty string`);
  if (name.length > MAX_NAME_BYTES) throw new RangeError(`${who}: a destination name is at most ${MAX_NAME_BYTES} bytes (UTF-8)`);
  const b = UTF8.encode(name);
  if (b.length > MAX_NAME_BYTES) throw new RangeError(`${who}: a destination name is at most ${MAX_NAME_BYTES} bytes (UTF-8)`);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return s;
}
/** @param {string} key */
const hexOf = (key) => { let h = '<'; for (let i = 0; i < key.length; i++) h += key.charCodeAt(i).toString(16).padStart(2, '0'); return `${h}>`; };

/** @type {WeakMap<object, ReturnType<typeof create>>} */
const registries = new WeakMap();
/** the document's named destinations (made, with its finisher, on first use) @param {any} doc */
export function namedDests(doc) {
  let r = registries.get(doc);
  if (!r) registries.set(doc, r = create(doc));
  return r;
}

/** @param {any} doc */
function create(doc) {
  /** @type {Map<string, { name: string, i: number, d: Fit }>} */
  const defs = new Map();
  /** @type {Map<string, string>} names used by links and outlines, to warn about the undefined ones */
  const used = new Map();
  doc.onFinish(async () => {
    for (const [k, n] of used) if (!defs.has(k)) doc.warn(`"${n}" is used as a destination but was never defined (pdf.destination)`);
    /** @type {[string, string][]} */
    const entries = [];
    for (const k of [...defs.keys()].sort()) {
      const v = /** @type {any} */ (defs.get(k)), a = destArray(doc, v.i, v.d);
      if (a) entries.push([hexOf(k), a]);
      else doc.warn(`The destination "${v.name}" points to page ${v.i + 1}, but the PDF has ${doc.pageCount} pages`);
    }
    if (entries.length) setNames(doc, 'Dests', await writeTree(doc, 'Names', entries));
  });
  return {
    /** @param {any} name @param {any} page @param {any} fit */
    define(name, page, fit) {
      const who = 'pdf.destination', k = keyOf(name, who);
      if (defs.has(k)) throw new TypeError(`${who}: "${name}" is already defined (names are unique)`);
      if (defs.size >= MAX_NAMES) throw new RangeError(`${who}: at most ${MAX_NAMES} named destinations`);
      defs.set(k, { name, i: pageIndex(doc, page, who), d: fitOf(fit, who) });
    },
    /** the name as a destination (a hex string) @param {any} name @param {string} who */
    use(name, who) {
      const k = keyOf(name, who);
      if (used.size < MAX_NAMES) used.set(k, name);
      return hexOf(k);
    },
  };
}
