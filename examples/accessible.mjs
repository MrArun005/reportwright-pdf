// PDF/UA-1 and PDF/A-2a in one file: a structure tree (headings, a list, a figure), artifacts for decoration.
//
//   node examples/accessible.mjs font.ttf [out.pdf]
import fs from 'node:fs';
import { createPdf } from '../dist/index.js';

const [fontFile, out = 'accessible.pdf'] = process.argv.slice(2);
if (!fontFile) { console.error('node examples/accessible.mjs font.ttf [out.pdf]'); process.exit(2); }
const pdf = createPdf(fs.createWriteStream(out), {
  title: 'Leave policy', tagged: { lang: 'en-GB' },               // PDF/UA-1: a title and tags are required
  pdfa: { part: 2, conformance: 'a' },                            // PDF/A-2a: archival and tagged
});
const font = await pdf.embedFont(fs.readFileSync(fontFile));
const page = pdf.addPage();
page.artifact({ type: 'Pagination', subtype: 'Header' }, () => page.text('Example Ltd · HR policies', { x: 40, y: 20, font, size: 8 }));
page.tag('H1', () => page.text('Leave policy', { x: 40, y: 50, font, size: 22 }));
page.tag('P', () => page.textBox('Every employee gets the following leave each calendar year.', { x: 40, y: 90, width: 500, font }));
page.tag('L', () => ['18 days of annual leave', '12 days of sick leave'].forEach((s, i) => page.tag('LI', () => {
  page.tag('Lbl', () => page.text('•', { x: 40, y: 120 + i * 18, font }));
  page.tag('LBody', () => page.text(s, { x: 56, y: 120 + i * 18, font }));
})), { listNumbering: 'Disc' });
page.figure({ alt: 'Bar chart: annual leave 18 days, sick leave 12 days' }, () => {
  page.fill(page.path().rect(40, 180, 180, 16), { fill: '#1f4e79' });
  page.fill(page.path().rect(40, 200, 120, 16), { fill: '#5b9bd5' });
});
await page.end();
const { warnings } = await pdf.end();
console.log(`wrote ${out}: PDF/UA-1 + PDF/A-2a`, warnings.length ? warnings : '');
