// @ts-check
/**
 * An embedded font: a Type0 font (Identity-H, two bytes per glyph, drawn by glyph ID) over a CIDFontType2 (TrueType,
 * FontFile2) or CIDFontType0 (CFF, FontFile3/OpenType), with a ToUnicode map so text can be copied and searched.
 * Glyphs are recorded as pages draw; the font's objects are written at the end, subset to those glyphs.
 * Writing follows ReportWright's writeFont (src/exporters/pdfstream.js).
 */
import { brand } from '../core/brand.js';
import { parseFont, sfntTables } from './truetype.js';
import { subsetGlyf, buildSfnt } from './subset.js';
import { parseCff, subsetCff, identityCharset } from './cff.js';
import { kerning } from './kern.js';
import { measure } from '../text/runs.js';
import { ascii, esc, hex4, num, utf16, latin1, fontName } from '../core/serialize.js';

/**
 * @typedef {(font: Uint8Array, codePoints: Iterable<number>, opt: { glyphs: Iterable<number> }) => Promise<Uint8Array> | Uint8Array} Subsetter
 *   must keep glyph IDs (HarfBuzz: HB_SUBSET_FLAGS_RETAIN_GIDS)
 * @typedef {{ g: number, cl: number, ax: number, dx?: number, dy?: number }} ShapedGlyph
 *   a glyph from a shaper, in font units: glyph ID, cluster (the UTF-16 index of its first character in the text),
 *   x advance, x and y offsets (HarfBuzz's glyph infos and positions)
 * @typedef {(text: string, font: any, opt: { direction: 'ltr' | 'rtl', kerning: boolean }) => ShapedGlyph[]} Shaper
 * @param {import('../document.js').Doc} doc @param {Uint8Array | ArrayBuffer} input
 * @param {{ subset?: boolean | Subsetter, shaper?: Shaper }} [opt]
 * @returns {import('../document.js').Font}
 */
