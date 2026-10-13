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
| document caches | 1,024 fonts, 32 M glyph numbers, 256 MB decoded images, 64 MB content, 4 font sets; 4,096 shadings / 16 M shading numbers; 64 MB tiling cells | that cache emptied |
| functions | sampled table ≤ 1 M values (checked before reading); ≤ 1,024 functions in one, 8 deep, no self-reference; calculator ≤ 65,536 tokens, stack ≤ 100, no loops, charged for every operator it runs; a sampled lookup charged for its 2^m corners; every evaluation a budget step | shading skipped |
| meshes | ≤ 1 M vertices (from the data length, before reading), ≤ 100,000 patches, ≤ 500,000 triangles (patch grids 3–20 a side, shrunk to fit), each triangle's pixels charged before drawing; a mesh is drawn once per shading and transform, its layer counted in the 1 GB mask budget (one budget for a page and every tiling cell drawn for it) | shading skipped / E_BUDGET |
| pattern paints | a budget step per painted pixel (a pattern costs more than a colour), across every fill, stroke, string and `sh` | E_BUDGET / E_TIMEOUT |
| transparency | layers (groups, soft masks, blended objects) ≤ 8 open at once, deeper ones not drawn; one scratch layer per depth and each soft mask's bytes counted in the page's 1 GB mask allowance (shared with clips, meshes and tiling cells); compositing a step a pixel and a soft mask a step a pixel, before the work; a soft mask's form is a form draw (form caps, no re-entry) | not drawn / E_BUDGET |
| tiling | one period drawn as a cell ≤ 1 M pixels (cost per painted pixel whatever XStep: a tiny step over a huge area draws one small cell); ≤ 9 × 9 copies of the content per cell; patterns inside patterns ≤ 8 deep, never re-entered | pattern not drawn |

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
- Shadings, by `sh` and as shading patterns (PatternType 2) for fill, stroke and text: function-based (1), axial (2),
  radial (3, both circles, Extend, the cone when one circle lies outside the other), free-form and lattice Gouraud
  meshes (4, 5, with or without a Function), Coons and tensor-product patches (6, 7, shared edges). Functions: sampled
  (0, multilinear), exponential (2), stitching (3), PostScript calculator (4). BBox clips; a pattern's Background
  fills where the shading does not reach; `sh` covers the clip (or the mesh) only. Axial and radial colours come from
  a 1,024-entry table of their function; meshes interpolate RGB between their corners, as pdf.js does. AntiAlias is
  ignored (edges inside a mesh are not anti-aliased, as in pdf.js).
- Tiling patterns (PatternType 1): coloured and uncoloured (`[/Pattern /DeviceRGB] cs r g b /P scn`), XStep / YStep,
  BBox larger or smaller than the step, the pattern matrix (rotation, skew), as fill, stroke and text fill.

