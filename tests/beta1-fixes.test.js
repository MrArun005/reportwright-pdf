// Tester-reported issues for 0.1.0-beta.1: the real reason for an unreadable catalog, one bad page not failing the
// document, createPdf's metadata: false, a merge's tagging claims, the reader's memory.
import { describe, it, expect } from 'vitest';
import { loadPdf, PdfReadError } from '../src/index.js';
import { rawPdf, enc } from './reader-tools.js';

describe('PDF-5: a catalog nested past the limit', () => {
  it('reports E_DEPTH with the limit, not "no document catalog"', async () => {
    const deep = '<< /A '.repeat(100_000) + '>>'.repeat(100_000);
    const b = rawPdf([`<< /Type /Catalog /Pages 2 0 R /X ${deep} >>`, '<< /Type /Pages /Kids [] /Count 0 >>']);
    const e = await loadPdf(b).then(
      () => null,
      (x) => x,
    );
    expect(e).toBeInstanceOf(PdfReadError);
    expect(e.code).toBe('E_DEPTH');
    expect(e.message).toMatch(/catalog.*deeper than \d+/);
  });
});

describe("PDF-6: a reference loop in one page's /Contents", () => {
  const hello = enc('BT /F1 12 Tf 10 10 Td (Hello) Tj ET');
  const file = () =>
    rawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>',
      '5 0 R',
      '4 0 R',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /Font << /F1 8 0 R >> >> /Contents 7 0 R >>',
      [`<< /Length ${hello.length} >>`, hello],
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ]);
  it('that page is empty with a warning; load, extractText, save and merge work for the rest', async () => {
    const d = await loadPdf(file());
    expect(d.pageCount).toBe(2);
    expect(d.extractText()).toBe('\fHello');
    expect(d.warnings.join()).toMatch(/page 1's \/Contents has a reference loop/);
    const s = await d.save();
    expect(s.warnings.join()).toMatch(/reference loop/);
    const back = await loadPdf(s.bytes);
    expect(back.pageCount).toBe(2);
    expect(back.extractText()).toBe('\fHello');
    const m = await loadPdf(file());
    m.merge([await loadPdf(file())]);
    m.page(0).draw((p) => p.rect(0, 0, 1, 1));
    const merged = await loadPdf((await m.save()).bytes);
    expect(merged.pageCount).toBe(4);
    expect(merged.extractText()).toBe('\fHello\f\fHello');
  });
});

describe('PDF-9: createPdf metadata: false', () => {
  const make = async (o) => {
    const { toBytes } = await import('../src/index.js');
    return toBytes(
      async (pdf) => {
        const p = pdf.addPage();
        p.text('Invoice', { x: 36, y: 36, font: pdf.standardFont('Helvetica'), size: 12 });
        await p.end();
      },
      { title: 'Invoice', creationDate: new Date('2026-01-01'), ...o },
    );
  };
  it('omits the XMP stream and keeps Info; the file is smaller', async () => {
    const withXmp = await make({}),
      without = await make({ metadata: false });
    expect(without.length).toBeLessThan(withXmp.length - 800);
    const d = await loadPdf(without);
    expect(d.xmp).toBeNull();
    expect(d.info.title).toBe('Invoice');
    expect(d.extractText()).toBe('Invoice');
    expect((await loadPdf(withXmp)).xmp).toMatch(/Invoice/);
  });
  it('is refused with PDF/A or PDF/UA (both require XMP), and must be a boolean', async () => {
    await expect(make({ metadata: false, pdfa: true })).rejects.toThrow(/PDF\/A and PDF\/UA require the XMP/);
    await expect(make({ metadata: false, tagged: { lang: 'en' } })).rejects.toThrow(
      /PDF\/A and PDF\/UA require the XMP/,
    );
    await expect(make({ metadata: 'no' })).rejects.toThrow(/metadata is true/);
  });
});

