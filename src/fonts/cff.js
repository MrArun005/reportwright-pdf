// @ts-check
/**
 * CFF (the outlines of an OpenType .otf font): read what subsetting needs, check it, and subset by glyph ID.
 *
 * Subsetting keeps glyph IDs: an unused glyph's charstring becomes a bare `endchar` (one byte), the used ones and every
 * subroutine (global and local) are kept as they are, so nothing in the charstrings needs rewriting. The new
 * CharStrings INDEX (smaller) is written where the old one was and the bytes it no longer needs are zeroed: no offset
 * elsewhere in the table changes, and Flate turns the zeros into almost nothing in the PDF. Used glyphs are scanned
 * (a Type 2 charstring walk) to check them and to find `seac` accents, whose components are named by
 * StandardEncoding code: a font using seac (deprecated in OpenType) is embedded whole instead.
 *
 * The font is HOSTILE input. Every INDEX's count, offset size and offsets are checked against the table before use
 * (offsets start at 1, never go back, end inside the table); DICT operands at most 48; charstrings at most 65,535
 * bytes, operand stack at most 48, subroutines nested at most 10 deep (Type 2 charstring spec, appendix B), called by
 * an explicit stack (no recursion), and at most 1,000,000 charstring bytes walked per glyph (a subroutine that calls
 * itself, or one called in a loop, stops there).
 */
const broken = (/** @type {string} */ why) => new TypeError(`Broken font: ${why}`);
const MAX_STACK = 48, MAX_DEPTH = 10, MAX_CS = 65535, BUDGET = 1_000_000;

/**
 * An INDEX at p: { count, at(i) → [start, end), end } (positions in t), every offset checked.
 * @param {Uint8Array} t @param {number} p @param {string} what
 */
function readIndex(t, p, what) {
  if (p + 2 > t.length) throw broken(`the CFF ${what} INDEX lies outside the table`);
  const count = (t[p] << 8) | t[p + 1];
  if (!count) return { count, os: 0, p, at: () => /** @type {[number, number]} */ ([0, 0]), end: p + 2 };
  const os = t[p + 2];
  if (os < 1 || os > 4) throw broken(`the CFF ${what} INDEX has offset size ${os}`);
  const offs = p + 3, base = offs + (count + 1) * os - 1;
  if (offs + (count + 1) * os > t.length) throw broken(`the CFF ${what} INDEX says ${count} entries, more than the table holds`);
  const off = (/** @type {number} */ i) => { let v = 0; for (let k = 0; k < os; k++) v = v * 256 + t[offs + i * os + k]; return v; };
  if (off(0) !== 1) throw broken(`the CFF ${what} INDEX does not start at offset 1`);
  let prev = 1;
  for (let i = 1; i <= count; i++) {
    const v = off(i);
    if (v < prev) throw broken(`the CFF ${what} INDEX goes backwards at entry ${i}`);
    prev = v;
  }
  if (base + prev > t.length) throw broken(`the CFF ${what} INDEX runs past the table`);
  return { count, os, p, at: (/** @type {number} */ i) => /** @type {[number, number]} */ ([base + off(i), base + off(i + 1)]), end: base + prev };
}

/** A DICT's operators → operands (two-byte operators as 1200 + b). @param {Uint8Array} t @param {number} s @param {number} e */
function readDict(t, s, e) {
  /** @type {Map<number, number[]>} */
  const d = new Map();
  let st = [];
  for (let p = s; p < e;) {
    const b = t[p];
    if (b <= 21) {
      const op = b === 12 ? 1200 + t[p + 1] : b;
      p += b === 12 ? 2 : 1;
      d.set(op, st); st = [];
      continue;
    }
    if (st.length >= MAX_STACK) throw broken('a CFF DICT has more than 48 operands');
    if (p + (b === 28 ? 3 : b === 29 ? 5 : b >= 247 ? 2 : 1) > e) throw broken('a CFF DICT runs past its end');
    if (b === 28) { st.push(((t[p + 1] << 24) | (t[p + 2] << 16)) >> 16); p += 3; }
    else if (b === 29) { st.push((t[p + 1] << 24) | (t[p + 2] << 16) | (t[p + 3] << 8) | t[p + 4]); p += 5; }
    else if (b === 30) { p++; while (p < e && (t[p] & 15) !== 15 && (t[p] >> 4) !== 15) p++; p++; st.push(0); } // a real: only offsets matter here
    else if (b >= 32 && b <= 246) { st.push(b - 139); p++; }
    else if (b >= 247 && b <= 250) { st.push((b - 247) * 256 + t[p + 1] + 108); p += 2; }
    else if (b >= 251 && b <= 254) { st.push(-(b - 251) * 256 - t[p + 1] - 108); p += 2; }
    else throw broken(`a CFF DICT has the reserved byte ${b}`);
  }
  return d;
}

