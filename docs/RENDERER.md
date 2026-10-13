# Renderer (experimental)

Page → pixels in pure JS, no runtime dependencies (zlib for PNG comes from the bundled fflate).

```js
import { loadPdf, renderPage, toPng, drawToCanvas } from '@reportwright/pdf';
const doc = await loadPdf(bytes);
const page = renderPage(doc, 0, { scale: 2 }); // { width, height, data: Uint8ClampedArray RGBA }
await toPng(page);                             // PNG bytes
drawToCanvas(ctx, page);                       // browsers: putImageData on a 2D context
```

Options: `scale` (pixels per point, 1 = 72 dpi), `fonts` (substitutes for the standard 14: `{ Helvetica: ttf, default: ttf }`),
`background` (RGBA, white), `annotations` (draw appearance streams, true), `timeoutMs` (60 s).

## How it works

| part | file | reuses |
|---|---|---|
| content interpreter (graphics state, text state, forms, annotations) | `src/render/render.js` | the reader's lexer, `decodeStream` and filters, budget, `pageAt`, `skipInline`, `glyphText`, standard metrics |
| rasterizer: polygons → anti-aliased coverage (4 sub-scanlines, exact horizontal coverage; non-zero and even-odd), stroker (width, caps, joins, miter limit, dashes), curve flattening | `src/render/raster.js` | — |
| glyph outlines: TrueType `glyf` (simple + composite), CFF Type 2 charstrings | `src/render/glyphs.js` | `sfntTables`, `parseFont`, `parseCff` (its checked INDEXes, FDSelect, charset) |
| PNG encoder, canvas helper | `src/render/png.js` | fflate (bundled) |

Everything runs under the document's budget (each operator a step) and a time limit; forms nest at most 16 deep and never
re-enter themselves; the device is at most 16,384 px a side and 64 M pixels. A broken font or image draws as nothing.

## Phase 1 (this PR)

- Paths: `m l c v y h re`, fill non-zero / even-odd, stroke (width — at least one device pixel, as pdf.js —, butt / round /
  square caps, miter / round / bevel joins, miter limit, dash arrays and phase), `B b B* b*`, clipping `W W*`, `cm`, `q Q`.
- Colour: DeviceGray / RGB / CMYK (naive CMYK → RGB, no ICC), ICCBased (by its `N`), CalRGB / CalGray, Indexed; constant
  opacity `ca` / `CA` from ExtGState; LW / LC / LJ / ML / D / Font from ExtGState.
- Text: every positioning and state operator, render modes 0–3 (4–7 drawn as 0–2, no clip), Type0 Identity-H (Identity-V advanced horizontally, phase 2) with
  CIDFontType2 (TrueType, CIDToGIDMap) and CIDFontType0 (CFF, bare or OpenType), simple TrueType fonts (Encoding,
  Differences, symbolic cmaps).
- Standard 14 fonts: the file has no outlines and the library ships metrics only, so they draw **only with a substitute**
  passed in `fonts` (any TrueType/OpenType, e.g. Inter for Helvetica), advanced by the PDF's widths; without one the
  text is not drawn. Symbol and ZapfDingbats are never substituted.
- Images: XObjects and inline images; Flate / LZW / ASCII85 / ASCIIHex / RunLength / raw; 1–16 bits; Gray / RGB / CMYK /
  Indexed; `/Decode`; stencil masks (`ImageMask`) in the fill colour; `/SMask` soft masks; single-component colour-key
  `/Mask`; nearest-neighbour unless `/Interpolate` (as pdf.js).
- Form XObjects (Matrix, BBox clip, own Resources) and annotation appearance streams (`/AP /N`, `/AS` state, Matrix →
  Rect mapping; Hidden / NoView / Popup skipped) — form fields render.
- Page rotation (`/Rotate`, `page.rotate()`), CropBox.

## Phase 2 (not drawn yet)

Shadings (`sh`, shading patterns) and tiling patterns; transparency groups, soft masks in ExtGState, blend modes; Type 3
and Type 1 (`FontFile`) fonts and bare CFF simple fonts (`FontFile3 /Type1C`); non-Identity CMaps; DCT (no JPEG decoder in
the library yet), JPX, JBIG2, CCITT images; Separation / DeviceN through their tint transforms (drawn as gray now); Lab;
text render-mode clipping; colour-key masks with more than one component; box-filtered image downscaling; hinting; CFF
`seac` accents; a CFF FontMatrix other than 1/1000; performance (see below).

## Against pdf.js

`tests/render.test.js` renders each fixture page at scale 2 with both (pdf.js via `pdfjs-dist` + `@napi-rs/canvas`, dev
dependencies only, annotations drawn on canvas) and counts the pixels whose channels differ by more than 48 levels.

| page | differing pixels (all) | differing inked pixels |
|---|---|---|
| ours: text (Inter, TrueType) | 0.01% | 0.19% |
| ours: table (rules + text) | 0.00% | 0.01% |
| ours: vector (fills, even-odd, caps, joins, dash, CMYK, opacity) | 0.00% | 0.01% |
| ours: images (RGB, RGBA soft mask, gray) | 0.00% | 0.00% |
| ours: form (text field, checkboxes) | 0.00% | 0.25% |
| ours: CFF font (Noto Sans SC) + `/Rotate 90` + clipping | 0.00% | 0.01% |
| pdf-lib: vector + standard Helvetica | 0.73% | 3.05% (the text: Inter substitute vs pdf.js's Foxit Sans) |
| pdf-lib: RGBA image + form widgets | 0.48% | 1.19% (the field's Helvetica, same reason) |

Speed (Apple Silicon, Node 20, 600 × 440 px pages, same process): rendering the same page again takes 3–7 ms here
against 0.6–1.5 ms for pdf.js — pdf.js keeps the page's parsed operator list between renders and rasterizes natively
(Skia); this renderer re-reads the content each time in JS. First render of a freshly loaded document: 6–38 ms here,
3–165 ms pdf.js (font loading dominates both). Phase 2: cache parsed fonts/content per document, cut allocations in the
rasterizer's active-edge loop.
