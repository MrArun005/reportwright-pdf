# Renderer (experimental)

Page → pixels in pure JS, no runtime dependencies (zlib for PNG comes from the bundled fflate).

```js
import { loadPdf, renderPage, toPng, drawToCanvas } from '@reportwright/pdf';
const doc = await loadPdf(bytes);
const page = renderPage(doc, 0, { scale: 2 }); // { width, height, data: Uint8ClampedArray RGBA }
await toPng(page);                             // PNG bytes
drawToCanvas(ctx, page);                       // browsers: putImageData on a 2D context
```

Options: `scale` (pixels per point, 1 = 72 dpi), `fonts` (outlines for the standard 14: `stdFonts` from the optional
`@reportwright/pdf-std-fonts` package, or your own `{ Helvetica: ttf, default: ttf }`),
`background` (RGBA, white), `annotations` (draw appearance streams, true), `timeoutMs` (60 s).

## How it works

| part | file | reuses |
|---|---|---|
| content interpreter (graphics state, text state, forms, annotations) | `src/render/render.js` | the reader's lexer, `decodeStream` and filters, budget, `pageAt`, `skipInline`, `glyphText`, standard metrics |
| rasterizer: polygons → anti-aliased coverage (non-zero: exact signed-area accumulation in bands of at most 4 MB; even-odd: 4 sub-scanlines, exact horizontally), stroker (width, caps, joins, miter limit, dashes), curve flattening | `src/render/raster.js` | — |
| glyph outlines: TrueType `glyf` (simple + composite), CFF Type 2 charstrings | `src/render/glyphs.js` | `sfntTables`, `parseFont`, `parseCff` (its checked INDEXes, FDSelect, charset) |
| JPEG decoder (DCTDecode) | `src/images/jpeg-decode.js` | — (the reader can use it too) |
| PNG encoder, canvas helper | `src/render/png.js` | fflate (bundled) |
| standard-font outlines (optional package) | `packages/std-fonts` | — |

Everything runs under the document's budget (each operator a step) and a time limit; forms nest at most 16 deep and never
re-enter themselves; the device is at most 16,384 px a side and 64 M pixels. A broken font or image draws as nothing.

Renders of one document share caches (per set of `fonts` bytes, so a fresh options object still hits): parsed fonts and
glyph outlines, decoded images, pages' and forms' decoded content. Each has a cap and is emptied past it.

