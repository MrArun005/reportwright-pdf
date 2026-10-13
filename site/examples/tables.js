// Tables are paths and text: there is no table primitive, so you control every rule and alignment.
import { toBytes } from '@reportwright/pdf';

const bytes = await toBytes(async (pdf) => {
  const regular = pdf.standardFont('Helvetica'), bold = pdf.standardFont('Helvetica-Bold');
  const page = pdf.addPage();
  page.text('Quarterly report', { x: 40, y: 44, font: bold, size: 22, color: '#1f4e79' });
  const box = page.textBox('Revenue grew in every region. The table is drawn with paths: a filled header row, ' +
    'rules between rows and right-aligned numbers.', { x: 40, y: 80, width: 515, font: regular, size: 11, align: 'justify' });

  const rows = [['Region', 'Q1', 'Q2'], ['North', '1,204', '1,390'], ['South', '980', '1,122'], ['West', '1,510', '1,488']];
  const cols = [40, 300, 430], right = 555, rowH = 22, top = 92 + box.height;
  page.fill(page.path().rect(40, top, right - 40, rowH), { fill: '#1f4e79' });          // header band
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    r.forEach((cell, c) => {
      const font = i === 0 ? bold : regular;
      const x = c === 0 ? cols[c] + 6 : (cols[c + 1] ?? right) - 6 - font.widthOfText(cell, 11);   // right-align numbers
      page.text(cell, { x, y: y + 5, font, size: 11, color: i === 0 ? '#ffffff' : 0 });
    });
    if (i > 0) page.stroke(page.path().moveTo(40, y + rowH).lineTo(right, y + rowH), { stroke: 0.75, width: 0.5 });
  });
  await page.end();
}, { title: 'Tables' });

show(bytes, 'tables.pdf');
