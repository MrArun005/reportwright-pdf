# Architecture of @reportwright/pdf

One module per feature area under `src/`. Features are added as **new files** in their folder and wired in at a small
number of named extension points; shared files are touched only there (usually one line).

```
src/
  index.js            public API: createPdf, toBytes (wires the modules together)
  document.js         the document: page queue, finishers, Resources, page tree, Info, catalog  → `doc`, the extension API
  page.js             Page: content, annotations, page-dict entries, install() for drawing methods
  core/               objects.js (numbers, object streams, packed xref, xref stream, encryption hook),
                      serialize.js (numbers, strings, names, dates), deflate.js, sink.js (sinks, back-pressure, abort)
  content/            content.js: the content-stream builder (graphics state, text objects, marked content)
  fonts/              standard.js (14 standard fonts), truetype.js (sfnt reader), subset.js (glyf subsetter), embed.js
  graphics/           color.js (colour → operator), shapes.js (line, rect), path.js (Path builder), svg.js (SVG path data),
                      draw.js (fill/stroke/clip, styles, opacity, transforms, save/restore, figure), paint.js (gradients, patterns)
  core/brand.js       handles (fonts, pages, gradients, patterns): branded at creation, looked up — never trusted — when passed back
  text/               text.js (page.text)
  nav/                links.js (page.link), outline.js (bookmarks)
  tags/               tags.js (structure tree, page.tag, marked content for PDF/UA)
  standards/          xmp.js (metadata), pdfa.js (PDF/A output intent + bundled sRGB profile)
  images/ annotations/ forms/ security/   (empty until their feature groups land)
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
| `doc.tags` | the structure tree (tags.js) when tagged, else null |
| `doc.pdfa`, `doc.tagged`, `doc.compress`, `doc.signal` | the options a module must respect |
| `options.encrypt` (the **encryption hook**) | `{ id, dict(n, text), stream(n, bytes, dict), trailer }` (core/objects.js `Encryptor`): `dict` gets each **direct** object's text and returns it with its hex strings encrypted; `stream` gets each stream's (filtered) bytes; `trailer` adds `/Encrypt n 0 R`; `id` is the file ID the key was derived with. Strings inside object streams are not passed (the object stream is encrypted as a stream); the xref stream is never encrypted |

### On a page (page.js)

| Point | Use |
|---|---|
| `install({ name: fn })` | add drawing methods to every page (`this` is the page); one line in page.js per module |
| `page.content` | the content builder: `op(ops)` appends operators outside any text object, in the right marked content; `q()`/`Q()`; `fill(op)`, `stroke(op)`, `lineWidth`, `dash` (state-tracked); `draw()` before painting anything else; `text(...)` |
| `page.annotate((ref, final) => dict)` → ref | an annotation; its dictionary is made when the page is written (return `undefined` to be asked again at the end, `final` true) |
| `page.onWrite(async (page) => …)` | write objects that belong to this page when it is written (delayed until page end), set entries |
| `page.entries.set(key, value)` | page dictionary entries: `Rotate`, `CropBox`, `Group`, `StructParents`… |
| `page.ref`, `page.index`, `page.width`, `page.height`, `page.doc` | |

Coordinates: methods take top-left, y-down points; convert with `page.height - y` when writing operators.

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

A feature that needs a resource registers it: `const gs = this.doc.resource('ExtGState', '<< /ca 0.5 >>'); c.op(`/${gs} gs`)`.
A feature that needs whole-document objects (AcroForm) collects per page with `page.annotate`/`page.onWrite` and writes
the rest in `doc.onFinish`, then `doc.catalog('AcroForm', …)`. A feature with document options (PDF/A-3, encryption)
reads them in `index.js` (one `if` next to `if (o.pdfa) addOutputIntent(doc)`).

## Rules

- Memory must stay flat: hold numbers (Int32Array) not strings per page; write per-page objects in `onWrite`.
- Handles: anything the library hands out and takes back (fonts, pages, gradients, patterns; later images, colour
  spaces, fields) is branded with `brand()` (core/brand.js) and read back with `unbrand()`; never write a string
  from a property of an object the caller passed in.
- Determinism: no `Date.now()`, no randomness in output; the same input gives the same bytes.
- PDF/A and PDF/UA: a feature that cannot comply throws a clear error when `doc.pdfa`/`doc.tagged` (as standardFont does).
- Tests: `tests/pdf/<feature>.test.js`, vitest with `--maxWorkers=2`; check with poppler (pdftotext, pdffonts, pdftoppm)
  and veraPDF where the feature touches PDF/A or PDF/UA.
