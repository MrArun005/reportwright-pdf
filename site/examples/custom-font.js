// Embed a TrueType font: it is subset to the glyphs used, kerned, and any Unicode it covers works.
import { toBytes } from '@reportwright/pdf';

const FONTS = 'https://cdn.jsdelivr.net/gh/MrArun005/reportwright-pdf@main/public/fonts/';
const load = async (name) => new Uint8Array(await (await fetch(FONTS + name)).arrayBuffer());
const [regular, bold] = await Promise.all([load('Inter-Regular.ttf'), load('Inter-Bold.ttf')]);

const bytes = await toBytes(async (pdf) => {
  const inter = await pdf.embedFont(regular), interBold = await pdf.embedFont(bold);
  const page = pdf.addPage();
  page.text('Inter, embedded and subset', { x: 56, y: 56, font: interBold, size: 26, color: '#1f4e79' });
  ['Café, naïve, façade — “quotes” and €1,234.50',
   'Ελληνικά · Русский · Čeština · Türkçe',
   'Kerning: AVATAR WAVE Type To'].forEach((s, i) => page.text(s, { x: 56, y: 110 + i * 32, font: inter, size: 18 }));
  log('width of "Hello" at 18 pt:', inter.widthOfText('Hello', 18).toFixed(2), 'pt');
  await page.end();
}, { title: 'Custom font' });

show(bytes, 'custom-font.pdf');