const bias = (/** @type {number} */ n) => (n < 1240 ? 107 : n < 33900 ? 1131 : 32768);

/**
 * Parse and check a CFF table (version 1) for subsetting. @param {Uint8Array} t the 'CFF ' table
 * @param {number} maxpGlyphs maxp's, or -1: the CharStrings' own count (a subsetter's output, whose maxp may keep the old count)
 */
export function parseCff(t, maxpGlyphs) {
  if (t.length < 4 || t[0] !== 1) throw broken(`the CFF table is not version 1 (${t[0]})`);
  const names = readIndex(t, t[2], 'Name');
  const tops = readIndex(t, names.end, 'Top DICT');
  if (tops.count < 1) throw broken('the CFF table has no Top DICT');
  const strings = readIndex(t, tops.end, 'String');
  const gsubrs = readIndex(t, strings.end, 'Global Subr');
  const top = readDict(t, ...tops.at(0));
  if ((top.get(1206)?.[0] ?? 2) !== 2) throw broken('the CFF charstrings are not Type 2');
  const csAt = top.get(17)?.[0];
  if (csAt == null || csAt < 4) throw broken('the CFF table has no CharStrings');
  const cs = readIndex(t, csAt, 'CharStrings');
  if (maxpGlyphs >= 0 && cs.count !== maxpGlyphs) throw broken(`the CFF CharStrings has ${cs.count} glyphs, maxp says ${maxpGlyphs}`);
  const numGlyphs = cs.count;
  /** local subrs of a Private DICT given as [size, offset] @param {number[] | undefined} pr */
  const localSubrs = (pr) => {
    if (!pr || pr.length < 2) return null;
    const [size, off] = pr;
    if (size < 0 || off < 0 || off + size > t.length) throw broken('a CFF Private DICT lies outside the table');
    const sub = readDict(t, off, off + size).get(19)?.[0];
    return sub ? readIndex(t, off + sub, 'Subrs') : null;
  };
  /** @type {Uint16Array | null} a CID-keyed font's glyph → CID (the PDF draws it by CID) */
  let cids = null;
  /** @type {(g: number) => any} */
  let subrsFor;
  if (top.has(1230)) { // ROS: CID-keyed
    const fdAt = top.get(1236)?.[0], selAt = top.get(1237)?.[0];
    if (fdAt == null || selAt == null) throw broken('a CID-keyed CFF without FDArray or FDSelect');
    const fds = readIndex(t, fdAt, 'FDArray');
    const locals = [];
    for (let i = 0; i < fds.count; i++) locals.push(localSubrs(readDict(t, ...fds.at(i)).get(18)));
    const fdOf = fdSelect(t, selAt, numGlyphs, fds.count);
    subrsFor = (g) => locals[fdOf(g)];
    cids = charsetCids(t, top.get(15)?.[0] ?? 0, numGlyphs);
  } else {
    const local = localSubrs(top.get(18));
    subrsFor = () => local;
  }
  return { cs, gsubrs, subrsFor, cids, charset: cids ? /** @type {number} */ (top.get(15)?.[0]) : -1 };
}

