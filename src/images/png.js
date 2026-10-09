// @ts-check
/**
 * PNG → image XObject parts. Every colour type (gray, RGB, palette, gray + alpha, RGBA), bit depths 1/2/4/8/16,
 * Adam7 interlacing, tRNS.
 *
 * - No alpha and not interlaced (gray, RGB, palette): the IDAT data is passed through as FlateDecode with the PNG
 *   predictor (it is still inflated once, counting bytes and checking each row's filter byte, to check it; anything
 *   after the zlib stream is dropped). tRNS on gray/RGB becomes a colour-key
 *   /Mask; palettes are padded to 2^depth entries so no index can fall outside.
 * - Alpha (gray + alpha, RGBA, a palette with tRNS) or interlaced: decoded, split into colour and an /SMask, filtered
 *   again (the PNG heuristic: the row filter with the smallest sum) and deflated.
 *
 * The file is HOSTILE: chunk lengths are checked against the file, CRCs are checked, the header's size is capped
 * (each side ≤ 65,535, ≤ 100 megapixels), and the inflated size is computed from the header and enforced while
 * inflating, in 8 KB steps of input (deflate expands at most ~1,032×, so a zip bomb stops within ~8 MB of output).
 * Nothing recurses.
 */
import { Unzlib } from 'fflate';

export const MAX_SIDE = 65535, MAX_PIXELS = 100e6;
/** decoded bytes an image needing decoding (alpha, interlace) may hold: 100 MP of 8-bit RGBA */
const MAX_DECODED = 400e6;
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
// Adam7: x0, y0, dx, dy per pass
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

