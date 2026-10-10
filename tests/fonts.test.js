// Embedded TrueType: Unicode text through Identity-H + ToUnicode (pdftotext extracts it), subsetting (built in, off,
// or a subsetter function such as HarfBuzz's), metrics.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { toBytes, createPdf } from '../src/index.js';
import { parseFont } from '../src/fonts/truetype.js';
import { subsetGlyf, buildSfnt } from '../src/fonts/subset.js';
import { sfntTables } from '../src/fonts/truetype.js';
import { INTER, MONO, ROOT, HAS, pdftotext, pdffonts, latin } from './tools.js';

const DATE = new Date('2026-01-01');
const TEXT = 'Grüße, Ελληνικά, Кириллица — €100 “ok” ✓';
const draw = (font, opt, txt = TEXT, o = {}) => toBytes(async (pdf) => {
  const f = await pdf.embedFont(font, opt);
  pdf.addPage().text(txt, { x: 20, y: 20, font: f, size: 14 });
}, { creationDate: DATE, ...o });

describe('embedded TrueType', () => {
  it('a variable font (an fvar table) is embedded at its default instance, with a warning that says which', async () => {
    const fvar = Buffer.alloc(36); // one axis, wght 100 to 900, default 100 (as Noto Sans JP's Thin)
    fvar.writeUInt16BE(1, 0); fvar.writeUInt16BE(16, 4); fvar.writeUInt16BE(2, 6); fvar.writeUInt16BE(1, 8); fvar.writeUInt16BE(20, 10); fvar.writeUInt16BE(8, 14);
    fvar.write('wght', 16, 'latin1'); fvar.writeInt32BE(100 << 16, 20); fvar.writeInt32BE(100 << 16, 24); fvar.writeInt32BE(900 << 16, 28);
    const t = sfntTables(INTER); t.set('fvar', new Uint8Array(fvar));
    let r;
    await toBytes(async (pdf) => {
      pdf.addPage().text('Hi', { font: await pdf.embedFont(buildSfnt(t)) });
      const end = pdf.end; pdf.end = async () => (r = await end());
    }, { creationDate: DATE });
    expect(r.warnings.join()).toMatch(/Inter-Regular is a variable font: it is drawn at its default instance \(wght 100\)/);
    let plain; await toBytes(async (pdf) => { pdf.addPage().text('Hi', { font: await pdf.embedFont(INTER) }); const end = pdf.end; pdf.end = async () => (plain = await end()); });
    expect(plain.warnings).toEqual([]);
  });

  it('Unicode text extracts exactly; the font is embedded, subset, with a ToUnicode map', async () => {
    const out = await draw(INTER);
    if (!HAS.poppler) return;
    expect(pdftotext(out).trim()).toBe(TEXT);
    expect(pdffonts(out)).toMatch(/^[A-Z]{6}\+Inter-Regular\s+CID TrueType\s+Identity-H\s+yes yes yes/m);
  });

  it('the built-in subset is far smaller than the whole font and keeps glyph IDs', async () => {
    const sub = await draw(INTER), whole = await draw(INTER, { subset: false });
    expect(sub.length).toBeLessThan(whole.length / 4);
    if (HAS.poppler) {
      expect(pdffonts(whole)).toMatch(/^Inter-Regular\s+CID TrueType\s+Identity-H\s+yes no\s+yes/m);
      expect(pdftotext(whole).trim()).toBe(TEXT);
    }
    const f = parseFont(INTER), g = f.glyphFor(0x47); // G
    const s = parseFont(subsetGlyf(INTER, [g]), false);
    expect(s.numGlyphs).toBe(f.numGlyphs);
    expect(s.advance(g)).toBe(f.advance(g));
  });

  it('a short-loca font (JetBrains Mono) subsets and extracts', async () => {
    const out = await draw(MONO, undefined, 'const x = 42; // mono');
    if (HAS.poppler) {
      expect(pdftotext(out).trim()).toBe('const x = 42; // mono');
      expect(pdffonts(out)).toMatch(/\+JetBrainsMono-Regular\s+CID TrueType\s+Identity-H\s+yes yes yes/);
    }
  });

  it('a subsetter function is used when given; a bad one falls back to the whole font', async () => {
    let calls = 0;
    const out = await draw(INTER, { subset: async (font, cps) => { calls++; return font; } });
    expect(calls).toBe(1);
    if (HAS.poppler) { expect(pdftotext(out).trim()).toBe(TEXT); }
    const bad = await draw(INTER, { subset: () => new Uint8Array(10) });
    if (HAS.poppler) { expect(pdffonts(bad)).toMatch(/^Inter-Regular\s+CID TrueType\s+Identity-H\s+yes no/m); expect(pdftotext(bad).trim()).toBe(TEXT); }
  });

  it('missing glyphs: drawn as .notdef normally, dropped in PDF/UA, reported either way', async () => {
    let r;
    const txt = 'A中B';
    const out = await toBytes(async (pdf) => {
      const f = await pdf.embedFont(INTER);
      pdf.addPage().text(txt, { x: 10, y: 10, font: f });
      const end = pdf.end; pdf.end = async () => (r = await end());
    }, { creationDate: DATE, compress: false });
    expect(r.warnings.join()).toMatch(/Inter-Regular has no glyph for "中"/);
    const P = parseFont(INTER), two = (c) => { const g = P.glyphFor(c.codePointAt(0)); return String.fromCharCode(g >> 8, g & 255); };
    expect(latin(out)).toContain(`(${two('A')}\0\0${two('B')}) Tj`); // A, .notdef (glyph 0), B: two bytes a glyph
    expect(latin(out)).toContain('<0000> <4e2d>'); // .notdef stands for 中 in the ToUnicode: copied text keeps it
    const ua = await draw(INTER, undefined, txt, { tagged: { lang: 'en' }, title: 't', compress: false });
    expect(latin(ua)).toContain(`(${two('A')}${two('B')}) Tj`);
  });

  it('widthOf and the vertical metrics come from hmtx and hhea', async () => {
    const pdf = createPdf({ write() {} });
    const f = await pdf.embedFont(INTER);
    const p = parseFont(INTER);
    const want = ['H', 'i'].reduce((t, c) => t + p.advance(p.glyphFor(c.codePointAt(0))), 0) * 10 / p.unitsPerEm;
    expect(f.widthOf('Hi', 10)).toBeCloseTo(want, 6);
    expect(f.ascent).toBeCloseTo(p.ascent / p.unitsPerEm);
    expect(f.descent).toBeLessThan(0);
  });

  it("subsetting leaves the caller's bytes alone (a Node Buffer, whose slice() is a view)", async () => {
    const b = fs.readFileSync(path.join(ROOT, 'public/fonts/Inter-Regular.ttf')), before = Buffer.from(b);
    await draw(b);
    expect(b.equals(before)).toBe(true);
  });

  it('accepts an ArrayBuffer', async () => {
    const out = await draw(INTER.buffer.slice(INTER.byteOffset, INTER.byteOffset + INTER.byteLength), undefined, 'ab');
    if (HAS.poppler) expect(pdftotext(out).trim()).toBe('ab');
  });
});
