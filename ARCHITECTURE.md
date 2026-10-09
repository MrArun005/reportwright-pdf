# Architecture of @reportwright/pdf

One module per feature area under `src/`. Features are added as **new files** in their folder and wired in at a small
number of named extension points; shared files are touched only there (usually one line).

```
src/
  index.js            public API: createPdf, toBytes (wires the modules together)
  document.js         the document: page queue, finishers, Resources, page tree, Info, catalog  → `doc`, the extension API
  page.js             Page: content, annotations, page-dict entries, install() for drawing methods
  core/               objects.js (numbers, object streams, packed xref, xref stream or — PDF/A-1 — a classic xref table, encryption hook),
                      serialize.js (numbers, strings, names, dates), deflate.js, sink.js (sinks, back-pressure, abort)
  content/            content.js: the content-stream builder (graphics state, text objects, marked content)
  fonts/              standard.js (14 standard fonts), truetype.js (sfnt reader), subset.js (glyf subsetter), embed.js,
                      cff.js (checked CFF reader, CFF subsetter, identity charset), kern.js (GPOS / kern-table pair kerning)
  graphics/           color.js (colours → operators: gray, RGB, CMYK, spot, ICC; PDF/A intent rules), shapes.js (line, rect), path.js (Path builder), svg.js (SVG path data),
                      draw.js (fill/stroke/clip, styles, opacity, transforms, save/restore, figure), paint.js (gradients, patterns)
  core/filename.js    checkFileName: the one validator for file names written into a PDF (attachments; group G's embedded-files
                      name tree KEYS and PDF/A-3 attachments must use it too): spoofing, Windows-invalid and dot look-alike characters,
                      device names, an allowlist of passive types (allowTypes widens it), double extensions, MIME/extension agreement;
                      both the /UF name and its ASCII /F form are checked
  core/md5.js         MD5 (an embedded file's /CheckSum)
  core/brand.js       handles (fonts, pages, gradients, patterns, images, spot colours, ICC spaces): branded at creation, looked up — never trusted — when passed back
  text/               runs.js (fonts' runs → segments, widths, Tj/TJ operators), text.js (page.text), box.js (page.textBox)
  nav/                links.js (page.link, URL checks, refuseActive), outline.js (bookmarks), dest.js (fits, pdf.destination),
                      trees.js (balanced name/number trees, the catalog /Names dict: setNames), labels.js, viewer.js
  annotations/        annot.js (shared entries, appearance(), addAnnot), markup.js (notes, text markup, FreeText, shapes,
                      ink, stamps), attach.js (file attachments)
  tags/               tags.js (structure tree, page.tag, marked content for PDF/UA; nesting and heading rules, Table/List
                      attributes, IDTree, page.artifact)
  standards/          xmp.js (metadata, escaped values, PDF/A extension schemas), pdfa.js (PDF/A output intent: bundled sRGB or
                      the caller's profile), icc.js (ICC header check), level.js (the pdfa option → part and conformance;
                      refuseInA1), files.js (pdf.attach: the EmbeddedFiles tree, /AF), facturx.js (pdf.facturX: the invoice
                      XML read without a parser, the fx XMP schema), layers.js (pdf.layer, page.layer, /OCProperties),
                      boxes.js (addPage's page boxes, Rotate, UserUnit)
  images/             png.js (PNG reader/decoder), jpeg.js (JPEG marker reader), image.js (embedImage, page.image)
  forms/              form.js (pdf.form: fields, groups, widgets, the AcroForm, flattening, every check), draw.js (appearance
                      streams: frames, text values, combs, list rows, check marks, button faces)
  security/           crypto.js (the platform's AES-CBC, SHA-2, MD5, randomness, the incremental hash), encrypt.js (the standard
                      security handler: AES-256 R6, AES-128 R4, permissions, SASLprep), der.js (DER writer, bounded reader),
                      cms.js (CMS SignedData: cmsSigner, nodeSigner), sign.js (pdf.sign: the streamed PAdES signature)
examples/             harfbuzz-shaper.mjs (a harfbuzzjs shaper for embedFont's `shaper`; not a dependency)
```

## The write model (read this first)

- Objects are written **as soon as they are complete** and never held: `doc.reserve()` gives a number now, `doc.write(n, …)`
  writes it whenever it is ready (forward references are fine).
