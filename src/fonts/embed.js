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
import { parseCff, subsetCff, identityCharset, scanGlyph, FONT_BUDGET } from './cff.js';
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
  const parsed = cffTable ? parseCff(cffTable, f.numGlyphs) : null, cidKeyed = !!parsed?.cids;
  const sub = opt.subset ?? true;
  // the CFF subsetter walks each used glyph's charstring: once, when text first uses it, on one budget for the font
  const walk = parsed && sub && typeof sub !== 'function' && !(f.fsType & 0x0100) ? { left: FONT_BUDGET } : null;
  let seac = false;
  const use = (/** @type {number} */ g) => { if (walk && scanGlyph(/** @type {Uint8Array} */ (cffTable), /** @type {any} */ (parsed), g, walk)) seac = true; };
  use(0);
  const two = (/** @type {number} */ g) => esc(g >> 8) + esc(g & 255);
  const kern = kerning(f.tables, f.numGlyphs, (m) => doc.warn(`${f.postscriptName.slice(0, 63)}: ${m}`));
  const axes = variation(f.tables.get('fvar'));
  if (axes) doc.warn(`${f.postscriptName.slice(0, 63)} is a variable font: it is drawn at its default instance (${axes}); to draw another weight or width, embed a static instance of it (fonttools varLib.instancer, or HarfBuzz's hb-subset --instance)`);
  const k = 1000 / f.unitsPerEm;
  const ref = doc.reserve();
  // A TrueType CIDFont can draw one glyph under several CIDs (a CIDToGIDMap), so each glyph-and-text pair gets its own
  // code and the ToUnicode is exact everywhere: a glyph that stands for "क" in one place and for nothing in another
  // (the second glyph of a cluster) is two codes. A CFF CIDFont cannot (its CID is the glyph): there a glyph keeps the
  // text it first stood for, and a span that needs other text gets an ActualText.
  /** @type {Map<number, { g: number, t: string }>} code (CID) → its glyph and the text it stands for */
  const codes = new Map();
  /** @type {Map<string, number>} "glyph:text" → its code */
  const codeOf = new Map();
  const copies = !f.cff;
  let next = f.numGlyphs; // the codes past the font's glyphs, for second and later texts of a glyph
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
      memo.set(ch, b = !g && strict ? '' : two(code(g, ch)[0]));
    }
    return b;
  };
  /**
   * the code drawing glyph g as standing for t ('' for nothing: the later glyphs of a cluster), and whether the
   * ToUnicode gives exactly t (false: the span needs an ActualText) @returns {[number, boolean]}
   */
  const code = (/** @type {number} */ g, /** @type {string} */ t) => {
    const m = t.length <= 32 ? t : String.fromCodePoint(/** @type {number} */ (t.codePointAt(0))); // ToUnicode stays small
    let c = codeOf.get(`${g}:${m}`);
    if (c === undefined) {
      if (!codes.has(g)) { use(g); c = g; } // a glyph's first text: its own code
      else if (copies && next <= 0xffff) c = next++;
      else return [g, /** @type {any} */ (codes.get(g)).t === t]; // ponytail: out of codes (or CFF): ActualText
      codes.set(c, { g, t: m }); codeOf.set(`${g}:${m}`, c);
    }
    return [c, m === t];
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
      const [c, ok] = o.measure ? [g, true] : code(g, ch), w = W(g);
      if (kerned && prev >= 0) out[out.length - 1].a += kern(prev, g) * k;
      out.push({ b: two(c), w, a: w, dx: 0, dy: 0, sp: ch === ' ', at: ok ? undefined : ch, n: 1 });
      prev = g;
    }
    return out;
  };
  /**
   * text through the shaper: glyphs by ID. A cluster of several glyphs (a conjunct, a matra, a reordered vowel, a
   * letter and its dots) has its text on one glyph, its widest (the first of them in visual order), and its other
   * glyphs stand for WJ (U+2060) in the ToUnicode, a format character pdf.js skips (pdf.js reads an empty mapping as
   * the code itself, a stray character). So that readers that honour ActualText (Acrobat, poppler, ours) do not read
   * the WJs: the other glyphs with no advance (marks, dots) are drawn out of the flow, after the run, in a span of no
   * ActualText; a left-to-right cluster with another glyph that has an advance (a matra) is one ActualText span of its
   * text. Why: pdf.js skips a format character without its advance (so the widest glyph has the text), and it cuts
   * its text items at marked content and orders right-to-left text within an item, so a span inside an Arabic word
   * would put the word's pieces in visual order; a right-to-left cluster with two glyphs that both advance keeps its
   * WJ in poppler's text (ponytail: no such cluster in the Arabic fonts tried). A span is also written where the
   * ToUnicode cannot say a glyph's text (a CFF font's glyph that already stands for other text, or no codes left).
   */
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
    const out = [], said = new Set(); // the clusters whose text is out (a cluster split around others says it once)
    /** the cluster from glyph a: [its end, its text] @param {number} a @returns {[number, string]} */
    const at = (a) => { let b = a; while (b < gl.length && gl[b].cl === gl[a].cl) b++; return [b, said.has(gl[a].cl) ? '' : text.slice(gl[a].cl, end.get(gl[a].cl))]; };
    /** @type {import('../text/runs.js').Item | null} the span the space glyph next joins */
    let glued = null;
    for (let i = 0; i < gl.length;) {
      const [j, t0] = at(i), cl = gl[i].cl, first = out.length;
      if (glued && t0 === ' ' && j - i === 1) { // a space whose text went on the glyph before (see below)
        const { g, ax, dx, dy } = gl[i];
        out.push({ b: two(o.measure ? g : code(g, '\u2060')[0]), w: W(g), a: ax * k, dx: dx * k, dy: dy * k, sp: true });
        if (glued.n) glued.n++;
        glued = null; said.add(cl); i = j;
        continue;
      }
      glued = null;
      // pdf.js reads a glyph whose text has a nonspacing mark (a virama, a Telugu matra) as having no width, and after a
      // space then such glyphs it puts the space in again ("क्षत्रि य"): so before a word that starts with one, the
      // space's text goes on the glyph before it ("दी ", the space glyph WJ), in an ActualText span of both
      const glue = !o.rtl && !!t0 && t0 !== ' ' && j < gl.length && at(j)[1] === ' ' && at(j)[0] - j === 1 && at(j)[0] < gl.length && MN.test(at(at(j)[0])[1]);
      const t = glue ? `${t0} ` : t0;
      let lead = -1, span = glue;
      if (t0) for (let q = i; q < j; q++) if ((gl[q].g || !strict) && (lead < 0 || gl[q].ax > gl[lead].ax)) lead = q;
      for (let q = i; q < j; q++) {
        const { g, ax, dx, dy } = gl[q];
        if (!g) { if (!o.measure) lack(t); if (missing.size < 100 && !o.measure && t) missing.add(t); if (strict) { if (out.length > first) out[out.length - 1].a += ax * k; continue; } }
        // right to left, a glyph's text is in visual order, as pdf.js and poppler reverse a line's right-to-left characters
        const [c, exact] = o.measure ? [g, true] : code(g, q !== lead ? '\u2060' : o.rtl && RTL.test(t) ? [...t].reverse().join('') : t);
        if (!exact) span = true;
        if (q !== lead && Math.abs(ax * k) >= 1) span ||= !o.rtl; // a continuation with an advance stays in the flow
        out.push({ b: two(c), w: W(g), a: ax * k, dx: dx * k, dy: dy * k, sp: q === lead && t === ' ', c: (q !== lead && Math.abs(ax * k) < 1) || undefined });
      }
      if (out.length > first) said.add(cl);
      if (span && !o.measure) { // the cluster's glyphs in the flow, in one ActualText span
        const flow = out.slice(first).filter((x) => !x.c);
        if (flow.length) { flow[0].at = t; flow[0].n = flow.length; if (glue) glued = flow[0]; }
      } else if (glue) glued = /** @type {any} */ ({}); // measuring: the space still joins (no span)
      i = j;
    }
    return out;
  };
  const MN = /\p{Mn}/u, RTL = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;
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
      const cids = [...codes.keys()].sort((a, b) => a - b);
      const used = [...new Set([0, ...[...codes.values()].map((x) => x.g)])].sort((a, b) => a - b);
      const cps = [...new Set([...codes.values()].flatMap((x) => [...x.t].map((c) => /** @type {number} */ (c.codePointAt(0)))))];
      let file = bytes;
      if (sub && !(f.fsType & 0x0100)) { // 0x0100: the licence forbids subsetting
        if (typeof sub === 'function') {
          try {
            const s = await sub(bytes, cps, { glyphs: used });
            const p = parseFont(s, false); // the subset must still have every glyph drawn, at the same ID
            if (p.numGlyphs > used[used.length - 1]) file = s;
          } catch { /* the whole font */ }
        } else if (cffTable) file = subsetOtf(bytes, f.numGlyphs, used, seac);
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
        const all = [...new Set([...used, ...cids])], bits = new Uint8Array((Math.max(...all) >> 3) + 1), n = doc.reserve();
        for (const g of all) bits[g >> 3] |= 0x80 >> (g & 7);
        await doc.writeStream(n, '<< >>', bits);
        cidSet = ` /CIDSet ${n} 0 R`;
      }
      const s = (/** @type {number} */ v) => num(v * k);
      const flags = (f.fixedPitch ? 1 : 0) | 4 | (f.italicAngle ? 64 : 0);
      const [x0, y0, x1, y1] = f.bbox;
      await doc.write(desc, `<< /Type /FontDescriptor /FontName ${base} /Flags ${flags} /FontBBox [${s(x0)} ${s(y0)} ${s(x1)} ${s(y1)}] /ItalicAngle ${num(f.italicAngle)} /Ascent ${s(f.ascent)} /Descent ${s(f.descent)} /CapHeight ${s(f.capHeight)} /XHeight ${s(f.xHeight)} /StemV 0 /${cff ? 'FontFile3' : 'FontFile2'} ${fileRef} 0 R${cidSet} >>`);
      // widths: runs of consecutive glyph IDs, "first [w w w]"
      const wc = (cids.length ? cids : [0]).map((c) => [c, codes.get(c)?.g ?? 0]);
      let Wa = '';
      for (let i = 0; i < wc.length;) {
        let j = i;
        while (j + 1 < wc.length && wc[j + 1][0] === wc[j][0] + 1) j++;
        Wa += `${wc[i][0]} [${wc.slice(i, j + 1).map(([, g]) => s(f.advance(g))).join(' ')}] `;
        i = j + 1;
      }
      let c2g = ' /CIDToGIDMap /Identity';
      if (!cff && next > f.numGlyphs) { // codes past the glyphs: a map, two bytes a CID, the glyph's own ID below numGlyphs
        const m = new Uint8Array(2 * next), r = doc.reserve();
        for (let c = 0; c < next; c++) { const g = c < f.numGlyphs ? c : codes.get(c)?.g ?? 0; m[2 * c] = g >> 8; m[2 * c + 1] = g & 255; }
        await doc.writeStream(r, '<< >>', m);
        c2g = ` /CIDToGIDMap ${r} 0 R`;
      }
      await doc.write(cid, `<< /Type /Font /Subtype /${cff ? 'CIDFontType0' : 'CIDFontType2'} /BaseFont ${base} /CIDSystemInfo << /Registry ${ascii('Adobe')} /Ordering ${ascii('Identity')} /Supplement 0 >> /FontDescriptor ${desc} 0 R /W [${Wa}]${cff ? '' : c2g} >>`);
      await doc.writeStream(cmap, '<< >>', latin1(toUnicode(codes)));
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
/** An OpenType/CFF font subset by glyph ID (fonts/cff.js), or the whole font when it uses seac. @param {Uint8Array} bytes @param {number} n @param {number[]} used @param {boolean} seac */
function subsetOtf(bytes, n, used, seac) {
  const t = sfntTables(bytes), cff = subsetCff(/** @type {Uint8Array} */ (t.get('CFF ')), n, used, seac);
  if (!cff) return bytes;
  /** @type {Map<string, Uint8Array>} */
  const out = new Map();
  for (const tg of OTF_KEEP) { const x = t.get(tg); if (x) out.set(tg, x); }
  out.set('CFF ', cff);
  return buildSfnt(out, [0x4f, 0x54, 0x54, 0x4f]);
}

