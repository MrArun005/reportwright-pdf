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
| `pdfa` | `true`: PDF/A-2b (sRGB output intent bundled, XMP identification). Fonts must be embedded |
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

Colours: `'#rgb'`, `'#rrggbb'`, `[r, g, b]` (0–1), or a gray level `0`–`1`.

### Document

- `pdf.outline({ title, page, top?, level? })` (or an array) — bookmarks; `level` nests (0 = top).
- `await pdf.end()` — ends open pages, writes fonts, outline, metadata and the cross-reference stream; resolves to
  `{ pages, bytes, warnings }`.

## Not supported yet

Images, curves and paths, clipping, transforms, opacity, gradients; CMYK and ICC colours; kerning, shaping, text
wrapping; annotations other than links; form fields; encryption and signatures; PDF/A-1/3, attachments; reading or
editing existing PDFs. See NOTES.md for the plan. Extending the library: ARCHITECTURE.md.
