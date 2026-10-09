// @ts-check
/**
 * Copying objects out of loaded documents into a new file (save: through the writer's doc.write) or into an
 * incremental section (saveIncremental). A copy is deep, iterative and post-order: an object is written after the
 * objects it refers to, so identical objects (a font, an image, an ICC profile embedded by two merged files, or twice
 * in one) are written ONCE (the same dictionary text and bytes → the same object). A reference back to an object
 * still being copied (a cycle: an annotation's /P, a structure element's /P) gets its number ahead of time and that
 * object is not de-duplicated.
 *
 * What is never copied: page tree nodes and the catalog (pages are remapped to the new file's pages; a page that is not
 * in the new file becomes null), cross-reference and object streams, and — unless keepActiveContent — anything outside
 * two ALLOWLISTS: actions (GoTo, URI with an http/https/mailto/ftp URL as nav/links.js checkUrl accepts it, Named page
 * moves, ResetForm), checked wherever an action can be (/A, /OpenAction, /Next and its arrays, /PA, any /Type /Action,
 * resolved through references); and annotation subtypes (KEEP_ANNOTS; a file attachment's name through checkFileName).
 * /AA and /JS are always dropped. Each removal is counted in the report. A signature's value
 * (/V of a signature field) is never copied by a rewrite: the new file's bytes are not the signed bytes.
 *
 * Nothing here recurses: values are serialised and their references collected on explicit stacks.
 */
import { Ref, PdfString, PdfStream } from './lexer.js';
import { flatTree } from './pdf.js';
import { judge, cleanAction, refuseAnnot, cleanFile, attributesOnly, STRUCT_TYPES, ACTION_KEYS, DANGEROUS_KEYS } from './policy.js';
import { deflate } from '../core/deflate.js';

export { refuseAction, refuseAnnot, refuseFile, isAnnot, KEEP_ACTIONS, KEEP_ANNOTS, ACTION_KEYS } from './policy.js';

/** dictionaries safe to share when equal (values, not identities) */
const SHARE = new Set(['Font', 'FontDescriptor', 'ExtGState', 'Encoding', 'Pattern', 'Shading', 'Halftone', 'Function', 'XObject', 'Mask', 'CMap', 'OutputIntent', 'Filespec', 'EmbeddedFile']);
const GRAY = -2;

/** a name with its slash, its bytes exactly (chars 0–255), delimiters and white space as #xx @param {string} s */
export function nameText(s) {
  let o = '/';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i) & 255;
    o += c < 0x21 || c > 0x7e || c === 0x23 || '()<>[]{}/%'.includes(s[i]) ? `#${c.toString(16).padStart(2, '0').toUpperCase()}` : s[i];
  }
  return o;
}
/** a number as PDF writes it (no exponent) @param {number} v */
export function numText(v) {
  if (!Number.isFinite(v)) return '0';
  if (Number.isInteger(v)) return String(v);
  const s = String(v);
  if (!/e/i.test(s)) return s;
  return Math.abs(v) < 1 ? v.toFixed(10).replace(/\.?0+$/, '') || '0' : v.toFixed(0);
}
const HEXD = '0123456789abcdef';
/** @param {Uint8Array} b */
export function hexText(b) {
  if (NodeBuffer && b.length > 64) return `<${NodeBuffer.from(b.buffer, b.byteOffset, b.length).toString('hex')}>`; // flat, not a rope of one node per byte
  /** @type {string[]} */ const parts = ['<'];
  for (let i = 0; i < b.length; i += 4096) { let s = ''; for (let k = i; k < Math.min(b.length, i + 4096); k++) s += HEXD[b[k] >> 4] + HEXD[b[k] & 15]; parts.push(s); }
  parts.push('>');
  return parts.join('');
}
const NodeBuffer = /** @type {any} */ (globalThis).Buffer;

