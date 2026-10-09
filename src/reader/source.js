// @ts-check
/**
 * A PDF file's objects, read lazily: the header, the cross-reference (classic tables, xref streams, hybrid files,
 * incremental updates, the latest winning), object streams, the trailer, decryption. An object is parsed only when it
 * is asked for (get / resolve) and kept; a stream's data is decoded only when asked (decode).
 *
 * HOSTILE input: the /Prev chain is followed once per offset (a loop ends it), at most MAX_SECTIONS sections; a table's
 * or an xref stream's rows are bounded by the bytes there, never by /Size; an object stream's /N by its data; an
 * object stream may not live in an object stream (so none contains itself); a reference chain is followed at most
 * MAX_RESOLVE deep and an object being loaded that is asked for again is null (a /Length pointing at itself). A
 * broken cross-reference is rebuilt by scanning for "n g obj" (as viewers do), once, in one pass; a wrong /Length is
 * found again from the next "endstream" (one scan of the file, binary-searched after). Everything ticks the budget.
 */
import { Lexer, parseValue, Ref, PdfString, PdfStream, Op, T, indexOf, lastIndexOf, latin1 } from './lexer.js';
import { decode } from './filters.js';
import { fail, PdfReadError } from './budget.js';
import { openSecurity } from './crypt.js';

export const MAX_SECTIONS = 4096, MAX_RESOLVE = 32, MAX_OBJSTM_N = 1_000_000;
const OBJSTM_CACHE = 32;
const P48 = 2 ** 48, P16 = 2 ** 16;
const pack = (/** @type {number} */ t, /** @type {number} */ a, /** @type {number} */ b) => t * P48 + a * P16 + b;
const unpack = (/** @type {number} */ v) => [Math.floor(v / P48), Math.floor(v / P16) % 2 ** 32, v % P16];

/**
 * @param {Uint8Array} bytes @param {import('./budget.js').Budget} budget @param {{ password?: string }} o
 */
