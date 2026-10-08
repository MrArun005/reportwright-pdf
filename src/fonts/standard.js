// @ts-check
/**
 * The 14 standard PDF fonts: named, not embedded (every reader has them). Metrics: Adobe's AFM files, generated into
 * standard-metrics.js (see THIRD-PARTY-NOTICES.md). One byte per character, its code in the font's encoding
 * (WinAnsi; Symbol and ZapfDingbats have their own); a character outside it is dropped and reported.
 */
import { brand } from '../core/brand.js';
import { METRICS, ENCODINGS } from './standard-metrics.js';
import { esc, fontName } from '../core/serialize.js';

export const STANDARD_NAMES = Object.keys(METRICS);

/**
 * @param {import('../document.js').Doc} doc @param {string} key a PostScript name of the 14
 * @returns {import('../document.js').Font}
 */
export function standardFont(doc, key) {
  const m = /** @type {any} */ (METRICS)[key];
  if (!m) throw new TypeError(`Not a standard font: ${key} (one of ${STANDARD_NAMES.join(', ')})`);
  if (doc.pdfa || doc.tagged) throw new TypeError(`PDF/A and PDF/UA need embedded fonts: ${key} is a standard font, which is not embedded. Use pdf.embedFont(bytes).`);
  const pairs = /** @type {number[]} */ (/** @type {any} */ (ENCODINGS)[m.encoding]);
  /** @type {Map<number, number>} code point → code */
  const codeOf = new Map();
  for (let i = 0; i < pairs.length; i += 2) codeOf.set(pairs[i], pairs[i + 1]);
  const widths = /** @type {number[]} */ (m.widths);
  const ref = doc.reserve();
  /** @type {Set<string>} */
  const missing = new Set();
  /** @type {Map<string, string>} char → escaped byte ('' when dropped) */
  const memo = new Map();
  const byte = (/** @type {string} */ ch) => {
    let b = memo.get(ch);
    if (b === undefined) {
      const code = codeOf.get(/** @type {number} */ (ch.codePointAt(0)));
      if (code === undefined && missing.size < 100) missing.add(ch);
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
    /** @param {string} text */
    encode(text) { let s = ''; for (const ch of text) s += byte(ch); return s; },
    async write() {
      await doc.write(ref, `<< /Type /Font /Subtype /Type1 /BaseFont ${fontName(key)}${m.encoding === 'WinAnsi' ? ' /Encoding /WinAnsiEncoding' : ''} /FirstChar 32 /LastChar 255 /Widths [${widths.slice(32, 256).map((x) => x || 0).join(' ')}] >>`);
    },
  };
  doc.addFont(font);
  return brand(Object.freeze(font), 'font', doc); // frozen: encode, write and name cannot be swapped
}