/** FDSelect (formats 0 and 3): glyph → font DICT, checked. @param {Uint8Array} t @param {number} p @param {number} n @param {number} nfd */
function fdSelect(t, p, n, nfd) {
  if (p >= t.length) throw broken('the CFF FDSelect lies outside the table');
  const f = t[p];
  if (f === 0) {
    if (p + 1 + n > t.length) throw broken('the CFF FDSelect runs past the table');
    for (let g = 0; g < n; g++) if (t[p + 1 + g] >= nfd) throw broken('the CFF FDSelect names a font DICT that does not exist');
    return (/** @type {number} */ g) => t[p + 1 + g];
  }
  if (f !== 3) throw broken(`the CFF FDSelect has format ${f}`);
  const nr = (t[p + 1] << 8) | t[p + 2];
  if (!nr || p + 5 + nr * 3 > t.length) throw broken('the CFF FDSelect runs past the table');
  const first = (/** @type {number} */ i) => (t[p + 3 + i * 3] << 8) | t[p + 4 + i * 3];
  if (first(0) !== 0) throw broken('the CFF FDSelect does not start at glyph 0');
  for (let i = 0; i < nr; i++) {
    if (t[p + 5 + i * 3] >= nfd) throw broken('the CFF FDSelect names a font DICT that does not exist');
    if (first(i + 1) <= first(i) && i + 1 < nr) throw broken('the CFF FDSelect goes backwards');
  }
  return (/** @type {number} */ g) => {
    let lo = 0, hi = nr - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (first(mid) <= g) lo = mid; else hi = mid - 1; }
    return t[p + 5 + lo * 3];
  };
}

/**
 * A CID-keyed font's charset: glyph → CID (formats 0, 1, 2), every range inside the table, no CID twice.
 * @param {Uint8Array} t @param {number} p @param {number} n @returns {Uint16Array}
 */
function charsetCids(t, p, n) {
  if (p < 3 || p >= t.length) throw broken('a CID-keyed CFF without a charset');
  const f = t[p], cid = new Uint16Array(n), seen = new Uint8Array(65536);
  seen[0] = 1;
  let g = 1, q = p + 1;
  const u16 = (/** @type {number} */ x) => (t[x] << 8) | t[x + 1];
  const set = (/** @type {number} */ c) => {
    if (c > 65535 || seen[c]) throw broken(`the CFF charset gives CID ${c} twice or past 65535`);
    seen[c] = 1; cid[g++] = c;
  };
  if (f === 0) { if (q + (n - 1) * 2 > t.length) throw broken('the CFF charset runs past the table'); while (g < n) { set(u16(q)); q += 2; } return cid; }
  if (f !== 1 && f !== 2) throw broken(`the CFF charset has format ${f}`);
  const w = f === 1 ? 3 : 4;
  while (g < n) {
    if (q + w > t.length) throw broken('the CFF charset runs past the table');
    const first = u16(q), left = f === 1 ? t[q + 2] : u16(q + 2);
    for (let i = 0; i <= left && g < n; i++) set(first + i);
    q += w;
  }
  return cid;
}

/**
 * Walk glyph g's charstring (Type 2): checks it and returns true when it ends in a seac accent. No recursion: calls
 * go on an explicit stack of at most 10. @param {Uint8Array} t @param {ReturnType<typeof parseCff>} c @param {number} g
 */