- A page's operators accumulate in `page.content` until `page.end()`; the page is then compressed (a few at a time) and
  written **in order** with its annotations and the objects its `onWrite` hooks write. After that nothing of it stays.
- Everything that needs the whole document (fonts' subsets, the outline, the structure tree's root, AcroForm…) is
  written at `pdf.end()` by **finishers**, then fonts, then Resources, page tree, metadata, Info, catalog, xref.
- All pages share **one Resources dictionary** (written at the end), so a resource name from `doc.resource()` is valid on
  every page and in any XObject that uses the shared Resources.
- Every string the library writes into a dictionary is a **hex string** (`serialize.js`: `text`, `ascii`). Literal
  `(…)` strings appear only inside content streams. Keep it that way: the encryption hook relies on it.

## Extension points

### On `doc` (document.js; `pdf.core` publicly, passed to every module)

| Point | Use |
|---|---|
| `doc.reserve()` → number | an object number for an object written later |
| `doc.write(n, dict, stream?)` | write object n now; `stream` bytes are already filtered (`/Length` is added). Small dicts go into object streams |
| `doc.writeStream(n, dict, raw)` | write a stream, Flate-compressed unless `compress: false` (adds `/Filter`) |
| `doc.object(dict, stream?)` → Promise<number> | reserve + write |
| `doc.writeBig(n, head, parts, tail)` | an object whose text is too long to hold (written as the parts come) |
| `doc.resource(kind, value, name?)` → name | register a resource in the shared Resources dict: `'Font'`, `'XObject'`, `'ExtGState'`, `'Shading'`, `'Pattern'`, `'ColorSpace'`, `'Properties'`. Same value → same name |
| `doc.catalog(key, value)` | a catalog entry, e.g. `doc.catalog('AcroForm', '12 0 R')`, `'OCProperties'`, `'Names'`, `'PageLabels'`, `'OutputIntents'`. Read when the catalog is written, so finishers may still set it |
| `doc.onFinish(fn)` | run `fn` at `pdf.end()` after the last page is written, before fonts and catalog (in registration order) |
| `doc.addFont(font)` | a font object (`{ name, ref, key, missing, ascent, descent, widthOf, encode, write }`, see `Font` in document.js); written after the finishers |
| `doc.pageRef(i)`, `doc.pageHeight(i)`, `doc.pageCount` | page object numbers (reserved ahead), heights (once the page exists) |
| `doc.warn(msg)` | a warning in `pdf.end()`'s result |
| `doc.tags` | the structure tree (tags.js) when tagged, else null; `doc.tags.link(page, annotRef, 'Link' \| 'Annot')` gives an annotation its element (with an OBJR) and returns its `/StructParent` |
| `doc.resourcesRef` | the shared Resources dictionary's object number, for a form XObject drawn with page resources (appearance streams) |
| `setNames(doc, key, ref)` (nav/trees.js) | add a name tree to the catalog's `/Names` (`Dests` here; group G adds `EmbeddedFiles` through it: `doc.catalog('Names')` directly would drop the others). `writeTree(doc, 'Names' \| 'Nums', sortedEntries)` writes a balanced tree |
| `namedDests(doc)` (nav/dest.js) | `.use(name, who)` → the hex string a `/Dest` names (records it, to warn when undefined); `destArray(doc, i, fitOf(o))` a page destination |
| `doc.pdfa`, `doc.tagged`, `doc.compress`, `doc.signal` | the options a module must respect |
| `doc.pdfaLevel` | `{ part: 1 \| 2 \| 3, conformance: 'a' \| 'b' \| 'u', unicode }` when `pdfa`, else null (standards/level.js). A feature PDF/A-1 cannot hold calls `refuseInA1(doc, what, why)` (transparency, soft masks, 16-bit images, layers, UserUnit do); `unicode` means a character without a glyph throws (fonts/embed.js) |
| `doc.xmpExtensions` | push `{ schema, ns, prefix, props: [{ name, type, category, description, value }] }` (standards/xmp.js `Extension`) before the end: the values are written in the XMP and, in PDF/A, the schema's description in the one `pdfaExtension:schemas` bag. Prefixes and names are checked as XML names; every value is escaped |
| `createFiles(doc, when)` (standards/files.js) | the `attach(bytes, o, who)` behind `pdf.attach`: another module embedding a file (facturx.js does) calls it, so the name check, the tree, `/AF` and the PDF/A rules are the same |
| `doc.outputIntent` | `'RGB'` or `'CMYK'` when `pdfa`: which device colours PDF/A allows. Check with `checkDevice(doc, '/DeviceCMYK')` (graphics/color.js) before writing a device colour space |
| `doc.serial(fn)` | run `fn` after every write queued before it. **Writes outside a page or finisher must go through it** (`embedImage`, `iccColorSpace`): the object writer is not re-entrant, and two interleaved writes corrupt the file |
| the **encryption hook** (`Encryptor`, core/objects.js; made by security/encrypt.js from `options.encrypt`) | `{ id, ref, dict(n, text), stream(n, bytes, dict), trailer }`: `dict` (may be async) gets each **direct** object's text and returns it with its hex strings encrypted; `stream` gets each stream's (filtered) bytes; `trailer` adds `/Encrypt n 0 R`; `id` is the file ID the key was derived with; object `ref` (the Encrypt dictionary) is written directly and left alone. Strings inside object streams are not passed (the object stream is encrypted as a stream, ISO 32000-1 §7.6.2); the xref stream is never encrypted. A dictionary with a literal `( … )` string throws (it could not be encrypted) |
| `doc.signing`, `doc.sigFlags`, `doc.last` | made to be signed (`options.sign`: every flushed byte is hashed); the AcroForm's `/SigFlags`; the `LastObject` (core/objects.js) — the signature dictionary, written as the file's last object by `finish()`, which builds it, the xref and the trailer in memory, fills its fixed-width `BYTERANGE` placeholder, and passes the digest to its `sign()` |

