// @ts-check
/**
 * Public font reading: readFont (the metrics and cmap of a font file) and checkSubset (whether a subset is safe to
 * embed). Both build on truetype.js's parseFont and on their own bounds-checked reads. Input is UNTRUSTED: every read is
 * checked, and a font that is not a font throws a TypeError, never a RangeError.
 */
import { parseFont } from './truetype.js';

/**
 * @param {Uint8Array} bytes a TrueType or OpenType (CFF) font file
 * @returns {{ numGlyphs: number, postscriptName: string, fsType: number, unitsPerEm: number, ascent: number, descent: number, isCFF: boolean, advance: (gid: number) => number, hasGlyph: (codePoint: number) => boolean, glyphForCodePoint: (codePoint: number) => number }}
 */
export function readFont(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('readFont: bytes must be a Uint8Array');
  let f;
  try {
    f = parseFont(bytes);
  } catch (e) {
    // ponytail: parseFont checks its reads up front; this maps any read it missed to the documented error, not a RangeError
    if (e instanceof RangeError) throw new TypeError('Broken font: a read ran past the end of the file');
    throw e;
  }
  return {
    numGlyphs: f.numGlyphs,
    postscriptName: f.postscriptName,
    fsType: f.fsType,
    unitsPerEm: f.unitsPerEm,
    ascent: f.ascent,
    descent: f.descent,
    isCFF: f.cff,
    advance: f.advance,
    hasGlyph: (codePoint) => f.glyphFor(codePoint) !== 0,
    glyphForCodePoint: f.glyphFor,
  };
}

/** Thrown inside checkSubset for a problem; any other error is reported as unreadable. */
class Problem {
  /** @param {string} m */
  constructor(m) {
    this.m = m;
  }
}
/** @param {string} m @returns {never} */
const fail = (m) => {
  throw new Problem(m);
};

/**
 * Why a subset cannot be embedded, or null when it can: the sfnt header, every table in the directory lying inside the
 * bytes, glyf/loca (each loca entry ascending and at most the glyf length), and a CFF table's header and its Name and
 * Top DICT INDEXes lying inside the table. Never throws.
 * @param {Uint8Array} bytes the subset, before any padding
 * @returns {string | null}
 */
export function checkSubset(bytes) {
  try {
    if (!(bytes instanceof Uint8Array)) return 'it is not a byte array';
    check(bytes);
    return null;
  } catch (e) {
    return e instanceof Problem ? e.m : 'it could not be read';
  }
}

/** @param {Uint8Array} bytes */
function check(bytes) {
  const len = bytes.byteLength;
  if (len < 12) fail('it is too short to be a font');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, len);
  const v = dv.getUint32(0);
  if (v !== 0x00010000 && v !== 0x74727565 && v !== 0x4f54544f) fail('it is not a TrueType or OpenType font');
  const n = dv.getUint16(4);
  if (12 + 16 * n > len) fail('its table directory runs past the end');
  /** @type {Map<string, { off: number, length: number }>} */
  const t = new Map();
  for (let i = 0; i < n; i++) {
    const p = 12 + 16 * i;
    const tag = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
    const off = dv.getUint32(p + 8),
      length = dv.getUint32(p + 12);
    if (off + length > len) fail(`its ${tag.trim()} table runs past the end`);
    t.set(tag, { off, length });
  }

  const glyf = t.get('glyf'),
    loca = t.get('loca');
  if (glyf || loca) {
    const head = t.get('head'),
      maxp = t.get('maxp');
    if (!glyf || !loca || !head || !maxp) fail('glyf, loca, head or maxp is missing');
    if (head.length < 54 || maxp.length < 6) fail('head or maxp is too short');
    const numGlyphs = dv.getUint16(maxp.off + 4);
    const long = dv.getInt16(head.off + 50) === 1,
      size = long ? 4 : 2;
    if (loca.length < (numGlyphs + 1) * size) fail('loca is too short for the glyph count');
    if (numGlyphs > 0 && glyf.length === 0) fail('glyf is empty but the font has glyphs');
    let prev = 0;
    for (let k = 0; k <= numGlyphs; k++) {
      const at = long ? dv.getUint32(loca.off + 4 * k) : 2 * dv.getUint16(loca.off + 2 * k);
      if (at < prev) fail(`loca goes backwards at entry ${k}`);
      if (at > glyf.length) fail(`loca entry ${k} lies beyond glyf`);
      prev = at;
    }
  }

  const cff = t.get('CFF ') ?? t.get('CFF2');
  if (cff) {
    const o = cff.off,
      end = o + cff.length;
    if (cff.length < 4) fail('the CFF table is too short');
    const major = bytes[o],
      hdr = bytes[o + 2];
    if (major !== (t.has('CFF ') ? 1 : 2)) fail(`the CFF header version is ${major}`);
    if (hdr < 4 || hdr > cff.length) fail(`the CFF header size ${hdr} is out of range`);
    if (t.has('CFF ')) {
      // the Name INDEX, then the Top DICT INDEX: count, offSize, offsets and data all inside the table
      let p = o + hdr;
      for (const what of ['Name', 'Top DICT']) {
        if (p + 2 > end) fail(`the CFF ${what} INDEX lies outside the table`);
        const count = dv.getUint16(p);
        if (!count) {
          p += 2;
          continue;
        }
        if (p + 3 > end) fail(`the CFF ${what} INDEX lies outside the table`);
        const os = bytes[p + 2];
        if (os < 1 || os > 4) fail(`the CFF ${what} INDEX has offset size ${os}`);
        const lastOff = p + 3 + count * os; // the last of count + 1 offsets
        if (lastOff + os > end) fail(`the CFF ${what} INDEX offsets lie outside the table`);
        let rel = 0;
        for (let b = 0; b < os; b++) rel = rel * 256 + bytes[lastOff + b];
        p = lastOff + os - 1 + rel; // data starts one before the offset base, as offsets begin at 1
        if (p > end) fail(`the CFF ${what} INDEX data runs past the table`);
      }
    }
  }
}