- Transparency: all 16 blend modes (`/BM`, a name or an array; separable ones from a 256 × 256 table, Hue /
  Saturation / Color / Luminosity by the spec's formulas), with `ca` / `CA`; transparency groups (form XObject
  `/Group /S /Transparency`), composited as one object with the fill alpha, blend mode and soft mask in force, their
  own blend mode, soft mask and alphas starting over inside; soft masks in ExtGState (`/SMask`): Luminosity (with
  `/BC`, in the group's `/CS`) and Alpha, `/TR` transfer functions, `/SMask /None`. Each object under a blend mode
  or soft mask is drawn into a layer and composited over the pixels it drew; plain Normal drawing takes no layer.
  As pdf.js does, groups draw as isolated and knockout is ignored (non-isolated and knockout groups look as isolated
  ones); a group's `/CS` other than the mask backdrop's is ignored (blending is in RGB); a page `/Group` changes
  nothing (the page is opaque white).

## Phase 2 (not drawn yet)

Non-isolated and knockout transparency groups (drawn as isolated); Type 3
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

Shadings and patterns (`tests/shading.test.js`, fixtures in `tests/shading-fixtures.js`, `stdFonts` for the text):

| page | differing pixels (all) | differing inked pixels |
|---|---|---|
| `sh` axial: stitching of exponentials, extended; sampled (Type 0) function | 0.00% | 0.00% |
| `sh` radial: from a point, offset circles extended, a cone | 0.00% | 0.00% |
| Type 4 free-form mesh (flags 0, 1, 2) | 0.46% | 0.85% |
| Type 5 lattice with a Function | 0.42% | 0.59% |
| Type 6 Coons patches (a shared edge) | 0.80% | 1.37% |
| Type 7 tensor-product patches | 0.82% | 1.41% |
| shading patterns as fill, stroke and text fill (pattern matrix) | 0.00% | 0.00% |
| tiling: coloured rotated checker, uncoloured dots as fill, stroke and text | 0.89% | 2.46% |
| report chart from our library: gradient bars, hatched bar, radial dot, text | 0.06% | 0.25% |

Meshes differ along their outlines (neither anti-aliases them; pixel centres fall a pixel apart); tiling along the
cell edges (both resample a cell bitmap). ShadingType 1 is checked by its colours instead: pdf.js does not draw it
(it paints a placeholder).

Transparency (`tests/transparency.test.js`, fixtures in `tests/transparency-fixtures.js`, hand-built), pixels whose
colour differs by more than 8 of 255:

| page | differing inked pixels |
|---|---|
| 16 blend modes over coloured stripes | 0.00% |
| the same at `ca` 0.6 | 0.00% |
| the same inside a transparency group over a card | 0.00% |
| groups at alpha 0.5 (isolated, non-isolated, knockout, /CS), a group blended Multiply | 0.00% |
| Alpha soft mask (an opaque and a 0.4 shape), `/SMask /None` | 0.00% |
| page `/Group` with a Screen object at 0.5 | 0.00% |
| designer card: gradient, soft drop shadow (Alpha mask), multiply band, translucent circles, Screen circle | 0.07% |

Luminosity soft masks are checked by value instead: pdf.js under Node does not apply them (it masks through a canvas
filter that Node's canvas lacks), so its page shows the shapes unmasked.

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

Shading pages (same setup, `fonts: stdFonts`), ms:

| page | warm | pdf.js warm | cold | pdf.js cold |
|---|---|---|---|---|
| sh axial | 2.0 | 1.1 | 18.2 | 42.5 |
| sh radial | 3.5 | 1.8 | 16.4 | 4.2 |
| mesh 4 | 3.6 | 11.9 | 18.3 | 21.1 |
| mesh 5 | 4.4 | 12.5 | 4.9 | 13.9 |
| patch 6 | 5.3 | 14.0 | 7.3 | 18.9 |
| patch 7 | 5.0 | 13.9 | 6.6 | 17.1 |
| pattern-shading | 1.2 | 2.6 | 13.7 | 22.5 |
| tiling | 8.8 | 5.1 | 16.5 | 13.3 |
| chart | 1.4 | 3.7 | 6.1 | 31.1 |

Axial and radial shadings are drawn a row at a time: the position along the gradient advances by one add per pixel
(radial: the quadratic's terms by one add each, one square root per pixel), each pixel reads the shading's 1,024-entry
colour table, and whole pixels are written as one 32-bit store; a whole-pixel rectangle (a rectangular clip, or `sh`
over one) is covered without rasterizing. Warm: axial 1.8×, radial 1.9×, tiling 1.7× pdf.js; meshes, shading patterns
and the chart faster. Cold, radial is 3.9× (JIT warm-up of the first render).

Transparency pages (same setup), ms. Plain Normal drawing is unchanged (the other pages measured before and after
this change agree within noise). A fill of one colour under a blend mode or soft mask is composited as it is
rasterized (no layer); groups and patterned or image objects draw into a layer, composited only over the pixels it
covered; a group over a still-empty layer draws in place. Soft masks are made once a page per form and transform
(a /TR reuses its form's reading), read only where their form drew; a clip of the whole page makes no mask.

| page | warm | pdf.js warm | cold | pdf.js cold |
|---|---|---|---|---|
| blend modes | 1.4 | 1.3 | 36.6 | 41.8 |
| blend at ca 0.6 | 1.4 | 1.2 | 7.6 | 3.0 |
| blend in a group | 2.3 | 1.4 | 4.7 | 3.9 |
| groups | 2.0 | 1.3 | 9.0 | 3.1 |
| Luminosity masks (pdf.js: not applied) | 4.5 | 2.8 | 18.7 | 7.3 |
| Alpha mask | 2.1 | 1.4 | 6.0 | 2.7 |
| page group | 1.0 | 0.9 | 1.1 | 2.1 |
| designer | 4.2 | 2.3 | 16.0 | 4.6 |

Within 2× of pdf.js warm. The rasterizer accumulates exact signed area per cell (even-odd folds the winding),
scans only the cells edges touched and hands on only covered spans; axis-aligned rectangles skip accumulation;
whole opaque runs, flat-backdrop runs and upright opaque image rows are written as native word fills / copies.

## Canvas output

`renderToCanvas(doc, i, ctx, { scale, createCanvas, Path2D, ImageData })` draws a page onto a
CanvasRenderingContext2D (a browser canvas, OffscreenCanvas, or @napi-rs/canvas in Node), resized to the page. The
canvas draws: fills and strokes (as paths in user space, curves as curves, with the stroke's width, caps, joins,
miter limit and dash), glyph outlines (a Path2D per glyph, kept), images (a surface per image), axial shadings and
radial ones extended at both ends (its own gradients, 256 stops from the shading's table), the 16 blend modes
(globalCompositeOperation), transparency groups (an offscreen canvas per depth, only the part drawn composited) and
soft masks (their mask made here, applied as alpha with destination-in). Everything else (other shadings, patterns,
stencil images, clips not made from paths) is drawn by this renderer into a copy of the canvas's pixels, read before
and written back after. The caps are those of renderPage: canvas draws are charged as the rasterizer charges them,
before they are drawn; offscreen canvases, mask canvases and image surfaces count in the page's mask allowance.

Glyph coverage (renderPage) is cached per document: per glyph, transform and subpixel offset (x to 1/16 pixel, y to
1/64), at most 8,192 bitmaps and 16 MB, a glyph over 256 pixels a side drawn as polygons; each drawn glyph is still
charged for its rows.

## WASM kernel

`src/render/kernel.wat` is a hand-written WebAssembly module (about 2.3 KB, shipped inlined as base64 in
`src/render/kernel.js`, built by `node scripts/build-kernel.mjs` with the `wabt` dev dependency). It does the
rasterizer's hot loops: a band's edge areas accumulated into cells, a row's cells swept into coverage spans (interior
runs stored four at a time with 128-bit SIMD), and one colour composited through coverage and a clip mask (whole-pixel
runs stored with SIMD). It uses the same IEEE operations in the same order as the JS, so pixels are byte-identical with
`wasm: false` (tested on every fixture and on random hostile polygons). JS keeps parsing, interpretation, paths and every
cap: offsets and lengths are checked before each call, and memory growth is charged before it happens.

While a page renders, its pixels (and its first clip masks, up to 32 MB) live in kernel memory and are copied out at
the end; memory never grows during a render (fills too large for the room left use JS). The memory is kept between
renders: 24 MB of scratch plus the largest page held (at most 128 MB). Without WebAssembly SIMD the JS path is used.

