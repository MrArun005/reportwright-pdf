// @ts-check
/**
 * The structure tree of a tagged PDF (PDF/UA-1), written as the pages are (as ReportWright's pdfstreamtags.js): each
 * page's elements and its parent-tree array go out when the page is written; what stays is one number per top-level
 * element (the Document's kids) and two per page and link (the parent tree), written at the end.
 *
 * page.tag(type, fn): what fn draws belongs to a new element of that type, a child of the enclosing tag (else of the
 * Document). Content drawn outside any tag is an artifact. Marked-content sequences open lazily (content.js draw()),
 * so a container that draws nothing itself (Table, TR) has element kids only.
 */
import { ascii, text } from '../core/serialize.js';

export const STRUCTURE_TYPES = new Set(['Document', 'Part', 'Art', 'Sect', 'Div', 'BlockQuote', 'Caption', 'TOC', 'TOCI', 'Index', 'NonStruct', 'Private',
  'P', 'H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'L', 'LI', 'Lbl', 'LBody', 'Table', 'TR', 'TH', 'TD', 'THead', 'TBody', 'TFoot',
  'Span', 'Quote', 'Note', 'Reference', 'BibEntry', 'Code', 'Link', 'Annot', 'Ruby', 'RB', 'RT', 'RP', 'Warichu', 'WT', 'WP', 'Figure', 'Formula', 'Form']);
const ART = 'artifact';

/**
 * @typedef {{ ref: number, S: string, parent: number, kids: (number | El | { objr: number })[], o?: TagOptions }} El
 * @typedef {{ alt?: string, lang?: string, scope?: 'Row' | 'Column' | 'Both' }} TagOptions
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

  doc.onFinish(async () => {
    await doc.write(docRef, `<< /Type /StructElem /S /Document /P ${rootRef} 0 R /K [${docKids.map((k) => `${k} 0 R`).join(' ')}] >>`);
    const pt = doc.reserve();
    await doc.writeBig(pt, '<< /Nums [', pairs(nums, nn), '] >>');
    await doc.write(rootRef, `<< /Type /StructTreeRoot /K ${docRef} 0 R /ParentTree ${pt} 0 R /ParentTreeNextKey ${key} >>`);
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
          const m = s.mcids.length;
          s.mcids.push(owner.ref); owner.kids.push(m);
          return `/${owner.S} <</MCID ${m}>> BDC\n`;
        },
      };
      page.onWrite(async () => {
        for (const e of s.els) {
          const K = e.kids.map((k) => (typeof k === 'number' ? k : 'objr' in k ? `<< /Type /OBJR /Obj ${k.objr} 0 R >>` : `${k.ref} 0 R`)).join(' ');
          const o = e.o || {};
          const A = `${o.alt != null ? ` /Alt ${text(o.alt)}` : ''}${o.lang ? ` /Lang ${ascii(o.lang)}` : ''}${o.scope ? ` /A << /O /Table /Scope /${o.scope} >>` : ''}`;
          await doc.write(e.ref, `<< /S /${e.S} /P ${e.parent} 0 R /Pg ${page.ref} 0 R /K [${K}]${A} >>`);
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
      /** @type {El} */
      const e = { ref: doc.reserve(), S: type, parent: parent ? parent.ref : docRef, kids: [], o };
      if (parent) parent.kids.push(e); else docKids.push(e.ref);
      s.els.push(e);
      s.stack.push(e);
      try {
        const r = fn();
        if (r && typeof (/** @type {any} */ (r)).then === 'function') throw new TypeError('page.tag: fn must draw synchronously (no async function)');
        return r;
      } finally { s.stack.pop(); }
    },
    /** a link annotation's Link element (the enclosing Link tag, else a new one) @param {import('../page.js').Page} page @param {number} annot @returns {number} its StructParent */
    link(page, annot) {
      const s = /** @type {any} */ (state.get(page));
      let e = s.stack[s.stack.length - 1];
      if (!e || e.S !== 'Link') {
        const parent = e;
        e = { ref: doc.reserve(), S: 'Link', parent: parent ? parent.ref : docRef, kids: [] };
        if (parent) parent.kids.push(e); else docKids.push(e.ref);
        s.els.push(e);
      }
      e.kids.push({ objr: annot });
      s.links = true;
      num(key, e.ref);
      return key++;
    },
  };
}

/** the parent tree's key, value pairs, a few thousand at a time @param {Int32Array} a @param {number} n */
function* pairs(a, n) { for (let i = 0; i < n; i += 4096) { let s = ''; for (let j = i; j < Math.min(n, i + 4096); j += 2) s += `${a[j]} ${a[j + 1]} 0 R `; yield s; } }
