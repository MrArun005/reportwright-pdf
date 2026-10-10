// Shaped text comes back once, in logical order, from our extractText, poppler's pdftotext and pdf.js (0.1.0-beta.1:
// beta.0 doubled every multi-glyph cluster: "किकिताताब"); textMapping 'actualText' trades pdf.js's left to right for MuPDF. And the reader: ActualText replaces its glyphs; a code with
// no Unicode reads as U+FFFD, one mapped to nothing on purpose as nothing.
//
// pdf.js is not a dependency: its part runs when pdfjs-dist can be imported (installed, or PDFJS_DIR=<dir with
// node_modules/pdfjs-dist>) on Node 22 or later (pdf.js 6 needs Promise.withResolvers), and is skipped otherwise:
//   npm i --prefix /tmp/pdfjs pdfjs-dist@6.4.299 && PDFJS_DIR=/tmp/pdfjs npx vitest run tests/shaped-extract.test.js
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { toBytes, loadPdf } from '../src/index.js';
import { harfbuzzShaper } from '../examples/harfbuzz-shaper.mjs';
import { ROOT, HAS, run, save } from './tools.js';
import { onePage, rawPdf } from './reader-tools.js';

const font = (n) => fs.readFileSync(path.join(ROOT, 'public/fonts', n));
const CASES = [
  ['Devanagari', 'NotoSansDevanagari-Regular.ttf', 'किताब हिन्दी क्षत्रिय श्री', 'ltr'],
  ['Kannada', 'NotoSansKannada-Regular.ttf', 'ಕನ್ನಡ ಭಾಷೆ', 'ltr'],
  ["Kannada (the tester's)", 'NotoSansKannada-Regular.ttf', 'ಕನ್ನಡ ನಮಸ್ಕಾರ ಬೆಂಗಳೂರು', 'ltr'],
  ['Telugu', 'NotoSansTelugu-Regular.ttf', 'తెలుగు భాష', 'ltr'],
  ['Tamil', 'NotoSansTamil-Regular.ttf', 'தமிழ் மொழி', 'ltr'],
  ['Bengali', 'NotoSansBengali-Regular.ttf', 'বাংলা ভাষা', 'ltr'],
  ['Arabic', 'NotoSansArabic-Regular.ttf', 'مرحبا بالعالم', 'rtl'],
  ['Arabic (lam-alef, tanwin)', 'NotoSansArabic-Regular.ttf', 'السلام عليكم لا إله مرحبًا', 'rtl'],
];
const norm = (s) =>
  s
    .replace(/[‪-‮‎‏]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const shaped = (file, text, direction, textMapping, compress) =>
  toBytes(
    async (pdf) => {
      const b = font(file);
      pdf.addPage({ width: 600, height: 120 }).text(text, {
        x: 20,
        y: 20,
        size: 24,
        font: await pdf.embedFont(b, { shaper: harfbuzzShaper(b), textMapping }),
        direction,
      });
    },
    { creationDate: new Date('2026-01-01'), compress },
  );

let pdfjs = null;
if (typeof Promise.withResolvers === 'function') {
  const dir = process.env.PDFJS_DIR;
  try {
    pdfjs = await import(
      dir ? path.join(dir, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs') : 'pdfjs-dist/legacy/build/pdf.mjs'
    );
  } catch {
    /* not installed: skipped */
  }
}
async function pdfjsText(bytes) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }),
    d = await task.promise;
  const tc = await (await d.getPage(1)).getTextContent();
  await task.destroy();
  return tc.items.map((i) => i.str + (i.hasEOL ? '\n' : '')).join('');
}

