// Embedded TrueType: Unicode text through Identity-H + ToUnicode (pdftotext extracts it), subsetting (built in, off,
// or a subsetter function such as HarfBuzz's), metrics.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { toBytes, createPdf } from '../src/index.js';
import { parseFont } from '../src/fonts/truetype.js';
import { subsetGlyf, compactGlyf, buildSfnt } from '../src/fonts/subset.js';
import { sfntTables } from '../src/fonts/truetype.js';
import { INTER, MONO, ROOT, HAS, pdftotext, pdffonts, latin } from './tools.js';

const DATE = new Date('2026-01-01');
const TEXT = 'Grüße, Ελληνικά, Кириллица — €100 “ok” ✓';
const draw = (font, opt, txt = TEXT, o = {}) =>
  toBytes(
    async (pdf) => {
      const f = await pdf.embedFont(font, opt);
      pdf.addPage().text(txt, { x: 20, y: 20, font: f, size: 14 });
    },
    { creationDate: DATE, ...o },
  );

describe('embedded TrueType', () => {
  it('a variable font (an fvar table) is embedded at its default instance, with a warning that says which', async () => {
    const fvar = Buffer.alloc(36); // one axis, wght 100 to 900, default 100 (as Noto Sans JP's Thin)
    fvar.writeUInt16BE(1, 0);
    fvar.writeUInt16BE(16, 4);
    fvar.writeUInt16BE(2, 6);
    fvar.writeUInt16BE(1, 8);
    fvar.writeUInt16BE(20, 10);
    fvar.writeUInt16BE(8, 14);
    fvar.write('wght', 16, 'latin1');
    fvar.writeInt32BE(100 << 16, 20);
    fvar.writeInt32BE(100 << 16, 24);
    fvar.writeInt32BE(900 << 16, 28);
    const t = sfntTables(INTER);
    t.set('fvar', new Uint8Array(fvar));
    let r;
    await toBytes(
      async (pdf) => {
        pdf.addPage().text('Hi', { font: await pdf.embedFont(buildSfnt(t)) });
        const end = pdf.end;
        pdf.end = async () => (r = await end());
      },
      { creationDate: DATE },
    );
    expect(r.warnings.join()).toMatch(
      /Inter-Regular is a variable font: it is drawn at its default instance \(wght 100\)/,
    );
    let plain;
    await toBytes(async (pdf) => {
      pdf.addPage().text('Hi', { font: await pdf.embedFont(INTER) });
      const end = pdf.end;
      pdf.end = async () => (plain = await end());
    });
    expect(plain.warnings).toEqual([]);
  });

  it('Unicode text extracts exactly; the font is embedded, subset, with a ToUnicode map', async () => {
    const out = await draw(INTER);
    if (!HAS.poppler) return;
    expect(pdftotext(out).trim()).toBe(TEXT);
    expect(pdffonts(out)).toMatch(/^[A-Z]{6}\+Inter-Regular\s+CID TrueType\s+Identity-H\s+yes yes yes/m);
  });

  it('the built-in subset is far smaller than the whole font and keeps glyph IDs', async () => {
    const sub = await draw(INTER),
      whole = await draw(INTER, { subset: false });
    expect(sub.length).toBeLessThan(whole.length / 4);
    if (HAS.poppler) {
      expect(pdffonts(whole)).toMatch(/^Inter-Regular\s+CID TrueType\s+Identity-H\s+yes no\s+yes/m);
      expect(pdftotext(whole).trim()).toBe(TEXT);
    }
    const f = parseFont(INTER),
      g = f.glyphFor(0x47); // G
    const s = parseFont(subsetGlyf(INTER, [g]), false);
    expect(s.numGlyphs).toBe(f.numGlyphs);
    expect(s.advance(g)).toBe(f.advance(g));
  });

  it('the built-in subset renumbers: only the glyphs used (and .notdef and components), and only the tables a PDF needs', async () => {
    const f = parseFont(INTER),
      H = f.glyphFor(0x48),
      i = f.glyphFor(0x69);
    const { file, gid } = compactGlyf(INTER, [i, H, i]);
    const s = parseFont(file, false);
    expect(s.numGlyphs).toBe(gid.size); // .notdef, H, i, and i's components (dotless i, the dot)
    expect(s.numGlyphs).toBeLessThan(8);
    expect([...gid.keys()]).toEqual([...gid.keys()].sort((a, b) => a - b));
    expect([...gid.values()]).toEqual([...gid.keys()].map((_, k) => k));
    expect(gid.get(0)).toBe(0);
    expect(s.advance(gid.get(H))).toBe(f.advance(H));
    expect(s.advance(gid.get(i))).toBe(f.advance(i));
    expect([...sfntTables(file).keys()].sort()).toEqual(['glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'prep']);
  });

  it('a composite glyph keeps its components, renumbered to their new IDs', async () => {
    const f = parseFont(INTER),
      U = f.glyphFor(0xdc); // Ü: U and the dieresis
    const { file, gid } = compactGlyf(INTER, [U]);
    const t = sfntTables(file),
      n = parseFont(file, false).numGlyphs;
    expect(n).toBeGreaterThan(2);
    const lv = new DataView(t.get('loca').buffer, t.get('loca').byteOffset),
      long = t.get('head')[51] === 1,
      at = (g) => (long ? lv.getUint32(g * 4) : lv.getUint16(g * 2) * 2),
      gl = t.get('glyf'),
      gv = new DataView(gl.buffer, gl.byteOffset);
    const p0 = at(gid.get(U));
    expect(gv.getInt16(p0)).toBe(-1);
    let p = p0 + 10,
      flags,
      comps = [];
    do {
      flags = gv.getUint16(p);
      comps.push(gv.getUint16(p + 2));
      p += 4 + (flags & 1 ? 4 : 2) + (flags & 8 ? 2 : flags & 0x40 ? 4 : flags & 0x80 ? 8 : 0);
    } while (flags & 0x20);
    for (const c of comps) {
      expect(c).toBeGreaterThan(0);
      expect(c).toBeLessThan(n);
      expect(at(c + 1) - at(c)).toBeGreaterThan(0); // its outline is there
    }
  });

  it('a renumbered font draws through a CIDToGIDMap stream; a subsetter function keeps the identity', async () => {
    const out = latin(await draw(INTER, undefined, TEXT, { compress: false }));
    expect(out).toMatch(/\/CIDToGIDMap \d+ 0 R/);
    expect(out).not.toMatch(/\/FontName \/[A-Z]{6}\+Inter-Regular[^]*?\/CIDToGIDMap \/Identity/);
    const fn = latin(await draw(INTER, { subset: (font) => font }, TEXT, { compress: false }));
    expect(fn).toMatch(/\/CIDToGIDMap \/Identity/);
  });

  it('a 19-character line embeds a font file a few KB long', async () => {
    const out = latin(await draw(INTER, undefined, 'Hello, world! 12345', { compress: false }));
    const len = Number(/\/Length1 (\d+)/.exec(out)[1]);
    expect(len).toBeLessThan(6000);
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
    const out = await draw(INTER, {
      subset: async (font, cps) => {
        calls++;
        return font;
      },
    });
    expect(calls).toBe(1);
    if (HAS.poppler) {
      expect(pdftotext(out).trim()).toBe(TEXT);
    }
    const bad = await draw(INTER, { subset: () => new Uint8Array(10) });
    if (HAS.poppler) {
      expect(pdffonts(bad)).toMatch(/^Inter-Regular\s+CID TrueType\s+Identity-H\s+yes no/m);
      expect(pdftotext(bad).trim()).toBe(TEXT);
    }
  });

  it('missing glyphs: drawn as .notdef normally, dropped in PDF/UA, reported either way', async () => {
    let r;
    const txt = 'A中B';
    const out = await toBytes(
      async (pdf) => {
        const f = await pdf.embedFont(INTER);
        pdf.addPage().text(txt, { x: 10, y: 10, font: f });
        const end = pdf.end;
        pdf.end = async () => (r = await end());
      },
      { creationDate: DATE, compress: false },
    );
    expect(r.warnings.join()).toMatch(/Inter-Regular has no glyph for "中"/);
    const P = parseFont(INTER),
      two = (c) => {
        const g = P.glyphFor(c.codePointAt(0));
        return String.fromCharCode(g >> 8, g & 255);
      };
    expect(latin(out)).toContain(`(${two('A')}\0\0${two('B')}) Tj`); // A, .notdef (glyph 0), B: two bytes a glyph
    expect(latin(out)).toContain('<0000> <4e2d>'); // .notdef stands for 中 in the ToUnicode: copied text keeps it
    const ua = await draw(INTER, undefined, txt, { tagged: { lang: 'en' }, title: 't', compress: false });
    expect(latin(ua)).toContain(`(${two('A')}${two('B')}) Tj`);
  });

  it('widthOf and the vertical metrics come from hmtx and hhea', async () => {
    const pdf = createPdf({ write() {} });
    const f = await pdf.embedFont(INTER);
    const p = parseFont(INTER);
    const want = (['H', 'i'].reduce((t, c) => t + p.advance(p.glyphFor(c.codePointAt(0))), 0) * 10) / p.unitsPerEm;
    expect(f.widthOf('Hi', 10)).toBeCloseTo(want, 6);
    expect(f.ascent).toBeCloseTo(p.ascent / p.unitsPerEm);
    expect(f.descent).toBeLessThan(0);
  });

  it("subsetting leaves the caller's bytes alone (a Node Buffer, whose slice() is a view)", async () => {
    const b = fs.readFileSync(path.join(ROOT, 'public/fonts/Inter-Regular.ttf')),
      before = Buffer.from(b);
    await draw(b);
    expect(b.equals(before)).toBe(true);
  });

  it('accepts an ArrayBuffer', async () => {
    const out = await draw(INTER.buffer.slice(INTER.byteOffset, INTER.byteOffset + INTER.byteLength), undefined, 'ab');
    if (HAS.poppler) expect(pdftotext(out).trim()).toBe('ab');
  });
});
