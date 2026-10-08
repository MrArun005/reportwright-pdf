// @ts-check
/**
 * An embedded font: a Type0 font (Identity-H, two bytes per glyph, drawn by glyph ID) over a CIDFontType2 (TrueType,
 * FontFile2) or CIDFontType0 (CFF, FontFile3/OpenType), with a ToUnicode map so text can be copied and searched.
 * Glyphs are recorded as pages draw; the font's objects are written at the end, subset to those glyphs.
 * Writing follows ReportWright's writeFont (src/exporters/pdfstream.js).
 */
import { parseFont, sfntTables } from './truetype.js';
import { subsetGlyf } from './subset.js';
import { ascii, esc, hex4, num, utf16, latin1, pdfName } from '../core/serialize.js';

/**
 * @typedef {(font: Uint8Array, codePoints: Iterable<number>, opt: { glyphs: Iterable<number> }) => Promise<Uint8Array> | Uint8Array} Subsetter
 *   must keep glyph IDs (HarfBuzz: HB_SUBSET_FLAGS_RETAIN_GIDS)
 * @param {import('../document.js').Doc} doc @param {Uint8Array | ArrayBuffer} input
 * @param {{ subset?: boolean | Subsetter }} [opt]
 * @returns {import('../document.js').Font}
 */
export function embedFont(doc, input, opt = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const f = parseFont(bytes);
  const k = 1000 / f.unitsPerEm;
  const ref = doc.reserve();
  /** @type {Map<number, string>} glyph → the text it stands for */
  const glyphs = new Map();
  /** @type {Set<string>} */
  const missing = new Set();
  /** @type {Map<string, string>} char → its two escaped bytes */
  const memo = new Map();
  const strict = doc.pdfa || doc.tagged; // PDF/A and PDF/UA forbid drawing .notdef
  const pair = (/** @type {string} */ ch) => {
    let b = memo.get(ch);
    if (b === undefined) {
      const g = f.glyphFor(/** @type {number} */ (ch.codePointAt(0)));
      if (!g && missing.size < 100) missing.add(ch);
      if (!glyphs.has(g) && (g || !strict)) glyphs.set(g, g ? ch : '');
      memo.set(ch, b = !g && strict ? '' : esc(g >> 8) + esc(g & 255));
    }
    return b;
  };
  const font = {
    doc, ref, key: f.postscriptName, standard: false, missing,
    name: doc.resource('Font', `${ref} 0 R`),
    ascent: f.ascent / f.unitsPerEm, descent: f.descent / f.unitsPerEm,
    /** @param {string} text @param {number} size */
    widthOf(text, size) {
      let w = 0;
      for (const ch of String(text)) w += f.advance(f.glyphFor(/** @type {number} */ (ch.codePointAt(0))));
      return w * size / f.unitsPerEm;
    },
    /** @param {string} text */
    encode(text) { let s = ''; for (const ch of text) s += pair(ch); return s; },
    async write() {
      if (!glyphs.size) glyphs.set(0, '');
      const used = [...glyphs.keys()].sort((a, b) => a - b);
      const cps = [...glyphs.values()].filter(Boolean).map((t) => /** @type {number} */ (t.codePointAt(0)));
      let file = bytes;
      const sub = opt.subset ?? true;
      if (sub && !(f.fsType & 0x0100)) { // 0x0100: the licence forbids subsetting
        if (typeof sub === 'function') {
          try {
            const s = await sub(bytes, cps, { glyphs: used });
            const p = parseFont(s, false); // the subset must still have every glyph drawn, at the same ID
            if (p.numGlyphs > used[used.length - 1]) file = s;
          } catch { /* the whole font */ }
        } else if (!f.cff) file = subsetGlyf(bytes, used);
      }
      const subset = file !== bytes;
      const base = pdfName(`${subset ? `${tag(file)}+` : ''}${f.postscriptName}`, 'Font'); // with its slash; the name table is untrusted
      const desc = doc.reserve(), fileRef = doc.reserve(), cid = doc.reserve(), cmap = doc.reserve();
      const cff = f.cff && sfntTables(file).has('CFF ');
      await doc.writeStream(fileRef, cff ? '<< /Subtype /OpenType >>' : `<< /Length1 ${file.length} >>`, file);
      const s = (/** @type {number} */ v) => num(v * k);
      const flags = (f.fixedPitch ? 1 : 0) | 4 | (f.italicAngle ? 64 : 0);
      const [x0, y0, x1, y1] = f.bbox;
      await doc.write(desc, `<< /Type /FontDescriptor /FontName ${base} /Flags ${flags} /FontBBox [${s(x0)} ${s(y0)} ${s(x1)} ${s(y1)}] /ItalicAngle ${num(f.italicAngle)} /Ascent ${s(f.ascent)} /Descent ${s(f.descent)} /CapHeight ${s(f.capHeight)} /XHeight ${s(f.xHeight)} /StemV 0 /${cff ? 'FontFile3' : 'FontFile2'} ${fileRef} 0 R >>`);
      // widths: runs of consecutive glyph IDs, "first [w w w]"
      let W = '';
      for (let i = 0; i < used.length;) {
        let j = i;
        while (j + 1 < used.length && used[j + 1] === used[j] + 1) j++;
        W += `${used[i]} [${used.slice(i, j + 1).map((g) => s(f.advance(g))).join(' ')}] `;
        i = j + 1;
      }
      await doc.write(cid, `<< /Type /Font /Subtype /${cff ? 'CIDFontType0' : 'CIDFontType2'} /BaseFont ${base} /CIDSystemInfo << /Registry ${ascii('Adobe')} /Ordering ${ascii('Identity')} /Supplement 0 >> /FontDescriptor ${desc} 0 R /W [${W}]${cff ? '' : ' /CIDToGIDMap /Identity'} >>`);
      await doc.writeStream(cmap, '<< >>', latin1(toUnicode(glyphs)));
      await doc.write(ref, `<< /Type /Font /Subtype /Type0 /BaseFont ${base} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${cmap} 0 R >>`);
    },
  };
  doc.addFont(font);
  return font;
}

/** ToUnicode: each glyph to the text it stands for (UTF-16BE); glyphs that stand for nothing are left out. @param {Map<number, string>} glyphs */
function toUnicode(glyphs) {
  const entries = [...glyphs].filter(([, t]) => t).sort((a, b) => a[0] - b[0]);
  let body = '';
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    body += `${chunk.length} beginbfchar\n${chunk.map(([id, t]) => `<${hex4(id)}> <${utf16(t)}>`).join('\n')}\nendbfchar\n`;
  }
  return `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <ffff>\nendcodespacerange\n${body}endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`;
}

/** Six capital letters from the subset's bytes (FNV-1a): the subset's tag. @param {Uint8Array} bytes */
function tag(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619);
  let t = '';
  for (let i = 0; i < 6; i++) { t += String.fromCharCode(65 + ((h >>> 0) % 26)); h = Math.imul(h ^ i, 16777619) >>> 0; }
  return t;
}
