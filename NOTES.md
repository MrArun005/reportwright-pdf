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
  veraPDF reports a version-3 post table's font as "not embedded" (found by bisecting tables). CFF: see group C. A subsetter's output is re-parsed and must still hold every glyph ID
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
| **B colour and images** (done) | CMYK, spot (Separation), ICC-based colours; JPEG (DCT passthrough), PNG (Flate + predictors, alpha → SMask), image XObjects, `page.image()` | `graphics/color.js` (extend `colorOp`), `images/` | `doc.resource('ColorSpace'|'XObject')`, `doc.object()` for XObjects written once, `install({ image })` |
| **C text** (done) | OpenType/CFF subsetting, kerning (`TJ`), character/word spacing, render modes, rise, a HarfBuzz shaping hook (glyph runs by ID with ToUnicode/ActualText, as ReportWright's drawRun), wrap and align helpers, multi-line text boxes | `text/`, `fonts/` | `install()`, `page.content.text` (add a `TJ` variant), `Font.encode` / a glyph-ID encode on embedded fonts, the `subset` option |
| **D navigation and annotations** (done) | named destinations, page labels, text/highlight/square/stamp annotations, file attachment annotations, link styles, GoTo/Launch/named actions | `nav/`, `annotations/` | `page.annotate()`, `doc.catalog('Names'|'PageLabels'|'Dests')`, `doc.onFinish()`; tagged: `doc.tags` (Annot elements) |
| **E AcroForm fields** (done) | text, checkbox, radio, choice, push-button and signature fields, appearance streams, flatten | `forms/` | `page.annotate()` (widgets), `doc.onFinish()` + `doc.catalog('AcroForm')`, `doc.resource('Font')` for DA fonts |
| **F encryption and signing** (done) | RC4-free AES-128 / AES-256 (R6) standard security handler, permissions; PAdES-B (detached CMS, ByteRange placeholder), timestamps | `security/` | `options.encrypt` (the `Encryptor` hook in core/objects.js), `doc.catalog`, `page.annotate()` (signature widget); signing needs a ByteRange patch over the finished file (a sink wrapper, or toBytes then patch) |
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

## Group B (colour and images): done

- Files: `graphics/color.js` (rewritten around `resolve(c, doc)` → `{ cs, comps }`: gray, RGB incl. CSS `rgb()`, CMYK
  via `cmyk()` or 4-arrays, spot colours, ICC colours), `standards/icc.js` (ICC header check), `images/png.js`,
  `images/jpeg.js`, `images/image.js`. Shared files touched: `index.js` (`cmyk` export; `embedImage`, `spotColor`,
  `iccColorSpace`; the `pdfa` option passed to the output intent; those three refuse after `pdf.end()`), `page.js`
  (one `install`), `standards/pdfa.js` (a caller's output intent), `graphics/paint.js` (gradients in any one colour
  space), `graphics/draw.js` (`gstate` exported; the transparency group's `/CS` follows a CMYK intent),
  `graphics/shapes.js` and `text/text.js` (pass the page's doc to `colorOp`).
- **Spot colours**: `[/Separation /Name <alternate> <Type 2 function from white to the alternate>]`, one per name per
  document (a second definition with another alternate throws: PDF/A 6.2.4.4 wants one). The name goes through
  `pdfName`, which escapes as `#xx` (see "Names" under group C), so `PANTONE 185 C` is `/PANTONE#20185#20C`.
- **ICC**: the profile is checked (size field = bytes given, `acsp`, version 2–4, GRAY/RGB/CMYK, tag table and tags
  inside the profile) and written once; `/N` comes from its colour space. All-gray gradients are now DeviceGray (were
  DeviceRGB; they render the same).
- **PDF/A colour rule** (ISO 19005-2 6.2.4.3, checked with veraPDF): DeviceCMYK needs a CMYK output intent, DeviceRGB
  an RGB one; with the sRGB intent veraPDF fails `6.2.4.3-3` on a CMYK fill (tried by forcing one through), so it is
  refused up front with an error naming the fix. `pdfa: { outputIntent: bytes }` takes an RGB or CMYK profile of class
  prtr or mntr. Both cases pass veraPDF A-2b with 0 failed rules (the CMYK one with macOS's Generic CMYK Profile).
- **JPEG**: never re-encoded (the file is the DCTDecode stream). Markers are walked to SOS with every length checked;
  SOF0–2 only, 8-bit, 1/3/4 components. 4 components with an Adobe APP14 segment get `/Decode [1 0 1 0 1 0 1 0]`
  (Photoshop and libjpeg write CMYK inverted; pdf.js and PDFKit do the same). EXIF orientation 1–8 is honoured by
  turning the unit square in the image's `cm`; the handle's width/height are the upright size.
- **PNG**: non-interlaced gray/RGB/palette without alpha pass the IDAT through (Predictor 15), after one counting-only
  inflate that checks the data really is that size. Everything else is decoded, split into colour + SMask, filtered
  again (None/Sub/Up/Paeth per row by the smallest sum) and deflated; small images (≤ 256 KB) are also deflated
  unfiltered and the smaller kept (icons: −25 %). Palettes are padded to 2^depth entries so a bad index cannot fall
  outside. 16-bit colour keys become an SMask: poppler ignores 16-bit `/Mask` ranges (found by a pixel test).
- **Hostile input**: chunk lengths against the file, CRCs, IHDR combinations, each side ≤ 65,535 and ≤ 100 MP, the
  inflated size computed from the header and enforced in the inflater's output callback with input pushed 8 KB at a
  time (so a bomb stops within ~8 MB), 400 MB decoded at most, 256 MB of file; JPEG marker lengths, SOF length vs
  components, EXIF reads bounded by its segment; ICC sizes. No recursion. tests/pdf/hostile-images.test.js: each case
  throws in < 1 s with < 64 MB growth.
- **Writes outside pages** (images, ICC streams) go through `doc.serial`: the object writer is not re-entrant (a write
  awaiting the sink while another starts would interleave bytes and offsets).
- **Inline images: never.** Every image is an XObject, so one drawn 100 times is written once, and it can carry an
  SMask (inline images cannot).
- Tagged: `page.image(img, { alt })` is a Figure with /Alt; without alt it is an artifact. veraPDF UA-1 and A-2b:
  0 failed rules on a tagged PDF/A page with RGBA, interlaced palette + tRNS and 16-bit PNGs, a progressive JPEG in an
  ICCBased space, an ICC fill and opacity.
- Not done (optional / later): image masks (stencils); embedded ICC profiles of PNG (iCCP) and JPEG (APP2) files are
  ignored (the image is drawn in the device space unless `colorSpace` is given); PNG eXIf orientation.

## Group C (text): done

- Files: `fonts/cff.js`, `fonts/kern.js`, `text/runs.js`, `text/box.js`, `examples/harfbuzz-shaper.mjs`. Shared files
  touched: `fonts/embed.js` and `fonts/standard.js` (a `FontImpl` as brand data, `widthOfText`, `lineHeight`; CFF
  subsetting and kerning in embed), `fonts/truetype.js` (`lineGap`), `fonts/subset.js` (`buildSfnt` takes the sfnt
  version, for `OTTO`; a Buffer bug, below), `content/content.js` (`run` with the text state; `text` goes through it),
  `text/text.js` (rewritten around runs), `page.js` (one `install`), `core/serialize.js` (names, below),
  `graphics/color.js` (a spot handle's `name` is the name as given).
- **Names (fix first).** `pdfName` now writes PDF 1.7 §7.3.5 names: UTF-8 bytes, each outside 0x21–0x7E and each of
  `( ) < > [ ] { } / % #` as `#XX` (upper-case hex: pdf-lib decodes only that), NUL dropped, at most 127 bytes cut
  between characters, a fallback when empty. `PANTONE 185 C` is `/PANTONE#20185#20C` and pdf-lib reads it back as
  `PANTONE 185 C`. No delimiter or white space survives, so it stays injection-safe. Fonts use `fontName`, the old
  PostScript-name rule (`[A-Za-z0-9_.+-]`, ≤ 63), because BaseFont must be a valid PostScript name.
- **Bug found and fixed (pre-existing):** the glyf subsetter changed `head` through `head.slice()`, which for a Node
  Buffer is a view, so `embedFont(fs.readFileSync(...))` wrote into the caller's font bytes (at offset 50 of the
  file's ArrayBuffer). Copies are now `new Uint8Array(...)`; a test checks the caller's Buffer is unchanged.
- **CFF.** Embedded as `FontFile3 /Subtype /OpenType` under a CIDFontType0, Identity-H, ToUnicode. Subsetting is
  built in and keeps glyph IDs: unused glyphs' charstrings become `endchar`, used ones and all subroutines are kept
  (no desubroutinising), and the new CharStrings INDEX is written in place with the rest zeroed, so no other offset
  moves and Flate removes the zeros (STIX General, 3,302 glyphs: whole: a 258 KB PDF, subset to one line of text: 61 KB; the
  subroutines are most of what is left). A used glyph that is a `seac` accent (deprecated in OpenType) makes the font
  embed whole. Layout tables, cmap and post are dropped. **CID-keyed CFF** (Noto Sans SC): poppler draws an
  OpenType/CFF CIDFont by glyph ID, ignoring the CFF charset that the spec says maps CIDs (found by pixels: CIDs drew
  blanks, glyph IDs drew the glyphs), so the charset is rewritten in place to the identity (format 0, or one range of
  format 1 or 2, never longer than the original) and glyphs are drawn by ID; then every reader agrees. The HarfBuzz
  subsetter hook works for CFF too (its output's maxp may keep the old count: the CharStrings count is used).
- **CFF hostile input**: INDEX counts, offset sizes and offsets (start at 1, never back, end inside the table), DICT
  operands ≤ 48 and inside their DICT, FDSelect / charset ranges, charstrings ≤ 65,535 bytes, operand stack ≤ 48,
  subroutine nesting ≤ 10 by an explicit stack, 1,000,000 charstring bytes walked per glyph. Lying INDEX counts throw
  at `embedFont`; charstring problems at `pdf.end()` (when used glyphs are scanned for the subset).
- **Kerning.** GPOS lookups of every `kern` feature (any script), type 2 formats 1 and 2 and type 9 extensions (one
  level), the first glyph's XAdvance; summed over lookups, first matching subtable in each. Else the `kern` table
  (version 0, format 0 horizontal subtables, sized by nPairs because the 16-bit length is wrong in big fonts). Checked
  at embed time (counts, offsets, arrays against the table; subtables de-duplicated, ≤ 4,096; a 4,000,000-step check
  budget); a broken source is dropped with a warning, the font still embeds. Pairs memoised (≤ 65,536). Checked
  against HarfBuzz: Inter, Arial, STIX, SF Pro give the same advances on "AVATAR To Yo WAVE Ta. LT"; Times New Roman
  (kern table only) differs because the harfbuzzjs build does not apply legacy kern tables. Standard fonts: not
  kerned (the generated AFM metrics carry no KPX pairs, and the generator is outside this package).
- **Runs.** A run is one string (`(…) Tj`) when nothing goes between its glyphs, else a TJ array with the difference
  between the wanted advance (kerning, shaper, word spacing) and the /W width as written (3 decimals, so measuring and
  drawing agree exactly), `Ts` changes for y offsets, and `/Span << /ActualText … >> BDC … EMC` around clusters that
  are not one glyph standing for their text. Tc and Tz are left to the reader. Word spacing: `Tw` for standard fonts;
  TJ for Identity-H (whose two-byte codes Tw does not touch; Tw is set to 0 there so a reader that wrongly applied it
  to <0020> would not double it). A `.notdef` drawn outside PDF/A/UA now carries an ActualText of the missing
  character (so it still extracts).
- **Shaping hook**: the shaper's output is validated (array, ≤ 4 glyphs a character + 64, integer glyph IDs inside
  the font, clusters inside the text, |numbers| < 1e6). harfbuzzjs 1.6 (in node_modules, via its wasm) shapes Arabic
  and Devanagari in the tests; the drawn glyph IDs equal HarfBuzz's and pdftotext returns the source text.
- **Bidi**: `direction: 'rtl'` plus pre-ordered runs; a run of right-to-left letters only is drawn right to left by
  itself. No UAX #9 (no tiny correct implementation exists: it needs the bidi class table, ~10 KB, and the full
  algorithm); documented.
- **textBox**: greedy by word (a line's width is the sum of its words' and spaces' widths, kerning across a space not
  counted), long words broken a character at a time in one pass, justify by word spacing. SECURITY (review of
  919dcb4): the first version re-measured growing slices (O(n²) on a long word, on the ellipsis trim, and laid out
  all the text when few lines show). Now every loop is linear in the text it touches, layout stops one line past what
  shows, measuring builds no per-glyph objects, text is capped at 10,000,000 characters and a box at 100,000 lines
  (tests/pdf/hostile-text.test.js: a 2 MB word, 1 MB with maxLines 1, 200,000 paragraphs, a 0.001 pt box, a huge
  size, each < 1 s).
- veraPDF UA-1 and A-2b: 0 failed rules on a tagged PDF/A page with kerned text with character spacing, a justified
  textBox, shaped Devanagari and Arabic (ActualText spans), and a fallback line with rise.
- Not done: WOFF/WOFF2 (refused, as before); kerning of standard fonts; hyphenation; UAX #9; vertical text; GPOS
  beyond pair kerning without a shaper; desubroutinising CFF (the HarfBuzz hook does it).
- Speed: plain lines went through the new run machinery; 1,000-page text 134 → ~150 ms warm (same bytes), after
  trimming per-call objects (first cut was 188 ms).

## Group D (navigation and annotations): done

- Files: `nav/dest.js`, `nav/trees.js`, `nav/labels.js`, `nav/viewer.js`, `annotations/annot.js`,
  `annotations/markup.js`, `annotations/attach.js`, `core/md5.js`, `core/filename.js`; rewritten `nav/outline.js`,
  `nav/links.js`. Shared files touched at extension points: `index.js` (`destination`, `pageLabels`, `viewer`),
  `page.js` (one `install`, the `MAX_ANNOTS` cap in `annotate`), `document.js` (`resourcesRef`), `tags/tags.js`
  (`link(page, annot, S)`: Link or Annot elements).
- **Destinations**: every fit (XYZ with zoom, Fit, FitH, FitV, FitR, FitB, FitBH, FitBV) in the top-left space, written
  when the page's height is known. Named destinations: a balanced name tree (64 entries a leaf, `Kids` + `Limits`
  above; keys the names' UTF-8 bytes, sorted as bytes), checked with pdf-lib's walk and `pdfinfo -dests` (5,000
  names, depth 2). The catalog's `/Names` is shared through `setNames` (group G adds EmbeddedFiles there).
- **Outline**: open/closed (`/Count` signs summed bottom-up in reverse order: no recursion), colour, bold/italic,
  fits, named destinations. Levels now **throw** outside 0–63 (they were clamped to 0–9). 100,000 entries are written in
  < 1 s.
- **Page labels**: a number tree; page 0 gets decimal labels when no range starts there. poppler's tools do not print
  labels (pdfinfo has no option), so pdf-lib reads the tree.
- **Viewer**: preferences, page mode/layout, open action (a destination only); merged after the tagger (which needs
  DisplayDocTitle) and the outline (whose /UseOutlines an explicit pageMode overrides).
- **Annotations**: notes (with replies, /IRT), Highlight/Underline/StrikeOut/Squiggly (QuadPoints from rectangles,
  Acrobat's corner order), FreeText (/DA, /Q, drawn with textBox), Square, Circle, Line (10 line endings drawn),
  Polygon, PolyLine, Ink, Stamp (14 standard names, label in the caller's font; or a custom draw), FileAttachment
  (Filespec F/UF/Desc, EmbeddedFile with /Params Size, MD5 CheckSum, dates). Every one has an appearance stream: a form
  XObject drawn by the page's own methods on a stand-in page (`appearance()`), using the shared Resources. A highlight
  is filled with blend mode Multiply (the form gets a transparency group), so the text shows through (pixel test).
  Link appearance streams are not written (PDF/A exempts links; viewers draw /BS borders).
- **Tagged**: Annot elements with OBJR (Link for links), `/Tabs /S`, contents required (the alternate description).
  veraPDF UA-1 and A-2b: 0 failed rules on a tagged PDF/A page with links, notes and a reply, four text markups,
  FreeText, five shapes, ink and two stamps; UA-1 also with a file attachment.
- **SECURITY**: no JavaScript, Launch, GoToR, GoToE, SubmitForm, ImportData or other action can be written (targets
  are checked; keys naming them throw). URLs: http, https, mailto by default; `allowSchemes` widens per link but
  never to javascript/vbscript/data/file; control characters refused; WHATWG-normalised, percent-encoded (also
  `()'"<>`), hex. Caps: 100,000 outline entries, levels 0–63, titles 4,096 characters; 100,000 destination names of
  ≤ 1,024 UTF-8 bytes (a collision by bytes throws); 10,000 label ranges; 100,000 annotations a page, 10,000
  rectangles and 100,000 points an annotation, 2,000 squiggle waves, contents 1,000,000 characters, URLs 32,768.
  tests/pdf/hostile-nav.test.js: each case refused or escaped (no /JavaScript, /JS, /Launch in uncompressed output)
  in < 1 s.
- **SECURITY (two reviews of the attachment names, fixed):** names that display or save as another name (bidi
  controls such as U+202E, zero-width and other Cf/Cc characters, Windows-invalid characters and NTFS streams
  `x.pdf:evil.exe`, dot look-alikes such as U+FF0E/U+2024, trailing dots and spaces, a leading dot, Windows device
  names, > 255 UTF-8 bytes) are refused; types are an **allowlist** of passive formats (an executable denylist can
  never be complete), anything else needs `allowTypes` (the caller accepts the risk); double extensions are checked;
  a MIME type must agree with the extension; the /UF name and its ASCII /F form are both checked. One shared
  validator, core/filename.js, for group G's EmbeddedFiles keys and PDF/A-3 attachments too. A third review added: every
  passive extension mapped to its MIME types (a contradicting one throws), slash look-alikes refused before the directory
  is dropped, spaces other than U+0020 and runs of 3 refused, every check run on the final name written, a
  stable-result invariant, a threat-model table in the file, and a 2,000-name random hostile test.
  tests/pdf/hostile-attachments.test.js.
- PDF/A-2: attachments refused (A-2 allows only PDF/A files, which cannot be checked here; PDF/A-3 is group G).
- Bench (node 20.20, Apple Silicon, median of 10), 500 link annotations over 20 pages + 200 outline entries:
  @reportwright/pdf 21,168 bytes, 5.8 ms warm, 64 ms cold; pdf-lib 1.17.1 29,803 bytes, 16.2 ms warm, 131 ms cold.
  pdf-lib has no link or outline API: its run builds the same Link dictionaries (XYZ destinations) and outline items
  through `doc.context` (see the bench), which is the fairest equivalent; ours also writes each link's /Contents.
- Not done: Popup annotations (viewers make their own), rich text (/RC) in FreeText, callout lines, link appearance
  streams, Caret/Sound/Movie/3D/Redact annotations (Sound/Movie/3D are forbidden in PDF/A anyway), the
  document-level EmbeddedFiles tree (group G).

## Group E (forms): done

- Files: `forms/form.js`, `forms/draw.js`. Shared files touched at extension points: `index.js` (`createForm`, the
  `form` option, `pdf.form`). Nothing else: widgets go through `page.annotate`, appearances through annot.js
  `appearance()`, Form elements through `doc.tags.link(page, ref, 'Form')` inside `page.tag('Form', …, { alt })`.
- **Model**: a field with one widget is one dictionary (field + widget merged: what pdf-lib and Acrobat write); a
  radio group is a parent field (written at the end) with a widget per button; `group()` is a non-terminal field
  (`/T`, `/Kids`, `/Parent`). The AcroForm is `/Fields`, `/NeedAppearances false`, `/DR` = the shared Resources
  object (every font a `/DA` names is there already). Nothing is held per field but numbers and short strings.
- **Appearances**: every state: text `/N`; check boxes and radios `/N << /on … /Off … >>` with `/AS`; push buttons
  `/N` and a pressed `/D`. Auto size (`0 Tf`): one line fits the height then the width (≤ 12); multiline tries
  12, 11 … 4 on a scratch copy of the stand-in page (layout only, nothing drawn) and keeps the first that fits. Combs
  centre each character in its cell with dividers. List boxes highlight selected rows and set `/TI` when the first
  selected row would be out of view. Check marks are vector paths (`/MK /CA` still names the ZapfDingbats character
  for viewers that regenerate). Values a font cannot draw throw (fallback fonts are tried first), so an appearance
  never silently drops characters.
- **PDF/A-2 (found with veraPDF, then refused up front)**: 6.3.3 needs a Btn widget's `/N` to be a subdictionary
  (push buttons too), so in PDF/A a push button gets `/AS /Push /N << /Push … >>`; appearance dictionaries hold `/N`
  only (no `/D`); 6.4.1 forbids `/A` on any widget and 6.5.1 forbids ResetForm, so button actions throw in PDF/A.
- **Tagged**: tooltip required (it is `/TU` and the Form element's `/Alt`). veraPDF UA-1 and A-2b: 0 failed rules on a
  tagged PDF/A page with every field type (text, multiline, comb, password, two check-box styles, two radio groups,
  two combos, a multi-select list, a labelled and an icon button, a locked signature field), and on the same page
  flattened (each field a Figure).
- **Flatten**: each field's shown appearance is drawn with `q 1 0 0 1 x y cm /Xn Do Q` (the same form XObject), no
  widget or AcroForm is written, and only the shown state's appearance is made. pdftotext reads the values.
- **SECURITY**: no JavaScript of any kind: each field type has an allowlist of option keys; script-, action- and
  submit-like keys (`aa`, `js`, `format`, `keystroke`, `validate`, `calculate`, `submit`, `importData`, `url`…) throw
  with the reason; a button's action is ResetForm (all, or named fields with `exclude`) or one of four named page
  actions. `/CO` is not written: it orders calculate scripts and there are none. Names: no `.` (use groups), no Cc,
  Cf (bidi, zero-width, BOM), Cs (lone surrogates), Zl or Zp characters, ≤ 256 characters, ≤ 32 levels, full names
  unique; every string is a hex text string; on-states through `pdfName` (written names must be unique, `Off` is
  refused); numbers through `num()`; pages, fonts, images and fields are looked up in the brand table. Caps: 10,000
  fields and groups, 1,000 buttons a radio group and 50,000 a document (that last cap was a fix: per-group alone
  allowed 10 million widgets), 10,000 options and 1,000,000 option characters, values 100,000 characters, tooltips,
  labels and options 4,096, combs 1,000 cells; every length is checked before anything is iterated. A password field
  takes no value (readers must not store one). Reset and lock names are checked at `pdf.end()` (an unknown name
  fails it with the name). tests/pdf/hostile-forms.test.js: each case refused or escaped, no `/JavaScript`, `/JS`,
  `/AA`, `/SubmitForm` in uncompressed output, each < 1 s.
- Bench (node 20.20, Apple Silicon, median of 10), a 200-field form filled (4 pages × 40 text fields, 5 check boxes,
  5 combo boxes, Helvetica 10): @reportwright/pdf 63,095 bytes, 15.4 ms warm, 82 ms cold; pdf-lib 1.17.1 (its form API;
  `save()` makes the appearances) 165,910 bytes, 97.0 ms warm, 237 ms cold. Both read back as 200 fields by pdf-lib.
- Not done: rich text (`/RV`), file-select fields, the Sort flag (options stay in the caller's order), field
  rotation (`/MK /R`), per-widget tooltips on radio kids, `/SigFlags` (group F sets it when it signs). An embedded font in a
  fillable field is subset to what was drawn: embed with `subset: false` for fields people type into (README).

## Group F (encryption and signatures): done

- Files: `security/crypto.js` (the platform's AES-CBC, SHA-2, MD5, randomness, the incremental hash), `security/encrypt.js`
  (the standard security handler), `security/der.js` (a DER writer and a bounded reader), `security/cms.js` (CMS
  SignedData: `cmsSigner`, `nodeSigner`), `security/sign.js` (`pdf.sign`). Shared files touched at extension points:
  `core/objects.js` (the hook's `dict` is awaited and the Encrypt dictionary written directly; the digest of every flushed
  byte; `finish()` writes a `LastObject` — the signature dictionary — with the xref and trailer built in memory),
  `document.js` (`doc.signing`, `doc.sigFlags`, `doc.last`), `forms/form.js` (a signature widget's `/V`, written at the
  end when the PDF is made to be signed; `/SigFlags`), `index.js` (`encrypt`, `sign`, `pdf.sign`, the exports).
- **Encryption**: AES-256 (V5/R6) default, AES-128 (V4/R4) option, RC4 refused. Strings inside object streams are not
  encrypted on their own: ISO 32000-1 §7.6.2 excludes "strings inside streams such as compressed object streams, which
  themselves are encrypted" (the brief said "per object"; the spec, qpdf and poppler agree on this). The xref stream is
  never encrypted; the Encrypt dictionary never sits in an object stream. EncryptMetadata false: the XMP stream gets the
  Identity crypt filter (found by testing: poppler decrypted an unmarked XMP stream anyway, qpdf did not).
  R4's /O and /U use RC4 inside Algorithms 3 and 5 (a key-stretching step the spec defines; WebCrypto and Node 17+ have
  no RC4), so a 10-line RC4 lives in encrypt.js for that and nothing else. MD5 (R4 only) is node:crypto's, else core/md5.js.
- **Verified**: Algorithm 2.B and Algorithms 2/3/5 reproduce /U /O /UE /OE /Perms and the R4 /O, key and /U of files
  qpdf 12.4.2 made (vectors in tests/pdf/encrypt.test.js); poppler 26.04 opens AES-256 and AES-128 with each password,
  refuses a wrong one, and pdfinfo shows the permissions; qpdf (through pikepdf 10.1, `PIKEPDF_PY=…/python`) decrypts
  every string and stream with each password and `check_pdf_syntax()` finds nothing; pdf-lib parses the structure (it
  cannot decrypt). WebCrypto and node:crypto give the same bytes, and the whole library works with node:crypto hidden
  (tests/pdf/crypto-web.test.js). poppler's command-line tools keep only 32 characters of `-upw`/`-opw`, so the 127-byte
  cut is checked with qpdf.
- **Signatures**: PAdES B-B / B-T, one per document, streamed (see README). `/ByteRange` is a fixed-width placeholder
  in the signature dictionary's head, filled once the tail is built; the ID is the hash of the bytes before the
  signature dictionary (so RSA PKCS#1 v1.5 signing stays byte-for-byte deterministic; ECDSA and PSS are randomised).
  Verified: `openssl cms -verify` (OpenSSL 3.6) on the extracted CMS over the ByteRange bytes, pdfsig "Signature is
  Valid." (RSA, RSA-PSS SHA-384, P-256, P-384 SHA-512, adbe.pkcs7.detached, DocMDP, encrypted AES-256 and AES-128), one
  changed byte failing both, an `openssl ts` token over the signature value (`openssl ts -verify`: OK), pdf-lib reading
  the field's `/V`, and veraPDF A-2b: 0 failed rules on a signed PDF/A.
- **SECURITY** (tests/pdf/hostile-crypto.test.js): passwords > 1024 characters refused before any work; SASLprep
  refuses control, bidi, private-use and unassigned characters; passwords and keys never in an error (nodeSigner drops
  the cause of a key error); a signer's or timestamp's output must be one DER SignedData within its cap (reserve,
  64 KB for a token, 16 KB for a raw signature, 10 certificates of 64 KB); a signer that hangs is stopped by
  timeoutMs/signal (and is given the signal); IVs are never reused (checked across 100 strings and streams, and every
  stream and string of a whole file). Two fixes from review, each its own commit: a forged field handle was read as a
  new field's options; a custom signer dropping the requested timestamp silently downgraded B-T to B-B.
- Bench (node 20.20, Apple Silicon, median of 10): 50 pages × 50 lines, Times: plain 24,610 bytes, 9.1 ms warm, 70 ms
  cold; AES-256 26,461 bytes, 11.7 ms warm, 78 ms cold (pdf-lib cannot encrypt; qpdf was not on the PATH, so no qpdf
  row). Signing the 1-page invoice (RSA 2048, SHA-256, nodeSigner): 36,208 bytes (the 16 KB reserve is 32 KB of hex),
  2.2 ms warm, 57 ms cold (pdf-lib cannot sign).
- Not done: public-key (certificate) encryption, more than one signature (incremental updates: group H), LTV (B-LT:
  DSS, OCSP/CRL), a visible signature appearance beyond the field's frame, the RFC 3454 bidi rule in SASLprep.

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
- TODO(daylight): `brew install qpdf` (or keep pikepdf in a venv and set PIKEPDF_PY) so the group F qpdf checks and the
  qpdf --encrypt bench row run by default; this session used pikepdf 10.1 (libqpdf 12.4.2) in a scratch venv.
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
  | 1,000 vector shapes | @reportwright/pdf | 8,353 (was 45,903) | 5.3 | 60 |
  | 1,000 vector shapes | pdf-lib 1.17.1 | 22,273 | 20.5 | 132 |
  | 20 photos (one 800 × 600 JPEG) | @reportwright/pdf | 76,790 | 0.8 | 48 |
  | 20 photos (one 800 × 600 JPEG) | pdf-lib 1.17.1 | 76,092 | 0.7 | 86 |
  | 100 PNG icons with alpha (32 × 32, all different) | @reportwright/pdf | 58,989 | 20.2 | 90 |
  | 100 PNG icons with alpha (32 × 32, all different) | pdf-lib 1.17.1 | 61,285 | 27.9 | 135 |
  | 50 pages of wrapped, justified paragraphs (Times) | @reportwright/pdf | 23,758 | 13.1 | 74 |
  | 50 pages of wrapped, justified paragraphs (Times) | pdf-lib 1.17.1 (its widthOfTextAtSize + a greedy wrapper in the bench, Tw pushed around each justified line: pdf-lib has no justified wrap) | 49,633 | 37.4 | 155 |
  | a 200-field form, filled | @reportwright/pdf | 63,095 | 15.4 | 82 |
  | a 200-field form, filled | pdf-lib 1.17.1 (its form API) | 165,910 | 97.0 | 237 |

  After group C: 1,000-page text 151.8 ms warm (was 134; see group C), the rest unchanged.

  The photo page is 698 bytes larger than pdf-lib's: the XMP metadata stream (855 bytes) pdf-lib does not write.
- Memory (tests/pdf/memory-child.mjs, 30 text lines + 30 rules + a link per page, after GC): heap 4.5 MB at 1,000
  pages, 5.0 MB at 20,000 pages; array buffers 0.4 → 0.75 MB; a 15 MB file written in about 1.6 s.
- `npm pack --dry-run`: 39.7 kB tarball, 153 kB unpacked (dist/index.js 138 kB unminified, of which the AFM width
  tables are most).
