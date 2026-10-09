// @ts-check
/**
 * PDF syntax, read: tokens and objects. The file is HOSTILE, so nothing here recurses (nested arrays and dictionaries
 * are built on an explicit stack, at most MAX_DEPTH deep), every string or name is bounded by the bytes that are
 * there, a container holds at most MAX_ITEMS values, and every token is a budget step.
 *
 * Values: numbers, booleans, null, names as JS strings ("Type"), strings as PdfString (bytes), arrays, dictionaries as
 * Map (key without the slash), indirect references as Ref, streams as PdfStream (dictionary + the raw bytes as they
 * are in the file, still filtered and, in an encrypted file, encrypted).
 */
import { fail } from './budget.js';

export const MAX_DEPTH = 256, MAX_ITEMS = 4_000_000;

export class Ref {
  /** @param {number} n @param {number} g */
  constructor(n, g) { this.n = n; this.g = g; }
  toString() { return `${this.n} ${this.g} R`; }
}
export class PdfString {
  /** @param {Uint8Array} bytes @param {boolean} [hex] written as hex in the file */
  constructor(bytes, hex = false) { this.bytes = bytes; this.hex = hex; }
}
export class PdfStream {
  /** @param {Map<string, any>} dict @param {Uint8Array} data raw (filtered; encrypted when the file is) @param {number} n @param {number} g */
  constructor(dict, data, n, g) { this.dict = dict; this.data = data; this.n = n; this.g = g; this.xrefStream = false; }
}
/** the stream of an operator or keyword in content (BT, Tj, obj, R…) */
export class Op {
  /** @param {string} v */
  constructor(v) { this.v = v; }
}

// byte classes: 1 white space, 2 delimiter
const CLASS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) CLASS[c] = 1;
for (const c of '()<>[]{}/%') CLASS[c.charCodeAt(0)] = 2;

export const T = { EOF: 0, NUM: 1, STR: 2, NAME: 3, KW: 4, AOPEN: 5, ACLOSE: 6, DOPEN: 7, DCLOSE: 8, BRACE: 9 };
const POW10 = Array.from({ length: 16 }, (_, i) => 10 ** i);
const HEX = new Int8Array(256).fill(-1);
for (let i = 0; i < 16; i++) HEX['0123456789abcdef'.charCodeAt(i)] = i, HEX['0123456789ABCDEF'.charCodeAt(i)] = i;

/** bytes → a string of chars 0–255 @param {Uint8Array} b */
export function latin1(b) {
  if (b.length < 64) { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; }
  const B = /** @type {any} */ (globalThis).Buffer;
  if (B) return B.from(b.buffer, b.byteOffset, b.length).toString('latin1');
  let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
}

// names every file repeats, made once: a name read is looked up by length and two bytes, then compared, so the common
// ones build no string (a fixed table of the spec's names, nothing from a file)
const COMMON = new Map();
for (const s of ('Type Subtype Font Page Pages Parent Contents Resources MediaBox CropBox Rotate Filter FlateDecode Length DecodeParms '
  + 'BaseFont Encoding WinAnsiEncoding FirstChar LastChar Widths FontDescriptor ProcSet PDF Text ImageB ImageC ImageI XObject ExtGState '
  + 'ColorSpace Kids Count Annots Root Info Size Prev ID XRef ObjStm N First W Index Catalog Name Type1 TrueType Type0 Image Width Height '
  + 'BitsPerComponent DeviceRGB DeviceGray DeviceCMYK Metadata Outlines Trans Group Rect Border Subj Link URI GoTo S D A Dest Annot '
  + 'StructParents Helvetica ASCII85Decode DCTDecode Producer Creator Author Title Subject Keywords CreationDate ModDate Trapped '
  + 'obj endobj stream endstream R true false null xref trailer startxref BT ET Tf Td TD Tm T* Tj TJ Tc Tw TL Tz Ts Tr q Q cm re f n W m l c h S B Do gs rg RG g G k K cs CS sc scn').split(' ')) {
  const k = s.length * 65536 + s.charCodeAt(0) * 256 + s.charCodeAt(s.length - 1);
  const l = COMMON.get(k); if (l) l.push(s); else COMMON.set(k, [s]);
}
/** an operator object for each of those names, shared (an Op is never changed) */
const OPS = new Map([...COMMON.values()].flat().map((s) => [s, new Op(s)]));
/** @param {Uint8Array} b @param {number} i @param {number} j */
function common(b, i, j) {
  const l = COMMON.get((j - i) * 65536 + b[i] * 256 + b[j - 1]);
  if (l) outer: for (const s of l) { for (let k = 1; k < s.length - 1; k++) if (s.charCodeAt(k) !== b[i + k]) continue outer; return s; }
  return word(b, i, j);
}

