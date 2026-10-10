// Run by hostile-reader-review.test.js in its own process (a time limit and --max-old-space-size): an input that can
// exhaust the heap kills the process, which no in-process test survives. argv[2] names the case; it prints one JSON
// line { code, ms, text? } (code: 'OK' or the PdfReadError code).
import fs from 'node:fs';
import { deflateSync } from 'node:zlib';
import { loadPdf } from '../src/index.js';

/** a PDF of numbered objects: { n: text | { dict, data } } */
function build(objs) {
  const parts = [];
  let pos = 0;
  const push = (s) => {
    const b = typeof s === 'string' ? Buffer.from(s, 'latin1') : Buffer.from(s);
    parts.push(b);
    pos += b.length;
  };
  push('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
  const offs = {};
  const nums = Object.keys(objs)
    .map(Number)
    .sort((a, b) => a - b);
  for (const n of nums) {
    offs[n] = pos;
    const o = objs[n];
    if (typeof o === 'string') push(`${n} 0 obj\n${o}\nendobj\n`);
    else {
      push(`${n} 0 obj\n${o.dict.replace(/>>\s*$/, `/Length ${o.data.length} >>`)}\nstream\n`);
      push(o.data);
      push('\nendstream\nendobj\n');
    }
  }
  const max = Math.max(...nums),
    xat = pos;
  let x = `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= max; i++)
    x += offs[i] != null ? `${String(offs[i]).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n';
  push(`${x}trailer\n<< /Size ${max + 1} /Root 1 0 R >>\nstartxref\n${xat}\n%%EOF\n`);
  return new Uint8Array(Buffer.concat(parts));
}
const doc = (page, content, more) =>
  build({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R ${page} >>`,
    4: { dict: '<< >>', data: Buffer.from(content) },
    ...more,
  });
const cmap = (body) => ({
  dict: '<< /Filter /FlateDecode >>',
  data: deflateSync(
    Buffer.from(
      `/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <00> <FF> endcodespacerange\n${body} endcmap end end`,
    ),
  ),
});

const CASES = {
  // R1: a bfrange over 65,536 codes with a 20,000-byte destination: 1.3 GB of strings from an 831-byte file
  'cmap-long-dst': () => [
    doc('/Resources << /Font << /F1 5 0 R >> >>', 'BT /F1 12 Tf 10 10 Td (A) Tj ET', {
      5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>',
      6: cmap(`1 beginbfrange <0000> <FFFF> <${'4e01'.repeat(10000)}> endbfrange`),
    }),
    { timeoutMs: 5000 },
  ],
  // R1: destinations short enough to pass, but 65,536 × 64 code units: past the characters one CMap may hold
  'cmap-chars': () => [
    doc('/Resources << /Font << /F1 5 0 R >> >>', 'BT /F1 12 Tf 10 10 Td (A) Tj ET', {
      5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>',
      6: cmap(`1 beginbfrange <0000> <FFFF> <${'4e01'.repeat(64)}> endbfrange`),
    }),
    {},
  ],
  // R1: 200 fonts, each CMap just under the per-CMap cap: past what one extraction may hold
  'cmap-many-fonts': () => {
    const more = {},
      fonts = [];
    let content = 'BT 10 10 Td ';
    for (let i = 0; i < 200; i++) {
      more[5 + 2 * i] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode ${6 + 2 * i} 0 R >>`;
      more[6 + 2 * i] = cmap(`1 beginbfrange <0000> <FFFF> <${'4e01'.repeat(60)}> endbfrange`);
      fonts.push(`/F${i} ${5 + 2 * i} 0 R`);
      content += `/F${i} 12 Tf (A) Tj `;
    }
    return [doc(`/Resources << /Font << ${fonts.join(' ')} >> >>`, `${content}ET`, more), {}];
  },
  // R2: /W [0 65535 500] 20,000 times (240 KB): 65,536 Map.set each, none a budget step (30 s, timeoutMs 1000 ignored)
  'w-ranges': () => [type0(`/W [${'0 65535 500 '.repeat(20000)}]`), { timeoutMs: 1000 }],
  // R2: /W [0 7 0 R …] where 7 is an array of 60,000 widths, 2,000 times
  'w-arrays': () => [type0(`/W [${'0 7 0 R '.repeat(2000)}]`, { 7: `[${'500 '.repeat(60000)}]` }), { timeoutMs: 1000 }],
  // R2 (the audit): a /Kids array of 20,000 page-tree nodes, each with that same /Kids: every kid pushed again at
  // every level (400 M entries)
  'page-tree-shared-kids': () => {
    const L = 20000,
      more = { 1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids 3 0 R /Count 1 >>' };
    more[3] = `[${Array.from({ length: L }, (_, i) => `${4 + i} 0 R`).join(' ')}]`;
    for (let i = 0; i < L; i++) more[4 + i] = '<< /Type /Pages /Kids 3 0 R >>';
    return [build(more), { timeoutMs: 10000 }];
  },
  // R3: an unfiltered form XObject of a 64 KB Tj drawn 100,000 times: its bytes never counted against maxDecoded
  'forms-unfiltered': () => [forms(100000, 'A'.repeat(1 << 16)), { budget: { maxDecoded: 4 << 20 } }],
  // R3: a tiny form drawn 20,000 times: past the cap on form XObjects an extraction draws
  'forms-many': () => [forms(20000, ''), {}],
  // R3: one Tj of a 16 MB string, timeoutMs 300: the glyphs were no budget steps (and were 16 M objects at once)
  'glyphs-one-string': () => [
    doc('/Resources << /Font << /F1 6 0 R >> >>', `BT /F1 1 Tf (${'A'.repeat(16 << 20)}) Tj ET`, { 6: FONT }),
    { timeoutMs: 300 },
  ],
  // R8: 80,000 streams, each hiding an unreadable object stream in its data: the whole-file check asked, per hidden
  // object, whether it lies in stream data by scanning every stream (quadratic)
  regions: () => {
    const more = {
      1: '<< /Type /Catalog /Pages 2 0 R >>',
      2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>',
    };
    for (let i = 0; i < 80000; i++)
      more[4 + i] = {
        dict: '<< >>',
        data: Buffer.from(`\n${900000 + i} 0 obj << /Type /ObjStm /N -1 /First 0 /Length 1 >> stream\nx\nendstream\n`),
      };
    return [build(more), {}, (d) => d.saveIncremental().then((r) => `${r.warnings}`)];
  },
  // an /ActualText in one object, used by 10,000 spans: 1 MB (past the 4,096 a span may have: ignored, the glyphs read)
  'actualtext-1mb': () => [
    actual(1 << 20, '/Span << /ActualText 5 0 R >> BDC (A) Tj EMC\n'.repeat(10000)),
    {},
    (d) => `${d.page(0).extractText().length} ${d.warnings}`,
  ],
  // 4,000 characters (read) used 10,000 times: past the characters an extraction may make (E_BUDGET)
  'actualtext-4k': () => [actual(4000, '/Span << /ActualText 5 0 R >> BDC (A) Tj EMC\n'.repeat(10000)), {}],
  // 10,000 nested spans: the outermost one is read, once
  'actualtext-nested': () => [
    actual(4000, `${'/Span << /ActualText 5 0 R >> BDC\n'.repeat(10000)}(A) Tj${'\nEMC'.repeat(10000)}`),
    {},
    (d) => String(d.page(0).extractText().length),
  ],
  // 150 Identity-H fonts with no ToUnicode, each its own (compressed) copy of a 300 KB TrueType program: the cmap
  // fallback reads at most 100 font programs (E_BUDGET past them)
  'cmap-fonts-many': () => noToUnicode(150, false),
  // 1,000 such fonts sharing one program: it is read once, the text comes out
  'cmap-fonts-shared': () => noToUnicode(1000, true),
};
function noToUnicode(n, shared) {
  const prog = {
    dict: '<< /Filter /FlateDecode >>',
    data: deflateSync(fs.readFileSync(new URL('../public/fonts/Inter-Regular.ttf', import.meta.url))),
  };
  const more = {},
    fonts = [];
  let content = 'BT ';
  for (let i = 0; i < n; i++) {
    const o = 10 + 3 * i;
    more[o] = `<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [${o + 1} 0 R] >>`;
    more[o + 1] =
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /CIDToGIDMap /Identity /FontDescriptor ${o + 2} 0 R >>`;
    more[o + 2] = `<< /Type /FontDescriptor /FontName /X /FontFile2 ${shared ? 9 : o + 3 * n + 3} 0 R >>`;
    if (!shared) more[o + 3 * n + 3] = prog;
    fonts.push(`/F${i} ${o} 0 R`);
    content += `/F${i} 10 Tf 10 ${10 + (i % 50) * 12} Td <0002> Tj `; // glyph 2: "A" in Inter
  }
  if (shared) more[9] = prog;
  return [
    doc(`/Resources << /Font << ${fonts.join(' ')} >> >>`, `${content}ET`, more),
    {},
    (d) => {
      const t = d.page(0).extractText();
      return `${t.length} ${t.slice(0, 3)}`;
    },
  ];
}
function actual(n, body) {
  return doc('/Resources << /Font << /F1 6 0 R >> >>', `BT /F1 1 Tf ${body} ET`, {
    5: `(${'x'.repeat(n)})`,
    6: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  });
}
const FONT = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding << /Differences [65 /.notdef] >> >>';
function forms(n, text) {
  return doc('/Resources << /XObject << /X 5 0 R >> >>', '/X Do\n'.repeat(n), {
    5: {
      dict: '<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << /Font << /F1 6 0 R >> >> >>',
      data: Buffer.from(`BT /F1 1 Tf (${text}) Tj ET`),
    },
    6: FONT,
  });
}
function type0(w, more = {}) {
  return doc('/Resources << /Font << /F1 5 0 R >> >>', 'BT /F1 12 Tf 10 10 Td <0041> Tj ET', {
    5: '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [6 0 R] >>',
    6: `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X ${w} >>`,
    ...more,
  });
}

const [bytes, o, run = (d) => d.page(0).extractText()] = CASES[process.argv[2]]();
const t = Date.now();
let r;
try {
  const d = await loadPdf(bytes, o);
  const text = await run(d);
  r = { code: 'OK', text: text.slice(0, 200) };
} catch (e) {
  r = { code: e.code ?? e.name, message: String(e.message).slice(0, 300) };
}
console.log(JSON.stringify({ ...r, ms: Date.now() - t }));
