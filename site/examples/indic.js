// Hindi (Devanagari) shaped by HarfBuzz (harfbuzzjs, WebAssembly, loaded from a CDN): conjuncts and reordered
// matras are drawn correctly, and copied or extracted text stays the source text in logical order.
import { toBytes, loadPdf } from '@reportwright/pdf';
import * as hb from 'https://cdn.jsdelivr.net/npm/harfbuzzjs@1.6.3/dist/index.mjs';

// The shaper from examples/harfbuzz-shaper.mjs: one run in, glyphs in visual order (font units) out.
function harfbuzzShaper(fontBytes) {
  const font = new hb.Font(new hb.Face(new hb.Blob(fontBytes)));
  return (text, _font, { direction, kerning }) => {
    const b = new hb.Buffer();
    b.addText(text);
    b.guessSegmentProperties();
    b.setDirection(direction === 'rtl' ? hb.Direction.RTL : hb.Direction.LTR);
    hb.shape(font, b, kerning ? [] : [new hb.Feature('kern', 0)]);
    const pos = b.getGlyphPositions();
    return b.getGlyphInfos().map((g, i) => ({ g: g.codepoint, cl: g.cluster, ax: pos[i].xAdvance, dx: pos[i].xOffset, dy: pos[i].yOffset }));
  };
}

const FONTS = 'https://cdn.jsdelivr.net/gh/MrArun005/reportwright-pdf@main/public/fonts/';
const deva = new Uint8Array(await (await fetch(FONTS + 'NotoSansDevanagari-Regular.ttf')).arrayBuffer());

const bytes = await toBytes(async (pdf) => {
  const hindi = await pdf.embedFont(deva, { shaper: harfbuzzShaper(deva) });
  const latin = pdf.standardFont('Helvetica');
  const page = pdf.addPage();
  page.text('किताब हिन्दी क्षत्रिय', { x: 40, y: 40, font: hindi, size: 28 });
  page.textBox('Mixed text: इस किताब में हिन्दी और English दोनों हैं।', { x: 40, y: 100, width: 420, font: hindi, fallback: [latin], size: 16 });
  await page.end();
}, { title: 'हिन्दी' });

log('extracted:', (await loadPdf(bytes)).extractText().trim());
show(bytes, 'indic.pdf');