/** the bytes [i, j) as a string of chars 0–255 (no cache: nothing read from one file outlives its lexer) @param {Uint8Array} b @param {number} i @param {number} j */
function word(b, i, j) {
  if (j - i > 24) return latin1(b.subarray(i, j));
  let s = ''; for (let k = i; k < j; k++) s += String.fromCharCode(b[k]);
  return s;
}

export class Lexer {
  /** @param {Uint8Array} buf @param {import('./budget.js').Budget} budget @param {number} [at] @param {number} [end] */
  constructor(buf, budget, at = 0, end = buf.length) {
    this.buf = buf; this.pos = at; this.end = Math.min(end, buf.length); this.budget = budget;
    /** @type {any} */ this.val = null;
    this.start = at;
  }
  /** skip white space and comments */
  ws() {
    const b = this.buf, e = this.end;
    let i = this.pos;
    for (;;) {
      while (i < e && CLASS[b[i]] === 1) i++;
      if (i < e && b[i] === 0x25) { while (i < e && b[i] !== 10 && b[i] !== 13) i++; continue; }
      break;
    }
    this.pos = i;
  }
  /** the next token's kind (T); its value in this.val */
  next() {
    this.budget.tick();
    this.ws();
    const b = this.buf, e = this.end;
    let i = this.pos;
    this.start = i;
    if (i >= e) return T.EOF;
    const c = b[i];
    if (c === 0x5b) { this.pos = i + 1; return T.AOPEN; }
    if (c === 0x5d) { this.pos = i + 1; return T.ACLOSE; }
    if (c === 0x7b || c === 0x7d) { this.pos = i + 1; this.val = c; return T.BRACE; }
    if (c === 0x3c) {
      if (b[i + 1] === 0x3c) { this.pos = i + 2; return T.DOPEN; }
      return this.hexString(i + 1);
    }
    if (c === 0x3e) { this.pos = i + (b[i + 1] === 0x3e ? 2 : 1); return T.DCLOSE; }
    if (c === 0x28) return this.literal(i + 1);
    if (c === 0x29) { this.pos = i + 1; return this.next(); } // a stray ')': skipped, as viewers do
    if (c === 0x2f) return this.name(i + 1);
    // a number or a keyword: the run of regular characters
    let j = i;
    while (j < e && CLASS[b[j]] === 0) j++;
    this.pos = j;
    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {
      if (j - i <= 16) { // the common case, a short plain number: no string. At most 15 digits, so the digits and the
        // power of ten are exact doubles and one division rounds as Number() does (IEEE division is correctly rounded)
        let k = i, neg = false;
        if (c === 0x2d || c === 0x2b) { neg = c === 0x2d; k++; }
        let v = 0, digits = 0, frac = -1;
        for (; k < j; k++) {
          const d = b[k];
          if (d >= 0x30 && d <= 0x39) { v = v * 10 + d - 0x30; digits++; if (frac >= 0) frac++; } else if (d === 0x2e && frac < 0) frac = 0; else break;
        }
        if (k === j && digits > 0 && digits <= 15) { if (frac > 0) v /= POW10[frac]; this.val = neg ? -v : v; return T.NUM; }
      }
      let s = ''; for (let k = i; k < j && k < i + 64; k++) s += String.fromCharCode(b[k]);
      let v = Number(s);
      if (!Number.isFinite(v)) { const m = /^[+-]?(\d+\.?\d*|\.\d+)/.exec(s.replace(/^([+-])[+-]+/, '$1')); v = m ? Number(m[0]) : 0; } // "--5", "5-3": the leading number, as viewers read it
      this.val = Number.isFinite(v) ? v : 0;
      return T.NUM;
    }
    this.val = j - i <= 128 ? common(b, i, j) : word(b, i, i + 128);
    return T.KW;
  }
  /** @param {number} i after "(" */
  literal(i) {
    const b = this.buf, e = this.end;
    let j = i; // the end first (the string is never longer than its bytes), then the bytes
    for (let d = 1; j < e; j++) { const c = b[j]; if (c === 0x5c) j++; else if (c === 0x28) d++; else if (c === 0x29 && --d === 0) break; }
    const out = new Uint8Array(Math.max(0, Math.min(j, e) - i));
    let n = 0, depth = 1;
    while (i < e) {
      const c = b[i++];
      if (c === 0x5c) { // escape
        if (i >= e) break;
        const d = b[i++];
        if (d === 0x6e) out[n++] = 10; else if (d === 0x72) out[n++] = 13; else if (d === 0x74) out[n++] = 9;
        else if (d === 0x62) out[n++] = 8; else if (d === 0x66) out[n++] = 12;
        else if (d === 13) { if (b[i] === 10) i++; } else if (d === 10) { /* line continuation */ }
        else if (d >= 0x30 && d <= 0x37) {
          let v = d - 0x30;
          for (let k = 0; k < 2 && i < e && b[i] >= 0x30 && b[i] <= 0x37; k++) v = v * 8 + b[i++] - 0x30;
          out[n++] = v & 255;
        } else out[n++] = d;
        continue;
      }
      if (c === 0x28) depth++;
      else if (c === 0x29 && --depth === 0) break;
      out[n++] = c;
    }
    this.budget.tick(1 + (n >> 10));
    this.pos = i;
    this.val = new PdfString(n === out.length ? out : out.slice(0, n), false);
    return T.STR;
  }
  /** @param {number} i after "<" */
  hexString(i) {
    const b = this.buf, e = this.end;
    let j = i; while (j < e && b[j] !== 0x3e) j++;
    const out = new Uint8Array((j - i + 1) >> 1);
    let n = 0, hi = -1;
    for (let k = i; k < j; k++) {
      const h = HEX[b[k]];
      if (h < 0) continue; // white space (and junk) between digits
      if (hi < 0) hi = h; else { out[n++] = (hi << 4) | h; hi = -1; }
    }
    if (hi >= 0) out[n++] = hi << 4; // an odd last digit: followed by 0
    this.budget.tick(1 + (n >> 10));
    this.pos = j < e ? j + 1 : j;
    this.val = new PdfString(n === out.length ? out : out.slice(0, n), true);
    return T.STR;
  }
  /** @param {number} i after "/" */
  name(i) {
    const b = this.buf, e = this.end;
    let j = i;
    while (j < e && CLASS[b[j]] === 0 && b[j] !== 0x23 && j - i < 4096) j++;
    if (j - i < 4096 && (j >= e || b[j] !== 0x23)) { this.pos = j; this.val = j > i ? common(b, i, j) : ''; return T.NAME; } // no #xx escape: no per-byte string
    let s = '';
    j = i;
    while (j < e && CLASS[b[j]] === 0 && j - i < 4096) {
      if (b[j] === 0x23 && j + 2 < e && HEX[b[j + 1]] >= 0 && HEX[b[j + 2]] >= 0) { s += String.fromCharCode((HEX[b[j + 1]] << 4) | HEX[b[j + 2]]); j += 3; continue; }
      s += String.fromCharCode(b[j++]);
    }
    while (j < e && CLASS[b[j]] === 0) j++; // a name past 4096 bytes: cut
    this.pos = j;
    this.val = s;
    return T.NAME;
  }
}

