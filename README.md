# @reportwright/pdf

A streaming PDF writer for Node and browsers, with no runtime dependencies. Pages are written to your sink as
they end, so memory stays flat however many pages you write. It is the writer inside ReportWright, extracted.

## Quickstart

```js
import fs from 'node:fs';
import { createPdf } from '@reportwright/pdf';

const pdf = createPdf(fs.createWriteStream('hello.pdf'), { title: 'Hello', creationDate: new Date('2026-01-01') });
const bold = pdf.standardFont('Helvetica-Bold');
const page = pdf.addPage({ width: 595.28, height: 841.89 });          // A4, in points
page.text('Hello, world', { x: 72, y: 72, font: bold, size: 24, color: '#1f4e79' });
page.line(72, 104, 523, 104, { color: 0.6, width: 0.5 });
await page.end();
await pdf.end();                                                        // ends the stream too
```

In memory: `const bytes = await toBytes((pdf) => { ... }, options)`.

## Coordinates

PDF points (1/72 inch), **origin at the top-left corner of the page, y growing downwards** (as in CSS and canvas;
PDF itself counts from the bottom-left — the library converts). For `page.text`, `y` is the **top of the line box**:
the baseline sits at `y + font.ascent * size`.

## API

### `createPdf(sink, options?)`

`sink` is a Node `Writable`, a WHATWG `WritableStream`, or any `{ write(bytes) }` (its return value is awaited if it
is a promise). Back-pressure is honoured: a Node stream's `false` waits for `'drain'`; a `WritableStream` waits for its
writer to be ready. `pdf.end()` ends a Node stream and closes a `WritableStream`; a plain `{ write }` sink gets
`close()` called if it has one.

| option | meaning |
|---|---|
| `title`, `author`, `subject`, `keywords` | document info, mirrored in the XMP metadata (every value escaped) |
| `metadata` | `true` (default): an XMP metadata stream mirrors the info. `false`: the Info dictionary only, no XMP (a one-page invoice goes from 2.5 KB to 1.6 KB). Refused with `pdfa` or `tagged`: PDF/A and PDF/UA require the XMP |
| `creationDate` | a `Date` (default: now). With the same input and date the output is byte-for-byte identical |
| `compress` | `true` (default): content, fonts, object streams and the xref stream are Flate-compressed |
| `pdfa` | `true`: PDF/A-2b (sRGB output intent bundled, XMP identification). Fonts must be embedded. `{ part, conformance, outputIntent }`: a level (see PDF/A levels) and/or your RGB or CMYK output profile instead of sRGB (a CMYK intent allows CMYK colour and refuses RGB) |
| `tagged` | `{ lang: 'en-GB' }`: PDF/UA-1 — a structure tree (`page.tag`), `title` required, fonts embedded |
| `signal`, `timeoutMs` | stop the export: pending and later calls reject with the signal's reason / a `TimeoutError` |
| `id` | the file identifier (32 hex digits); default: a hash of the file's bytes (random when encrypting) |
| `encrypt` | password protection, AES-256 or AES-128 (see Encryption) |
| `sign` | `true` or `{ hash }`: make the PDF signable with `pdf.sign` (see Signatures) |

### Fonts

- `pdf.standardFont(name)` — one of the 14 standard fonts (`Helvetica`, `Helvetica-Bold`, `Helvetica-Oblique`,
  `Helvetica-BoldOblique`, `Times-Roman`, `Times-Bold`, `Times-Italic`, `Times-BoldItalic`, `Courier`,
  `Courier-Bold`, `Courier-Oblique`, `Courier-BoldOblique`, `Symbol`, `ZapfDingbats`). Not embedded; text is WinAnsi
  (Latin-1 plus €, curly quotes, dashes…). Not allowed with `pdfa` or `tagged`.
- `await pdf.embedFont(bytes, { subset, shaper })` — a TrueType (`glyf`) or OpenType/CFF (`.otf`) font. Any Unicode
  text (Identity-H with a ToUnicode map, so text can be copied and searched). TrueType embeds as `FontFile2`
  (CIDFontType2); OpenType/CFF as `FontFile3 /Subtype /OpenType` (CIDFontType0; `pdffonts` says "CID Type 0C (OT)").
  `subset`: `true` (default) keeps only the glyphs used, both kinds built in (CFF: unused glyphs' charstrings become
  `endchar`, subroutines are kept, glyph IDs stay; a font using the deprecated `seac` accents embeds whole; a
  CID-keyed CFF gets an identity charset so every reader maps its glyphs alike); `false` embeds the whole font; or a
  function `(font, codePoints, { glyphs }) => Promise<Uint8Array>` (e.g. a HarfBuzz subsetter, which also
  desubroutinises CFF) that must keep glyph IDs. `shaper`: see Shaping.
  A variable font (an `fvar` table) is drawn at its default instance, which may be its thinnest weight (Noto Sans JP's
  is Thin), with a warning naming the axes' values: for another weight, embed a static instance of it (fonttools
  `varLib.instancer`, or `hb-subset --instance`).
- `font.widthOfText(text, size, { kerning, characterSpacing, wordSpacing, horizontalScaling, direction })` — the width
  text is drawn at (kerned, shaped, spaced); `font.widthOf(text, size)` — plain advances; `font.lineHeight(size)` —
  ascent − descent + line gap (1.2 × size for standard fonts); `font.ascent`, `font.descent` (fractions of the size).

**Kerning** is on by default: GPOS pair adjustment (formats 1 and 2, extension lookups too) of the `kern` feature,
else the legacy `kern` table (format 0). It is applied in measuring and drawing (TJ arrays); `kerning: false` turns it
off. Other GPOS positioning (marks, cursive) needs a shaper. The standard fonts are **not kerned** (the bundled AFM
metrics have no kerning pairs).

Characters a font has no glyph for are reported in `pdf.end()`'s `warnings` (standard fonts drop them; embedded fonts
draw the font's "missing" box, or drop it in PDF/A and PDF/UA, which forbid it).

### Pages

`const page = pdf.addPage({ width, height, cropBox, bleedBox, trimBox, artBox, rotate, userUnit })` (default A4).
`page.number` is 1-based. The boxes are `[x, y, width, height]` in the page's top-left space, inside the page (the
MediaBox); `trimBox` and `artBox` must lie inside `bleedBox` when both are given (`pdfinfo -box` shows them). `rotate`
(0, 90, 180, 270) turns the page clockwise **as viewers show it**: drawing coordinates stay those of the unrotated page
(top-left of the MediaBox), so a page added with `{ width: 842, height: 595, rotate: 90 }` is drawn in landscape and
shown in portrait. `userUnit` (PDF 1.6, not in PDF/A-1) sets the default unit in 1/72 inch. A bad box throws and adds
no page.

- `page.text(str, { x, y, font, size = 12, color, … })` — one line (options below).
- `page.textBox(str, { x, y, width, height, font, size, align, lineHeight, maxLines, ellipsis, … })` — paragraphs
  (split at `\n`) wrapped by word, a word longer than the line broken inside; `align`: `left` (default; `right` for
  `direction: 'rtl'`), `right`, `center`, `justify` (word spacing: `Tw` for standard fonts, TJ adjustments at spaces
  for embedded fonts; a paragraph's last line is not stretched). `maxLines` ends the last line with `…` (`...` when
  no font has it) when text is left; `height` stops at the last whole line that fits, without an ellipsis, so the
  rest can go on in another box. Returns `{ height, lines, overflow }` (`overflow`: the text not drawn, `''` when it
  all fit). No hyphenation. At most 10,000,000 characters and 100,000 lines a box (the rest is overflow); layout is
  linear in the text it reads and stops once the visible lines are known.
- `page.line(x1, y1, x2, y2, { color, width = 1, dash, opacity, blendMode })` — `dash`: `[on, off]`.
- `page.rect(x, y, w, h, { fill, stroke, width = 1, dash, opacity, fillOpacity, strokeOpacity, blendMode })` — fill, stroke or both (default: fill black). Opacity and blend mode work as in `page.fill` (an ExtGState inside `q`/`Q`; refused in PDF/A-1).
- `page.link(x, y, w, h, target, { alt, highlight, border, quadPoints, allowSchemes })` — see Links below.
- `page.tag(type, fn, options)` — when `tagged`: what `fn` draws becomes a structure element of `type`
  (`P`, `H1`…`H6`, `Table`, `TR`, `TH`, `TD`, `L`, `LI`, `Link`, `Figure`…). Tags nest. Anything drawn outside a tag is
  marked as an artifact (decoration). Without `tagged` it just calls `fn`. See Tagged PDF.
