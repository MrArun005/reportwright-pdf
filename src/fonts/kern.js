// @ts-check
/**
 * Pair kerning: GPOS pair adjustment (lookup type 2, formats 1 and 2, also inside extension lookups, type 9) of the
 * 'kern' feature, else the legacy 'kern' table (version 0, format 0 horizontal subtables). kern(left, right) gives
 * the first glyph's XAdvance change in font units (0 when none). Other GPOS features (mark positioning, cursive
 * attachment) and the second glyph's value record are left to a shaper (embedFont's `shaper` option).
 *
 * HOSTILE input: every count, offset and array is checked against its table when the font is embedded (a lying
 * lookup count or offset fails there, with the kerning source dropped and a warning); lookups and subtables are
 * de-duplicated and capped, checking is bounded by a work budget, and lookups at draw time are binary searches over
 * arrays already checked. No recursion (an extension lookup is followed one level, never to another extension).
 */
const broken = (/** @type {string} */ why) => new TypeError(`Broken font: ${why}`);
/**
 * Subtables an uncached pair may try, in all (GPOS 'kern' lookups, or kern-table subtables): 171 system and bundled fonts
 * have at most 20 (SF Pro Rounded), most under 10, so 64 is never reached by a real font; over it, kerning is off with a
 * warning (4,096 made a pair cost ~11 µs, 40 s for a 10M-character text of distinct pairs).
 */
const MAX_SUBTABLES = 64, BUDGET = 4_000_000;

/** popcount of a ValueFormat's low byte × 2: a ValueRecord's size @param {number} f */
const vsize = (f) => { let n = 0; for (let b = f & 0xff; b; b >>= 1) n += b & 1; return n * 2; };

/**
 * @param {Map<string, Uint8Array>} tables @param {number} numGlyphs @param {(msg: string) => void} warn
 * @returns {((a: number, b: number) => number) | null}
 */
export function kerning(tables, numGlyphs, warn) {
  const gpos = tables.get('GPOS'), kern = tables.get('kern');
  if (gpos) {
    try { const k = gposKerning(gpos); if (k) return memo(k); } catch (e) { warn(`${/** @type {Error} */ (e).message}: GPOS kerning is off`); }
  }
  if (kern) {
    try { const k = kernTable(kern, numGlyphs); if (k) return memo(k); } catch (e) { warn(`${/** @type {Error} */ (e).message}: kern-table kerning is off`); }
  }
  return null;
}

/** pairs looked up once (capped: a long document's pairs do not pile up) @param {(a: number, b: number) => number} k */
function memo(k) {
  const m = new Map();
  return (/** @type {number} */ a, /** @type {number} */ b) => {
    const key = a * 65536 + b;
    let v = m.get(key);
    if (v === undefined) { if (m.size > 65536) m.clear(); m.set(key, v = k(a, b)); }
    return v;
  };
}

/** A checked reader over one table. @param {Uint8Array} t @param {string} name */
function reader(t, name) {
  const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
  let budget = BUDGET;
  /** bytes [p, p + n) are in the table @param {number} p @param {number} n @param {string} what */
  const need = (p, n, what) => {
    if ((budget -= 1 + (n >> 6)) < 0) throw broken(`${name} is too complex to check`);
    if (!(p >= 0 && p + n <= t.length)) throw broken(`${name} ${what} lies outside the table`);
    return p;
  };
  return { dv, need, u16: (/** @type {number} */ p) => dv.getUint16(p), i16: (/** @type {number} */ p) => dv.getInt16(p), u32: (/** @type {number} */ p) => dv.getUint32(p) };
}

/** Coverage table at p → glyph → coverage index or -1 (checked) @param {ReturnType<typeof reader>} r @param {number} p */
function coverage(r, p) {
  const { u16, need } = r;
  need(p, 4, 'a coverage table');
  const f = u16(p), n = u16(p + 2);
  if (f === 1) {
    need(p + 4, n * 2, 'a coverage table');
    return (/** @type {number} */ g) => {
      let lo = 0, hi = n - 1;
      while (lo <= hi) { const mid = (lo + hi) >> 1, v = u16(p + 4 + mid * 2); if (v < g) lo = mid + 1; else if (v > g) hi = mid - 1; else return mid; }
      return -1;
    };
  }
  if (f !== 2) throw broken(`GPOS has a coverage table of format ${f}`);
  need(p + 4, n * 6, 'a coverage table');
  return (/** @type {number} */ g) => {
    let lo = 0, hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, q = p + 4 + mid * 6;
      if (u16(q + 2) < g) lo = mid + 1; else if (u16(q) > g) hi = mid - 1; else return u16(q + 4) + g - u16(q);
    }
    return -1;
  };
}

