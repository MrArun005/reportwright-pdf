<h1 align="center">@reportwright/pdf</h1>

<p align="center">
  <b>Create, comply, sign, light edit.</b><br>
  A streaming PDF library for Node and browsers with <b>zero runtime dependencies</b>.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@reportwright/pdf"><img alt="npm" src="https://img.shields.io/npm/v/@reportwright/pdf?color=1f4e79"></a>
  <a href="https://github.com/MrArun005/reportwright-pdf/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/MrArun005/reportwright-pdf/actions/workflows/ci.yml/badge.svg"></a>
  <a href="./LICENSE"><img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="./package.json"><img alt="runtime dependencies: 0" src="https://img.shields.io/badge/runtime%20dependencies-0-brightgreen"></a>
  <a href="./package.json"><img alt="node >= 20.16" src="https://img.shields.io/badge/node-%3E%3D20.16-339933"></a>
  <a href="./conformance"><img alt="PDF/A + PDF/UA: veraPDF clean" src="https://img.shields.io/badge/PDF%2FA%201b%E2%80%933a%20%2B%20UA--1-veraPDF%20clean-6f42c1"></a>
</p>

<p align="center">
  <a href="https://mrarun005.github.io/reportwright-pdf/">Live demo</a> ·
  <a href="https://mrarun005.github.io/reportwright-pdf/play.html">Playground</a> ·
  <a href="https://mrarun005.github.io/reportwright-pdf/bench.html">Benchmarks</a> ·
  <a href="#security-model">Security model</a>
</p>

Pages are written to your sink as they end, so memory stays flat however many pages you write: 20,000 pages hold
about the heap that 1,000 do. It is the writer inside ReportWright, extracted, plus a hardened reader for merging,
splitting, filling and signing existing files.