- `page.artifact({ type, subtype }, fn)` — what `fn` draws is a typed artifact: `type` `Pagination` (with `subtype`
  `Header`, `Footer` or `Watermark`), `Layout` or `Page`. Outside any tag.
- `page.layer(layer, fn)` — what `fn` draws belongs to a layer (see Layers).
- `await page.end()` — the page is compressed and written; nothing of it stays in memory.

Text options (`page.text` and `page.textBox`):

| option | meaning |
|---|---|
| `kerning` | `true` (default) / `false` |
| `characterSpacing` | points after every glyph (`Tc`) |
| `wordSpacing` | points at every space (`Tw` for standard fonts, whose space is the one-byte code 32; TJ adjustments for embedded Identity-H fonts) |
| `horizontalScaling` | percent (`Tz`, default 100) |
| `rise` | points the baseline is raised (`Ts`; negative lowers it): super- and subscripts |
| `renderMode` | 0–7 or `'fill'`, `'stroke'`, `'fillStroke'`, `'invisible'`, `'fillClip'`, `'strokeClip'`, `'fillStrokeClip'`, `'clip'` (`Tr`). The clipping modes add the glyphs to the clip until the enclosing `page.restore()`, so wrap them in `save()`/`restore()`. `strokeColor`, `strokeWidth` (default: `color`, 1) for the stroking modes |
| `rotate` | radians, clockwise, about (x, y) (as `page.rotate`); any transform (`page.rotate`, `scale`, `skew`) applies to text too |
| `fallback` | `[fontB, fontC]`: characters the font lacks are drawn in the first of these that has them, a run at a time (white space stays in the run it is in). Each run keeps its ToUnicode, so tagged PDFs stay extractable |
| `direction` | `'rtl'`: the text is one right-to-left run (passed to the shaper; without one, glyphs reversed). A run of only right-to-left letters (Arabic, Hebrew) in a line is drawn right to left by itself. There is **no Unicode bidi algorithm** (UAX #9): mixed-direction text must be split into runs in visual order by the caller |

### Shaping

`pdf.embedFont(bytes, { shaper })`: text in that font goes through `shaper(text, font, { direction, kerning })`, which
returns the glyphs in visual order, in font units: `[{ g, cl, ax, dx, dy }]` (glyph ID, cluster = UTF-16 index of
its first character, x advance, offsets: what HarfBuzz's `hb_shape` gives). So Arabic, Indic and other complex
scripts draw correctly. The glyphs are drawn by ID with their advances and offsets (TJ adjustments, `Ts` for vertical
offsets); copied and extracted text is the source text, once, in logical order (checked with Acrobat-style
ActualText readers, poppler and pdf.js): a cluster of several glyphs (a conjunct, a reordered matra, a letter and its
dots) has its text on one glyph and WJ (U+2060) on the others, which are drawn after the run or inside an
`/ActualText` span, and a glyph that stands for different text in different places gets a code for each (a
`CIDToGIDMap`; a CFF font cannot, so there it gets an ActualText span). The shaper's output is checked (glyph IDs in
the font, finite numbers, clusters inside the text, at most 4 glyphs a character).

An adapter for harfbuzzjs v1 (`npm i harfbuzzjs`; not a dependency of this package). The same file ships in the package
as `examples/harfbuzz-shaper.mjs`:

```js
import * as hb from 'harfbuzzjs';
function harfbuzzShaper(bytes) {
  const font = new hb.Font(new hb.Face(new hb.Blob(bytes)));     // positions in font units
  return (text, _font, { direction, kerning }) => {
    const buf = new hb.Buffer();
    buf.addText(text);                                           // clusters are UTF-16 indices
    buf.guessSegmentProperties();                                // script and language from the text
    buf.setDirection(direction === 'rtl' ? hb.Direction.RTL : hb.Direction.LTR);
    hb.shape(font, buf, kerning ? [] : [new hb.Feature('kern', 0)]);
    const pos = buf.getGlyphPositions();
    return buf.getGlyphInfos().map((g, i) => ({ g: g.codepoint, cl: g.cluster, ax: pos[i].xAdvance, dx: pos[i].xOffset, dy: pos[i].yOffset }));
  };
}

const bytes = fs.readFileSync('NotoSansDevanagari-Regular.ttf');
const hindi = await pdf.embedFont(bytes, { shaper: harfbuzzShaper(bytes) });
page.text('किताब हिन्दी', { x: 40, y: 40, font: hindi, size: 18 });
page.textBox(longText, { x: 40, y: 80, width: 300, font: inter, fallback: [hindi], align: 'justify' });
```

Colours (fills, strokes, text, gradient stops):

| form | colour space |
|---|---|
| a gray level `0`–`1` | DeviceGray |
| `'#rgb'`, `'#rrggbb'`, `'rgb(255, 128, 0)'`, `'rgb(100% 50% 0%)'`, `[r, g, b]` (0–1) | DeviceRGB |
| `cmyk(c, m, y, k)` (import it) or `[c, m, y, k]` (0–1) | DeviceCMYK |
| `pdf.spotColor(name, alternate)`, or `.tint(t)` of it | Separation: a named ink, shown as its device `alternate` (gray, RGB or CMYK) at full tint, lighter tints towards white |
| `(await pdf.iccColorSpace(profileBytes)).color(...components)` | ICCBased: a gray, RGB or CMYK ICC profile (its header is checked; `/N` comes from it) |

```js
import { createPdf, cmyk } from '@reportwright/pdf';
const pantone = pdf.spotColor('PANTONE 185 C', cmyk(0, 0.91, 0.76, 0));  // written as /PANTONE#20185#20C
page.rect(40, 40, 100, 20, { fill: pantone });                          // full tint
page.rect(40, 70, 100, 20, { fill: pantone.tint(0.4) });
const p3 = await pdf.iccColorSpace(fs.readFileSync('Display P3.icc'));
page.text('Vivid', { x: 40, y: 100, font, color: p3.color(1, 0.2, 0.1) });
```

A spot colour's name is written exactly (PDF 1.7 §7.3.5: white space, delimiters, `#` and non-ASCII bytes as `#xx`, so
`PANTONE 185 C` is `/PANTONE#20185#20C`, which every reader and RIP decodes back to `PANTONE 185 C`; at most 127 bytes). One name has one definition per document. A gradient's stops share one colour
space: gray and RGB mix (as RGB), otherwise all CMYK, all tints of one spot colour, or all from one ICC space.

**PDF/A** needs device colour to match the output intent (ISO 19005-2, 6.2.4.3, as veraPDF checks): with the default
sRGB intent, CMYK colour (and CMYK spot alternates, CMYK gradients and CMYK JPEGs) throws a clear error; with
`pdfa: { outputIntent: cmykProfile }`, RGB colour throws instead. Gray, spot colours with a matching alternate and
ICC-based colours are allowed with either.

### Vector graphics

Paths are built as with the Canvas 2D API, in the same top-left, y-down space (so `rotate` and arc angles, in
radians, turn **clockwise** on the page, as in canvas). A path is not tied to a page; draw it with `fill`, `stroke`,
`fillAndStroke` or use it to `clip`.

```js
const p = page.path()
  .moveTo(40, 40).lineTo(140, 40)
  .bezierCurveTo(160, 40, 160, 80, 140, 80).quadraticCurveTo(90, 120, 40, 80)
  .closePath();
page.fillAndStroke(p, { fill: '#cfe2f3', stroke: '#1f4e79', width: 2, join: 'round' });

page.fill(page.path().roundedRect(40, 140, 200, 60, [12, 12, 0, 0]), { fill: page.linearGradient(40, 0, 240, 0, [[0, '#1f4e79'], [0.6, '#5b9bd5'], [1, '#ffffff']]) });

page.save();                                   // transform, clip and styles until restore()
page.translate(300, 200).rotate(Math.PI / 6);
page.clip(page.path().arc(0, 0, 50, 0, 2 * Math.PI));
page.shade(page.radialGradient(0, 0, 0, 0, 0, 50, [[0, '#fff'], [1, '#c00']]));   // paint the clip area
page.restore();

page.svgPath('M10 300 h 80 a 20 20 0 0 1 0 40 h -80 z', { fill: '#e2efda', stroke: 0, dash: [4, 2] });
page.figure({ alt: 'Revenue up 12% on last year' }, () => page.fill(page.path().rect(40, 380, 120, 30), { fill: '#5b9bd5', opacity: 0.8 }));
```

