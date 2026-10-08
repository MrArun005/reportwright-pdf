// @ts-check
/**
 * PDF syntax helpers. INVARIANT (the encryption hook relies on it): every string the library writes into an object
 * dictionary is a hex string `<…>` made here (text, ascii, hexBytes), never a literal `( … )`. Literal strings appear
 * only inside content streams, which are encrypted as streams.
 */

/** a number to 3 decimals, no exponent, no "-0" @param {number} v */
export const num = (v) => {
  const r = Math.round(v * 1000) / 1000;
  return r === 0 ? '0' : String(r);
};
/** @param {number} id */
export const hex4 = (id) => id.toString(16).padStart(4, '0');
/** UTF-16BE hex of a string (surrogate pairs as they are in JS) @param {string} t */
export const utf16 = (t) => { let h = ''; for (let i = 0; i < t.length; i++) h += hex4(t.charCodeAt(i)); return h; };
/** a text string (Info, outline, /Alt, /Contents): UTF-16BE with its byte-order mark, as hex @param {any} t */
export const text = (t) => `<feff${utf16(String(t ?? ''))}>`;
/** a byte string of ASCII text (a URI) as hex; characters past 0x7f are percent-encoded first @param {string} s */
export const ascii = (s) => {
  const a = String(s).replace(/[^\x20-\x7e]/g, (c) => encodeURIComponent(c));
  let h = '<'; for (let i = 0; i < a.length; i++) h += a.charCodeAt(i).toString(16).padStart(2, '0');
  return `${h}>`;
};
/** a PDF name: characters outside the regular printable set as #xx @param {string} s */
export const name = (s) => '/' + String(s).replace(/[^!-~]|[#()<>[\]{}/%]/g, (c) => `#${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
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
