// Group H modifying: every change written through save() (a full rewrite) or saveIncremental(), then checked with
// poppler (pdftotext, pdfinfo, pdfimages -list, pdfdetach -list, pdftoppm pixels, pdfsig), pdf-lib (it parses the
// output; form values), qpdf through pikepdf (PIKEPDF_PY: no syntax or stream errors) and veraPDF (a merged PDF/A).
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { toBytes, loadPdf, mergePdfs, nodeSigner } from '../src/index.js';
import { HAS, INTER, run, save, DIR, gray, verapdf } from './tools.js';
import { seeds, rawPdf, onePage, enc, qpdfCheck, PY } from './reader-tools.js';
import { png } from './image-fixtures.js';

const D = new Date('2026-01-01');
const text = (b, ...a) => run('pdftotext', [...a, save(b), '-']).replace(/\s+/g, ' ').trim();
const pages = (b) => Number(/Pages:\s+(\d+)/.exec(run('pdfinfo', [save(b)]))[1]);
/** pdf-lib parses it; qpdf (pikepdf) finds no error */
async function sound(b, password) {
  await PDFDocument.load(b, { ignoreEncryption: true });
  if (PY) expect(qpdfCheck(b, password)).toEqual([]);
}
let S;
beforeAll(async () => { S = await seeds(); });

describe('merge, split, reorder, rotate', () => {
  (HAS.poppler ? it : it.skip)('merge ours, a form, pdf-lib\'s and an image page: same text, pages, images and attachments', async () => {
    const icon = png({ w: 8, h: 8, type: 2, depth: 8, px: (x, y) => [x * 30, y * 30, 128] });
    const img = await toBytes(async (pdf) => { const i = await pdf.embedImage(icon); const p = pdf.addPage({ width: 200, height: 200 }); p.image(i, { x: 10, y: 10, width: 50 }); p.image(i, { x: 80, y: 10, width: 50 }); }, { creationDate: D });
    const list = [S.ours[0], S.ours[1], S.pdfLib[0], S.ours[3], img];
    const docs = await Promise.all(list.map((b) => loadPdf(b)));
    const r = await mergePdfs(docs);
    expect(pages(r.bytes)).toBe(list.reduce((n, b) => n + pages(b), 0));
    expect(text(r.bytes)).toBe(list.map((b) => text(b)).filter(Boolean).join(' '));
    const imgs = (b) => run('pdfimages', ['-list', save(b)]).trim().split('\n').length - 2;
    expect(imgs(r.bytes)).toBe(list.reduce((n, b) => n + imgs(b), 0));
    expect(run('pdfdetach', ['-list', save(r.bytes)])).toContain('data.csv');
    expect((await loadPdf(r.bytes)).fields.map((f) => f.name).sort()).toEqual(['c', 'name', 'ok', 'who']);
    await sound(r.bytes);
  });
  it('the same document merged twice: shared fonts are written once', async () => {
    const a = await loadPdf(S.ours[0]);
    const one = (await a.save()).bytes.length, two = (await mergePdfs([a, a])).bytes.length;
    expect(two).toBeLessThan(one * 1.6);
  });
  (HAS.poppler ? it : it.skip)('split into one file per page, reorder, remove, rotate; links to removed pages are dropped, others remapped', async () => {
    const d = await loadPdf(S.ours[0]); // page 1 links to page 3
    for (let i = 0; i < d.pageCount; i++) { const one = d.fork(); one.reorder([i]); const r = await one.save(); expect(text(r.bytes)).toBe(`Seed page ${i + 1}`); await sound(r.bytes); }
    const re = d.fork().reorder([2, 0]);
    re.page(1).rotate(90);
    const r = await re.save();
    expect(text(r.bytes)).toBe('Seed page 3 Seed page 1');
    expect(run('pdfinfo', ['-l', '2', save(r.bytes)])).toMatch(/Page\s+2 rot:\s+90/);
    const back = await loadPdf(r.bytes);
    expect(back.page(1).annotations().map((a) => a.page)).toEqual([0]); // the link to "page 3", now first
    const cut = d.fork().removePages([2]);
    const r2 = await cut.save();
    expect((await loadPdf(r2.bytes)).page(0).annotations()).toEqual([]);
    expect(r2.warnings.join()).toMatch(/links to pages that were not copied/);
    await sound(r2.bytes);
  });
  it('copyPages with at, and an outline remapped to the copied pages', async () => {
    const a = await loadPdf(S.ours[0]), b = await loadPdf(S.pdfLib[0]);
    a.copyPages(b, [1], { at: 1 });
    const r = await loadPdf((await a.save()).bytes);
    expect([0, 1, 2, 3].map((i) => r.page(i).extractText())).toEqual(['Seed page 1', 'pdf-lib page 2', 'Seed page 2', 'Seed page 3']);
    expect(r.outlines.map((o) => [o.title, o.page])).toEqual([['Start', 0]]);
  });
});