### On a page (page.js)

| Point | Use |
|---|---|
| `install({ name: fn })` | add drawing methods to every page (`this` is the page); one line in page.js per module |
| `page.content` | the content builder: `op(ops)` appends operators outside any text object, in the right marked content; `q()`/`Q()`; `fill(op)`, `stroke(op)`, `lineWidth`, `dash` (state-tracked); `draw()` before painting anything else; `text(...)`; `run(font, size, x, y, ops, { Tc, Tw, Tz, Ts, Tr })` (a text run: the text state set only when it changes, unset ones back to their defaults, then Tf, Td and `ops`) |
| `page.annotate((ref, final) => dict)` → ref | an annotation; its dictionary is made when the page is written (return `undefined` to be asked again at the end, `final` true). At most `MAX_ANNOTS` (100,000) a page |
| `addAnnot(page, subtype, box, own, shared(doc, o, who), draw)` (annotations/annot.js) | an annotation with the shared entries, its appearance stream (`draw(ap)` on a stand-in page of the box's size: the page's drawing methods, written as a form XObject with the page) and its Annot element; returns a branded handle. Group E widgets can reuse `appearance(page, w, h, draw)` |
| fields (forms/form.js) | `unbrand(field, 'field', doc, 'field')` → `{ kind, full, ref }`; a signature field's also has `page` (the Page) and `rect` ([x, y, w, h], top-left): its widget is the field's object `ref`, written with the page, and `sig` (`{ v }`): pdf.sign sets `sig.v` to the signature dictionary's number and the widget gets `/V` (in a PDF made to be signed the widget is written at the end, so pdf.sign may come after its page) |
| `page.onWrite(async (page) => …)` | write objects that belong to this page when it is written (delayed until page end), set entries |
| `page.entries.set(key, value)` | page dictionary entries: `Group`, `StructParents`… (`Rotate`, the boxes and `UserUnit` come from addPage's options through standards/boxes.js) |
| `page.ref`, `page.index`, `page.width`, `page.height`, `page.doc` | |

Coordinates: methods take top-left, y-down points; convert with `page.height - y` when writing operators.
Rotation (`addPage({ rotate })`) does not change them: they stay those of the unrotated MediaBox.

Marked content of your own (as layers.js's `/OC … BDC`): call `page.content.closeMarked()` and `et()` before opening
it and again before its `EMC`, so the tagger's sequences (which open lazily in `draw()`) nest inside it, never across.

## How to add a feature module (worked example: `page.ellipse`)

1. New file `src/graphics/ellipse.js`:

   ```js
   // @ts-check
   import { num } from '../core/serialize.js';
   import { colorOp } from './color.js';
   const K = 4 * ((Math.SQRT2 - 1) / 3);
   /** @this {import('../page.js').Page} */
   export function ellipse(cx, cy, rx, ry, o = {}) {
     const c = this.content, y = this.height - cy, ox = rx * K, oy = ry * K;
     c.draw(); c.et();
     if (o.fill != null) c.fill(colorOp(o.fill, false));
     c.s += `${num(cx - rx)} ${num(y)} m ${num(cx - rx)} ${num(y - oy)} ${num(cx - ox)} ${num(y - ry)} ${num(cx)} ${num(y - ry)} c `
       + `… h ${o.fill != null ? 'f' : 'S'}\n`;
     return this;
   }
   ```

2. One line in `src/page.js`: `install({ ellipse });` (import it at the top).
3. Its types in `index.d.ts` (`Page.ellipse`), a section in README.md, tests in `tests/pdf/ellipse.test.js`
   (pdftoppm/veraPDF where relevant).

Colours: `colorOp(c, stroke, page.doc)` (graphics/color.js) gives the operator for any colour (device, spot, ICC) and
registers its colour space; `resolve(c, doc)` gives `{ cs, comps }` for a module that writes the colour space itself
(gradients do). Pass the page's `doc` (a pattern cell's stand-in records the resources the cell uses).

Text: a font handle's private side is its brand data, a `FontImpl` (text/runs.js): `{ standard, ascent, lineHeight,
has(cp), items(text, { kerning, rtl, ws, measure }) }`, where `items` gives a run — one escaped string (`{ body, a, n,
sp }`, nothing between the glyphs) or glyph items (`{ b, w, a, dx, dy, sp, at, n }`: bytes, PDF width, wanted
advance, offsets in thousandths of the size, word-spacing point, ActualText span). `measure: true` records nothing
(no glyph for the subset, no warning). A module that draws text gets the fonts with `fontsOf(page, o, who)` and draws
a line with `drawLine(page, fonts, str, x, baseline, size, textState(o), o)` (text/text.js); a new font kind provides a
`FontImpl` as its brand data and works with both.

Images: `await pdf.embedImage(bytes)` writes the XObject at once through `doc.serial` and returns a branded handle; a
module that draws one reads it with `unbrand(img, 'image', doc, …)` → `{ ref, w, h, orient, alpha }` and registers
`doc.resource('XObject', `${ref} 0 R`)`.

A feature that needs a resource registers it: `const gs = this.doc.resource('ExtGState', '<< /ca 0.5 >>'); c.op(`/${gs} gs`)`.
A feature that needs whole-document objects (AcroForm) collects per page with `page.annotate`/`page.onWrite` and writes
the rest in `doc.onFinish`, then `doc.catalog('AcroForm', …)`. A feature with document options (PDF/A-3, encryption)
reads them in `index.js` (one `if` next to `if (o.pdfa) addOutputIntent(doc)`).

## Rules

- Memory must stay flat: hold numbers (Int32Array) not strings per page; write per-page objects in `onWrite`.
- Active content: no module writes a JavaScript, Launch, GoToR, GoToE, SubmitForm or ImportData action, or an `/AA`
  entry (form fields: an allowlist of option keys per field; push buttons may act only by ResetForm or a named page action). Actions are built from fixed names only (nav/links.js `refuseActive` refuses option keys that name them; URLs
  go through `checkUrl`). File names go through core/filename.js `checkFileName`.
- Handles: anything the library hands out and takes back (fonts, pages, gradients, patterns, images, spot colours,
  ICC colour spaces; later fields) is branded with `brand()` (core/brand.js) and read back with `unbrand()`; never write a string
  from a property of an object the caller passed in.
- Hostile input (fonts, images, ICC profiles, a caller's text): bound every loop and allocation by the input's size and explicit caps,
  check every length against the bytes that are there, never recurse on input, and inflate with a known output size
  enforced while inflating (images/png.js `inflateExact`).
- Determinism: no `Date.now()`, no randomness in output; the same input gives the same bytes. The one exception is
  encryption (random IVs, salts and, unless `id` is given, file ID), which security requires; randomness comes from
  `crypto.getRandomValues` only (security/crypto.js `random`).
- Crypto: the platform's only (WebCrypto; node:crypto as Node's fast path, same bytes). No hand-written AES or SHA.
- PDF/A and PDF/UA: a feature that cannot comply throws a clear error when `doc.pdfa`/`doc.tagged` (as standardFont does).
- Tests: `tests/pdf/<feature>.test.js`, vitest with `--maxWorkers=2`; check with poppler (pdftotext, pdffonts, pdftoppm)
  and veraPDF where the feature touches PDF/A or PDF/UA.