export function embedFont(doc, input, opt = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const f = parseFont(bytes);
  const shaper = opt.shaper;
  if (shaper != null && typeof shaper !== 'function') throw new TypeError('embedFont: shaper is a function (text, font, { direction, kerning }) => glyphs');
  const cffTable = f.tables.get('CFF ');
  // checked now: a broken CFF fails here, not at pdf.end(). Glyphs are drawn by glyph ID; a CID-keyed CFF's charset is
  // rewritten to the identity when written (readers disagree on whether an OpenType CFF's CIDs go through it)
  const cidKeyed = cffTable ? !!parseCff(cffTable, f.numGlyphs).cids : false;
  const two = (/** @type {number} */ g) => esc(g >> 8) + esc(g & 255);
  const kern = kerning(f.tables, f.numGlyphs, (m) => doc.warn(`${f.postscriptName.slice(0, 63)}: ${m}`));
  const k = 1000 / f.unitsPerEm;
  const ref = doc.reserve();
  /** @type {Map<number, string>} glyph → the text it stands for */
  const glyphs = new Map();
  /** @type {Set<string>} */
  const missing = new Set();
  /** @type {Map<string, string>} char → its two escaped bytes */
  const memo = new Map();
  const strict = doc.pdfa || doc.tagged; // PDF/A and PDF/UA forbid drawing .notdef
  // PDF/A-2u/2a/3u/3a: every glyph maps to Unicode, so a character the font lacks is an error, not a dropped character
  const lack = (/** @type {string} */ t) => { if (doc.pdfaLevel?.unicode) throw new TypeError(`PDF/A-${doc.pdfaLevel.part}${doc.pdfaLevel.conformance}: ${f.postscriptName.slice(0, 63)} has no glyph for ${JSON.stringify(t)} (U+${(t.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}), and every character drawn must map to Unicode: use a font that has it, or a fallback font`); };
  /** glyph g's width as /W writes it, in thousandths of the size */
  const W = (/** @type {number} */ g) => Number(num(f.advance(g) * k));
  const pair = (/** @type {string} */ ch) => {
    let b = memo.get(ch);
    if (b === undefined) {
      const g = f.glyphFor(/** @type {number} */ (ch.codePointAt(0)));
      if (!g) lack(ch);
      if (!g && missing.size < 100) missing.add(ch);
      if (!glyphs.has(g) && (g || !strict)) glyphs.set(g, g ? ch : '');
      memo.set(ch, b = !g && strict ? '' : two(g));
    }
    return b;
  };
  /** record glyph g as standing for t; false when it already stands for other text (the run needs ActualText) */
  const record = (/** @type {number} */ g, /** @type {string} */ t) => {
    const m = t.length <= 32 ? t : String.fromCodePoint(/** @type {number} */ (t.codePointAt(0))); // ToUnicode stays small
    if (!glyphs.has(g)) glyphs.set(g, g ? m : '');
    return glyphs.get(g) === t;
  };
  /** @type {any} the font handle (passed to the shaper) */
  let handle;
  /** @param {string} text @param {import('../text/runs.js').RunOptions} o @returns {import('../text/runs.js').Run} */
  const items = (text, o) => {
    const kerned = o.kerning !== false && kern;
    if (shaper) return shaped(text, o);
    if (!kerned && !o.ws) { // nothing between the glyphs: one string
      let body = '', a = 0, n = 0, sp = 0;
      for (const ch of o.rtl ? [...text].reverse() : text) {
        const g = f.glyphFor(/** @type {number} */ (ch.codePointAt(0)));
        if (!g && strict) { if (!o.measure) pair(ch); continue; }
        if (!o.measure) body += pair(ch); // measuring records nothing (no glyph for the subset, no warning)
        n++; a += W(g);
        if (ch === ' ') sp++;
      }
      return { body, a, n, sp };
    }
    if (o.measure) { // the advance only: no glyph objects (a long text is measured in one pass, flat in memory)
      let a = 0, n = 0, sp = 0, prev = -1;
      for (const ch of o.rtl ? [...text].reverse() : text) {
        const g = f.glyphFor(/** @type {number} */ (ch.codePointAt(0)));
        if (!g && strict) continue;
        a += W(g) + (kerned && prev >= 0 ? kern(prev, g) * k : 0); n++; prev = g;
        if (ch === ' ') sp++;
      }
      return { body: '', a, n, sp };
    }
    /** @type {import('../text/runs.js').Item[]} */
    const out = [];
    let prev = -1;
    for (const ch of o.rtl ? [...text].reverse() : text) {
      const g = f.glyphFor(/** @type {number} */ (ch.codePointAt(0)));
      if (!g) { if (!o.measure) lack(ch); if (missing.size < 100 && !o.measure) missing.add(ch); if (strict) continue; }
      const ok = o.measure || record(g, ch), w = W(g);
      if (kerned && prev >= 0) out[out.length - 1].a += kern(prev, g) * k;
      out.push({ b: two(g), w, a: w, dx: 0, dy: 0, sp: ch === ' ', at: ok ? undefined : ch, n: 1 });
      prev = g;
    }
    return out;
  };
  /** text through the shaper: glyphs by ID, ActualText where a cluster is not one glyph standing for its text */
  const shaped = (/** @type {string} */ text, /** @type {import('../text/runs.js').RunOptions} */ o) => {
    const res = /** @type {any} */ (shaper)(text, handle, { direction: o.rtl ? 'rtl' : 'ltr', kerning: o.kerning !== false });
    if (!Array.isArray(res) || res.length > 4 * text.length + 64) throw new TypeError(`The shaper returned ${Array.isArray(res) ? `${res.length} glyphs for ${text.length} characters` : 'no array'}`);
    const fin = (/** @type {any} */ v, /** @type {string} */ what) => {
      const x = v ?? 0;
      if (typeof x !== 'number' || !(Math.abs(x) < 1e6)) throw new TypeError(`The shaper returned a bad ${what}: ${v}`);
      return x;
    };
    /** @type {{ g: number, cl: number, ax: number, dx: number, dy: number }[]} */
    const gl = res.map((r) => {
      const g = r?.g, cl = r?.cl;
      if (!Number.isInteger(g) || g < 0 || g >= f.numGlyphs) throw new TypeError(`The shaper returned glyph ${g}, not one of the font's ${f.numGlyphs}`);
      if (!Number.isInteger(cl) || cl < 0 || cl >= Math.max(1, text.length)) throw new TypeError(`The shaper returned cluster ${cl}, outside the text`);
      return { g, cl, ax: fin(r.ax, 'advance'), dx: fin(r.dx, 'offset'), dy: fin(r.dy, 'offset') };
    });
    // a cluster's text runs from its index to the next cluster's
    const starts = [...new Set(gl.map((x) => x.cl))].sort((a, b) => a - b);
    const end = new Map(starts.map((c, i) => [c, starts[i + 1] ?? text.length]));
    /** @type {import('../text/runs.js').Item[]} */
    const out = [];
    for (let i = 0; i < gl.length;) {
      let j = i;
      while (j < gl.length && gl[j].cl === gl[i].cl) j++;
      const t = text.slice(gl[i].cl, end.get(gl[i].cl)), first = out.length;
      let ok = j - i === 1;
      for (let q = i; q < j; q++) { // ponytail: a cluster split around other glyphs gets its ActualText twice
        const { g, ax, dx, dy } = gl[q];
        if (!g) { if (!o.measure) lack(t); if (missing.size < 100 && !o.measure) missing.add(t); if (strict) { if (out.length > first) out[out.length - 1].a += ax * k; continue; } }
        ok = (o.measure || record(g, t)) && ok;
        out.push({ b: two(g), w: W(g), a: ax * k, dx: dx * k, dy: dy * k, sp: t === ' ' });
      }
      if (out.length > first && !ok) { out[first].at = t; out[first].n = out.length - first; }
      i = j;
    }
    return out;
  };
  /** @type {import('../text/runs.js').FontImpl} */
  const impl = {
    standard: false, items, has: (cp) => f.glyphFor(cp) !== 0,
    ascent: f.ascent / f.unitsPerEm, lineHeight: (f.ascent - f.descent + Math.max(0, f.lineGap)) / f.unitsPerEm,
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
    /** @param {string} text @param {number} size @param {import('../text/runs.js').MeasureOptions} [o] */
    widthOfText: (text, size, o) => measure(impl, String(text ?? ''), size, o),
    /** @param {number} size */
    lineHeight: (size) => impl.lineHeight * size,
    /** @param {string} text */
    encode(text) { let s = ''; for (const ch of text) s += pair(ch); return s; },
    async write() {
      if (!glyphs.size) glyphs.set(0, '');
      const used = [...glyphs.keys()].sort((a, b) => a - b);
      const cps = [...glyphs.values()].filter(Boolean).flatMap((t) => [...t].map((c) => /** @type {number} */ (c.codePointAt(0))));
      let file = bytes;
      const sub = opt.subset ?? true;
      if (sub && !(f.fsType & 0x0100)) { // 0x0100: the licence forbids subsetting
        if (typeof sub === 'function') {
          try {
            const s = await sub(bytes, cps, { glyphs: used });
            const p = parseFont(s, false); // the subset must still have every glyph drawn, at the same ID
            if (p.numGlyphs > used[used.length - 1]) file = s;
          } catch { /* the whole font */ }
        } else if (cffTable) file = subsetOtf(bytes, f.numGlyphs, used);
        else if (!f.cff) file = subsetGlyf(bytes, used);
      }
      const subset = file !== bytes;
      if (cidKeyed) file = identityOtf(file, file === bytes ? f.numGlyphs : -1);
      const base = fontName(`${subset ? `${tag(file)}+` : ''}${f.postscriptName}`, 'Font'); // with its slash; the name table is untrusted
      const desc = doc.reserve(), fileRef = doc.reserve(), cid = doc.reserve(), cmap = doc.reserve();
      const cff = f.cff && sfntTables(file).has('CFF ');
      // PDF/A-1 is PDF 1.4, which has no OpenType font files: there the bare CFF table goes in (CIDFontType0C)
      const bare = cff && doc.pdfaLevel?.part === 1;
      await doc.writeStream(fileRef, bare ? '<< /Subtype /CIDFontType0C >>' : cff ? '<< /Subtype /OpenType >>' : `<< /Length1 ${file.length} >>`, bare ? /** @type {Uint8Array} */ (sfntTables(file).get('CFF ')) : file);
      let cidSet = ''; // PDF/A-1 (ISO 19005-1 6.3.5): a subset CIDFont lists the CIDs it has, one bit each, high bit first
      if (subset && doc.pdfaLevel?.part === 1) {
        const bits = new Uint8Array((used[used.length - 1] >> 3) + 1), n = doc.reserve();
        for (const g of used) bits[g >> 3] |= 0x80 >> (g & 7);
        await doc.writeStream(n, '<< >>', bits);
        cidSet = ` /CIDSet ${n} 0 R`;
      }
      const s = (/** @type {number} */ v) => num(v * k);
      const flags = (f.fixedPitch ? 1 : 0) | 4 | (f.italicAngle ? 64 : 0);
      const [x0, y0, x1, y1] = f.bbox;
      await doc.write(desc, `<< /Type /FontDescriptor /FontName ${base} /Flags ${flags} /FontBBox [${s(x0)} ${s(y0)} ${s(x1)} ${s(y1)}] /ItalicAngle ${num(f.italicAngle)} /Ascent ${s(f.ascent)} /Descent ${s(f.descent)} /CapHeight ${s(f.capHeight)} /XHeight ${s(f.xHeight)} /StemV 0 /${cff ? 'FontFile3' : 'FontFile2'} ${fileRef} 0 R${cidSet} >>`);
      // widths: runs of consecutive glyph IDs, "first [w w w]"
      const codes = used.map((g) => [g, g]);
      let Wa = '';
      for (let i = 0; i < codes.length;) {
        let j = i;
        while (j + 1 < codes.length && codes[j + 1][0] === codes[j][0] + 1) j++;
        Wa += `${codes[i][0]} [${codes.slice(i, j + 1).map(([, g]) => s(f.advance(g))).join(' ')}] `;
        i = j + 1;
      }
      await doc.write(cid, `<< /Type /Font /Subtype /${cff ? 'CIDFontType0' : 'CIDFontType2'} /BaseFont ${base} /CIDSystemInfo << /Registry ${ascii('Adobe')} /Ordering ${ascii('Identity')} /Supplement 0 >> /FontDescriptor ${desc} 0 R /W [${Wa}]${cff ? '' : ' /CIDToGIDMap /Identity'} >>`);
      await doc.writeStream(cmap, '<< >>', latin1(toUnicode(glyphs)));
      await doc.write(ref, `<< /Type /Font /Subtype /Type0 /BaseFont ${base} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${cmap} 0 R >>`);
    },
  };
  doc.addFont(font);
  handle = brand(Object.freeze(font), 'font', doc, impl); // frozen: encode, write and name cannot be swapped
  return handle;
}