| cap | limit | when exceeded |
|---|---|---|
| output | 16,384 px a side, 64 M pixels; scale ≤ 100 | RangeError, before allocating |
| path | 4 M numbers; flattening 4 M points (checked before each curve's points); a fill 4 M points (before its edges are allocated) | E_BUDGET |
| stroke | 4 M points as pieces are made (dashes × joins × caps); 100,000 dashes; dash array ≤ 64 | E_BUDGET |
| rasterizer work | budget steps for every edge, band, crossed cell and painted span, before the work | E_BUDGET / E_TIMEOUT |
| `q` / clips | 256 deep; clip masks 1 GB per render, each charged before allocation | E_BUDGET |
| forms | 16 deep, no re-entry, 10,000 drawn per page | E_BUDGET |
| images | 25 M pixels, checked before decoding; decoding charged per 16 pixels | image skipped |
| JPEG | ≤ 25 M pixels, 1–4 components, sampling 1–4 and ≤ 10 blocks per MCU, ≤ 64 scans, Huffman tables checked, coefficient buffers charged before allocation, truncated data stops (≤ 64 zero bits) | image skipped |
| glyphs | composite 256 parts / 8 deep / 1 M numbers; 8 M outline numbers per font; text batches ≤ 4096 polygons or 4 M numbers | glyph skipped / cache emptied / batch painted |
| document caches | 1,024 fonts, 32 M glyph numbers, 256 MB decoded images, 64 MB content, 4 font sets | that cache emptied |

## What draws

- Paths: `m l c v y h re`, fill non-zero / even-odd, stroke (width — at least one device pixel, as pdf.js —, butt / round /
  square caps, miter / round / bevel joins, miter limit, dash arrays and phase), `B b B* b*`, clipping `W W*`, `cm`, `q Q`.
- Colour: DeviceGray / RGB / CMYK (CMYK → RGB by pdf.js's press-profile polynomial, no ICC), ICCBased (by its `N`), CalRGB / CalGray, Indexed; constant
  opacity `ca` / `CA` from ExtGState; LW / LC / LJ / ML / D / Font from ExtGState.
- Text: every positioning and state operator, render modes 0–3 (4–7 drawn as 0–2, no clip), Type0 Identity-H (Identity-V advanced horizontally, phase 2) with
  CIDFontType2 (TrueType, CIDToGIDMap) and CIDFontType0 (CFF, bare or OpenType), simple TrueType fonts (Encoding,
  Differences, symbolic cmaps).
- Standard 14 fonts: the file has no outlines and the core ships metrics only. With the optional
  `@reportwright/pdf-std-fonts` package (`fonts: stdFonts`, 5.4 MB, SIL OFL 1.1) they draw in Liberation Sans / Serif
  / Mono 2.1.5 (metric-compatible with Helvetica / Times / Courier), Symbol in Liberation Serif (its Greek and common
  maths, not every Symbol glyph) and ZapfDingbats in Noto Sans Symbols 2, by their own code tables. Any other
  TrueType/OpenType can stand in (`fonts: { default: ttf }`), advanced by the PDF's widths; Symbol and ZapfDingbats
  only take a font given for them by name. With none, standard-font text is not drawn.
- Images: XObjects and inline images; Flate / LZW / ASCII85 / ASCIIHex / RunLength / raw; JPEG (DCTDecode: baseline
  and progressive Huffman, 8-bit, 4:4:4 / 4:2:2 / 4:2:0 and any sampling, restart markers, Adobe APP14 YCbCr / YCCK /
  inverted CMYK, `/ColorTransform`; 12-bit and arithmetic-coded JPEGs are skipped with "not supported"); 1–16 bits; Gray / RGB / CMYK /
  Indexed; `/Decode`; stencil masks (`ImageMask`) in the fill colour; `/SMask` soft masks; single-component colour-key
  `/Mask`; nearest-neighbour unless `/Interpolate` (as pdf.js).
- Form XObjects (Matrix, BBox clip, own Resources) and annotation appearance streams (`/AP /N`, `/AS` state, Matrix →
  Rect mapping; Hidden / NoView / Popup skipped) — form fields render.
- Page rotation (`/Rotate`, `page.rotate()`), CropBox.

## Phase 2 (not drawn yet)

Shadings (`sh`, shading patterns) and tiling patterns; transparency groups, soft masks in ExtGState, blend modes; Type 3
and Type 1 (`FontFile`) fonts and bare CFF simple fonts (`FontFile3 /Type1C`); non-Identity CMaps; 12-bit and
arithmetic JPEG, JPX, JBIG2, CCITT images; inline images with DCTDecode; Separation / DeviceN through their tint transforms (drawn as gray now); Lab;
text render-mode clipping; colour-key masks with more than one component; box-filtered image downscaling; hinting; CFF
`seac` accents; a CFF FontMatrix other than 1/1000; ICC profiles and output intents.

## Against pdf.js

`tests/render.test.js` renders each fixture page at scale 2 with both (pdf.js via `pdfjs-dist` + `@napi-rs/canvas`, dev
dependencies only, annotations drawn on canvas) and counts the pixels whose channels differ by more than 48 levels.

| page | differing pixels (all) | differing inked pixels |
|---|---|---|
| ours: text (Inter, TrueType) | 0.01% | 0.17% |
| ours: table (rules + text) | 0.00% | 0.02% |
| ours: vector (fills, even-odd, caps, joins, dash, CMYK, opacity) | 0.00% | 0.00% |
| ours: images (RGB, RGBA soft mask, gray) | 0.00% | 0.00% |
| ours: form (text field, checkboxes) | 0.00% | 0.36% |
| ours: CFF font (Noto Sans SC) + `/Rotate 90` + clipping | 0.00% | 0.01% |
| ours: 8 JPEGs (baseline 4:2:0 / 4:2:2 / 4:4:4, progressive 4:2:0 / 4:4:4 / gray, restart markers, optimised Huffman) | 0.00% | 0.00% |
| ours: Adobe CMYK JPEG | 0.00% | 0.00% |
| pdf-lib: vector + standard Helvetica, with `stdFonts` | 0.00% | 0.01% |
| pdf-lib: RGBA image + form widgets, with `stdFonts` | 0.00% | 0.01% |
| pdf-lib: the same two with Inter standing in for Helvetica | 0.72% / 0.47% | 2.98% / 1.18% (glyph shapes) |

JPEG fixtures: `tests/fixtures/jpeg` (made with cjpeg from libjpeg-turbo 3.2 and sharp). 4:4:4 decodes within 2
levels of libjpeg; subsampled chroma is repeated (nearest), as pdf.js does, where libjpeg interpolates.

## Speed

Apple Silicon laptop, Node 20, scale 2 (600 × 440 px pages), one engine per process, `fonts: { default: Inter }`
written afresh each call. Warm: the same page again, mean of 30 after 5. Cold: the first render of a freshly loaded
document (it includes JIT warm-up for whichever page runs first, text here).

| page | warm, round 1 | warm now | pdf.js warm | now ÷ pdf.js | cold, round 1 | cold now | pdf.js cold |
|---|---|---|---|---|---|---|---|
| text | 4.65 ms | 1.43 ms | 1.29 ms | 1.1× | 25.2 ms | 19.6 ms | 53.8 ms |
| table | 3.36 | 1.39 | 0.76 | 1.8× | 4.8 | 8.9 | 7.5 |
| vector | 2.04 | 1.37 | 0.55 | 2.5× | 7.9 | 3.1 | 3.0 |
| images | 3.54 | 1.63 | 0.69 | 2.4× | 11.8 | 10.3 | 4.9 |
| form | 1.71 | 0.68 | 0.57 | 1.2× | 7.1 | 3.2 | 10.9 |
| cff | 2.19 | 1.10 | 0.58 | 1.9× | 5.2 | 5.5 | 12.8 |
| jpeg (8 images) | 9.85 | 2.72 | 1.14 | 2.4× | 42.4 | 25.7 | 13.3 |
| jpeg-cmyk | 2.21 | 0.45 | 0.48 | 0.9× | 15.5 | 9.1 | 7.8 |
| pdf-lib vector | 2.42 | 1.24 | 0.63 | 2.0× | 10.1 | 3.3 | 10.3 |
| pdf-lib image + form | 4.31 | 2.27 | 0.84 | 2.7× | 10.7 | 7.0 | 10.4 |

Round 1's numbers were taken with both engines in one process and missed the font cache whenever the `fonts` object
was new, so they flatter the gain a little. What changed: per-document caches, an accumulation rasterizer for
non-zero fills, opaque pixels written whole, nearest-neighbour images stepped per pixel, and an IDCT that skips zero
rows. Warm is within 2× of pdf.js on 6 of 10 pages, 2.4–2.7× on the rest (vector, images, JPEG, pdf-lib image + form):
pdf.js composites with native Skia, this composites in JS. Cold is faster than pdf.js on 5 of 10 pages (text, form, cff,
both pdf-lib pages), level on vector, slower on table, images and the two JPEG pages (JIT warm-up and JPEG decoding).
