// Benchmark: @reportwright/pdf (dist) against pdf-lib and PDFKit when they are in node_modules (nothing is installed).
// Cases: a 1-page invoice and a 1,000-page text document, standard fonts only. Measures output size, warm time (median of
// 10 runs in one process, after a warm-up) and cold time (median of 10 new `node` processes: start, import, build, write).
//   node packages/pdf/bench/compare.mjs            (build dist first: node packages/pdf/build.mjs)
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../../../package.json'));
const has = (m) => { try { require.resolve(m); return true; } catch { return false; } };

const ROWS = Array.from({ length: 20 }, (_, i) => [`Item ${i + 1} — consulting services`, String(1 + (i % 5)), (120 + i * 7.5).toFixed(2)]);
const LINE = (p, r) => `Page ${p}, line ${r}: the quick brown fox jumps over the lazy dog ${p * 50 + r}`;

/** each library: (kase) => Promise<Uint8Array> */
const LIBS = {
  async reportwright(kase) {
    const { toBytes } = await import(pathToFileURL(path.join(here, '../dist/index.js')).href);
    return toBytes(async (pdf) => {
      const reg = pdf.standardFont(kase === 'invoice' ? 'Helvetica' : 'Times-Roman');
      if (kase === 'invoice') {
        const bold = pdf.standardFont('Helvetica-Bold');
        const p = pdf.addPage();
        p.text('INVOICE #2026-0042', { x: 50, y: 50, font: bold, size: 20 });
        p.text('Acme Ltd · 1 Main Street · Springfield', { x: 50, y: 80, font: reg, size: 10, color: 0.4 });
        p.rect(50, 110, 495, 20, { fill: '#1f4e79' });
        ['Description', 'Qty', 'Amount'].forEach((h, i) => p.text(h, { x: 55 + [0, 330, 420][i], y: 114, font: bold, size: 10, color: '#ffffff' }));
        ROWS.forEach((r, k) => { r.forEach((v, i) => p.text(v, { x: 55 + [0, 330, 420][i], y: 136 + k * 18, font: reg, size: 10 })); p.line(50, 151 + k * 18, 545, 151 + k * 18, { color: 0.85, width: 0.5 }); });
        p.text('Total 3,825.00', { x: 420, y: 136 + 20 * 18 + 10, font: bold, size: 12 });
        await p.end();
      } else {
        for (let i = 1; i <= 1000; i++) { const p = pdf.addPage(); for (let r = 0; r < 50; r++) p.text(LINE(i, r), { x: 50, y: 40 + r * 15, font: reg, size: 10 }); await p.end(); }
      }
    }, { title: 'Bench', creationDate: new Date(0) });
  },
  async 'pdf-lib'(kase) {
    const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
    const doc = await PDFDocument.create();
    doc.setTitle('Bench');
    const reg = await doc.embedFont(kase === 'invoice' ? StandardFonts.Helvetica : StandardFonts.TimesRoman);
    if (kase === 'invoice') {
      const bold = await doc.embedFont(StandardFonts.HelveticaBold);
      const p = doc.addPage([595.28, 841.89]), H = 841.89;
      p.drawText('INVOICE #2026-0042', { x: 50, y: H - 50 - 20 * 0.718, font: bold, size: 20 });
      p.drawText('Acme Ltd · 1 Main Street · Springfield', { x: 50, y: H - 80 - 7.18, font: reg, size: 10, color: rgb(0.4, 0.4, 0.4) });
      p.drawRectangle({ x: 50, y: H - 130, width: 495, height: 20, color: rgb(0.12, 0.31, 0.47) });
      ['Description', 'Qty', 'Amount'].forEach((h, i) => p.drawText(h, { x: 55 + [0, 330, 420][i], y: H - 114 - 7.18, font: bold, size: 10, color: rgb(1, 1, 1) }));
      ROWS.forEach((r, k) => { r.forEach((v, i) => p.drawText(v, { x: 55 + [0, 330, 420][i], y: H - 136 - k * 18 - 7.18, font: reg, size: 10 })); p.drawLine({ start: { x: 50, y: H - 151 - k * 18 }, end: { x: 545, y: H - 151 - k * 18 }, thickness: 0.5, color: rgb(0.85, 0.85, 0.85) }); });
      p.drawText('Total 3,825.00', { x: 420, y: H - 136 - 370 - 8.6, font: bold, size: 12 });
    } else {
      for (let i = 1; i <= 1000; i++) { const p = doc.addPage([595.28, 841.89]); for (let r = 0; r < 50; r++) p.drawText(LINE(i, r), { x: 50, y: 841.89 - 40 - r * 15 - 6.83, font: reg, size: 10 }); }
    }
    return doc.save();
  },
  async pdfkit(kase) {
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ size: 'A4', autoFirstPage: false, compress: true, info: { Title: 'Bench' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    const done = new Promise((r) => doc.on('end', r));
    if (kase === 'invoice') {
      doc.addPage();
      doc.font('Helvetica-Bold').fontSize(20).text('INVOICE #2026-0042', 50, 50, { lineBreak: false });
      doc.font('Helvetica').fontSize(10).fillColor('#666').text('Acme Ltd · 1 Main Street · Springfield', 50, 80, { lineBreak: false });
      doc.rect(50, 110, 495, 20).fill('#1f4e79');
      doc.font('Helvetica-Bold').fillColor('#fff');
      ['Description', 'Qty', 'Amount'].forEach((h, i) => doc.text(h, 55 + [0, 330, 420][i], 114, { lineBreak: false }));
      doc.font('Helvetica').fillColor('#000');
      ROWS.forEach((r, k) => { r.forEach((v, i) => doc.text(v, 55 + [0, 330, 420][i], 136 + k * 18, { lineBreak: false })); doc.moveTo(50, 151 + k * 18).lineTo(545, 151 + k * 18).lineWidth(0.5).stroke('#d9d9d9'); });
      doc.font('Helvetica-Bold').fontSize(12).text('Total 3,825.00', 420, 506, { lineBreak: false });
    } else {
      doc.font('Times-Roman').fontSize(10);
      for (let i = 1; i <= 1000; i++) { doc.addPage(); for (let r = 0; r < 50; r++) doc.text(LINE(i, r), 50, 40 + r * 15, { lineBreak: false }); }
    }
    doc.end();
    await done;
    return Buffer.concat(chunks);
  },
};

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

// child mode: build one case once and exit (the cold measurement)
if (process.argv[2] === '--once') {
  const out = await LIBS[process.argv[3]](process.argv[4]);
  process.stdout.write(String(out.length));
  process.exit(0);
}

const libs = Object.keys(LIBS).filter((l) => l === 'reportwright' || has(l));
const missing = Object.keys(LIBS).filter((l) => !libs.includes(l));
const rows = [];
for (const kase of ['invoice', 'text-1000']) {
  for (const lib of libs) {
    let size = 0;
    await LIBS[lib](kase); // warm-up
    const warm = [];
    for (let i = 0; i < 10; i++) { const t = performance.now(); size = (await LIBS[lib](kase)).length; warm.push(performance.now() - t); }
    const cold = [];
    for (let i = 0; i < 10; i++) { const t = performance.now(); execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--once', lib, kase]); cold.push(performance.now() - t); }
    rows.push({ case: kase, library: lib, bytes: size, warmMs: +median(warm).toFixed(1), coldMs: +median(cold).toFixed(0) });
    console.error(`${kase} ${lib}: ${size} bytes, warm ${median(warm).toFixed(1)} ms, cold ${median(cold).toFixed(0)} ms`);
  }
}
console.table(rows);
if (missing.length) console.log(`not in node_modules (not measured): ${missing.join(', ')}`);
console.log(`node ${process.version}, ${process.platform} ${process.arch}`);
