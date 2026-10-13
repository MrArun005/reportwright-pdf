// PDF/UA-1 + PDF/A-2a in one file: a structure tree (heading, paragraph, list, figure with alt text),
// and the header marked as an artifact so screen readers skip it.
import { toBytes } from '@reportwright/pdf';

const FONTS = 'https://cdn.jsdelivr.net/gh/MrArun005/reportwright-pdf@main/public/fonts/';
const inter = new Uint8Array(await (await fetch(FONTS + 'Inter-Regular.ttf')).arrayBuffer());

const bytes = await toBytes(async (pdf) => {
  const font = await pdf.embedFont(inter);
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
}, { title: 'Leave policy', tagged: { lang: 'en-GB' }, pdfa: { part: 2, conformance: 'a' } });

show(bytes, 'accessible.pdf');