describe('drawing on existing pages', () => {
  (HAS.poppler ? it : it.skip)('a watermark and page numbers, wrapped in q/Q: a page that leaves a red fill, a 2× scale and a clip open cannot change them', async () => {
    const b = onePage(enc('q 1 0 0 rg 2 0 0 2 0 0 cm 0 0 50 50 re W n 0 0 10 10 re f'));
    const d = await loadPdf(b);
    d.page(0).draw((p, { fonts }) => { p.rect(150, 150, 40, 40, { fill: 0 }); p.text('1 / 1', { x: 10, y: 180, font: fonts.f, size: 8 }); }, { fonts: { f: 'Helvetica' } });
    const r = await d.save();
    const g = gray(r.bytes);
    expect(g.px(170, 170)).toBeLessThan(40); // black, where it was asked for (not scaled, not clipped, not red)
    expect(g.px(5, 195)).toBeLessThan(200); // the page's own red square, still there (bottom-left, 20 × 20 after its 2× scale)
    expect(text(r.bytes)).toMatch(/1 ?\/ ?1/);
    await sound(r.bytes);
  });
  it('pdf-lib\'s pages take a stamp; an image', async () => {
    const d = await loadPdf(S.pdfLib[1]);
    for (let i = 0; i < d.pageCount; i++) d.page(i).draw((p, { fonts }) => p.text('CONFIDENTIAL', { x: 50, y: 50, font: fonts.f, size: 20, color: '#c00000' }), { fonts: { f: 'Helvetica-Bold' } });
    const r = await loadPdf((await d.save()).bytes);
    expect(r.page(1).extractText()).toBe('pdf-lib page 2\nCONFIDENTIAL');
  });
});