- `page.path()` → a `Path`: `moveTo`, `lineTo`, `bezierCurveTo`, `quadraticCurveTo` (written as a cubic), `arc(x, y, r,
  start, end, ccw?)`, `arcTo(x1, y1, x2, y2, r)`, `ellipse(x, y, rx, ry, rotation, start, end, ccw?)`, `rect`,
  `roundedRect(x, y, w, h, radii)` (one radius or canvas roundRect's 1–4 per-corner forms, scaled down when they do not
  fit), `closePath`, `svg(d)`. Each returns the path. At most 1,000,000 segments.
- `page.fill(path, o)`, `page.stroke(path, o)`, `page.fillAndStroke(path, o)`, `page.svgPath(d, o)` (fill, stroke or
  both by which of `fill`/`stroke` you give; neither: filled black). Options:

  | option | meaning |
  |---|---|
  | `fill`, `stroke` (or `color`) | a colour, a gradient or a tiling pattern (default black) |
  | `rule` | `'nonzero'` (default) or `'evenodd'` |
  | `width`, `dash`, `dashPhase` | stroke width (default 1); dash lengths (at most 100, not all 0) and their phase |
  | `cap`, `join`, `miterLimit` | `'butt'`/`'round'`/`'square'`; `'miter'`/`'round'`/`'bevel'`; ≥ 1 (default 10) |
  | `opacity`, `fillOpacity`, `strokeOpacity` | 0–1 (`opacity` multiplies both) |
  | `blendMode` | any of the 16 PDF modes: `Normal`, `Multiply`, `Screen`, `Overlay`, `Darken`, `Lighten`, `ColorDodge`, `ColorBurn`, `HardLight`, `SoftLight`, `Difference`, `Exclusion`, `Hue`, `Saturation`, `Color`, `Luminosity` (or canvas names: `'color-dodge'`…) |

  Styles are per call (an option left out is its default), so draws do not leak into each other. Opacity and blend
  modes go into one ExtGState per distinct value in the document, and give the page a transparency group (as PDF/A-2
  asks).
- `page.clip(path, rule?)` — intersect the clip with the path until the enclosing `restore()`.
- `page.save()`, `page.restore()` — nest at most 1000 deep (27 in PDF/A, whose limit is 28). A `restore()` without a
  `save()` throws; saves still open when the page ends are closed there, with a warning in `pdf.end()`'s result.
- `page.translate(x, y)`, `page.rotate(angle)`, `page.scale(sx, sy = sx)`, `page.skew(ax, ay = 0)`,
  `page.transform(a, b, c, d, e, f)` — as canvas; they apply to everything drawn after (text too) until `restore()`.
- `page.linearGradient(x0, y0, x1, y1, stops, { extend })`, `page.radialGradient(x0, y0, r0, x1, y1, r1, stops,
  { extend })` — `stops`: `[[offset, colour], …]` or `[{ offset, color }, …]` (1–256, sorted, offsets clamped to
  0–1, equal offsets make a hard stop; colours in one space: see Colours). Use as a `fill`/`stroke`, or `page.shade(gradient)` to paint the
  current clip. Gradients follow the transform current when they are painted.
- `page.tilingPattern({ width, height, spacing }, (cell) => …)` — `cell` has the page's drawing methods in the cell's
  own top-left space (shapes, gradients, nested patterns; not text or links); cells repeat every `width + spacing`.
  With no spacing the cell's `/BBox` is written 0.001 pt larger than the step: PDFium (Chrome, Edge) otherwise draws a
  cell whose `/BBox` equals `/XStep` × `/YStep` one device pixel too far apart (a 20 pt cell every 21 pt at 72 dpi).
- `page.figure({ alt }, fn)` — tagged PDFs: what `fn` draws is a `Figure` with that alt text (required). Graphics drawn
  outside any tag are artifacts, so a tagged page of charts and rules stays PDF/UA-1 clean. Untagged, it just runs `fn`.

Gradients, patterns, fonts, pages, images, spot colours and ICC colour spaces are handles: only ones made by this document are accepted (a copy, a
hand-made `{ type: 'gradient', … }` or one from another PDF throws). NaN, Infinity and numbers of 1e9 or more
throw before anything is drawn; malformed SVG path data throws a `SyntaxError` naming the position.

### Images

```js
const photo = await pdf.embedImage(fs.readFileSync('team.jpg'));       // { width, height } in pixels
page.image(photo, { x: 40, y: 40, width: 200 });                        // height from the aspect ratio
page.image(photo, { x: 260, y: 40, width: 120, height: 120, fit: 'cover', alt: 'The team at the 2026 offsite' });
const logo = await pdf.embedImage(fs.readFileSync('logo.png'));         // alpha → a soft mask
for (const y of [400, 500, 600]) page.image(logo, { x: 40, y, height: 24, opacity: 0.6 });   // written once
```

- `await pdf.embedImage(bytes, { colorSpace, maxDecodedBytes })` — a JPEG or PNG, written to the file at once as an image XObject;
  returns a handle with `width` and `height` (pixels, after the EXIF orientation). `colorSpace`: an ICC colour space
  (`pdf.iccColorSpace`) with the image's number of components, instead of the device space. `maxDecodedBytes`: the
  decoded size allowed for a PNG that needs decoding (default 64 MB, 67,108,864 bytes).
  - **JPEG**: baseline and progressive, gray, RGB and CMYK, embedded unchanged (DCTDecode, no re-encoding). Adobe's
    inverted CMYK (an APP14 "Adobe" segment) is drawn with `/Decode [1 0 1 0 1 0 1 0]`. The EXIF orientation (1–8)
    is honoured. 12-bit, lossless, hierarchical and arithmetic-coded JPEGs are refused.
  - **PNG**: gray, RGB, palette, gray + alpha, RGBA; 1, 2, 4, 8 and 16 bits; Adam7 interlacing; tRNS. Without alpha
    and not interlaced, the compressed data is copied through (FlateDecode with the PNG predictor). Alpha (and a
    palette's or a 16-bit colour key's tRNS) becomes a soft mask (`/SMask`); an 8-bit-or-less colour key a `/Mask`;
    interlaced images are de-interlaced. Those are re-compressed. Other chunks (gamma, ICC, text, eXIf) are ignored.
  - Limits: each side ≤ 65,535 pixels, ≤ 100 megapixels, ≤ 256 MB of file, and ≤ 64 MB decoded (`maxDecodedBytes`)
    for a PNG that needs decoding (alpha or interlacing). Such a PNG is decoded and re-compressed a row at a time: a
    non-interlaced one is never held whole (memory: a strip of rows plus the compressed result), an interlaced one is
    held once, de-interlaced. A JPEG is cut at the EOI that ends its image data and a passed-through PNG at the end of
    its zlib stream: bytes appended after them are not embedded. Truncated or corrupt files, lying chunk or marker lengths, bad CRCs and
    data that inflates past its header's size (a zip bomb) throw a clear error.
- `page.image(img, { x, y, width, height, fit, opacity, alt })` — top-left `(x, y)` (default 0, 0). Only `width` or
  `height`: the other keeps the aspect ratio; neither: one point per pixel. `fit`: `'fill'` (default: stretch to the
  box), `'contain'` (all of the image, centred), `'cover'` (fills the box, centred, cut to it). `opacity` 0–1. Tagged
  PDFs: `alt` makes the image a `Figure` with that alternate text; without `alt` it is an artifact (decoration).
- An image drawn any number of times, on any pages, is one XObject in the file. Images are always XObjects, never
  inline images: an inline image would be repeated in every content stream and cannot have a soft mask.
- Image handles, like fonts and gradients, only work in the PDF that made them.

### Links and destinations

A destination is a page and a fit, in the top-left space: `{ page, fit, left, top, right, bottom, zoom }` where `fit`
is `XYZ` (left, top, `zoom`: 1 = 100%), `Fit`, `FitH` (top), `FitV` (left), `FitR` (left, top, right, bottom), `FitB`,
`FitBH`, `FitBV`. Without `fit`: `XYZ` when left, top or zoom is given, else `Fit`. `page` is 1-based or a page object
(it may not exist yet).

