// A page's /Contents in every shape (a stream, a direct array, an indirect reference to an array, an array nesting a
// reference to another array, an empty array) through flatten, fill + flatten, page.draw and saveIncremental: the
// page's own text survives, the field appearances are drawn, no field remains, and qpdf --check is clean.
// The shape that broke: an indirect array was spliced as "7 0 R 0 0 9 0 R" (cantoo-scribe/pdf-lib #86's Acrobat form).
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { loadPdf } from '../src/index.js';
import { HAS, save } from './tools.js';
import { rawPdf } from './reader-tools.js';

const font = '<< /Font << /Helv 5 0 R /F1 5 0 R >> >>';
const ap = (s) => [
  `<< /Type /XObject /Subtype /Form /BBox [0 0 200 20] /Resources ${font} >>`,
  `BT /Helv 10 Tf 2 5 Td (${s}) Tj ET`,
];
/** every stream given its /Length (an incremental update keeps the original bytes) */
const withLength = (objs) =>
  objs.map((o) => (Array.isArray(o) ? [o[0].replace(/^<</, `<< /Length ${o[1].length}`), o[1]] : o));
const form = (contents) =>
  rawPdf(
    withLength([
      '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R 10 0 R 11 0 R] /DA (/Helv 12 Tf 0 g) /DR << /Font << /Helv 5 0 R >> >> >> >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ${font} /Contents ${contents} /Annots [6 0 R 10 0 R 12 0 R 13 0 R] >>`,
      ['<< >>', 'BT /F1 12 Tf 50 700 Td (StaticOne) Tj ET'],
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      '<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /V (Filled) /Rect [50 600 250 620] /P 3 0 R /F 4 /DA (/Helv 12 Tf 0 g) /AP << /N 7 0 R >> >>',
      ap('Filled'),
      ['<< >>', 'BT /F1 12 Tf 50 680 Td (StaticTwo) Tj ET'],
      '[4 0 R 8 0 R]',
      // an Acrobat-style check box and radio group: per-state /AP /N, the state in /AS
      '<< /Type /Annot /Subtype /Widget /FT /Btn /T (agree) /V /On /AS /On /Rect [50 550 250 570] /P 3 0 R /F 4 /AP << /N << /On 14 0 R /Off 15 0 R >> >> >>',
      '<< /FT /Btn /Ff 49152 /T (size) /V /S2 /Kids [12 0 R 13 0 R] >>',
      '<< /Type /Annot /Subtype /Widget /Parent 11 0 R /AS /Off /Rect [50 500 250 520] /P 3 0 R /F 4 /AP << /N << /S1 16 0 R /Off 15 0 R >> >> >>',
      '<< /Type /Annot /Subtype /Widget /Parent 11 0 R /AS /S2 /Rect [300 500 500 520] /P 3 0 R /F 4 /AP << /N << /S2 17 0 R /Off 15 0 R >> >> >>',
      ap('CheckOn'),
      ap(''),
      ap('RadioA'),
      ap('RadioB'),
    ]),
  );

const SHAPES = {
  'indirect array': ['9 0 R', ['StaticOne', 'StaticTwo']],
  'direct array': ['[4 0 R 8 0 R]', ['StaticOne', 'StaticTwo']],
  'single stream': ['4 0 R', ['StaticOne']],
  'array nesting an indirect array': ['[9 0 R]', ['StaticOne', 'StaticTwo']],
  'empty array': ['[]', []],
};

const qpdfClean = (b) => {
  if (!HAS.qpdf) return;
  try {
    execFileSync('qpdf', ['--check', save(b)], { stdio: 'pipe' });
  } catch (e) {
    throw new Error(`qpdf --check: ${e.stdout}${e.stderr}`);
  }
};
const textOf = async (b) => (await loadPdf(b)).page(0).extractText();

describe('/Contents in every shape', () => {
  for (const [shape, [contents, statics]] of Object.entries(SHAPES)) {
    describe(shape, () => {
      it('flatten keeps the page text and draws the fields, check box and chosen radio', async () => {
        const { bytes } = await (await loadPdf(form(contents))).flatten().save();
        const t = await textOf(bytes);
        for (const s of [...statics, 'Filled', 'CheckOn', 'RadioB']) expect(t).toContain(s);
        expect(t).not.toContain('RadioA');
        expect((await loadPdf(bytes)).fields).toEqual([]);
        qpdfClean(bytes);
      });
      it('fill + flatten', async () => {
        const d = await loadPdf(form(contents));
        d.fill({ name: 'Ada', agree: false, size: 'S1' });
        const { bytes } = await d.flatten().save();
        const t = await textOf(bytes);
        for (const s of [...statics, 'Ada', 'RadioA']) expect(t).toContain(s);
        expect(t).not.toContain('CheckOn');
        expect(t).not.toContain('RadioB');
        expect((await loadPdf(bytes)).fields).toEqual([]);
        qpdfClean(bytes);
      });
      it('page.draw overlay', async () => {
        const d = await loadPdf(form(contents));
        d.page(0).draw((p, { fonts }) => p.text('Overlay', { x: 40, y: 100, font: fonts.f, size: 14 }), {
          fonts: { f: 'Helvetica' },
        });
        const { bytes } = await d.save();
        const t = await textOf(bytes);
        for (const s of [...statics, 'Overlay']) expect(t).toContain(s);
        expect((await loadPdf(bytes)).fields.length).toBe(3);
        qpdfClean(bytes);
      });
      it('fill + saveIncremental', async () => {
        const d = await loadPdf(form(contents));
        d.fill({ name: 'Grace' });
        const { bytes } = await d.saveIncremental();
        const r = await loadPdf(bytes);
        expect(r.fields.find((f) => f.name === 'name').value).toBe('Grace');
        for (const s of statics) expect(await textOf(bytes)).toContain(s);
        // the page itself is not rewritten: a malformed nesting stays (qpdf warns about the input too)
        if (shape !== 'array nesting an indirect array') qpdfClean(bytes);
      });
    });
  }
});