let CRC_TABLE = /** @type {Uint32Array | null} */ (null);
/** @param {Uint8Array} b @param {number} from @param {number} to */
function crc32(b, from, to) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export const isPng = (/** @type {Uint8Array} */ b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a;

/** bytes of an inflated image of w × h pixels at bits per pixel, with a filter byte per row @param {number} w @param {number} h @param {number} bits */
const rawSize = (w, h, bits) => (w && h ? h * (1 + Math.ceil((w * bits) / 8)) : 0);

/**
 * @typedef {{ w: number, h: number, depth: number, type: number, interlace: boolean, palette: Uint8Array | null,
 *   trns: Uint8Array | null, idat: Uint8Array[] }} Png
 * @param {Uint8Array} b @returns {Png}
 */
export function readPng(b) {
  const bad = (/** @type {string} */ m) => new TypeError(`PNG: ${m}`);
  if (!isPng(b)) throw bad('no PNG signature');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  /** @type {Png | null} */
  let png = null;
  let pos = 8, ended = false;
  while (!ended) {
    if (pos + 12 > b.length) throw bad('truncated (the file ends inside a chunk, before IEND)');
    const len = dv.getUint32(pos), type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
    if (len > 0x7fffffff || pos + 12 + len > b.length) throw bad(`truncated or corrupt: the ${JSON.stringify(type)} chunk claims ${len} bytes, past the end of the file`);
    if (!/^[A-Za-z]{4}$/.test(type)) throw bad('corrupt chunk type');
    const data = b.subarray(pos + 8, pos + 8 + len);
    if (crc32(b, pos + 4, pos + 8 + len) !== dv.getUint32(pos + 8 + len)) throw bad(`bad CRC in the ${type} chunk`);
    pos += 12 + len;
    if (!png && type !== 'IHDR') throw bad('IHDR is not the first chunk');
    if (type === 'IHDR') {
      if (png) throw bad('two IHDR chunks');
      if (len !== 13) throw bad('IHDR is 13 bytes');
      const w = dv.getUint32(pos - len - 4), h = dv.getUint32(pos - len), depth = data[8], ctype = data[9];
      if (!(w >= 1 && h >= 1 && w <= MAX_SIDE && h <= MAX_SIDE)) throw bad(`${w} × ${h} pixels: each side is 1–${MAX_SIDE}`);
      if (w * h > MAX_PIXELS) throw bad(`${w} × ${h} is over ${MAX_PIXELS / 1e6} megapixels`);
      const ok = /** @type {Record<number, number[]>} */ (DEPTHS)[ctype];
      if (!ok) throw bad(`colour type ${ctype} does not exist (0, 2, 3, 4, 6)`);
      if (!ok.includes(depth)) throw bad(`bit depth ${depth} is not allowed with colour type ${ctype} (${ok.join(', ')})`);
      if (data[10] !== 0 || data[11] !== 0 || data[12] > 1) throw bad('unknown compression, filter or interlace method');
      png = { w, h, depth, type: ctype, interlace: data[12] === 1, palette: null, trns: null, idat: [] };
    } else if (type === 'PLTE') {
      if (len % 3 || len === 0 || len > 768) throw bad('PLTE is 1–256 RGB entries');
      png.palette = data;
    } else if (type === 'tRNS') {
      const need = png.type === 0 ? 2 : png.type === 2 ? 6 : -1;
      if (png.type === 3 ? !png.palette || len > png.palette.length / 3 : len !== need) throw bad('tRNS does not fit the colour type');
      png.trns = data;
    } else if (type === 'IDAT') png.idat.push(data);
    else if (type === 'IEND') ended = true;
  }
  if (!png) throw bad('no IHDR');
  if (png.type === 3 && !png.palette) throw bad('a palette image without PLTE');
  if (!png.idat.length) throw bad('no image data (IDAT)');
  return png;
}

/**
 * Inflate the IDAT stream, enforcing exactly `size` bytes out; each piece goes to onData (or is only counted).
 * @param {Uint8Array[]} idat @param {number} size @param {((chunk: Uint8Array, at: number) => void) | null} onData
 * @returns {number} the length of the zlib stream in the IDAT data (what follows it is not part of the image)
 */
function inflateExact(idat, size, onData) {
  let n = 0, done = false, total = 0;
  const z = new Unzlib((chunk, final) => {
    if (n + chunk.length > size) throw new TypeError(`PNG: the image data inflates past the ${size.toLocaleString('en')} bytes its header allows (corrupt, or a zip bomb)`);
    if (onData) onData(chunk, n);
    n += chunk.length;
    if (final) done = true;
  });
  try {
    for (let i = 0; i < idat.length; i++) {
      const d = idat[i];
      total += d.length;
      for (let at = 0; at < d.length; at += 8192) z.push(d.subarray(at, Math.min(d.length, at + 8192)), i === idat.length - 1 && at + 8192 >= d.length);
    }
  } catch (e) {
    if (e instanceof TypeError && e.message.startsWith('PNG:')) throw e;
    throw new TypeError(`PNG: corrupt image data (${/** @type {Error} */ (e).message})`);
  }
  if (!done || n !== size) throw new TypeError(`PNG: truncated image data (${n.toLocaleString('en')} of ${size.toLocaleString('en')} bytes)`);
  // where the zlib stream ends. ponytail: fflate 0.8 (bundled, pinned) keeps the input its inflater has not consumed in
  // z.p, from the byte its bit cursor z.s.p (0–7) is in, after taking the last 4 bytes as the Adler-32; the tests cover
  // it (hostile-review-oct.test.js, F6), so an fflate upgrade that changes it fails there, not silently here
  const rest = /** @type {any} */ (z).p, bit = /** @type {any} */ (z).s?.p;
  if (!(rest instanceof Uint8Array) || typeof bit !== 'number') throw new Error('PNG: internal: the inflater does not report where the zlib stream ends');
  return total - rest.length + (bit ? 1 : 0);
}

/** a callback for inflateExact that checks every row's filter byte (0–4) @param {number} rb row bytes (without it) */
const filterBytes = (rb) => {
  let next = 0;
  return (/** @type {Uint8Array} */ chunk, /** @type {number} */ at) => {
    for (; next < at + chunk.length; next += rb + 1) if (chunk[next - at] > 4) throw new TypeError(`PNG: unknown row filter ${chunk[next - at]}`);
  };
};

/** undo the row filters in place: raw is rows of [filter byte, ...bytes] @param {Uint8Array} raw @param {number} at @param {number} rows @param {number} rb row bytes @param {number} bpp bytes per pixel (≥ 1) */
function unfilter(raw, at, rows, rb, bpp) {
  for (let y = 0; y < rows; y++) {
    const r = at + y * (rb + 1) + 1, f = raw[r - 1], p = r - rb - 1; // r: this row's first byte, p: the previous row's
    if (f > 4) throw new TypeError(`PNG: unknown row filter ${f}`);
    if (f === 0 || (f === 2 && !y)) continue;
    if (f === 1 || (f === 3 && !y) || (f === 4 && !y)) { // Sub (Average and Paeth on the first row: half / all of a)
      for (let i = bpp; i < rb; i++) raw[r + i] += f === 3 ? raw[r + i - bpp] >> 1 : raw[r + i - bpp];
      continue;
    }
    if (f === 2) { for (let i = 0; i < rb; i++) raw[r + i] += raw[p + i]; continue; }
    if (f === 3) {
      for (let i = 0; i < bpp; i++) raw[r + i] += raw[p + i] >> 1;
      for (let i = bpp; i < rb; i++) raw[r + i] += (raw[r + i - bpp] + raw[p + i]) >> 1;
      continue;
    }
    for (let i = 0; i < bpp; i++) raw[r + i] += raw[p + i]; // Paeth with a = c = 0 is Up
    for (let i = bpp; i < rb; i++) {
      const a = raw[r + i - bpp], u = raw[p + i], c = raw[p + i - bpp], pp = a + u - c, pa = Math.abs(pp - a), pb = Math.abs(pp - u), pc = Math.abs(pp - c);
      raw[r + i] += pa <= pb && pa <= pc ? a : pb <= pc ? u : c;
    }
  }
}

/** filter rows again for compression (each row: the filter with the smallest sum of |bytes|) @param {Uint8Array} px rows without filter bytes @param {number} rows @param {number} rb @param {number} bpp */
export function filterRows(px, rows, rb, bpp) {
  const out = new Uint8Array(rows * (rb + 1)), t = new Uint8Array(rb);
  for (let y = 0; y < rows; y++) {
    const r = y * rb, o = y * (rb + 1);
    let best = -1, bestSum = Infinity;
    for (let f = 0; f <= 4; f++) {
      if (f === 3) continue; // ponytail: Average rarely wins; None, Sub, Up, Paeth
      let sum = 0;
      for (let i = 0; i < rb; i++) {
        const x = px[r + i], a = i >= bpp ? px[r + i - bpp] : 0, u = y ? px[r - rb + i] : 0, c = y && i >= bpp ? px[r - rb + i - bpp] : 0;
        let p = 0;
        if (f === 1) p = a; else if (f === 2) p = u;
        else if (f === 4) { const pp = a + u - c, pa = Math.abs(pp - a), pb = Math.abs(pp - u), pc = Math.abs(pp - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? u : c; }
        const v = (x - p) & 255;
        t[i] = v; sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; best = f; out.set(t, o + 1); out[o] = f; }
    }
    void best;
  }
  return out;
}

/**
 * The image as XObject parts: color (passthrough: the IDAT bytes; else rows to filter), its dictionary entries, and an
 * alpha channel when there is one. @param {Png} p
 * @returns {{ w: number, h: number, colors: number, bpc: number, abpc: number, space: 'gray' | 'rgb' | 'indexed', palette: Uint8Array | null,
 *   mask: number[] | null, data: Uint8Array, filtered: boolean, alpha: Uint8Array | null }}
 *   data: the IDAT zlib stream (filtered = true, passed through) or unfiltered pixel rows (filtered = false); alpha: unfiltered rows of alpha samples
 */
export function decodePng(p) {
  const { w, h, depth, type } = p;
  const ch = /** @type {Record<number, number>} */ (CHANNELS)[type], bits = ch * depth, bpp = Math.max(1, bits >> 3);
  const colors = type === 0 || type === 4 ? 1 : type === 3 ? 1 : 3;
  const space = type === 3 ? 'indexed' : colors === 1 ? 'gray' : 'rgb';
  const palAlpha = type === 3 && p.trns ? p.trns : null;
  // a 16-bit colour key becomes an SMask: poppler ignores 16-bit /Mask ranges
  const keyAlpha = p.trns && (type === 0 || type === 2) && depth === 16 ? p.trns : null;
  const hasAlpha = type === 4 || type === 6 || !!palAlpha || !!keyAlpha;
  let mask = null;
  if (p.trns && (type === 0 || type === 2) && depth <= 8) {
    const max = (1 << depth) - 1;
    mask = [];
    for (let i = 0; i < p.trns.length; i += 2) { const v = Math.min(max, (p.trns[i] << 8) | p.trns[i + 1]); mask.push(v, v); }
  }
  const head = { w, h, colors, bpc: depth, abpc: palAlpha || keyAlpha ? 8 : depth, space: /** @type {'gray' | 'rgb' | 'indexed'} */ (space), palette: p.palette, mask };

  if (!hasAlpha && !p.interlace) { // passthrough, checked by inflating once (counting, and checking each row's filter)
    const n = inflateExact(p.idat, rawSize(w, h, bits), filterBytes(Math.ceil((w * bits) / 8)));
    const data = new Uint8Array(n); // the zlib stream only: anything after it is dropped
    let at = 0; for (const d of p.idat) { if (at >= n) break; data.set(d.subarray(0, n - at), at); at += d.length; }
    return { ...head, data, filtered: true, alpha: null };
  }

  // decode: inflate, unfilter (per pass when interlaced), then de-interlace into full rows
  let size = 0;
  const passes = p.interlace ? ADAM7.map(([x0, y0, dx, dy]) => [Math.ceil((w - x0) / dx), Math.ceil((h - y0) / dy), x0, y0, dx, dy]) : [[w, h, 0, 0, 1, 1]];
  for (const [pw, ph] of passes) size += rawSize(pw, ph, bits);
  const rb = Math.ceil((w * bits) / 8);
  if (size > MAX_DECODED || rb * h > MAX_DECODED) throw new TypeError(`PNG: ${w} × ${h} needs ${Math.round(Math.max(size, rb * h) / 1e6)} MB decoded; at most ${MAX_DECODED / 1e6} MB for an image with alpha or interlacing`);
  const raw = new Uint8Array(size);
  inflateExact(p.idat, size, (chunk, at) => raw.set(chunk, at));
  let px;
  if (!p.interlace) {
    unfilter(raw, 0, h, rb, bpp);
    px = new Uint8Array(rb * h);
    for (let y = 0; y < h; y++) px.set(raw.subarray(y * (rb + 1) + 1, (y + 1) * (rb + 1)), y * rb);
  } else {
    px = new Uint8Array(rb * h);
    let at = 0;
    for (const [pw, ph, x0, y0, dx, dy] of passes) {
      if (!pw || !ph) continue;
      const prb = Math.ceil((pw * bits) / 8);
      unfilter(raw, at, ph, prb, bpp);
      for (let j = 0; j < ph; j++) {
        const src = at + j * (prb + 1) + 1, dst = (y0 + j * dy) * rb;
        for (let i = 0; i < pw; i++) {
          const x = x0 + i * dx;
          if (bits >= 8) for (let k = 0, from = src + i * bpp, to = dst + x * bpp; k < bpp; k++) px[to + k] = raw[from + k];
          else { // 1, 2, 4 bits: one sample per pixel
            const v = (raw[src + ((i * bits) >> 3)] >> (8 - bits - ((i * bits) & 7))) & ((1 << bits) - 1);
            px[dst + ((x * bits) >> 3)] |= v << (8 - bits - ((x * bits) & 7));
          }
        }
      }
      at += rawSize(pw, ph, bits);
    }
  }
  if (!hasAlpha) return { ...head, data: px, filtered: false, alpha: null };
  if (keyAlpha) { // 0 where the pixel is the key colour
    const alpha = new Uint8Array(w * h).fill(255), n = ch * 2;
    for (let i = 0; i < w * h; i++) {
      let k = 0;
      while (k < n && px[i * n + k] === keyAlpha[k]) k++;
      if (k === n) alpha[i] = 0;
    }
    return { ...head, data: px, filtered: false, alpha };
  }
  if (palAlpha) { // alpha per palette index
    const alpha = new Uint8Array(w * h), max = (1 << depth) - 1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = (px[y * rb + ((x * depth) >> 3)] >> (8 - depth - ((x * depth) & 7))) & max;
      alpha[y * w + x] = k < palAlpha.length ? palAlpha[k] : 255;
    }
    return { ...head, data: px, filtered: false, alpha };
  }
  // gray + alpha, RGBA: split the last sample of each pixel off
  const sb = depth >> 3, cb = colors * sb, color = new Uint8Array(w * h * cb), alpha = new Uint8Array(w * h * sb);
  for (let i = 0, n = w * h, s = 0, c = 0, a = 0; i < n; i++) {
    for (let k = 0; k < cb; k++) color[c++] = px[s++];
    for (let k = 0; k < sb; k++) alpha[a++] = px[s++];
  }
  return { ...head, data: color, filtered: false, alpha };
}