describe('shaped text extracts exactly, once', () => {
  for (const [name, file, text, dir] of CASES) {
    for (const mode of [undefined, 'actualText'])
      it(`${name}: ours${HAS.poppler ? ', poppler' : ''} (${mode ?? 'default'})`, async () => {
        const out = await shaped(file, text, dir, mode);
        expect(norm((await loadPdf(out)).page(0).extractText())).toBe(text);
        if (HAS.poppler) expect(norm(run('pdftotext', [save(out), '-']))).toBe(text);
      });
    it.skipIf(!pdfjs)(`${name}: pdf.js`, async () => {
      expect(norm(await pdfjsText(await shaped(file, text, dir)))).toBe(text);
    });
  }

  it("textMapping 'actualText': a spanned cluster's carrier is drawn with a code the ToUnicode maps to WJ; by default with its text", async () => {
    // the carrier's code drawn in the content stream (uncompressed), and what the ToUnicode maps it to
    const carrier = async (mode) => {
      const s = Buffer.from(await shaped('NotoSansDevanagari-Regular.ttf', 'किताब', 'ltr', mode, false)).toString(
        'latin1',
      );
      const map = new Map(
        [...s.matchAll(/<([0-9A-Fa-f]{4})> <([0-9A-Fa-f]*)>/g)].map((m) => [m[1].toUpperCase(), m[2].toUpperCase()]),
      );
      const lit = (t) =>
        t.replace(/\\([0-7]{1,3}|.)/g, (_, e) =>
          /^[0-7]/.test(e)
            ? String.fromCharCode(parseInt(e, 8))
            : ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[e] ?? e),
        );
      const hex = (t) =>
        [...lit(t)]
          .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
          .join('')
          .toUpperCase()
          .match(/.{4}/g) ?? [];
      const drawn = [...s.matchAll(/\/ActualText[\s\S]*?BDC\n\(((?:\\[\s\S]|[^\\)])*)\) Tj\nEMC/g)].flatMap((m) =>
        hex(m[1]),
      );
      return drawn.map((c) => map.get(c));
    };
    const [def, at] = [await carrier(undefined), await carrier('actualText')];
    expect(def).toContain('0915093F'); // कि on its carrier
    expect(at).not.toContain('0915093F');
    expect(at.length).toBeGreaterThan(0);
    expect(at.every((u) => u === '2060')).toBe(true);
    await expect(
      toBytes(async (pdf) => {
        await pdf.embedFont(font('NotoSansDevanagari-Regular.ttf'), { textMapping: 'nope' });
      }),
    ).rejects.toThrow(TypeError);
  });

  it('a glyph that stands for different text in different places gets a code for each (a CIDToGIDMap), never one text twice', async () => {
    const out = await toBytes(
      async (pdf) => {
        const b = font('NotoSansDevanagari-Regular.ttf');
        pdf
          .addPage()
          .text('क कि क्ष', { x: 20, y: 20, size: 20, font: await pdf.embedFont(b, { shaper: harfbuzzShaper(b) }) });
      },
      { creationDate: new Date('2026-01-01'), compress: false },
    );
    expect(Buffer.from(out).toString('latin1')).toMatch(/\/CIDToGIDMap \d+ 0 R/);
    expect(norm((await loadPdf(out)).page(0).extractText())).toBe('क कि क्ष');
  });
});

/** a page drawing hex codes with a Type0 font whose ToUnicode maps 0001 → A, 0002 → nothing, and not 0003 */
const type0 = (content) =>
  rawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /Properties << /P0 << /ActualText (Named) >> >> >> >>',
    [`<< /Length ${content.length} >>`, content],
    '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 500 >>',
    (() => {
      const s =
        '/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <0000> <ffff> endcodespacerange 2 beginbfchar <0001> <0041> <0002> <> endbfchar endcmap end end';
      return [`<< /Length ${s.length} >>`, s];
    })(),
  ]);

describe('extractText: ActualText, and codes with no Unicode', () => {
  it('a span with /ActualText reads as its text in place of its glyphs (inline or a /Properties name), never both', async () => {
    const t = (c) => loadPdf(onePage(c)).then((d) => d.page(0).extractText());
    expect(await t('BT /F1 12 Tf 10 10 Td (a) Tj /Span << /ActualText (Hi) >> BDC (xy) Tj EMC (z) Tj ET')).toBe('aHiz');
    expect(
      await t(
        'BT /F1 12 Tf 10 10 Td /Span << /ActualText <feff0915093f> >> BDC (xy) Tj /Span << /ActualText (no) >> BDC (q) Tj EMC BMC (r) Tj EMC EMC ET',
      ),
    ).toBe('कि'); // the outer one wins
    expect(await t('BT /F1 12 Tf 10 10 Td /Span << /ActualText <feff> >> BDC (xy) Tj EMC (z) Tj ET')).toBe('z'); // nothing, on purpose
    expect(await t('BT /F1 12 Tf 10 10 Td /Span << /MCID 0 >> BDC (xy) Tj EMC EMC EMC (z) Tj ET')).toBe('xyz'); // no ActualText; unbalanced EMCs ignored
    expect(await t('BT /F1 12 Tf 10 10 Td /Span << /ActualText (Hi) >> BDC ET')).toBe(''); // no glyphs, nothing
    expect((await loadPdf(type0('BT /F1 12 Tf 10 10 Td /Span /P0 BDC <0001> Tj EMC ET'))).page(0).extractText()).toBe(
      'Named',
    );
  });

  it('a code the font has no mapping for at all reads as U+FFFD; one its ToUnicode skips or maps to nothing reads as nothing', async () => {
    // a ToUnicode that skips 0003: nothing, as pdftotext (beta.1 read U+FFFD)
    expect((await loadPdf(type0('BT /F1 12 Tf 10 10 Td <000300010002> Tj ET'))).page(0).extractText()).toBe('A');
    // a code mapped to WJ (U+2060, our shaped clusters' filler) reads as nothing, so "किताब" stays searchable
    const wj = Buffer.from(type0('BT /F1 12 Tf 10 10 Td <000100020001> Tj ET'))
      .toString('latin1')
      .replace('<0002> <>', '<0002> <2060>');
    expect((await loadPdf(new Uint8Array(Buffer.from(wj, 'latin1')))).page(0).extractText()).toBe('AA');
    // no ToUnicode and no font program: U+FFFD for every code (the same length: the xref holds)
    const bare = Buffer.from(type0('BT /F1 12 Tf 10 10 Td <000300010002> Tj ET'))
      .toString('latin1')
      .replace(/ \/ToUnicode 7 0 R/, (m) => ' '.repeat(m.length));
    expect((await loadPdf(new Uint8Array(Buffer.from(bare, 'latin1')))).page(0).extractText()).toBe('���');
    const simple = (enc) =>
      rawPdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        ['<< /Length 38 >>', 'BT /F1 12 Tf 10 10 Td <41818243> Tj ET'],
        `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding ${enc} >>`,
      ]);
    // 0x81 has no character in WinAnsi; 0x82 is a glyph named g123 (no Unicode) or quotesinglbase
    expect(
      (await loadPdf(simple('<< /BaseEncoding /WinAnsiEncoding /Differences [130 /g123] >>'))).page(0).extractText(),
    ).toBe('A��C');
    expect((await loadPdf(simple('/WinAnsiEncoding'))).page(0).extractText()).toBe('A�‚C');
  });
});