/** ClassDef table at p → glyph → class (0 when none; checked) @param {ReturnType<typeof reader>} r @param {number} p */
function classDef(r, p) {
  const { u16, need } = r;
  need(p, 4, 'a class definition');
  const f = u16(p);
  if (f === 1) {
    need(p, 6, 'a class definition');
    const start = u16(p + 2), n = u16(p + 4);
    need(p + 6, n * 2, 'a class definition');
    return (/** @type {number} */ g) => (g >= start && g < start + n ? u16(p + 6 + (g - start) * 2) : 0);
  }
  if (f !== 2) throw broken(`GPOS has a class definition of format ${f}`);
  const n = u16(p + 2);
  need(p + 4, n * 6, 'a class definition');
  return (/** @type {number} */ g) => {
    let lo = 0, hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, q = p + 4 + mid * 6;
      if (u16(q + 2) < g) lo = mid + 1; else if (u16(q) > g) hi = mid - 1; else return u16(q + 4);
    }
    return 0;
  };
}

/**
 * One pair-adjustment subtable at p → (a, b) → XAdvance, or undefined when it does not apply (so the next subtable
 * is tried). @param {ReturnType<typeof reader>} r @param {number} p
 */
function pairPos(r, p) {
  const { u16, i16, need } = r;
  need(p, 10, 'a pair adjustment');
  const fmt = u16(p), cov = coverage(r, p + u16(p + 2)), vf1 = u16(p + 4), vf2 = u16(p + 6);
  const s1 = vsize(vf1), rec = s1 + vsize(vf2);
  const xa = vf1 & 4 ? vsize(vf1 & 3) : -1; // XAdvance's place in the first value record, or none
  if (fmt === 1) {
    const n = u16(p + 8);
    need(p + 10, n * 2, 'a pair adjustment');
    for (let i = 0; i < n; i++) { const s = p + u16(p + 10 + i * 2); need(s, 2, 'a pair set'); need(s + 2, u16(s) * (2 + rec), 'a pair set'); }
    return (/** @type {number} */ a, /** @type {number} */ b) => {
      const i = cov(a);
      if (i < 0 || i >= n) return undefined;
      const s = p + u16(p + 10 + i * 2), m = u16(s);
      let lo = 0, hi = m - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1, q = s + 2 + mid * (2 + rec), v = u16(q);
        if (v < b) lo = mid + 1; else if (v > b) hi = mid - 1; else return xa < 0 ? 0 : i16(q + 2 + xa);
      }
      return undefined;
    };
  }
  if (fmt !== 2) throw broken(`GPOS has a pair adjustment of format ${fmt}`);
  need(p, 16, 'a pair adjustment');
  const cd1 = classDef(r, p + u16(p + 8)), cd2 = classDef(r, p + u16(p + 10)), c1 = u16(p + 12), c2 = u16(p + 14);
  need(p + 16, c1 * c2 * rec, 'a class pair adjustment');
  return (/** @type {number} */ a, /** @type {number} */ b) => {
    if (cov(a) < 0) return undefined;
    const k1 = cd1(a), k2 = cd2(b);
    if (k1 >= c1 || k2 >= c2) return 0; // a class past the counts: no adjustment
    return xa < 0 ? 0 : i16(p + 16 + (k1 * c2 + k2) * rec + xa);
  };
}

