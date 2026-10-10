// Tagged PDF depth, group G: tables (THead/TBody, TH ids with Scope, TD Headers, spans), lists (ListNumbering, a nested
// list), headings H1–H3, Lang spans, ActualText, Alt, /E, typed artifacts; veraPDF PDF/UA-1 and PDF/A-2a with 0 failed
// rules; the structure read back by pdf-lib; the nesting and heading rules.
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFDict, PDFArray } from 'pdf-lib';
import { toBytes, createPdf } from '../src/index.js';
import { HAS, INTER, verapdf, pdftotext, latin } from './tools.js';
import { DATE } from './standards-fixture.js';

/** a report: header/footer/watermark artifacts, H1 > H2 > H3, a table with a header row and a spanning cell, a nested list */
async function report(pdf) {
  const f = await pdf.embedFont(INTER);
  for (let n = 1; n <= 2; n++) {
    const p = pdf.addPage(), T = (t, fn, o) => p.tag(t, fn, o), t = (s, x, y, o = {}) => p.text(s, { x, y, font: f, size: 11, ...o });
    p.artifact({ type: 'Pagination', subtype: 'Header' }, () => t('Quarterly report', 40, 20, { size: 8 }));
    p.artifact({ type: 'Pagination', subtype: 'Footer' }, () => t(`Page ${n} of 2`, 40, 810, { size: 8 }));
    p.artifact({ type: 'Pagination', subtype: 'Watermark' }, () => t('DRAFT', 200, 400, { size: 60, color: 0.9 }));
    p.artifact({ type: 'Layout' }, () => p.line(40, 32, 555, 32, { color: 0.7 }));
    if (n === 1) T('H1', () => t('Quarterly report', 40, 50, { size: 20 }));
    T('H2', () => t(`Part ${n}`, 40, 90, { size: 15 }));
    T('H3', () => t('Sales by region', 40, 120, { size: 12 }));
    T('Table', () => {
      T('THead', () => T('TR', () => ['Region', 'Q1', 'Q2'].forEach((h, i) => T('TH', () => t(h, 40 + i * 120, 145), { scope: 'Column', id: `p${n}h${i}` }))));
      T('TBody', () => {
        T('TR', () => { T('TH', () => t('North', 40, 165), { scope: 'Row', id: `p${n}r0` }); ['1,204', '1,377'].forEach((v, i) => T('TD', () => t(v, 160 + i * 120, 165), { headers: [`p${n}h${i + 1}`, `p${n}r0`] })); });
        T('TR', () => { T('TH', () => t('South', 40, 185), { scope: 'Row', id: `p${n}r1` }); T('TD', () => t('2,581 (both quarters)', 160, 185), { headers: [`p${n}h1`, `p${n}h2`, `p${n}r1`], colSpan: 2 }); });
      });
    });
    T('L', () => ['Revenue grew', 'Costs fell'].forEach((s, i) => T('LI', () => {
      T('Lbl', () => t(`${i + 1}.`, 40, 220 + i * 40));
      T('LBody', () => {
        t(s, 60, 220 + i * 40);
        if (i === 0) T('L', () => T('LI', () => { T('Lbl', () => t('•', 60, 238)); T('LBody', () => t('in every region', 75, 238)); }), { listNumbering: 'Disc' });
      });
    })), { listNumbering: 'Decimal' });
    T('P', () => {
      t('Figures from the ', 40, 320);
      T('Span', () => t('CFO', 140, 320), { expansion: 'Chief Financial Officer' });
      t(', and ', 170, 320);
      T('Span', () => t('en français', 205, 320), { lang: 'fr' });
      t('.', 270, 320);
    });
    T('P', () => { t('Half: ', 40, 345); T('Span', () => t('1/2', 80, 345), { actualText: '½' }); });
    T('Figure', () => p.rect(40, 370, 30, 30, { fill: '#5b9bd5' }), { alt: 'A blue square' });
    await p.end();
  }
}

