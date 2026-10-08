# @reportwright/pdf — notes

## Decisions (phase 1)

- **Deflate.** Page content and fonts compress with Node's zlib on its thread pool when available (several pages at
  once, off the main thread), else `CompressionStream` (browsers), else fflate. The packed cross-reference blocks and the
  xref stream need synchronous zlib in every runtime, so **fflate is bundled** into `dist/index.js` at build time (MIT,
  credited in THIRD-PARTY-NOTICES.md). The source imports `fflate`; the built package has no runtime dependencies.
- **Font parsing without fontkit.** `src/fonts/truetype.js` reads cmap (formats 4, 12; 3/0 symbol fonts), head, hhea,
  hmtx, maxp, OS/2, post and name — all a PDF needs to embed a font and measure text. fontkit was not needed.
- **Subsetting.** Built in for TrueType: glyph IDs are kept (unused glyphs become empty), composite glyphs keep their
  components, and cmap, post and layout tables are dropped. `post` is dropped rather than cut to version 3 because
  veraPDF reports a version-3 post table's font as "not embedded" (found by bisecting tables). CFF fonts embed whole
  unless a subsetter function (HarfBuzz) is passed. A subsetter's output is re-parsed and must still hold every glyph ID
  drawn, else the whole font is embedded.
- **Coordinates.** Top-left origin, y down; `page.text`'s y is the top of the line box (baseline = y + ascent × size).
- **Standard fonts in PDF/A and PDF/UA** throw (they are not embedded). ReportWright draws them in embedded stand-ins;
  this library ships no fonts, so it says so instead.
- **.notdef.** A character an embedded font lacks draws the font's missing box, except in PDF/A and PDF/UA (which forbid
  it), where it is dropped; standard fonts drop characters outside their encoding. Either way `pdf.end()` warns.
- **File ID.** A 128-bit FNV-1a of the file's bytes (so the same input and date give the same bytes), unless `id` is given.
- **PDF/A level.** Always PDF/A-2**b** (even when tagged): 2a needs more checks than phase 1 makes.
- **Sinks.** `pdf.end()` ends a Node stream and closes a WritableStream. On a failure (or abort/timeout) a
  WritableStream is aborted (otherwise it stays locked); a Node stream is left to its owner.

## Feature groups for the parallel agents (phase 2/3)

Each group adds new files in its folder and wires in at the extension points of ARCHITECTURE.md.

