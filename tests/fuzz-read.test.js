// Group H fuzzing: the seed PDFs (ours: plain, form, AES-128, tagged PDF/A-3a with an attachment, layers, AES-256;
// pdf-lib's with and without object streams; macOS's own when present, read at run time, never committed) mutated
// FUZZ_ITER times in all (default 200 locally; the cloud job runs 20,000) with a fixed seed (FUZZ_SEED, default
// 20261009): bit flips, truncation, duplicated and removed byte ranges, numbers swapped for hostile ones. Every load,
// read, save and merge either succeeds or throws a typed error (PdfReadError, or a TypeError / RangeError with our own
// message — never "Cannot read properties of undefined", a stack overflow or an invalid array length), each in under
// 2 s, with the heap bounded. FUZZ_REPORT=path writes the result as JSON.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { loadPdf, mergePdfs, toBytes, PdfReadError } from '../src/index.js';
import { seeds } from './reader-tools.js';

const ITER = Number(process.env.FUZZ_ITER || 200), SEED = Number(process.env.FUZZ_SEED || 20261009), LIMIT = 2000;
const CRASH = /Cannot read prop|Cannot set prop|is not a function|is not iterable|Maximum call stack|Invalid array length|Invalid typed array length|Array buffer allocation failed|out of memory|internal:/i;

/** mulberry32: a fixed, reproducible stream */
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const HOSTILE = ['0', '-1', '1', '2147483648', '4294967296', '1000000000', '999999999999', '-2147483649', '3.4e38', '0.000001', '65535', '1e308', 'NaN'];

function mutate(src, r) {
  let b = Buffer.from(src);
  const n = 1 + Math.floor(r() * 3), what = [];
  for (let k = 0; k < n; k++) {
    const kind = Math.floor(r() * 5), at = Math.floor(r() * b.length);
    if (kind === 0) { for (let i = 0, m = 1 + Math.floor(r() * 8); i < m; i++) { const p = Math.floor(r() * b.length); b[p] ^= 1 << Math.floor(r() * 8); } what.push('flip'); }
    else if (kind === 1) { b = b.subarray(0, at); what.push('truncate'); }
    else if (kind === 2) { const len = Math.floor(r() * 1024), to = Math.floor(r() * b.length); b = Buffer.concat([b.subarray(0, to), b.subarray(at, at + len), b.subarray(to)]); what.push('duplicate'); }
    else if (kind === 3) { const len = Math.floor(r() * 1024); b = Buffer.concat([b.subarray(0, at), b.subarray(at + len)]); what.push('remove'); }
    else { // a number swapped for a hostile one
      const s = b.toString('latin1'), re = /\d+/g; re.lastIndex = at;
      const m = re.exec(s) ?? /\d+/.exec(s);
      if (m) b = Buffer.concat([b.subarray(0, m.index), Buffer.from(HOSTILE[Math.floor(r() * HOSTILE.length)], 'latin1'), b.subarray(m.index + m[0].length)]);
      what.push('number');
    }
  }
  return { bytes: new Uint8Array(b), what: what.join('+') };
}

describe('fuzz: mutated PDFs load, read, save and merge or fail typed, fast, bounded', () => {
  it(`${ITER} mutations (seed ${SEED})`, async () => {
    const s = await seeds();
    const all = [...s.all];
    all.push(await toBytes(async (pdf) => { pdf.addPage({ width: 200, height: 200 }).text('AES-256', { x: 10, y: 10, font: pdf.standardFont('Helvetica') }); }, { encrypt: { userPassword: '' }, creationDate: new Date('2026-01-01') }));
    const clean = await loadPdf(s.ours[0]);
    const r = rng(SEED);
    const heap0 = process.memoryUsage().heapUsed;
    let maxMs = 0, loaded = 0, typed = 0, saved = 0, maxHeap = 0;
    const failures = [];
    const codes = {};
    const step = async (label, fn) => { // eslint-disable-line
      const t = performance.now();
      try { await fn(); return true; }
      catch (e) {
        const ok = e instanceof PdfReadError || ((e instanceof TypeError || e instanceof RangeError) && !CRASH.test(e.message));
        if (!ok) failures.push(`${label}: ${e?.name}: ${String(e?.message).slice(0, 200)}`);
        else { typed++; const c = `${label.split(' ').pop()}:${e.code ?? e.name}`; codes[c] = (codes[c] ?? 0) + 1; }
        return false;
      } finally {
        const ms = performance.now() - t; maxMs = Math.max(maxMs, ms);
        if (ms > LIMIT) failures.push(`${label}: took ${ms.toFixed(0)} ms`);
      }
    };
    for (let i = 0; i < ITER; i++) {
      const seed = all[i % all.length];
      const { bytes, what } = mutate(seed, r);
      const label = `#${i} seed ${i % all.length} (${what})`;
      let d = null;
      if (!(await step(`${label} load`, async () => { d = await loadPdf(bytes); }))) continue;
      loaded++;
      await step(`${label} read`, async () => {
        void d.info; void d.fields; void d.outlines; void d.signatures; void d.pdfa;
        for (const a of d.attachments.slice(0, 2)) a.bytes();
        for (let k = 0; k < Math.min(2, d.pageCount); k++) d.page(k).extractText();
      });
      if (await step(`${label} save`, async () => { await d.save(); })) saved++;
      if (i % 4 === 0) await step(`${label} merge`, async () => { await mergePdfs([d, clean]); });
      maxHeap = Math.max(maxHeap, process.memoryUsage().heapUsed - heap0);
      expect(maxHeap, 'heap growth').toBeLessThan(1.5 * 2 ** 30);
    }
    const result = { iterations: ITER, seed: SEED, seeds: all.length, loaded, saved, typedErrors: typed, errorCodes: codes, maxMs: Math.round(maxMs), maxHeapGrowthMB: Math.round(maxHeap / 2 ** 20), failures };
    if (process.env.FUZZ_REPORT) fs.writeFileSync(process.env.FUZZ_REPORT, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, failures: failures.length }));
    expect(failures).toEqual([]);
  }, Math.max(60_000, ITER * 3000));
});
