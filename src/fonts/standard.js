// @ts-check
/**
 * The 14 standard PDF fonts: named, not embedded (every reader has them). Metrics: Adobe's AFM files, generated into
 * standard-metrics.js (see THIRD-PARTY-NOTICES.md). One byte per character, its code in the font's encoding
 * (WinAnsi; Symbol and ZapfDingbats have their own); a character outside it is dropped and reported.
 */
import { brand } from '../core/brand.js';
import { METRICS, ENCODINGS } from './standard-metrics.js';
import { esc, fontName } from '../core/serialize.js';
import { measure } from '../text/runs.js';

export const STANDARD_NAMES = Object.keys(METRICS);
/** an escaped two-character byte ("\\(", "\\)", "\\\\", "\\r") → its code */
const CODE = /** @type {Record<string, number>} */ ({ '\\(': 0x28, '\\)': 0x29, '\\\\': 0x5c, '\\r': 0x0d });

/**
 * @param {import('../document.js').Doc} doc @param {string} key a PostScript name of the 14
 * @returns {import('../document.js').Font}
 */
export function standardFont(doc, key) {
  const m = typeof key === 'string' && Object.hasOwn(METRICS, key) ? /** @type {any} */ (METRICS)[key] : null; // own keys only: not 'constructor'
  if (!m) throw new TypeError(`Not a standard font: ${key} (one of ${STANDARD_NAMES.join(', ')})`);
  if (doc.pdfa || doc.tagged) throw new TypeError(`PDF/A and PDF/UA need embedded fonts: ${key} is a standard font, which is not embedded. Use pdf.embedFont(bytes).`);
  const pairs = /** @type {number[]} */ (/** @type {any} */ (ENCODINGS)[m.encoding]);
  /** @type {Map<number, number>} code point → code */
  const codeOf = new Map();
  for (let i = 0; i < pairs.length; i += 2) codeOf.set(pairs[i], pairs[i + 1]);
  const widths = /** @type {number[]} */ (m.widths);
  // code units below 256: their width (-1: not in the encoding), and whether their byte is the character itself
  const W8 = new Float64Array(256), SAME = new Uint8Array(256);
  for (let c = 0; c < 256; c++) {
    const code = codeOf.get(c);
    W8[c] = code === undefined ? -1 : widths[code] || 0;
    SAME[c] = code === c && esc(code) === String.fromCharCode(c) ? 1 : 0;
  }
  const SP32 = codeOf.get(32) === 32;
  const ref = doc.reserve();
  /** @type {Set<string>} */
  const missing = new Set();
  /** @type {Map<string, string>} char → escaped byte ('' when dropped) */
  const memo = new Map();
  const byte = (/** @type {string} */ ch) => {
    let b = memo.get(ch);
    if (b === undefined) {
      const code = codeOf.get(/** @type {number} */ (ch.codePointAt(0)));
      memo.set(ch, b = code === undefined ? '' : esc(code));
    }
    return b;
  };
  const font = {
    doc, ref, key, standard: true, missing,
    name: doc.resource('Font', `${ref} 0 R`),
    ascent: m.ascent / 1000, descent: m.descent / 1000,
    /** @param {string} text @param {number} size */
    widthOf(text, size) {
      let w = 0;
      for (const ch of String(text)) { const c = codeOf.get(/** @type {number} */ (ch.codePointAt(0))); if (c !== undefined) w += widths[c] || 0; }
      return w * size / 1000;
    },
    /** @param {string} text @param {number} size @param {import('../text/runs.js').MeasureOptions} [o] */
    widthOfText: (text, size, o) => measure(impl, String(text ?? ''), size, o),
    /** 1.2 × size (the AFM metrics have no line gap) @param {number} size */
    lineHeight: (size) => 1.2 * size,
    /** @param {string} text */
    encode(text) { let s = ''; for (const ch of text) { const b = byte(ch); if (!b && missing.size < 100) missing.add(ch); s += b; } return s; },
    async write() {
      await doc.write(ref, `<< /Type /Font /Subtype /Type1 /BaseFont ${fontName(key)}${m.encoding === 'WinAnsi' ? ' /Encoding /WinAnsiEncoding' : ''} /FirstChar 32 /LastChar 255 /Widths [${widths.slice(32, 256).map((x) => x || 0).join(' ')}] >>`);
    },
  };
  /** @type {import('../text/runs.js').FontImpl} not kerned: the metrics carry no kerning pairs */
  const impl = {
    standard: true, ascent: m.ascent / 1000, lineHeight: 1.2,
    has: (cp) => codeOf.has(cp),
    items(text, o) {
      const draw = !o.measure;
      if (!o.rtl) { // the common case: a table per code unit below 256, and the text itself when every byte is its character
        let a = 0, n = 0, sp = 0, same = true;
        for (let i = 0; i < text.length; i++) {
          const c = text.charCodeAt(i);
          if (c > 255) { same = false; break; }
          const w = W8[c];
          if (w < 0) { same = false; break; }
          a += w; n++;
          if (c === 32 && SP32) sp++;
          if (!SAME[c]) { same = false; break; }
        }
        if (same) return { body: draw ? text : '', a, n, sp };
      }
      let body = '', a = 0, n = 0, sp = 0;
      for (const ch of o.rtl ? [...text].reverse() : text) {
        const b = byte(ch); // memoised per character: its escaped byte, '' when the encoding lacks it
        if (!b) { if (draw && missing.size < 100) missing.add(ch); continue; }
        const code = b.length === 1 ? b.charCodeAt(0) : CODE[b];
        if (draw) body += b;
        n++; a += widths[code] || 0;
        if (code === 32) sp++;
      }
      return { body, a, n, sp };
    },
  };
  doc.addFont(font);
  return brand(Object.freeze(font), 'font', doc, impl); // frozen: encode, write and name cannot be swapped
}
