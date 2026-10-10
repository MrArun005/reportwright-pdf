// PDF/UA-1 and PDF/A-2b, checked by veraPDF (0 failed rules), and the structure tree's shape.
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFDict } from 'pdf-lib';
import { toBytes, createPdf } from '../src/index.js';
import { INTER, MONO, HAS, verapdf, pdftotext } from './tools.js';

const DATE = new Date('2026-01-01');

/** a tagged report: headings, paragraphs, a table, a list, links (inside text and alone), decoration, 3 pages, outline */
async function sample(pdf) {
  const f = await pdf.embedFont(INTER), m = await pdf.embedFont(MONO);
  const pages = [];
  for (let n = 1; n <= 3; n++) {
    const p = pdf.addPage();
    pages.push(p);
    p.rect(0, 0, 595.28, 40, { fill: '#eef3f8' }); // a header band: an artifact
    p.text(`Report — page ${n}`, { x: 40, y: 12, font: f, size: 9, color: 0.4 }); // running header: an artifact
    p.tag('H1', () => p.text(`Section ${n}`, { x: 40, y: 60, font: f, size: 22 }));
    p.tag('P', () => {
      p.text('Revenue grew in every region. See ', { x: 40, y: 100, font: f });
      p.tag('Link', () => { p.text('the appendix', { x: 230, y: 100, font: f, color: '#0645ad' }); p.link(230, 100, 70, 14, { page: 3, top: 50 }, { alt: 'Go to the appendix' }); });
    });
    p.tag('Table', () => {
      p.tag('TR', () => ['Region', 'Q1', 'Q2'].forEach((h, i) => p.tag('TH', () => p.text(h, { x: 40 + i * 120, y: 140, font: f }), { scope: 'Column' })));
      for (let r = 0; r < 5; r++) p.tag('TR', () => ['North', '1,204', '1,377'].forEach((v, i) => p.tag('TD', () => p.text(`${v}${i ? '' : ` ${r}`}`, { x: 40 + i * 120, y: 160 + r * 18, font: i ? m : f }))));
    });
    p.line(40, 260, 555, 260, { color: 0.7 }); // a rule: an artifact
    p.tag('L', () => ['First point', 'Second point'].forEach((t, i) => p.tag('LI', () => { p.tag('Lbl', () => p.text('•', { x: 40, y: 280 + i * 18, font: f })); p.tag('LBody', () => p.text(t, { x: 55, y: 280 + i * 18, font: f })); })));
    p.tag('P', () => p.text('Données en français.', { x: 40, y: 330, font: f }), { lang: 'fr' });
    p.link(40, 350, 120, 14, { url: 'https://example.com/report' });
    await p.end();
  }
  pdf.outline([{ title: 'Section 1', page: 1 }, { title: 'Section 2', page: pages[1] }, { title: 'Appendix', page: 3, top: 50, level: 1 }]);
}

describe.skipIf(!HAS.verapdf)('veraPDF', () => {
  it('a tagged PDF/A file passes PDF/UA-1 and PDF/A-2b with no failed rule', async () => {
    const out = await toBytes(sample, { title: 'Quarterly report', author: 'Finance', tagged: { lang: 'en-GB' }, pdfa: true, creationDate: DATE });
    const ua = verapdf(out, 'ua1'), a = verapdf(out, '2b');
    expect(ua.failed).toEqual([]);
    expect(a.failed).toEqual([]);
    expect(ua.ok && a.ok).toBe(true);
    if (HAS.poppler) expect(pdftotext(out)).toMatch(/Section 2[\s\S]*Revenue grew in every region\. See\s+the appendix/);
  }, 60000);

  it('PDF/UA-1 alone (no PDF/A) and PDF/A-2b alone (untagged) pass', async () => {
    const ua = await toBytes(sample, { title: 'UA only', tagged: { lang: 'en' }, creationDate: DATE });
    expect(verapdf(ua, 'ua1').failed).toEqual([]);
    const a = await toBytes(async (pdf) => {
      const f = await pdf.embedFont(INTER);
      const p = pdf.addPage();
      p.text('Archived. Ünïcødé ✓', { x: 40, y: 40, font: f });
      p.rect(40, 80, 100, 30, { fill: [0.2, 0.4, 0.6], stroke: 0 });
      p.link(40, 40, 80, 14, { url: 'https://example.com' });
      pdf.outline({ title: 'Start', page: 1 });
    }, { title: 'Archive', pdfa: true, creationDate: DATE });
    expect(verapdf(a, '2b').failed).toEqual([]);
  }, 60000);
});

describe('tagging', () => {
  it('the structure tree: Document > H1, P > Link (with OBJR), Table > TR > TH/TD; the parent tree; page /Tabs /S', async () => {
    const out = await toBytes(sample, { title: 'T', tagged: { lang: 'en' }, creationDate: DATE });
    const doc = await PDFDocument.load(out);
    const root = doc.catalog.lookup(PDFName.of('StructTreeRoot'), PDFDict);
    const top = root.lookup(PDFName.of('K'), PDFDict);
    expect(top.get(PDFName.of('S')).toString()).toBe('/Document');
    const kids = top.lookup(PDFName.of('K')).asArray().map((r) => doc.context.lookup(r, PDFDict));
    expect(kids.slice(0, 6).map((k) => k.get(PDFName.of('S')).toString())).toEqual(['/H1', '/P', '/Table', '/L', '/P', '/Link']);
    const th = doc.context.lookup(doc.context.lookup(kids[2].lookup(PDFName.of('K')).get(0), PDFDict).lookup(PDFName.of('K')).get(0), PDFDict);
    expect(th.get(PDFName.of('S')).toString()).toBe('/TH');
    expect(th.lookup(PDFName.of('A'), PDFDict).get(PDFName.of('Scope')).toString()).toBe('/Column');
    expect(root.get(PDFName.of('ParentTreeNextKey')).toString()).toBe(String(3 * 3)); // per page: its MCIDs, 2 links
    expect(doc.getPage(0).node.get(PDFName.of('Tabs')).toString()).toBe('/S');
    expect(doc.catalog.get(PDFName.of('MarkInfo')).toString()).toMatch('/Marked true');
  });

  it('untagged documents ignore page.tag; tagged ones refuse non-standard types, async fns and standard fonts', async () => {
    const plain = createPdf({ write() {} });
    expect(plain.addPage().tag('Whatever', () => 7)).toBe(7);
    const t = createPdf({ write() {} }, { title: 't', tagged: true });
    const p = t.addPage();
    expect(() => p.tag('Para', () => {})).toThrow(/not a standard structure type/);
    expect(() => p.tag('P', async () => {})).toThrow(/synchronously/);
    expect(() => p.tag('TH', () => {}, /** @type {any} */ ({ scope: 'Diagonal' }))).toThrow(/scope/);
    expect(() => t.standardFont('Helvetica')).toThrow(/PDF\/A and PDF\/UA need embedded fonts/);
    expect(() => createPdf({ write() {} }, { pdfa: true }).standardFont('Courier')).toThrow(/embedded fonts/);
  });
});
