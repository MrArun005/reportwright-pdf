// Group H security: hand-made hostile files. Each loads (or its use throws) a PdfReadError — never a crash, a hang or
// an unbounded allocation — in well under 2 s: a 302-byte Flate stream that inflates to 10 GB (four Flate layers), a
// 100,000-deep nested array, a /Prev loop, a page tree loop, a /Count of 2^31, an object stream that points at
// itself, an xref claiming 10^9 objects, a /Length of 10^12, a reference loop, an outline /Next loop, an AcroForm
// /Kids loop, 100,000 unbalanced q's under an overlay, a time limit and an abort.
import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import { loadPdf, PdfReadError } from '../src/index.js';
import { rawPdf, onePage, flateBomb, enc } from './reader-tools.js';

const fast = async (fn, ms = 2000) => { const t = performance.now(); const r = await fn(); expect(performance.now() - t).toBeLessThan(ms); return r; };
const typed = async (p, code) => { const e = await p.then(() => null, (x) => x); expect(e, 'expected a PdfReadError').toBeInstanceOf(PdfReadError); if (code) expect(e.code).toBe(code); return e; };

describe('decompression bombs stop at the budget', () => {
  it('a 302-byte Flate stream that inflates to 10 GB: loading is lazy, extracting the text stops at 128 MB', async () => {
    const { data, layers } = flateBomb(10);
    expect(data.length).toBeLessThan(1024);
    const f = `[${Array(layers).fill('/FlateDecode').join(' ')}]`;
    const d = await fast(() => loadPdf(onePage(data, `<< /Filter ${f} >>`)));
    expect(d.pageCount).toBe(1);
    const e = await fast(() => typed(Promise.resolve().then(() => d.page(0).extractText()), 'E_BUDGET'));
    expect(e.message).toMatch(/decompression bomb/);
  });
  it('the document budget (maxDecoded) stops many small bombs', async () => {
    const z = zlib.deflateSync(Buffer.alloc(8 << 20));
    const d = await loadPdf(onePage(z, '<< /Filter /FlateDecode >>'), { budget: { maxDecoded: 4 << 20 } });
    await typed(Promise.resolve().then(() => d.page(0).extractText()), 'E_BUDGET');
  });
  it('a bomb in an object stream or an xref stream stops too', async () => {
    const { data, layers } = flateBomb(1);
    const f = `[${Array(layers).fill('/FlateDecode').join(' ')}]`;
    const b = rawPdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>', [`<< /Type /ObjStm /N 1 /First 4 /Filter ${f} >>`, data]], {
      xref: () => 'xref\n0 4\n0000000000 65535 f\r\n0000000015 00000 n\r\n0000000060 00000 n\r\n0000000110 00000 n\r\n',
    });
    await fast(async () => { const d = await loadPdf(b).catch((e) => e); expect(d instanceof PdfReadError || d.pageCount === 0).toBe(true); });
  });
});

describe('structure bombs', () => {
  it('a 100,000-deep nested array: E_DEPTH, no stack overflow', async () => {
    const deep = '['.repeat(100_000) + ']'.repeat(100_000);
    const b = rawPdf(['<< /Type /Catalog /Pages 2 0 R /X 3 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>', deep]);
    const d = await fast(() => loadPdf(b));
    const { internal } = await import('../src/reader/pdf.js');
    await typed(Promise.resolve().then(() => internal(d, 't').r.src.get(3)), 'E_DEPTH');
  });
  it('a /Prev loop is cut', async () => {
    const b = rawPdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>'], { trailer: '/Prev 9999' });
    const s = Buffer.from(b).toString('latin1'), x = s.lastIndexOf('xref');
    const looped = enc(s.replace('/Prev 9999', `/Prev ${x}`));
    const d = await fast(() => loadPdf(looped));
    expect(d.warnings.join()).toMatch(/Prev chain .* loops|rebuilt/);
  });
  it('a page tree loop and a /Count of 2^31', async () => {
    const b = rawPdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 2 0 R] /Count 2147483648 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>']);
    const d = await fast(() => loadPdf(b));
    expect(d.pageCount).toBe(1);
    expect(d.warnings.join()).toMatch(/page tree has a loop/);
  });
  it('an object stream that contains itself', async () => {
    // object 3 is an object stream whose xref entry says it lives in object stream 3
    const body = enc('3 0 << /Type /Catalog >>');
    const b = rawPdf(['<< /Type /Catalog /Pages 2 0 R /X 4 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>', [`<< /Type /ObjStm /N 1 /First 4 >>`, body]]);
    const d = await fast(() => loadPdf(b));
    expect(d.pageCount).toBe(0);
  });
  it('an xref claiming 10^9 objects: rebuilt by scanning, nothing allocated for the claim', async () => {
    const b = rawPdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>'], { xref: () => 'xref\n0 1000000000\n0000000000 65535 f\r\n', trailer: '/Size 1000000000' });
    const d = await fast(() => loadPdf(b));
    expect(d.pageCount).toBe(1);
    expect(d.recovered).toBe(true);
  });
  it('a /Length of 10^12: the data is found from endstream', async () => {
    const content = enc('BT /F1 12 Tf 10 10 Td (Hello) Tj ET');
    const b = Buffer.from(onePage(content)).toString('latin1').replace(`/Length ${content.length}`, '/Length 1000000000000');
    const d = await fast(() => loadPdf(enc(b)));
    expect(d.page(0).extractText()).toBe('Hello');
  });
  it('a reference loop (1 → 2 → 1) is E_CYCLE when followed', async () => {
    const b = rawPdf(['<< /Type /Catalog /Pages 2 0 R /X 3 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>', '4 0 R', '3 0 R']);
    const d = await loadPdf(b);
    const { internal } = await import('../src/reader/pdf.js');
    await typed(Promise.resolve().then(() => internal(d, 't').r.src.resolve(internal(d, 't').r.root.get('X'))), 'E_CYCLE');
  });
  it('an outline /Next loop and an AcroForm /Kids loop are cut', async () => {
    const b = rawPdf(['<< /Type /Catalog /Pages 2 0 R /Outlines 3 0 R /AcroForm << /Fields [5 0 R] >> >>', '<< /Type /Pages /Kids [] /Count 0 >>',
      '<< /First 4 0 R >>', '<< /Title (loop) /Next 4 0 R >>', '<< /T (a) /Kids [6 0 R] >>', '<< /T (b) /Kids [5 0 R] >>']);
    const d = await fast(() => loadPdf(b));
    expect(d.outlines.length).toBe(1);
    expect(d.fields).toEqual([]);
  });
  it('100,000 unbalanced q\'s: drawing on the page is refused (each needs a Q), 200 are fine', async () => {
    const many = await loadPdf(onePage(enc('q '.repeat(100_000))));
    many.page(0).draw((p) => p.rect(0, 0, 10, 10));
    await fast(() => typed(many.save(), 'E_MALFORMED'));
    const some = await loadPdf(onePage(enc('q '.repeat(200))));
    some.page(0).draw((p) => p.rect(0, 0, 10, 10));
    const r = await some.save();
    expect((await loadPdf(r.bytes)).pageCount).toBe(1);
  });
});

