// Links (URL, named destination, page), bookmarks (the outline) and page labels.
import { toBytes } from '@reportwright/pdf';

const bytes = await toBytes(async (pdf) => {
  const font = pdf.standardFont('Helvetica'), bold = pdf.standardFont('Helvetica-Bold');
  const blue = '#0645ad';
  const pages = [pdf.addPage(), pdf.addPage(), pdf.addPage()];
  pages[0].text('Contents', { x: 40, y: 40, font: bold, size: 22 });
  pages[0].text('Open example.com', { x: 40, y: 90, font, color: blue });
  pages[0].link(40, 88, 120, 14, { url: 'https://example.com/report' });          // http, https, mailto
  pages[0].text('Go to the appendix (named destination)', { x: 40, y: 115, font, color: blue });
  pages[0].link(40, 113, 230, 14, { dest: 'appendix' }, { alt: 'Go to the appendix' });
  pages[0].text('Go to page 2', { x: 40, y: 140, font, color: blue });
  pages[0].link(40, 138, 80, 14, { page: 2, fit: 'FitH', top: 0 });
  pages[1].text('Chapter 1', { x: 40, y: 40, font: bold, size: 22 });
  pages[2].text('Appendix', { x: 40, y: 40, font: bold, size: 22 });

  pdf.destination('appendix', 3, { top: 40 });
  pdf.outline([
    { title: 'Contents', page: 1 },
    { title: 'Chapter 1', page: 2 },
    { title: 'Appendix', page: 3, level: 1 },                                      // nests under the previous entry
  ]);
  pdf.pageLabels([{ start: 0, style: 'r' }, { start: 1, style: 'D' }]);            // i, 1, 2
  for (const p of pages) await p.end();
}, { title: 'Links and bookmarks' });

show(bytes, 'links.pdf');
