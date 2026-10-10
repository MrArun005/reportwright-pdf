// PDF names: #xx escaping (PDF 1.7 §7.3.5) keeps a name's exact text and leaves no delimiter for injection.
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFArray } from 'pdf-lib';
import { toBytes, cmyk } from '../src/index.js';
import { pdfName, fontName } from '../src/core/serialize.js';
import { INTER, HAS, latin, verapdf } from './tools.js';

const EVIL = [
  'A /OpenAction << /S /JavaScript /JS (app.alert(1)) >>',
  'x) Tj ET 1 0 0 RG (',
  'a\nb\r%c',
  'B#20C',
  '[]{}<>',
];

describe('pdfName', () => {
  it('escapes white space, delimiters, # and non-ASCII as #xx (UTF-8 bytes), drops NUL, caps at 127 bytes', () => {
    expect(pdfName('PANTONE 185 C')).toBe('/PANTONE#20185#20C');
    expect(pdfName('a b/c#d')).toBe('/a#20b#2Fc#23d');
    expect(pdfName('()<>[]{}/%#')).toBe('/#28#29#3C#3E#5B#5D#7B#7D#2F#25#23');
    expect(pdfName('é€')).toBe('/#C3#A9#E2#82#AC');
    expect(pdfName('a\0b')).toBe('/ab');
    expect(pdfName('')).toBe('/X');
    expect(pdfName(null, 'Font')).toBe('/Font');
    expect(pdfName('\0')).toBe('/X');
    expect(pdfName('N'.repeat(500))).toBe(`/${'N'.repeat(127)}`);
    expect(pdfName('€'.repeat(50))).toBe(`/${'#E2#82#AC'.repeat(42)}`); // 42 × 3 = 126 bytes: not cut inside a character
    for (const s of EVIL)
      (expect(pdfName(s).slice(1)).toMatch(/^[!-~]+$/), expect(pdfName(s).slice(1)).not.toMatch(/[()<>[\]{}/%\s]/));
    expect(fontName('PANTONE 185 C')).toBe('/PANTONE-185-C'); // fonts keep the stricter PostScript-name rule
  });

  it('a spot colour round-trips exactly through pdf-lib; injection strings stay inside one name', async () => {
    const out = await toBytes(
      (pdf) => {
        const p = pdf.addPage();
        p.rect(0, 0, 10, 10, { fill: pdf.spotColor('PANTONE 185 C', cmyk(0, 0.91, 0.76, 0)) });
        EVIL.forEach((n, i) => p.rect(0, 20 + i * 10, 10, 10, { fill: pdf.spotColor(n, '#CC0000') }));
      },
      { compress: false, creationDate: new Date(0) },
    );
    const s = latin(out);
    expect(s).toContain('/Separation /PANTONE#20185#20C /DeviceCMYK');
    expect(s).not.toMatch(/\/OpenAction|\/JavaScript|\(app\.alert/);
    const doc = await PDFDocument.load(out);
    expect(doc.catalog.get(PDFName.of('OpenAction'))).toBeUndefined();
    const names = [];
    doc.context.enumerateIndirectObjects().forEach(([, o]) => {
      const cs = o?.get?.(PDFName.of('ColorSpace'));
      if (cs)
        for (const [, v] of cs.entries()) {
          const a = v instanceof PDFArray ? v : doc.context.lookup(v);
          names.push(a.get(1).decodeText());
        }
    });
    expect(names).toContain('PANTONE 185 C');
    for (const n of EVIL) expect(names).toContain(n.replace(/\0/g, ''));
  });

  it.skipIf(!HAS.verapdf)('veraPDF A-2b: 0 failed rules with escaped spot names', async () => {
    const out = await toBytes(
      async (pdf) => {
        const f = await pdf.embedFont(INTER);
        const p = pdf.addPage();
        p.text('Spot', { x: 10, y: 10, font: f, color: pdf.spotColor('PANTONE 185 C', '#E4002b') });
        p.rect(10, 40, 50, 50, { fill: pdf.spotColor('Brand / Red é', '#CC0000').tint(0.5) });
      },
      { pdfa: true, title: 'Names', creationDate: new Date(0) },
    );
    expect(verapdf(out, '2b').failed).toEqual([]);
  });
});
