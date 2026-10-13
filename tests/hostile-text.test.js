// Text from a caller is untrusted in size and shape: page.textBox must stay linear in the text it reads (one
// measuring pass per word, long words broken in one pass, layout stopped one line past what can show) and capped.
import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { toBytes, loadPdf } from '../src/index.js';
import { rawPdf } from './reader-tools.js';
import { INTER } from './tools.js';

/** run box(page, font) on a fresh page; its result and the elapsed ms (the PDF is ended and parsed too) */
async function timed(box, standard = false) {
  let r, ms;
  const out = await toBytes(
    async (pdf) => {
      const f = standard ? pdf.standardFont('Helvetica') : await pdf.embedFont(INTER);
      const page = pdf.addPage();
      const t = performance.now();
      r = box(page, f);
      ms = performance.now() - t;
    },
    { creationDate: new Date(0) },
  );
  await PDFDocument.load(out);
  return { r, ms };
}

describe('hostile text (each under 1 s)', () => {
  it('a 2 MB word with no spaces in a narrow box: broken a few characters a line, stopped at the height', async () => {
    const word = 'abcdefghij'.repeat(200_000);
    for (const standard of [false, true]) {
      const { r, ms } = await timed(
        (p, font) => p.textBox(word, { x: 10, y: 10, width: 30, height: 800, font, size: 10 }),
        standard,
      );
      expect(ms).toBeLessThan(1000);
      expect(r.lines).toBeGreaterThan(50);
      expect(r.overflow.length).toBeGreaterThan(word.length - 500);
      expect(word.endsWith(r.overflow)).toBe(true);
    }
  });

  it('a 2 MB word without a height stops at the 100,000-line cap', async () => {
    const word = 'x'.repeat(2_000_000);
    // calibrated on this runner: a 10× shorter word (under the cap) bounds the time; quadratic would be ~100×
    const { ms: small } = await timed((p, font) =>
      p.textBox(word.slice(0, 200_000), { x: 10, y: 10, width: 100, font, size: 10 }),
    );
    let per = 0;
    const { r, ms } = await timed((p, font) => {
      per = Math.floor(100 / font.widthOfText('x', 10));
      return p.textBox(word, { x: 10, y: 10, width: 100, font, size: 10 });
    });
    expect(ms).toBeLessThan(Math.max(1000, 25 * small));
    expect(r.lines).toBe(100_000);
    expect(r.overflow.length).toBe(2_000_000 - 100_000 * per); // every line holds as many x as fit
  });

  it('1 MB of words with maxLines 1: one line with an ellipsis, the rest as overflow', async () => {
    const txt = 'lorem ipsum dolor sit amet '.repeat(40_000);
    const { r, ms } = await timed((p, font) =>
      p.textBox(txt, { x: 10, y: 10, width: 200, font, size: 10, maxLines: 1 }),
    );
    expect(ms).toBeLessThan(1000);
    expect(r.lines).toBe(1);
    expect(txt.endsWith(r.overflow)).toBe(true);
    expect(r.overflow.length).toBeGreaterThan(txt.length - 60);
  });

  it('200,000 paragraphs of "\\n": capped lines, nothing drawn, fast', async () => {
    const { r, ms } = await timed((p, font) =>
      p.textBox('\n'.repeat(200_000), { x: 10, y: 10, width: 200, font, size: 10 }),
    );
    expect(ms).toBeLessThan(1000);
    expect(r.lines).toBe(100_000);
    expect(r.overflow.length).toBe(100_000);
  });

  it('a box 0.001 pt wide: one character a line', async () => {
    const txt = 'hello world '.repeat(100_000);
    const { r, ms } = await timed((p, font) =>
      p.textBox(txt, { x: 10, y: 10, width: 0.001, height: 120, font, size: 10 }),
    );
    expect(ms).toBeLessThan(1000);
    expect(r.lines).toBe(9); // 120 / Inter's 12.1 pt line: h e l l o w o r l
    expect(r.overflow).toBe(txt.slice(10)); // the space between the words starts no line
  });

  it('a huge font size: no line fits the height, or one character a line', async () => {
    const txt = 'huge text here '.repeat(10_000);
    let { r, ms } = await timed((p, font) => p.textBox(txt, { x: 0, y: 0, width: 500, height: 1000, font, size: 1e6 }));
    expect(ms).toBeLessThan(1000);
    expect(r).toEqual({ height: 0, lines: 0, overflow: txt });
    ({ r, ms } = await timed((p, font) => p.textBox(txt, { x: 0, y: 0, width: 500, font, size: 1e5, maxLines: 2 })));
    expect(ms).toBeLessThan(1000);
    expect(r.lines).toBe(2);
    expect(r.overflow.startsWith('uge text')).toBe(true); // 'h'; then the ellipsis alone (no character fits beside it)
  });

  it('text over 10 MB is refused with a clear error', async () => {
    const big = 'a'.repeat(10_000_001);
    await expect(timed((p, font) => p.textBox(big, { width: 100, font }))).rejects.toThrow(/more than 10000000/);
    await expect(timed((p, font) => p.text(big, { font }))).rejects.toThrow(/more than 10000000/);
  });
});

describe('a 2-million-operator page (PDF-7)', () => {
  // made here, not committed: "BT /F1 6 Tf", then (n - 3) / 2 pairs "1 0 0 1 x y Tm (c) Tj", then "ET": n operators, a piece per Tj
  const opsPage = (n) => {
    const parts = ['BT /F1 6 Tf\n'];
    for (let i = 0; i < (n - 3) / 2; i++)
      parts.push(
        `1 0 0 1 ${20 + (i % 60) * 9} ${820 - (Math.floor(i / 60) % 100) * 8} Tm (${String.fromCharCode(97 + (i % 26))}) Tj\n`,
      );
    parts.push('ET\n');
    const content = Buffer.from(parts.join(''), 'latin1');
    return rawPdf(
      [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
        [`<< /Length ${content.length} >>`, content],
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      ],
      { trailer: '/Size 6' },
    );
  };
  it('reads all 999,998 pieces in order, deterministically', async () => {
    const text = (await loadPdf(opsPage(2_000_000))).extractText();
    expect(text.length).toBe(1_999_997); // 999,998 letters, a space or a line break between each
    expect(text.slice(0, 7)).toBe('a b c d');
  }, 20000);
  it('one piece past budget.maxTextItems is refused', async () => {
    const d = await loadPdf(opsPage(2_000_000), { budget: { maxTextItems: 999_997 } });
    expect(() => d.extractText()).toThrow(/maxTextItems/);
  }, 20000);
});

describe('extraction: one very long right-to-left line', () => {
  const rtlPage = (n) => {
    const cmap =
      '/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 beginbfchar <41> <05D0> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end';
    const content = `BT /F1 1 Tf 0 0 Td (${'A'.repeat(n)}) Tj ET`;
    return rawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      [`<< /Length ${content.length} >>`, content],
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>',
      [`<< /Length ${cmap.length} >>`, cmap],
    ]);
  };
  it('is read whole, linearly, with no engine error', async () => {
    const t = (await loadPdf(rtlPage(300_000))).page(0).extractText();
    expect(t).toBe('א'.repeat(300_000));
  }, 20000);
  it('past budget.maxTextItems is a budget error', async () => {
    const d = await loadPdf(rtlPage(2_000_000));
    expect(() => d.page(0).extractText()).toThrow(/maxTextItems/);
  }, 20000);
});
