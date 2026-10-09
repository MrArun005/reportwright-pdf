// @ts-check
/**
 * A small DER writer and a bounded DER reader: just what CMS SignedData needs (security/cms.js). The reader checks
 * every length against the bytes that are there, takes definite lengths of at most 4 bytes and single-byte tags only,
 * and never recurses on input.
 */
import { concat } from './crypto.js';

/** @param {number} n */
const lenBytes = (n) => (n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : n < 0x10000 ? [0x82, n >> 8, n & 255] : n < 0x1000000 ? [0x83, n >> 16, (n >> 8) & 255, n & 255] : [0x84, n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
/** a TLV @param {number} tag @param {Uint8Array[]} parts */
export const tlv = (tag, ...parts) => { const body = concat(parts); return concat([Uint8Array.of(tag, ...lenBytes(body.length)), body]); };
export const seq = (/** @type {Uint8Array[]} */ ...p) => tlv(0x30, ...p);
/** a SET OF, its elements sorted by their encodings (DER, X.690 §11.6) @param {Uint8Array[]} p */
export const set = (...p) => tlv(0x31, ...[...p].sort(cmp));
/** [n] constructed (EXPLICIT, or IMPLICIT over a SEQUENCE/SET) @param {number} n @param {Uint8Array[]} p */
export const ctx = (n, ...p) => tlv(0xa0 + n, ...p);
export const octets = (/** @type {Uint8Array} */ b) => tlv(0x04, b);
export const NULL = Uint8Array.of(5, 0);
/** a small non-negative INTEGER @param {number} n */
export const int = (n) => { const b = []; do { b.unshift(n & 255); n = Math.floor(n / 256); } while (n > 0); if (b[0] & 0x80) b.unshift(0); return tlv(0x02, Uint8Array.from(b)); };
/** an OBJECT IDENTIFIER from dotted text @param {string} s */
export function oid(s) {
  const a = s.split('.').map(Number), out = [40 * a[0] + a[1]];
  for (const v of a.slice(2)) { const b = [v & 127]; for (let x = Math.floor(v / 128); x > 0; x = Math.floor(x / 128)) b.unshift((x & 127) | 128); out.push(...b); }
  return tlv(0x06, Uint8Array.from(out));
}
/** UTCTime (years 1950–2049) or GeneralizedTime, to the second (RFC 5280 §4.1.2.5) @param {Date} d */
export function time(d) {
  const iso = d.toISOString().replace(/\D/g, '').slice(0, 14), y = d.getUTCFullYear();
  return y >= 1950 && y < 2050 ? tlv(0x17, new TextEncoder().encode(`${iso.slice(2)}Z`)) : tlv(0x18, new TextEncoder().encode(`${iso}Z`));
}
/** @param {Uint8Array} a @param {Uint8Array} b */
function cmp(a, b) { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; }

/**
 * One TLV at `at`, checked: { tag, start (its content), end, whole (the TLV's bytes) }. @param {Uint8Array} b @param {number} at
 * @param {number} [limit] the end of the enclosing value
 */
export function read(b, at, limit = b.length) {
  if (at + 2 > limit) throw new RangeError('DER: truncated');
  const tag = b[at];
  if ((tag & 0x1f) === 0x1f) throw new RangeError('DER: multi-byte tags are not supported');
  let len = b[at + 1], start = at + 2;
  if (len === 0x80) throw new RangeError('DER: an indefinite length is not DER');
  if (len > 0x80) {
    const k = len & 0x7f;
    if (k > 4 || start + k > limit) throw new RangeError('DER: a bad length');
    len = 0; for (let i = 0; i < k; i++) len = len * 256 + b[start + i];
    start += k;
  }
  const end = start + len;
  if (end > limit) throw new RangeError('DER: a length past the end of its value');
  return { tag, start, end, whole: b.subarray(at, end) };
}
/** the children of a constructed value (bounded by its length) @param {Uint8Array} b @param {{ start: number, end: number }} v */
export function kids(b, v) {
  const out = [];
  for (let at = v.start; at < v.end;) { const k = read(b, at, v.end); out.push(k); at = k.end; }
  return out;
}