class Raw { /** @param {string} s */ constructor(s) { this.s = s; } }
/** a reference into another loaded document (a widget's new appearance, made in a scratch file by the writer) */
export class Foreign {
  /** @param {any} owner @param {Ref} ref */
  constructor(owner, ref) { this.owner = owner; this.ref = ref; }
}
/** walk()'s refText for an audit: report what would be dropped, build no text */
const AUDIT = () => 'null';
const OPEN_A = new Raw('['), CLOSE_A = new Raw(']'), OPEN_D = new Raw('<<'), CLOSE_D = new Raw('>>');

/**
 * @typedef {{
 *   reserve(): number,
 *   write(n: number, dict: string, stream: Uint8Array | null, srcDict: Map<string, any> | null): Promise<void>,
 *   keepActive: boolean, compress: boolean, dedupe: boolean, keepSignatures?: boolean, resolveDests?: boolean,
 *   page(owner: any, n: number): number | null | undefined,
 *   keepStruct(owner: any): boolean,
 *   replace?(owner: any, n: number): any,
 *   report(what: string): void, reportRewrites?: boolean,
 * }} Target
 *   page: the new number of the source page object n (null: not copied; undefined: n is not a page);
 *   replace: a value to copy instead of object n (a widget with a new appearance), or undefined
 *   reportRewrites: report what would be rewritten (a URI normalised, a file name stripped) as well as what is dropped (the incremental check)
 */

