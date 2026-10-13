// Text in the 14 standard fonts (no font files needed), a rule, and a justified, wrapping text box.
import { toBytes } from '@reportwright/pdf';

const bytes = await toBytes(async (pdf) => {
  const page = pdf.addPage();                                   // A4, points, origin top-left, y down
  const names = ['Helvetica', 'Helvetica-Bold', 'Times-Roman', 'Times-Italic', 'Courier-Bold'];
  names.forEach((name, i) =>
    page.text(name + ': the quick brown fox', { x: 56, y: 56 + i * 30, font: pdf.standardFont(name), size: 18, color: '#1f4e79' }));
  page.line(56, 214, 539, 214, { color: 0.6, width: 0.5 });
  const box = page.textBox(
    'Pages are written to the sink as they end, so memory stays flat however many pages you write. ' +
    'This paragraph wraps inside a 483 pt wide box and is justified; whatever does not fit comes back as overflow.',
    { x: 56, y: 230, width: 483, font: pdf.standardFont('Times-Roman'), size: 13, align: 'justify' });
  log('text box height:', box.height.toFixed(1), 'pt');
  await page.end();                                              // the page is written and freed
}, { title: 'Text and fonts' });

show(bytes, 'text.pdf');
