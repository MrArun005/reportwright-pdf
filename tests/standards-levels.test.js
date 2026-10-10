// PDF/A levels (group G): 1b, 2b, 2u, 2a, 3b, 3u, 3a checked by veraPDF (0 failed rules) on a document with text, a
// table, a list, headings, images, links, a note, form fields, layers and attachments as each level allows; the XMP
// identification; PDF/A-1's PDF 1.4 file (classic xref, no object streams) and what it refuses; the Unicode rule of u/a.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { toBytes, createPdf } from '../src/index.js';
import { HAS, INTER, verapdf, pdftotext, pdfinfo, latin, ROOT } from './tools.js';
import { rich, DATE, RGBA, CSV } from './standards-fixture.js';
import { png } from './image-fixtures.js';

const level = (part, conformance, extra = {}) => ({ title: 'Invoice', author: 'Acme', subject: 'An invoice', keywords: 'invoice, 2026', pdfa: { part, conformance }, creationDate: DATE, ...extra });
const xmpOf = (b) => /<\?xpacket begin[\s\S]*?<\?xpacket end="w"\?>/.exec(latin(b))?.[0] ?? '';

describe.skipIf(!HAS.verapdf)('veraPDF, every level claimed', () => {
  for (const fl of ['1b', '2b', '2u', '2a', '3b', '3u', '3a']) {
    const part = Number(fl[0]), c = fl[1], tagged = c === 'a';
    it(`PDF/A-${fl}${tagged ? ' (and PDF/UA-1)' : ''}: 0 failed rules`, async () => {
      const out = await toBytes((pdf) => rich(pdf, { part }), level(part, c, tagged ? { tagged: { lang: 'en' } } : {}));
      const r = verapdf(out, fl);
      expect(r.failed).toEqual([]);
      expect(r.ok).toBe(true);
      if (tagged) expect(verapdf(out, 'ua1').failed).toEqual([]);
      const x = xmpOf(out);
      expect(x).toContain(`<pdfaid:part>${part}</pdfaid:part><pdfaid:conformance>${c.toUpperCase()}</pdfaid:conformance>`);
      expect(x).toContain('<pdf:Keywords>invoice, 2026</pdf:Keywords>');
      if (HAS.poppler) expect(pdftotext(out)).toMatch(/Ünïcødé text and a link to\s+example\.com/);
    }, 60000);
  }

  it('PDF/A-2u and 3u tagged pass PDF/UA-1 too; pdfa: true is still PDF/A-2b', async () => {
    const u = await toBytes((pdf) => rich(pdf, { part: 3 }), level(3, 'u', { tagged: { lang: 'en' } }));
    expect(verapdf(u, '3u').failed).toEqual([]);
    expect(verapdf(u, 'ua1').failed).toEqual([]);
    const b = await toBytes((pdf) => rich(pdf, { part: 2 }), { title: 'T', pdfa: true, creationDate: DATE });
    expect(xmpOf(b)).toContain('<pdfaid:part>2</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>');
    expect(verapdf(b, '2b').failed).toEqual([]);
  }, 60000);
});

