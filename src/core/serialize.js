// @ts-check
/**
 * PDF syntax helpers. INVARIANT (the encryption hook relies on it): every string the library writes into an object
 * dictionary is a hex string `<…>` made here (text, ascii, hexBytes), never a literal `( … )`. Literal strings appear
 * only inside content streams, which are encrypted as streams.
 */

/** a number to 3 decimals, no "-0"; NaN, Infinity and absurd sizes throw (they would corrupt the file) @param {number} v */
export const num = (v) => {
  if (typeof v !== 'number' || !(Math.abs(v) < 1e9)) throw new RangeError(`Not a usable number: ${v}`);
  const r = Math.round(v * 1000) / 1000;
  return r === 0 ? '0' : String(r);
};
/** @param {number} id */
export const hex4 = (id) => id.toString(16).padStart(4, '0');
/** UTF-16BE hex of a string (surrogate pairs as they are in JS) @param {string} t */
export const utf16 = (t) => { let h = ''; for (let i = 0; i < t.length; i++) h += hex4(t.charCodeAt(i)); return h; };
/** a text string (Info, outline, /Alt, /Contents): UTF-16BE with its byte-order mark, as hex @param {any} t */
export const text = (t) => `<feff${utf16(String(t ?? ''))}>`;
/** a byte string of ASCII text (a URI) as hex; spaces, controls and characters past 0x7e are percent-encoded first @param {string} s */
export const ascii = (s) => {
  const a = String(s).replace(/[^\x21-\x7e]/g, (c) => encodeURIComponent(c));
  let h = '<'; for (let i = 0; i < a.length; i++) h += a.charCodeAt(i).toString(16).padStart(2, '0');
  return `${h}>`;
};
/**
 * A PDF name (with its slash) from any text, safe to write into a dictionary or content stream: characters other than
 * A–Z a–z 0–9 _ . + - become '-', at most 63 of them (a PostScript name's limit; PDF/A allows 127 bytes), and the
 * fallback when nothing is left. EVERY name built from data (fonts' names, tag types, resource names, dictionary keys)
 * goes through here, so a font's name table or a caller's string cannot inject entries ("A /OpenAction << … >>").
 * @param {any} raw @param {string} [fallback]
 */
export const pdfName = (raw, fallback = 'X') => `/${String(raw ?? '').replace(/[^A-Za-z0-9_.+-]/g, '-').slice(0, 63) || fallback}`;
/** a date as D:YYYYMMDDHHmmSS+00'00' (UTC, to the second): the same instant gives the same bytes in any time zone @param {Date} d */
export const pdfDate = (d) => ascii(`D:${d.toISOString().replace(/\D/g, '').slice(0, 14)}+00'00'`);
/** one byte per char (content streams hold glyph bytes as chars 0–255) @param {string} s @returns {Uint8Array} */
export function latin1(s) {
  const B = /** @type {any} */ (globalThis).Buffer;
  if (B) return B.from(s, 'latin1');
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
/** a byte in a literal string's body: ( ) \ escaped, CR as \r (a bare CR would read as a line end) @param {number} b */
export const esc = (b) => (b === 0x28 || b === 0x29 || b === 0x5c ? '\\' + String.fromCharCode(b) : b === 0x0d ? '\\r' : String.fromCharCode(b));
