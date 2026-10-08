// @ts-check
/**
 * ICC profile header check. A profile is hostile input: everything read is bounded by its length, nothing recurses.
 * Checked: the size field equals the bytes given, the 'acsp' signature, a version of at most 4, the colour space (gray,
 * RGB or CMYK: their component count is the PDF /N), and that the tag table and every tag lie inside the profile.
 */

export const MAX_ICC = 32 << 20;
const SPACES = new Map([['GRAY', 1], ['RGB ', 3], ['CMYK', 4]]);

/**
 * @param {any} bytes @param {string} what for errors ("iccColorSpace")
 * @returns {{ bytes: Uint8Array, n: 1 | 3 | 4, space: string, cls: string }}
 */
export function parseIcc(bytes, what) {
  const b = toBytes(bytes, what);
  const bad = (/** @type {string} */ m) => new TypeError(`${what}: not a usable ICC profile (${m})`);
  if (b.length < 132) throw bad(`${b.length} bytes; a profile has at least 132`);
  if (b.length > MAX_ICC) throw bad(`over ${MAX_ICC >> 20} MB`);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const size = dv.getUint32(0);
  if (size !== b.length) throw bad(`its header says ${size} bytes, but ${b.length} were given`);
  if (tag(b, 36) !== 'acsp') throw bad("no 'acsp' signature");
  if (b[8] < 2 || b[8] > 4) throw bad(`version ${b[8]}; PDF takes ICC versions 2 to 4`);
  const space = tag(b, 16), n = SPACES.get(space);
  if (!n) throw bad(`colour space ${JSON.stringify(space.trim())}; gray, RGB and CMYK are supported`);
  const count = dv.getUint32(128);
  if (count > (size - 132) / 12) throw bad(`${count} tags do not fit in ${size} bytes`);
  for (let i = 0; i < count; i++) {
    const off = dv.getUint32(132 + 12 * i + 4), len = dv.getUint32(132 + 12 * i + 8);
    if (off + len > size) throw bad(`tag ${i} lies outside the profile`);
  }
  return { bytes: b, n: /** @type {1 | 3 | 4} */ (n), space: space.trim(), cls: tag(b, 12) };
}

/** four ASCII bytes at i @param {Uint8Array} b @param {number} i */
const tag = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);

/** bytes from a Uint8Array (Buffer), ArrayBuffer or typed array view @param {any} v @param {string} what @returns {Uint8Array} */
export function toBytes(v, what) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new TypeError(`${what}: bytes are a Uint8Array or an ArrayBuffer`);
}