export async function openSource(bytes, budget, o = {}) {
  const size = bytes.length;
  /** @type {Map<number, number>} object → packed entry (type 0 free, 1 at an offset, 2 in an object stream) */
  let xref = new Map();
  /** @type {Map<number, any>} */
  const cache = new Map();
  const loading = new Set();
  /** @type {Map<number, { data: Uint8Array, nums: Int32Array, offs: Int32Array, first: number }>} */
  const objstms = new Map();
  /** @type {Int32Array | null} the offsets of every "endstream", found once when a /Length is wrong */
  let endstreams = null;
  let recovered = false;
  /** @type {any} */
  let security = null, encryptRef = -1;
  /** @type {string[]} */
  const warnings = [];
  const warn = (/** @type {string} */ m) => { if (warnings.length < 100 && !warnings.includes(m)) warnings.push(m); };

  // header
  const head = indexOf(bytes, '%PDF-', 0, Math.min(size, 1024));
  if (head < 0 && indexOf(bytes, ' obj', 0, Math.min(size, 1 << 20)) < 0) fail('E_MALFORMED', 'Not a PDF (no %PDF- header and no objects)');
  const version = head >= 0 ? (/^\d\.\d/.exec(latin1(bytes.subarray(head + 5, head + 8)))?.[0] ?? '1.4') : '1.4';

  /** an object at an offset: "n g obj value [stream]" @param {number} off @param {Uint8Array} [buf] @param {number} [end] */
  function parseAt(off, buf = bytes, end = buf.length) {
    const lx = new Lexer(buf, budget, off, end);
    if (lx.next() !== T.NUM) return null;
    const n = lx.val;
    if (lx.next() !== T.NUM) return null;
    const g = lx.val;
    if (lx.next() !== T.KW || lx.val !== 'obj') return null;
    let v = parseValue(lx);
    if (v === undefined || v instanceof Op) v = null;
    let stop = lx.pos, data = /** @type {[number, number] | null} */ (null);
    if (v instanceof Map && buf === bytes) {
      const at = lx.pos;
      if (lx.next() === T.KW && lx.val === 'stream') {
        let s = lx.pos;
        if (bytes[s] === 13) s++;
        if (bytes[s] === 10) s++;
        v = new PdfStream(v, streamData(v, s, n), n, g);
        data = [s, s + v.data.length];
        const es = indexOf(bytes, 'endstream', data[1]);
        stop = es < 0 ? size : es + 9;
      } else lx.pos = at;
    }
    return { n, g, v, end: stop, data };
  }
  /** a stream's bytes from s: /Length when it lands on "endstream", else up to the next "endstream" @param {Map<string, any>} d @param {number} s @param {number} n */
  function streamData(d, s, n) {
    let len = d.get('Length');
    if (len instanceof Ref) len = len.n === n ? null : get(len.n);
    if (Number.isInteger(len) && len >= 0 && s + len <= size) {
      let e = s + len;
      while (e < size && (bytes[e] === 10 || bytes[e] === 13 || bytes[e] === 32 || bytes[e] === 9 || bytes[e] === 12 || bytes[e] === 0)) e++;
      if (indexOf(bytes, 'endstream', e, Math.min(size, e + 9)) === e) return bytes.subarray(s, s + len);
    }
    // a wrong /Length: up to the next endstream (all of them found in one pass, then binary search)
    if (!endstreams) {
      const at = [];
      for (let i = indexOf(bytes, 'endstream', 0); i >= 0; i = indexOf(bytes, 'endstream', i + 9)) { at.push(i); if ((at.length & 1023) === 0) budget.tick(); }
      budget.tick(1 + (size >> 12));
      endstreams = Int32Array.from(at);
    }
    let lo = 0, hi = endstreams.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (endstreams[mid] < s) lo = mid + 1; else hi = mid; }
    let e = lo < endstreams.length ? endstreams[lo] : size;
    if (e > s && bytes[e - 1] === 10) e--;
    if (e > s && bytes[e - 1] === 13) e--;
    warn('a stream /Length is wrong; its data runs to the next "endstream"');
    return bytes.subarray(s, Math.max(s, e));
  }

  /** decrypt the strings of an object (not in an object stream), in place, without recursion @param {any} v @param {number} n @param {number} g */
  function decryptStrings(v, n, g) {
    if (!security || n === encryptRef) return v;
    const fix = (/** @type {any} */ x) => (x instanceof PdfString ? new PdfString(security.string(n, g, x.bytes), x.hex) : x);
    if (v instanceof PdfString) return fix(v);
    const stack = [v instanceof PdfStream ? v.dict : v];
    while (stack.length) {
      const c = stack.pop();
      budget.tick();
      if (Array.isArray(c)) { for (let i = 0; i < c.length; i++) { c[i] = fix(c[i]); if (c[i] instanceof Map || Array.isArray(c[i])) stack.push(c[i]); } }
      else if (c instanceof Map) {
        const sig = c.has('ByteRange') && (c.get('Type') === 'Sig' || c.get('Type') === 'DocTimeStamp' || c.has('Contents'));
        for (const [k, x] of c) {
          if (sig && k === 'Contents') continue; // a signature's /Contents is never encrypted
          const y = fix(x); if (y !== x) c.set(k, y);
          if (y instanceof Map || Array.isArray(y)) stack.push(y);
        }
      }
    }
    return v;
  }

  /** object n from object stream s at index i @param {number} s @param {number} i @param {number} n */
  function fromObjStm(s, i, n) {
    let os = objstms.get(s);
    if (!os) {
      const e = xref.get(s);
      if (e === undefined || unpack(e)[0] !== 1) { warn('an object stream is not a top-level object'); return null; } // never one inside another: none contains itself
      const st = get(s);
      if (!(st instanceof PdfStream)) return null;
      const { data } = decodeStream(st);
      const N = st.dict.get('N'), first = st.dict.get('First');
      if (!Number.isInteger(N) || N < 0 || !Number.isInteger(first) || first < 0 || first > data.length) { warn('an object stream has a bad /N or /First'); return null; }
      const cnt = Math.min(N, MAX_OBJSTM_N, Math.floor(first / 2) + 1); // each pair takes ≥ 2 bytes of the header
      const nums = new Int32Array(cnt), offs = new Int32Array(cnt);
      const lx = new Lexer(data, budget, 0, first);
      let k = 0;
      for (; k < cnt; k++) {
        if (lx.next() !== T.NUM) break; nums[k] = lx.val;
        if (lx.next() !== T.NUM) break; offs[k] = lx.val;
      }
      os = { data, nums: nums.subarray(0, k), offs: offs.subarray(0, k), first };
      if (objstms.size >= OBJSTM_CACHE) objstms.delete(/** @type {number} */ (objstms.keys().next().value));
      objstms.set(s, os);
    }
    let j = os.nums[i] === n ? i : os.nums.indexOf(n);
    if (j < 0) return null;
    const at = os.first + os.offs[j];
    if (at < 0 || at > os.data.length) return null;
    const lx = new Lexer(os.data, budget, at, os.data.length);
    const v = parseValue(lx);
    return v === undefined || v instanceof Op ? null : v;
  }

  /** object n (cached), null when free, missing or broken @param {number} n */
  function get(n) {
    if (cache.has(n)) return cache.get(n);
    if (loading.has(n)) return null; // asked for while it loads (a /Length that is itself, an object stream in a loop)
    loading.add(n);
    try {
      let v = load(n);
      if (v === undefined && !recovered) { recover(); recoverDeep(); v = load(n); }
      v ??= null;
      cache.set(n, v);
      return v;
    } finally { loading.delete(n); }
  }
  /** @param {number} n @returns {any} undefined: the entry pointed at something else */
  function load(n) {
    const e = xref.get(n);
    if (e === undefined) return null;
    const [t, a, b] = unpack(e);
    if (t === 1) {
      if (a >= size) return undefined;
      const r = parseAt(a);
      if (!r || r.n !== n) return undefined;
      return decryptStrings(r.v, n, r.g);
    }
    if (t === 2) return fromObjStm(a, b, n);
    return null;
  }

  /** follow references (at most MAX_RESOLVE) @param {any} v */
  function resolve(v) {
    for (let i = 0; v instanceof Ref; i++) {
      if (i >= MAX_RESOLVE) fail('E_CYCLE', `A chain of indirect references is longer than ${MAX_RESOLVE} (a loop)`);
      v = get(v.n);
    }
    return v;
  }

  /** a stream's data decrypted (still filtered) @param {PdfStream} s */
  function rawStream(s) {
    return security && s.n !== encryptRef && !s.xrefStream ? security.stream(s.n, s.g, s.data, s.dict) : s.data;
  }
  /** a stream decoded @param {PdfStream} s @returns {{ data: Uint8Array, done: boolean, filter: string | null }} */
  function decodeStream(s) {
    return decode(rawStream(s), resolve(s.dict.get('Filter')), resolve(s.dict.get('DecodeParms') ?? s.dict.get('DP')), budget, resolve);
  }

  // ---- the cross-reference ----
  /** @type {Map<string, any>} */
  let trailer = new Map();
  let xrefIsStream = false, startxref = -1;
  /** @type {number[]} each revision's end (after its %%EOF) */
  const revisions = [];

  /** a section at off: its entries, trailer and /Prev @param {number} off */
  function section(off) {
    const lx = new Lexer(bytes, budget, off);
    lx.ws();
    if (indexOf(bytes, 'xref', lx.pos, lx.pos + 4) === lx.pos) { // a classic table
      lx.pos += 4;
      /** @type {[number, number][]} */
      const rows = [];
      for (;;) {
        const save = lx.pos;
        const k = lx.next();
        if (k === T.KW && lx.val === 'trailer') break;
        if (k !== T.NUM) { lx.pos = save; break; }
        let start = lx.val;
        if (lx.next() !== T.NUM) fail('E_MALFORMED', 'A cross-reference subsection header is broken');
        const count = lx.val;
        if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 0 || count > (size - lx.pos) / 17 + 1) fail('E_MALFORMED', 'A cross-reference subsection claims more rows than the file holds');
        for (let i = 0; i < count; i++) {
          if (lx.next() !== T.NUM) fail('E_MALFORMED', 'A cross-reference row is broken');
          const a = lx.val;
          if (lx.next() !== T.NUM) fail('E_MALFORMED', 'A cross-reference row is broken');
          const g = lx.val;
          if (lx.next() !== T.KW || (lx.val !== 'n' && lx.val !== 'f')) fail('E_MALFORMED', 'A cross-reference row is broken');
          if (i === 0 && start === 1 && lx.val === 'f' && a === 0 && g === 65535) start = 0; // a known writer bug: the table starts at 1 but lists object 0
          const num = start + i;
          if (rows.length >= budget.maxObjects) fail('E_BUDGET', `More than ${budget.maxObjects.toLocaleString('en')} cross-reference entries (budget.maxObjects)`);
          if (lx.val === 'f') rows.push([num, 0]);
          else if (a >= 0 && a < 2 ** 32 && a < size) rows.push([num, pack(1, a, Math.max(0, Math.min(g, 65535)))]);
        }
      }
      const tr = parseValue(lx);
      if (!(tr instanceof Map)) fail('E_MALFORMED', 'The trailer is not a dictionary');
      return { rows, trailer: tr, stream: false };
    }
    const r = parseAt(off);
    if (!r || !(r.v instanceof PdfStream) || r.v.dict.get('Type') !== 'XRef') fail('E_MALFORMED', 'startxref does not point at a cross-reference');
    return xrefStream(/** @type {PdfStream} */ (r.v));
  }
  /** @param {PdfStream} s */
  function xrefStream(s) {
    s.xrefStream = true; // never encrypted
    const d = s.dict;
    const W = d.get('W');
    if (!Array.isArray(W) || W.length < 3 || !W.slice(0, 3).every((w) => Number.isInteger(w) && w >= 0 && w <= 8)) fail('E_MALFORMED', 'An xref stream has a bad /W');
    const [w0, w1, w2] = W, rw = w0 + w1 + w2;
    if (!rw) fail('E_MALFORMED', 'An xref stream has a bad /W');
    const { data } = decode(s.data, d.get('Filter'), d.get('DecodeParms'), budget, (v) => (v instanceof Ref ? null : v));
    let index = d.get('Index');
    if (!Array.isArray(index)) index = [0, d.get('Size')];
    /** @type {[number, number][]} */
    const rows = [];
    let at = 0;
    const field = (/** @type {number} */ w) => { let v = 0; for (let i = 0; i < w; i++) v = v * 256 + data[at++]; return v; };
    for (let k = 0; k + 1 < index.length && at + rw <= data.length; k += 2) {
      const start = index[k], count = index[k + 1];
      if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 0) fail('E_MALFORMED', 'An xref stream has a bad /Index');
      const n = Math.min(count, Math.floor((data.length - at) / rw)); // rows bounded by the data, never by /Size
      for (let i = 0; i < n; i++) {
        if (rows.length >= budget.maxObjects) fail('E_BUDGET', `More than ${budget.maxObjects.toLocaleString('en')} cross-reference entries (budget.maxObjects)`);
        const t = w0 ? field(w0) : 1, a = field(w1), b = field(w2);
        if ((i & 1023) === 0) budget.tick();
        if (t === 0) rows.push([start + i, 0]);
        else if (t === 1 && a < size) rows.push([start + i, pack(1, a, Math.min(b, 65535))]);
        else if (t === 2 && a < 2 ** 32 && b < 65536) rows.push([start + i, pack(2, a, b)]);
      }
    }
    return { rows, trailer: d, stream: true };
  }

  function readXref() {
    const sx = lastIndexOf(bytes, 'startxref', size, Math.min(size, 1 << 20));
    if (sx < 0) fail('E_MALFORMED', 'No startxref');
    const lx = new Lexer(bytes, budget, sx + 9);
    if (lx.next() !== T.NUM || !Number.isInteger(lx.val) || lx.val < 0 || lx.val >= size) fail('E_MALFORMED', 'startxref is not an offset in the file');
    startxref = lx.val;
    const seen = new Set();
    /** @type {Map<number, number>} */
    const out = new Map();
    let off = startxref, first = true;
    while (off >= 0) {
      if (seen.has(off)) { warn('the /Prev chain of cross-reference sections loops; it was cut'); break; }
      if (seen.size >= MAX_SECTIONS) fail('E_MALFORMED', `More than ${MAX_SECTIONS} cross-reference sections`);
      seen.add(off);
      const s = section(off);
      if (first) { trailer = s.trailer; xrefIsStream = s.stream; first = false; }
      else for (const k of ['Root', 'Info', 'Encrypt', 'ID']) if (!trailer.has(k) && s.trailer.has(k)) trailer.set(k, s.trailer.get(k));
      /** @type {Map<number, number>} this section's entries: its hybrid xref stream fills the table's free or missing ones */
      const sec = new Map(s.rows);
      const stm = s.trailer.get('XRefStm');
      if (!s.stream && Number.isInteger(stm) && stm >= 0 && stm < size && !seen.has(stm)) {
        try {
          const r = parseAt(stm);
          if (r && r.v instanceof PdfStream) for (const [n, e] of xrefStream(r.v).rows) if (!sec.get(n)) sec.set(n, e);
        } catch (e) { if (!(e instanceof PdfReadError) || e.code !== 'E_MALFORMED') throw e; warn('a hybrid file\'s /XRefStm is broken'); }
      }
      for (const [n, e] of sec) if (!out.has(n)) out.set(n, e); // the latest section wins
      if (out.size > budget.maxObjects) fail('E_BUDGET', `More than ${budget.maxObjects.toLocaleString('en')} cross-reference entries (budget.maxObjects)`);
      const prev = s.trailer.get('Prev');
      off = Number.isInteger(prev) && prev >= 0 && prev < size ? prev : -1;
    }
    xref = out;
  }

  /** every "n g obj" in the bytes, in file order: [n, g, offset] (a bounded scan, one pass) */
  function scanObjects() {
    /** @type {[number, number, number][]} */
    const out = [];
    const isDigit = (/** @type {number} */ c) => c >= 0x30 && c <= 0x39, isWs = (/** @type {number} */ c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
    for (let i = indexOf(bytes, 'obj', 0); i >= 0; i = indexOf(bytes, 'obj', i + 3)) {
      if (out.length >= budget.maxObjects) fail('E_BUDGET', `More than ${budget.maxObjects.toLocaleString('en')} objects (budget.maxObjects)`);
      if ((out.length & 1023) === 0) budget.tick(64);
      const after = bytes[i + 3];
      if (i + 3 < size && !(isWs(after) || after === 0x3c || after === 0x5b || after === 0x2f || after === 0x28 || after === 0x25)) continue;
      let j = i - 1;
      if (j < 0 || !isWs(bytes[j])) continue;
      while (j >= 0 && isWs(bytes[j])) j--;
      const ge = j; while (j >= 0 && isDigit(bytes[j]) && ge - j < 5) j--;
      if (j === ge || j < 0 || !isWs(bytes[j])) continue;
      const g = Number(latin1(bytes.subarray(j + 1, ge + 1)));
      while (j >= 0 && isWs(bytes[j])) j--;
      const ne = j; while (j >= 0 && isDigit(bytes[j]) && ne - j < 10) j--;
      if (j === ne || (j >= 0 && !isWs(bytes[j]) && bytes[j] !== 0x3e && bytes[j] !== 0x5d && bytes[j] !== 0x29)) continue;
      const n = Number(latin1(bytes.subarray(j + 1, ne + 1)));
      if (n > 0 && n < 2 ** 31) out.push([n, g, j + 1]);
    }
    return out;
  }
  /** rebuild the cross-reference by scanning for "n g obj" (later wins), and the trailer from "trailer" dictionaries and xref streams */
  function recover() {
    if (recovered) return;
    recovered = true;
    warn('the cross-reference was broken and has been rebuilt by scanning the file');
    /** @type {Map<number, number>} */
    const found = new Map();
    for (const [n, g, off] of scanObjects()) found.set(n, pack(1, off, Math.min(g, 65535))); // later wins
    // trailers: the last one's keys win
    /** @type {Map<string, any>} */
    const tr = new Map();
    for (let i = indexOf(bytes, 'trailer', 0); i >= 0; i = indexOf(bytes, 'trailer', i + 7)) {
      budget.tick(16);
      try { const v = parseValue(new Lexer(bytes, budget, i + 7)); if (v instanceof Map) for (const [k, x] of v) if (['Root', 'Info', 'Encrypt', 'ID'].includes(k)) tr.set(k, x); } catch (e) { if (!(e instanceof PdfReadError) || e.code === 'E_TIMEOUT' || e.code === 'E_ABORTED' || e.code === 'E_BUDGET') throw e; }
    }
    // keep entries in object streams the old table knew, unless the scan found the object itself
    for (const [n, e] of xref) if (unpack(e)[0] === 2 && !found.has(n)) found.set(n, e);
    xref = found;
    trailer = tr;
    // xref streams' trailer keys (/Encrypt among them: needed before anything can be decrypted); their dictionaries are never encrypted
    if (!['Root', 'Encrypt'].every((k) => tr.has(k))) for (const [n, e] of found) {
      if (unpack(e)[0] !== 1 || indexOf(bytes, 'XRef', unpack(e)[1], Math.min(size, unpack(e)[1] + 4096)) < 0) continue;
      let v; try { v = parseAt(unpack(e)[1])?.v; } catch (x) { if (x instanceof PdfReadError && (x.code === 'E_TIMEOUT' || x.code === 'E_ABORTED' || x.code === 'E_BUDGET')) throw x; continue; }
      if (v instanceof PdfStream && v.dict.get('Type') === 'XRef') for (const k of ['Root', 'Info', 'Encrypt', 'ID']) if (!tr.has(k) && v.dict.has(k)) tr.set(k, v.dict.get(k));
    }
    cache.clear(); objstms.clear();
  }
  /** the rebuild's second half, once the file can be decrypted: object streams' contents, xref streams' trailers, and the catalog if the trailer has no Root */
  function recoverDeep() {
    const found = xref, tr = trailer;
    let catalog = null;
    for (const [n] of found) {
      if (unpack(/** @type {number} */ (found.get(n)))[0] !== 1) continue;
      let v;
      try { v = load(n); } catch (e) { if (e instanceof PdfReadError && (e.code === 'E_TIMEOUT' || e.code === 'E_ABORTED' || e.code === 'E_BUDGET')) throw e; continue; }
      if (v instanceof PdfStream && v.dict.get('Type') === 'ObjStm') {
        const N = v.dict.get('N'), first = v.dict.get('First');
        if (!Number.isInteger(N) || !Number.isInteger(first)) continue;
        try {
          const { data } = decodeStream(v);
          const lx = new Lexer(data, budget, 0, Math.min(first, data.length));
          for (let k = 0; k < Math.min(N, MAX_OBJSTM_N); k++) {
            if (lx.next() !== T.NUM) break; const num = lx.val;
            if (lx.next() !== T.NUM) break;
            if (Number.isInteger(num) && num > 0 && !found.has(num)) found.set(num, pack(2, n, k));
          }
        } catch (e) { if (e instanceof PdfReadError && (e.code === 'E_TIMEOUT' || e.code === 'E_ABORTED' || e.code === 'E_BUDGET')) throw e; }
      } else if (v instanceof PdfStream && v.dict.get('Type') === 'XRef') {
        for (const k of ['Root', 'Info', 'Encrypt', 'ID']) if (!tr.has(k) && v.dict.has(k)) tr.set(k, v.dict.get(k));
      } else if (v instanceof Map && v.get('Type') === 'Catalog') catalog = n;
    }
    if (!(resolveSafe(tr.get('Root')) instanceof Map) && catalog != null) tr.set('Root', new Ref(catalog, 0));
    trailer = tr;
    cache.clear();
  }
  const resolveSafe = (/** @type {any} */ v) => { try { return resolve(v); } catch (e) { if (e instanceof PdfReadError && (e.code === 'E_TIMEOUT' || e.code === 'E_ABORTED' || e.code === 'E_BUDGET')) throw e; return null; } };

  try { readXref(); } catch (e) {
    if (!(e instanceof PdfReadError) || e.code === 'E_TIMEOUT' || e.code === 'E_ABORTED' || e.code === 'E_BUDGET') throw e;
    recover();
  }

  // revisions: where each %%EOF ends (signatures say which revision they cover)
  for (let i = indexOf(bytes, '%%EOF', 0); i >= 0 && revisions.length < MAX_SECTIONS; i = indexOf(bytes, '%%EOF', i + 5)) {
    let e = i + 5; if (bytes[e] === 13) e++; if (bytes[e] === 10) e++;
    revisions.push(e);
  }

  // decryption
  const encV = trailer.get('Encrypt');
  const idArr = resolveSafe(trailer.get('ID'));
  const id = Array.isArray(idArr) && idArr[0] instanceof PdfString ? [idArr[0].bytes, (idArr[1] instanceof PdfString ? idArr[1] : idArr[0]).bytes] : null;
  if (encV != null) {
    if (encV instanceof Ref) encryptRef = encV.n;
    const E = resolveSafe(encV);
    if (E instanceof Map) {
      security = await openSecurity(E, id?.[0] ?? new Uint8Array(0), o.password ?? '', resolve);
      const keep = encryptRef >= 0 ? cache.get(encryptRef) : undefined;
      cache.clear(); objstms.clear(); // anything read before the key is read again, decrypted
      if (keep !== undefined) cache.set(encryptRef, keep);
    }
  }
  if (recovered) recoverDeep();
  else if (!(resolveSafe(trailer.get('Root')) instanceof Map)) { recover(); recoverDeep(); }
  const root = resolveSafe(trailer.get('Root'));
  if (!(root instanceof Map)) fail('E_MALFORMED', 'The PDF has no document catalog (/Root)');

  return {
    bytes, budget, size, version, trailer, id, warnings, warn,
    get recovered() { return recovered; },
    get security() { return security; },
    encryptRef, xrefIsStream, startxref, revisions,
    /** the highest object number + 1 */
    get maxNum() { let m = 0; for (const n of xref.keys()) if (n > m) m = n; const S = trailer.get('Size'); return Math.max(m + 1, Number.isInteger(S) && S <= m + 1_000_000 ? S : 0); }, // a /Size far past the objects is a lie
    get, resolve, decodeStream, rawStream,
    /** the generation of object n in the cross-reference (0 in an object stream or unknown) @param {number} n */
    genOf(n) { const e = xref.get(n); if (!e) return 0; const [t, , g] = unpack(e); return t === 1 ? g : 0; },
    /**
     * EVERY object in the bytes, each version of it (older revisions, objects nothing refers to), and every object
     * in every object stream: { n, v }. Parsed (and decrypted) apart from the cache. Errors are thrown, not skipped:
     * a caller that must see everything fails closed.
     */
    *everyObject() {
      /** @type {Map<number, number>} offset → object number of every object read */
      const at = new Map();
      /** @type {[number, number][]} stream data regions */
      const regions = [];
      /** @type {Map<number, Set<number>>} object stream number → its members */
      const members = new Map();
      const unreadable = (/** @type {string} */ m) => { throw new PdfReadError('E_MALFORMED', m); };
      /** @param {number} off */
      function* read(off) {
        const r = parseAt(off);
        if (!r) return false;
        at.set(off, r.n);
        if (r.data) regions.push(r.data);
        const v = decryptStrings(r.v, r.n, r.g);
        yield { n: r.n, v };
        if (v instanceof PdfStream && resolve(v.dict.get('Type')) === 'ObjStm') { // its objects, every one (fail closed)
          const { data } = decodeStream(v);
          const N = resolve(v.dict.get('N')), first = resolve(v.dict.get('First'));
          if (!Number.isInteger(N) || !Number.isInteger(first) || first < 0 || first > data.length || N < 0) unreadable(`The object stream ${r.n} has a bad /N or /First`);
          const lx = new Lexer(data, budget, 0, first);
          const set = new Set();
          for (let k = 0; k < Math.min(N, MAX_OBJSTM_N); k++) {
            if (lx.next() !== T.NUM) unreadable(`The object stream ${r.n}'s header is broken`);
            const num = lx.val;
            if (lx.next() !== T.NUM) unreadable(`The object stream ${r.n}'s header is broken`);
            const o = lx.val;
            if (!Number.isInteger(o) || o < 0 || first + o > data.length) unreadable(`The object stream ${r.n} points outside its data`);
            const x = parseValue(new Lexer(data, budget, first + o));
            if (x === undefined || x instanceof Op) unreadable(`An object in object stream ${r.n} cannot be read`);
            set.add(num);
            yield { n: num, v: x };
          }
          members.set(r.n, set);
        }
        return r.end;
      }
      // 1. the file read as a repairing viewer reads it: tokens, with the parser's own lexer (any white space, comments)
      const lx = new Lexer(bytes, budget);
      /** @type {{ k: number, v: any, start: number }[]} */
      let last = [];
      for (;;) {
        const k = lx.next();
        if (k === T.EOF) break;
        if (k === T.KW && lx.val === 'obj' && last.length === 2 && last.every((t) => t.k === T.NUM && Number.isInteger(t.v) && t.v >= 0)) {
          const off = last[0].start;
          const end = yield* read(off);
          if (end === false) unreadable(`The object at byte ${off} cannot be read`);
          lx.pos = Math.max(lx.pos, /** @type {number} */ (end));
          last = [];
          continue;
        }
        last.push({ k, v: lx.val, start: lx.start });
        if (last.length > 2) last.shift();
      }
      // 2. every "n g obj" a byte scan finds (one hidden in a string the tokens swallowed, in junk, in stream data)
      const inStream = (/** @type {number} */ off) => regions.some(([a, b]) => off >= a && off < b);
      for (const [, , off] of scanObjects()) {
        if (at.has(off)) continue;
        let ok = false;
        try { ok = (yield* read(off)) !== false; } catch (e) { if (e instanceof PdfReadError && (e.code === 'E_TIMEOUT' || e.code === 'E_ABORTED' || e.code === 'E_BUDGET')) throw e; if (!inStream(off)) throw e; }
        if (!ok && !inStream(off)) unreadable(`The object at byte ${off} cannot be read`);
      }
      // 3. every cross-reference entry points at an object that was read
      for (const [n, e] of xref) {
        const [t, a, b] = unpack(e);
        if (t === 1 && at.get(a) !== n) unreadable(`The cross-reference entry of object ${n} points at byte ${a}, where it is not`);
        if (t === 2 && !members.get(a)?.has(n)) unreadable(`The cross-reference entry of object ${n} points into object stream ${a}, which does not hold it`);
        void b;
      }
    },
    /** every object number in the cross-reference that is in use */
    *numbers() { for (const [n, e] of xref) if (e) yield n; },
  };
}
/** @typedef {Awaited<ReturnType<typeof openSource>>} Source */
