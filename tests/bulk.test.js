// bulk(): named tasks over many files in worker threads; one bad file never stops the batch.
import { describe, it, expect } from 'vitest';
import wt from 'node:worker_threads';
import zlib from 'node:zlib';
import { bulk, BULK_TASKS, toBytes, loadPdf } from '../src/index.js';

const doc = (label, pages = 2) => toBytes(async (pdf) => {
  const f = pdf.standardFont('Helvetica');
  for (let p = 0; p < pages; p++) { const pg = pdf.addPage(); pg.text(`${label} page ${p + 1}`, { x: 40, y: 40, font: f, size: 12 }); await pg.end(); }
}, { creationDate: new Date(0), id: '00112233445566778899aabbccddeeff' });
/** every Worker made while fn runs, and the ones that exited */
const watchWorkers = async (fn) => {
  const Real = wt.Worker, made = [], exited = [];
  wt.Worker = class extends Real { constructor(...a) { super(...a); made.push(this); this.once('exit', () => exited.push(this)); } };
  try { await fn(); } finally { wt.Worker = Real; }
  return { made, exited };
};
const junk = new Uint8Array([1, 2, 3]);

describe('bulk', () => {
  it('runs each task in workers, results in input order, a bad file failing alone', async () => {
    const a = await doc('Alpha'), b = await doc('Beta', 3);
    const text = await bulk([a, junk, b], 'extractText', { workers: 2 });
    expect(text.map((r) => r.ok)).toEqual([true, false, true]);
    expect(text[0].value).toBe('Alpha page 1\fAlpha page 2');
    expect(text[1].error.code).toBe('E_MALFORMED');
    const split = await bulk([b], 'split', { workers: 2 });
    expect(split[0].value).toHaveLength(3);
    expect((await loadPdf(split[0].value[2])).extractText()).toBe('Beta page 3');
    const merged = await bulk([[a, b], [a, junk]], 'merge', { workers: 2 });
    expect((await loadPdf(merged[0].value)).pageCount).toBe(5);
    expect(merged[1].ok).toBe(false);
    const enc = await bulk([a, b], 'encrypt', { workers: 2, encrypt: { userPassword: 'u', ownerPassword: 'o' } });
    await expect(loadPdf(enc[0].value)).rejects.toThrow();
    expect((await loadPdf(enc[1].value, { password: 'u' })).pageCount).toBe(3);
  }, 30000);
  it('runs sequentially in-process with one worker (the browser path) with the same results', async () => {
    const a = await doc('Solo');
    const r = await bulk([junk, a], 'extractText', { workers: 1 });
    expect(r[0].ok).toBe(false); expect(r[1].value).toBe('Solo page 1\fSolo page 2');
  });
  it('takes named tasks only, never functions', async () => {
    expect(BULK_TASKS).toEqual(['extractText', 'merge', 'split', 'encrypt']);
    await expect(bulk([], 'toString')).rejects.toThrow(TypeError);
    await expect(bulk([], /** @type {any} */ (() => 1))).rejects.toThrow(TypeError);
    await expect(bulk([junk], 'encrypt', { workers: 1 }).then((r) => r[0].error.message)).resolves.toMatch(/encrypt/);
  });
  it('a worker past its heap cap fails only its item, and the next item gets a new worker', async () => {
    // a page whose text pieces need far more than 16 MB of heap
    const parts = ['BT /F1 6 Tf\n']; for (let i = 0; i < 400_000; i++) parts.push(`1 0 0 1 ${20 + (i % 60) * 9} 800 Tm (a) Tj\n`); parts.push('ET\n');
    const c = new TextEncoder().encode(parts.join(''));
    const head = '%PDF-1.7\n', objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
    const chunks = [new TextEncoder().encode(head)]; let off = chunks[0].length; const xref = [];
    objs.forEach((o, k) => { xref.push(off); const b = o ? new TextEncoder().encode(`${k + 1} 0 obj\n${o}\nendobj\n`) : new Uint8Array([...new TextEncoder().encode(`${k + 1} 0 obj\n<< /Length ${c.length} >>\nstream\n`), ...c, ...new TextEncoder().encode('\nendstream\nendobj\n')]); chunks.push(b); off += b.length; });
    chunks.push(new TextEncoder().encode(`xref\n0 6\n0000000000 65535 f \n${xref.map((x) => String(x).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${off}\n%%EOF\n`));
    const big = new Uint8Array(chunks.reduce((n, x) => n + x.length, 0)); { let p = 0; for (const x of chunks) { big.set(x, p); p += x.length; } }
    const small = await doc('After');
    const r = await bulk([big, small, small], 'extractText', { workers: 2, memoryMb: 16 });
    expect(r[0].ok).toBe(false); expect(r[0].error.code).toBe('E_WORKER');
    expect(r[1].value).toBe('After page 1\fAfter page 2'); expect(r[2].ok).toBe(true);
  }, 60000);
  it('gives what a loop in this thread gives, for every task and worker count (small files sent several at a time)', async () => {
    const files = []; for (let i = 0; i < 30; i++) files.push(await doc(`F${i}`, 1 + (i % 3)));
    const save = { creationDate: new Date(0) };
    for (const [task, inputs, o] of [['extractText', files, {}], ['split', files, { save }], ['merge', files.map((f, i) => [f, files[(i + 7) % 30]]), { save }]]) {
      const one = await bulk(inputs, task, { workers: 1, ...o });
      for (const workers of [2, 3]) expect(await bulk(inputs, task, { workers, ...o }), `${task} ${workers}`).toEqual(one);
    }
    // encrypted files differ by their random IVs: the same text once opened
    const enc = await bulk(files, 'encrypt', { workers: 3, encrypt: { userPassword: 'u', ownerPassword: 'o' } });
    const text = await bulk(files, 'extractText', { workers: 1 });
    for (let i = 0; i < files.length; i++) expect((await loadPdf(enc[i].value, { password: 'u' })).extractText()).toBe(text[i].value);
  }, 60000);
  it('a worker that dies fails only the item it was on; the items sent behind it go to a new worker', async () => {
    const parts = ['BT /F1 6 Tf\n']; for (let i = 0; i < 400_000; i++) parts.push(`1 0 0 1 ${20 + (i % 60) * 9} 800 Tm (a) Tj\n`); parts.push('ET\n');
    const c = zlib.deflateSync(new TextEncoder().encode(parts.join('')), { level: 9 }); // small on the way: items go behind it
    const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
    const enc = (t) => new TextEncoder().encode(t), chunks = [enc('%PDF-1.7\n')]; let off = chunks[0].length; const xref = [];
    objs.forEach((o, k) => { xref.push(off); const b = o ? enc(`${k + 1} 0 obj\n${o}\nendobj\n`) : new Uint8Array([...enc(`${k + 1} 0 obj\n<< /Length ${c.length} /Filter /FlateDecode >>\nstream\n`), ...c, ...enc('\nendstream\nendobj\n')]); chunks.push(b); off += b.length; });
    chunks.push(enc(`xref\n0 6\n0000000000 65535 f \n${xref.map((x) => String(x).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${off}\n%%EOF\n`));
    const big = new Uint8Array(chunks.reduce((n, x) => n + x.length, 0)); { let p = 0; for (const x of chunks) { big.set(x, p); p += x.length; } }
    // the big file's worker has small ones queued behind it (several are sent at once): none of them is lost
    const small = await doc('S');
    const inputs = [small, big, small, small, small, junk, small, small, small, small];
    const r = await bulk(inputs, 'extractText', { workers: 1 + 1, memoryMb: 16 });
    expect(r.map((x) => x.ok)).toEqual([true, false, true, true, true, false, true, true, true, true]);
    expect(r[1].error.code).toBe('E_WORKER'); expect(r[5].error.code).toBe('E_MALFORMED');
  }, 60000);
  it('keeps its workers warm between calls, and ends them on an abort or a timeout', async () => {
    const files = []; for (let i = 0; i < 40; i++) files.push(await doc(`W${i}`, 3));
    const o = { workers: 2, encrypt: { userPassword: 'u', ownerPassword: 'o' } };
    await bulk(files, 'encrypt', o);
    const again = await watchWorkers(() => bulk(files, 'encrypt', o));
    expect(again.made.length).toBe(0); // the first call's
    const ac = new AbortController();
    const aborted = await watchWorkers(async () => {
      let n = 0;
      await expect(bulk(files, 'encrypt', { ...o, memoryMb: 64, signal: ac.signal, onResult: () => { if (++n === 3) ac.abort(new Error('stop')); } })).rejects.toThrow('stop');
      await expect(bulk(files, 'encrypt', { ...o, memoryMb: 64, signal: AbortSignal.timeout(5) })).rejects.toMatchObject({ name: 'TimeoutError' });
    });
    await new Promise((ok) => setTimeout(ok, 200));
    expect(aborted.made.length).toBeGreaterThan(0);
    expect(aborted.exited.length).toBe(aborted.made.length); // none kept: ended
  }, 60000);
  it('hostile batch: a stuck item and a worker-killing item fail alone, the rest finish, no worker is left', async () => {
    const small = await doc('H');
    // a "stuck" item: a file whose text takes far longer than itemTimeoutMs (stands in for one that never ends)
    const slowParts = ['BT /F1 6 Tf\n']; for (let i = 0; i < 300_000; i++) slowParts.push(`1 0 0 1 20 800 Tm (a) Tj\n`); slowParts.push('ET\n');
    const mk = (content) => { const c = zlib.deflateSync(new TextEncoder().encode(content)); const e = (t) => new TextEncoder().encode(t);
      const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
      const ch = [e('%PDF-1.7\n')]; let off = ch[0].length; const x = [];
      objs.forEach((o, k) => { x.push(off); const b = o ? e(`${k + 1} 0 obj\n${o}\nendobj\n`) : new Uint8Array([...e(`${k + 1} 0 obj\n<< /Length ${c.length} /Filter /FlateDecode >>\nstream\n`), ...c, ...e('\nendstream\nendobj\n')]); ch.push(b); off += b.length; });
      ch.push(e(`xref\n0 6\n0000000000 65535 f \n${x.map((v) => String(v).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${off}\n%%EOF\n`));
      const out = new Uint8Array(ch.reduce((n, y) => n + y.length, 0)); let p = 0; for (const y of ch) { out.set(y, p); p += y.length; } return out; };
    const stuck = mk(slowParts.join(''));
    const killParts = ['BT /F1 6 Tf\n']; for (let i = 0; i < 400_000; i++) killParts.push(`1 0 0 1 ${20 + (i % 60) * 9} 800 Tm (a) Tj\n`); killParts.push('ET\n');
    const killer = mk(killParts.join(''));
    const inputs = [small, stuck, small, killer, small, stuck, small, killer, small, junk, small];
    let r;
    const w = await watchWorkers(async () => { r = await bulk(inputs, 'extractText', { workers: 2, memoryMb: 16, itemTimeoutMs: 40 }); });
    expect(r.map((x) => x.ok)).toEqual([true, false, true, false, true, false, true, false, true, false, true]);
    for (const k of [1, 5]) expect(['E_TIMEOUT', 'E_WORKER']).toContain(r[k].error.code);
    expect(r[3].error.code).toMatch(/E_WORKER|E_TIMEOUT/);
    expect(w.made.length).toBeLessThanOrEqual(2 + 4); // one new worker a failed item at most
    await expect(bulk([small], 'extractText', { workers: 1e6 })).rejects.toThrow(TypeError);
    await expect(bulk([small, small], 'extractText', { workers: 2, memoryMb: 1e9 })).rejects.toThrow(TypeError);
    await expect(bulk([small, small], 'extractText', { workers: 2, itemTimeoutMs: -1 })).rejects.toThrow(TypeError);
  }, 60000);
});