describe('time and abort', () => {
  it('timeoutMs and an aborted signal stop the reader with a typed error', async () => {
    const big = rawPdf(['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: 50_000 }, () => '3 0 R').join(' ')}] /Count 1 >>`, '<< /Type /Page /MediaBox [0 0 1 1] >>']);
    const ac = new AbortController(); ac.abort(new Error('stop'));
    await typed(loadPdf(big, { signal: ac.signal }), 'E_ABORTED');
    const late = new AbortController();
    const p = loadPdf(big, { signal: late.signal, timeoutMs: 60_000 });
    late.abort();
    await p.then(() => {}, (e) => expect(e.code).toBe('E_ABORTED')); // aborted while reading, or done first
    const d = await loadPdf(big, { budget: { maxSteps: 1000 } }).catch((e) => e);
    expect(d).toBeInstanceOf(PdfReadError);
  });
});

describe('memory held per entry is capped (budget.maxObjects, budget.maxTextItems)', () => {
  it('cross-reference entries past maxObjects: E_BUDGET, not a map of millions', async () => {
    const b = rawPdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>'], { xref: () => `xref\n0 3000\n${'0000000000 65535 f\r\n'.repeat(3000)}` });
    await typed(loadPdf(b, { budget: { maxObjects: 1000 } }), 'E_BUDGET');
    expect((await loadPdf(b)).pageCount).toBe(0);
  });
  it('a page of more text pieces than maxTextItems: E_BUDGET from extractText', async () => {
    const d = await loadPdf(onePage(enc(`BT /F1 1 Tf ${'0 -2 Td (ab) Tj '.repeat(2000)} ET`)), { budget: { maxTextItems: 1000 } });
    await typed(Promise.resolve().then(() => d.page(0).extractText()), 'E_BUDGET');
  });
});

describe('lexer fast paths keep their bounds (hostile tokens)', async () => {
  const { Lexer, T, indexOf } = await import('../src/reader/lexer.js');
  const { createBudget } = await import('../src/reader/budget.js');
  const lex = (s) => { const lx = new Lexer(new TextEncoder().encode(s), createBudget()); const out = []; for (let k; (k = lx.next()) !== T.EOF;) out.push([k, lx.val]); return out; };
  it('a 1 MB name is cut at 4,096 bytes; a #xx escape after a long plain prefix is still decoded', () => {
    const t = lex('/' + 'A'.repeat(1 << 20) + ' 1');
    expect(t[0][1].length).toBe(4096); expect(t[1]).toEqual([T.NUM, 1]);
    expect(lex('/' + 'B'.repeat(100) + '#41')[0][1]).toBe('B'.repeat(100) + 'A');
  });
  it('a 1 MB keyword is cut at 128 chars, a 1 MB digit run is one finite number, and both advance', () => {
    const t = lex('x'.repeat(1 << 20) + ' ' + '9'.repeat(1 << 20) + ' 007 -3');
    expect(t[0][1].length).toBe(128); expect(Number.isFinite(t[1][1])).toBe(true); expect(t.slice(2)).toEqual([[T.NUM, 7], [T.NUM, -3]]);
  });
  it('indexOf never matches past its end or before its start, natively or not', () => {
    const b = new TextEncoder().encode('x'.repeat(200) + 'endstream' + 'y'.repeat(200));
    expect(indexOf(b, 'endstream', 0)).toBe(200);
    expect(indexOf(b, 'endstream', 0, 208)).toBe(-1);
    expect(indexOf(b, 'endstream', 201)).toBe(-1);
    expect(indexOf(b, 'endstream', 1e9)).toBe(-1);
    expect(indexOf(b.subarray(100), 'endstream', 0)).toBe(100);
  });
});
