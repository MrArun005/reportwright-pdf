// @ts-check
/**
 * Stream filters, decoded under the document's budget: FlateDecode (zlib, or raw deflate when the header is bad),
 * LZWDecode, ASCII85Decode, ASCIIHexDecode, RunLengthDecode, and the PNG and TIFF predictors. Each decoder counts its
 * output as it makes it (budget.take: per stream and for the document), so a 1 KB stream that would inflate to 10 GB
 * stops at the cap. Image codecs (DCTDecode, JPXDecode, JBIG2Decode, CCITTFaxDecode) are not decoded: the data is left
 * as it is from that filter on (`done` false), which is what copying needs.
 *
 * Corrupt data gives what decoded before the damage (as viewers show it); a cap is an error (PdfReadError E_BUDGET).
 * Data no decoder makes (an unfiltered stream, an image codec's input) is counted too, each time it is decoded: a
 * stream used 100,000 times is 100,000 times its bytes against maxDecoded, filtered or not.
 */
import { Unzlib, Inflate } from 'fflate';
import { fail } from './budget.js';

const PASS = new Set(['DCTDecode', 'DCT', 'JPXDecode', 'JBIG2Decode', 'CCITTFaxDecode', 'CCF']);
const CHUNK = 16384;
export const MAX_FILTERS = 16;

/** grows as output comes, checked against the budget @param {import('./budget.js').Budget} budget */
function sinkOf(budget) {
  /** @type {Uint8Array[]} */
  const parts = [];
  let n = 0;
  return {
    get n() { return n; },
    /** @param {Uint8Array} c */
    push(c) { if (!c.length) return; budget.take(c.length, n); parts.push(c); n += c.length; },
    out() { if (parts.length === 1) return parts[0]; const o = new Uint8Array(n); let at = 0; for (const p of parts) { o.set(p, at); at += p.length; } return o; },
  };
}

/** @param {Uint8Array} data @param {import('./budget.js').Budget} budget */
export function flate(data, budget) {
  const run = (/** @type {any} */ Z) => {
    const s = sinkOf(budget);
    const z = new Z((/** @type {Uint8Array} */ c) => s.push(c));
    let ok = true;
    try {
      for (let at = 0; at < data.length; at += CHUNK) z.push(data.subarray(at, Math.min(data.length, at + CHUNK)), at + CHUNK >= data.length);
      if (!data.length) z.push(new Uint8Array(0), true);
    } catch (e) {
      if (/** @type {any} */ (e)?.name === 'PdfReadError') throw e;
      ok = false; // corrupt or truncated: what came out before it
    }
    return { out: s.out(), ok, n: s.n };
  };
  const r = run(Unzlib);
  if (r.ok || r.n) return r.out;
  return run(Inflate).out; // no zlib header (or a bad one): raw deflate, as some writers make
}

/** @param {Uint8Array} data @param {import('./budget.js').Budget} budget @param {number} early EarlyChange */
export function lzw(data, budget, early) {
  const s = sinkOf(budget);
  const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), len = new Int32Array(4096);
  for (let i = 0; i < 256; i++) { prefix[i] = -1; suffix[i] = i; len[i] = 1; }
  let next = 258, width = 9, prev = -1, bits = 0, acc = 0;
  let buf = new Uint8Array(CHUNK), bn = 0;
  const flush = () => { s.push(buf.slice(0, bn)); bn = 0; };
  const tmp = new Uint8Array(4096);
  const emit = (/** @type {number} */ code) => {
    let l = len[code], c = code;
    for (let k = l - 1; k >= 0; k--) { tmp[k] = suffix[c]; c = prefix[c]; }
    if (bn + l > buf.length) flush();
    buf.set(tmp.subarray(0, l), bn); bn += l;
    return tmp[0];
  };
  for (let i = 0; i < data.length; i++) {
    acc = (acc << 8) | data[i]; bits += 8;
    while (bits >= width) {
      const code = (acc >>> (bits - width)) & ((1 << width) - 1);
      bits -= width; acc &= (1 << bits) - 1;
      if (code === 256) { next = 258; width = 9; prev = -1; continue; }
      if (code === 257) { flush(); return s.out(); }
      if (prev < 0) { if (code > 255) { flush(); return s.out(); } emit(code); prev = code; continue; }
      let first;
      if (code < next) first = emit(code);
      else if (code === next) { const f = emit(prev); if (bn + 1 > buf.length) flush(); buf[bn++] = f; first = f; }
      else { flush(); return s.out(); } // corrupt
      if (next < 4096) { prefix[next] = prev; suffix[next] = first; len[next] = len[prev] + 1; next++; }
      if (next + early >= (1 << width) && width < 12) width++;
      prev = code;
    }
    if ((i & 4095) === 0) budget.tick();
  }
  flush();
  return s.out();
}