describe('tagged depth', () => {
  it.skipIf(!HAS.verapdf)('tables, lists, headings, spans and artifacts pass PDF/UA-1 and PDF/A-2a with 0 failed rules', async () => {
    const out = await toBytes(report, { title: 'Quarterly report', tagged: { lang: 'en-GB' }, pdfa: { part: 2, conformance: 'a' }, creationDate: DATE });
    expect(verapdf(out, 'ua1').failed).toEqual([]);
    expect(verapdf(out, '2a').failed).toEqual([]);
    if (HAS.poppler) {
      const s = pdftotext(out);
      expect(s).toMatch(/Sales by region/);
      expect(s).toMatch(/Half:\s+1\/2/); // poppler reads the content; the element's /ActualText is for assistive technology
    }
  }, 60000);

  it('the structure read back: THead/TBody, Scope, Headers, ColSpan, IDTree, ListNumbering, E, Lang, ActualText, typed artifacts', async () => {
    const out = await toBytes(report, { title: 'T', tagged: { lang: 'en' }, creationDate: DATE, compress: false });
    const doc = await PDFDocument.load(out);
    const root = doc.catalog.lookup(PDFName.of('StructTreeRoot'), PDFDict);
    const ids = root.lookup(PDFName.of('IDTree'), PDFDict).lookup(PDFName.of('Names'), PDFArray).asArray();
    expect(ids.length).toBe(2 * 10); // 5 TH a page
    const s = latin(out);
    expect(s).toContain('/A << /O /Table /Scope /Column >>');
    expect(s).toMatch(/\/A << \/O \/Table \/Headers \[<[0-9a-f]+> <[0-9a-f]+> <[0-9a-f]+>\] \/ColSpan 2 >>/);
    expect(s).toContain('/A << /O /List /ListNumbering /Decimal >>');
    expect(s).toContain('/A << /O /List /ListNumbering /Disc >>');
    expect(s).toMatch(/\/S \/Span [^>]*\/E <feff[0-9a-f]+>/);
    expect(s).toMatch(/\/S \/Span [^>]*\/Lang <6672>/);
    expect(s).toMatch(/\/S \/Span [^>]*\/ActualText <feff00bd>/);
    expect(s).toMatch(/\/ID <70316830>/); // p1h0
    for (const a of ['/Artifact << /Type /Pagination /Subtype /Header >> BDC', '/Artifact << /Type /Pagination /Subtype /Footer >> BDC', '/Artifact << /Type /Pagination /Subtype /Watermark >> BDC', '/Artifact << /Type /Layout >> BDC']) expect(s).toContain(a);
    const top = root.lookup(PDFName.of('K'), PDFDict).lookup(PDFName.of('K'), PDFArray).asArray().map((r) => doc.context.lookup(r, PDFDict).get(PDFName.of('S')).toString());
    expect(top.slice(0, 7)).toEqual(['/H1', '/H2', '/H3', '/Table', '/L', '/P', '/P']);
  });

  it('nesting rules: rows in tables, cells in rows, items in lists, labels in items', () => {
    const pdf = createPdf({ write() {} }, { title: 't', tagged: true }), p = pdf.addPage();
    expect(() => p.tag('TD', () => {})).toThrow(/TD belongs inside TR, not the Document/);
    expect(() => p.tag('Table', () => p.tag('TD', () => {}))).toThrow(/TD belongs inside TR, not Table/);
    expect(() => p.tag('P', () => p.tag('TR', () => {}))).toThrow(/TR belongs inside Table, THead, TBody, TFoot/);
    expect(() => p.tag('LI', () => {})).toThrow(/LI belongs inside L/);
    expect(() => p.tag('L', () => p.tag('Lbl', () => {}))).toThrow(/Lbl belongs inside LI/);
    expect(() => p.tag('THead', () => {})).toThrow(/THead belongs inside Table/);
    expect(() => p.tag('Table', () => p.tag('TR', () => p.tag('TD', () => {}, { scope: 'Row' })))).toThrow(/scope is for TH/);
    expect(() => p.tag('P', () => {}, { listNumbering: 'Decimal' })).toThrow(/listNumbering is for L/);
    expect(() => p.tag('L', () => {}, { listNumbering: 'Hex' })).toThrow(/listNumbering is for L/);
    expect(() => p.tag('P', () => {}, { headers: ['a'] })).toThrow(/headers is for TD and TH/);
    expect(() => p.tag('Table', () => p.tag('TR', () => p.tag('TD', () => {}, { colSpan: 0 })))).toThrow(/colSpan is a whole number/);
    expect(() => p.tag('P', () => {}, { id: 'a b' })).toThrow(/an id is/);
    expect(() => p.tag('P', () => {}, { lang: 'en"/JS' })).toThrow(/lang is a language tag/);
    expect(() => p.tag('P', () => {}, { actualText: 5 })).toThrow(/actualText is a string/);
    p.tag('P', () => {}, { id: 'x' });
    expect(() => p.tag('P', () => {}, { id: 'x' })).toThrow(/already used/);
  });

  it('heading rules (PDF/UA 7.4.2, 7.4.4): H1 first, no skipped level going down, H and Hn not mixed', () => {
    const page = () => createPdf({ write() {} }, { title: 't', tagged: true }).addPage();
    expect(() => page().tag('H2', () => {})).toThrow(/the first heading is H1, not H2/);
    const a = page(); a.tag('H1', () => {}); a.tag('H2', () => {});
    expect(() => a.tag('H4', () => {})).toThrow(/H4 after H2 skips a level/);
    a.tag('H3', () => {}); a.tag('H1', () => {}); a.tag('H2', () => {}); // going up and down again is fine
    expect(() => a.tag('H', () => {})).toThrow(/H or H1–H6/);
    const b = page(); b.tag('H', () => {});
    expect(() => b.tag('H1', () => {})).toThrow(/H or H1–H6/);
    const plain = createPdf({ write() {} }).addPage();
    expect(plain.tag('H4', () => 1)).toBe(1); // untagged: no rules
  });

  it('artifacts: fixed types only, never inside a tag, no tags or annotations inside; untagged documents just draw', async () => {
    const pdf = createPdf({ write() {} }, { title: 't', tagged: true }), p = pdf.addPage();
    expect(() => p.artifact({ type: 'Evil /JS' }, () => {})).toThrow(/type is Pagination, Layout, Page/);
    expect(() => p.artifact({ type: 'Layout', subtype: 'Header' }, () => {})).toThrow(/subtype .* is for type Pagination/);
    expect(() => p.artifact({ subtype: 'Sidebar' }, () => {})).toThrow(/subtype/);
    expect(() => p.tag('P', () => p.artifact({}, () => {}))).toThrow(/inside page.tag/);
    expect(() => p.artifact({}, () => p.tag('P', () => {}))).toThrow(/inside page.artifact/);
    expect(() => p.artifact({}, () => p.link(0, 0, 10, 10, { url: 'https://example.com' }, { alt: 'x' }))).toThrow(/inside page.artifact/);
    expect(() => p.artifact({}, async () => {})).toThrow(/synchronously/);
    expect(() => p.artifact({})).toThrow(/fn is a function/);
    expect(createPdf({ write() {} }).addPage().artifact({ type: 'Pagination' }, () => 7)).toBe(7);
  });

  it('a TD naming an id no TH has fails pdf.end with the id', async () => {
    const pdf = createPdf({ write() {} }, { title: 't', tagged: true });
    const p = pdf.addPage();
    p.tag('Table', () => p.tag('TR', () => p.tag('TD', () => {}, { headers: ['missing'] })));
    await expect(pdf.end()).rejects.toThrow(/headers names "missing"/);
  });
});
