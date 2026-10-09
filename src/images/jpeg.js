// @ts-check
/**
 * JPEG → image XObject, passed through as DCTDecode (never re-encoded). Baseline and progressive (SOF0/1/2), 8-bit,
 * gray / RGB (YCbCr) / CMYK (Adobe's inverted CMYK, flagged by an APP14 "Adobe" segment, gets /Decode [1 0 …]).
 * The EXIF orientation (APP1) is read so page.image can turn the image upright.
 *
 * The file is HOSTILE: the markers are walked up to the first scan (SOS), every segment length is checked against the
 * file and its marker (SOF: 8 + 3 × components), each side is ≤ 65,535 and the image ≤ 100 megapixels, and the EXIF
 * walk reads IFD0 only, its entries bounded by the segment. Arithmetic-coded, lossless, hierarchical and 12-bit
 * JPEGs are refused (PDF readers do not decode them reliably).
 */
import { MAX_PIXELS } from './png.js';

export const isJpeg = (/** @type {Uint8Array} */ b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/**
 * @param {Uint8Array} b @returns {{ w: number, h: number, comps: 1 | 3 | 4, adobe: boolean, orientation: number, end: number }}
 *   end: the byte after the EOI that ends the image data (the file's length without one); what follows is not embedded
 */
export function readJpeg(b) {
  const bad = (/** @type {string} */ m) => new TypeError(`JPEG: ${m}`);
  if (!isJpeg(b)) throw bad('no JPEG signature (FF D8)');
  let pos = 2, w = 0, h = 0, comps = 0, adobe = false, orientation = 1;
  for (;;) {
    if (pos >= b.length) throw bad('truncated before the image data (no SOS marker)');
    if (b[pos] !== 0xff) throw bad(`expected a marker at byte ${pos}`);
    while (pos < b.length && b[pos] === 0xff) pos++; // fill bytes
    if (pos >= b.length) throw bad('truncated');
    const m = b[pos++];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue; // no length
    if (m === 0xd9) throw bad('the image ends (EOI) before any image data');
    if (pos + 2 > b.length) throw bad('truncated inside a marker');
    const len = (b[pos] << 8) | b[pos + 1];
    if (len < 2 || pos + len > b.length) throw bad(`marker FF${m.toString(16).toUpperCase()} claims ${len} bytes, past the end of the file (bogus length)`);
    const s = pos + 2, e = pos + len; // the segment's data
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (comps) throw bad('two frame headers (SOF)');
      if (m > 0xc2) throw bad(`frame type SOF${m - 0xc0} (lossless, hierarchical or arithmetic-coded) is not supported; baseline and progressive are`);
      if (len < 8) throw bad('SOF is too short');
      if (b[s] !== 8) throw bad(`${b[s]}-bit samples; PDF's DCTDecode takes 8-bit JPEGs`);
      h = (b[s + 1] << 8) | b[s + 2]; w = (b[s + 3] << 8) | b[s + 4]; comps = b[s + 5];
      if (len !== 8 + 3 * comps) throw bad(`SOF's length ${len} does not match its ${comps} components`);
      if (comps !== 1 && comps !== 3 && comps !== 4) throw bad(`${comps} components; gray (1), RGB (3) and CMYK (4) are supported`);
      if (!w || !h) throw bad(`${w} × ${h} pixels (a height set later by DNL is not supported)`);
      if (w * h > MAX_PIXELS) throw bad(`${w} × ${h} is over ${MAX_PIXELS / 1e6} megapixels`);
    } else if (m === 0xee && len >= 7 && String.fromCharCode(...b.subarray(s, s + 5)) === 'Adobe') adobe = true;
    else if (m === 0xe1 && len >= 16 && String.fromCharCode(...b.subarray(s, s + 6)) === 'Exif\0\0') orientation = exifOrientation(b, s + 6, e);
    else if (m === 0xda) {
      if (!comps) throw bad('image data (SOS) before the frame header (SOF)');
      return { w, h, comps: /** @type {1 | 3 | 4} */ (comps), adobe, orientation, end: imageEnd(b, e) };
    }
    pos = e;
  }
}

/**
 * Where the image data ends: walks the entropy-coded data from the first scan (FF 00 stuffing, fill bytes and RSTn are
 * data) and the marker segments between scans (their lengths skipped) to the EOI, so an FF D9 inside a segment or
 * appended after the image is never taken for it. @param {Uint8Array} b @param {number} at after the first SOS segment
 */
function imageEnd(b, at) {
  for (let i = b.indexOf(0xff, at); i >= 0 && i + 1 < b.length; i = b.indexOf(0xff, i + 1)) {
    const m = b[i + 1];
    if (m === 0x00 || m === 0xff || (m >= 0xd0 && m <= 0xd7)) continue;
    if (m === 0xd9) return i + 2;
    if (i + 4 > b.length) break;
    i += 1 + ((b[i + 2] << 8) | b[i + 3]); // a segment (DHT, SOS, DQT, DRI, COM, APPn): skip it
  }
  return b.length;
}

/** IFD0's Orientation tag (1–8), else 1; every read inside [t, end) @param {Uint8Array} b @param {number} t the TIFF header @param {number} end */
function exifOrientation(b, t, end) {
  const le = b[t] === 0x49 && b[t + 1] === 0x49;
  if (!le && !(b[t] === 0x4d && b[t + 1] === 0x4d)) return 1;
  const u16 = (/** @type {number} */ i) => (i + 2 <= end ? (le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]) : -1);
  const u32 = (/** @type {number} */ i) => (i + 4 <= end ? (le ? (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + b[i + 3] * 2 ** 24 : b[i] * 2 ** 24 + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3])) : -1);
  const ifd = u32(t + 4);
  if (ifd < 8 || t + ifd + 2 > end) return 1;
  const n = u16(t + ifd);
  for (let i = 0; i < n; i++) {
    const at = t + ifd + 2 + 12 * i;
    if (at + 12 > end) return 1;
    if (u16(at) === 0x0112) { const v = u16(at + 8); return v >= 1 && v <= 8 ? v : 1; }
  }
  return 1;
}