describe('PDF/A-1b: PDF 1.4', () => {
  it('a classic xref table and trailer, no object or xref streams, %PDF-1.4; pdf-lib and poppler read it', async () => {
    const out = await toBytes((pdf) => rich(pdf, { part: 1 }), level(1, 'b'));
    const s = latin(out);
    expect(s.startsWith('%PDF-1.4\n')).toBe(true);
    expect(s).not.toMatch(/\/ObjStm|\/XRef|\/OCProperties|\/EmbeddedFiles/);
    const xref = s.lastIndexOf('\nxref\n');
    expect(Number(/startxref\n(\d+)\n%%EOF\n$/.exec(s)[1])).toBe(xref + 1);
    const [, first, count] = /xref\n(\d+) (\d+)\n/.exec(s.slice(xref));
    expect(first).toBe('0');
    const rows = s.slice(xref + 1).split('\n').slice(2, 2 + Number(count)).join('\n');
    expect(rows.split('\r').length - 1).toBe(Number(count)); // 20-byte rows ending in CR LF
    for (const [, off, kind] of rows.matchAll(/(\d{10}) \d{5} ([nf])\r/g)) if (kind === 'n') expect(s.slice(Number(off)).match(/^\d+ 0 obj/)).not.toBeNull();
    expect((await PDFDocument.load(out)).getPageCount()).toBe(1);
    if (HAS.poppler) expect(pdfinfo(out)).toMatch(/PDF version:\s+1\.4/);
    expect(s).toMatch(/\/CIDSet \d+ 0 R/); // subset CIDFonts list their CIDs (ISO 19005-1 6.3.5)
  });

  it.skipIf(!HAS.verapdf)('gradients, a tiling pattern, a clip, a spot colour and dashes pass veraPDF 1b (shadings are PDF 1.3)', async () => {
    const out = await toBytes(async (pdf) => {
      const f = await pdf.embedFont(INTER), spot = pdf.spotColor('PANTONE 185 C', [0.9, 0.1, 0.2]), p = pdf.addPage();
      p.fill(p.path().rect(40, 40, 200, 100), { fill: p.linearGradient(40, 40, 240, 40, [[0, '#f00'], [0.5, '#0f0'], [1, '#00f']]) });
      p.fill(p.path().rect(40, 160, 200, 100), { fill: p.radialGradient(140, 210, 0, 140, 210, 80, [[0, '#fff'], [1, '#0a0']]) });
      p.fill(p.path().rect(40, 280, 200, 100), { fill: p.tilingPattern({ width: 10, height: 10 }, (c) => c.fill(c.path().rect(0, 0, 5, 5), { fill: '#333' })) });
      p.save(); p.clip(p.path().arc(400, 100, 50, 0, 6.28)); p.rect(300, 0, 200, 200, { fill: spot }); p.restore();
      p.stroke(p.path().moveTo(300, 300).lineTo(500, 350), { stroke: '#000', width: 2, dash: [4, 2] });
      p.text('Graphics', { x: 40, y: 400, font: f });
    }, level(1, 'b'));
    expect(verapdf(out, '1b').failed).toEqual([]);
  }, 60000);

  it('refuses what PDF 1.4 / PDF/A-1 cannot hold: transparency, soft masks, 16-bit images, layers, attachments, UserUnit, 1a', async () => {
    const make = () => createPdf({ write() {} }, level(1, 'b'));
    const pdf = make(), f = await pdf.embedFont(INTER), p = pdf.addPage();
    expect(() => p.fill(p.path().rect(0, 0, 10, 10), { fill: 0.5, opacity: 0.5 })).toThrow(/PDF\/A-1.*forbids transparency/);
    expect(() => p.fill(p.path().rect(0, 0, 10, 10), { fill: 0.5, blendMode: 'Multiply' })).toThrow(/forbids transparency/);
    expect(() => p.highlight({ x: 0, y: 0, width: 10, height: 10 }, { contents: 'x' })).toThrow(/forbids transparency/);
    await expect(pdf.embedImage(RGBA)).rejects.toThrow(/PDF\/A-1.*soft masks/);
    await expect(pdf.embedImage(png({ w: 2, h: 2, type: 2, depth: 16, px: () => [1, 2, 3] }))).rejects.toThrow(/16-bit/);
    expect(() => pdf.layer('L')).toThrow(/PDF\/A-1.*optional content/);
    await expect(pdf.attach(CSV, { name: 'a.csv', mimeType: 'text/csv' })).rejects.toThrow(/PDF\/A-1 forbids embedded files/);
    expect(() => pdf.addPage({ userUnit: 2 })).toThrow(/UserUnit/);
    expect(() => createPdf({ write() {} }, { pdfa: { part: 1, conformance: 'a' }, tagged: true, title: 't' })).toThrow(/PDF\/A-1a is not offered/);
    p.text('ok', { x: 10, y: 10, font: f });
    await pdf.end();
  });

  it('an OpenType/CFF font goes in as its bare CFF (FontFile3 /CIDFontType0C: PDF 1.4 has no OpenType) and draws the same', async () => {
    const SC = fs.readFileSync(`${ROOT}/tests/fixtures/fonts/NotoSansSC-Subset.otf`);
    const make = (part) => toBytes(async (pdf) => { const f = await pdf.embedFont(SC); pdf.addPage().text('中文', { x: 40, y: 40, font: f, size: 30 }); }, level(part, 'b', { compress: false }));
    const a1 = await make(1), a2 = await make(2);
    expect(latin(a1)).toContain('/Subtype /CIDFontType0C');
    expect(latin(a2)).toContain('/Subtype /OpenType');
    if (HAS.verapdf) expect(verapdf(a1, '1b').failed).toEqual([]);
    if (HAS.poppler) expect(pdftotext(a1).trim()).toBe('中文');
  }, 60000);
});

describe('levels: options and the Unicode rule', () => {
  it('pdfa options are checked; a needs tagged', () => {
    const c = (pdfa, o = {}) => () => createPdf({ write() {} }, { title: 't', pdfa, ...o });
    expect(c({ part: 4 })).toThrow(/part is 1, 2 or 3/);
    expect(c({ conformance: 'x' })).toThrow(/conformance is 'a', 'b' or 'u'/);
    expect(c('yes')).toThrow(/pdfa is true or/);
    expect(c({ part: 2, conformance: 'a' })).toThrow(/tagged/);
    expect(c({ part: 2, conformance: 'a' }, { tagged: true })).not.toThrow();
    expect(() => createPdf({ write() {} }, { keywords: 7 })).toThrow(/keywords is a string/);
  });

  it('u and a: a character the font lacks throws (2b drops it with a warning)', async () => {
    const draw = (o) => toBytes(async (pdf) => { const f = await pdf.embedFont(INTER); pdf.addPage().text('A \u{1F600} B', { x: 10, y: 10, font: f }); }, { title: 't', creationDate: DATE, ...o });
    await expect(draw({ pdfa: { part: 2, conformance: 'u' } })).rejects.toThrow(/PDF\/A-2u: .* has no glyph for "😀" \(U\+1F600\).*map to Unicode/);
    await expect(draw({ pdfa: { part: 3, conformance: 'a' }, tagged: true })).rejects.toThrow(/PDF\/A-3a/);
    const warned = [];
    const pdf = createPdf({ write() {} }, { title: 't', pdfa: true });
    const f = await pdf.embedFont(INTER);
    pdf.addPage().text('A \u{1F600} B', { x: 10, y: 10, font: f });
    warned.push(...(await pdf.end()).warnings);
    expect(warned.join()).toMatch(/no glyph/);
  });
});
