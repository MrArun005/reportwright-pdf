// Group D navigation: outlines (nesting, open/closed, colour, flags, fits, named destinations), named destinations (a
// balanced name tree), page labels (a number tree), viewer preferences, page mode/layout, the open action, and links
// (named destinations, named actions, fit modes, highlight, border, quad points). Checked with pdf-lib and poppler.
import { describe, it, expect } from 'vitest';
import { PDFName, PDFDict, PDFArray } from 'pdf-lib';
import { toBytes, createPdf } from '../src/index.js';
import { HAS, pdfinfo, run, save } from './tools.js';
import { load, annots, get, js, bytesOf } from './nav-tools.js';

const DATE = new Date('2026-01-01');
const pages = (pdf, n, o) => { for (let i = 0; i < n; i++) pdf.addPage(o); };

describe('outline', () => {
  it('nests deeply, with open and closed entries (/Count signs), colour, bold/italic flags and fit modes', async () => {
    const out = await toBytes((pdf) => {
      pages(pdf, 3, { width: 600, height: 800 });
      pdf.outline([
        { title: 'Part 1', page: 1, color: '#ff0000', bold: true },
        { title: 'Chapter 1', page: 1, level: 1, fit: 'FitH', top: 100, open: false, italic: true },
        { title: 'Section 1.1', page: 2, level: 2, zoom: 2, left: 10, top: 20 },
        { title: 'Section 1.2', page: 2, level: 2, fit: 'FitR', left: 10, top: 20, right: 300, bottom: 400 },
        { title: 'Deep', page: 3, level: 3, fit: 'FitBV', left: 5 },
        { title: 'Chapter 2', page: 3, level: 1, fit: 'FitB', bold: true, italic: true },
        { title: 'Part 2', page: 3, fit: 'FitV', left: 50, color: 0.5 },
      ]);
    }, { creationDate: DATE });
    const doc = await load(out);
    const root = doc.catalog.lookup(PDFName.of('Outlines'), PDFDict);
    const first = (d) => d.lookup(PDFName.of('First'), PDFDict), next = (d) => d.lookup(PDFName.of('Next'), PDFDict);
    const part1 = first(root), ch1 = first(part1), s11 = first(ch1), s12 = next(s11), deep = first(s12), ch2 = next(ch1), part2 = next(part1);
    expect([part1, ch1, s11, s12, deep, ch2, part2].map((d) => get(d, 'Title'))).toEqual(['Part 1', 'Chapter 1', 'Section 1.1', 'Section 1.2', 'Deep', 'Chapter 2', 'Part 2']);
    // root: Part 1, Chapter 1, Chapter 2, Part 2 visible (Chapter 1 closed hides 3)
    expect(get(root, 'Count')).toBe(4);
    expect(get(part1, 'Count')).toBe(2);
    expect(get(ch1, 'Count')).toBe(-3); // closed: 3 would show if opened
    expect(get(s12, 'Count')).toBe(1);
    expect(get(part1, 'C')).toEqual([1, 0, 0]);
    expect(get(part2, 'C')).toEqual([0.5, 0.5, 0.5]);
    expect([part1, ch1, ch2, s11].map((d) => get(d, 'F') ?? 0)).toEqual([2, 1, 3, 0]);
    const dest = (d) => get(d, 'Dest', 0).slice(1);
    expect(dest(part1)).toEqual(['/Fit']);
    expect(dest(ch1)).toEqual(['/FitH', 700]);
    expect(dest(s11)).toEqual(['/XYZ', 10, 780, 2]);
    expect(dest(s12)).toEqual(['/FitR', 10, 400, 300, 780]);
    expect(dest(deep)).toEqual(['/FitBV', 5]);
    expect(dest(ch2)).toEqual(['/FitB']);
    expect(dest(part2)).toEqual(['/FitV', 50]);
    expect(get(part1, 'Dest', 0)[0]).toBe(`${doc.getPage(0).ref.objectNumber} R`);
    expect(get(s11, 'Parent', 0)).toBe(`${ch1.context.getObjectRef(ch1).objectNumber} R`);
    if (!HAS.poppler) return;
    const x = run('pdftohtml', ['-xml', '-stdout', '-i', '-q', save(out)]).replace(/\s+/g, '');
    expect(x).toContain('<outline><itempage="1">Part1</item><outline><itempage="1">Chapter1</item><outline><itempage="2">Section1.1</item><itempage="2">Section1.2</item><outline><itempage="3">Deep</item></outline></outline><itempage="3">Chapter2</item></outline><itempage="3">Part2</item></outline>');
  });

  it('an entry may name a destination; one skipping levels nests under the nearest lower one', async () => {
    const out = await toBytes((pdf) => {
      pages(pdf, 2);
      pdf.destination('appendix', 2, { top: 100 });
      pdf.outline([{ title: 'Top', page: 1 }, { title: 'Far down', page: 2, level: 5 }, { title: 'Appendix', dest: 'appendix' }]);
    }, { creationDate: DATE });
    const doc = await load(out);
    const root = doc.catalog.lookup(PDFName.of('Outlines'), PDFDict);
    const top = root.lookup(PDFName.of('First'), PDFDict);
    expect(get(top.lookup(PDFName.of('First'), PDFDict), 'Title')).toBe('Far down');
    const app = top.lookup(PDFName.of('Next'), PDFDict);
    expect(bytesOf(app.get(PDFName.of('Dest'))).toString()).toBe('appendix');
    if (HAS.poppler) expect(run('pdftohtml', ['-xml', '-stdout', '-i', '-q', save(out)]).replace(/\s+/g, '')).toContain('<itempage="2">Appendix</item>');
  });
});