| Group | Scope | Folder | Extension points |
|---|---|---|---|
| **A graphics** | paths (move/line/curve/close), ellipses, rounded rects, clipping, transforms (`page.save/restore/transform`), opacity, blend modes, gradients (axial/radial shadings), tiling patterns | `graphics/` | `install()`, `page.content` (`op`, `q`/`Q`), `doc.resource('ExtGState'|'Shading'|'Pattern')`; PDF/A: transparency needs a page `/Group` (`page.entries`) |
| **B colour and images** | CMYK, spot (Separation), ICC-based colours; JPEG (DCT passthrough), PNG (Flate + predictors, alpha → SMask), image XObjects, `page.image()` | `graphics/color.js` (extend `colorOp`), `images/` | `doc.resource('ColorSpace'|'XObject')`, `doc.object()` for XObjects written once, `install({ image })` |
| **C text** | OpenType/CFF subsetting, kerning (`TJ`), character/word spacing, render modes, rise, a HarfBuzz shaping hook (glyph runs by ID with ToUnicode/ActualText, as ReportWright's drawRun), wrap and align helpers, multi-line text boxes | `text/`, `fonts/` | `install()`, `page.content.text` (add a `TJ` variant), `Font.encode` / a glyph-ID encode on embedded fonts, the `subset` option |
| **D navigation and annotations** | named destinations, page labels, text/highlight/square/stamp annotations, file attachment annotations, link styles, GoTo/Launch/named actions | `nav/`, `annotations/` | `page.annotate()`, `doc.catalog('Names'|'PageLabels'|'Dests')`, `doc.onFinish()`; tagged: `doc.tags` (Annot elements) |
| **E AcroForm fields** | text, checkbox, radio, choice, push-button and signature fields, appearance streams, flatten | `forms/` | `page.annotate()` (widgets), `doc.onFinish()` + `doc.catalog('AcroForm')`, `doc.resource('Font')` for DA fonts |
| **F encryption and signing** | RC4-free AES-128 / AES-256 (R6) standard security handler, permissions; PAdES-B (detached CMS, ByteRange placeholder), timestamps | `security/` | `options.encrypt` (the `Encryptor` hook in core/objects.js), `doc.catalog`, `page.annotate()` (signature widget); signing needs a ByteRange patch over the finished file (a sink wrapper, or toBytes then patch) |
| **G standards** | PDF/A-1b (no object/xref streams: needs a classic xref writer variant), PDF/A-2u/3b, embedded files (`/AF`), ZUGFeRD/Factur-X (XML attachment + XMP extension schema), layers (OCG, `OCProperties`), page boxes (Crop/Bleed/Trim/Art), rotation | `standards/`, `nav/` | `doc.catalog('Names'|'AF'|'OCProperties')`, `page.entries` (`Rotate`, `CropBox`…), `xmpPacket` (extend), `doc.resource('Properties')` for OCG marked content |
| **H reading and modifying** (later) | parse an existing PDF (xref tables and streams, object streams), incremental updates, merge/split, fill forms | new `reader/` | separate from the writer; reuses core/serialize.js and core/deflate.js |

## Group A (graphics): done

- Files: `graphics/path.js` (Path builder; arcs → ≤ 90° cubics), `graphics/svg.js` (SVG path data: one pass, no regex, no
  recursion, 10 MB cap), `graphics/draw.js` (fill/stroke/clip/shade, stroke styles, ExtGState, transforms,
  save/restore, figure), `graphics/paint.js` (gradients: Type 2 / Type 3 stitching functions; Type 2 shading patterns;
  tiling patterns), `core/brand.js` (handles). Shared files touched: `page.js` (two imports, one `install` line), and for
  the branded-handle security fix `text/text.js`, `nav/links.js`, `nav/outline.js`, `fonts/standard.js`,
  `fonts/embed.js`.
- **Transforms.** A top-left transform T is written as the PDF matrix F·T·F (F the page flip), so the other modules'
  operators (which convert y themselves) follow it and text is not mirrored. The accumulated T is tracked per page
  because pattern space ignores the CTM: each gradient / tiling pattern use carries it in its `/Matrix` (one Pattern
  resource per distinct matrix; one tiling stream per pattern and matrix, written with the page that first uses it).
- **Matrix precision.** `cm` and pattern matrices are written to 6 decimals by `num6` (draw.js), which first calls
  `num()` to reject NaN/Infinity/≥1e9; 3 decimals visibly skew rotations over a page. Everything else uses `num()`.
- **Styles are per call** (unspecified = default), tracked in `content.st` (new keys cap/join/ml), so no draw leaks a
  style into the next and nothing is set twice.
- **Opacity** wraps the draw in q/Q with its ExtGState (so it does not leak); one ExtGState per distinct value in the
  document (`doc.resource` dedupes). Transparency sets the page `/Group << /S /Transparency /CS /DeviceRGB >>` — on
  every page that uses it (PDF/A-2 needs it only without an output intent; harmless otherwise).
- **save/restore depth**: 1000, or 27 in PDF/A (ISO 19005-2 limits q nesting to 28; the opacity q/Q is the 28th).
- **Tagged**: graphics outside a tag are already artifacts (the marker in content.js); `page.figure` is `page.tag('Figure')`
  with alt required. veraPDF UA-1 and A-2b: 0 failed rules on a page with gradients, opacity, a blend mode, a clip, a
  tiling pattern, a shading and an SVG arc. Pattern cells carry no marked content.
- **Tiling cells** are drawn at definition on a `Page` built on a stand-in doc that records the resources the cell uses
  (for the pattern's own `/Resources`); text, links, annotations and `end` throw there (fonts register their resource
  outside that recorder).
- **Security**: handles (gradients, patterns, fonts, pages) are branded in a module-private WeakMap with their document
  and private data (core/brand.js); paint/font/link/outline positions look the handle up there, never trusting its
  own properties, so a forged `{ type: 'gradient', dict: '… /JavaScript …' }`, a copy, or another PDF's handle throws.
  Fonts are frozen. Caps: 1,000,000 path segments, 10 MB SVG strings, 100 dash lengths (not all 0), 256 gradient stops.
- Bench (2026-10-09, node 20.20, Apple Silicon, median of 10): 1,000 vector shapes — @reportwright/pdf 45,903 bytes,
  11.4 ms warm, 63 ms cold; pdf-lib 1.17.1 22,273 bytes, 21.9 ms warm, 133 ms cold. Twice as fast, twice as big:
  absolute page coordinates never repeat, so deflate found nothing to share.
- **Local coordinates (size fix).** A path of 3+ segments is now written relative to its first point inside
  `q 1 0 0 1 x y cm … Q` (the colour and stroke style are set before the `q`, so they outlive it and are not repeated;
  with an opacity ExtGState the `cm` goes in that draw's existing `q`, keeping PDF/A's nesting limit). The same shape
  anywhere on the page then has the same operators, which deflate to a back-reference. 1,000 shapes: 45,903 → 8,353
  bytes (pdf-lib: 22,273); content stream 44,164 → ~6,600 bytes. Pixel check (pdftoppm, no anti-aliasing): the bench
  page differs in 59 of 501,832 pixels at 72 dpi, every one on a shape's edge (coordinates exactly on a pixel boundary
  round 0.001 pt differently); a page of transformed gradients, patterns, opacity, clips, dashes and blend modes is
  pixel-identical at 144 dpi. Clips stay absolute (a `Q` would drop them); lines and 2-segment paths stay absolute.