```js
pdf.destination('appendix', 12, { top: 80 });                            // a named destination
page.link(40, 100, 120, 14, { dest: 'appendix' }, { alt: 'Go to the appendix' });
page.link(40, 120, 120, 14, { page: 3, fit: 'FitH', top: 200 }, { highlight: 'push' });
page.link(40, 140, 120, 14, { url: 'https://example.com/report' }, { border: { width: 1, style: 'dashed', dash: [3, 2], color: '#0645ad' } });
page.link(40, 160, 120, 14, { named: 'NextPage' });
```

- `page.link(x, y, w, h, target, o)` — `target`: `{ url }`, `{ page, …fit }`, `{ dest: name }` or `{ named:
  'NextPage' | 'PrevPage' | 'FirstPage' | 'LastPage' }`. Options: `alt` (what screen readers say; default the URL or
  "Page n"), `highlight` (`none`, `invert`, `outline`, `push`), `border` (`{ width, style: solid | dashed | beveled |
  inset | underline, dash, color }`; default none), `quadPoints` (rectangles the link covers, e.g. a wrapped line),
  `allowSchemes`.
- `pdf.destination(name, page, fit)` — written at the end to the catalog's `Names` tree as a balanced name tree (sorted,
  64 a node, `Kids` and `Limits` when larger). Names are unique (a second definition throws), at most 1,024 UTF-8 bytes
  and 100,000 a document; one that is used but never defined, or points past the last page, is a warning.

**No active content.** A library that writes PDFs must not be a vector for it, so there is **no way to write a
JavaScript, Launch, GoToR, GoToE, SubmitForm, ImportData or any other action**: link targets and the open action are
destinations (plus the four navigation actions above), and anything else throws. URLs are limited to `http`, `https`
and `mailto` by default; `allowSchemes: ['tel']` widens that per link, but `javascript:`, `vbscript:`, `data:` and
`file:` are never written, however spelled. A URL with a control character is refused (browsers drop them, which
hides schemes like `java\tscript:`); the rest is normalised by the WHATWG URL parser, percent-encoded (quotes,
parentheses and angle brackets too) and written as a hex string. Every caller's string (contents, titles, names) is a
hex string and every name is escaped, so no text can inject PDF syntax.

### Outline, page labels and viewer

- `pdf.outline({ title, page | dest, level, open, color, bold, italic, …fit })` (or an array) — bookmarks. `level`
  (0–63) nests: an entry is the child of the nearest one before it at a lower level. `open: false` shows it closed.
  `color`: RGB or gray. At most 100,000 entries, titles of 4,096 characters.
- `pdf.pageLabels([{ start, style, prefix, first }])` — labels viewers show for pages from the 0-based index `start`:
  `style` `D` (1, 2, 3), `r`/`R` (i, ii / I, II), `a`/`A` (a, b / A, B) or none (the prefix alone), `prefix`, `first` (the
  first number). Page 0 gets decimal labels when no range starts there.
  ```js
  pdf.pageLabels([{ start: 0, style: 'r' }, { start: 4, style: 'D' }, { start: 40, style: 'A', prefix: 'Appendix ' }]);
  ```
- `pdf.viewer({ … })` — `hideToolbar`, `hideMenubar`, `hideWindowUI`, `fitWindow`, `centerWindow`, `displayDocTitle`
  (always true when tagged), `direction` (`L2R`/`R2L`), `printScaling` (`None`/`AppDefault`), `duplex` (`Simplex`,
  `DuplexFlipShortEdge`, `DuplexFlipLongEdge`), `pickTrayByPDFSize`, `numCopies` (1–5); `pageMode` (`UseNone`,
  `UseOutlines`, `UseThumbs`, `FullScreen`, `UseOC`, `UseAttachments`); `pageLayout` (`SinglePage`, `OneColumn`,
  `TwoColumnLeft`, `TwoColumnRight`, `TwoPageLeft`, `TwoPageRight`); `openAt: { page, …fit }` (the open action: a
  destination only). Unknown options throw.

### Annotations

Each annotation method takes a box in the page's top-left space and returns a handle. Shared options: `color` (gray,
RGB or CMYK), `contents` (its text; required in tagged PDFs, where it is the description), `author` (`/T`),
`modified` (a Date), `flags` (`{ print, hidden, noView, locked, readOnly, noZoom, noRotate, … }`; default print).
Every annotation gets an **appearance stream** drawn by the library, so it looks the same in every viewer and passes
PDF/A (which needs one, and printed, visible annotations: PDF/A refuses `hidden`, `noView` or `print: false`).

```js
const n = page.note(500, 60, { contents: 'Check this figure', author: 'Ada', icon: 'Comment', open: true });
page.note(525, 60, { contents: 'Done', author: 'Bo', replyTo: n });
page.highlight([{ x: 40, y: 100, width: 300, height: 16 }, { x: 40, y: 116, width: 120, height: 16 }], { contents: 'Key result' });
page.freeText('Sign here', { x: 40, y: 200, width: 120, height: 30, font, size: 12, background: '#fff8c4', border: { width: 1 } });
page.markup('Line', { x1: 40, y1: 260, x2: 200, y2: 300 }, { lineEndings: ['None', 'OpenArrow'], color: '#c00', contents: 'This one' });
page.stamp({ x: 380, y: 700, width: 160, height: 44, name: 'Approved', font });
page.attachFile(csvBytes, { x: 560, y: 60, name: 'figures.csv', mimeType: 'text/csv', description: 'The data' });
```

- `page.note(x, y, { icon, open, replyTo })` — a sticky note (Text), 20 × 20, not zoomed or rotated. `icon`: `Comment`,
  `Key`, `Note`, `Help`, `NewParagraph`, `Paragraph`, `Insert`. `replyTo`: another annotation (`/IRT`).
- `page.highlight(rects)`, `page.underline`, `page.strikeOut`, `page.squiggly` — text markup over one rectangle or
  several (up to 10,000; QuadPoints are computed from them). A highlight multiplies, so the text shows through.
- `page.freeText(text, { x, y, width, height, font, size, textColor, align, border, background, padding })` — text in
  a box, wrapped and drawn with the package's own text.
- `page.markup(type, geometry, { interior, lineWidth, dash, lineEndings })` — `Square` and `Circle` (`{ x, y, width,
  height }`), `Line` (`{ x1, y1, x2, y2 }`, `lineEndings: [start, end]`: `None`, `Square`, `Circle`, `Diamond`,
  `OpenArrow`, `ClosedArrow`, `Butt`, `ROpenArrow`, `RClosedArrow`, `Slash`), `Polygon` and `PolyLine` (`[[x, y], …]`),
  `Ink` (`[[[x, y], …], …]`, strokes). `color` is the line, `interior` the fill. At most 100,000 points.
- `page.stamp({ x, y, width, height, name, font })` — a standard stamp (`Approved`, `Experimental`, `NotApproved`,
  `AsIs`, `Expired`, `NotForPublicRelease`, `Confidential`, `Final`, `Sold`, `Departmental`, `ForComment`, `TopSecret`,
  `Draft`, `ForPublicRelease`) with its label drawn in `font`; or `draw: (ap) => …` to draw your own appearance on `ap`,
  a page the size of the box.
- `page.attachFile(bytes, { x, y, name, mimeType, description, created, modified, icon, allowTypes, allowArchives })` —
  a FileAttachment annotation with the file embedded (`/Params` with its size, MD5 checksum and dates). Not in PDF/A-2,
  which allows only PDF/A attachments (refused with an error). The **file name is checked** as an OS and a viewer would
  read it: control, format and bidi characters (`invoice\u202Efdp.exe`), Windows-invalid characters and NTFS streams
  (`report.pdf:evil.exe`), dot look-alikes, a leading dot, Windows device names and more than 255 UTF-8 bytes throw;
  only passive types are allowed (pdf, images, text, csv, json, Office documents without macros, ics, vcf, eml…; not
  rtf, msg or xml, which can carry embedded objects or external entities; zip with `allowArchives`), so anything else
  needs `allowTypes: ['ext']`, **by which you accept that type's risk** (`pdf.facturX` embeds its checked XML itself);
  slash look-alikes (`docs／x.pdf`), spaces other than U+0020 and runs of 3 spaces throw; double extensions
  (`invoice.pdf.scr`) throw; a `mimeType` must be one of the extension's types (`invoice.pdf` as
  `application/x-msdownload` throws; with no `mimeType` none is written; a type in `allowTypes` takes any MIME type, at
  your risk). `/F` holds an ASCII form, checked with the same rules.
