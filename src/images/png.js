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
 *   again (the PNG heuristic: the row filter with the smallest sum) and deflated, a row at a time: a non-interlaced
 *   image is never held whole (about one strip of rows at a time, plus the compressed output); an interlaced one is
 *   held once, de-interlaced. At most 64 MB decoded by default (embedImage's maxDecodedBytes).
 *
 * The file is HOSTILE: chunk lengths are checked against the file, CRCs are checked, the header's size is capped
 * (each side ≤ 65,535, ≤ 100 megapixels), and the inflated size is computed from the header and enforced while
 * inflating, in 1 KB steps of input (deflate expands at most ~1,032×, so a zip bomb stops within ~1 MB of output).
 * Nothing recurses.
 */
import { Unzlib } from 'fflate';

export const MAX_SIDE = 65535, MAX_PIXELS = 100e6;
/** decoded bytes an image needing decoding (alpha, interlace) may have by default (embedImage's maxDecodedBytes) */
export const MAX_DECODED = 64 << 20;
/** input fed to the inflater at a time: deflate expands ~1,032× at most, so ≤ ~1 MB comes out of each step */
const STEP = 1024;
const NODE_ZLIB = /** @type {any} */ (globalThis).process?.getBuiltinModule?.('node:zlib');
/** inflated bytes up to which node:zlib inflates in one call; ponytail: above, fflate streams, so memory stays flat */
const SYNC_MAX = 32 << 20;
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
 * Inflate the IDAT stream, enforcing exactly `size` bytes out; each piece goes to onData (or is only counted), and
 * after each STEP of input `drain` (if given) is awaited, so a consumer can use what came out before more comes.
 * @param {Uint8Array[]} idat @param {number} size @param {((chunk: Uint8Array, at: number) => void) | null} onData
 * @param {(() => Promise<void>) | null} [drain]
 * @returns {Promise<number>} the length of the zlib stream in the IDAT data (what follows it is not part of the image)
 */
async function inflateExact(idat, size, onData, drain = null) {
  if (NODE_ZLIB && size <= SYNC_MAX) return inflateNode(idat, size, onData, drain);
  let n = 0, done = false, total = 0;
  const z = new Unzlib((chunk, final) => {
    if (n + chunk.length > size) throw new TypeError(`PNG: the image data inflates past the ${size.toLocaleString('en')} bytes its header allows (corrupt, or a zip bomb)`);
    if (onData) onData(chunk, n);
    n += chunk.length;
    if (final) done = true;
  });
  for (let i = 0; i < idat.length; i++) {
    const d = idat[i];
    total += d.length;
    for (let at = 0; at < d.length; at += STEP) {
      try { z.push(d.subarray(at, Math.min(d.length, at + STEP)), i === idat.length - 1 && at + STEP >= d.length); } catch (e) {
        if (e instanceof TypeError && e.message.startsWith('PNG:')) throw e;
        throw new TypeError(`PNG: corrupt image data (${/** @type {Error} */ (e).message})`);
      }
      if (drain) await drain();
    }
  }
  if (!done || n !== size) throw new TypeError(`PNG: truncated image data (${n.toLocaleString('en')} of ${size.toLocaleString('en')} bytes)`);
  // where the zlib stream ends. ponytail: fflate 0.8 (bundled, pinned) keeps the input its inflater has not consumed in
  // z.p, from the byte its bit cursor z.s.p (0–7) is in, after taking the last 4 bytes as the Adler-32; the tests cover
  // it (hostile-review-oct.test.js, F6), so an fflate upgrade that changes it fails there, not silently here
  const rest = /** @type {any} */ (z).p, bit = /** @type {any} */ (z).s?.p;
  if (!(rest instanceof Uint8Array) || typeof bit !== 'number') throw new Error('PNG: internal: the inflater does not report where the zlib stream ends');
  return total - rest.length + (bit ? 1 : 0);
}

/** inflateExact with node:zlib, in one call (maxOutputLength stops a zip bomb at size) @type {typeof inflateExact} */
async function inflateNode(idat, size, onData, drain = null) {
  let total = 0;
  for (const d of idat) total += d.length;
  let src = idat[0];
  if (idat.length > 1) { src = new Uint8Array(total); let at = 0; for (const d of idat) { src.set(d, at); at += d.length; } }
  let r;
  try { r = NODE_ZLIB.inflateSync(src, { info: true, maxOutputLength: Math.max(1, size) }); } catch (e) {
    const code = /** @type {any} */ (e).code;
    if (code === 'ERR_BUFFER_TOO_LARGE') throw new TypeError(`PNG: the image data inflates past the ${size.toLocaleString('en')} bytes its header allows (corrupt, or a zip bomb)`);
    if (code === 'Z_BUF_ERROR') throw new TypeError(`PNG: truncated image data (the zlib stream ends early)`);
    throw new TypeError(`PNG: corrupt image data (${/** @type {Error} */ (e).message})`);
  }
  const out = new Uint8Array(r.buffer.buffer, r.buffer.byteOffset, r.buffer.length);
  if (out.length !== size) throw new TypeError(`PNG: truncated image data (${out.length.toLocaleString('en')} of ${size.toLocaleString('en')} bytes)`);
  if (onData) onData(out, 0);
  if (drain) await drain();
  return r.engine.bytesWritten;
}

/** a callback for inflateExact that checks every row's filter byte (0–4) @param {number} rb row bytes (without it) */
const filterBytes = (rb) => {
  let next = 0;
  return (/** @type {Uint8Array} */ chunk, /** @type {number} */ at) => {
    for (; next < at + chunk.length; next += rb + 1) if (chunk[next - at] > 4) throw new TypeError(`PNG: unknown row filter ${chunk[next - at]}`);
  };
};

/**
 * Undo a row's filter in place. @param {number} f its filter byte @param {Uint8Array} c the row's bytes
 * @param {Uint8Array | null} p the previous row of its pass, unfiltered (null: the first row) @param {number} bpp bytes per pixel (≥ 1)
 */
function unfilterRow(f, c, p, bpp) {
  const rb = c.length;
  if (f > 4) throw new TypeError(`PNG: unknown row filter ${f}`);
  if (f === 0 || (f === 2 && !p)) return;
  if (f === 1 || !p) { // Sub (Average and Paeth on the first row: half / all of a)
    for (let i = bpp; i < rb; i++) c[i] += f === 3 ? c[i - bpp] >> 1 : c[i - bpp];
    return;
  }
  if (f === 2) { for (let i = 0; i < rb; i++) c[i] += p[i]; return; }
  if (f === 3) {
    for (let i = 0; i < bpp; i++) c[i] += p[i] >> 1;
    for (let i = bpp; i < rb; i++) c[i] += (c[i - bpp] + p[i]) >> 1;
    return;
  }
  for (let i = 0; i < bpp; i++) c[i] += p[i]; // Paeth with a = c = 0 is Up
  for (let i = bpp; i < rb; i++) {
    const a = c[i - bpp], u = p[i], cc = p[i - bpp], pp = a + u - cc, pa = Math.abs(pp - a), pb = Math.abs(pp - u), pc = Math.abs(pp - cc);
    c[i] += pa <= pb && pa <= pc ? a : pb <= pc ? u : cc;
  }
}

/**
 * Filter a row again for compression: the filter with the smallest sum of |bytes| (the PNG heuristic), written to
 * out[o] (the filter byte) and out[o + 1 …]. @param {Uint8Array} x the row, unfiltered @param {Uint8Array | null} up
 * the previous row, unfiltered (null: the first) @param {number} bpp @param {Uint8Array} out @param {number} o @param {Uint8Array} t scratch, a row long
 */
export function filterRow(x, up, bpp, out, o, t) {
  const rb = x.length, m = Math.min(bpp, rb);
  // one tight loop per filter; ties go to the lower filter (None, Sub, Up, Paeth). ponytail: Average rarely wins
  let best = 0, sum = 0;
  for (let i = 0; i < rb; i++) { const v = x[i]; sum += v < 128 ? v : 256 - v; }
  out[o] = 0; out.set(x, o + 1);
  best = sum; sum = 0;
  for (let i = 0; i < m; i++) { const v = x[i]; t[i] = v; sum += v < 128 ? v : 256 - v; }
  for (let i = m; i < rb; i++) { const v = (x[i] - x[i - bpp]) & 255; t[i] = v; sum += v < 128 ? v : 256 - v; }
  if (sum < best) { best = sum; out[o] = 1; out.set(t, o + 1); }
  if (!up) return; // Up and Paeth on the first row equal None and Sub
  sum = 0;
  for (let i = 0; i < rb; i++) { const v = (x[i] - up[i]) & 255; t[i] = v; sum += v < 128 ? v : 256 - v; }
  if (sum < best) { best = sum; out[o] = 2; out.set(t, o + 1); }
  sum = 0;
  for (let i = 0; i < m; i++) { const v = (x[i] - up[i]) & 255; t[i] = v; sum += v < 128 ? v : 256 - v; } // Paeth with a = c = 0 is Up
  for (let i = m; i < rb; i++) {
    const a = x[i - bpp], u = up[i], c = up[i - bpp], pa = Math.abs(u - c), pb = Math.abs(a - c), pc = Math.abs(a + u - c - c);
    const v = (x[i] - (pa <= pb && pa <= pc ? a : pb <= pc ? u : c)) & 255; t[i] = v; sum += v < 128 ? v : 256 - v;
  }
  if (sum < best) { out[o] = 4; out.set(t, o + 1); }
}

/**
 * @typedef {{ w: number, h: number, colors: number, bpc: number, abpc: number, space: 'gray' | 'rgb' | 'indexed',
 *   palette: Uint8Array | null, mask: number[] | null }} PngHead
 * @typedef {(color: Uint8Array, alpha: Uint8Array | null) => Promise<void> | void} RowSink
 */

/**
 * The image as XObject parts. Passed through (no alpha, not interlaced): data is the IDAT's zlib stream. Else decoded,
 * a row at a time: rows(each) calls each(colour row, alpha row or null) for every row, top to bottom, unfiltered (the
 * two buffers are reused once its promise settles). Memory: a non-interlaced image is never held whole (the inflated
 * data is unfiltered and handed on row by row as it comes); an interlaced one is de-interlaced into one full image.
 * maxDecoded caps the decoded bytes of an image that is decoded.
 * @param {Png} p @param {number} [maxDecoded]
 * @returns {Promise<PngHead & ({ filtered: true, data: Uint8Array } | { filtered: false, alpha: boolean, rows: (each: RowSink) => Promise<void> })>}
 */
export async function decodePng(p, maxDecoded = MAX_DECODED) {
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
    const n = await inflateExact(p.idat, rawSize(w, h, bits), filterBytes(Math.ceil((w * bits) / 8)));
    const data = new Uint8Array(n); // the zlib stream only: anything after it is dropped
    let at = 0; for (const d of p.idat) { if (at >= n) break; data.set(d.subarray(0, n - at), at); at += d.length; }
    return { ...head, filtered: true, data };
  }

  let size = 0;
  const passes = p.interlace ? ADAM7.map(([x0, y0, dx, dy]) => [Math.ceil((w - x0) / dx), Math.ceil((h - y0) / dy), x0, y0, dx, dy]).filter(([pw, ph]) => pw && ph) : [[w, h, 0, 0, 1, 1]];
  for (const [pw, ph] of passes) size += rawSize(pw, ph, bits);
  const rb = Math.ceil((w * bits) / 8), need = Math.max(size, rb * h);
  if (need > maxDecoded) throw new TypeError(`PNG: ${w} × ${h} needs ${Math.round(need / 1e6)} MB decoded; at most ${Math.round(maxDecoded / 1e6)} MB for an image with alpha or interlacing (embedImage's maxDecodedBytes)`);

  // one full row (unfiltered) → its colour row and alpha row
  const sb = depth >> 3, cb = colors * sb;
  const split = type === 4 || type === 6;
  const color = split ? new Uint8Array(w * cb) : null, alpha = hasAlpha ? new Uint8Array(split ? w * sb : w) : null;
  /** @param {Uint8Array} px a full row @param {RowSink} each */
  const emit = (px, each) => {
    if (!alpha) return each(px, null);
    if (keyAlpha) { // 0 where the pixel is the key colour
      const n = ch * 2;
      for (let i = 0; i < w; i++) {
        let k = 0;
        while (k < n && px[i * n + k] === keyAlpha[k]) k++;
        alpha[i] = k === n ? 0 : 255;
      }
      return each(px, alpha);
    }
    if (palAlpha) { // alpha per palette index
      const max = (1 << depth) - 1;
      for (let x = 0; x < w; x++) { const k = (px[(x * depth) >> 3] >> (8 - depth - ((x * depth) & 7))) & max; alpha[x] = k < palAlpha.length ? palAlpha[k] : 255; }
      return each(px, alpha);
    }
    const c = /** @type {Uint8Array} */ (color); // gray + alpha, RGBA: split the last sample of each pixel off
    for (let i = 0, s = 0, o = 0, a = 0; i < w; i++) {
      for (let k = 0; k < cb; k++) c[o++] = px[s++];
      for (let k = 0; k < sb; k++) alpha[a++] = px[s++];
    }
    return each(c, alpha);
  };

  /** @param {RowSink} each */
  const rows = async (each) => {
    // the inflated bytes are cut into rows as they come: cur (filter byte + bytes) fills, is unfiltered against prev
    /** @type {Uint8Array[]} */
    const pending = [];
    const img = p.interlace ? new Uint8Array(rb * h) : null; // de-interlaced into this, then handed on
    let pass = 0, j = 0, fill = 0, prb = Math.ceil((passes[0][0] * bits) / 8);
    let cur = new Uint8Array(prb + 1), prev = new Uint8Array(prb + 1);
    const drain = async () => {
      for (const chunk of pending.splice(0)) {
        for (let i = 0; i < chunk.length;) {
          const n = Math.min(chunk.length - i, cur.length - fill);
          cur.set(chunk.subarray(i, i + n), fill); fill += n; i += n;
          if (fill < cur.length) break;
          const row = cur.subarray(1);
          unfilterRow(cur[0], row, j ? prev.subarray(1) : null, bpp);
          const [pw, ph, x0, y0, dx, dy] = passes[pass];
          if (!img) await emit(row, each);
          else {
            const dst = (y0 + j * dy) * rb;
            for (let k = 0; k < pw; k++) {
              const x = x0 + k * dx;
              if (bits >= 8) for (let b = 0, from = k * bpp, to = dst + x * bpp; b < bpp; b++) img[to + b] = row[from + b];
              else img[dst + ((x * bits) >> 3)] |= ((row[(k * bits) >> 3] >> (8 - bits - ((k * bits) & 7))) & ((1 << bits) - 1)) << (8 - bits - ((x * bits) & 7));
            }
          }
          [cur, prev] = [prev, cur];
          fill = 0;
          if (++j === ph && ++pass < passes.length) { // the next pass: rows of another width
            j = 0; prb = Math.ceil((passes[pass][0] * bits) / 8);
            cur = new Uint8Array(prb + 1); prev = new Uint8Array(prb + 1);
          }
        }
      }
    };
    await inflateExact(p.idat, size, (chunk) => { pending.push(chunk); }, drain);
    if (img) for (let y = 0; y < h; y++) await emit(img.subarray(y * rb, (y + 1) * rb), each);
  };
  return { ...head, filtered: false, alpha: hasAlpha, rows };
}