/** @param {Target} t */
export function createCopier(t) {
  /** @type {Map<any, Map<number, number>>} owner → source number → new number (null: none; GRAY: being copied) */
  const maps = new Map();
  /** @type {Map<string, { n: number, dict: string, raw: () => Uint8Array | null }>} content hash → the object written (and how to get its source bytes again: by number, so the parsed object is not held) */
  const seen = new Map();
  /** @type {Map<any, Map<number, number>>} numbers reserved ahead (cycles) */
  const ahead = new Map();
  /** @type {WeakSet<object>} dictionaries already judged (a rewritten one is not judged again) */
  const judged = new WeakSet();
  const mapOf = (/** @type {any} */ owner) => { let m = maps.get(owner); if (!m) maps.set(owner, m = new Map()); return m; };
  const aheadOf = (/** @type {any} */ owner) => { let m = ahead.get(owner); if (!m) ahead.set(owner, m = new Map()); return m; };

  /** @type {Map<any, { objs: Set<object>, nums: Set<number>, types: Set<string> }>} per document: its structure tree, by position (held: the reader's cache keeps an object's identity only while something holds it) */
  const trees = new Map();
  /** while auditing an object the tree reaches by number (everyObject parses apart from the cache: no identity) */
  let auditing = false;
  /**
   * The structure elements of a document, by POSITION: the dictionaries (and the numbers of the objects) reached by
   * walking /StructTreeRoot /K and its /ParentTree, through structure elements only (/S a standard type or one the
   * /RoleMap maps; marked-content and object references are not followed: an /OBJR's /Obj is an annotation).
   * @param {any} owner
   */
  function treeOf(owner) {
    let t0 = trees.get(owner);
    if (t0) return t0;
    const src = owner.r.src, R = src.resolve;
    t0 = { objs: new Set(), nums: new Set(), types: new Set(STRUCT_TYPES) };
    trees.set(owner, t0);
    const root = R(owner.r.root.get('StructTreeRoot'));
    if (!(root instanceof Map)) return t0;
    const rm = R(root.get('RoleMap'));
    if (rm instanceof Map) for (const [k] of rm) t0.types.add(k);
    /** @type {any[]} */
    const stack = [root.get('K')];
    const pt = R(root.get('ParentTree'));
    if (pt instanceof Map) for (const v of flatTree(pt, src, 'Nums').values()) stack.push(v);
    let count = 0;
    while (stack.length && count < 1_000_000) {
      const x = stack.pop();
      src.budget.tick();
      if (x instanceof Ref) { if (t0.nums.has(x.n)) continue; }
      const v = R(x);
      if (Array.isArray(v)) { if (x instanceof Ref) t0.nums.add(x.n); src.budget.tick(v.length); for (const y of v) stack.push(y); continue; }
      if (!(v instanceof Map) || t0.objs.has(v)) continue;
      const ty = R(v.get('Type')), st = R(v.get('S'));
      if ((ty != null && ty !== 'StructElem') || typeof st !== 'string' || !t0.types.has(st)) continue;
      count++;
      t0.objs.add(v);
      if (x instanceof Ref) t0.nums.add(x.n);
      stack.push(v.get('K'));
    }
    return t0;
  }
  /** a structure element: reached by the tree walk (or, auditing an object the walk reached by number, shaped as one) @param {any} owner @param {Map<string, any>} d */
  function isStruct(owner, d) {
    const t0 = treeOf(owner);
    if (t0.objs.has(d)) return true;
    if (!auditing) return false;
    const R = owner.r.src.resolve, ty = R(d.get('Type')), st = R(d.get('S'));
    return (ty == null || ty === 'StructElem') && typeof st === 'string' && t0.types.has(st);
  }

  /**
   * The entries of a dictionary as copied: the ONE place every rule applies (every copied object's dictionaries,
   * direct or not, pass here). Action values (/A, /OpenAction, /Next, /PA) are resolved, arrays walked, and each
   * checked against the allowlist; /Annots entries are resolved and checked against the annotation allowlist; /AA
   * and /JS are always dropped. @param {any} owner @param {Map<string, any>} d
   */
  function entries(owner, d) {
    const R = owner.r.src.resolve;
    /** @type {[string, any][]} */
    const out = [];
    const goTo = R(d.get('S')) === 'GoTo';
    const field = d.has('FT') || d.has('T') || d.has('Parent');
    const struct = isStruct(owner, d); // its /A is attributes, not an action (by position: the structure tree)
    for (const [k, v0] of d) {
      let v = v0;
      if (!t.keepActive) {
        const bad = DANGEROUS_KEYS.get(k);
        if (bad) { t.report(bad); continue; }
        if (ACTION_KEYS.has(k) && (k !== 'Next' || d.has('S')) && !(k === 'A' && struct && attributesOnly(v, R))) { // an action's place: resolved, arrays walked
          const x = R(v);
          if (Array.isArray(x) && (k === 'Next' || k === 'A')) { // an /A array outside attributes: each element an action
            const keep = [];
            for (const y of x.slice(0, 1000)) { const r = cleanAction(R(y), R); if ('why' in r) t.report(r.why); else { if (t.reportRewrites && r.rewritten) t.report(r.rewritten); keep.push(y); } }
            if (!keep.length) continue;
            v = keep;
          } else { const r = cleanAction(x, R); if ('why' in r) { t.report(r.why); continue; } if (t.reportRewrites && r.rewritten) t.report(r.rewritten); }
        }
        if (k === 'Annots' || k === 'Fields' || (k === 'Kids' && field)) { // an annotation's place: every element checked, whatever its shape
          const x = R(v);
          if (Array.isArray(x)) owner.r.src.budget.tick(x.length); // one array shared by many dictionaries is checked once per dictionary
          if (Array.isArray(x)) v = x.filter((y) => {
            const a = R(y);
            if (!(a instanceof Map)) { if (k === 'Annots') { t.report('an annotation that is not a dictionary'); return false; } return true; }
            if (k !== 'Annots' && !a.has('Subtype') && !a.has('Rect')) return true; // a field, not a widget
            const why = refuseAnnot(a, R); if (why) t.report(why); return !why;
          });
        }
        if (k === 'FS') { const r = cleanFile(R(v), R); if ('why' in r) { t.report(r.why); continue; } if (t.reportRewrites && r.rewritten) t.report(r.rewritten); if (!(v instanceof Ref)) v = r.value; }
      }
      if (k === 'Dest' || (k === 'D' && goTo)) { if (t.resolveDests !== false) { v = owner.explicit(v); if (v == null) continue; } }
      if (k === 'V' && !t.keepSignatures) { const x = R(v); if (x instanceof Map && x.has('ByteRange')) { t.report('signature value (a rewrite invalidates it)'); continue; } }
      if ((k === 'StructParent' || k === 'StructParents') && !t.keepStruct(owner)) continue;
      out.push([k, v]);
    }
    return out;
  }

  /**
   * walk a value: each reference found (with its document), its text when refText is given @param {any} owner
   * @param {any} v @param {((o: any, r: Ref) => string) | null} refText @param {[any, number][] | null} found
   */
  function walk(owner, v, refText, found) {
    /** @type {string[]} */
    const out = [];
    const stack = [v];
    const budget = owner.r.src.budget;
    const text = refText !== null && refText !== AUDIT; // an audit only reports: no text is built
    while (stack.length) {
      const x = stack.pop();
      budget.tick();
      if (x instanceof Raw) { if (text) out.push(x.s); continue; }
      if (x instanceof Ref) { if (found) found.push([owner, x.n]); if (text) out.push(/** @type {any} */ (refText)(owner, x)); continue; }
      if (x instanceof Foreign) { if (found) found.push([x.owner, x.ref.n]); if (text) out.push(/** @type {any} */ (refText)(x.owner, x.ref)); continue; }
      if (Array.isArray(x)) {
        if (text) stack.push(CLOSE_A);
        for (let i = x.length - 1; i >= 0; i--) stack.push(x[i]);
        if (text) stack.push(OPEN_A);
        continue;
      }
      if (x instanceof Map) {
        if (!t.keepActive) { // every direct dictionary's own verdict (policy.js judge): dropped, or rewritten
          if (!judged.has(x)) {
            const r = judge(x, owner.r.src.resolve);
            if ('why' in r) { if (refText) { t.report(r.why); if (text) out.push('null'); } continue; }
            if (t.reportRewrites && r.rewritten) t.report(r.rewritten);
            judged.add(r.value);
            if (r.value !== x) { stack.push(r.value); continue; }
          }
        }
        const es = entries(owner, x);
        if (text) {
          stack.push(CLOSE_D);
          for (let i = es.length - 1; i >= 0; i--) { stack.push(es[i][1]); stack.push(new Raw(nameText(es[i][0]))); }
          stack.push(OPEN_D);
        } else for (let i = es.length - 1; i >= 0; i--) stack.push(es[i][1]);
        continue;
      }
      if (!text) continue;
      if (x instanceof PdfString) out.push(hexText(x.bytes));
      else if (typeof x === 'string') out.push(nameText(x));
      else if (typeof x === 'number') out.push(numText(x));
      else if (typeof x === 'boolean') out.push(String(x));
      else out.push('null'); // null, a stream inside a value (impossible in a valid file)
    }
    return out.join(' ');
  }

  /** what object n of owner becomes without copying it: a page's number, null; undefined → copy it @param {any} owner @param {number} n */
  function special(owner, n) {
    const p = t.page(owner, n);
    if (p !== undefined) return p;
    const v = owner.r.src.get(n);
    if (v == null) return null;
    const d = v instanceof PdfStream ? v.dict : v;
    if (d instanceof Map) {
      const ty = owner.r.src.resolve(d.get('Type')); // resolved: a /Type can be an indirect name
      if (ty === 'Pages' || ty === 'Catalog' || ty === 'XRef' || ty === 'ObjStm' || n === owner.r.src.encryptRef) return null;
      if (d.has('ByteRange') && (ty === 'Sig' || ty === 'DocTimeStamp' || d.has('Contents'))) return null;
    }
    return undefined;
  }

  /** the text of a reference once copied @param {any} owner @param {Ref} r */
  const refText0 = (owner, r) => {
    const v = mapOf(owner).get(r.n);
    if (v === GRAY) return `${/** @type {number} */ (aheadOf(owner).get(r.n))} 0 R`;
    return v == null ? 'null' : `${v} 0 R`;
  };

  /** copy every object these references reach (post-order, de-duplicated) @param {[any, number][]} roots */
  async function copyAll(roots) {
    /** @type {{ owner: any, n: number, v?: any, rep?: any, ready?: boolean }[]} */
    const stack = roots.map(([owner, n]) => ({ owner, n })).reverse();
    while (stack.length) {
      const f = stack[stack.length - 1], owner = f.owner, m = mapOf(owner), fwd = aheadOf(owner);
      if (!f.ready) {
        if (m.has(f.n)) { stack.pop(); continue; }
        const s = special(owner, f.n);
        if (s !== undefined) { m.set(f.n, s); stack.pop(); continue; }
        const rep = t.replace?.(owner, f.n);
        f.rep = rep;
        f.v = rep !== undefined ? rep : owner.r.src.get(f.n);
        if (!t.keepActive && f.v instanceof Map) { // an indirect dictionary's own verdict, as a direct one's (policy.js judge)
          const r = judge(f.v, owner.r.src.resolve);
          if ('why' in r) { t.report(r.why); m.set(f.n, null); stack.pop(); continue; }
          f.v = r.value;
          judged.add(f.v);
        }
        m.set(f.n, GRAY);
        f.ready = true;
        /** @type {[any, number][]} */
        const kids = [];
        walk(owner, f.v instanceof PdfStream ? streamDict(owner, f.v) : f.v, null, kids);
        for (let i = kids.length - 1; i >= 0; i--) {
          const [ko, kn] = kids[i], km = mapOf(ko), st = km.get(kn);
          if (st === undefined) stack.push({ owner: ko, n: kn });
          else if (st === GRAY && !aheadOf(ko).has(kn)) aheadOf(ko).set(kn, t.reserve()); // a cycle: numbered ahead
        }
        continue;
      }
      stack.pop();
      const v = f.v, rep0 = f.rep;
      let open = false; // the text refers to an object still being copied (a cycle): not de-duplicated
      const refText = (/** @type {any} */ o, /** @type {Ref} */ r) => { if (mapOf(o).get(r.n) === GRAY) open = true; return refText0(o, r); };
      let dict = '', data = null;
      if (v instanceof PdfStream) {
        dict = walk(owner, streamDict(owner, v), refText, null);
        ({ dict, data } = await streamOut(owner, v, dict));
      } else dict = walk(owner, v, refText, null);
      const early = fwd.get(f.n);
      // equal objects written once: a hash of the text and bytes finds a candidate, and the text and the source bytes
      // are compared before sharing (no reliance on the hash: a collision cannot swap one font or image for another)
      let key = '';
      const raw = v instanceof PdfStream ? owner.r.src.rawStream(v) : null;
      if (t.dedupe && early === undefined && !open && shareable(v)) {
        key = `${dict.length} ${fnv(dict)} ${raw ? `${raw.length} ${fnv(raw)}` : ''}`;
        const hit = seen.get(key);
        if (hit && hit.dict === dict && same(hit.raw(), raw)) { m.set(f.n, hit.n); continue; }
        if (hit) key = ''; // a collision: written on its own
      }
      const n = early ?? t.reserve();
      await t.write(n, dict, data, v instanceof PdfStream ? v.dict : v instanceof Map ? v : null);
      if (key) {
        const o2 = owner, n2 = f.n, mine = rep0 === undefined ? null : v; // a replacement is not in the source: held
        seen.set(key, { n, dict, raw: () => { const v2 = mine ?? o2.r.src.get(n2); return v2 instanceof PdfStream ? o2.r.src.rawStream(v2) : null; } });
      }
      m.set(f.n, n);
    }
  }
  const same = (/** @type {Uint8Array | null} */ a, /** @type {Uint8Array | null} */ b) => {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  /** @param {any} v */
  const shareable = (v) => {
    if (v instanceof PdfStream) return true;
    if (Array.isArray(v)) return true;
    if (v instanceof Map) { const ty = v.get('Type'); return (typeof ty === 'string' && SHARE.has(ty)) || v.has('BaseFont'); }
    return typeof v !== 'object' || v === null || v instanceof PdfString;
  };
  /**
   * FNV-1a over a string's code units or bytes: a candidate key only (a hit is compared in full before sharing), sync
   * and allocation-free (a SHA-256 per object through WebCrypto cost ~18 MB of peak memory on a 2,000-page save)
   * @param {string | Uint8Array} x
   */
  const fnv = (x) => {
    let h = 0x811c9dc5;
    if (typeof x === 'string') for (let i = 0; i < x.length; i++) h = Math.imul(h ^ x.charCodeAt(i), 0x01000193);
    else for (let i = 0; i < x.length; i++) h = Math.imul(h ^ x[i], 0x01000193);
    return (h >>> 0).toString(36);
  };

  /** a stream's dictionary as copied: no /Length (the writer adds it), a Crypt filter dropped (the data is decrypted) @param {any} owner @param {PdfStream} s */
  function streamDict(owner, s) {
    const R = owner.r.src.resolve;
    const f = R(s.dict.get('Filter'));
    const d = new Map(s.dict);
    d.delete('Length'); d.delete('DL');
    if (f === 'Crypt' || (Array.isArray(f) && f.some((x) => R(x) === 'Crypt'))) {
      const fs = Array.isArray(f) ? f.map(R) : [f], ps0 = R(s.dict.get('DecodeParms')), ps = Array.isArray(ps0) ? ps0 : [ps0];
      const keep = fs.map((x, i) => [x, ps[i]]).filter(([x]) => x !== 'Crypt');
      if (keep.length) { d.set('Filter', keep.map(([x]) => x)); d.set('DecodeParms', keep.map(([, p]) => p ?? null)); } else { d.delete('Filter'); d.delete('DecodeParms'); }
    }
    return d;
  }
  /** the stream's bytes to write: decrypted, compressed when it was not (and is not metadata) @param {any} owner @param {PdfStream} s @param {string} dict */
  async function streamOut(owner, s, dict) {
    const src = owner.r.src;
    let data = src.rawStream(s);
    if (t.compress && !s.dict.has('Filter') && data.length > 64 && src.resolve(s.dict.get('Type')) !== 'Metadata') {
      data = await deflate(data);
      dict = dict.replace(/>>$/, '/Filter /FlateDecode >>');
    }
    return { dict, data };
  }

  return {
    /**
     * The text of a value with every object it reaches copied (written) first. @param {any} owner the document's
     * private side @param {any} v a value (a Ref, a dictionary…)
     */
    async text(owner, v) {
      /** @type {[any, number][]} */
      const refs = [];
      walk(owner, v, null, refs);
      if (refs.length) await copyAll(refs);
      return walk(owner, v, refText0, null);
    },
    /**
     * What the copy rules would drop or rewrite in value v (reported through t.report), without copying anything:
     * reader/active.js checks every object of a file this way. @param {any} owner @param {any} v @param {number} [n] its number
     */
    audit(owner, v, n = -1) {
      if (v instanceof Map) { const r = judge(v, owner.r.src.resolve); if ('why' in r) { t.report(r.why); return; } if (r.rewritten) t.report(r.rewritten); v = r.value; }
      auditing = treeOf(owner).nums.has(n); // an object the structure walk reached by number: its elements by shape (their /A still attributesOnly)
      try { walk(owner, v instanceof PdfStream ? v.dict : v, AUDIT, null); } finally { auditing = false; }
    },
    /** the new number of an object already copied, or null @param {any} owner @param {number} n */
    numberOf(owner, n) { const v = mapOf(owner).get(n); return v == null || v === GRAY ? null : v; },
  };
}