- Tagged PDFs: each annotation becomes an `Annot` structure element (links a `Link`) with an object reference, pages
  with annotations get `/Tabs /S`; veraPDF UA-1 and A-2b pass with notes, highlights, FreeText, shapes and stamps.
- At most 100,000 annotations a page.

### Forms

`pdf.form` places interactive fields (AcroForm) on pages. Each field gets **appearance streams for every state** it can
show, drawn with the package's own text and graphics (NeedAppearances is false, so every viewer shows the same thing);
`/DA` names the field's font, and `/DR` is the shared Resources, which hold every font used. Each method returns a
field handle.

```js
const font = await pdf.embedFont(interBytes);
const page = pdf.addPage();
const f = pdf.form;
f.textField('name', { page, x: 40, y: 40, width: 200, height: 22, font, value: 'Ada Lovelace', tooltip: 'Full name', required: true });
const address = f.group('address');                 // children are address.city, address.zip
address.textField('city', { page, x: 40, y: 80, width: 200, height: 22, font, value: 'Paris', tooltip: 'City' });
f.textField('pin', { page, x: 40, y: 120, width: 80, height: 22, font, comb: true, maxLen: 4, tooltip: 'PIN' });
f.checkbox('agree', { page, x: 40, y: 160, width: 14, height: 14, checked: true, value: 'Agreed', style: 'check', tooltip: 'I agree' });
f.radioGroup('size', { value: 'M', tooltip: 'Size', buttons: ['S', 'M', 'L'].map((v, i) => ({ page, x: 40 + i * 30, y: 190, width: 14, height: 14, value: v })) });
f.comboBox('country', { page, x: 40, y: 220, width: 150, height: 22, font, options: [['FR', 'France'], ['DE', 'Germany']], value: 'DE', tooltip: 'Country' });
f.listBox('langs', { page, x: 40, y: 250, width: 150, height: 60, font, options: ['English', 'French'], value: ['French'], multiSelect: true, tooltip: 'Languages' });
f.button('clear', { page, x: 40, y: 320, width: 80, height: 24, font, label: 'Clear', action: { reset: true }, tooltip: 'Clear the form' });
f.signature('sig', { page, x: 40, y: 360, width: 200, height: 40, tooltip: 'Sign here', lock: { action: 'All' } });
```

- Shared options: `page`, `x`, `y`, `width`, `height` (the widget's box), `border` (`{ width, color }`, default 1 pt
  black; `false`: none), `background`, `tooltip` (`/TU`, also the accessible name: **required in tagged PDFs**),
  `readOnly`, `required`. Text options (text, choice, button labels): `font`, `fallback` (fonts tried for characters
  the font lacks), `size` (0, the default, is auto: `0 Tf` in `/DA`, and the appearance uses the largest size up to 12
  that fits), `textColor`, `align` (`/Q`: `left`, `center`, `right`). A value with a character no font has **throws**.
- `textField` — `value`, `defaultValue`, `multiline`, `password` (takes no value: readers must never store a password
  in the file), `comb` with `maxLen` (1–1000 cells), `maxLen`, `doNotSpellCheck`, `doNotScroll`.
