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
- TODO(daylight): the engine's typecheck (scripts/typecheck.mjs) does not cover packages/pdf; add it or a `tsc --noEmit`
  over packages/pdf with checkJs.
