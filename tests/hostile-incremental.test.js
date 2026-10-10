// Group H security: saveIncremental fails CLOSED. An update cannot remove bytes (a reader that rebuilds the
// cross-reference, shows an earlier revision or follows /Prev finds the original objects again), so a file with active
// content anywhere in its bytes is refused (PdfReadError E_ACTIVE, naming what was found) unless keepActiveContent:
// true; save() rewrites it without. Cases: JavaScript reached only through an indirect /OpenAction, in an object
// nothing refers to (and absent from the cross-reference), in an object stream, in a /Next array, an XFA form.
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { loadPdf } from '../src/index.js';
import { internal } from '../src/reader/pdf.js';
import { rawPdf, enc, qdf, PY } from './reader-tools.js';

const base = (cat = '', extra = [], xref) =>
  rawPdf(
    [
      `<< /Type /Catalog /Pages 2 0 R ${cat} >>`,
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>',
      ['<< /Length 0 >>', new Uint8Array(0)],
      ...extra,
    ],
    { xref },
  );

async function inObjectStream() {
  const d = await PDFDocument.create();
  d.addPage([200, 200]);
  const js = d.context.register(d.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') }));
  d.catalog.set(PDFName.of('OpenAction'), js);
  return d.save({ useObjectStreams: true });
}

const CASES = {
  'an indirect /OpenAction': () => base('/OpenAction 5 0 R', ['<< /S /JavaScript /JS (app.alert(1)) >>']),
  'an object nothing refers to, missing from the cross-reference': () =>
    base(
      '',
      ['<< /S /JavaScript /JS (x) >>'],
      (offs) =>
        `xref\n0 5\n0000000000 65535 f\r\n${offs
          .slice(0, 4)
          .map((o) => `${String(o).padStart(10, '0')} 00000 n\r\n`)
          .join('')}`,
    ),
  'an object stream': inObjectStream,
  'a /Next array': () => base('/OpenAction << /S /GoTo /D [3 0 R /Fit] /Next [<< /S /JavaScript /JS (x) >>] >>'),
  'hex-escaped names (/S /Java#53cript /#4A#53)': () =>
    base('/OpenAction 5 0 R', ['<< /S /Java#53cript /#4A#53 (app.alert(1)) >>']),
  'hex-escaped names inside an object stream': () => {
    const m = '6 0 << /S /Java#53cript /#4A#53 (x) >>';
    return base('/OpenAction 6 0 R', [[`<< /Type /ObjStm /N 1 /First 4 /Length ${m.length} >>`, enc(m)]]);
  },
  'a launch action whose /S is indirect': () => base('/OpenAction << /S 5 0 R /F (calc.exe) >>', ['/Launch']),
  'an XFA form': () =>
    base('/AcroForm << /Fields [] /XFA 5 0 R >>', [
      ['<< /Length 26 >>', enc('<script>app.alert(1)</script>').subarray(0, 26)],
    ]),
};

describe('saveIncremental refuses a file with active content; save() removes it', () => {
  for (const [name, make] of Object.entries(CASES)) {
    it(name, async () => {
      const bytes = await make();
      const d = await loadPdf(bytes);
      d.setInfo({ title: 'changed' });
      await expect(d.saveIncremental()).rejects.toMatchObject({
        name: 'PdfReadError',
        code: 'E_ACTIVE',
        message: expect.stringMatching(/active content \(.+\).*Use save\(\)/s),
      });
      // nothing changed: still checked (fail closed)
      await expect((await loadPdf(bytes)).saveIncremental()).rejects.toMatchObject({ code: 'E_ACTIVE' });
      const kept = await d.saveIncremental({ keepActiveContent: true });
      expect(kept.activeContent.length).toBeGreaterThan(0);
      expect(kept.bytes.subarray(0, bytes.length)).toEqual(new Uint8Array(bytes)); // appended only
      const clean = await (await loadPdf(bytes)).save();
      const all = [];
      for (const { v } of internal(await loadPdf(clean.bytes), 't').r.src.everyObject()) all.push(v);
      expect(JSON.stringify(all.map((v) => (v instanceof Map ? [...v.keys()] : null)))).not.toMatch(/"JS"|"XFA"|"AA"/);
      if (PY) {
        const q = qdf(clean.bytes);
        for (const b of ['/JavaScript', '/JS', '/XFA', '/AA']) expect(q.includes(b), b).toBe(false);
      }
    });
  }
  it('a check that cannot finish refuses too (fail closed)', async () => {
    const d = await loadPdf(base(), { budget: { maxSteps: 1e6 } });
    internal(d, 't').r.src.budget.steps = 1e6 - 5; // the budget runs out during the check
    await expect(d.saveIncremental()).rejects.toMatchObject({
      code: 'E_ACTIVE',
      message: expect.stringMatching(/could not be checked/),
    });
  });
  it('the scan is done once per source: a second update reuses it', async () => {
    const d = await loadPdf(base());
    d.setInfo({ title: 'one' });
    await d.saveIncremental();
    const src = internal(d, 't').r.src,
      every = src.everyObject;
    let calls = 0;
    src.everyObject = function* () {
      calls++;
      yield* every();
    };
    d.setInfo({ title: 'two' });
    await d.saveIncremental();
    expect(calls).toBe(0);
  });
  it('a clean file updates', async () => {
    const d = await loadPdf(base());
    d.setInfo({ title: 'New' });
    const r = await d.saveIncremental();
    expect(r.activeContent).toEqual([]);
    expect((await loadPdf(r.bytes)).info.title).toBe('New');
  });
});