- `checkbox` — `checked`, `value` (the export value, the on state's name, default `Yes`; not `Off`), `style`
  (`check`, `cross`, `circle`, `square`, `diamond`, `star`, drawn in the appearance), `color` (the mark's).
- `radioGroup` — one field, a widget per entry of `buttons` (each `{ page, x, y, width, height, value }`, its own
  export value), `value` (the selected one), `noToggleToOff` (default true), `radiosInUnison`, `style` (default
  `circle`), `color`.
- `comboBox` (`editable`: any value; else the value must be an option's export value) and `listBox` (`multiSelect`:
  several values, written with their indexes in `/I`). Options are strings or `[export, display]` pairs, written in the
  given order (the Sort flag is never set); export values are unique; at most 10,000 options.
- `button` — a push button with a `label` (needs `font`) and/or an `icon` (an image from `pdf.embedImage`), a pressed
  appearance (`/D`, `pressedBackground`) and an optional `action`: `{ reset: true }` (ResetForm, every field),
  `{ reset: ['name', 'address.city', fieldHandle], exclude }`, or `{ named: 'NextPage' | 'PrevPage' | 'FirstPage' |
  'LastPage' }`. **Nothing else.**
- `signature` — an empty signature field (a framed widget, `/FT /Sig`) with an optional `lock` (`{ action: 'All' }`, or
  `Include`/`Exclude` with `fields`), to sign into later.
- `pdf.form.group(name)` — a parent field; its children are named `name.child` and written as a parent/kids tree
  (at most 32 levels).
- **Flattening**: `createPdf(sink, { form: { flatten: true } })` draws every field's appearance into its page and
  writes no AcroForm and no widgets: a filled form as a plain PDF (text extracts with pdftotext). In a tagged PDF each
  flattened field is a Figure whose alternate text is the tooltip and the value.
- **Tagged PDFs**: each widget is a `Form` structure element (with the tooltip as `/Alt`) holding an object reference
  to it; pages with fields get `/Tabs /S`. veraPDF UA-1 and A-2b pass with every field type, and flattened.
- **PDF/A-2**: fields are allowed with their appearance streams and NeedAppearances false, but ISO 19005-2 forbids
  any action on a widget (6.4.1) and ResetForm itself (6.5.1), so a button with an `action` **throws** in PDF/A;
  appearance dictionaries hold `/N` only (no pressed `/D`), a push button's as a one-state subdictionary.
- **Names**: a partial name cannot contain `.` (the hierarchy separator: use `group`), control, format, bidi or
  separator characters, and is at most 256 characters; full names are unique (a duplicate throws). Every name, value,
  option and tooltip is written as a hex text string, on-states and export values through the name writer.
- **No JavaScript, ever.** There is no option for `/AA` (additional actions), `/JS`, format, keystroke, validate or
  calculate scripts, SubmitForm or ImportData: each field takes a fixed set of options, and anything else throws
  (script-like keys with a message saying why). Calculation order (`/CO`) does not apply: it only orders calculate
  scripts, and there are none.
- Limits: 10,000 fields and groups a document, 1,000 buttons a radio group and 50,000 in all, 10,000 options (1,000,000
  characters in all), values of 100,000 characters, tooltips and options of 4,096.
- An embedded font in a fillable field is subset to the characters drawn; for fields people will type into, embed it
  with `subset: false` so a viewer has every glyph.

### Encryption

```js
const pdf = createPdf(sink, {
  encrypt: {
    userPassword: 'open me',          // '' (default): opens without a prompt, the permissions still apply
    ownerPassword: 'full access',     // left out: a random one (nobody can lift the permissions)
    algorithm: 'aes-256',             // default; 'aes-128' (V4/R4) for readers older than Acrobat 9
    permissions: { print: true, printHighQuality: false, modify: false, copy: false, annotate: true,
                   fillForms: true, accessibility: true, assemble: false },   // each defaults to true
    encryptMetadata: true,            // false: the XMP metadata stays readable
  },
});
```

- **AES-256** (V5/R6, ISO 32000-2, `/CFM /AESV3`) is the default; **AES-128** (V4/R4, `/CFM /AESV2`) is the option for old
  readers. Every string and stream gets a fresh random 16-byte IV (`crypto.getRandomValues`), AES-CBC with PKCS#7
  padding. R6 writes `/U`, `/UE`, `/O`, `/OE` and `/Perms`, and the catalog's Adobe extension level 8.
- Encryption streams like everything else: strings and streams are encrypted as their objects are written; the
  `/Encrypt` dictionary and the file ID are fixed at the start. The ID is therefore **random** (it can no longer be a
  hash of the content) unless you pass `id`; and an encrypted file's bytes differ on every run anyway (random IVs
  and salts), as they must.
- Passwords: at most 1024 characters are accepted; AES-256 keeps 127 UTF-8 bytes after SASLprep (non-ASCII spaces
  become spaces, NFKC, and control, private-use, unassigned and bidi characters are refused; the RFC 3454 bidi rule is
  not applied), AES-128 keeps 32 printable Latin-1 characters.
- **PDF/A** refuses encryption (ISO 19005 forbids it). In a **tagged** PDF (PDF/UA) the accessibility permission is
  forced on, with a warning.
- Runs on the platform's crypto only: WebCrypto (browsers, Node) with node:crypto as Node's fast path.

### Signatures

```js
import { createPdf, nodeSigner } from '@reportwright/pdf';
const pdf = createPdf(sink, { sign: true });                  // or { sign: { hash: 'SHA-384' } }
const page = pdf.addPage();
const field = pdf.form.signature('approval', { page, x: 40, y: 700, width: 200, height: 40 });
await pdf.sign(field, {
  signer: nodeSigner({ key: privateKeyPem, certs: certificateChainPem }),   // RSA, RSA-PSS (pss: true), ECDSA P-256/P-384
  reason: 'Approved', location: 'Paris', name: 'A. Signer', contactInfo: 'a@example.com',
  certify: 2,                    // optional DocMDP: 1 no changes, 2 form filling and signing, 3 also annotations
  timestamp: async (signatureValue) => tokenFromYourTsa,   // optional RFC 3161 TimeStampToken (PAdES B-T)
});
await pdf.end();                 // the signer runs here
```

- **PAdES baseline B-B** (B-T with `timestamp`): CMS SignedData, detached, `/SubFilter /ETSI.CAdES.detached` (or
  `subFilter: 'adbe.pkcs7.detached'`), with the signed attributes content-type, message-digest and ESS
  signing-certificate-v2; signing-time only for `adbe.pkcs7.detached` (PAdES puts the time in `/M`).
- **Streaming**: the file is never held or patched. Every byte is hashed as it goes out; the signature dictionary is
  the file's last object, and it, the xref and the trailer are built in memory, so the `/ByteRange` is known before
  they are written: the digest of everything but `/Contents` goes to the signer, and its CMS fills `/Contents`
  (hex, zero-padded to `reserve` bytes, default 16384; a CMS that does not fit is a clear error). In a browser
  (no incremental SHA in WebCrypto) the file's bytes are held until the digest.
- `signer` is any `async ({ digest, hash, subFilter, date, timestamp, signal }) => cmsBytes`: an HSM, a cloud KMS or
  node-forge. `cmsSigner({ certs, keyAlgorithm, sign(bytes, hash) })` builds the CMS around a raw signature function
  (what a KMS gives); `nodeSigner({ key, certs, pss })` signs with node:crypto. A signer that does not answer is stopped by
  `signal`/`timeoutMs`; when a timestamp is asked for, a CMS without one is refused.
- `field` is a signature field from `pdf.form.signature`, or `{ name, page, x, y, width, height }` to make one. The
  AcroForm gets `/SigFlags 3`. **One signature** a document (more need incremental updates).
- Works with encryption (the signature's `/Contents` is not encrypted, as the spec requires) and with PDF/A-2b.

### Tagged PDF

`page.tag(type, fn, options)` options: `alt` (`/Alt`), `actualText` (`/ActualText`: the text the element stands for),
`expansion` (`/E`: an abbreviation's expansion), `lang` (a language tag), `id` (`/ID`, unique, in the IDTree), and per
type: `TH` `scope` (`Row`, `Column`, `Both`); `TH`/`TD` `headers` (the ids of the TH cells that head it), `rowSpan`,
`colSpan`; `L` `listNumbering` (`None`, `Disc`, `Circle`, `Square`, `Decimal`, `UpperRoman`, `LowerRoman`,
`UpperAlpha`, `LowerAlpha`). Checked as you build: `TR` in `Table`/`THead`/`TBody`/`TFoot`, `TH`/`TD` in `TR`,
`THead`/`TBody`/`TFoot` in `Table`, `LI` in `L`, `Lbl`/`LBody` in `LI`; headings start at `H1` and never skip a level
going down (`H1` → `H3` throws; going back up is fine), and a document uses `H` or `H1`–`H6`, not both (PDF/UA 7.4.2,
7.4.4; checked in the order you tag). A `headers` id no element has fails `pdf.end()`.

```js
page.artifact({ type: 'Pagination', subtype: 'Header' }, () => page.text('Quarterly report', { x: 40, y: 20, font, size: 8 }));
page.tag('H1', () => page.text('Sales', { x: 40, y: 50, font, size: 20 }));
page.tag('Table', () => {
  page.tag('THead', () => page.tag('TR', () => ['Region', 'Q1'].forEach((h, i) =>
    page.tag('TH', () => page.text(h, { x: 40 + i * 120, y: 90, font }), { scope: 'Column', id: `h${i}` }))));
  page.tag('TBody', () => page.tag('TR', () => ['North', '1,204'].forEach((v, i) =>
    page.tag('TD', () => page.text(v, { x: 40 + i * 120, y: 110, font }), { headers: [`h${i}`] }))));
});
page.tag('L', () => ['First', 'Second'].forEach((t, i) => page.tag('LI', () => {
  page.tag('Lbl', () => page.text(`${i + 1}.`, { x: 40, y: 140 + i * 18, font }));
  page.tag('LBody', () => page.text(t, { x: 60, y: 140 + i * 18, font }));
})), { listNumbering: 'Decimal' });
page.tag('P', () => page.tag('Span', () => page.text('CFO', { x: 40, y: 190, font }), { expansion: 'Chief Financial Officer' }));
```

### PDF/A levels

`pdfa: { part, conformance }` (with `outputIntent` as before; `pdfa: true` is PDF/A-2b):

| level | what changes |
|---|---|
| `{ part: 1, conformance: 'b' }` | PDF 1.4: `%PDF-1.4`, a classic cross-reference table and trailer (no object or xref streams), subset fonts carry a `/CIDSet`, OpenType/CFF fonts go in as their bare CFF (`FontFile3 /CIDFontType0C`). Refused: transparency (opacity, blend modes, highlights' Multiply, images with alpha), 16-bit images, layers, attachments, `userUnit` |
| part 2, `'b'` | as before |
| part 2 or 3, `'u'` | every character drawn must map to Unicode: a character the font (and its fallbacks) lacks **throws** instead of being dropped with a warning |
| part 2 or 3, `'a'` | `'u'` plus tagged: `tagged` is required (use `page.tag` for the content) |
| part 3, `'b'`/`'u'`/`'a'` | embedded files allowed (`pdf.attach`, `pdf.facturX`), each with `/AFRelationship` and listed in the catalog's `/AF` |

Every level in this table passes veraPDF (`--flavour 1b`, `2b`, `2u`, `2a`, `3b`, `3u`, `3a`) with 0 failed rules on
a document with text, a table, a list, headings, images, links, a note, form fields, layers and attachments as the
level allows. PDF/A-1a is not offered (its structure rules predate PDF/UA; use 2a or 3a). Encryption is refused at
every level. PDF/X is not offered (no validator was available to check it).

### Embedded files

```js
await pdf.attach(csvBytes, { name: 'lines.csv', mimeType: 'text/csv', description: 'Invoice lines', relationship: 'Data' });
```

Document-level files, in the catalog's `/Names /EmbeddedFiles` tree (sorted, balanced: 64 a leaf), each with a file
specification (`/F`, `/UF`, `/Desc`, `/AFRelationship`) and an embedded-file stream (`/Subtype` the MIME type, `/Params`
with `/Size`, an MD5 `/CheckSum`, `/CreationDate`, `/ModDate`: default the document's date). `pdfdetach -list` shows
them. Options: `name` (checked like `page.attachFile`'s: spoofing and look-alike characters, device names, an allowlist
of passive types, `allowTypes`/`allowArchives` to widen it), `mimeType` (must agree with the extension; **required in
PDF/A-3**), `description`, `relationship` (`Source`, `Data`, `Alternative`, `Supplement`, `Unspecified`; default
`Unspecified` in PDF/A-3), `created`, `modified`, `maxBytes` (refuse a larger file before it is copied; default and at
most 256 MB). At most 10,000 files; a name used twice throws. The bytes are written at the call (copied, so the checksum
is of what is written); nothing is held. PDF/A-1 and PDF/A-2 refuse attachments (PDF/A-2 allows only PDF/A files,
which cannot be checked here); in PDF/A-3 every file is listed in `/AF`.

### Factur-X / ZUGFeRD / XRechnung

```js
const pdf = createPdf(sink, { title: 'Invoice 2026-001', pdfa: { part: 3, conformance: 'b' } });
// … draw the invoice …
await pdf.facturX(ciiXmlBytes, { profile: 'EN 16931' });   // MINIMUM, BASIC WL, BASIC, EN 16931, EXTENDED, XRECHNUNG
```

Needs PDF/A-3 (`b`, `u` or `a`). The XML is embedded as `factur-x.xml` (`xrechnung.xml` for `XRECHNUNG`), MIME
`text/xml`, `/AFRelationship /Data` for MINIMUM and BASIC WL (they are not a full invoice) and `/Alternative` for the
others, and listed in `/AF`; the XMP gets the `fx:` properties (`DocumentType INVOICE`, `DocumentFileName`, `Version
1.0`, `ConformanceLevel` the profile) with the PDF/A extension schema that describes them (Factur-X 1.0.07; ZUGFeRD 2.1
and later use the same). `version` is `'1.0'` (the only one). One invoice a document.

The XML is **data**: it is never handed to an XML parser. A size-capped (10 MB), linear scan refuses any `DOCTYPE`,
`ENTITY`, `ELEMENT` or `ATTLIST` declaration (no entity can expand), requires UTF-8, checks that the root element is
`CrossIndustryInvoice` and that its `GuidelineSpecifiedDocumentContextParameter` ID names the profile given (BASIC
needs `urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic`, and so on; XRECHNUNG any
`…#compliant#urn:xeinkauf.de:kosit:xrechnung_` version). It does **not** validate the invoice: run the Factur-X XSD and
Schematron (or the KoSIT validator for XRechnung) before embedding. Checked: veraPDF A-3b/3u/3a with 0 failed rules,
`pdfdetach`, and the factur-x Python package (akretion) extracting `factur-x.xml` from the PDF and passing its XSD.
`examples/factur-x.mjs` writes a tagged PDF/A-3a invoice.

### Layers

```js
const notes = pdf.layer('Reviewer notes', { visible: false });
page.layer(notes, () => page.text('Check this total', { x: 400, y: 300, font }));
```

`pdf.layer(name, { visible = true, printable = visible, locked = false })` makes an optional content group;
`page.layer(layer, fn)` puts what `fn` draws (synchronously; `save()`/`restore()` must balance inside) into it, as
`/OC … BDC … EMC`; layers nest (at most 32 deep). The catalog gets `/OCProperties` with every layer in `/OCGs` and the
default configuration `/D` (`/Name`, `/Order` listing every layer, `/ON`, `/OFF`, `/Locked`). `visible` and
`printable` differing makes a screen-only or print-only layer (`/Usage` and the `/AS` auto-states); PDF/A forbids
`/AS`, so there they must agree. Not in PDF/A-1 (refused). At most 10,000 layers.

### Document

- `await pdf.end()` — ends open pages, writes fonts, outline, metadata and the cross-reference stream; resolves to
  `{ pages, bytes, warnings }`.

### Reading and modifying

```js
import { loadPdf, mergePdfs } from '@reportwright/pdf';

const doc = await loadPdf(bytes, { password, budget: { maxDecoded: 256 << 20 }, timeoutMs: 10_000, signal });
doc.pageCount; doc.info; doc.xmp; doc.pdfa;               // { part: 3, conformance: 'a' } or null
doc.page(0).extractText();                                 // content order, in lines
doc.outlines; doc.fields; doc.attachments; doc.signatures;

doc.copyPages(other, [0, 2], { at: 1 }).removePages([4]).movePage(0, 3);
doc.page(0).rotate(90);
doc.page(0).draw((p, { fonts }) => p.text('DRAFT', { x: 200, y: 400, font: fonts.f, size: 60, color: '#c00000' }), { fonts: { f: 'Helvetica-Bold' } });
doc.fill({ 'name': 'Ada', 'agree': true, 'size': 'L', 'tags': ['a', 'b'] }, { font: ttfBytes });
doc.setInfo({ title: 'Signed copy' });
const { bytes, stripped, warnings } = await doc.save({ encrypt: { userPassword: 'pw' } });
const merged = await mergePdfs([a, b, c]);
const one = doc.fork().reorder([5]); await one.save();    // split: a fork per page

const signed = await doc.saveIncremental({ sign: { field: { name: 'approval', page: 0, x: 40, y: 700, width: 180, height: 40 }, signer: nodeSigner({ key, certs }) } });
```

- `loadPdf(bytes, { password, budget, timeoutMs, signal })` reads lazily: the cross-reference (classic tables, xref
  streams, hybrid files, incremental updates — the latest wins — object streams), the trailer, `/Encrypt`, `/ID` and
  the page tree; an object is parsed when asked for, a stream decoded when needed (Flate, LZW, ASCII85, ASCIIHex,
  RunLength, PNG and TIFF predictors; DCT, JPX, JBIG2 and CCITT are passed through undecoded). A broken
  cross-reference is rebuilt by scanning for `n g obj` (`doc.recovered`), a wrong `/Length` found again from the next
  `endstream` (`doc.warnings` says what was repaired). Encrypted files: the user or the owner password; RC4 (40–128
  bit), AES-128 and AES-256 are read (`doc.encryption`); only AES is ever written.
- `doc.page(i)`: `width`, `height`, the five boxes (`[x0, y0, x1, y1]`, PDF space), `rotation`, `userUnit`,
  `extractText()`, `annotations()`, `draw(fn, { fonts, images })`, `rotate(deg)`, `removeAnnotations()`.
- `extractText()` maps each code to Unicode through the font's ToUnicode CMap, else its encoding (WinAnsi, MacRoman,
  Standard, `/Differences` glyph names), places it with the text and graphics matrices (form XObjects included) and
  groups lines (a new line when the baseline moves by half the size; a space at a gap of a quarter of it, or a wide
  `TJ` adjustment). It is **not layout-perfect**: no columns, no reading order beyond the stream's, no RTL reordering.
- `doc.fields`: full names, types (text, checkbox, radio, pushbutton, combo, list, signature), values, options and
  widgets. `doc.attachments`: `rawName`, `name` (checked by the same file-name rules as the writer; `null` and
  `refused` when it would spoof or is executable), `mimeType`, `bytes()`. `doc.signatures`: each signed field with its
  `/ByteRange`, `coversWholeFile`, `revision`, `bytesAfter` and the CMS (not verified: `signedBytes()` gives the bytes
  to verify it against).
- Changes are a plan, written by `save()` or `saveIncremental()`. `copyPages(src, indexes, { at })`, `merge(docs)`,
  `removePages`, `reorder`, `movePage`, `rotate`, `draw`, `fill(values, { font })`, `flatten()`, `setInfo`,
  `setXmp`, `removeAnnotations`; `fork()` copies the plan (the source is shared).
- **`save(options)`** writes a NEW file through the writer (`saveTo(sink, options)` streams it): pages are deep-copied
  as they are written (fonts, images, XObjects, annotations), equal objects written once (also across merged files),
  destinations and links remapped to the new pages (a link to a page not copied is dropped), unused objects left out,
  uncompressed streams compressed, object streams on. Drawn content (`page.draw`, flattened fields) is a form XObject
  after the page's own content, which is wrapped in `q … Q` (closing any `q` it leaves open), so nothing the old
  content does to the graphics state reaches it. The first document gives the catalog (form with every contributing
  document's fields, outline of each, embedded files merged, structure tree when every page is its own, layers, viewer
  preferences). PDF/A is kept when every document declares the same level and output intent (its profile, XMP and
  identification kept; overlays obey the writer's PDF/A rules); otherwise dropped with a warning. A rewrite invalidates
  signatures, so their values are dropped (reported in `stripped`). Options: `compress`, `keepActiveContent`,
  `encrypt`, `pdfa: 'keep' | false`, `keepStructure`, `creationDate`, `signal`, `timeoutMs`.
- `fill`: text and combo values are strings, check boxes booleans, radio groups an export value, list boxes a string
  or strings. Text and choice appearances are made again by the writer's form code at the widget's size and look
  (`/DA` font, size and colour, `/Q`, `/MK` border and background, multiline, comb): with the `/DA` standard font, or
  `font` (bytes; required in PDF/A and for text outside WinAnsi). A character the font lacks throws, naming the field.
- **`saveIncremental({ sign, keepActiveContent })`** appends only the changed objects, a new cross-reference section
  (the file's kind) with `/Prev`, so EXISTING SIGNATURES STAY VALID (poppler then reports the first one as "not total
  document signed" while its own bytes still verify). It can fill fields, change the info, the XMP and rotation, and
  sign: an empty signature field by name, or a new one (`{ name, page, x, y, width, height }`; no size: invisible), with
  group F's signers, the `/ByteRange` over the whole file including the original bytes. An encrypted file's new objects
  use its own AES key; RC4 files cannot be updated (writing RC4 is refused).
- `mergePdfs(docs, options)`: every page of each, into a new file. **A merged PDF/UA (or PDF/A-a) file is no longer
  tagged**: the structure tree is kept only when every page comes from one document (and the form is not flattened),
  so a merge drops it with `/MarkInfo` and `/Lang`, the XMP's PDF/UA identification (`pdfuaid`) goes too, PDF/A-a is
  claimed as PDF/A-b, and `warnings` says "the structure tree (tags) was dropped … the result is not tagged (no
  longer PDF/UA …)". Tag the merged content again with the writer if the result must be PDF/UA.
- Errors from the input are `PdfReadError` with a `code`: `E_MALFORMED`, `E_BUDGET`, `E_DEPTH`, `E_CYCLE`,
  `E_TIMEOUT`, `E_ABORTED`, `E_PASSWORD`, `E_UNSUPPORTED`, `E_ACTIVE`.

## Security

What the library refuses, and why:

| Refused | Why |
|---|---|
| RC4 encryption (40- and 128-bit, V1–V3 / R2–R3) | broken: a biased key stream and brute-forceable 40-bit keys; it only looks like protection |
| Encryption in PDF/A | ISO 19005 forbids it: an archive must open anywhere, forever |
| Turning off the accessibility permission in PDF/UA | ISO 14289 needs assistive technology to read the content (forced on, with a warning) |
| An empty owner password | it would give everyone full access; leave it out for a random one |
| Passwords over 1024 characters; control, bidi, private-use or unassigned characters (AES-256); non-Latin-1 (AES-128) | bounded input, and SASLprep, so every reader derives the same key |
| A signer's CMS that is not one DER SignedData, is larger than `reserve`, or (with `timestamp`) carries no token | garbage must not land in `/Contents`; a dropped timestamp would downgrade B-T to B-B silently |
| A second signature in one document as it is created | it needs an incremental update: `saveIncremental({ sign })` |
| A Factur-X XML with a DOCTYPE, ENTITY or other markup declaration, over 10 MB, or not UTF-8 | the XML is data: nothing may expand (billion laughs, external entities); it is never given to an XML parser |
| Caller text inserted into XMP unescaped | title, author, subject and keywords are escaped (`& < > " '`; characters XML cannot carry dropped); schema prefixes and names are checked as XML names |
| An attachment over `maxBytes`, or with a spoofed name | the size is checked before any copy; names go through the same checker as `page.attachFile` |

Crypto comes from the platform only (WebCrypto, node:crypto in Node); no AES or SHA is hand-written. The key
derivations of the standard security handler (ISO 32000-2 Algorithm 2.B; ISO 32000-1 Algorithms 2, 3, 5) are written
here, as the spec composes them, and checked against vectors from qpdf. Passwords and keys never appear in an error.
JavaScript, launch and submit actions cannot be written at all (see Forms and Links).

**Reading files from strangers.** The reader treats every byte as hostile:

| Bound | Default (`budget` option) |
|---|---|
| Decoded stream bytes, the whole document / one stream (every filter and predictor counts as it produces, so a zip bomb stops at the cap: a 302-byte stream that inflates to 10 GB stops at 128 MB) | `maxDecoded` 512 MB / `maxStream` 128 MB |
| Parsing steps (tokens, xref rows, tree nodes, operators); time | `maxSteps` 200 M; `timeoutMs`, `signal` |
| Cross-reference entries and scanned objects held; one page's text pieces | `maxObjects` 5 M; `maxTextItems` 1 M (and 16 M characters a page, ActualText included) |
| Nesting of arrays and dictionaries (an explicit stack, never recursion) | 256 |
| A chain of indirect references | 32 |

Every count and length is bounded by the bytes actually there (xref rows, `/N`, `/Length`, strings, `/Count` is never
trusted); loops are cut where they can occur (`/Prev`, page tree `/Kids`, outline `/Next`, AcroForm `/Kids`, an object
stream inside an object stream, form XObjects drawing themselves); recovery is one bounded pass.

**Active content is never carried over** unless `keepActiveContent: true`. One registry (`src/reader/policy.js`) says
what is allowed, and both save paths use it:

| Kept | Dropped (and reported in `stripped`) |
|---|---|
| Actions: GoTo, URI (plain-ASCII bytes accepted by the writer's URL check — http, https, mailto, ftp — and written as normalised), Named page moves, ResetForm | every other action (JavaScript, Launch, SubmitForm, ImportData, GoToR, GoToE, Hide, Movie, Sound, Rendition, RichMediaExecute, SetOCGState, Trans, GoTo3DView, Thread, unknown), wherever it is: `/A`, `/OpenAction`, `/Next` arrays, `/PA`, through references, or any dictionary whose `/S` is an action type |
| Annotations: Link, Text, FreeText, Line, Square, Circle, Polygon, PolyLine, Highlight, Underline, Squiggly, StrikeOut, Stamp, Caret, Ink, Popup, FileAttachment, Widget | RichMedia, Screen, Movie, Sound, 3D and anything else; every `/Annots` element and form widget is checked by position |
| File specifications whose every name key passes the writer's file-name check and agrees in extension (written back as the checked `/UF` and `/F`, with one embedded stream) | any other (`/F` "evil.exe" behind a clean `/UF`, `/DOS`, a spoofed double extension) |
| — | `/AA`, `/JS`, `/Names /JavaScript`, the AcroForm's `/XFA` |

An attachment that is itself a PDF is copied as data: its own content is not sanitised (opening it is a separate act).

**An incremental update cannot strip anything**: the original bytes stay, and a reader that rebuilds the
cross-reference, shows an earlier revision or follows `/Prev` finds them again. So `saveIncremental` checks the WHOLE
file first — every object in the bytes (the parser's own lexer plus a byte scan, every duplicate, every object stream,
every cross-reference entry) against the same registry — and refuses (`E_ACTIVE`, naming what it found) if there is
any active content, or if anything cannot be read (fail closed), unless `keepActiveContent: true`. **For files from
strangers, `save()` is the safe path** (it rewrites the file without the active content; this invalidates existing
signatures).

**Signed documents (signature policy).** `saveIncremental` reads every signature's permissions and takes the
strictest: DocMDP from the catalog `/Perms` and from each signature's `/Reference` in every revision (no `/P` means
P=2), FieldMDP from each `/Reference` and each signed field's `/Lock`, and ReadOnly from any ancestor field. Anything it
cannot read or does not know refuses the update (`E_SIGNED`, fail closed).

| The document | Allowed | Refused |
|---|---|---|
| certified P=1 | nothing | every update, including a new signature |
| certified P=2 or P=3 | fills (opt-in, below) and new signatures | rotation, Info/XMP changes |
| signed, no DocMDP | fills (opt-in) and new signatures | rotation, Info/XMP changes unless `allowChangesAfterSigning: true` |
| a locked (FieldMDP) or ReadOnly field | — | filling it |

Filling a form **after it was signed** needs `allowFillAfterSigning: true`. Viewers show such a document as "changed
after signing", and refilling widgets that existed before signing is how "shadow attacks" (Mainka et al., USENIX
Security 2021) make a signed document look different while its signature still verifies. As a second guard the filled
widgets may cover at most 40% of a page in all, and a widget with an opaque background may not lie over the page's text.

## Not supported yet

Image masks (stencils) and colour-managed images (embedded ICC profiles of PNG/JPEG files are ignored); the Unicode
bidi algorithm, hyphenation, kerning of the standard fonts, WOFF fonts; popup annotations; RC4 encryption (refused; read only), public-key (certificate) encryption (neither written nor read), verifying signatures' cryptography (they are listed with their coverage); PDF/A-1a, PDF/X, attachment annotations in PDF/A-3 (use `pdf.attach`), validating a Factur-X invoice's content; layout-perfect text extraction; page edits in an incremental update (use `save()`); reading encrypted files in browsers (WebCrypto has no synchronous AES; Node only). See NOTES.md for the plan. Extending the library: ARCHITECTURE.md.