It does **not** render PDFs (use [pdf.js](https://mozilla.github.io/pdf.js/) or
[PDFium](https://pdfium.googlesource.com/pdfium/)), and for heavy rewriting, repair or raw speed MuPDF, qpdf and
pdfcpu are faster (see [Benchmarks](#benchmarks)).

**Why this library.** Most PDF jobs are the same four: generate a report or invoice, make it compliant (PDF/A,
PDF/UA, Factur-X), sign or protect it, and lightly edit someone else's file (merge, split, fill, stamp). This does
all four with one maintained, dependency-free package, at flat memory however many pages you write, and it is
conservative about untrusted input.

## Contents

[Install](#install) · [Quick start](#quick-start-30-seconds) · [Coming from pdf-lib](#coming-from-pdf-lib) · [Features](#features) · [Screenshots](#screenshots) ·
[Guide](#guide) · [Bundle size](#bundle-size) · [Examples](#examples) · [Rendering](#rendering-experimental) · [Benchmarks](#benchmarks) · [Options reference](#options-reference) ·
[Security model](#security-model) · [Known limits](#known-limits) · [Public API and stability](#public-api-and-stability) · [Releasing](#releasing) · [Changes](#changes)

## Install

```sh
npm i @reportwright/pdf
```

ESM only. Node 20.16 or later, and modern browsers (the same `dist/index.js`; crypto comes from WebCrypto). Types are
included (`index.d.ts`). Optional, for complex scripts (Indic, Arabic) only: `npm i harfbuzzjs`.

## Quick start (30 seconds)

```js
// hello.mjs  →  node hello.mjs
import fs from 'node:fs';
import { createPdf } from '@reportwright/pdf';

const pdf = createPdf(fs.createWriteStream('hello.pdf'), { title: 'Hello' });
const page = pdf.addPage();                                       // A4, points, origin top-left
page.text('Hello, world', { x: 72, y: 72, font: pdf.standardFont('Helvetica-Bold'), size: 24, color: '#1f4e79' });
page.line(72, 104, 523, 104, { color: 0.6, width: 0.5 });
await page.end();                                                 // the page is written and freed
console.log(await pdf.end());                                     // { pages: 1, bytes: …, warnings: [] }
```

In memory instead of a stream: `const bytes = await toBytes(async (pdf) => { … }, options)`.

## Coming from pdf-lib

[pdf-lib](https://github.com/Hopding/pdf-lib) is a popular pure-JS PDF library. Its last npm release, 1.17.1, was
published on 2021-11-06 (`npm view pdf-lib time`), so if you need current fixes, PDF/A, signing or accessible output,
this is the same kind of API with those built in. The tasks below are the ones people reach for pdf-lib for. Two
differences to know: our coordinates start at the **top-left** (pdf-lib's at the bottom-left), and a document is
written to a sink as pages end instead of being built whole in memory.

Every `@reportwright/pdf` snippet here was run against the local 1.0.0 build and produced a valid PDF.

**1. A page with text**

```js
// pdf-lib
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const page = doc.addPage();
page.drawText('Hello, world', { x: 50, y: 780, size: 30, font, color: rgb(0.12, 0.31, 0.47) });
fs.writeFileSync('out.pdf', await doc.save());
```

```js
// @reportwright/pdf
import { createPdf } from '@reportwright/pdf';
const pdf = createPdf(fs.createWriteStream('out.pdf'));
const page = pdf.addPage();                                     // A4, origin top-left
page.text('Hello, world', { x: 50, y: 50, size: 30, font: pdf.standardFont('Helvetica'), color: '#1f4e79' });
await page.end();
await pdf.end();
```

**2. Embed a custom font**

```js
// pdf-lib (needs the separate @pdf-lib/fontkit package)
import fontkit from '@pdf-lib/fontkit';
doc.registerFontkit(fontkit);
const font = await doc.embedFont(fs.readFileSync('Inter-Regular.ttf'), { subset: true });
page.drawText('café, naïve', { x: 50, y: 780, size: 24, font });
```

```js
// @reportwright/pdf (no extra package; subset, kerned, any Unicode)
const inter = await pdf.embedFont(fs.readFileSync('Inter-Regular.ttf'));
page.text('café, naïve', { x: 50, y: 50, size: 24, font: inter });
```

**3. Embed a PNG or JPEG**

```js
// pdf-lib
const img = await doc.embedPng(fs.readFileSync('logo.png'));      // embedJpg for JPEG
page.drawImage(img, { x: 50, y: 500, width: 200, height: 200 * img.height / img.width });
```

```js
// @reportwright/pdf (one call for both formats; height follows the aspect ratio)
const img = await pdf.embedImage(fs.readFileSync('logo.png'));
page.image(img, { x: 50, y: 50, width: 200 });
```

**4. Fill a form field and flatten**

```js
// pdf-lib
const doc = await PDFDocument.load(fs.readFileSync('form.pdf'));
const form = doc.getForm();
form.getTextField('name').setText('Aanya Sharma');
form.flatten();
fs.writeFileSync('filled.pdf', await doc.save());
```

```js
// @reportwright/pdf
import { loadPdf } from '@reportwright/pdf';
const doc = await loadPdf(fs.readFileSync('form.pdf'));
doc.fill({ name: 'Aanya Sharma' }).flatten();
fs.writeFileSync('filled.pdf', (await doc.save()).bytes);
```

**5. Merge two PDFs**

```js
// pdf-lib
const merged = await PDFDocument.create();
for (const file of ['a.pdf', 'b.pdf']) {
  const src = await PDFDocument.load(fs.readFileSync(file));
  (await merged.copyPages(src, src.getPageIndices())).forEach((p) => merged.addPage(p));
}
fs.writeFileSync('merged.pdf', await merged.save());
```

```js
// @reportwright/pdf
import { loadPdf, mergePdfs } from '@reportwright/pdf';
const a = await loadPdf(fs.readFileSync('a.pdf')), b = await loadPdf(fs.readFileSync('b.pdf'));
fs.writeFileSync('merged.pdf', (await mergePdfs([a, b])).bytes);
```

**6. Set metadata**

```js
// pdf-lib
doc.setTitle('Report');
doc.setAuthor('Example Ltd');
doc.setSubject('Q3');
doc.setKeywords(['finance', 'q3']);
```

```js
// @reportwright/pdf: when writing a new file
const pdf = createPdf(sink, { title: 'Report', author: 'Example Ltd', subject: 'Q3', keywords: 'finance, q3' });

// or on an existing one
const doc = await loadPdf(bytes);
doc.setInfo({ title: 'Report', author: 'Example Ltd', subject: 'Q3', keywords: 'finance, q3' });
const { bytes: out } = await doc.save();
```

### What you get on top

- **Signing**: PAdES B-B / B-T signatures, and incremental countersignatures that keep earlier ones valid.
- **PDF/A-1b to 3a and PDF/UA-1**, veraPDF clean, plus Factur-X / ZUGFeRD / XRechnung invoices.
- **Encryption**: AES-256 / AES-128 with permissions.
- **Streaming and bulk**: flat memory for 20,000+ pages, and worker-thread batches with a per-file timeout.
- **Complex scripts** (Devanagari, Bengali, Tamil, Arabic…) shaped through HarfBuzz, text still extractable.
- **Zero runtime dependencies**, and a reader with a budget against hostile files.

### Not supported yet

Existing pages are not editable at the content level: `page.draw()` overlays new text, images and paths on top of
what is there, but you cannot remove, move or rewrite content already on a page, and there are no page edits in an
incremental update (`saveIncremental()` fills, signs and changes info; use `save()` to rewrite). We also do not embed
a page of another PDF as a reusable drawing (pdf-lib's `embedPdf`/`embedPage`); `copyPages` and `mergePdfs` copy
whole pages instead. See [Known limits](#known-limits).

## Features

| Area | What you get |
|---|---|
| **Write** | Text in the 14 standard fonts or embedded TrueType/OpenType (subset, kerned, any Unicode); text boxes with wrapping and alignment; JPEG/PNG images (alpha as a soft mask); Canvas-style vector paths, gradients, patterns, layers |
| **Complex scripts** | Devanagari, Bengali, Tamil, Telugu, Kannada, Arabic… through a HarfBuzz shaper you plug in (`harfbuzzjs`), text still extractable |
| **Streaming** | Each page is written and freed when it ends; flat memory for 20,000+ pages; `timeoutMs` and `AbortSignal` |
| **Navigate** | Links, named destinations, bookmarks, page labels, annotations |
| **Forms** | Every AcroForm field type with appearance streams; fill and flatten existing forms |
| **Protect** | AES-256 / AES-128 encryption with permissions |
| **Sign** | PAdES B-B / B-T signatures while streaming; incremental countersignatures that keep earlier ones valid |
| **Comply** | PDF/A-1b, 2b/2u/2a, 3b/3u/3a and PDF/UA-1 (veraPDF clean); Factur-X / ZUGFeRD / XRechnung invoices |
| **Read and edit** | Load (also damaged or encrypted files), merge, split, reorder, extract text, fill, stamp, `saveIncremental` |
| **Bulk** | One task over many files in worker threads, each with a heap cap and a per-file timeout; one bad file never stops the batch |
| **Safe by default** | No JavaScript or launch actions can be written; active content is stripped on read; every input is budgeted |
| **Small** | Zero runtime dependencies; one ESM file plus a lazily loaded `fflate.js`; TypeScript types included |

## Screenshots

Page 1 of the [examples](#examples), rendered by poppler (`pdftoppm`) on GitHub Actions straight from their output.

<table>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/MrArun005/reportwright-pdf/main/docs/screenshots/write.png" width="240" alt="write.mjs: a report with a logo, a justified paragraph, a table drawn with paths and a link"><br><code>write.mjs</code><br>text, image, table, link</td>
    <td align="center"><img src="https://raw.githubusercontent.com/MrArun005/reportwright-pdf/main/docs/screenshots/invoice-facturx.png" width="240" alt="invoice-facturx.mjs: a Factur-X PDF/A-3a invoice in Inter"><br><code>invoice-facturx.mjs</code><br>Factur-X, PDF/A-3a</td>
    <td align="center"><img src="https://raw.githubusercontent.com/MrArun005/reportwright-pdf/main/docs/screenshots/indic.png" width="240" alt="indic.mjs: Devanagari text shaped by HarfBuzz mixed with English"><br><code>indic.mjs</code><br>Devanagari via HarfBuzz</td>
  </tr>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/MrArun005/reportwright-pdf/main/docs/screenshots/fill-form.png" width="240" alt="fill-form.mjs: a leave request form, filled in"><br><code>fill-form.mjs</code><br>a form, filled</td>
    <td align="center"><img src="https://raw.githubusercontent.com/MrArun005/reportwright-pdf/main/docs/screenshots/accessible.png" width="240" alt="accessible.mjs: a tagged PDF/UA-1 and PDF/A-2a policy page"><br><code>accessible.mjs</code><br>PDF/UA-1 + PDF/A-2a, tagged</td>
    <td></td>
  </tr>
</table>

## Guide

Every snippet below is cut from a file in [`examples/`](./examples), each of which was run and produces a PDF. The
examples import `../dist/index.js`; in your code import `@reportwright/pdf`. They also ship in the package
(`node_modules/@reportwright/pdf/examples/`).

### Write: text, fonts, images, tables

```js
const pdf = createPdf(fs.createWriteStream('report.pdf'), { title: 'Quarterly report', author: 'Example Ltd' });
const regular = pdf.standardFont('Helvetica'), bold = pdf.standardFont('Helvetica-Bold');
const inter = await pdf.embedFont(fs.readFileSync('Inter-Regular.ttf'));          // subset, any Unicode
const logo = await pdf.embedImage(fs.readFileSync('logo.png'));                   // alpha becomes a soft mask

const page = pdf.addPage();
page.image(logo, { x: 40, y: 40, width: 32 });
page.text('Quarterly report', { x: 84, y: 44, font: bold, size: 22, color: '#1f4e79' });
const box = page.textBox(longText, { x: 40, y: 90, width: 515, font: inter, size: 11, align: 'justify' });
// box = { height, lines, overflow }: continue `overflow` in the next box or page
```

**Tables are paths and text**: there is no table primitive, so you control every rule and alignment.

```js
const rows = [['Region', 'Q1', 'Q2'], ['North', '1,204', '1,390'], ['South', '980', '1,122']];
const cols = [40, 300, 430], right = 555, rowH = 22, top = 100 + box.height;
page.fill(page.path().rect(40, top, right - 40, rowH), { fill: '#1f4e79' });       // header band
rows.forEach((r, i) => {
  const y = top + i * rowH;
  r.forEach((cell, c) => {
    const font = i === 0 ? bold : regular;
    const x = c === 0 ? cols[c] + 6 : (cols[c + 1] ?? right) - 6 - font.widthOfText(cell, 11);   // right-align numbers
    page.text(cell, { x, y: y + 5, font, size: 11, color: i === 0 ? '#ffffff' : 0 });
  });
  if (i > 0) page.stroke(page.path().moveTo(40, y + rowH).lineTo(right, y + rowH), { stroke: 0.75, width: 0.5 });
});
await page.end();
await pdf.end();
```

Full file: [`examples/write.mjs`](./examples/write.mjs) (it also generates its PNG, so it needs no input files).

### Indic and other complex scripts (HarfBuzz)

Pass a shaper to `embedFont` and conjuncts, reordered matras, Arabic joining and marks are drawn correctly; copied
and extracted text stays the source text, in logical order. The adapter for harfbuzzjs ships as
[`examples/harfbuzz-shaper.mjs`](./examples/harfbuzz-shaper.mjs).

```js
import { harfbuzzShaper } from '@reportwright/pdf/examples/harfbuzz-shaper.mjs';   // needs: npm i harfbuzzjs

const bytes = fs.readFileSync('NotoSansDevanagari-Regular.ttf');
const hindi = await pdf.embedFont(bytes, { shaper: harfbuzzShaper(bytes) });
page.text('किताब हिन्दी क्षत्रिय', { x: 40, y: 40, font: hindi, size: 24 });
page.textBox('इस किताब में हिन्दी और English दोनों हैं।', { x: 40, y: 90, width: 400, font: hindi, fallback: [latin] });
```

`node examples/indic.mjs NotoSansDevanagari-Regular.ttf`. Right-to-left: `{ direction: 'rtl' }` (there is no bidi
algorithm: split mixed-direction lines into runs yourself).

### Links and bookmarks

```js
page.link(40, 300, 160, 14, { url: 'https://example.com/report' });              // http, https, mailto by default
pdf.destination('appendix', 2, { top: 40 });                                      // a named destination
page.link(40, 320, 160, 14, { dest: 'appendix' }, { alt: 'Go to the appendix' });
page.link(40, 340, 160, 14, { page: 2, fit: 'FitH', top: 0 });
pdf.outline([
  { title: 'Quarterly report', page: 1 },
  { title: 'Appendix', page: 2, level: 1 },                                       // level nests under the previous entry
]);
pdf.pageLabels([{ start: 0, style: 'r' }, { start: 2, style: 'D' }]);             // i, ii, 1, 2, …
```

### Forms: create, fill, flatten

```js
import { toBytes, loadPdf } from '@reportwright/pdf';

const form = await toBytes(async (pdf) => {
  const font = pdf.standardFont('Helvetica'), page = pdf.addPage();
  pdf.form.textField('name', { page, x: 40, y: 80, width: 240, height: 22, font, tooltip: 'Full name', required: true });
  pdf.form.comboBox('type', { page, x: 40, y: 115, width: 160, height: 22, font, options: ['Annual', 'Sick', 'Unpaid'], value: 'Annual', tooltip: 'Leave type' });
  pdf.form.checkbox('approved', { page, x: 40, y: 150, width: 14, height: 14, tooltip: 'Approved by manager' });
  await page.end();
});

const doc = await loadPdf(form);
doc.fields;                                                        // [{ name: 'name', type: 'text', … }, …]
doc.fill({ name: 'Aanya Sharma', type: 'Sick', approved: true });  // appearances redrawn by the writer
const filled = (await doc.save()).bytes;

const flattened = (await (await loadPdf(form)).fill({ name: 'Aanya Sharma' }).flatten().save()).bytes;  // no AcroForm left
```

[`examples/fill-form.mjs`](./examples/fill-form.mjs) writes `form.pdf`, `filled.pdf` and `flattened.pdf`. To
flatten while writing: `createPdf(sink, { form: { flatten: true } })`.

### Encryption

```js
const bytes = await toBytes(build, {
  encrypt: {
    userPassword: 'open me', ownerPassword: 'full access',
    algorithm: 'aes-256',                                          // default; 'aes-128' for very old readers
    permissions: { print: true, copy: false, modify: false },      // each defaults to true
  },
});
const doc = await loadPdf(bytes, { password: 'open me' });         // doc.encryption.algorithm === 'aes-256'
```

[`examples/encrypt.mjs`](./examples/encrypt.mjs). RC4 is read, never written.

### Signing (PAdES)

```js
import { createPdf, loadPdf, nodeSigner } from '@reportwright/pdf';

const signer = nodeSigner({ key: fs.readFileSync('key.pem', 'utf8'), certs: fs.readFileSync('cert.pem', 'utf8') });
const pdf = createPdf(sink, { title: 'Offer letter', sign: true });
const page = pdf.addPage();
const hr = pdf.form.signature('hr', { page, x: 40, y: 700, width: 200, height: 40, tooltip: 'HR signature' });
pdf.form.signature('candidate', { page, x: 300, y: 700, width: 200, height: 40, tooltip: 'Candidate signature' });
await pdf.sign(hr, { signer, reason: 'Issued', location: 'Bengaluru', certify: 2 });
await page.end();
await pdf.end();                                                   // the signer runs here

// Countersign later: an incremental update, so the first signature stays valid.
const { bytes } = await (await loadPdf(signedBytes)).saveIncremental({ sign: { field: 'candidate', signer } });
```

[`examples/sign.mjs`](./examples/sign.mjs) (make a test key with the `openssl` line at its top). Its output checks with
`pdfsig`: both signatures "Signature is Valid", the second "Total document signed". `signer` can be any async function
returning CMS bytes (an HSM, a cloud KMS: see `cmsSigner`); add `timestamp` for PAdES B-T.

### PDF/A, PDF/UA and Factur-X

```js
const pdf = createPdf(sink, {
  title: 'Leave policy',
  tagged: { lang: 'en-GB' },                // PDF/UA-1: structure tree, title, embedded fonts
  pdfa: { part: 2, conformance: 'a' },      // or true (2b), { part: 1, conformance: 'b' }, { part: 3, … }
});
const font = await pdf.embedFont(fs.readFileSync('Inter-Regular.ttf'));
const page = pdf.addPage();
page.artifact({ type: 'Pagination', subtype: 'Header' }, () => page.text('HR policies', { x: 40, y: 20, font, size: 8 }));
page.tag('H1', () => page.text('Leave policy', { x: 40, y: 50, font, size: 22 }));
page.figure({ alt: 'Bar chart: annual leave 18 days' }, () => page.fill(page.path().rect(40, 180, 180, 16), { fill: '#1f4e79' }));
```

A Factur-X / ZUGFeRD invoice is PDF/A-3 with the CII XML attached:

```js
const pdf = createPdf(sink, { title: 'Invoice INV-2026-001', pdfa: { part: 3, conformance: 'a' }, tagged: { lang: 'en' } });
// … draw the invoice from the same data as the XML …
await pdf.facturX(xmlBytes, { profile: 'EN 16931' });   // MINIMUM, BASIC WL, BASIC, EN 16931, EXTENDED, XRECHNUNG
```

[`examples/accessible.mjs`](./examples/accessible.mjs) (PDF/A-2a + PDF/UA-1) and
[`examples/invoice-facturx.mjs`](./examples/invoice-facturx.mjs) (self-contained PDF/A-3a invoice; `factur-x.mjs`
does the same from your own XML) both pass veraPDF with 0 failed rules (`2a` + `ua1`, `3a` + `ua1`).

### Read: merge, split, extractText, saveIncremental

```js
import { loadPdf, mergePdfs } from '@reportwright/pdf';

const a = await loadPdf(fs.readFileSync('contract.pdf')), b = await loadPdf(fs.readFileSync('annexure.pdf'));
const merged = await mergePdfs([a, b]);                            // { bytes, pages, stripped, warnings }

const all = await loadPdf(merged.bytes);
all.extractText();                                                 // every page, joined by \f
all.page(0).extractText();                                         // one page, in lines

for (let i = 0; i < all.pageCount; i++) {                          // split: one file per page
  fs.writeFileSync(`page-${i + 1}.pdf`, (await all.fork().reorder([i]).save()).bytes);
}

const doc = await loadPdf(merged.bytes);
doc.setInfo({ title: 'Contract (reviewed)' });
const { bytes } = await doc.saveIncremental();                     // the original bytes + an appended update
```

[`examples/merge-split.mjs`](./examples/merge-split.mjs). `save()` rewrites the file (and strips active content);
`saveIncremental()` appends (and refuses files with active content): see [Security model](#security-model).

### Bulk: many files in worker threads

```js
import { bulk } from '@reportwright/pdf';

const files = fs.readdirSync('in').map((f) => fs.readFileSync(`in/${f}`));
const texts = await bulk(files, 'extractText', { workers: 4 });           // [{ ok: true, value } | { ok: false, error }]
const locked = await bulk(files, 'encrypt', { encrypt: { userPassword: 'u', ownerPassword: 'o' } });
const pages = await bulk(files, 'split');                                 // value: one Uint8Array per page
const joined = await bulk([[a, b], [c, d]], 'merge');                     // each input: the files to merge
```

Tasks are names (`extractText`, `merge`, `split`, `encrypt`; `BULK_TASKS`), never functions, so only bytes and plain
options cross to a worker. Results come back in input order; a file that fails (malformed, wrong password, over the
budget) gives `{ ok: false, error: { name, code, message } }` and the batch goes on. Each worker's heap is capped
(`memoryMb`, default 512): a file that exhausts it kills only that worker, its item fails with `E_WORKER`, and a new
worker takes the next. `workers` defaults to `os.availableParallelism() - 1`. Node only: in browsers (no
`node:worker_threads`), and with `workers: 1`, the same tasks run one at a time in the calling thread, without the
heap cap. [`examples/bulk.mjs`](./examples/bulk.mjs).

Workers stay warm (unref'd, so they never keep the process alive) for 2 s after a call, so the next call skips their
start-up; small files are sent several at a time (up to 8, or 256 KB, a worker). Each item has `itemTimeoutMs` (default 120000) in a worker: past it the worker is ended and the item fails with `E_TIMEOUT`; a failed item is never retried, so a batch of stuck or worker-killing files ends with each failing alone (`workers` is 1–64, `memoryMb` 16–16384; with `workers: 1` there is no item timeout or heap cap). Pass `signal` to stop a call (or
`AbortSignal.timeout(ms)` for a time limit): its workers are ended and `bulk` rejects with the signal's reason. When
to use it: CPU-heavy items (encrypt, the text of long files) gain from the first call; cheap items on small files
(extractText or merge of 1–2 page files) gain only once the workers are warm: the first call pays ~25 ms a worker to
start them, so a one-off batch of under ~100 ms of work is quicker with `workers: 1`.

Measured on an Apple M2 (4 performance + 4 efficiency cores, 8 GB, busy laptop), Node 22, files made with
`toBytes` (small: 200 files of 2 pages, 0.4 MB in all; large: 20 files of 200 pages of text, 2.3 MB in all). Items/s
from the best of 3 calls in one process (warm), and the first call's ms (cold); results equal to `workers: 1`'s
(encrypt: the same text once opened). Before: one worker started per call, one item a round trip.

| files | task | workers | items/s before | items/s now | first call ms before | now | peak RSS MB |
|---|---|---|---|---|---|---|---|
| small | extractText | 1 | 4762 | 4762 | 80 | 78 | 135 |
| small | extractText | 2 | 1923 | 5882 | 106 | 99 | 246 |
| small | extractText | 4 | 1754 | 6452 | 123 | 100 | 351 |
| small | merge | 1 | 2174 | 2128 | 137 | 136 | 148 |
| small | merge | 4 | 1299 | 3175 | 171 | 142 | 429 |
| small | encrypt | 1 | 284 | 288 | 733 | 738 | 171 |
| small | encrypt | 4 | 563 | 813 | 370 | 373 | 465 |
| large | extractText | 1 | 11 | 11 | 1906 | 1891 | 218 |
| large | extractText | 4 | 29 | 37 | 684 | 653 | 422 |
| large | merge | 1 | 143 | 135 | 224 | 220 | 176 |
| large | merge | 4 | 77 | 196 | 276 | 249 | 429 |
| large | encrypt | 1 | 149 | 155 | 213 | 212 | 181 |
| large | encrypt | 4 | 93 | 217 | 218 | 210 | 416 |

## Bundle size

Gzip (`gzip -9`) of the built files in `dist/`. `.` is `dist/index.js` (writer and reader); `./write` is `dist/write.js`
(writer only: `createPdf`, fonts, images, graphics, forms, standards, encryption, signing). fflate is a separate file
(`dist/fflate.js`) loaded on first use by either entry.

| entry | before (unminified) | after (minified) |
| --- | --- | --- |
| `.` (`dist/index.js`) | 166.8 KiB (170,811 B) | 133.4 KiB (136,583 B) |
| `./write` (`dist/write.js`) | not exported | 85.0 KiB (87,080 B) |
| `fflate` (`dist/fflate.js`) | 15.5 KiB (15,842 B) | 12.6 KiB (12,953 B) |

Import `@reportwright/pdf/write` when the code only writes PDFs: it leaves out the reader (`loadPdf`, `mergePdfs`) and
`bulk`. The two entries are separate bundles, so an app that imports both pays for the writer twice.

## Examples

| file | what it shows | run |
|---|---|---|
| [`write.mjs`](./examples/write.mjs) | text, a PNG, a table from paths, a link, bookmarks | `node examples/write.mjs out.pdf` |
| [`indic.mjs`](./examples/indic.mjs) | Devanagari shaped by HarfBuzz, Latin fallback | `node examples/indic.mjs NotoSansDevanagari-Regular.ttf out.pdf` |
| [`harfbuzz-shaper.mjs`](./examples/harfbuzz-shaper.mjs) | the harfbuzzjs shaper adapter (a module) | imported by `indic.mjs` |
| [`fill-form.mjs`](./examples/fill-form.mjs) | create, fill and flatten a form | `node examples/fill-form.mjs outDir` |
| [`encrypt.mjs`](./examples/encrypt.mjs) | AES-256 with permissions, read back | `node examples/encrypt.mjs out.pdf` |
| [`sign.mjs`](./examples/sign.mjs) | PAdES signature while streaming + countersignature | `node examples/sign.mjs key.pem cert.pem out.pdf` |
| [`accessible.mjs`](./examples/accessible.mjs) | PDF/UA-1 + PDF/A-2a | `node examples/accessible.mjs font.ttf out.pdf` |
| [`invoice-facturx.mjs`](./examples/invoice-facturx.mjs) | self-contained Factur-X PDF/A-3a invoice | `node examples/invoice-facturx.mjs font.ttf out.pdf` |
| [`factur-x.mjs`](./examples/factur-x.mjs) | Factur-X from your own CII XML | `node examples/factur-x.mjs invoice.xml font.ttf out.pdf` |
| [`merge-split.mjs`](./examples/merge-split.mjs) | merge, split, extractText, saveIncremental | `node examples/merge-split.mjs outDir` |
| [`bulk.mjs`](./examples/bulk.mjs) | extractText and encrypt over many files in worker threads | `node examples/bulk.mjs outDir` |
| [`render.js`](./examples/render.js) | pages to PNG with the experimental renderer | `node examples/render.js in.pdf outDir 2` |
| [`p12-signer.mjs`](./examples/p12-signer.mjs) | a `pdf.sign` signer from a PKCS#12 (.p12) file through `cmsSigner` (needs node-forge) | imported by your code |

Run from `node_modules/@reportwright/pdf` (or the package folder of the repository).

## Rendering (experimental)

`renderPage(doc, i, { scale })` draws a loaded page to RGBA pixels in pure JS (no canvas, no dependencies);
`toPng(result)` encodes it, `drawToCanvas(ctx, result)` puts it on a browser canvas. It draws paths, text in
embedded TrueType / CFF fonts, Flate, raw and JPEG images, clipping and form fields. The standard 14 fonts draw with
the optional `@reportwright/pdf-std-fonts` package (`fonts: stdFonts`; Liberation and Noto fonts, SIL OFL) or any
font you pass (`fonts: { default: ttfBytes }`). Shadings (all seven types), tiling patterns, blend modes, transparency groups and soft masks draw; Type 3 fonts are not drawn yet. What draws, and how close it is to pdf.js: [docs/RENDERER.md](./docs/RENDERER.md).

```js
const page = renderPage(await loadPdf(bytes), 0, { scale: 2 });
fs.writeFileSync('page.png', await toPng(page));
```

## Benchmarks

The QA benchmark suite (`qa/bench`, GitHub Actions run [38317309719](https://github.com/MrArun005/reportwright/actions/runs/38317309719),
2026-10-12, the 1.0 release measurement) measures `@reportwright/pdf` 0.1.0-beta.15 from npm (the same code as 1.0.0:
only the version and doc comments changed) against the other libraries of each task on the same runner. Time is wall
time from process start to exit (warm invoice: in-process median). Each row is our time and peak memory next to the
fastest library in that row. The suite's verdicts: **8 PASS, 10 WARN, 2 FAIL** of 20 rows. The losses are listed with
the wins.

| Task (size) | @reportwright/pdf | Fastest in the run | We are | Verdict |
|---|---|---|---|---|
| Writers: plain text pages (10) | 189 ms · 75 MB | printpdf (Rust) 77 ms | 2.46× slower, rank 3 of 13 | WARN |
| Writers: plain text pages (100) | 420 ms · 110 MB | fpdf (Go) 129 ms | 3.25× slower, rank 3 of 13 | FAIL |
| Writers: grouped report (100 rows) | 159 ms · 72 MB | fpdf (Go) 75 ms | 2.11× slower, rank 3 of 13 | WARN |
| Writers: grouped report (1,000 rows) | 240 ms · 79 MB | fpdf (Go) 102 ms | 2.35× slower, rank 3 of 13 | WARN |
| Writers: grouped report (10,000 rows) | 614 ms · 116 MB | fpdf (Go) 258 ms | 2.38× slower, rank 3 of 13 | WARN |
| Writers: invoice, cold process | 188 ms · 73 MB | printpdf (Rust) 75 ms | 2.49× slower, rank 4 of 13 | WARN |
| Writers: invoice, warm (50) | 8.5 ms · 130 MB | PDFsharp (.NET) 5.6 ms | 1.52× slower, rank 2 of 13 | WARN |
| Writers: Unicode (Hindi, Arabic, CJK) | 181 ms · 88 MB | fpdf (Go) 79 ms | 2.29× slower, rank 2 of 9 | WARN |
| Writers: images (6 MP PNG + 24 MP JPEG) | 991 ms · 197 MB | printpdf (Rust) 354 ms | 2.80× slower, rank 3 of 13 | WARN |
| Writers: PDF/A-2b invoice (veraPDF) | 185 ms · 73 MB | pdfkit (JS) 432 ms | 2.3× faster, rank 1 of 2 | PASS |
| Read: text of a 1,200-page PDF | 1206 ms · 120 MB | pdftotext (CLI) 795 ms | 1.52× slower, rank 3 of 14 | PASS |
| Read: 11 mixed real-world files | 208 ms · 79 MB | pdfium (CLI) 175 ms | 1.19× slower, rank 2 of 6 | PASS |
| Edit: merge 100 files | 182 ms · 80 MB | pdfcpu (Go) 68 ms | 2.67× slower, rank 8 of 15 | WARN |
| Edit: split 100 pages | 185 ms · 79 MB | pdfium (CLI) 110 ms | 1.68× slower, rank 9 of 15 | WARN |
| Edit: encrypt AES-256 | 136 ms · 76 MB | pdfcpu (Go) 44 ms | 3.07× slower, rank 5 of 10 | FAIL |
| Edit: incremental metadata change | 137 ms · 72 MB | PyMuPDF (Python) 159 ms | 1.16× faster, rank 1 of 6 | PASS |
| Edit: fill and flatten a form | 113 ms · 72 MB | PyMuPDF (Python) 154 ms | 1.36× faster, rank 1 of 7 | PASS |
| Edit: sign (PAdES/CMS, test certificate) | 111 ms · 72 MB | pdfbox (Java) 628 ms | 5.7× faster, rank 1 of 4 | PASS |
| Robustness: 25 fuzzed PDFs | 22 ok, 3 clean errors | no crash, hang or OOM | | PASS |
| Robustness: 6 hostile files | 4 ok, 2 clean errors | no crash, hang or OOM | | PASS |

The small-edit rows (metadata, form, sign) are close to the harness's Node process start-up floor (about 110 ms), so
they measure start-up as much as the work of each task.

In short: it is a fast JavaScript writer with flat memory, not the fastest PDF library. It is at or near the top on
PDF/A, signing and small edits in this run, and 1.5–3× behind the native and Go writers on plain and report output.
It is not the right tool for raw speed on repairs or large rewrites: MuPDF, qpdf and pdfcpu are faster there.

## vs Python

Medians from GitHub Actions run [38317309719](https://github.com/MrArun005/reportwright/actions/runs/38317309719) of [ReportWright](https://github.com/MrArun005/reportwright) (ubuntu-latest, all libraries interleaved in one job), the same build as the Benchmarks table. Wall time from process start (warm invoice: in-process) · peak memory. Full write-up: [JavaScript vs Python for PDFs](https://github.com/MrArun005/reportwright/blob/main/docs/compare/python.md).

| job | @reportwright/pdf | ReportLab | PyMuPDF | pypdf |
|---|---|---|---|---|
| Grouped report, 100 rows | **159 ms** · 72 MB | 199 ms · **33 MB** | 372 ms · 59 MB | — |
| Grouped report, 10,000 rows | **614 ms** · 116 MB | 2378 ms · **45 MB** | 13.17 s · 70 MB | — |
| Grouped report, 1,000,000 rows (older run [38108358497](https://github.com/MrArun005/reportwright/actions/runs/38108358497), 0.1.0-beta.12, not repeated for 1.0) | **29.07 s · 596 MB** | 215.17 s · 1292 MB | 1358.32 s · 1279 MB | — |
| Invoice, single | **188 ms** | 199 ms | 256 ms | — |
| Invoice, warm (50 in one process) | **8.5 ms** · 130 MB | 8.7 ms · **34 MB** | 54 ms · 60 MB | — |
| Extract text, 1,200 pages | **1206 ms** | — | 1426 ms | 5424 ms |
| Split 100 pages | 185 ms | — | 177 ms | 198 ms (pikepdf **132 ms**) |
| Fill and flatten a form | **113 ms** | — | 154 ms | 175 ms |

Faster than the Python libraries at report scale (V8's JIT on the layout loop, typed arrays, a streaming writer that drops each page once written). ReportLab uses the least memory at every size and is within a few per cent on one-page documents; pikepdf (qpdf underneath) is faster at merge, split and encryption.

## Options reference

Every option of the writer, the reader and the editing API (coordinates, fonts, pages, shaping, vector graphics, images, links, annotations, forms, encryption, signatures, tagged PDF, PDF/A, Factur-X, layers, reading and modifying) is documented in [docs/API.md](https://github.com/MrArun005/reportwright-pdf/blob/main/docs/API.md).

## Security model

Every input is budgeted, active content is stripped on read and can never be written, and the reader is hardened against malformed and hostile files. The full model, its guarantees and its limits are in [SECURITY.md](https://github.com/MrArun005/reportwright-pdf/blob/main/SECURITY.md).

## Known limits

- **Images**: image masks (stencils); embedded ICC profiles of PNG/JPEG files are ignored.
- **Text**: no Unicode bidi algorithm, no hyphenation, no kerning of the standard fonts, no WOFF fonts; text
  extraction is reading order, not layout-perfect. With `textMapping: 'actualText'`, readers that ignore ActualText
  or close it early (pdf.js; a tester saw an older MuPDF drop a line's last Bengali cluster) lose the spanned
  clusters: the writer closes every span after its cluster's last glyph, and MuPDF 1.28.2 (PyMuPDF) reads Bengali,
  Devanagari and the other test scripts whole.
- **Annotations**: no popup annotations.
- **Crypto**: RC4 is refused (read only); public-key (certificate) encryption is neither written nor read; signatures
  are listed with their coverage, but their cryptography is not verified.
- **Standards**: no PDF/A-1a or PDF/X; no attachment annotations in PDF/A-3 (use `pdf.attach`); a Factur-X invoice's
  content is not validated.
- **Editing**: no page edits in an incremental update (use `save()`).
- **Browsers**: reading encrypted files needs Node (WebCrypto has no synchronous AES).

See NOTES.md for the plan, and ARCHITECTURE.md for extending the library.

## Public API and stability

From 1.0.0 this package follows [semantic versioning](https://semver.org).

**What 1.0 promises** (the public API):

- The entry points `@reportwright/pdf` (`index.d.ts`), `@reportwright/pdf/write` (the writer without the reader,
  `write.d.ts`) and `@reportwright/pdf/fflate` (fflate as bundled here, `fflate.d.ts`), and `./examples/*` as files.
- Every name those type files declare, with the options documented in this README's [Options reference](#options-reference):
  `createPdf`, `toBytes`, `Page`, `loadPdf`, `mergePdfs`, `bulk`, `BULK_TASKS`, `nodeSigner`, `cmsSigner`, `readFont`,
  `checkSubset`, `svgPathOps`, `cmyk`, `STANDARD_NAMES`, `PdfReadError` (and its `code` values), `pdf.core`
  (`PdfCore`, the low-level extension API) and the option and result types.
- What a written file is: valid PDF of the declared version and conformance (PDF/A, PDF/UA, Factur-X) as documented.
  The exact bytes are not part of the API (compression, object order and subsets may change in a minor, the rendered
  page and extracted text do not).
- The security model's limits and `PdfReadError` codes.

**Not public:** `__bulkWorker` (`@internal`: the bulk worker's entry, exported only so the worker can load it from the
same bundle), anything reached through `dist/` or `src/` by path, and the text-position internals of the reader.

**Rules:** breaking changes only in a major release, listed under [Changes](#changes) with their replacement and
deprecated (typed `@deprecated`, noted here) for at least one minor release first. Security fixes may change
behaviour in a patch release when that is what closes the hole (for example a tighter read budget); the change note
says so.

## Releasing

Releases are published to npm by GitHub Actions from a GitHub Release (tag `v<version>`). The one-time `NPM_TOKEN`
setup and the steps are in [RELEASING.md](./RELEASING.md).

## Changes

1.0.0: the first stable release; the API is the one in [Public API and stability](#public-api-and-stability). No
behaviour change from 0.1.0-beta.15. `__bulkWorker` is marked `@internal` (it was already documented as internal).

Upgrading from the betas: install without a tag (`npm i @reportwright/pdf`, `latest` is 1.0.0; `next` was the beta
line) and pin `^1.0.0`. From before beta.14: a check box's `doc.fields` value is `true`/`false`, its on-state name is
`onValue`. From before beta.13: built-in TrueType subsets renumber glyphs (a subsetter function and `core` keep glyph
IDs). From before beta.11: `SignatureOptions` `page`, `width` and `height` are optional and `@reportwright/pdf/write`
exists. Nothing exported by beta.15 was removed.

0.1.0-beta.15 (performance; no output change except the xref stream's compressed bytes): the xref stream is compressed
by Node's zlib (CompressionStream or fflate elsewhere) instead of always loading fflate, so a cold one-page PDF takes
26.3 ms instead of 32.7 ms (laptop, whole process from import); with `objectStreamLevel` unset the file is now the same
as at level 6. Unkerned left-to-right text with an embedded font is encoded through a per-font table (charCodeAt, no
string-keyed Map per character), the same bytes: 500-line pages 0.25 → 0.18 ms a page (−27%).

0.1.0-beta.14: `doc.fields` reads a check box's `value` as `true`/`false` (was its state name, `'Yes'`/`'Off'`),
with the on-state name as `onValue`; `Page` and the internal `__bulkWorker` are declared in `index.d.ts`;
`examples/invoice-facturx.mjs` embeds a complete EN 16931 invoice (line items, VAT breakdown, payment terms) that CI
checks against the Factur-X XSD; the README notes pypdf's and MuPDF's Indic extraction quirks.

0.1.0-beta.13: the built-in TrueType subset renumbers its glyphs and drops the tables a PDF does not read (`name`,
`OS/2`, `gasp`; OpenType/CFF also drops `name` and `OS/2`): a 19-character DejaVu Sans line is 6.5 KB, was 20.2 KB.
Renders and extracted text are unchanged. A subsetter function, and `core`, still keep glyph IDs.

0.1.0-beta.13: the README's benchmarks (wins and losses) were published with the package; they were beta.12's GitHub run. They are superseded by the QA run in [Benchmarks](#benchmarks).

0.1.0-beta.12: the build no longer keeps function names. esbuild's `keepNames` wrapped every closure in an `Object.defineProperty` call, which made writing about 35% slower (10,000 lines 182 → 117 ms). `PdfReadError` sets its own name; stacks map through the sourcemap.

0.1.0-beta.11: `pdf.core`, the low-level API under `createPdf`, is documented (`PdfCore` in the types), with
`core.imageResource`; encryption now covers every literal and hex string in direct objects (it leaked some and threw
on others); `readFont` and `checkSubset` read a font's metrics and check a subset before embedding; form fields take
a caller's `appearance`, `da`, `structParent` and `widgetRef`; a document whose pages were written through `core` can
be signed (an invisible field), with a PKCS#12 example (`examples/p12-signer.mjs`); `svgPathOps` turns SVG path data
into path operators; the build is minified, and `@reportwright/pdf/write` exports the writer without the reader; the
`page`, `width` and `height` of `SignatureOptions` are optional.
It includes everything from beta.9 and beta.10.

0.1.0-beta.10: a WritableStream's writer lock is released when the export ends, fails or is stopped (`timeoutMs`,
`signal`), so the caller can reuse or cancel the stream; the abort reason is still the original error.

0.1.0-beta.9: stamping every page (`page.draw` then `save()`) is about 35% faster on a 1,000-page file: a page's open
graphics states are counted with a byte scan instead of a full parse, and FlateDecode inflates whole, valid zlib
streams with Node's zlib (damaged, truncated, raw or over-budget streams still go through fflate as before); the output
is byte-identical. `bulk` starts an item's `itemTimeoutMs` clock when its worker is ready, so a respawned worker's
start-up no longer fails good files; a stopped export (`timeoutMs` or `signal`) aborts its WritableStream even when
the stop lands between two calls.

0.1.0-beta.2: a left-to-right shaped cluster in an ActualText span has its text only in the ActualText, so MuPDF
no longer reads it twice (pdf.js, which ignores ActualText, now misses those clusters; poppler, PDFium and
`extractText` read them); `extractText` drops WJ (U+2060) and reads a code a ToUnicode skips as nothing (U+FFFD
only when the font has no mapping at all); `@reportwright/pdf/examples/*` can be imported.

0.1.0-beta.1: shaped text (Indic, Arabic) extracts once and in order in pdf.js, poppler and `extractText`;
`extractText` honours ActualText, reads unmapped glyphs as U+FFFD, falls back to an embedded TrueType cmap, spaces
separate text objects (spreadsheet cells), orders a line along its baseline (rotated text too), and stops a
2 M-operator page at 170 MB (`maxTextItems` 1 M); standard-font text writes 40% faster; variable fonts warn; the
package ships `examples/`. The list with details: NOTES.md ("Changes") in the repository.