/**
 * One object (a number, a reference "n g R", a string, a name, an array or a dictionary), built without recursion.
 * Malformed input is read as viewers read it: a stray ']' or '>>' is skipped, an unclosed container is closed at the
 * end (or at a keyword such as endobj or stream, which is left unread). Returns undefined at the end of input, or an
 * Op for a keyword other than true, false, null (content streams: operators).
 * @param {Lexer} lx @returns {any}
 */
export function parseValue(lx) {
  /** @type {{ arr?: any[], dict?: Map<string, any>, key: string | null }[]} */
  const stack = [];
  for (;;) {
    const before = lx.pos;
    const k = lx.next();
    /** @type {any} */
    let v;
    if (k === T.AOPEN || k === T.DOPEN) {
      if (stack.length >= MAX_DEPTH) fail('E_DEPTH', `Arrays and dictionaries nest deeper than ${MAX_DEPTH}`);
      stack.push(k === T.AOPEN ? { arr: [], key: null } : { dict: new Map(), key: null });
      continue;
    }
    if (k === T.ACLOSE) { if (!stack.length) return parseValueEnd(); const top = stack[stack.length - 1]; if (!top.arr) continue; stack.pop(); v = top.arr; }
    else if (k === T.DCLOSE) { if (!stack.length) return parseValueEnd(); const top = stack[stack.length - 1]; if (!top.dict) continue; stack.pop(); v = top.dict; }
    else if (k === T.NUM) {
      v = lx.val;
      if (Number.isInteger(v) && v >= 0) { // n g R?
        const save = lx.pos;
        if (lx.next() === T.NUM && Number.isInteger(lx.val) && lx.val >= 0 && lx.val < 65536) {
          const g = lx.val;
          if (lx.next() === T.KW && lx.val === 'R') v = new Ref(v, g);
          else lx.pos = save;
        } else lx.pos = save;
      }
    } else if (k === T.STR || k === T.NAME) v = lx.val;
    else if (k === T.BRACE) continue; // PostScript calculator braces: not data
    else if (k === T.KW) {
      const w = lx.val;
      if (w === 'true') v = true; else if (w === 'false') v = false; else if (w === 'null') v = null;
      else {
        if (!stack.length) return OPS.get(w) ?? new Op(w);
        lx.pos = before; // endobj, stream, an operator: the containers end here
        while (stack.length > 1) { const t = /** @type {any} */ (stack.pop()); add(stack[stack.length - 1], t.arr ?? t.dict); }
        const t = /** @type {any} */ (stack.pop());
        return t.arr ?? t.dict;
      }
    } else { // EOF
      if (!stack.length) return undefined;
      while (stack.length > 1) { const t = /** @type {any} */ (stack.pop()); add(stack[stack.length - 1], t.arr ?? t.dict); }
      const t = /** @type {any} */ (stack.pop());
      return t.arr ?? t.dict;
    }
    if (!stack.length) return v;
    add(stack[stack.length - 1], v);
  }
}
const parseValueEnd = () => undefined;
/** @param {{ arr?: any[], dict?: Map<string, any>, key: string | null }} top @param {any} v */
function add(top, v) {
  if (top.arr) {
    if (top.arr.length >= MAX_ITEMS) fail('E_BUDGET', `An array holds more than ${MAX_ITEMS.toLocaleString('en')} values`);
    top.arr.push(v);
    return;
  }
  const d = /** @type {Map<string, any>} */ (top.dict);
  if (top.key === null) { if (typeof v === 'string') top.key = v; return; } // a key must be a name: anything else is skipped
  if (d.size >= MAX_ITEMS) fail('E_BUDGET', `A dictionary holds more than ${MAX_ITEMS.toLocaleString('en')} entries`);
  d.set(top.key, v);
  top.key = null;
}

