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
import { sha, hex } from '../security/crypto.js';
const sha256 = (/** @type {Uint8Array} */ b) => sha('SHA-256', b);
import { judge, refuseAction, refuseAnnot, cleanFile, ACTION_KEYS, DANGEROUS_KEYS } from './policy.js';
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
export function hexText(b) { let s = '<'; for (const x of b) s += HEXD[x >> 4] + HEXD[x & 15]; return s + '>'; }

class Raw { /** @param {string} s */ constructor(s) { this.s = s; } }
/** a reference into another loaded document (a widget's new appearance, made in a scratch file by the writer) */
export class Foreign {
  /** @param {any} owner @param {Ref} ref */
  constructor(owner, ref) { this.owner = owner; this.ref = ref; }
}
const OPEN_A = new Raw('['), CLOSE_A = new Raw(']'), OPEN_D = new Raw('<<'), CLOSE_D = new Raw('>>');

/**
 * @typedef {{
 *   reserve(): number,
 *   write(n: number, dict: string, stream: Uint8Array | null, srcDict: Map<string, any> | null): Promise<void>,
 *   keepActive: boolean, compress: boolean, dedupe: boolean, keepSignatures?: boolean, resolveDests?: boolean,
 *   page(owner: any, n: number): number | null | undefined,
 *   keepStruct(owner: any): boolean,
 *   replace?(owner: any, n: number): any, hash?: (b: Uint8Array) => Promise<Uint8Array>,
 *   report(what: string): void,
 * }} Target
 *   page: the new number of the source page object n (null: not copied; undefined: n is not a page);
 *   replace: a value to copy instead of object n (a widget with a new appearance), or undefined
 */

