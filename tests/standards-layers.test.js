// Layers (optional content) and page boxes / rotation, group G: /OCProperties read by pdf-lib, a hidden layer not
// rendered by poppler, print/screen-only usage, PDF/A rules; boxes and rotation through pdfinfo -box.
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFDict, PDFArray } from 'pdf-lib';
import { toBytes, createPdf } from '../src/index.js';
import { HAS, INTER, verapdf, pdfinfo, latin, gray } from './tools.js';
import { DATE } from './standards-fixture.js';

const refs = (a) => (a ? a.asArray().map(String) : []);

describe('layers', () => {
  it('OCGs with names, /D with Name, Order, ON, OFF, Locked; /OC marked content; a hidden layer does not render', async () => {
    const out = await toBytes(async (pdf) => {
      const shown = pdf.layer('Shown'), hidden = pdf.layer('Hidden', { visible: false }), lock = pdf.layer('Locked', { locked: true });
      const p = pdf.addPage({ width: 200, height: 200 });
      p.layer(shown, () => p.rect(10, 10, 50, 50, { fill: 0 }));
      p.layer(hidden, () => p.rect(110, 10, 50, 50, { fill: 0 }));
      p.layer(lock, () => p.layer(shown, () => p.rect(10, 110, 50, 50, { fill: 0 }))); // nested
    }, { creationDate: DATE, compress: false });
    const doc = await PDFDocument.load(out);
    const oc = doc.catalog.lookup(PDFName.of('OCProperties'), PDFDict);
    const ocgs = refs(oc.lookup(PDFName.of('OCGs'), PDFArray));
    expect(ocgs.length).toBe(3);
    const names = oc.lookup(PDFName.of('OCGs'), PDFArray).asArray().map((r) => doc.context.lookup(r, PDFDict).lookup(PDFName.of('Name')).decodeText());
    expect(names).toEqual(['Shown', 'Hidden', 'Locked']);
    const d = oc.lookup(PDFName.of('D'), PDFDict);
    expect(d.lookup(PDFName.of('Name')).decodeText()).toBe('Default');
    expect(refs(d.lookup(PDFName.of('Order'), PDFArray))).toEqual(ocgs);
    expect(refs(d.lookup(PDFName.of('ON'), PDFArray))).toEqual([ocgs[0], ocgs[2]]);
    expect(refs(d.lookup(PDFName.of('OFF'), PDFArray))).toEqual([ocgs[1]]);
    expect(refs(d.lookup(PDFName.of('Locked'), PDFArray))).toEqual([ocgs[2]]);
    expect(d.get(PDFName.of('AS'))).toBeUndefined();
    const s = latin(out);
    expect(s).toMatch(/\/OC \/MC1 BDC\n[\s\S]*?EMC\n\/OC \/MC2 BDC/);
    expect(s).toMatch(/\/Properties << \/MC1 \d+ 0 R \/MC2 \d+ 0 R \/MC3 \d+ 0 R >>/);
    if (HAS.poppler) {
      const g = gray(out);
      expect(g.ink(10, 10, 60, 60)).toBe(2500); // shown
      expect(g.ink(110, 10, 160, 60)).toBe(0); // hidden
      expect(g.ink(10, 110, 60, 160)).toBe(2500); // locked (on) > shown
    }
  });

  it('print-only and screen-only layers: /Usage and the /D /AS auto-states for View and Print', async () => {
    const out = await toBytes(async (pdf) => {
      const printOnly = pdf.layer('Print only', { visible: false, printable: true }), screen = pdf.layer('Screen only', { printable: false });
      const p = pdf.addPage();
      p.layer(printOnly, () => p.rect(0, 0, 10, 10)); p.layer(screen, () => p.rect(20, 0, 10, 10));
    }, { creationDate: DATE, compress: false });
    const s = latin(out);
    expect(s).toMatch(/\/Type \/OCG \/Name <[0-9a-f]+> \/Usage << \/View << \/ViewState \/OFF >> \/Print << \/PrintState \/ON >> >>/);
    expect(s).toMatch(/\/Usage << \/View << \/ViewState \/ON >> \/Print << \/PrintState \/OFF >> >>/);
    expect(s).toMatch(/\/AS \[<< \/Event \/View \/OCGs \[\d+ 0 R \d+ 0 R\] \/Category \[\/View\] >> << \/Event \/Print \/OCGs \[\d+ 0 R \d+ 0 R\] \/Category \[\/Print\] >>\]/);
  });

  it('PDF/A-2: layers pass veraPDF; print-only or screen-only (needs /AS) is refused', async () => {
    const out = await toBytes(async (pdf) => {
      const f = await pdf.embedFont(INTER), a = pdf.layer('Text'), b = pdf.layer('Marks', { visible: false, printable: false, locked: true });
      const p = pdf.addPage();
      p.layer(a, () => p.text('In a layer', { x: 40, y: 40, font: f }));
      p.layer(b, () => p.rect(40, 80, 50, 50, { fill: '#c00' }));
    }, { title: 'Layers', pdfa: true, creationDate: DATE });
    if (HAS.verapdf) expect(verapdf(out, '2b').failed).toEqual([]);
    const pdf = createPdf({ write() {} }, { title: 't', pdfa: true });
    expect(() => pdf.layer('P', { visible: false, printable: true })).toThrow(/PDF\/A forbids the auto-states/);
  }, 60000);

  it('checks: names, options, forged and foreign handles, async fns, unbalanced saves, nesting, after end', async () => {
    const pdf = createPdf({ write() {} }), other = createPdf({ write() {} });
    expect(() => pdf.layer('')).toThrow(/non-empty string/);
    expect(() => pdf.layer('x'.repeat(1025))).toThrow(/1,024/);
    expect(() => pdf.layer('L', { visible: 'yes' })).toThrow(/visible is true or false/);
    const L = pdf.layer('L <</JavaScript>> /OpenAction'), p = pdf.addPage();
    expect(() => p.layer({ type: 'layer', name: 'L' }, () => {})).toThrow(/Not a layer/);
    expect(() => p.layer(other.layer('O'), () => {})).toThrow(/another PDF/);
    expect(() => p.layer(L, async () => {})).toThrow(/synchronously/);
    expect(() => p.layer(L, () => p.save())).toThrow(/balance/);
    p.restore();
    let deep = 0;
    const nest = () => { deep++; p.layer(L, nest); };
    expect(nest).toThrow(/at most 32 nested layers/);
    expect(deep).toBe(33);
    p.layer(L, () => p.rect(0, 0, 1, 1)); // still usable after the failures
    await pdf.end();
    expect(() => pdf.layer('late')).toThrow(/ended/);
    const out = await toBytes((d) => { const l = d.layer('L <</JavaScript>> /OpenAction'); const q = d.addPage(); q.layer(l, () => q.rect(0, 0, 1, 1)); }, { compress: false });
    expect(latin(out)).not.toMatch(/\/JavaScript|\/OpenAction/); // the name is a hex string
  });
});