describe('forms', () => {
  async function plForm() {
    const d = await PDFDocument.create(), f = await d.embedFont(StandardFonts.Helvetica), form = d.getForm(), p = d.addPage([400, 400]);
    form.createTextField('name').addToPage(p, { x: 20, y: 340, width: 200, height: 20, font: f });
    form.createCheckBox('agree').addToPage(p, { x: 20, y: 300, width: 14, height: 14 });
    const rg = form.createRadioGroup('size'); rg.addOptionToPage('S', p, { x: 20, y: 260, width: 14, height: 14 }); rg.addOptionToPage('L', p, { x: 60, y: 260, width: 14, height: 14 });
    const dd = form.createDropdown('color'); dd.addOptions(['Red', 'Blue']); dd.addToPage(p, { x: 20, y: 220, width: 100, height: 20, font: f });
    const ol = form.createOptionList('tags'); ol.addOptions(['a', 'b', 'c']); ol.addToPage(p, { x: 20, y: 140, width: 100, height: 60, font: f });
    return d.save();
  }
  (HAS.poppler ? it : it.skip)('fill text, check box, radio, combo and list fields of a pdf-lib form; appearances made again; pdf-lib reads the values', async () => {
    const d = await loadPdf(await plForm());
    d.fill({ name: 'Ada Lovelace', agree: true, size: 'L', color: 'Blue', tags: ['b'] });
    const r = await d.save();
    const f = (await PDFDocument.load(r.bytes)).getForm();
    expect(f.getTextField('name').getText()).toBe('Ada Lovelace');
    expect(f.getCheckBox('agree').isChecked()).toBe(true);
    expect(f.getRadioGroup('size').getSelected()).toBe('L');
    expect(f.getDropdown('color').getSelected()).toEqual(['Blue']);
    expect(f.getOptionList('tags').getSelected()).toEqual(['b']);
    expect(text(r.bytes)).toMatch(/Ada Lovelace.*Blue/);
    await sound(r.bytes);
    // flattened: the values are drawn, the form is gone
    d.flatten();
    const fl = await d.save();
    expect(text(fl.bytes)).toMatch(/Ada Lovelace.*Blue/);
    expect((await loadPdf(fl.bytes)).fields).toEqual([]);
    expect(run('pdfinfo', [save(fl.bytes)])).toMatch(/Form:\s+none/);
  });
  it('a value the font cannot draw is refused clearly; with a font given it is drawn', async () => {
    const d = await loadPdf(await plForm());
    d.fill({ name: 'Ωmega' });
    await expect(d.save()).rejects.toThrow(/fill: "name".*no glyph/);
    d.fill({ name: 'Ωmega' }, { font: INTER });
    expect((await loadPdf((await d.save()).bytes)).fields.find((x) => x.name === 'name').value).toBe('Ωmega');
  });
  it('fill a 200-field form and save', async () => {
    const pl = await PDFDocument.create(), f = await pl.embedFont(StandardFonts.Helvetica), form = pl.getForm();
    for (let i = 0; i < 4; i++) { const p = pl.addPage(); for (let k = 0; k < 50; k++) form.createTextField(`p${i}f${k}`).addToPage(p, { x: 50 + (k % 2) * 250, y: 760 - Math.floor(k / 2) * 30, width: 200, height: 20, font: f }); }
    const d = await loadPdf(await pl.save());
    d.fill(Object.fromEntries(d.fields.map((x) => [x.name, `v ${x.name}`])));
    const r = await loadPdf((await d.save()).bytes);
    expect(r.fields.filter((x) => x.value === `v ${x.name}`).length).toBe(200);
  });
});

describe('info, XMP, annotations, encryption, PDF/A', () => {
  (HAS.poppler ? it : it.skip)('setInfo and setXmp; removeAnnotations; an encrypted copy', async () => {
    const d = await loadPdf(S.ours[0]);
    d.setInfo({ title: 'Renamed', author: 'H' }).removeAnnotations();
    const r = await d.save();
    expect(run('pdfinfo', [save(r.bytes)])).toMatch(/Title:\s+Renamed[\s\S]*Author:\s+H/);
    expect((await loadPdf(r.bytes)).xmp).toContain('Renamed');
    expect((await loadPdf(r.bytes)).page(0).annotations()).toEqual([]);
    const e = await d.save({ encrypt: { userPassword: 'pw', algorithm: 'aes-256' } });
    expect(run('pdftotext', ['-upw', 'pw', save(e.bytes), '-'])).toContain('Seed page 1');
    await sound(e.bytes, 'pw');
  });
  (HAS.verapdf ? it : it.skip)('two PDF/A-2b files merged, with a watermark drawn with an embedded font: veraPDF 0 failures; mixed with a non-PDF/A file the claim is dropped', async () => {
    const mk = (t) => toBytes(async (pdf) => { const f = await pdf.embedFont(INTER); pdf.addPage().text(t, { x: 40, y: 40, font: f, size: 14 }); }, { title: t, pdfa: true, creationDate: D });
    const [a, b] = [await loadPdf(await mk('First')), await loadPdf(await mk('Second'))];
    const m = a.fork().merge([b]);
    m.page(1).draw((p, { fonts }) => p.text('APPROVED', { x: 40, y: 100, font: fonts.f, size: 20 }), { fonts: { f: INTER } });
    const r = await m.save();
    expect((await loadPdf(r.bytes)).pdfa).toEqual({ part: 2, conformance: 'b' });
    expect(verapdf(r.bytes, '2b').failed).toEqual([]);
    const mixed = await a.fork().merge([await loadPdf(S.ours[0])]).save();
    expect(mixed.warnings.join()).toMatch(/PDF\/A was dropped/);
    expect((await loadPdf(mixed.bytes)).pdfa).toBeNull();
  }, 60_000);
  (HAS.verapdf ? it : it.skip)('a PDF/A-3a file with its tags and attachment, rewritten alone: veraPDF 3a 0 failures', async () => {
    const r = await (await loadPdf(S.ours[3])).save();
    expect(verapdf(r.bytes, '3a').failed).toEqual([]);
  }, 60_000);
});

