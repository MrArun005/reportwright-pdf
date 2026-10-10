// Group D annotations: notes with replies, text markup, FreeText, shapes, ink, stamps and file attachments. pdf-lib reads
// each one's subtype, rect, contents, flags and entries; pdftoppm shows the appearance streams render (a highlight's
// colour behind its text, a stamp, a FreeText box); pdfdetach finds the attachment; veraPDF UA-1 and A-2b pass.
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { PDFName, PDFDict, PDFRawStream } from 'pdf-lib';
import { unzlibSync } from 'fflate';
import { toBytes, createPdf } from '../src/index.js';
import { INTER, HAS, verapdf, run, save, pdftotext } from './tools.js';
import { load, annots, get } from './nav-tools.js';
import { color } from './nav-tools.js';

const DATE = new Date('2026-01-01');
const MOD = new Date('2026-02-03T04:05:06Z');
const CSV = new TextEncoder().encode('name,amount\nAda,12\n');

/** one page of every annotation (tagged: each inside a P or on its own) */
async function every(pdf, { attach = true } = {}) {
  const f = await pdf.embedFont(INTER);
  const p = pdf.addPage({ width: 600, height: 800 });
  const T = (t, fn) => p.tag(t, fn);
  T('P', () => p.text('Highlighted words in a line', { x: 40, y: 40, font: f, size: 14 }));
  p.highlight({ x: 30, y: 38, width: 140, height: 20 }, { contents: 'Highlight', author: 'Ada', modified: MOD });
  p.underline([{ x: 40, y: 70, width: 80, height: 14 }, { x: 40, y: 86, width: 50, height: 14 }], { contents: 'Underline' });
  p.strikeOut({ x: 40, y: 110, width: 80, height: 14 }, { contents: 'Strike out' });
  p.squiggly({ x: 40, y: 130, width: 80, height: 14 }, { contents: 'Squiggly' });
  const n = p.note(300, 40, { contents: 'Please check', icon: 'Comment', open: true, author: 'Ada' });
  p.note(330, 40, { contents: 'Checked', replyTo: n, author: 'Bo', icon: 'Note' });
  p.freeText('Remember to sign the second page.', { x: 40, y: 170, width: 160, height: 50, font: f, size: 11, background: '#ddeeff', border: { width: 2, color: '#0000cc' }, align: 'center' });
  p.markup('Square', { x: 230, y: 170, width: 60, height: 40 }, { contents: 'Box', interior: '#ffdddd', color: '#cc0000', lineWidth: 2 });
  p.markup('Circle', { x: 310, y: 170, width: 60, height: 40 }, { contents: 'Ring', dash: [3, 2] });
  p.markup('Line', { x1: 40, y1: 250, x2: 200, y2: 270 }, { contents: 'Arrow', lineEndings: ['Butt', 'OpenArrow'], lineWidth: 1.5 });
  p.markup('Polygon', [[230, 250], [290, 250], [260, 290]], { contents: 'Triangle', interior: '#ddffdd' });
  p.markup('PolyLine', [[310, 250], [340, 280], [370, 250]], { contents: 'Zigzag', lineEndings: ['Circle', 'ClosedArrow'] });
  p.markup('Ink', [[[40, 310], [60, 330], [80, 310]], [[90, 310], [110, 330]]], { contents: 'Signature', color: '#0000cc' });
  p.stamp({ x: 230, y: 310, width: 150, height: 40, name: 'Approved', font: f });
  p.stamp({ x: 400, y: 310, width: 80, height: 40, contents: 'Seal', draw: (ap) => ap.fill(ap.path().arc(40, 20, 18, 0, 2 * Math.PI), { fill: '#33aa33' }) });
  T('Link', () => { p.text('Go to the end', { x: 40, y: 380, font: f }); p.link(40, 380, 90, 16, { dest: 'end' }, { alt: 'Go to the end' }); });
  p.link(40, 400, 90, 16, { url: 'https://example.com/report' }, { alt: 'The report online' });
  if (attach) p.attachFile(CSV, { x: 500, y: 40, name: 'data/figures.csv', mimeType: 'text/csv', description: 'The figures', created: DATE, modified: MOD });
  pdf.destination('end', 1, { top: 380 });
  return p;
}

