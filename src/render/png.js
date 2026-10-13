// @ts-check
/** A rendered page → PNG bytes (8-bit RGBA, zlib through the bundled fflate), and → a canvas ImageData in browsers. */
import { fflate } from '../core/lazy.js';

const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c >>> 0;
}
/** @param {Uint8Array} b @param {number} s @param {number} e */
const crc32 = (b, s, e) => {
  let c = ~0;
  for (let i = s; i < e; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
};

/**
 * PNG bytes of a renderPage result. @param {{ width: number, height: number, data: Uint8ClampedArray }} img
 * @param {{ level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 }} [o] the deflate level (6)
 */
export async function toPng(img, o = {}) {
  const { width: w, height: h, data } = img;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || !data || data.length !== w * h * 4)
    throw new TypeError('toPng: { width, height, data } with data.length = width × height × 4');
  const raw = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) raw.set(data.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1); // filter 0
  const z = (await fflate()).zlibSync(raw, { level: o.level ?? 6 });
  const chunks = [
    ['IHDR', Uint8Array.of(w >>> 24, w >>> 16, w >>> 8, w, h >>> 24, h >>> 16, h >>> 8, h, 8, 6, 0, 0, 0)],
    ['IDAT', z],
    ['IEND', new Uint8Array(0)],
  ];
  const out = new Uint8Array(8 + chunks.reduce((n, [, d]) => n + 12 + d.length, 0));
  out.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const v = new DataView(out.buffer);
  let p = 8;
  for (const [t, d] of /** @type {[string, Uint8Array][]} */ (chunks)) {
    v.setUint32(p, d.length);
    for (let i = 0; i < 4; i++) out[p + 4 + i] = t.charCodeAt(i);
    out.set(d, p + 8);
    v.setUint32(p + 8 + d.length, crc32(out, p + 4, p + 8 + d.length));
    p += 12 + d.length;
  }
  return out;
}

/** draw a renderPage result on a canvas 2D context (browsers, OffscreenCanvas) at x, y @param {any} ctx @param {{ width: number, height: number, data: Uint8ClampedArray }} img */
export function drawToCanvas(ctx, img, x = 0, y = 0) {
  ctx.putImageData(new ImageData(img.data, img.width, img.height), x, y);
}