/**
 * ToUnicode: each code to the text it stands for (UTF-16BE); the later glyphs of a cluster stand for U+2060 (see shaped).
 * @param {Map<number, { t: string }>} codes
 */
function toUnicode(codes) {
  const entries = [...codes].map(([c, x]) => /** @type {[number, string]} */ ([c, x.t])).sort((a, b) => a[0] - b[0]);
  let body = '';
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    body += `${chunk.length} beginbfchar\n${chunk.map(([id, t]) => `<${hex4(id)}> <${utf16(t)}>`).join('\n')}\nendbfchar\n`;
  }
  return `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <ffff>\nendcodespacerange\n${body}endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`;
}

/** a variable font's axes at their defaults, "wght 100, wdth 100", or '' (no fvar, or a broken one) @param {Uint8Array | undefined} t */
function variation(t) {
  if (!t || t.length < 16) return '';
  const dv = new DataView(t.buffer, t.byteOffset, t.byteLength), off = dv.getUint16(4), n = dv.getUint16(8), size = dv.getUint16(10);
  const out = [];
  for (let i = 0; i < Math.min(n, 16) && size >= 20 && off + i * size + 20 <= t.length; i++) {
    const p = off + i * size;
    out.push(`${String.fromCharCode(...t.subarray(p, p + 4)).replace(/[^\x20-\x7e]/g, '?')} ${Math.round(dv.getInt32(p + 8) / 655.36) / 100}`);
  }
  return out.join(', ') || 'no axes read';
}

/** Six capital letters from the subset's bytes (FNV-1a): the subset's tag. @param {Uint8Array} bytes */
function tag(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619);
  let t = '';
  for (let i = 0; i < 6; i++) { t += String.fromCharCode(65 + ((h >>> 0) % 26)); h = Math.imul(h ^ i, 16777619) >>> 0; }
  return t;
}
