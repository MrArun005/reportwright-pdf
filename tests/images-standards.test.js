// Images in tagged PDFs and PDF/A: page.image's alt makes a Figure, no alt an artifact; veraPDF PDF/UA-1 and PDF/A-2b
// on a tagged page with JPEG and PNG (alpha, palette, 16-bit) images, alt text and an ICC colour space.
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFDict } from 'pdf-lib';
import { toBytes } from '../src/index.js';
import { HAS, INTER, latin, verapdf } from './tools.js';
import { png, sharp, profile } from './image-fixtures.js';

const DATE = new Date('2026-01-01');
const SRGB = profile('sRGB Profile.icc');
const rgba = png({ w: 24, h: 24, type: 6, depth: 8, px: (x, y) => [x * 10, y * 10, 128, (x + y) * 5] });
const pal = png({ w: 16, h: 16, type: 3, depth: 4, interlace: 1, px: (x) => [x % 3], palette: [[255, 0, 0], [0, 128, 0], [0, 0, 255]], trns: [255, 128] });
const deep = png({ w: 16, h: 8, type: 2, depth: 16, px: (x) => [x * 4000, 30000, 65535 - x * 4000] });

async function tagged(o = {}) {
  return toBytes(async (pdf) => {
    const font = await pdf.embedFont(INTER);
    const p = pdf.addPage();
    p.tag('H1', () => p.text('Images', { x: 40, y: 40, font, size: 20 }));
    const a = await pdf.embedImage(rgba), b = await pdf.embedImage(pal), c = await pdf.embedImage(deep);
    p.image(a, { x: 40, y: 80, width: 96, alt: 'A gradient square, fading in from the top left' });
    p.image(b, { x: 160, y: 80, width: 96, alt: 'Stripes of red, green and blue' });
    p.image(c, { x: 280, y: 80, width: 128, opacity: 0.8 }); // decoration: an artifact
    if (sharp) {
      const jpg = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#4080c0' } }).jpeg({ progressive: true }).toBuffer();
      const icc = SRGB ? await pdf.iccColorSpace(SRGB) : null;
      const j = await pdf.embedImage(jpg, icc ? { colorSpace: icc } : {});
      p.image(j, { x: 40, y: 200, width: 120, height: 60, fit: 'cover', alt: 'A blue photo' });
      if (icc) p.figure({ alt: 'A dark blue bar' }, () => p.rect(180, 200, 100, 20, { fill: icc.color(0.1, 0.2, 0.5) }));
    }
  }, { title: 'Images', tagged: { lang: 'en' }, creationDate: DATE, ...o });
}

describe('tagged images', () => {
  it('alt makes a Figure with /Alt; no alt is an artifact; a blank alt throws', async () => {
    const out = await tagged({ compress: false });
    const t = latin(out);
    expect(t.match(/\/Figure <<\/MCID \d+>> BDC\nq [^\n]* Do Q\n/g)).toHaveLength(sharp ? 3 : 2);
    expect(t).toMatch(/\/Artifact BMC\nq \/GS\d+ gs [^\n]* Do Q\n/);
    const doc = await PDFDocument.load(out);
    const root = doc.catalog.lookup(PDFName.of('StructTreeRoot'), PDFDict);
    expect(root).toBeTruthy();
    expect(t).toContain('/Alt <feff');
    await expect(toBytes(async (pdf) => { pdf.addPage().image(await pdf.embedImage(rgba), { alt: '  ' }); }, { title: 'T', tagged: true })).rejects.toThrow(/alt is a non-empty string/);
  });
  it.skipIf(!SRGB || !sharp)('an image tagged with an ICC colour space uses it; the component count must match', async () => {
    const out = await tagged({ compress: false });
    expect(latin(out)).toMatch(/\/ColorSpace \[\/ICCBased \d+ 0 R\] \/BitsPerComponent 8 \/Filter \/DCTDecode/);
    await expect(toBytes(async (pdf) => { const icc = await pdf.iccColorSpace(SRGB); await pdf.embedImage(png({ w: 1, h: 1, type: 0, depth: 8, px: () => [0] }), { colorSpace: icc }); })).rejects.toThrow(/1 colour components, the ICC colour space 3/);
  });
  it.skipIf(!HAS.verapdf)('veraPDF PDF/UA-1 and PDF/A-2b: 0 failed rules', async () => {
    const out = await tagged({ pdfa: true });
    await PDFDocument.load(out);
    for (const flavour of ['ua1', '2b']) {
      const r = verapdf(out, flavour);
      expect(r.failed, flavour).toEqual([]);
      expect(r.ok, flavour).toBe(true);
    }
  });
});