export function scanGlyph(t, c, g) {
  const local = c.subrsFor(g);
  let [p, e] = c.cs.at(g);
  if (e - p > MAX_CS) throw broken(`the charstring of glyph ${g} is ${e - p} bytes (at most ${MAX_CS})`);
  /** @type {[number, number][]} */
  const calls = [];
  let n = 0, stems = 0, budget = BUDGET, last = 0;
  for (;;) {
    if (p >= e) {
      if (!calls.length) return false; // ran off the end: no endchar (lenient, as readers are)
      [p, e] = /** @type {[number, number]} */ (calls.pop());
      continue;
    }
    if (--budget < 0) throw broken(`the charstring of glyph ${g} runs too long (a subroutine loop?)`);
    const b = t[p];
    if (b >= 32 || b === 28) {
      if (++n > MAX_STACK) throw broken(`the charstring of glyph ${g} pushes more than ${MAX_STACK} operands`);
      last = b === 28 ? ((t[p + 1] << 24) | (t[p + 2] << 16)) >> 16 : b <= 246 ? b - 139 : b <= 250 ? (b - 247) * 256 + t[p + 1] + 108 : b <= 254 ? -(b - 251) * 256 - t[p + 1] - 108 : 0;
      p += b === 28 ? 3 : b <= 246 ? 1 : b <= 254 ? 2 : 5;
      continue;
    }
    p++;
    if (b === 10 || b === 29) { // callsubr, callgsubr: the index is the last operand
      const subrs = b === 10 ? local : c.gsubrs;
      if (!n) throw broken(`glyph ${g} calls a subroutine without its number`);
      if (!subrs || !subrs.count) throw broken(`glyph ${g} calls a subroutine that does not exist`);
      const i = last + bias(subrs.count);
      if (!(i >= 0 && i < subrs.count)) throw broken(`glyph ${g} calls subroutine ${i}, past the ${subrs.count}`);
      if (calls.length >= MAX_DEPTH) throw broken(`glyph ${g} nests subroutines deeper than ${MAX_DEPTH}`);
      n--;
      calls.push([p, e]);
      [p, e] = subrs.at(i);
      if (e - p > MAX_CS) throw broken(`a subroutine of glyph ${g} is ${e - p} bytes (at most ${MAX_CS})`);
      continue;
    }
    if (b === 11) { // return
      if (!calls.length) throw broken(`glyph ${g} returns from no subroutine`);
      [p, e] = /** @type {[number, number]} */ (calls.pop());
      continue;
    }
    if (b === 14) return n >= 4; // endchar; with 4 operands (5 with a width) it is seac
    if (b === 1 || b === 3 || b === 18 || b === 23) stems += n >> 1; // stem hints
    else if (b === 19 || b === 20) { stems += n >> 1; p += (stems + 7) >> 3; } // hintmask, cntrmask: an implicit vstem, then the mask bytes
    else if (b === 12) p++; // two-byte operators
    n = 0;
  }
}

/**
 * The CFF table with unused glyphs emptied (glyph IDs kept), or null when a used glyph is a seac accent (embed whole).
 * @param {Uint8Array} t @param {number} numGlyphs @param {Iterable<number>} used
 */
export function subsetCff(t, numGlyphs, used) {
  const c = parseCff(t, numGlyphs);
  const keep = new Set([0]);
  for (const g of used) if (g < numGlyphs) keep.add(g);
  for (const g of keep) if (scanGlyph(t, c, g)) return null;
  const { cs } = c, os = /** @type {number} */ (cs.os);
  const out = c.cids ? identityCharset(t, numGlyphs) : new Uint8Array(t); // a copy (a Buffer's slice() is a view of the caller's bytes)
  const offs = cs.p + 3;
  let data = offs + (cs.count + 1) * os, off = 1;
  const put = (/** @type {number} */ i, /** @type {number} */ v) => { for (let k = os - 1; k >= 0; k--, v = Math.floor(v / 256)) out[offs + i * os + k] = v & 255; };
  for (let g = 0; g < cs.count; g++) {
    put(g, off);
    const [s, e] = cs.at(g);
    const len = keep.has(g) || e === s ? e - s : 1;
    if (len === 1 && !keep.has(g)) out[data] = 14; else out.set(t.subarray(s, e), data);
    data += len; off += len;
  }
  put(cs.count, off);
  out.fill(0, data, cs.end); // the old CharStrings' leftover bytes: unreferenced, zero
  return out;
}

/**
 * A copy of a CID-keyed CFF with its charset rewritten in place as the identity (CID = glyph ID), so a PDF that draws
 * by glyph ID shows the same glyphs in every reader. The identity form (format 0, or one range of format 1 or 2) is
 * never longer than the charset it replaces. @param {Uint8Array} t @param {number} n
 */
export function identityCharset(t, n) {
  const c = parseCff(t, n), p = c.charset, out = new Uint8Array(t);
  n = c.cs.count;
  if (n < 2) return out;
  if (t[p] === 0) { for (let g = 1; g < n; g++) { out[p + 1 + (g - 1) * 2] = g >> 8; out[p + 2 + (g - 1) * 2] = g & 255; } }
  else if (n - 1 <= 256) out.set([1, 0, 1, n - 2], p);
  else out.set([2, 0, 1, (n - 2) >> 8, (n - 2) & 255], p);
  return out;
}