/** @param {Uint8Array} t */
function gposKerning(t) {
  const r = reader(t, 'GPOS'), { u16, u32, need } = r;
  need(0, 10, 'header');
  if (u16(0) !== 1) throw broken(`GPOS version ${u16(0)}`);
  const fl = need(u16(6), 2, 'feature list'), ll = need(u16(8), 2, 'lookup list');
  const nf = u16(fl), nl = u16(ll);
  need(fl + 2, nf * 6, 'feature list');
  need(ll + 2, nl * 2, 'lookup list');
  /** @type {Set<number>} the 'kern' features' lookups, in lookup order */
  const ids = new Set();
  for (let i = 0; i < nf; i++) {
    const rec = fl + 2 + i * 6;
    if (String.fromCharCode(t[rec], t[rec + 1], t[rec + 2], t[rec + 3]) !== 'kern') continue;
    const f = need(fl + u16(rec + 4), 4, 'a feature'), n = u16(f + 2);
    need(f + 4, n * 2, 'a feature');
    for (let k = 0; k < n; k++) {
      const li = u16(f + 4 + k * 2);
      if (li >= nl) throw broken(`GPOS 'kern' names lookup ${li}, past the ${nl} lookups`);
      ids.add(li);
    }
  }
  /** @type {((a: number, b: number) => number | undefined)[][]} per lookup, its subtables */
  const lookups = [];
  /** @type {Map<number, any>} subtables already read, by offset */
  const seen = new Map();
  let total = 0;
  for (const li of [...ids].sort((a, b) => a - b)) {
    const L = need(ll + u16(ll + 2 + li * 2), 6, 'a lookup'), type = u16(L), n = u16(L + 4);
    if (type !== 2 && type !== 9) continue;
    need(L + 6, n * 2, 'a lookup');
    const subs = [];
    for (let k = 0; k < n; k++) {
      if (++total > MAX_SUBTABLES) throw broken(`GPOS kerning has more than ${MAX_SUBTABLES} subtables`);
      let s = L + u16(L + 6 + k * 2);
      if (type === 9) { // extension: format 1, the real type, a 32-bit offset from here
        need(s, 8, 'an extension lookup');
        if (u16(s) !== 1 || u16(s + 2) !== 2) continue;
        s += u32(s + 4);
      }
      if (!seen.has(s)) seen.set(s, pairPos(r, s));
      subs.push(seen.get(s));
    }
    if (subs.length) lookups.push(subs);
  }
  if (!lookups.length) return null;
  return (/** @type {number} */ a, /** @type {number} */ b) => {
    let v = 0;
    for (const subs of lookups) for (const f of subs) { const x = f(a, b); if (x !== undefined) { v += x; break; } }
    return v;
  };
}

/** the legacy kern table (version 0; format 0 horizontal subtables, minimum and cross-stream ones skipped) @param {Uint8Array} t @param {number} numGlyphs */
function kernTable(t, numGlyphs) {
  const r = reader(t, 'kern'), { u16, i16, need } = r;
  need(0, 4, 'header');
  if (u16(0) !== 0) return null; // Apple's version 1 is not read
  const n = u16(2);
  /** @type {[number, number][]} pairs' start and count */
  const subs = [];
  let p = 4;
  for (let i = 0; i < n && p < t.length; i++) {
    if (i >= MAX_SUBTABLES) throw broken(`kern has more than ${MAX_SUBTABLES} subtables`);
    need(p, 6, 'a subtable');
    const len = u16(p + 2), cov = u16(p + 4);
    if (cov >> 8 === 0 && (cov & 7) === 1) {
      need(p + 6, 8, 'a subtable');
      const np = u16(p + 6);
      need(p + 14, np * 6, 'a subtable'); // sized by its pairs: the 16-bit length is often wrong in big fonts
      subs.push([p + 14, np]);
      p += 14 + np * 6;
    } else {
      if (len < 6) throw broken('kern has a subtable shorter than its header');
      p += len;
    }
  }
  if (!subs.length || numGlyphs < 2) return null;
  return (/** @type {number} */ a, /** @type {number} */ b) => {
    const key = a * 65536 + b;
    let v = 0;
    for (const [s, np] of subs) {
      let lo = 0, hi = np - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1, q = s + mid * 6, k = u16(q) * 65536 + u16(q + 2);
        if (k < key) lo = mid + 1; else if (k > key) hi = mid - 1; else { v += i16(q + 4); break; }
      }
    }
    return v;
  };
}
