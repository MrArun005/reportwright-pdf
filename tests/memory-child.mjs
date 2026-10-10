// Run by streaming.test.js in its own process (node --expose-gc): writes PAGES pages of text to a sink that throws the
// bytes away, and prints the heap and array buffers (after a full GC) at checkpoints, as JSON. marks[0] is the baseline
// (0 pages: the library loaded, the document and its fonts made), so a test measures what the pages add, not the code.
import { createPdf } from '../src/index.js';
const PAGES = Number(process.argv[2] || 20000);
const marks = new Set([1000, 5000, 10000, 20000, PAGES]);
let bytes = 0;
const pdf = createPdf({ write(b) { bytes += b.length; } }, { title: 'Memory', creationDate: new Date(0) });
const f = pdf.standardFont('Helvetica'), b = pdf.standardFont('Helvetica-Bold');
const out = [];
// two full collections with a turn of the event loop between them (finalizers and the zlib thread pool's buffers)
const sample = async (pages) => { global.gc(); await new Promise((r) => setImmediate(r)); global.gc(); const m = process.memoryUsage(); out.push({ pages, heapMB: m.heapUsed / 2 ** 20, buffersMB: m.arrayBuffers / 2 ** 20, rssMB: m.rss / 2 ** 20 }); };
await sample(0);
for (let i = 1; i <= PAGES; i++) {
  const p = pdf.addPage();
  p.text(`Page ${i}`, { x: 40, y: 30, font: b, size: 14 });
  for (let r = 0; r < 30; r++) { p.text(`Row ${i}.${r}  item ${(i * 31 + r) % 997}  amount ${((i * r) % 10000) / 100}`, { x: 40, y: 60 + r * 24, font: f, size: 10 }); p.line(40, 74 + r * 24, 555, 74 + r * 24, { color: 0.8, width: 0.5 }); }
  p.link(40, 30, 100, 14, { page: (i % PAGES) + 1 });
  await p.end();
  if (marks.has(i)) await sample(i);
}
pdf.outline({ title: 'Start', page: 1 });
const r = await pdf.end();
console.log(JSON.stringify({ marks: out, pages: r.pages, bytes }));
