// The plain text loop's per-font table (fonts/embed.js plain) must write exactly what the general per-character loop
// writes: the same PDF bytes, widths and counts, over a mixed corpus.
import fs from 'node:fs';
import path from 'node:path';
import { it, expect } from 'vitest';
import { toBytes } from '../src/index.js';
import { REF } from '../src/fonts/embed.js';
import { harfbuzzShaper } from '../examples/harfbuzz-shaper.mjs';
import { INTER, ROOT } from './tools.js';

const DATE = new Date('2026-01-01');
const SC = fs.readFileSync(path.join(ROOT, 'tests/fixtures/fonts/NotoSansSC-Subset.otf'));
const DEVA = fs.readFileSync(path.join(ROOT, 'public/fonts/NotoSansDevanagari-Regular.ttf'));
const CORPUS = [
  'The quick brown fox, café naïve résumé — “quotes” 0123456789',
  '中文字体测试 你好世界 漢字', // CJK (in and out of the subset)
  'emoji 😀 math 𝔸𝔹 lone \ud800 high, lone \udc00 low, end \ud83d', // surrogates, paired and lone
  'unmapped ͸͹  ￿ tab\tnul\u0000', // glyphless
  'mixed: abc 中 😀 abc 中 😀', // a second pass over table hits
];

async function build(ref, opts = {}) {
  REF.on = ref;
  const widths = [];
  try {
    const bytes = await toBytes(
      async (pdf) => {
        const inter = await pdf.embedFont(INTER),
          sc = await pdf.embedFont(SC),
          deva = await pdf.embedFont(DEVA, { shaper: await harfbuzzShaper(DEVA) });
        for (const font of [inter, sc]) {
          const p = pdf.addPage();
          CORPUS.forEach((t, i) => {
            widths.push(font.widthOfText(t, 10, { kerning: false }));
            p.text(t, { x: 20, y: 20 + i * 20, font, size: 10, kerning: false });
          });
          await p.end();
        }
        const p = pdf.addPage();
        p.text('किताब हिन्दी क्षत्रिय abc', { x: 20, y: 20, font: deva, size: 12 });
        await p.end();
      },
      { creationDate: DATE, ...opts },
    );
    return { bytes: Buffer.from(bytes).toString('latin1'), widths };
  } finally {
    REF.on = false;
  }
}

it('the table loop writes the same bytes and widths as the general loop', async () => {
  const [a, b] = [await build(true), await build(false)];
  expect(b.widths).toEqual(a.widths);
  expect(b.bytes).toBe(a.bytes);
});

it('the same under tagged PDF (glyphless characters dropped)', async () => {
  const [a, b] = [await build(true, { tagged: true, title: 'T' }), await build(false, { tagged: true, title: 'T' })];
  expect(b.widths).toEqual(a.widths);
  expect(b.bytes).toBe(a.bytes);
});