describe('PDF-10: a merged PDF/UA file is no longer tagged and says so', () => {
  const tagged = async (o = {}) => {
    const { toBytes } = await import('../src/index.js');
    const { INTER } = await import('./tools.js');
    return toBytes(
      async (pdf) => {
        const f = await pdf.embedFont(INTER),
          p = pdf.addPage();
        p.tag('P', () => p.text('Tagged', { x: 36, y: 36, font: f, size: 12 }));
        await p.end();
      },
      { title: 'UA', tagged: { lang: 'en' }, creationDate: new Date('2026-01-01'), ...o },
    );
  };
  it('PDF/UA: no StructTreeRoot, no /MarkInfo, no pdfuaid in the XMP; the warning says it', async () => {
    const a = await loadPdf(await tagged()),
      b = await loadPdf(await tagged());
    expect(a.xmp).toMatch(/pdfuaid:part/);
    const r = await a.fork().merge([b]).save();
    expect(r.warnings.join()).toMatch(/structure tree \(tags\) was dropped.*no longer PDF\/UA/);
    const s = Buffer.from(r.bytes).toString('latin1');
    const m = await loadPdf(r.bytes);
    const { internal } = await import('../src/reader/pdf.js');
    const root = internal(m, 't').r.root;
    expect(root.has('StructTreeRoot')).toBe(false);
    expect(root.has('MarkInfo')).toBe(false);
    expect(m.xmp ?? '').not.toMatch(/pdfuaid/);
    expect(m.pageCount).toBe(2);
    expect(s).not.toMatch(/\/Marked true/);
    // a single document keeps its tags and its claim
    const one = await loadPdf((await a.save()).bytes);
    expect(one.xmp).toMatch(/pdfuaid:part/);
    expect(internal(one, 't').r.root.has('StructTreeRoot')).toBe(true);
  });
  it('PDF/A-2a + PDF/UA merged: PDF/A-2b, no pdfuaid', async () => {
    const o = { pdfa: { part: 2, conformance: 'a' } };
    const a = await loadPdf(await tagged(o)),
      b = await loadPdf(await tagged(o));
    const m = await loadPdf((await a.fork().merge([b]).save()).bytes);
    expect(m.pdfa).toEqual({ part: 2, conformance: 'b' });
    expect(m.xmp).not.toMatch(/pdfuaid/);
  });
});

describe('PDF-13: the reader holds a bounded cache of parsed objects', () => {
  it('a file with more objects than the cache saves byte-identically twice, keeps its tags, and merges deduplicated', async () => {
    const { toBytes } = await import('../src/index.js');
    const { INTER } = await import('./tools.js');
    const N = 1300; // > 2 × 1,024 objects: pages, contents and structure elements are evicted and parsed again
    const bytes = await toBytes(
      async (pdf) => {
        const f = await pdf.embedFont(INTER);
        for (let i = 0; i < N; i++) {
          const p = pdf.addPage({ width: 200, height: 100 });
          p.tag('P', () => p.text(`Page ${i + 1}`, { x: 10, y: 10, font: f, size: 10 }));
          await p.end();
        }
      },
      { title: 'Many', tagged: { lang: 'en' }, creationDate: new Date('2026-01-01') },
    );
    const d = await loadPdf(bytes);
    const a = await d.save({ creationDate: new Date('2026-01-01') }),
      b = await d.save({ creationDate: new Date('2026-01-01') });
    expect(Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes))).toBe(0);
    expect(a.warnings.join()).not.toMatch(/structure tree/);
    const back = await loadPdf(a.bytes);
    expect(back.pageCount).toBe(N);
    expect(back.xmp).toMatch(/pdfuaid/);
    expect(back.page(N - 1).extractText()).toBe(`Page ${N}`);
    expect(a.stripped).toEqual([]);
    // the font is shared by every page and by both documents: written once
    const m = await (
      await loadPdf(bytes)
    )
      .fork()
      .merge([await loadPdf(bytes)])
      .save();
    const mm = await loadPdf(m.bytes);
    expect(mm.pageCount).toBe(2 * N);
    const { internal } = await import('../src/reader/pdf.js');
    const r = internal(mm, 't').r,
      fonts = new Set();
    for (const i of [0, N - 1, N, 2 * N - 1])
      for (const v of r.src.resolve(r.src.resolve(r.pages[i].inh.Resources).get('Font')).values()) fonts.add(v.n);
    expect(fonts.size).toBe(1);
  });
});
