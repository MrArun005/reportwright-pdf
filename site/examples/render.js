// Render a PDF to PNG: make a one-page PDF, draw page 1 with the experimental renderer, show the PNG.
// On Node, import { stdFonts } from '@reportwright/pdf-std-fonts' instead of fetching the files.
import { toBytes, loadPdf, renderPage, toPng } from '@reportwright/pdf';

const pdf = await toBytes(async (pdf) => {
  const page = pdf.addPage({ width: 360, height: 200 });
  page.rect(0, 0, 360, 200, { fill: '#f4f1ea' });
  page.rect(24, 24, 312, 8, { fill: '#1f4e79' });
  page.text('Render a PDF to PNG', { x: 24, y: 80, font: pdf.standardFont('Helvetica-Bold'), size: 26, color: '#1f4e79' });
  page.text('Pure JS, no canvas, no dependencies.', { x: 24, y: 112, font: pdf.standardFont('Times-Italic'), size: 16 });
  await page.end();
});
show(pdf, 'made.pdf');

const files = { 'Helvetica-Bold': 'LiberationSans-Bold', 'Times-Italic': 'LiberationSerif-Italic' };
const base = new URL('fonts/std/', location.href).href;           // standard fonts have no outlines in the file: fetch them
const fonts = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([n, f]) =>
  [n, new Uint8Array(await (await fetch(base + f + '.ttf')).arrayBuffer())])));

const t = performance.now();
const page = renderPage(await loadPdf(pdf), 0, { scale: 2, fonts });
const png = await toPng(page);
showImage(png, 'page-1.png');
log(`page 1: ${page.width} × ${page.height} px, ${png.length} bytes of PNG, ${Math.round(performance.now() - t)} ms`);
