// PDF/A-2b: an archival PDF. Every font is embedded (standard fonts are refused), XMP metadata and an
// output intent are written. veraPDF passes the library's PDF/A output in CI.
import { toBytes } from '@reportwright/pdf';

const FONTS = 'https://cdn.jsdelivr.net/gh/MrArun005/reportwright-pdf@main/public/fonts/';
const inter = new Uint8Array(await (await fetch(FONTS + 'Inter-Regular.ttf')).arrayBuffer());

const bytes = await toBytes(async (pdf) => {
  const font = await pdf.embedFont(inter);
  const page = pdf.addPage();
  page.text('Archived statement', { x: 56, y: 56, font, size: 22 });
  page.textBox('PDF/A-1b, 2b/2u/2a and 3b/3u/3a are supported: pick the part and conformance level.',
    { x: 56, y: 100, width: 480, font, size: 12 });
  await page.end();
}, { title: 'Archived statement', pdfa: { part: 2, conformance: 'b' } });

log('PDF/A-2b,', bytes.length, 'bytes');
show(bytes, 'pdfa-2b.pdf');
