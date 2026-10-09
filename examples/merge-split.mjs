// Read and modify: merge, split, extract text, and an incremental update that keeps the original bytes.
//
//   node examples/merge-split.mjs [outDir]   writes merged.pdf, page-1.pdf … page-N.pdf, updated.pdf
import fs from 'node:fs';
import path from 'node:path';
import { toBytes, loadPdf, mergePdfs } from '../dist/index.js';

const dir = process.argv[2] ?? '.';
const make = (label, n) => toBytes(async (pdf) => {
  const font = pdf.standardFont('Helvetica');
  for (let i = 1; i <= n; i++) { const p = pdf.addPage(); p.text(`${label}, page ${i}`, { x: 40, y: 40, font, size: 16 }); await p.end(); }
}, { title: label });
const a = await loadPdf(await make('Contract', 2)), b = await loadPdf(await make('Annexure', 1));

const merged = await mergePdfs([a, b]);                         // a new file, every page of each
fs.writeFileSync(path.join(dir, 'merged.pdf'), merged.bytes);
const all = await loadPdf(merged.bytes);
console.log(`merged: ${all.pageCount} pages; text:`, all.extractText().split('\f').map((t) => t.trim()));

for (let i = 0; i < all.pageCount; i++) {                       // split: a fork per page
  const { bytes } = await all.fork().reorder([i]).save();
  fs.writeFileSync(path.join(dir, `page-${i + 1}.pdf`), bytes);
}

const doc = await loadPdf(merged.bytes);
doc.setInfo({ title: 'Contract (reviewed)' });
const update = await doc.saveIncremental();                     // original bytes + an appended update
fs.writeFileSync(path.join(dir, 'updated.pdf'), update.bytes);
console.log(`split into ${all.pageCount} files; update appended ${update.size - merged.bytes.length} bytes`);
