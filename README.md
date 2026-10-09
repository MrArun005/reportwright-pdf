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
| `title`, `author`, `subject` | document info, mirrored in the XMP metadata |
| `creationDate` | a `Date` (default: now). With the same input and date the output is byte-for-byte identical |
| `compress` | `true` (default): content, fonts, object streams and the xref stream are Flate-compressed |
| `pdfa` | `true`: PDF/A-2b (sRGB output intent bundled, XMP identification). Fonts must be embedded. `{ outputIntent: iccBytes }`: your RGB or CMYK output profile instead (a CMYK intent allows CMYK colour and refuses RGB) |
| `tagged` | `{ lang: 'en-GB' }`: PDF/UA-1 — a structure tree (`page.tag`), `title` required, fonts embedded |
| `signal`, `timeoutMs` | stop the export: pending and later calls reject with the signal's reason / a `TimeoutError` |
| `id` | the file identifier (32 hex digits); default: a hash of the file's bytes |

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

`const page = pdf.addPage({ width, height })` (default A4). `page.number` is 1-based.

- `page.text(str, { x, y, font, size = 12, color, … })` — one line (options below).
- `page.textBox(str, { x, y, width, height, font, size, align, lineHeight, maxLines, ellipsis, … })` — paragraphs
  (split at `\n`) wrapped by word, a word longer than the line broken inside; `align`: `left` (default; `right` for
  `direction: 'rtl'`), `right`, `center`, `justify` (word spacing: `Tw` for standard fonts, TJ adjustments at spaces
  for embedded fonts; a paragraph's last line is not stretched). `maxLines` ends the last line with `…` (`...` when
  no font has it) when text is left; `height` stops at the last whole line that fits, without an ellipsis, so the
  rest can go on in another box. Returns `{ height, lines, overflow }` (`overflow`: the text not drawn, `''` when it
  all fit). No hyphenation. At most 10,000,000 characters and 100,000 lines a box (the rest is overflow); layout is
  linear in the text it reads and stops once the visible lines are known.
- `page.line(x1, y1, x2, y2, { color, width = 1, dash })` — `dash`: `[on, off]`.
- `page.rect(x, y, w, h, { fill, stroke, width = 1 })` — fill, stroke or both (default: fill black).
- `page.link(x, y, w, h, target, { alt, highlight, border, quadPoints, allowSchemes })` — see Links below.
- `page.tag(type, fn, { alt, lang, scope })` — when `tagged`: what `fn` draws becomes a structure element of `type`
  (`P`, `H1`…`H6`, `Table`, `TR`, `TH`, `TD`, `L`, `LI`, `Link`, `Figure`…). Tags nest. Anything drawn outside a tag is
  marked as an artifact (decoration). Without `tagged` it just calls `fn`.
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
offsets); a glyph standing for its cluster's text maps it in ToUnicode (a ligature maps to all its letters); a cluster
of several glyphs (reordered matras, conjuncts) or a glyph already standing for other text is wrapped in an
`/ActualText` span, so copied text is the source text. The shaper's output is checked (glyph IDs in the font, finite
numbers, clusters inside the text, at most 4 glyphs a character). `examples/harfbuzz-shaper.mjs` is an adapter for
harfbuzzjs (not a dependency):

```js
import { harfbuzzShaper } from './harfbuzz-shaper.mjs';           // copy it from examples/
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

- `await pdf.embedImage(bytes, { colorSpace })` — a JPEG or PNG, written to the file at once as an image XObject;
  returns a handle with `width` and `height` (pixels, after the EXIF orientation). `colorSpace`: an ICC colour space
  (`pdf.iccColorSpace`) with the image's number of components, instead of the device space.
  - **JPEG**: baseline and progressive, gray, RGB and CMYK, embedded unchanged (DCTDecode, no re-encoding). Adobe's
    inverted CMYK (an APP14 "Adobe" segment) is drawn with `/Decode [1 0 1 0 1 0 1 0]`. The EXIF orientation (1–8)
    is honoured. 12-bit, lossless, hierarchical and arithmetic-coded JPEGs are refused.
  - **PNG**: gray, RGB, palette, gray + alpha, RGBA; 1, 2, 4, 8 and 16 bits; Adam7 interlacing; tRNS. Without alpha
    and not interlaced, the compressed data is copied through (FlateDecode with the PNG predictor). Alpha (and a
    palette's or a 16-bit colour key's tRNS) becomes a soft mask (`/SMask`); an 8-bit-or-less colour key a `/Mask`;
    interlaced images are de-interlaced. Those are re-compressed. Other chunks (gamma, ICC, text, eXIf) are ignored.
  - Limits: each side ≤ 65,535 pixels, ≤ 100 megapixels, ≤ 256 MB of file, and ≤ 400 MB decoded for a PNG that
    needs decoding (alpha or interlacing). Truncated or corrupt files, lying chunk or marker lengths, bad CRCs and
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
  only passive types are allowed (pdf, images, text, csv, json, xml, Office documents without macros, ics, vcf, eml…;
  zip with `allowArchives`), so anything else needs `allowTypes: ['ext']`, **by which you accept that type's risk**;
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

### Document

- `await pdf.end()` — ends open pages, writes fonts, outline, metadata and the cross-reference stream; resolves to
  `{ pages, bytes, warnings }`.

## Not supported yet

Image masks (stencils) and colour-managed images (embedded ICC profiles of PNG/JPEG files are ignored); the Unicode
bidi algorithm, hyphenation, kerning of the standard fonts, WOFF fonts; popup annotations; encryption and signatures; PDF/A-1/3 and document-level attachments (the EmbeddedFiles tree); reading or
editing existing PDFs. See NOTES.md for the plan. Extending the library: ARCHITECTURE.md.