/** index of needle (ASCII) in buf from `from` to `to`, or -1: a native search (Buffer's memmem in Node, else the typed
 * array's own byte search for the first byte), a JS loop only for short spans @param {Uint8Array} buf @param {string} needle @param {number} from @param {number} [to] */
export function indexOf(buf, needle, from, to = buf.length) {
  const n0 = needle.charCodeAt(0), L = needle.length;
  from = Math.max(0, from); to = Math.min(to, buf.length);
  if (to - from > 64) {
    if (NodeBuffer) {
      let v = VIEWS.get(buf); // one Buffer view per array: a scan calls this ~2× per object (120k objects: 240k views)
      if (!v) VIEWS.set(buf, (v = NodeBuffer.from(buf.buffer, buf.byteOffset, buf.length)));
      // bounded at `to`: a window searched in a large file must not scan to its end (recovery checks 4 KB per xref entry)
      return (to === v.length ? v : v.subarray(0, to)).indexOf(needle, from, 'latin1');
    }
    for (let i = buf.indexOf(n0, from); i >= 0 && i + L <= to; i = buf.indexOf(n0, i + 1)) {
      let j = 1; while (j < L && buf[i + j] === needle.charCodeAt(j)) j++;
      if (j === L) return i;
    }
    return -1;
  }
  outer: for (let i = from; i + L <= to; i++) {
    if (buf[i] !== n0) continue;
    for (let j = 1; j < L; j++) if (buf[i + j] !== needle.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}
const NodeBuffer = /** @type {any} */ (globalThis).Buffer;
const VIEWS = /** @type {WeakMap<Uint8Array, any>} */ (new WeakMap());
/** last index of needle in buf before `to`, at most `span` bytes back @param {Uint8Array} buf @param {string} needle @param {number} to @param {number} [span] */
export function lastIndexOf(buf, needle, to, span = to) {
  const L = needle.length;
  outer: for (let i = Math.min(to, buf.length) - L; i >= Math.max(0, to - span); i--) {
    for (let j = 0; j < L; j++) if (buf[i + j] !== needle.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}
