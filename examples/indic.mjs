// Hindi (Devanagari) text shaped by HarfBuzz: conjuncts and reordered matras drawn right, copied text in logical order.
//
//   npm i harfbuzzjs
//   node examples/indic.mjs NotoSansDevanagari-Regular.ttf [out.pdf]
import fs from 'node:fs';
import { createPdf } from '../dist/index.js';
import { harfbuzzShaper } from './harfbuzz-shaper.mjs';

const [fontFile, out = 'indic.pdf'] = process.argv.slice(2);
if (!fontFile) { console.error('node examples/indic.mjs NotoSansDevanagari-Regular.ttf [out.pdf]'); process.exit(2); }
const pdf = createPdf(fs.createWriteStream(out), { title: 'हिन्दी' });
const bytes = fs.readFileSync(fontFile);
const hindi = await pdf.embedFont(bytes, { shaper: harfbuzzShaper(bytes) });
const latin = pdf.standardFont('Helvetica');
const page = pdf.addPage();
page.text('किताब हिन्दी क्षत्रिय', { x: 40, y: 40, font: hindi, size: 24 });
page.textBox('Mixed text: इस किताब में हिन्दी और English दोनों हैं।', { x: 40, y: 90, width: 400, font: hindi, fallback: [latin], size: 14 });
await page.end();
const { warnings } = await pdf.end();
console.log(`wrote ${out}`, warnings.length ? warnings : '');
