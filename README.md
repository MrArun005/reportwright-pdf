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
- `await pdf.embedFont(bytes, { subset })` — a TrueType (`glyf`) or OpenType/CFF font. Any Unicode text (Identity-H
  with a ToUnicode map, so text can be copied and searched). `subset`: `true` (default) keeps only the glyphs used
  (built-in subsetter for TrueType; CFF fonts embed whole); `false` embeds the whole font; or a function
  `(font, codePoints, { glyphs }) => Promise<Uint8Array>` (e.g. a HarfBuzz subsetter) that must keep glyph IDs.
- `font.widthOf(text, size)`, `font.ascent`, `font.descent` (fractions of the size) — for your own layout.

Characters a font has no glyph for are reported in `pdf.end()`'s `warnings` (standard fonts drop them; embedded fonts
draw the font's "missing" box, or drop it in PDF/A and PDF/UA, which forbid it).

### Pages

`const page = pdf.addPage({ width, height })` (default A4). `page.number` is 1-based.

- `page.text(str, { x, y, font, size = 12, color })` — one line, no wrapping, no kerning.
- `page.line(x1, y1, x2, y2, { color, width = 1, dash })` — `dash`: `[on, off]`.
- `page.rect(x, y, w, h, { fill, stroke, width = 1 })` — fill, stroke or both (default: fill black).
- `page.link(x, y, w, h, { url } | { page, top }, { alt })` — `page`: a 1-based number or a page object (it may not
  exist yet); `top`: y on the target page (default: fit the page). `alt`: the description screen readers announce.
- `page.tag(type, fn, { alt, lang, scope })` — when `tagged`: what `fn` draws becomes a structure element of `type`
  (`P`, `H1`…`H6`, `Table`, `TR`, `TH`, `TD`, `L`, `LI`, `Link`, `Figure`…). Tags nest. Anything drawn outside a tag is
  marked as an artifact (decoration). Without `tagged` it just calls `fn`.
- `await page.end()` — the page is compressed and written; nothing of it stays in memory.

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

### Document

- `pdf.outline({ title, page, top?, level? })` (or an array) — bookmarks; `level` nests (0 = top).
- `await pdf.end()` — ends open pages, writes fonts, outline, metadata and the cross-reference stream; resolves to
  `{ pages, bytes, warnings }`.

## Not supported yet

Image masks (stencils) and colour-managed images (embedded ICC profiles of PNG/JPEG files are ignored); kerning, shaping, text
wrapping; annotations other than links; form fields; encryption and signatures; PDF/A-1/3, attachments; reading or
editing existing PDFs. See NOTES.md for the plan. Extending the library: ARCHITECTURE.md.