/** an OpenType/CFF font whose CID-keyed CFF has its charset made the identity (CID = glyph ID) @param {Uint8Array} file @param {number} n */
function identityOtf(file, n) {
  const t = sfntTables(file), cff = t.get('CFF ');
  if (!cff || !parseCff(cff, n).cids) return file;
  t.set('CFF ', identityCharset(cff, n));
  return buildSfnt(t, [0x4f, 0x54, 0x54, 0x4f]);
}

const OTF_KEEP = ['CFF ', 'head', 'hhea', 'hmtx', 'maxp', 'OS/2', 'name'];
/** An OpenType/CFF font subset by glyph ID (fonts/cff.js), or the whole font when it uses seac. @param {Uint8Array} bytes @param {number} n @param {number[]} used */
function subsetOtf(bytes, n, used) {
  const t = sfntTables(bytes), cff = subsetCff(/** @type {Uint8Array} */ (t.get('CFF ')), n, used);
  if (!cff) return bytes;
  /** @type {Map<string, Uint8Array>} */
  const out = new Map();
  for (const tg of OTF_KEEP) { const x = t.get(tg); if (x) out.set(tg, x); }
  out.set('CFF ', cff);
  return buildSfnt(out, [0x4f, 0x54, 0x54, 0x4f]);
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
