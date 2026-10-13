// Read and modify: merge two files, extract text, split into one file per page, and an incremental
// update that keeps the original bytes untouched.
import { toBytes, loadPdf, mergePdfs } from '@reportwright/pdf';

const make = (label, n) => toBytes(async (pdf) => {
  const font = pdf.standardFont('Helvetica');
  for (let i = 1; i <= n; i++) { const p = pdf.addPage(); p.text(label + ', page ' + i, { x: 40, y: 40, font, size: 16 }); await p.end(); }
}, { title: label });
const a = await loadPdf(await make('Contract', 2)), b = await loadPdf(await make('Annexure', 1));

const merged = await mergePdfs([a, b]);
show(merged.bytes, 'merged.pdf');
const all = await loadPdf(merged.bytes);
log('merged:', all.pageCount, 'pages; text per page:', JSON.stringify(all.extractText().split('\f').map((t) => t.trim())));

for (let i = 0; i < all.pageCount; i++) {                                   // split: a fork per page
  const { bytes } = await all.fork().reorder([i]).save();
  show(bytes, 'page-' + (i + 1) + '.pdf');
}

const doc = await loadPdf(merged.bytes);
doc.setInfo({ title: 'Contract (reviewed)' });
const update = await doc.saveIncremental();                                 // original bytes + appended update
log('incremental update appended', update.bytes.length - merged.bytes.length, 'bytes');
show(update.bytes, 'updated.pdf');
