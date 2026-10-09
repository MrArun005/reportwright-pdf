// Text, an image, a table drawn with paths, a link and bookmarks, using the standard fonts (no files needed).
//
//   node examples/write.mjs [out.pdf]
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createPdf } from '../dist/index.js';

const out = process.argv[2] ?? 'write.pdf';
const pdf = createPdf(fs.createWriteStream(out), { title: 'Quarterly report', author: 'Example Ltd' });
const regular = pdf.standardFont('Helvetica'), bold = pdf.standardFont('Helvetica-Bold');

// A 32 x 32 RGBA PNG made here so the example needs no image file (use fs.readFileSync('logo.png') in real code).
function png(w, h, pixel) {
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8);
    b.writeUInt32BE(zlib.crc32(b.subarray(4, 8 + data.length)), 8 + data.length); return b;
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (1 + w * 4) + 1 + x * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const logo = await pdf.embedImage(png(32, 32, (x, y) => [31, 78, 121, (x - 16) ** 2 + (y - 16) ** 2 < 256 ? 255 : 0]));

const page = pdf.addPage();                                     // A4; origin top-left, y down, in points
page.image(logo, { x: 40, y: 40, width: 32 });
page.text('Quarterly report', { x: 84, y: 44, font: bold, size: 22, color: '#1f4e79' });
const box = page.textBox('Revenue grew in every region. The table below is drawn with paths: a filled header row, ' +
  'rules between rows and right-aligned numbers.', { x: 40, y: 90, width: 515, font: regular, size: 11, align: 'justify' });

// A table from paths: no table primitive is needed.
const rows = [['Region', 'Q1', 'Q2'], ['North', '1,204', '1,390'], ['South', '980', '1,122'], ['West', '1,510', '1,488']];
const cols = [40, 300, 430], right = 555, rowH = 22, top = 100 + box.height;
page.fill(page.path().rect(40, top, right - 40, rowH), { fill: '#1f4e79' });
rows.forEach((r, i) => {
  const y = top + i * rowH;
  r.forEach((cell, c) => {
    const font = i === 0 ? bold : regular, size = 11;
    const x = c === 0 ? cols[c] + 6 : (cols[c + 1] ?? right) - 6 - font.widthOfText(cell, size);
    page.text(cell, { x, y: y + 5, font, size, color: i === 0 ? '#ffffff' : 0 });
  });
  if (i > 0) page.stroke(page.path().moveTo(40, y + rowH).lineTo(right, y + rowH), { stroke: 0.75, width: 0.5 });
});

page.text('Read the full report online', { x: 40, y: top + rows.length * rowH + 20, font: regular, color: '#0645ad' });
page.link(40, top + rows.length * rowH + 20, 160, 14, { url: 'https://example.com/report' });

const p2 = pdf.addPage();
p2.text('Appendix', { x: 40, y: 40, font: bold, size: 18 });
pdf.outline([{ title: 'Quarterly report', page: 1 }, { title: 'Appendix', page: 2, level: 1 }]);
await page.end(); await p2.end();
const { pages, bytes, warnings } = await pdf.end();
console.log(`wrote ${out}: ${pages} pages, ${bytes} bytes`, warnings.length ? warnings : '');