describe('page boxes and rotation', () => {
  it('CropBox, BleedBox, TrimBox, ArtBox from top-left [x, y, w, h]; Rotate; UserUnit; pdfinfo -box reads them', async () => {
    const out = await toBytes((pdf) => {
      pdf.addPage({ width: 600, height: 800, cropBox: [5, 5, 590, 790], bleedBox: [10, 20, 580, 770], trimBox: [19, 29, 562, 752], artBox: [40, 50, 520, 700], rotate: 90, userUnit: 2 });
      pdf.addPage({ rotate: 270 });
    }, { creationDate: DATE, compress: false });
    expect(latin(out)).toMatch(/\/CropBox \[5 5 595 795\] \/BleedBox \[10 10 590 780\] \/TrimBox \[19 19 581 771\] \/ArtBox \[40 50 560 750\] \/Rotate 90 \/UserUnit 2/);
    if (HAS.poppler) {
      const i = pdfinfo(out, '-box', '-f', '1', '-l', '2');
      expect(i).toMatch(/Page\s+1 MediaBox:\s+0\.00\s+0\.00\s+600\.00\s+800\.00/);
      expect(i).toMatch(/Page\s+1 CropBox:\s+5\.00\s+5\.00\s+595\.00\s+795\.00/);
      expect(i).toMatch(/Page\s+1 BleedBox:\s+10\.00\s+10\.00\s+590\.00\s+780\.00/);
      expect(i).toMatch(/Page\s+1 TrimBox:\s+19\.00\s+19\.00\s+581\.00\s+771\.00/);
      expect(i).toMatch(/Page\s+1 ArtBox:\s+40\.00\s+50\.00\s+560\.00\s+750\.00/);
      expect(i).toMatch(/Page\s+1 rot:\s+90/);
      expect(i).toMatch(/Page\s+2 rot:\s+270/);
    }
  });

  it('rotation turns the page, not the drawing coordinates: a mark at the top-left lands where the rotated view puts it', async () => {
    const out = await toBytes((pdf) => { const p = pdf.addPage({ width: 200, height: 100, rotate: 90 }); p.rect(0, 0, 20, 20, { fill: 0 }); }, { creationDate: DATE });
    if (!HAS.poppler) return;
    const g = gray(out);
    expect([g.w, g.h]).toEqual([100, 200]); // shown turned a quarter clockwise
    expect(g.box()).toEqual([80, 0, 100, 20]); // the page's top-left corner is now at the top right
  });

  it('checks: inside the MediaBox, positive sizes, trim and art inside bleed, rotate and userUnit values; a bad box adds no page', async () => {
    const pdf = createPdf({ write() {} });
    expect(() => pdf.addPage({ trimBox: [0, 0, 600, 10] })).toThrow(/trimBox .* lies outside the page/);
    expect(() => pdf.addPage({ cropBox: [-1, 0, 10, 10] })).toThrow(/outside the page/);
    expect(() => pdf.addPage({ artBox: [0, 0, 0, 10] })).toThrow(/positive width and height/);
    expect(() => pdf.addPage({ bleedBox: [0, 0, 10] })).toThrow(/\[x, y, width, height\]/);
    expect(() => pdf.addPage({ bleedBox: [10, 10, 100, 100], trimBox: [5, 10, 50, 50] })).toThrow(/trimBox lies outside bleedBox/);
    expect(() => pdf.addPage({ bleedBox: [10, 10, 100, 100], artBox: [20, 20, 100, 100] })).toThrow(/artBox lies outside bleedBox/);
    expect(() => pdf.addPage({ cropBox: [0, 0, NaN, 1] })).toThrow(/Not a usable number/);
    expect(() => pdf.addPage({ rotate: 45 })).toThrow(/rotate is 0, 90, 180 or 270/);
    expect(() => pdf.addPage({ userUnit: 0 })).toThrow(/userUnit/);
    expect(pdf.core.pageCount).toBe(0);
    pdf.addPage();
    expect((await pdf.end()).pages).toBe(1);
  });
});