describe('named destinations', () => {
  it('are written to the Names tree, sorted; links and outlines go to them; pdfinfo -dests lists them', async () => {
    const out = await toBytes((pdf) => {
      const p = pdf.addPage({ width: 500, height: 700 });
      pages(pdf, 2, { width: 500, height: 700 });
      pdf.destination('zeta', 3, 'Fit');
      pdf.destination('alpha', 1, { left: 20, top: 100, zoom: 1.5 });
      pdf.destination('mid', 2, { fit: 'FitH', top: 50 });
      pdf.destination('café', pdf.addPage({ width: 500, height: 700 }), 'FitB');
      p.link(10, 10, 50, 10, { dest: 'mid' });
    }, { creationDate: DATE });
    const doc = await load(out);
    const tree = doc.catalog.lookup(PDFName.of('Names'), PDFDict).lookup(PDFName.of('Dests'), PDFDict);
    const names = tree.lookup(PDFName.of('Names'), PDFArray).asArray();
    expect(names.filter((_, i) => i % 2 === 0).map((s) => bytesOf(s).toString('utf8'))).toEqual(['alpha', 'café', 'mid', 'zeta']);
    expect(js(names[1], doc.context, 0).slice(1)).toEqual(['/XYZ', 20, 600, 1.5]);
    expect(bytesOf(annots(doc)[0].get(PDFName.of('Dest'))).toString()).toBe('mid');
    if (!HAS.poppler) return;
    const d = pdfinfo(out, '-dests');
    expect(d).toMatch(/1 \[ XYZ\s+20\s+600 1\.50\s*\] "alpha"/);
    expect(d).toMatch(/2 \[ FitH\s+650\s*\] "mid"/);
    expect(d).toMatch(/3 \[ Fit\s*\] "zeta"/);
  });

  it('many names make a balanced tree: Kids with Limits, every leaf sorted, all found', async () => {
    const N = 5000;
    const out = await toBytes((pdf) => {
      pages(pdf, 3);
      for (let i = N - 1; i >= 0; i--) pdf.destination(`d${String(i).padStart(5, '0')}`, (i % 3) + 1, 'Fit');
    }, { creationDate: DATE });
    const doc = await load(out);
    const root = doc.catalog.lookup(PDFName.of('Names'), PDFDict).lookup(PDFName.of('Dests'), PDFDict);
    expect(root.get(PDFName.of('Limits'))).toBeUndefined();
    const found = [];
    let depth = 0;
    const walk = (node, d) => {
      depth = Math.max(depth, d);
      const kids = node.get(PDFName.of('Kids')) && node.lookup(PDFName.of('Kids'), PDFArray);
      if (kids) {
        for (const k of kids.asArray()) {
          const kid = doc.context.lookup(k, PDFDict), [lo, hi] = kid.lookup(PDFName.of('Limits'), PDFArray).asArray().map((s) => bytesOf(s).toString());
          const before = found.length;
          walk(kid, d + 1);
          expect([found[before], found[found.length - 1]]).toEqual([lo, hi]);
        }
      } else node.lookup(PDFName.of('Names'), PDFArray).asArray().forEach((s, i) => { if (i % 2 === 0) found.push(bytesOf(s).toString()); });
    };
    walk(root, 0);
    expect(found.length).toBe(N);
    expect(found).toEqual([...found].sort());
    expect(depth).toBe(2); // 5000 / 64 leaves → 2 nodes → root
    if (HAS.poppler) expect(pdfinfo(out, '-dests').split('\n').filter((l) => /"d\d{5}"/.test(l)).length).toBe(N);
  });

  it('a name used but never defined, or pointing past the last page, is a warning', async () => {
    let r;
    await toBytes((pdf) => {
      pdf.addPage().link(0, 0, 10, 10, { dest: 'nowhere' });
      pdf.destination('later', 9);
      const end = pdf.end; pdf.end = async () => (r = await end());
    }, { creationDate: DATE });
    expect(r.warnings.join('\n')).toMatch(/"nowhere" is used as a destination but was never defined/);
    expect(r.warnings.join('\n')).toMatch(/"later" points to page 9/);
  });
});

