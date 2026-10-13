// Render the pages of a PDF to PNG files (experimental renderer, pure JS).
//
//   node examples/render.js in.pdf [outDir] [scale] [substitute.ttf]
//
// substitute.ttf: a font drawn in place of the standard 14 fonts, which have no outlines in the file.
import fs from 'node:fs';
import path from 'node:path';
import { loadPdf, renderPage, toPng } from '../dist/index.js';

const [input, outDir = '.', scale = '2', sub] = process.argv.slice(2);
if (!input) throw new Error('usage: node examples/render.js in.pdf [outDir] [scale] [substitute.ttf]');
const doc = await loadPdf(fs.readFileSync(input));
const fonts = sub ? { default: fs.readFileSync(sub) } : {};
for (let i = 0; i < doc.pageCount; i++) {
  const t = performance.now();
  const page = renderPage(doc, i, { scale: Number(scale), fonts });
  const out = path.join(outDir, `page-${i + 1}.png`);
  fs.writeFileSync(out, await toPng(page));
  console.log(`${out}: ${page.width} × ${page.height} in ${(performance.now() - t).toFixed(1)} ms`);
}
