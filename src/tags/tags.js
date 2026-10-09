// @ts-check
/**
 * The structure tree of a tagged PDF (PDF/UA-1), written as the pages are (as ReportWright's pdfstreamtags.js): each
 * page's elements and its parent-tree array go out when the page is written; what stays is one number per top-level
 * element (the Document's kids) and two per page and link (the parent tree), written at the end.
 *
 * page.tag(type, fn): what fn draws belongs to a new element of that type, a child of the enclosing tag (else of the
 * Document). Content drawn outside any tag is an artifact. Marked-content sequences open lazily (content.js draw()),
 * so a container that draws nothing itself (Table, TR) has element kids only.
 *
 * Depth (group G): table and list structure is checked as it is built (TR in Table/THead/TBody/TFoot, TH/TD in TR,
 * LI in L, Lbl/LBody in LI…); headings H1–H6 start at H1 and never skip a level going down, and H and Hn are not mixed
 * (ISO 14289-1 7.4.2, 7.4.4); options write /Alt, /ActualText, /E (an abbreviation's expansion), /Lang, /ID (in the
 * IDTree) and the Table (/Scope, /Headers, /RowSpan, /ColSpan) and List (/ListNumbering) attributes. page.artifact(o, fn)
 * marks what fn draws as a typed artifact (/Artifact << /Type /Pagination /Subtype /Header >> BDC).
 */
import { ascii, pdfName, text, num as pdfNum } from '../core/serialize.js';
import { writeTree } from '../nav/trees.js';
import { unbrand } from '../core/brand.js';

export const STRUCTURE_TYPES = new Set(['Document', 'Part', 'Art', 'Sect', 'Div', 'BlockQuote', 'Caption', 'TOC', 'TOCI', 'Index', 'NonStruct', 'Private',
  'P', 'H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'L', 'LI', 'Lbl', 'LBody', 'Table', 'TR', 'TH', 'TD', 'THead', 'TBody', 'TFoot',
  'Span', 'Quote', 'Note', 'Reference', 'BibEntry', 'Code', 'Link', 'Annot', 'Ruby', 'RB', 'RT', 'RP', 'Warichu', 'WT', 'WP', 'Figure', 'Formula', 'Form']);
const ART = 'artifact';
/** the parents a structure type may have (ISO 32000-1 14.8.4; PDF/UA) */
const PARENTS = /** @type {Record<string, string[]>} */ ({
  TR: ['Table', 'THead', 'TBody', 'TFoot'], TH: ['TR'], TD: ['TR'], THead: ['Table'], TBody: ['Table'], TFoot: ['Table'],
  LI: ['L'], Lbl: ['LI'], LBody: ['LI'], TOCI: ['TOC'], RB: ['Ruby'], RT: ['Ruby'], RP: ['Ruby', 'Warichu'], WT: ['Warichu'], WP: ['Warichu'],
});
const NUMBERING = ['None', 'Disc', 'Circle', 'Square', 'Decimal', 'UpperRoman', 'LowerRoman', 'UpperAlpha', 'LowerAlpha'];
const ARTIFACT_TYPES = ['Pagination', 'Layout', 'Page'], ARTIFACT_SUBTYPES = ['Header', 'Footer', 'Watermark'];
const MAX_TEXT = 65536, MAX_IDS = 100_000;
/** a TagOptions text (alt, actualText, expansion) @param {any} v @param {string} k */
const str = (v, k) => { if (typeof v !== 'string' || v.length > MAX_TEXT) throw new TypeError(`page.tag: ${k} is a string of at most ${MAX_TEXT} characters`); return v; };
/** an element ID @param {any} v */
const idOf = (v) => { if (typeof v !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(v)) throw new TypeError(`page.tag: an id is 1–64 letters, digits, _ . : or -, not ${JSON.stringify(v)}`); return v; };

/**
 * @typedef {{ ref: number, S: string, parent: number, kids: (number | El | { objr: number })[], o?: TagOptions }} El
 * @typedef {{ alt?: string, lang?: string, scope?: 'Row' | 'Column' | 'Both', actualText?: string, expansion?: string, id?: string,
 *   headers?: string[], rowSpan?: number, colSpan?: number, listNumbering?: string }} TagOptions
 * @param {import('../document.js').Doc} doc @param {{ lang?: string }} opt
 */