/** @param {Uint8Array} data @param {import('./budget.js').Budget} budget */
export function ascii85(data, budget) {
  const out = new Uint8Array(Math.ceil(data.length * 4 / 5) + 4);
  let n = 0, k = 0, v = 0;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === 0x7e) break; // ~>
    if (c <= 32) continue;
    if (c === 0x7a && k === 0) { n += 4; continue; } // z: four zeros (out is zero-filled)
    if (c < 0x21 || c > 0x75) continue;
    v = v * 85 + (c - 33); k++;
    if (k === 5) { out[n++] = v >>> 24; out[n++] = (v >>> 16) & 255; out[n++] = (v >>> 8) & 255; out[n++] = v & 255; k = 0; v = 0; }
    if (n + 4 > out.length) break;
  }
  if (k > 1) { for (let j = k; j < 5; j++) v = v * 85 + 84; for (let j = 0; j < k - 1; j++) out[n++] = (v >>> (24 - 8 * j)) & 255; }
  budget.take(n, 0);
  return out.subarray(0, n);
}

/** @param {Uint8Array} data @param {import('./budget.js').Budget} budget */
export function asciiHex(data, budget) {
  const out = new Uint8Array((data.length >> 1) + 1);
  let n = 0, hi = -1;
  for (const c of data) {
    if (c === 0x3e) break;
    const h = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 55 : c >= 0x61 && c <= 0x66 ? c - 87 : -1;
    if (h < 0) continue;
    if (hi < 0) hi = h; else { out[n++] = (hi << 4) | h; hi = -1; }
  }
  if (hi >= 0) out[n++] = hi << 4;
  budget.take(n, 0);
  return out.subarray(0, n);
}

/** @param {Uint8Array} data @param {import('./budget.js').Budget} budget */
export function runLength(data, budget) {
  const s = sinkOf(budget);
  let buf = new Uint8Array(CHUNK), bn = 0;
  for (let i = 0; i < data.length;) {
    const L = data[i++];
    if (L === 128) break;
    const run = L < 128 ? Math.min(L + 1, data.length - i) : 257 - L;
    if (bn + run > buf.length) { s.push(buf.slice(0, bn)); bn = 0; }
    if (L < 128) { buf.set(data.subarray(i, i + run), bn); i += run; }
    else { if (i >= data.length) break; buf.fill(data[i++], bn, bn + run); }
    bn += run;
  }
  s.push(buf.slice(0, bn));
  return s.out();
}

/**
 * The PNG (10–15) or TIFF (2) predictor, undone. Output is never larger than input. @param {Uint8Array} data
 * @param {Map<string, any> | null} parms @param {import('./budget.js').Budget} budget
 */