/** @param {Target} t */
export function createCopier(t) {
  /** @type {Map<any, Map<number, number>>} owner → source number → new number (null: none; GRAY: being copied) */
  const maps = new Map();
  /** @type {Map<string, { n: number, dict: string, raw: () => Uint8Array | null }>} content hash → the object written (and how to get its source bytes again) */
  const seen = new Map();
  /** @type {Map<any, Map<number, number>>} numbers reserved ahead (cycles) */
  const ahead = new Map();
  /** @type {WeakSet<object>} dictionaries already judged (a rewritten one is not judged again) */
  const judged = new WeakSet();
  const mapOf = (/** @type {any} */ owner) => { let m = maps.get(owner); if (!m) maps.set(owner, m = new Map()); return m; };
  const aheadOf = (/** @type {any} */ owner) => { let m = ahead.get(owner); if (!m) ahead.set(owner, m = new Map()); return m; };

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
    for (const [k, v0] of d) {
      let v = v0;
      if (!t.keepActive) {
        const bad = DANGEROUS_KEYS.get(k);
        if (bad) { t.report(bad); continue; }
        if (ACTION_KEYS.has(k) && (k !== 'Next' || d.has('S'))) { // an action's place: resolved, arrays walked
          const x = R(v);
          if (Array.isArray(x) && k === 'Next') {
            const keep = [];
            for (const y of x.slice(0, 1000)) { const why = refuseAction(R(y), R); if (why) t.report(why); else keep.push(y); }
            if (!keep.length) continue;
            v = keep;
          } else { const why = refuseAction(x, R); if (why) { t.report(why); continue; } }
        }
        if (k === 'Annots' || k === 'Fields' || (k === 'Kids' && field)) { // an annotation's place: every element checked, whatever its shape
          const x = R(v);
          if (Array.isArray(x)) v = x.filter((y) => {
            const a = R(y);
            if (!(a instanceof Map)) { if (k === 'Annots') { t.report('an annotation that is not a dictionary'); return false; } return true; }
            if (k !== 'Annots' && !a.has('Subtype') && !a.has('Rect')) return true; // a field, not a widget
            const why = refuseAnnot(a, R); if (why) t.report(why); return !why;
          });
        }
        if (k === 'FS') { const r = cleanFile(R(v), R); if ('why' in r) { t.report(r.why); continue; } if (!(v instanceof Ref)) v = r.value; }
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
    while (stack.length) {
      const x = stack.pop();
      budget.tick();
      if (x instanceof Raw) { if (refText) out.push(x.s); continue; }
      if (x instanceof Ref) { if (found) found.push([owner, x.n]); if (refText) out.push(refText(owner, x)); continue; }
      if (x instanceof Foreign) { if (found) found.push([x.owner, x.ref.n]); if (refText) out.push(refText(x.owner, x.ref)); continue; }
      if (Array.isArray(x)) {
        stack.push(CLOSE_A);
        for (let i = x.length - 1; i >= 0; i--) stack.push(x[i]);
        stack.push(OPEN_A);
        continue;
      }
      if (x instanceof Map) {
        if (!t.keepActive) { // every direct dictionary's own verdict (policy.js judge): dropped, or rewritten
          if (!judged.has(x)) {
            const r = judge(x, owner.r.src.resolve);
            if ('why' in r) { if (refText) { t.report(r.why); out.push('null'); } continue; }
            judged.add(r.value);
            if (r.value !== x) { stack.push(r.value); continue; }
          }
        }
        stack.push(CLOSE_D);
        const es = entries(owner, x);
        for (let i = es.length - 1; i >= 0; i--) { stack.push(es[i][1]); stack.push(new Raw(nameText(es[i][0]))); }
        stack.push(OPEN_D);
        continue;
      }
      if (!refText) continue;
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
    /** @type {{ owner: any, n: number, v?: any, ready?: boolean }[]} */
    const stack = roots.map(([owner, n]) => ({ owner, n })).reverse();
    while (stack.length) {
      const f = stack[stack.length - 1], owner = f.owner, m = mapOf(owner), fwd = aheadOf(owner);
      if (!f.ready) {
        if (m.has(f.n)) { stack.pop(); continue; }
        const s = special(owner, f.n);
        if (s !== undefined) { m.set(f.n, s); stack.pop(); continue; }
        const rep = t.replace?.(owner, f.n);
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
      const v = f.v;
      let open = false; // the text refers to an object still being copied (a cycle): not de-duplicated
      const refText = (/** @type {any} */ o, /** @type {Ref} */ r) => { if (mapOf(o).get(r.n) === GRAY) open = true; return refText0(o, r); };
      let dict = '', data = null;
      if (v instanceof PdfStream) {
        dict = walk(owner, streamDict(owner, v), refText, null);
        ({ dict, data } = await streamOut(owner, v, dict));
      } else dict = walk(owner, v, refText, null);
      const early = fwd.get(f.n);
      // equal objects written once: SHA-256 of the text and bytes finds a candidate, and the text and the source bytes
      // are compared before sharing (no reliance on the hash: a collision cannot swap one font or image for another)
      let key = '';
      const raw = v instanceof PdfStream ? owner.r.src.rawStream(v) : null;
      if (t.dedupe && early === undefined && !open && shareable(v)) {
        key = hex(await (t.hash ?? sha256)(raw ? concat(dict, raw) : new TextEncoder().encode(dict)));
        const hit = seen.get(key);
        if (hit && hit.dict === dict && same(hit.raw(), raw)) { m.set(f.n, hit.n); continue; }
        if (hit) key = ''; // a collision: written on its own
      }
      const n = early ?? t.reserve();
      await t.write(n, dict, data, v instanceof PdfStream ? v.dict : v instanceof Map ? v : null);
      if (key) { const o2 = owner, v2 = v; seen.set(key, { n, dict, raw: () => (v2 instanceof PdfStream ? o2.r.src.rawStream(v2) : null) }); }
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
  /** @param {string} s @param {Uint8Array} b */
  const concat = (s, b) => { const a = new TextEncoder().encode(s); const o = new Uint8Array(a.length + b.length + 1); o.set(a); o[a.length] = 0; o.set(b, a.length + 1); return o; };

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
     * reader/active.js checks every object of a file this way. @param {any} owner @param {any} v
     */
    audit(owner, v) {
      if (v instanceof Map) { const r = judge(v, owner.r.src.resolve); if ('why' in r) { t.report(r.why); return; } v = r.value; }
      walk(owner, v instanceof PdfStream ? v.dict : v, () => 'null', null);
    },
    /** the new number of an object already copied, or null @param {any} owner @param {number} n */
    numberOf(owner, n) { const v = mapOf(owner).get(n); return v == null || v === GRAY ? null : v; },
  };
}
