// Group H security: active content in a file from a stranger never survives save() unless keepActiveContent. Hand-made
// files put it where a denylist on direct dictionaries would miss it: an action behind an indirect reference, a
// JavaScript action in a /Next array, document JavaScript in the /Names tree, an XFA form with a script, a RichMedia
// annotation, catalog and page /AA, a URI with leading white space and odd case. After save(), qpdf (pikepdf, when
// PIKEPDF_PY is set) writes the output as QDF (every stream uncompressed) and none of /JavaScript, /JS, /Launch,
// /XFA, /RichMedia, /AA is in it; our own reader and pdf-lib find no such action either. And a long https URI that
// contains "javascript:" after its scheme is KEPT (only the scheme matters).
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib';
import { loadPdf } from '../src/index.js';
import { internal } from '../src/reader/pdf.js';
import { rawPdf, qdf, PY, enc } from './reader-tools.js';

const LONG = `https://example.com/${'a'.repeat(80)}?next=javascript:alert(1)`;
const hostile = () =>
  rawPdf([
    `<< /Type /Catalog /Pages 2 0 R /Names << /JavaScript << /Names [(x) 9 0 R] >> >> /OpenAction << /S /GoTo /D [3 0 R /Fit] /Next [<< /S /JavaScript /JS (app.alert(1)) >>] >> /AA << /WC 9 0 R >> /AcroForm << /Fields [] /XFA [(template) 10 0 R] >> >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Annots [5 0 R 6 0 R 7 0 R 8 0 R] /AA << /O 9 0 R >> >>',
    ['<< /Length 0 >>', new Uint8Array(0)],
    '<< /Type /Annot /Subtype /Link /Rect [0 0 50 50] /A 11 0 R >>', // an indirect Launch
    '<< /Type /Annot /Subtype /RichMedia /Rect [50 0 100 50] >>',
    '<< /Type /Annot /Subtype /Link /Rect [0 50 50 100] /A << /S /URI /URI ( JAVASCRIPT:alert\\(1\\)) >> >>',
    `<< /Type /Annot /Subtype /Link /Rect [0 100 50 150] /A << /S /URI /URI (${LONG}) >> >>`,
    '<< /S /JavaScript /JS (app.alert(2)) >>',
    ['<< /Length 40 >>', enc('<template><script>x()</script></template>').subarray(0, 40)],
    '<< /S /Launch /F (calc.exe) >>',
  ]);
const BAD = ['/JavaScript', '/JS', '/Launch', '/XFA', '/RichMedia', '/AA'];

/** every dictionary of every object our reader finds in the bytes */
async function dicts(bytes) {
  const d = internal(await loadPdf(bytes), 'test');
  const out = [];
  for (const { v } of d.r.src.everyObject()) {
    const st = [v?.dict ?? v];
    while (st.length) {
      const x = st.pop();
      if (Array.isArray(x)) st.push(...x);
      else if (x instanceof Map) {
        out.push(x);
        st.push(...x.values());
      }
    }
  }
  return out;
}

describe('save() drops active content wherever it is', () => {
  it('indirect Launch, /Next JavaScript, Names JavaScript, XFA, RichMedia, /AA and a disguised javascript: URI are gone; the long https URI stays', async () => {
    const src = await loadPdf(hostile());
    const r = await src.save();
    const what = r.stripped.map((s) => s.what).join(' | ');
    for (const w of [
      'Launch action',
      'JavaScript action',
      'document JavaScript',
      'XFA',
      'RichMedia annotation',
      'additional actions',
      'URI action with an unsafe',
    ])
      expect(what).toContain(w);
    for (const d of await dicts(r.bytes)) {
      for (const k of ['JS', 'AA', 'XFA', 'JavaScript']) expect(d.has(k)).toBe(false);
      expect(['JavaScript', 'Launch'].includes(d.get('S'))).toBe(false);
      expect(d.get('Subtype')).not.toBe('RichMedia');
    }
    const out = await loadPdf(r.bytes);
    expect(
      out
        .page(0)
        .annotations()
        .map((a) => a.uri)
        .filter(Boolean),
    ).toEqual([LONG.replace('(', '%28').replace(')', '%29')]); // kept, as checkUrl normalised it
    // pdf-lib parses it and finds no such action
    const pl = await PDFDocument.load(r.bytes);
    for (const [, o] of pl.context.enumerateIndirectObjects()) {
      if (!(o instanceof PDFDict)) continue;
      const s = o.get(PDFName.of('S'));
      expect([PDFName.of('JavaScript'), PDFName.of('Launch')].includes(s)).toBe(false);
      expect(o.has(PDFName.of('AA'))).toBe(false);
    }
    if (PY) {
      const q = qdf(r.bytes);
      for (const b of BAD) expect(q.includes(b), b).toBe(false);
    }
  });
  it('keepActiveContent: true keeps them (the caller asked)', async () => {
    const r = await (await loadPdf(hostile())).save({ keepActiveContent: true });
    expect(r.stripped).toEqual([]);
    const ds = await dicts(r.bytes);
    expect(ds.some((d) => d.get('S') === 'Launch')).toBe(true);
    expect(ds.some((d) => d.has('JS'))).toBe(true);
  });
  it('a merge and a split strip it too (every path copies through the same rules)', async () => {
    const a = await loadPdf(hostile()),
      b = await loadPdf(hostile());
    for (const r of [
      await a.fork().merge([b]).save(),
      await (await loadPdf(hostile())).fork().removePages([]).save(),
    ]) {
      for (const d of await dicts(r.bytes)) {
        expect(d.has('JS')).toBe(false);
        expect(d.get('S')).not.toBe('Launch');
      }
    }
  });
  it('a direct RichMedia annotation in /Annots, an action whose /S is an indirect name, and a Launch behind /Type 12 0 R are dropped', async () => {
    const b = rawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Annots [<< /Type /Annot /Subtype /RichMedia /Rect [0 0 9 9] >> 4 0 R] >>',
      '<< /Type /Annot /Subtype /Link /Rect [0 0 9 9] /A << /S 5 0 R /F (calc.exe) >> /PA 6 0 R >>',
      '/Launch',
      '<< /Type 7 0 R /S /Launch /F (x) >>',
      '/Action',
    ]);
    const r = await (await loadPdf(b)).save();
    const R = internal(await loadPdf(r.bytes), 't').r.src.resolve;
    for (const d of await dicts(r.bytes)) {
      expect(R(d.get('Subtype'))).not.toBe('RichMedia');
      expect(R(d.get('S'))).not.toBe('Launch');
      expect(R(d.get('Type'))).not.toBe('Action');
    }
    if (PY) expect(qdf(r.bytes)).not.toMatch(/calc\.exe|\/Launch|\/RichMedia/);
    expect(r.stripped.map((x) => x.what).join()).toMatch(/RichMedia annotation.*|Launch action/);
  });
});