describe('annotations', () => {
  it('pdf-lib reads every annotation: subtype, rect, contents, flags and its entries; each has an appearance stream', async () => {
    const out = await toBytes(every, { creationDate: DATE });
    const doc = await load(out);
    const list = annots(doc);
    const by = (s) => list.filter((a) => get(a, 'Subtype') === s);
    expect(list.map((a) => get(a, 'Subtype'))).toEqual(['/Highlight', '/Underline', '/StrikeOut', '/Squiggly', '/Text', '/Text', '/FreeText', '/Square', '/Circle', '/Line', '/Polygon', '/PolyLine', '/Ink', '/Stamp', '/Stamp', '/Link', '/Link', '/FileAttachment']);
    for (const a of list) {
      const sub = get(a, 'Subtype');
      expect(get(a, 'Rect')).toHaveLength(4);
      expect(get(a, 'Contents')).toBeTruthy();
      if (sub !== '/Link') {
        const ap = a.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'));
        expect(ap).toBeInstanceOf(PDFRawStream);
        expect(get(ap.dict, 'Subtype')).toBe('/Form');
        const [x0, y0, x1, y1] = get(a, 'Rect');
        expect(get(ap.dict, 'BBox').map((v) => Math.round(v))).toEqual([0, 0, Math.round(x1 - x0), Math.round(y1 - y0)]);
        expect(get(a, 'P', 0)).toBe(`${doc.getPage(0).ref.objectNumber} R`);
      }
    }
    const [hl] = by('/Highlight');
    expect(get(hl, 'Rect')).toEqual([30, 742, 170, 762]);
    expect(get(hl, 'QuadPoints')).toEqual([30, 762, 170, 762, 30, 742, 170, 742]);
    expect(get(hl, 'F')).toBe(4);
    expect(get(hl, 'T')).toBe('Ada');
    expect(get(hl, 'Contents')).toBe('Highlight');
    expect(get(hl, 'M')).toBe("D:20260203040506+00'00'");
    expect(get(hl, 'C')).toEqual([1, 0.922, 0.231]);
    expect(get(by('/Underline')[0], 'QuadPoints')).toHaveLength(16);
    const [n1, n2] = by('/Text');
    expect(get(n1, 'Name')).toBe('/Comment');
    expect(get(n1, 'Open')).toBe(true);
    expect(get(n1, 'F')).toBe(4 | 8 | 16); // print, noZoom, noRotate
    expect(get(n1, 'Rect')).toEqual([300, 740, 320, 760]);
    expect(get(n2, 'IRT', 0)).toBe(`${doc.context.getObjectRef(n1).objectNumber} R`);
    expect(get(n2, 'RT')).toBe('/R');
    const [ft] = by('/FreeText');
    expect(get(ft, 'Contents')).toBe('Remember to sign the second page.');
    expect(get(ft, 'DA')).toMatch(/^\/\w+ 11 Tf 0 g$/);
    expect(get(ft, 'Q')).toBe(1);
    expect(get(ft, 'C')).toEqual([0.867, 0.933, 1]);
    const [sq] = by('/Square');
    expect(get(sq, 'IC')).toEqual([1, 0.867, 0.867]);
    expect(get(sq, 'BS')).toEqual({ W: 2, S: '/S' });
    expect(get(by('/Circle')[0], 'BS')).toEqual({ W: 1, S: '/D', D: [3, 2] });
    const [ln] = by('/Line');
    expect(get(ln, 'L')).toEqual([40, 550, 200, 530]);
    expect(get(ln, 'LE')).toEqual(['/Butt', '/OpenArrow']);
    expect(get(by('/Polygon')[0], 'Vertices')).toEqual([230, 550, 290, 550, 260, 510]);
    expect(get(by('/PolyLine')[0], 'LE')).toEqual(['/Circle', '/ClosedArrow']);
    expect(get(by('/Ink')[0], 'InkList')).toEqual([[40, 490, 60, 470, 80, 490], [90, 490, 110, 470]]);
    const [st, seal] = by('/Stamp');
    expect(get(st, 'Name')).toBe('/Approved');
    expect(get(st, 'Contents')).toBe('Approved');
    expect(get(seal, 'Name')).toBeNull();
    expect(get(seal, 'Contents')).toBe('Seal');
  });

  it('a file attachment carries its file: a Filespec with F/UF/Desc and an EmbeddedFile with MIME type, size, MD5 and dates', async () => {
    const out = await toBytes(every, { creationDate: DATE });
    const doc = await load(out);
    const fa = annots(doc).find((a) => get(a, 'Subtype') === '/FileAttachment');
    expect(get(fa, 'Name')).toBe('/PushPin');
    const fs = fa.lookup(PDFName.of('FS'), PDFDict);
    expect(get(fs, 'F')).toBe('figures.csv'); // the directory part is dropped
    expect(get(fs, 'UF')).toBe('figures.csv');
    expect(get(fs, 'Desc')).toBe('The figures');
    const ef = fs.lookup(PDFName.of('EF'), PDFDict).lookup(PDFName.of('F'));
    expect(get(ef.dict, 'Subtype')).toBe('/text#2Fcsv'); // the name text/csv, its slash escaped
    const params = get(ef.dict, 'Params');
    expect(params.Size).toBe(CSV.length);
    expect(params.ModDate).toBe("D:20260203040506+00'00'");
    expect(params.CreationDate).toBe("D:20260101000000+00'00'");
    const data = Buffer.from(unzlibSync(ef.getContents()));
    expect(data.toString()).toBe('name,amount\nAda,12\n');
    expect(Buffer.from(ef.dict.get(PDFName.of('Params')).get(PDFName.of('CheckSum')).asBytes()).toString('hex')).toBe(crypto.createHash('md5').update(CSV).digest('hex'));
    if (!HAS.poppler) return;
    const file = save(out);
    expect(run('pdfdetach', ['-list', file])).toMatch(/1: figures\.csv/);
    const dest = `${file}.csv`;
    run('pdfdetach', ['-save', '1', '-o', dest, file]);
    expect((await import('node:fs')).readFileSync(dest, 'utf8')).toBe('name,amount\nAda,12\n');
  });

  it('the appearance streams render: the highlight colour is behind its text, the stamp, the FreeText box, the note icon', async () => {
    if (!HAS.poppler) return;
    const out = await toBytes(every, { creationDate: DATE });
    const img = color(out);
    const yellow = ([r, g, b]) => r > 200 && g > 200 && b < 120, dark = ([r, g, b]) => r < 110 && g < 110 && b < 110;
    let y = 0, d = 0;
    for (let py = 38; py < 58; py++) for (let px = 30; px < 170; px++) { const c = img.rgb(px, py); if (yellow(c)) y++; if (dark(c)) d++; }
    expect(y).toBeGreaterThan(1000); // the highlight fills most of its box
    expect(d).toBeGreaterThan(50); // the text shows through (Multiply), not covered
    expect(yellow(img.rgb(33, 48))).toBe(true);
    const count = (x0, y0, x1, y1, f) => { let k = 0; for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) if (f(img.rgb(px, py))) k++; return k; };
    expect(count(230, 310, 380, 350, ([r, g, b]) => r > 150 && g < 90 && b < 90)).toBeGreaterThan(400); // the red stamp: border and label
    expect(img.rgb(235, 330)).toEqual([255, 255, 255]); // inside the stamp's border, before its label: page white
    expect(count(400, 310, 480, 350, ([r, g, b]) => g > 140 && r < 90 && b < 90)).toBeGreaterThan(800); // the custom seal
    const bg = img.rgb(45, 215);
    expect(bg[2]).toBeGreaterThan(240); expect(bg[0]).toBeGreaterThan(200); expect(bg[0]).toBeLessThan(235); // the FreeText background
    expect(count(40, 170, 200, 172, ([r, g, b]) => b > 150 && r < 60 && g < 60)).toBeGreaterThan(100); // its blue border
    expect(count(55, 180, 185, 210, dark)).toBeGreaterThan(30); // its text
    expect(count(300, 40, 320, 60, ([r, g, b]) => r > 200 && g > 180 && b < 120)).toBeGreaterThan(100); // the note's yellow icon
    expect(count(230, 170, 290, 210, ([r, g, b]) => r > 230 && g > 200 && g < 235 && b > 200 && b < 235)).toBeGreaterThan(1000); // the square's pink interior
  });

  it('flags: hidden, noView, locked; PDF/A refuses invisible annotations and attachments; unknown flags throw', async () => {
    const out = await toBytes(async (pdf) => {
      const p = pdf.addPage();
      p.note(10, 10, { contents: 'x', flags: { hidden: true, print: false, locked: true } });
      p.highlight({ x: 0, y: 0, width: 9, height: 9 }, { contents: 'y', flags: { noView: true, readOnly: true } });
    }, { creationDate: DATE });
    const [a, b] = annots(await load(out));
    expect(get(a, 'F')).toBe(2 | 8 | 16 | 128);
    expect(get(b, 'F')).toBe(4 | 32 | 64);
    const f = await (async () => { const pdf = createPdf({ write() {} }, { pdfa: true }); const font = await pdf.embedFont(INTER); return { pdf, font, p: pdf.addPage() }; })();
    expect(() => f.p.note(0, 0, { flags: { hidden: true } })).toThrow(/PDF\/A annotations are printed and visible/);
    expect(() => f.p.highlight({ x: 0, y: 0, width: 1, height: 1 }, { flags: { print: false } })).toThrow(/PDF\/A/);
    expect(() => f.p.attachFile(CSV, { name: 'a.csv' })).toThrow(/PDF\/A-2 does not allow attachments/);
    expect(() => f.p.note(0, 0, { flags: { javascript: true } })).toThrow(/unknown flag/);
  });

  it('checks input: icons, stamp names, line endings, point counts, colours, forged handles; tagged PDFs need contents', async () => {
    const pdf = createPdf({ write() {} });
    const font = await pdf.embedFont(INTER), p = pdf.addPage();
    expect(() => p.note(0, 0, { icon: 'Skull' })).toThrow(/icon is one of/);
    expect(() => p.stamp({ width: 10, height: 10, name: 'Paid', font })).toThrow(/name is one of/);
    expect(() => p.stamp({ width: 10, height: 10, name: 'Draft' })).toThrow(/pass font/);
    expect(() => p.stamp({ width: 10, height: 10, font: { name: 'F1 /JavaScript' } })).toThrow(/Not a font/);
    expect(() => p.markup('Line', { x1: 0, y1: 0, x2: 9, y2: 9 }, { lineEndings: ['None', 'Rocket'] })).toThrow(/lineEndings/);
    expect(() => p.markup('Polygon', [[0, 0], [1, 1]])).toThrow(/at least 3 points/);
    expect(() => p.markup('Star', [])).toThrow(/type is Square/);
    expect(() => p.highlight([])).toThrow(/1–10000 rectangles/);
    expect(() => p.highlight({ x: 0, y: 0, width: 5, height: 5 }, { color: pdf.spotColor('Gold', '#cc9900') })).toThrow(/not a spot or ICC colour/);
    expect(() => p.note(0, 0, { replyTo: { type: 'annotation' } })).toThrow(/Not an annotation made by this library/);
    expect(() => p.freeText('x', { width: 10, height: 10 })).toThrow(/Not a font/);
    expect(() => p.attachFile('text', { name: 'a.txt' })).toThrow(/Uint8Array/);
    expect(() => p.attachFile(CSV, { name: 'a\n.txt' })).toThrow(/control, format, bidi or Windows-invalid character/);
    expect(() => p.attachFile(CSV, { name: 'a.csv', mimeType: 'text/csv /JS' })).toThrow(/mimeType/);
    expect(() => p.stamp({ width: 10, height: 10, draw: async () => {} })).toThrow(/synchronously/);
    expect(() => p.stamp({ width: 10, height: 10, draw: (ap) => ap.note(0, 0) })).toThrow(/cannot be used in an annotation's appearance/);
    const t = createPdf({ write() {} }, { title: 'T', tagged: true });
    expect(() => t.addPage().note(0, 0)).toThrow(/tagged PDF \(PDF\/UA\) needs contents/);
  });

  it('tagged: an Annot element with an OBJR for each annotation, a Link for links; /Tabs /S; StructParent', async () => {
    const out = await toBytes((pdf) => every(pdf, { attach: true }), { creationDate: DATE, title: 'Annotated', tagged: { lang: 'en' } });
    const doc = await load(out);
    const root = doc.catalog.lookup(PDFName.of('StructTreeRoot'), PDFDict);
    const kids = root.lookup(PDFName.of('K'), PDFDict).lookup(PDFName.of('K')).asArray().map((r) => doc.context.lookup(r, PDFDict));
    const S = kids.map((k) => get(k, 'S'));
    expect(S.filter((s) => s === '/Annot')).toHaveLength(16);
    expect(S.filter((s) => s === '/Link')).toHaveLength(2);
    const list = annots(doc);
    const keys = new Set(list.map((a) => get(a, 'StructParent')));
    expect(keys.size).toBe(list.length);
    const annotEl = kids.find((k) => get(k, 'S') === '/Annot');
    const objr = get(annotEl, 'K', 2)[0];
    expect(objr.Type).toBe('/OBJR');
    expect(doc.getPage(0).node.get(PDFName.of('Tabs')).toString()).toBe('/S');
    if (HAS.poppler) expect(pdftotext(out)).toMatch(/Highlighted words in a line/);
  });
});

describe.skipIf(!HAS.verapdf)('veraPDF', () => {
  it('a tagged PDF/A page with links, notes, highlights, FreeText, shapes and stamps passes PDF/UA-1 and PDF/A-2b', async () => {
    const out = await toBytes((pdf) => every(pdf, { attach: false }), { creationDate: DATE, title: 'Reviewed report', tagged: { lang: 'en' }, pdfa: true });
    const ua = verapdf(out, 'ua1'), a = verapdf(out, '2b');
    expect(ua.failed).toEqual([]);
    expect(a.failed).toEqual([]);
    expect(ua.ok && a.ok).toBe(true);
  }, 60000);

  it('PDF/UA-1 with a file attachment (no PDF/A) passes', async () => {
    const out = await toBytes((pdf) => every(pdf, { attach: true }), { creationDate: DATE, title: 'With a file', tagged: { lang: 'en' } });
    expect(verapdf(out, 'ua1').failed).toEqual([]);
  }, 60000);
});
