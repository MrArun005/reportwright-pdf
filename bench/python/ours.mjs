// @reportwright/pdf's side of the Python comparison: the same jobs and CLI as tasks.py, README defaults only.
//   node ours.mjs reportwright <job> <fixtures dir> <out dir> <runs>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { toBytes, loadPdf, mergePdfs } = await import(pathToFileURL(path.join(here, '../../dist/index.js')).href);
const [, , , job, FIX, OUT, runsArg] = process.argv;
const fx = (n) => fs.readFileSync(path.join(FIX, n)), out = (n, b) => fs.writeFileSync(path.join(OUT, n), b);
const LINE = (p, r) => `Page ${p}, line ${r}: the quick brown fox jumps over the lazy dog ${p * 50 + r}`;
const ROWS = Array.from({ length: 20 }, (_, i) => [`Item ${i + 1} - consulting services`, String(1 + (i % 5)), (120 + i * 7.5).toFixed(2)]);
const PW = { userPassword: 'user', ownerPassword: 'owner' };

const extract = async (n) => out('text.txt', (await loadPdf(fx(n))).extractText());
const JOBS = {
  'create-1000': async () => out('report.pdf', await toBytes(async (pdf) => {
    const f = pdf.standardFont('Times-Roman');
    for (let p = 1; p <= 1000; p++) { const pg = pdf.addPage(); for (let r = 0; r < 50; r++) pg.text(LINE(p, r), { x: 50, y: 40 + r * 15, font: f, size: 10 }); await pg.end(); }
  }, { title: 'Bench' })),
  'invoice-ttf-png': async () => out('invoice.pdf', await toBytes(async (pdf) => {
    const f = await pdf.embedFont(fx('font.ttf')), logo = await pdf.embedImage(fx('logo.png')), p = pdf.addPage();
    p.image(logo, { x: 450, y: 42, width: 96, height: 48 });
    p.text('INVOICE #2026-0042', { x: 50, y: 50, font: f, size: 20 });
    ROWS.forEach((r, k) => r.forEach((v, i) => p.text(v, { x: 55 + [0, 330, 420][i], y: 136 + k * 18, font: f, size: 10 })));
    p.text('Total 3,825.00', { x: 420, y: 136 + 20 * 18 + 10, font: f, size: 10 });
    await p.end();
  })),
  'extract-big': () => extract('big.pdf'),
  'extract-real': () => extract('real.pdf'),
  'merge-100': async () => out('merged.pdf', (await mergePdfs(await Promise.all(Array.from({ length: 100 }, (_, k) => loadPdf(fx(`m${k}.pdf`)))))).bytes),
  'split-pages': async () => { const d = await loadPdf(fx('big.pdf')); for (let i = 0; i < d.pageCount; i++) out(`p${i + 1}.pdf`, (await d.fork().reorder([i]).save()).bytes); },
  'encrypt-aes256': async () => out('enc.pdf', (await (await loadPdf(fx('big.pdf'))).save({ encrypt: PW })).bytes),
  'incremental-info': async () => { const d = await loadPdf(fx('big.pdf')); d.setInfo({ title: 'Changed' }); out('inc.pdf', (await d.saveIncremental()).bytes); },
};

const fn = JOBS[job], runs = Number(runsArg), times = [];
await fn(); // warm-up (or the only run, for a cold measurement)
for (let i = 0; i < runs; i++) { const t = performance.now(); await fn(); times.push(performance.now() - t); }
times.sort((a, b) => a - b);
console.log(JSON.stringify({ warm_ms: runs ? (runs % 2 ? times[runs >> 1] : (times[runs / 2 - 1] + times[runs / 2]) / 2) : null }));