describe('page labels', () => {
  it('are a number tree of ranges: style, prefix, first number; page 0 is covered', async () => {
    const out = await toBytes((pdf) => {
      pages(pdf, 8);
      pdf.pageLabels([{ start: 4, style: 'D', first: 1 }, { start: 2, style: 'r' }, { start: 6, style: 'A', prefix: 'App-', first: 3 }, { start: 7, prefix: 'Back' }]);
    }, { creationDate: DATE });
    const doc = await load(out);
    const nums = js(doc.catalog.lookup(PDFName.of('PageLabels'), PDFDict).get(PDFName.of('Nums')), doc.context, 1);
    expect(nums).toEqual([0, { S: '/D' }, 2, { Type: '/PageLabel', S: '/r' }, 4, { Type: '/PageLabel', S: '/D' }, 6, { Type: '/PageLabel', S: '/A', P: 'App-', St: 3 }, 7, { Type: '/PageLabel', P: 'Back' }]);
    // poppler's tools do not print page labels (pdfinfo has no option for them), so pdf-lib reads the tree above
  });

  it('checks its input', () => {
    const pdf = createPdf({ write() {} });
    expect(() => pdf.pageLabels([])).toThrow(/array of 1/);
    expect(() => pdf.pageLabels([{ start: -1 }])).toThrow(/0-based page index/);
    expect(() => pdf.pageLabels([{ start: 0, style: 'roman' }])).toThrow(/style is one of/);
    expect(() => pdf.pageLabels([{ start: 0 }, { start: 0 }])).toThrow(/two ranges start/);
    expect(() => pdf.pageLabels([{ start: 0, first: 0 }])).toThrow(/first is a whole number/);
  });
});