describe('extractText: spaces between objects, order along the line, rotated text', () => {
  const t = (c) => loadPdf(onePage(c)).then((d) => d.page(0).extractText());
  it('separate text objects a little apart get a space (a spreadsheet\'s "1" and "Alpha"); a kerned word does not', async () => {
    // Helvetica "1" is 0.556 em: at 11 pt it ends at 76.1, and "Alpha" starts 1.5 pt (0.14 em) later
    expect(await t('BT /F1 11 Tf 70 100 Td (1) Tj ET BT /F1 11 Tf 77.6 100 Td (Alpha) Tj ET')).toBe('1 Alpha');
    expect(await t('BT /F1 11 Tf 70 100 Td [(W) 80 (ave) -30 (s)] TJ ET')).toBe('Waves');
    expect(await t('BT /F1 11 Tf 70 100 Td (A) Tj 7.337 0 Td (B) Tj ET')).toBe('AB'); // glyph by glyph, no gap
  });
  it('a glyph drawn after its neighbours goes back in its place along the line', async () => {
    // "1,200" first, then "₹" (here "R") drawn before it, as office suites draw a fallback font's glyph last
    expect(await t('BT /F1 10 Tf 60 100 Td (1,200) Tj ET BT /F1 10 Tf 52.78 100 Td (R) Tj ET')).toBe('R1,200');
  });
  it('rotated text reads along its baseline', async () => {
    expect(await t('BT /F1 10 Tf 0 1 -1 0 100 50 Tm (Quarter one) Tj ET')).toBe('Quarter one');
    expect(await t('BT /F1 10 Tf 0 -1 1 0 100 150 Tm (Reads down) Tj ET')).toBe('Reads down');
  });
});

describe('extractText: a Type0 font with no ToUnicode', () => {
  it('the beta.0 Chrome ledger: a minus sign its ToUnicode skips reads from the cmap, so −1,370.00 stays negative', async () => {
    const out = await toBytes(
      async (pdf) => {
        pdf.addPage().text('Revenue −1,370.00', {
          x: 20,
          y: 20,
          size: 12,
          font: await pdf.embedFont(font('Inter-Regular.ttf'), { subset: false }),
        });
      },
      { creationDate: new Date('2026-01-01'), compress: false },
    );
    const s0 = Buffer.from(out).toString('latin1'),
      s = s0.replace(/<[0-9a-f]{4}> <2212>/, (m) => ' '.repeat(m.length)); // the minus's entry gone, same length
    expect(s).not.toBe(s0);
    expect((await loadPdf(new Uint8Array(Buffer.from(s, 'latin1')))).page(0).extractText()).toBe('Revenue −1,370.00');
  });

  it('reads its embedded TrueType cmap backwards (glyph → character), as MuPDF and PDFBox do, instead of nothing', async () => {
    const out = await toBytes(
      async (pdf) => {
        pdf.addPage().text('Revenue 1,370.00', {
          x: 20,
          y: 20,
          size: 12,
          font: await pdf.embedFont(font('Inter-Regular.ttf'), { subset: false }),
        });
      },
      { creationDate: new Date('2026-01-01'), compress: false },
    );
    const s = Buffer.from(out)
      .toString('latin1')
      .replace(/ \/ToUnicode \d+ 0 R/, (m) => ' '.repeat(m.length)); // same length: the xref holds
    expect((await loadPdf(new Uint8Array(Buffer.from(s, 'latin1')))).page(0).extractText()).toBe('Revenue 1,370.00');
  });
});
