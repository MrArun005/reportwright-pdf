// A shaper for @reportwright/pdf's embedFont(bytes, { shaper }) built on harfbuzzjs (npm i harfbuzzjs). harfbuzzjs is
// not a dependency of @reportwright/pdf: copy this file, or import it where harfbuzzjs is installed.
//
//   import { harfbuzzShaper } from './harfbuzz-shaper.mjs';
//   const bytes = fs.readFileSync('NotoSansArabic-Regular.ttf');
//   const arabic = await pdf.embedFont(bytes, { shaper: harfbuzzShaper(bytes) });
//   page.text('مرحبا بالعالم', { x: 40, y: 40, font: arabic, size: 18, direction: 'rtl' });
//
// The shaper gets one run (one font, one direction) and returns its glyphs in visual order, in font units:
// { g: glyph ID, cl: cluster (UTF-16 index of its first character), ax: x advance, dx, dy: offsets }.
import * as hb from 'harfbuzzjs';

const NO_KERN = [new hb.Feature('kern', 0)];

/** @param {Uint8Array} fontBytes the same bytes passed to embedFont */
export function harfbuzzShaper(fontBytes) {
  const font = new hb.Font(new hb.Face(new hb.Blob(fontBytes))); // scale: units per em, so positions are font units
  return (text, _font, { direction, kerning }) => {
    const b = new hb.Buffer();
    b.addText(text); // clusters are UTF-16 indices, as JavaScript strings count
    b.guessSegmentProperties(); // script and language from the text
    b.setDirection(direction === 'rtl' ? hb.Direction.RTL : hb.Direction.LTR);
    hb.shape(font, b, kerning ? [] : NO_KERN);
    const pos = b.getGlyphPositions();
    return b.getGlyphInfos().map((g, i) => ({ g: g.codepoint, cl: g.cluster, ax: pos[i].xAdvance, dx: pos[i].xOffset, dy: pos[i].yOffset }));
  };
}
