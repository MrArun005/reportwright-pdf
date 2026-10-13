// Font and CMap text is read by a linear tokenizer: crafted text that made the old regular expressions backtrack for
// minutes (an unterminated FontMatrix array repeated, CMap hex strings never closed) is read in well under a second.
import { describe, it, expect } from 'vitest';
import { type1Font } from '../src/render/type1.js';
import { parseCMap, decodeCodes } from '../src/render/cmap.js';

const tick = () => {};
const fast = (f) => {
  const t = Date.now();
  f();
  expect(Date.now() - t).toBeLessThan(3000);
};

describe('font program text: linear time', () => {
  it('a Type 1 cleartext of unterminated FontMatrix arrays', { timeout: 10000 }, () => {
    const clear = '/FontMatrix [ '.repeat(80_000) + 'dup 1 /a '.repeat(20_000) + '\ncurrentfile eexec\n';
    const file = Buffer.concat([Buffer.from(clear, 'latin1'), Buffer.alloc(64, 0x80)]);
    fast(() => expect(() => type1Font(file, clear.length, tick)).toThrow(/CharStrings/));
  });
  it('a CMap of hex strings never closed', { timeout: 10000 }, () => {
    const text =
      'begincodespacerange <00> <FF> endcodespacerange begincidrange ' + '<0 '.repeat(300_000) + 'endcidrange';
    fast(() => parseCMap(Buffer.from(text, 'latin1'), null, tick));
  });
  it('a CMap of begin blocks never ended', { timeout: 10000 }, () => {
    const text = 'begincidchar <41> 1 '.repeat(50_000);
    fast(() => {
      const m = parseCMap(
        Buffer.from(`1 begincodespacerange <00> <FF> endcodespacerange ${text}`, 'latin1'),
        null,
        tick,
      );
      expect(decodeCodes(m, Buffer.from('A'))).toEqual([[1, false]]);
    });
  });
});

describe('font widths and codes: charged before the work', () => {
  it('W and W2 ranges are charged per CID set', async () => {
    const { loadPdf, renderPage } = await import('../src/index.js');
    const { rawPdf } = await import('./reader-tools.js');
    const ranges = '0 65535 500 '.repeat(15);
    const v = '0 65535 -1000 500 880 '.repeat(15);
    const content = 'BT /F 12 Tf 10 10 Td <0041> Tj ET';
    const pdf = rawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources << /Font << /F 5 0 R >> >> >>',
      [`<< /Length ${content.length} >>`, content],
      '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-V /DescendantFonts [6 0 R] >>',
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /CIDSystemInfo << /Registry (A) /Ordering (I) /Supplement 0 >> /W [${ranges}] /W2 [${v}] >>`,
    ]);
    const d = await loadPdf(pdf, { budget: { maxSteps: 300_000 } });
    expect(() => renderPage(d, 0)).toThrow(/steps/);
  });
});