describe('viewer', () => {
  it('writes viewer preferences, page mode and layout and a destination-only open action', async () => {
    const out = await toBytes((pdf) => {
      pages(pdf, 3, { width: 400, height: 500 });
      pdf.outline({ title: 'A', page: 1 }); // would set /UseOutlines: the explicit mode wins
      pdf.viewer({ hideToolbar: true, hideMenubar: false, fitWindow: true, centerWindow: true, displayDocTitle: true, direction: 'R2L', printScaling: 'None', duplex: 'DuplexFlipLongEdge', pickTrayByPDFSize: true, numCopies: 3, pageMode: 'FullScreen', pageLayout: 'TwoPageRight', openAt: { page: 2, top: 100, zoom: 1.25 } });
    }, { creationDate: DATE });
    const doc = await load(out);
    expect(get(doc.catalog, 'ViewerPreferences')).toEqual({ HideToolbar: true, HideMenubar: false, FitWindow: true, CenterWindow: true, DisplayDocTitle: true, Direction: '/R2L', PrintScaling: '/None', Duplex: '/DuplexFlipLongEdge', PickTrayByPDFSize: true, NumCopies: 3 });
    expect(get(doc.catalog, 'PageMode')).toBe('/FullScreen');
    expect(get(doc.catalog, 'PageLayout')).toBe('/TwoPageRight');
    const open = get(doc.catalog, 'OpenAction', 0);
    expect(open).toEqual([`${doc.getPage(1).ref.objectNumber} R`, '/XYZ', null, 400, 1.25]);
  });

  it('tagged PDFs keep DisplayDocTitle; bad values and other actions are refused', async () => {
    const out = await toBytes((pdf) => { pdf.addPage(); pdf.viewer({ pageLayout: 'OneColumn', hideToolbar: true }); }, { creationDate: DATE, title: 'T', tagged: true });
    const doc = await load(out);
    expect(get(doc.catalog, 'ViewerPreferences')).toEqual({ HideToolbar: true, DisplayDocTitle: true });
    const pdf = createPdf({ write() {} }, { title: 'T', tagged: true });
    expect(() => pdf.viewer({ displayDocTitle: false })).toThrow(/PDF\/UA/);
    expect(() => pdf.viewer({ pageMode: 'UseJS' })).toThrow(/pageMode is one of/);
    expect(() => pdf.viewer({ numCopies: 9 })).toThrow(/numCopies/);
    expect(() => pdf.viewer({ openAction: { javascript: 'app.alert(1)' } })).toThrow(/unknown option "openAction".*JavaScript/);
    expect(() => pdf.viewer({ openAt: { url: 'https://x' } })).toThrow(/openAt is \{ page/);
  });
});

describe('links', () => {
  it('fit modes, named actions, highlight mode, border style and colour, quad points', async () => {
    const out = await toBytes((pdf) => {
      const p = pdf.addPage({ width: 600, height: 800 });
      pdf.addPage({ width: 600, height: 800 });
      p.link(10, 10, 100, 20, { page: 2, fit: 'FitR', left: 0, top: 0, right: 300, bottom: 200 }, { highlight: 'outline', border: { width: 2, style: 'dashed', dash: [3, 1], color: '#0000ff' } });
      p.link(10, 40, 100, 20, { page: 2, zoom: 3 }, { highlight: 'push' });
      p.link(10, 70, 100, 20, { named: 'NextPage' }, { border: { width: 1, style: 'underline', color: 0 } });
      p.link(10, 100, 100, 40, { url: 'mailto:a@example.com?subject=Hi there' }, { quadPoints: [{ x: 10, y: 100, width: 100, height: 20 }, { x: 10, y: 120, width: 60, height: 20 }] });
    }, { creationDate: DATE });
    const doc = await load(out);
    const [a, b, c, d] = annots(doc);
    expect(get(a, 'Dest', 0).slice(1)).toEqual(['/FitR', 0, 600, 300, 800]);
    expect(get(a, 'H')).toBe('/O');
    expect(get(a, 'BS')).toEqual({ Type: '/Border', W: 2, S: '/D', D: [3, 1] });
    expect(get(a, 'C')).toEqual([0, 0, 1]);
    expect(get(b, 'Dest', 0).slice(1)).toEqual(['/XYZ', null, null, 3]);
    expect(get(c, 'A')).toEqual({ Type: '/Action', S: '/Named', N: '/NextPage' });
    expect(get(c, 'BS').S).toBe('/U');
    expect(bytesOf(d.lookup(PDFName.of('A'), PDFDict).get(PDFName.of('URI'))).toString()).toBe('mailto:a@example.com?subject=Hi%20there');
    expect(get(d, 'QuadPoints')).toEqual([10, 700, 110, 700, 10, 680, 110, 680, 10, 680, 70, 680, 10, 660, 70, 660]);
    for (const x of [a, b, c, d]) { expect(get(x, 'Subtype')).toBe('/Link'); expect(get(x, 'F')).toBe(4); }
  });

  it('widens URL schemes only through allowSchemes', async () => {
    const out = await toBytes((pdf) => { pdf.addPage().link(0, 0, 9, 9, { url: 'tel:+44 20 7946 0000' }, { allowSchemes: ['tel'] }); }, { creationDate: DATE });
    const doc = await load(out);
    expect(bytesOf(annots(doc)[0].lookup(PDFName.of('A'), PDFDict).get(PDFName.of('URI'))).toString()).toBe('tel:+44%2020%207946%200000');
    expect(() => createPdf({ write() {} }).addPage().link(0, 0, 9, 9, { url: 'tel:1' })).toThrow(/tel: URLs are not allowed.*allowSchemes/);
  });
});
