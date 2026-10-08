// @ts-check
/**
 * What every annotation shares: its rectangle (top-left space, as everywhere), flags, colour (/C), contents (/Contents,
 * also the alternate text in tagged PDFs), author (/T), modified date (/M); its appearance stream (/AP /N: a form
 * XObject drawn with the page's own drawing methods on a stand-in page the size of the rectangle, written with the
 * page, so it renders the same in every viewer and passes PDF/A); its structure element when tagged (an Annot with an
 * OBJR, tags.js); and its handle (branded: a reply's /IRT takes one).
 *
 * Every entry is built from checked parts: numbers through num(), text through the hex string writers, names from
 * fixed lists or pdfName. PDF/A: printed, never hidden (/F has Print, not Hidden/NoView); every annotation has /AP.
 */
import { num, text, pdfDate, latin1 } from '../core/serialize.js';
import { brand } from '../core/brand.js';
import { Content } from '../content/content.js';
import { colorArray } from '../nav/links.js';

export const FLAGS = { invisible: 1, hidden: 2, print: 4, noZoom: 8, noRotate: 16, noView: 32, readOnly: 64, locked: 128, toggleNoView: 256, lockedContents: 512 };
export const MAX_CONTENTS = 1_000_000;

/**
 * @typedef {{ color?: any, contents?: string, author?: string, modified?: Date, flags?: Partial<Record<keyof typeof FLAGS, boolean>> }} AnnotOptions
 */

/** a Date, checked @param {any} d @param {string} who */
export function dateOf(d, who) {
  if (!(d instanceof Date) || isNaN(+d)) throw new TypeError(`${who}: a date is a valid Date`);
  return pdfDate(d);
}

/**
 * The shared entries (" /F 4 /C [...] /Contents <…> /T <…> /M <…>"), checked. @param {any} doc @param {AnnotOptions} o
 * @param {string} who @param {{ flags?: number, color?: any, contents?: string }} [dflt]
 */
export function shared(doc, o, who, dflt = {}) {
  let F = dflt.flags ?? FLAGS.print;
  if (o.flags != null) {
    if (typeof o.flags !== 'object') throw new TypeError(`${who}: flags is { print, hidden, noView, locked, … }`);
    for (const [k, v] of Object.entries(o.flags)) {
      if (!Object.hasOwn(FLAGS, k)) throw new TypeError(`${who}: unknown flag ${JSON.stringify(k)} (${Object.keys(FLAGS).join(', ')})`);
      const bit = /** @type {any} */ (FLAGS)[k];
      F = v ? F | bit : F & ~bit;
    }
  }
  if (doc.pdfa && (!(F & FLAGS.print) || F & (FLAGS.invisible | FLAGS.hidden | FLAGS.noView | FLAGS.toggleNoView))) throw new TypeError(`${who}: PDF/A annotations are printed and visible (print on; hidden, invisible, noView and toggleNoView off)`);
  const contents = o.contents ?? dflt.contents;
  if (contents != null && (typeof contents !== 'string' || contents.length > MAX_CONTENTS)) throw new TypeError(`${who}: contents is a string of at most ${MAX_CONTENTS} characters`);
  if (doc.tagged && !contents?.trim()) throw new TypeError(`${who}: a tagged PDF (PDF/UA) needs contents (the annotation's description) for every annotation`);
  if (o.author != null && (typeof o.author !== 'string' || o.author.length > 4096)) throw new TypeError(`${who}: author is a string of at most 4096 characters`);
  const color = o.color ?? dflt.color;
  return `/F ${F}${color != null ? ` /C ${colorArray(color, doc, who)}` : ''}${contents != null ? ` /Contents ${text(contents)}` : ''}${o.author != null ? ` /T ${text(o.author)}` : ''}${o.modified != null ? ` /M ${dateOf(o.modified, who)}` : ''}`;
}

/** @param {string} what */
const no = (what) => () => { throw new TypeError(`page.${what} cannot be used in an annotation's appearance`); };

/**
 * An appearance stream: draw(ap) draws on a stand-in page of w × h (its own top-left space, the page's drawing
 * methods: shapes, paths, text, images); written as a form XObject when the page is written. Synchronous.
 * @param {any} page @param {number} w @param {number} h @param {(ap: any) => any} draw @returns {number} its object number
 */
export function appearance(page, w, h, draw) {
  const doc = page.doc;
  const ap = Object.create(Object.getPrototypeOf(page));
  Object.assign(ap, {
    doc, index: page.index, number: page.number, width: w, height: h, ref: page.ref, content: new Content(), entries: new Map(),
    annots: [], writers: [], ended: false, cell: true,
    onWrite: (/** @type {any} */ fn) => page.onWrite(fn),
    tag: (/** @type {any} */ _t, /** @type {() => any} */ fn) => fn(), figure: (/** @type {any} */ _o, /** @type {() => any} */ fn) => fn(),
    link: no('link'), annotate: no('annotate'), end: no('end'),
  });
  const r = draw(ap);
  if (r && typeof r.then === 'function') throw new TypeError('An appearance is drawn synchronously (no async function)');
  const ops = ap.content.end();
  const group = ap.entries.get('Group');
  const n = doc.reserve();
  const dict = `<< /Type /XObject /Subtype /Form /BBox [0 0 ${num(w)} ${num(h)}] /Resources ${doc.resourcesRef} 0 R${group ? ` /Group ${group}` : ''} >>`;
  page.onWrite(() => doc.writeStream(n, dict, latin1(ops)));
  return n;
}

/**
 * Add an annotation: subtype, its box (top-left x, y, w, h), its own entries, the shared ones, its appearance; tagged:
 * an Annot (or Link) element. Returns its handle. @param {any} page @param {string} subtype @param {number[]} box
 * @param {string} own entries, each from checked parts @param {string} common shared(…)'s entries
 * @param {((ap: any) => any) | null} draw
 */
export function addAnnot(page, subtype, box, own, common, draw) {
  const doc = page.doc, H = page.height, [x, y, w, h] = box;
  for (const v of box) num(v);
  if (!(w > 0 && h > 0)) throw new RangeError(`page: an annotation's width and height are above 0`);
  const rect = `[${num(x)} ${num(H - y - h)} ${num(x + w)} ${num(H - y)}]`;
  const ap = draw ? appearance(page, w, h, draw) : 0;
  let key = -1;
  const ref = page.annotate(() => `<< /Type /Annot /Subtype /${subtype} /Rect ${rect} /P ${page.ref} 0 R ${common}${own}${ap ? ` /AP << /N ${ap} 0 R >>` : ''}${key >= 0 ? ` /StructParent ${key}` : ''} >>`);
  if (doc.tags) key = doc.tags.link(page, ref, 'Annot');
  return brand(Object.freeze({ type: 'annotation', subtype }), 'annotation', doc, { ref });
}