export function createTagger(doc, opt) {
  const rootRef = doc.reserve(), docRef = doc.reserve();
  /** @type {number[]} */
  const docKids = [];
  let nums = new Int32Array(1024), nn = 0, key = 0;
  const num = (/** @type {number} */ k, /** @type {number} */ ref) => { if (nn + 2 > nums.length) { const b = new Int32Array(nums.length * 2); b.set(nums); nums = b; } nums[nn++] = k; nums[nn++] = ref; };
  /** @type {WeakMap<any, { stack: El[], mcids: number[], els: El[], links: boolean }>} */
  const state = new WeakMap();
  /** @type {Map<string, number>} element IDs → their elements (the IDTree) */
  const ids = new Map();
  /** @type {Set<string>} IDs named by /Headers, checked at the end */
  const named = new Set();
  let heading = 0, usesH = false;

  doc.onFinish(async () => {
    await doc.write(docRef, `<< /Type /StructElem /S /Document /P ${rootRef} 0 R /K [${docKids.map((k) => `${k} 0 R`).join(' ')}] >>`);
    const pt = doc.reserve();
    await doc.writeBig(pt, '<< /Nums [', pairs(nums, nn), '] >>');
    for (const h of named) if (!ids.has(h)) throw new TypeError(`page.tag: headers names ${JSON.stringify(h)}, which no element has as its id`);
    const idTree = ids.size ? ` /IDTree ${await writeTree(doc, 'Names', [...ids].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, r]) => [ascii(k), `${r} 0 R`]))} 0 R` : '';
    await doc.write(rootRef, `<< /Type /StructTreeRoot /K ${docRef} 0 R /ParentTree ${pt} 0 R /ParentTreeNextKey ${key}${idTree} >>`);
    doc.catalog('StructTreeRoot', `${rootRef} 0 R`);
    doc.catalog('MarkInfo', '<< /Marked true >>');
    doc.catalog('Lang', ascii(String(opt.lang || 'en').replace(/[^A-Za-z0-9-]/g, '') || 'en'));
    doc.catalog('ViewerPreferences', '<< /DisplayDocTitle true >>');
  });

  return {
    /** a new page: its marker and its elements, written with the page @param {import('../page.js').Page} page */
    attach(page) {
      /** @type {{ stack: El[], mcids: number[], els: El[], links: boolean }} */
      const s = { stack: [], mcids: [], els: [], links: false };
      state.set(page, s);
      page.content.marker = {
        current: () => s.stack[s.stack.length - 1] || ART,
        open(/** @type {any} */ owner) {
          if (owner === ART) return '/Artifact BMC\n';
          if (owner.art) return `/Artifact ${owner.art} BDC\n`; // a typed artifact (page.artifact)
          const m = s.mcids.length;
          s.mcids.push(owner.ref); owner.kids.push(m);
          return `${pdfName(owner.S)} <</MCID ${m}>> BDC\n`;
        },
      };
      page.onWrite(async () => {
        for (const e of s.els) {
          const K = e.kids.map((k) => (typeof k === 'number' ? k : 'objr' in k ? `<< /Type /OBJR /Obj ${k.objr} 0 R >>` : `${k.ref} 0 R`)).join(' ');
          const o = e.o || {};
          const table = `${o.scope ? ` /Scope ${pdfName(o.scope)}` : ''}${o.headers ? ` /Headers [${o.headers.map(ascii).join(' ')}]` : ''}${o.rowSpan ? ` /RowSpan ${o.rowSpan}` : ''}${o.colSpan ? ` /ColSpan ${o.colSpan}` : ''}`;
          const A = `${o.alt != null ? ` /Alt ${text(o.alt)}` : ''}${o.actualText != null ? ` /ActualText ${text(o.actualText)}` : ''}${o.expansion != null ? ` /E ${text(o.expansion)}` : ''}${o.lang ? ` /Lang ${ascii(o.lang)}` : ''}${o.id ? ` /ID ${ascii(o.id)}` : ''}${table ? ` /A << /O /Table${table} >>` : ''}${o.listNumbering ? ` /A << /O /List /ListNumbering ${pdfName(o.listNumbering)} >>` : ''}`;
          await doc.write(e.ref, `<< /S ${pdfName(e.S)} /P ${e.parent} 0 R /Pg ${doc.pageRef(unbrand(page, 'page', doc, 'page'))} 0 R /K [${K}]${A} >>`);
        }
        if (s.mcids.length) {
          const arr = doc.reserve();
          await doc.write(arr, `[${s.mcids.map((r) => `${r} 0 R`).join(' ')}]`);
          num(key, arr);
          page.entries.set('StructParents', String(key++));
        }
        if (s.links) page.entries.set('Tabs', '/S');
        state.delete(page);
      });
    },
    /**
     * @template T @param {import('../page.js').Page} page @param {string} type @param {() => T} fn @param {TagOptions} [o] @returns {T}
     */
    tag(page, type, fn, o) {
      if (!STRUCTURE_TYPES.has(type)) throw new TypeError(`page.tag: "${type}" is not a standard structure type (P, H1…H6, Table, TR, TH, TD, L, LI, Link, Figure…)`);
      if (o?.scope && !['Row', 'Column', 'Both'].includes(o.scope)) throw new TypeError('page.tag: scope is Row, Column or Both');
      const s = /** @type {any} */ (state.get(page));
      const parent = s.stack[s.stack.length - 1];
      if (parent?.art) throw new TypeError(`page.tag: ${type} inside page.artifact: an artifact is not content and holds no structure`);
      o = checkOptions(type, o);
      const want = PARENTS[type];
      if (want && !want.includes(parent?.S)) throw new TypeError(`page.tag: ${type} belongs inside ${want.join(', ')}, not ${parent ? parent.S : 'the Document'}`);
      if (/^H[1-6]?$/.test(type)) { // ISO 14289-1 7.4.2 and 7.4.4, in the order headings are tagged
        const n = Number(type[1] ?? 0);
        if ((n && usesH) || (!n && heading)) throw new TypeError('page.tag: a document uses H or H1–H6 for its headings, not both (PDF/UA 7.4.4)');
        if (n && n > heading + 1) throw new TypeError(heading ? `page.tag: ${type} after H${heading} skips a level (PDF/UA 7.4.2: headings go down one level at a time)` : `page.tag: the first heading is H1, not ${type} (PDF/UA 7.4.2)`);
        if (n) heading = n; else usesH = true;
      }
      /** @type {El} */
      const e = { ref: doc.reserve(), S: type, parent: parent ? parent.ref : docRef, kids: [], o };
      if (o?.id) {
        if (ids.has(o.id)) throw new TypeError(`page.tag: the id ${JSON.stringify(o.id)} is already used`);
        if (ids.size >= MAX_IDS) throw new RangeError(`page.tag: at most ${MAX_IDS} ids`);
        ids.set(o.id, e.ref);
      }
      if (o?.headers) for (const h of o.headers) if (named.size < MAX_IDS) named.add(h);
      if (parent) parent.kids.push(e); else docKids.push(e.ref);
      s.els.push(e);
      s.stack.push(e);
      try {
        const r = fn();
        if (r && typeof (/** @type {any} */ (r)).then === 'function') throw new TypeError('page.tag: fn must draw synchronously (no async function)');
        return r;
      } finally { s.stack.pop(); }
    },
    /**
     * an annotation's element: a Link's Link (the enclosing Link tag, else a new one), any other's Annot (likewise),
     * with an OBJR to it @param {import('../page.js').Page} page @param {number} annot @param {'Link' | 'Annot'} [S] @returns {number} its StructParent
     */
    link(page, annot, S = 'Link') {
      const s = /** @type {any} */ (state.get(page));
      let e = s.stack[s.stack.length - 1];
      if (e?.art) throw new TypeError('An annotation inside page.artifact: annotations are content in a tagged PDF; draw it outside the artifact');
      if (!e || e.S !== S) {
        const parent = e;
        e = { ref: doc.reserve(), S, parent: parent ? parent.ref : docRef, kids: [] };
        if (parent) parent.kids.push(e); else docKids.push(e.ref);
        s.els.push(e);
      }
      e.kids.push({ objr: annot });
      s.links = true;
      num(key, e.ref);
      return key++;
    },
    /**
     * What fn draws is an artifact of this type (Pagination with Header, Footer or Watermark; Layout; Page), written as
     * /Artifact << /Type … /Subtype … >> BDC. Names come from fixed lists, never from the caller's strings.
     * @template T @param {import('../page.js').Page} page @param {{ type?: string, subtype?: string }} o @param {() => T} fn @returns {T}
     */
    artifact(page, o, fn) {
      const type = o?.type ?? 'Pagination', sub = o?.subtype;
      if (!ARTIFACT_TYPES.includes(type)) throw new TypeError(`page.artifact: type is ${ARTIFACT_TYPES.join(', ')}`);
      if (sub != null && (type !== 'Pagination' || !ARTIFACT_SUBTYPES.includes(sub))) throw new TypeError(`page.artifact: subtype (${ARTIFACT_SUBTYPES.join(', ')}) is for type Pagination`);
      const s = /** @type {any} */ (state.get(page));
      if (s.stack.length) throw new TypeError('page.artifact: inside page.tag: an artifact is not part of the structure; draw it outside any tag');
      s.stack.push({ art: `<< /Type /${type}${sub ? ` /Subtype /${sub}` : ''} >>` });
      try {
        const r = fn();
        if (r && typeof (/** @type {any} */ (r)).then === 'function') throw new TypeError('page.artifact: fn must draw synchronously (no async function)');
        return r;
      } finally { s.stack.pop(); }
    },
  };
}