describe('incremental save and signatures', () => {
  const dir = fs.mkdtempSync(path.join(DIR, 'isig-'));
  let signer;
  beforeAll(() => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '30', '-subj', '/CN=Incremental'], { stdio: 'ignore' });
    signer = nodeSigner({ key: fs.readFileSync(path.join(dir, 'k.pem')), certs: fs.readFileSync(path.join(dir, 'c.pem'), 'utf8') });
  });
  const pdfsig = (b) => run('pdfsig', [save(b)]);
  for (const enc2 of [null, { userPassword: '', ownerPassword: 'o', algorithm: 'aes-256' }]) {
    (HAS.poppler ? it : it.skip)(`fill a signed form incrementally, then add a second signature: both valid (pdfsig)${enc2 ? ', AES-256 encrypted' : ''}`, async () => {
      const b = await toBytes(async (pdf) => {
        const f = pdf.standardFont('Helvetica'), p = pdf.addPage();
        p.text('Contract', { x: 40, y: 40, font: f });
        pdf.form.textField('name', { page: p, x: 40, y: 100, width: 200, height: 20, font: f });
        await pdf.sign({ name: 'first', page: p, x: 40, y: 200, width: 200, height: 40 }, { signer, reason: 'one' });
      }, { sign: true, creationDate: D, ...(enc2 ? { encrypt: enc2 } : {}) });
      const d = await loadPdf(b);
      d.fill({ name: 'Arun' });
      const f = await d.saveIncremental({ allowFillAfterSigning: true }); // a signed document: filling is opted into
      expect(f.bytes.subarray(0, b.length)).toEqual(b); // the signed bytes are untouched
      const s1 = pdfsig(f.bytes);
      // poppler: the first signature's own bytes verify; it says the document changed after it ("Not total document signed")
      expect(s1).toMatch(/Signature #1:[\s\S]*Not total document signed[\s\S]*Signature is Valid/);
      expect(run('pdftotext', [save(f.bytes), '-'])).toContain('Arun');
      const s = await (await loadPdf(f.bytes)).saveIncremental({ sign: { field: { name: 'second', page: 0, x: 300, y: 200, width: 150, height: 40 }, signer, reason: 'two' } });
      const out = pdfsig(s.bytes);
      expect(out).toMatch(/Signature #1:[\s\S]*Signature is Valid[\s\S]*Signature #2:[\s\S]*Total document signed[\s\S]*Signature is Valid/);
      const sigs = (await loadPdf(s.bytes)).signatures;
      expect(sigs.map((x) => [x.field, x.coversWholeFile])).toEqual([['first', false], ['second', true]]);
      await sound(s.bytes);
    }, 30_000);
  }
  (HAS.poppler ? it : it.skip)('sign an existing pdf-lib PDF incrementally (an empty signature field made new)', async () => {
    const r = await (await loadPdf(S.pdfLib[0])).saveIncremental({ sign: { field: { name: 'approval' }, signer } });
    expect(pdfsig(r.bytes)).toMatch(/Signature is Valid/);
    expect(r.bytes.subarray(0, S.pdfLib[0].length)).toEqual(S.pdfLib[0]);
  });
  it('a full rewrite of a signed file drops the signature value (reported)', async () => {
    const b = await toBytes(async (pdf) => { const p = pdf.addPage(); await pdf.sign({ name: 's', page: p, x: 0, y: 0, width: 10, height: 10 }, { signer }); }, { sign: true, creationDate: D });
    const r = await (await loadPdf(b)).save();
    expect(r.stripped.map((x) => x.what).join()).toMatch(/signature value/);
    expect((await loadPdf(r.bytes)).signatures).toEqual([]);
  });
});
void rawPdf;