## TODO(daylight)

- TODO(daylight): switch ReportWright's own streaming exporter (src/exporters/pdfstream.js) to this package's core, once
  group C lands shaped glyph runs and group A lands clipping and curves (the engine draws both). Not done: unattended
  work is additive only.
- TODO(daylight): decide the publish name/version cadence (this package has its own version, 0.1.0, unlike the others,
  which follow the repo's version) and add it to scripts/scan-packages.mjs and the release checklist.
- TODO(daylight): `.gitignore` ignores `packages/*/package.json` and `packages/*/LICENSE` (generated for the other
  packages); this package's are hand-written and were force-added. Either unignore `packages/pdf/` or generate them in
  build-packages.mjs.
- TODO(daylight): run the browser path (CompressionStream, WritableStream sink) in a real browser test (Playwright);
  phase 1 tests Node, with the WritableStream sink exercised under Node's web streams.
- TODO(daylight): the repo's typecheck (scripts/typecheck.mjs) does not cover packages/pdf. It is clean today with
  `node node_modules/typescript/bin/tsc --noEmit --allowJs --checkJs --skipLibCheck --target es2022 --module esnext
  --moduleResolution bundler --lib es2023,dom --types node packages/pdf/src/index.js`; wire that into CI.
- TODO(daylight): qpdf is not installed on this laptop, so `qpdf --check` never ran (the hostile-font test runs it when
  present). Structure was checked with pdf-lib (an independent parser), poppler and veraPDF instead. `brew install qpdf`.
- TODO(daylight): PDFKit is not in node_modules, so bench/compare.mjs measured pdf-lib only. Run it where PDFKit is
  installed (outside this repo) for the full comparison.

## Measurements (2026-10-09, Node 20.20, Apple Silicon laptop)

- bench/compare.mjs, standard fonts, median of 10:
  | case | library | bytes | warm ms | cold ms (new process) |
  |---|---|---|---|---|
  | 1-page invoice | @reportwright/pdf | 2,823 | 1.0 | 43 |
  | 1-page invoice | pdf-lib 1.17.1 | 2,775 | 3.7 | 96 |
  | 1,000-page text | @reportwright/pdf | 461,320 | 134 | 203 |
  | 1,000-page text | pdf-lib 1.17.1 | 1,421,783 | 918 | 1,119 |
- Memory (tests/pdf/memory-child.mjs, 30 text lines + 30 rules + a link per page, after GC): heap 4.5 MB at 1,000
  pages, 5.0 MB at 20,000 pages; array buffers 0.4 → 0.75 MB; a 15 MB file written in about 1.6 s.
- `npm pack --dry-run`: 39.7 kB tarball, 153 kB unpacked (dist/index.js 138 kB unminified, of which the AFM width
  tables are most).
