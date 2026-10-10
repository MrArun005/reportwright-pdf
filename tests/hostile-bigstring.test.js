// A hostile file with one huge string (the gate's bigstring.pdf): load, info, text and save must hold a few copies at
// most, not a rope of one node per char (a 40 MB title used to peak above 1 GB). Each case runs in its own process so
// the peak (maxRSS) is its own; 16 MB keeps it laptop-sized, the limit scales with it.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { PdfString } from '../src/reader/lexer.js';
import { decodeText } from '../src/reader/text.js';

const MB = 16;
const CHILD = `
const N = ${MB} << 20, kind = process.argv[1];
const body = kind === 'hex' ? '<' + 'ab'.repeat(N) + '>' : '(' + 'A'.repeat(N) + ')';
const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>', '<< /Title ' + body + ' >>'];
let s = '%PDF-1.4\\n'; const off = [];
objs.forEach((o, i) => { off.push(s.length); s += (i + 1) + ' 0 obj\\n' + o + '\\nendobj\\n'; });
const x = s.length; s += 'xref\\n0 5\\n0000000000 65535 f \\n' + off.map((o) => String(o).padStart(10, '0') + ' 00000 n \\n').join('') + 'trailer\\n<< /Size 5 /Root 1 0 R /Info 4 0 R >>\\nstartxref\\n' + x + '\\n%%EOF\\n';
const bytes = new Uint8Array(Buffer.from(s, 'latin1')); s = null;
const { loadPdf } = await import(${JSON.stringify(new URL('../src/index.js', import.meta.url).href)});
globalThis.gc(); const base = process.memoryUsage().rss;
const d = await loadPdf(bytes); const len = d.info.title.length; d.page(0).extractText();
const sv = await d.save(); const back = await loadPdf(sv.bytes);
const r = { len, saved: back.info.title.length, warned: sv.warnings.some((w) => /title .* was cut/.test(w)) };
r.merged = (await (await loadPdf(bytes)).merge([await loadPdf(bytes)]).save()).bytes.length > 0;
r.split = (await (await loadPdf(bytes)).merge([await loadPdf(bytes)]).removePages([1]).save()).bytes.length > 0;
r.inc = (await (await loadPdf(bytes)).saveIncremental({})).bytes.length >= bytes.length;
r.deltaMB = (process.resourceUsage().maxRSS * 1024 - base) / 2 ** 20;
console.log(JSON.stringify(r));
`;
const run = (kind) => {
  const r = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', CHILD, kind], { encoding: 'utf8', timeout: 60_000 });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
};

describe('a huge string', () => {
  for (const kind of ['literal', 'hex']) it(`a ${MB} MB ${kind} string stays within a few copies of itself`, () => {
    const r = run(kind);
    expect(r.len).toBe(MB << 20);
    expect(r).toMatchObject({ saved: 65536, warned: true, merged: true, split: true, inc: true }); // never a failed save on an unedited file
    expect(r.deltaMB).toBeLessThan(MB * 8); // was ~28× (a 40 MB literal: 1,151 MB peak)
  }, 60_000);
  it('setInfo still refuses an oversized title', async () => {
    const { loadPdf } = await import('../src/index.js');
    const { toBytes } = await import('../src/index.js');
    const d = await loadPdf(await toBytes(async (pdf) => { await pdf.addPage().end(); }));
    expect(() => d.setInfo({ title: 'x'.repeat(65537) })).toThrow(/at most 65,536/);
  });
  it('decodeText keeps its mapping: PDFDocEncoding, UTF-16BE with a lone surrogate, UTF-8', () => {
    expect(decodeText(new PdfString(new Uint8Array([0x41, 0x18, 0x80, 0xe9])))).toBe('A˘•é');
    expect(decodeText(new PdfString(new Uint8Array([0xfe, 0xff, 0x00, 0x41, 0xd8, 0x00, 0x00, 0x42, 0x00])))).toBe('A\ud800B');
    expect(decodeText(new PdfString(new Uint8Array([0xef, 0xbb, 0xbf, 0xc3, 0xa9])))).toBe('é');
  });
});

