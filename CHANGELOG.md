# Changelog

Older entries (1.0.0 and the betas) are in the README's [Changes](./README.md#changes) section.

## Unreleased

### Fixed

- PNGs embed on Deno 2.1 (Supabase Edge Functions, up to edge-runtime 1.77.8). Its `node:zlib` returns `crc32` as a
  signed number and ignores `inflateSync`'s `{ info: true }`, so every PNG was refused ("bad CRC in the IHDR chunk",
  then "truncated image data"). The CRC is read unsigned, and where `{ info: true }` is ignored fflate inflates.

## 1.1.1

### Fixed

- flatten and overlays keep existing page content when /Contents is an indirect array. `flatten()` and `page.draw()`
  on a loaded file spliced an indirect reference to a content array as if it were the array (`/Contents [7 0 R 0 0 9 0 R]`),
  dropping the page's own text (seen on Acrobat-filled forms). Every reader and writer of a page's /Contents (save,
  text extraction, the renderer) now resolves it through one helper: a stream, a direct array, an indirect array, or
  arrays nested through references, written back as one direct array.
- Text extraction handles very long right-to-left lines linearly.

## 1.1.0 — unreleased

New: an **experimental page renderer**, pure JS with no runtime dependencies. Everything here is additive; writing,
reading, signing and every existing export are unchanged. Details and pdf.js comparisons: [docs/RENDERER.md](./docs/RENDERER.md).

### Renderer (experimental)

- API: `renderPage(doc, i, opts)` (RGBA pixels), `toPng`, `drawToCanvas`, `renderToCanvas` (a browser canvas,
  OffscreenCanvas or @napi-rs/canvas; the canvas draws what it can, the renderer does the rest) and `renderPages`
  (pages of one file over worker threads on Node). Opt-in `wasm: true` runs the rasterizer's hot loops in a 2.7 KB
  SIMD WebAssembly kernel: 20-40% faster on vector- and text-heavy pages, byte-identical pixels, JS fallback.
- Coverage: paths, strokes (caps, joins, dashes) and clips; TrueType, CFF, Type 1 and Type 3 fonts; embedded CMaps
  with `usecmap`; vertical writing; text render modes 0-7; images (Flate, LZW, ASCII85/Hex, RunLength, and an own
  JPEG decoder: baseline and progressive, Gray/RGB/CMYK/YCCK), masks and soft-mask images; shadings types 1-7 and
  PostScript/sampled/exponential/stitching functions; tiling patterns; all 16 blend modes; transparency groups and
  soft masks; form XObjects, annotation appearances and form fields; page rotation and CropBox.
- Standard 14 fonts: draw with the new optional package `@reportwright/pdf-std-fonts` (Liberation Sans / Serif / Mono
  2.1.5, Noto Sans Symbols 2; SIL OFL 1.1), or any font you pass as `fonts: { default: ttf }`.
- Resource caps: per-page operator budget and time limit, device at most 16,384 px a side and 64 M pixels, bounded
  caches, font program, CMap, mesh and pattern limits; font and CMap parsing are linear and bounded. A broken font
  or image draws as nothing.
- `bulk` workers: they now run `renderPages` shares and hand pixel buffers back without copying; a font set sent to
  several workers is shared, not copied per call.

### Known gaps

JPX, JBIG2 and CCITT images; 12-bit and arithmetic JPEG; predefined CJK CMaps by name (not bundled); spot colours
(Separation / DeviceN draw as gray; Lab colour is not supported yet); non-isolated and knockout groups draw as
isolated; ICC profiles are not applied; no hinting.

### Packages

- `@reportwright/pdf-std-fonts` 0.1.0, first publish (MIT code, SIL OFL 1.1 fonts).