export function predictor(data, parms, budget) {
  const P = num(parms?.get('Predictor'), 1);
  if (P <= 1) return data;
  const colors = clamp(num(parms?.get('Colors'), 1), 1, 32), bpc = [1, 2, 4, 8, 16].includes(num(parms?.get('BitsPerComponent'), 8)) ? num(parms?.get('BitsPerComponent'), 8) : 8;
  const cols = clamp(num(parms?.get('Columns'), 1), 1, 1 << 24);
  const bpp = Math.max(1, (colors * bpc) >> 3), rb = Math.ceil((colors * bpc * cols) / 8);
  if (P === 2) { // TIFF: horizontal differencing (8-bit only; others passed through)
    if (bpc !== 8) return data;
    const out = data.slice();
    for (let r = 0; r + rb <= out.length; r += rb) for (let i = bpp; i < rb; i++) out[r + i] = (out[r + i] + out[r + i - bpp]) & 255;
    budget.tick(1 + (out.length >> 12));
    return out;
  }
  if (P < 10) return data;
  const rows = Math.floor(data.length / (rb + 1));
  const out = new Uint8Array(rows * rb);
  for (let y = 0; y < rows; y++) {
    const f = data[y * (rb + 1)], src = y * (rb + 1) + 1, r = y * rb, p = r - rb;
    for (let i = 0; i < rb; i++) {
      const x = data[src + i], a = i >= bpp ? out[r + i - bpp] : 0, u = y ? out[p + i] : 0, c = y && i >= bpp ? out[p + i - bpp] : 0;
      let v = x;
      if (f === 1) v = x + a; else if (f === 2) v = x + u; else if (f === 3) v = x + ((a + u) >> 1);
      else if (f === 4) { const pp = a + u - c, pa = Math.abs(pp - a), pb = Math.abs(pp - u), pc = Math.abs(pp - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? u : c); }
      out[r + i] = v & 255;
    }
    if ((y & 255) === 0) budget.tick();
  }
  return out;
}
const num = (/** @type {any} */ v, /** @type {number} */ d) => (typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : d);
const clamp = (/** @type {number} */ v, /** @type {number} */ a, /** @type {number} */ b) => Math.min(b, Math.max(a, v));

/**
 * Decode data through filters (a name or an array) with their parms. `done` false: an image codec is left undone.
 * @param {Uint8Array} data @param {any} filters @param {any} parms @param {import('./budget.js').Budget} budget
 * @param {(v: any) => any} resolve @returns {{ data: Uint8Array, done: boolean, filter: string | null }}
 */
export function decode(data, filters, parms, budget, resolve) {
  const fs = Array.isArray(filters) ? filters.map(resolve) : filters == null ? [] : [filters];
  const ps = Array.isArray(parms) ? parms.map(resolve) : [parms];
  if (fs.length > MAX_FILTERS) fail('E_MALFORMED', `A stream has more than ${MAX_FILTERS} filters`);
  let made = false; // a decoder counted what it made; data no decoder made (no filter, Crypt, an image codec) is counted here
  for (let i = 0; i < fs.length; i++) {
    const f = fs[i], p = ps[i] instanceof Map ? ps[i] : null;
    if (typeof f !== 'string') fail('E_MALFORMED', 'A stream filter is not a name');
    if (PASS.has(f)) { if (!made) budget.take(data.length, 0); return { data, done: false, filter: f }; }
    if (f !== 'Crypt') made = true;
    if (f === 'FlateDecode' || f === 'Fl') data = predictor(flate(data, budget), p, budget);
    else if (f === 'LZWDecode' || f === 'LZW') data = predictor(lzw(data, budget, num(p?.get('EarlyChange'), 1) ? 1 : 0), p, budget);
    else if (f === 'ASCII85Decode' || f === 'A85') data = ascii85(data, budget);
    else if (f === 'ASCIIHexDecode' || f === 'AHx') data = asciiHex(data, budget);
    else if (f === 'RunLengthDecode' || f === 'RL') data = runLength(data, budget);
    else if (f === 'Crypt') continue; // handled by the reader (Identity, or the document's filter)
    else fail('E_UNSUPPORTED', `Unknown stream filter /${f.slice(0, 40)}`);
  }
  if (!made) budget.take(data.length, 0); // every use of a stream counts against maxDecoded, filtered or not
  return { data, done: true, filter: null };
}