/** the options of a tag, checked for its type @param {string} type @param {TagOptions | undefined} o @returns {TagOptions | undefined} */
function checkOptions(type, o) {
  if (o == null) return o;
  if (typeof o !== 'object') throw new TypeError('page.tag: options are an object');
  for (const k of ['alt', 'actualText', 'expansion']) if (/** @type {any} */ (o)[k] != null) str(/** @type {any} */ (o)[k], k);
  if (o.lang != null && (typeof o.lang !== 'string' || !/^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8}){0,8}$/.test(o.lang))) throw new TypeError(`page.tag: lang is a language tag like "en" or "fr-CA", not ${JSON.stringify(o.lang)}`);
  if (o.id != null) idOf(o.id);
  if (o.scope != null && type !== 'TH') throw new TypeError('page.tag: scope is for TH');
  if (o.headers != null) {
    if (type !== 'TH' && type !== 'TD') throw new TypeError('page.tag: headers is for TD and TH');
    if (!Array.isArray(o.headers) || !o.headers.length || o.headers.length > 64) throw new TypeError('page.tag: headers is an array of 1–64 TH ids');
    o.headers.forEach(idOf);
  }
  for (const k of /** @type {const} */ (['rowSpan', 'colSpan'])) {
    if (o[k] == null) continue;
    if (type !== 'TH' && type !== 'TD') throw new TypeError(`page.tag: ${k} is for TD and TH`);
    if (!Number.isInteger(o[k]) || /** @type {number} */ (o[k]) < 1 || /** @type {number} */ (o[k]) > 10000) throw new RangeError(`page.tag: ${k} is a whole number 1–10000`);
    pdfNum(/** @type {number} */ (o[k]));
  }
  if (o.listNumbering != null && (type !== 'L' || !NUMBERING.includes(o.listNumbering))) throw new TypeError(`page.tag: listNumbering is for L, one of ${NUMBERING.join(', ')}`);
  return { ...o, headers: o.headers ? [...o.headers] : undefined };
}

/** the parent tree's key, value pairs, a few thousand at a time @param {Int32Array} a @param {number} n */
function* pairs(a, n) { for (let i = 0; i < n; i += 4096) { let s = ''; for (let j = i; j < Math.min(n, i + 4096); j += 2) s += `${a[j]} ${a[j + 1]} 0 R `; yield s; } }

/**
 * page.artifact(o, fn): what fn draws is a typed artifact (tagged PDFs; otherwise fn just runs).
 * @this {any} @template T @param {{ type?: string, subtype?: string }} o @param {() => T} fn @returns {T}
 */
export function artifact(o, fn) {
  if (typeof fn !== 'function') throw new TypeError('page.artifact: fn is a function that draws');
  return this.doc.tags ? this.doc.tags.artifact(this, o, fn) : fn();
}