describe('a huge string drawn with Tj', () => {
  it(`a ${MB} MB (AAAA…) Tj: extractText reads it or stops with E_BUDGET, within a few copies, never out of memory`, () => {
    const r = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', `
      const N = ${MB} << 20, content = 'BT /F1 12 Tf 10 700 Td (' + 'A'.repeat(N) + ') Tj ET';
      const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', '<< /Length ' + content.length + ' >>\\nstream\\n' + content + '\\nendstream', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
      let s = '%PDF-1.4\\n'; const off = [];
      objs.forEach((o, i) => { off.push(s.length); s += (i + 1) + ' 0 obj\\n' + o + '\\nendobj\\n'; });
      const x = s.length; s += 'xref\\n0 6\\n0000000000 65535 f \\n' + off.map((o) => String(o).padStart(10, '0') + ' 00000 n \\n').join('') + 'trailer\\n<< /Size 6 /Root 1 0 R >>\\nstartxref\\n' + x + '\\n%%EOF\\n';
      const bytes = new Uint8Array(Buffer.from(s, 'latin1')); s = null;
      const { loadPdf } = await import(${JSON.stringify(new URL('../src/index.js', import.meta.url).href)});
      globalThis.gc(); const base = process.memoryUsage().rss;
      const d = await loadPdf(bytes); let len = -1, code = null;
      try { len = d.page(0).extractText().length; } catch (e) { code = e.code ?? String(e); }
      console.log(JSON.stringify({ len, code, deltaMB: (process.resourceUsage().maxRSS * 1024 - base) / 2 ** 20 }));`], { encoding: 'utf8', timeout: 120_000 });
    expect(r.status, r.stderr).toBe(0); // an out-of-memory crash is a non-zero exit
    const o = JSON.parse(r.stdout);
    // 16 M characters are past MAX_TEXT_CHARS (16,000,000): the clean budget error, as the merge leaves one piece
    expect(o).toMatchObject({ len: -1, code: 'E_BUDGET' });
    expect(o.deltaMB).toBeLessThan(MB * 5);
  }, 120_000);
});

describe('hexText (strings written by save and copy)', () => {
  it('a 16 MB string becomes one flat hex string, not a rope of 16 M nodes', async () => {
    const { hexText } = await import('../src/reader/copy.js');
    const r = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', `
      const { hexText } = await import(${JSON.stringify(new URL('../src/reader/copy.js', import.meta.url).href)});
      const b = new Uint8Array(${MB} << 20).fill(0xab); globalThis.gc(); const base = process.memoryUsage().rss;
      const s = hexText(b); console.log(JSON.stringify({ len: s.length, deltaMB: (process.resourceUsage().maxRSS * 1024 - base) / 2 ** 20 }));`], { encoding: 'utf8', timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
    const o = JSON.parse(r.stdout);
    expect(o.len).toBe((MB << 21) + 2);
    expect(o.deltaMB).toBeLessThan(MB * 6); // the per-byte += rope was ~30× the bytes
    expect(hexText(new Uint8Array([0, 15, 255]))).toBe('<000fff>');
    expect(hexText(new Uint8Array(100).fill(1))).toBe(`<${'01'.repeat(100)}>`);
  }, 60_000);
});

describe('indexOf in a window', () => {
  it('searching many small windows of a large buffer stays linear (does not scan to the end each time)', async () => {
    const { indexOf } = await import('../src/reader/lexer.js');
    const b = new Uint8Array(8 << 20).fill(0x20); // 8 MB, no needle
    b.set([0x58, 0x52, 0x65, 0x66], b.length - 4); // "XRef" only at the very end
    const t = performance.now();
    for (let i = 0; i + 4096 < b.length; i += 512) expect(indexOf(b, 'XRef', i, i + 4096)).toBe(-1); // 16 K windows
    expect(performance.now() - t).toBeLessThan(2000); // to the end each time: 16 K × 8 MB, minutes
    expect(indexOf(b, 'XRef', 0)).toBe(b.length - 4);
    expect(indexOf(b, 'XRef', 0, b.length - 1)).toBe(-1); // a match crossing `to` is not one
  }, 20_000);
});
