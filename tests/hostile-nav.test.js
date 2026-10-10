// Hostile navigation input: active URLs (javascript:, data:, file:, vbscript:, in any case, with spaces or controls),
// parentheses, active link targets, 100k outline entries, outline depth 10k, colliding and huge destination names,
// annotation text full of PDF delimiters, the annotation cap. Each is refused clearly or escaped (no /JavaScript, /JS
// or /Launch in the output), in under 1 s.
import { describe, it, expect } from 'vitest';
import { PDFName, PDFDict } from 'pdf-lib';
import { createPdf, toBytes } from '../src/index.js';
import { latin, INTER } from './tools.js';
import { load, annots, get, bytesOf } from './nav-tools.js';

const fast = async (fn) => { const t = performance.now(); const r = await fn(); expect(performance.now() - t).toBeLessThan(1000); return r; };
const ACTIVE = /\/JavaScript|\/JS\b|\/Launch|\/GoToR|\/GoToE|\/SubmitForm|\/ImportData/;
const page = () => createPdf({ write() {} }).addPage();

describe('hostile URLs', () => {
  it('javascript:, vbscript:, data: and file: are refused in any spelling, and allowSchemes cannot allow them', () => fast(() => {
    for (const u of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', '  javascript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'FILE://c:/windows/system32/cmd.exe']) {
      expect(() => page().link(0, 0, 9, 9, { url: u }), u).toThrow(/URLs are never written/);
      expect(() => page().link(0, 0, 9, 9, { url: u }, { allowSchemes: ['javascript', 'file'] }), u).toThrow(/never written/);
    }
    expect(() => page().link(0, 0, 9, 9, { url: 'https://x' }, { allowSchemes: ['JavaScript'] })).toThrow(/allowSchemes cannot allow/);
    expect(() => page().link(0, 0, 9, 9, { url: 'ftp://x' })).toThrow(/ftp: URLs are not allowed/);
    expect(() => page().link(0, 0, 9, 9, { url: '/relative/path' })).toThrow(/needs a scheme/);
    expect(() => page().link(0, 0, 9, 9, { url: 'https://exa mple.com' })).toThrow(/not a valid URL/);
  }));

  it('control characters are refused (java\\tscript:, CR/LF, NUL); parentheses and quotes are percent-encoded in a hex string', async () => {
    await fast(() => {
      for (const u of ['java\tscript:alert(1)', 'https://x/\nabc', 'https://x/\r', 'https://x/\0', '\x01https://x', 'https://x/\x7f']) expect(() => page().link(0, 0, 9, 9, { url: u }), JSON.stringify(u)).toThrow(/control character/);
    });
    const out = await fast(() => toBytes((pdf) => { pdf.addPage().link(0, 0, 9, 9, { url: "https://example.com/a(b)c'd\"e<f>) /S /JavaScript /JS (app.alert(1)" }); }, { compress: false, creationDate: new Date(0) }));
    expect(latin(out)).not.toMatch(ACTIVE);
    const uri = bytesOf((annots(await load(out))[0]).lookup(PDFName.of('A'), PDFDict).get(PDFName.of('URI'))).toString();
    expect(uri).toBe('https://example.com/a%28b%29c%27d%22e%3Cf%3E%29%20/S%20/JavaScript%20/JS%20%28app.alert%281%29');
  });

  it('a URL over 32,768 characters is refused', () => fast(() => {
    expect(() => page().link(0, 0, 9, 9, { url: `https://x/${'a'.repeat(1 << 20)}` })).toThrow(/at most 32768/);
  }));
});

describe('hostile actions', () => {
  it('JavaScript, Launch, GoToR, GoToE, SubmitForm and ImportData targets are refused', () => fast(() => {
    for (const t of [{ javascript: 'app.alert(1)' }, { js: 'x' }, { launch: 'cmd.exe' }, { file: 'a.pdf', page: 1 }, { goToR: 'a.pdf' }, { GoToE: {} }, { submitForm: 'https://x' }, { importData: 'a.fdf' }, { action: { S: '/JavaScript' } }, { url: 'https://x', launch: 'y' }]) {
      expect(() => page().link(0, 0, 9, 9, t), JSON.stringify(t)).toThrow(/never written/);
    }
    expect(() => page().link(0, 0, 9, 9, { named: 'Print' })).toThrow(/named is one of NextPage/);
    expect(() => page().link(0, 0, 9, 9, { page: 1 }, { actions: [] })).toThrow(/never written/);
  }));
});

describe('hostile outlines', () => {
  it('100,000 entries are written; the 100,001st is refused', async () => {
    const out = await fast(() => toBytes((pdf) => {
      pdf.addPage();
      pdf.outline(Array.from({ length: 100_000 }, (_, i) => ({ title: `Entry ${i}`, page: 1, level: i % 4 })));
      expect(() => pdf.outline({ title: 'one more', page: 1 })).toThrow(/at most 100000 entries/);
    }, { creationDate: new Date(0) }));
    const doc = await load(out);
    expect(get(doc.catalog.lookup(PDFName.of('Outlines'), PDFDict), 'Count')).toBe(100_000);
  });

  it('depth 10,000 is refused (levels are 0–63); 64 levels nest without recursion', async () => {
    await fast(() => {
      const pdf = createPdf({ write() {} });
      expect(() => pdf.outline(Array.from({ length: 10_000 }, (_, i) => ({ title: 'x', page: 1, level: i })))).toThrow(/level is a whole number 0–63, not 64/);
      expect(() => pdf.outline({ title: 'x', page: 1, level: 1.5 })).toThrow(/level/);
      expect(() => pdf.outline({ title: 'x'.repeat(5000), page: 1 })).toThrow(/at most 4096 characters/);
    });
    const out = await fast(() => toBytes((pdf) => { pdf.addPage(); pdf.outline(Array.from({ length: 64 }, (_, i) => ({ title: `L${i}`, page: 1, level: i }))); }, { creationDate: new Date(0) }));
    let d = (await load(out)).catalog.lookup(PDFName.of('Outlines'), PDFDict), n = 0;
    while (d.get(PDFName.of('First'))) { d = d.lookup(PDFName.of('First'), PDFDict); n++; }
    expect(n).toBe(64);
  });

  it('titles full of delimiters are escaped', async () => {
    const out = await toBytes((pdf) => { pdf.addPage(); pdf.outline({ title: ') >> /A << /S /JavaScript /JS (app.alert(1)) >> <<', page: 1 }); }, { compress: false, creationDate: new Date(0) });
    expect(latin(out)).not.toMatch(ACTIVE);
    const doc = await load(out);
    expect(get(doc.catalog.lookup(PDFName.of('Outlines'), PDFDict).lookup(PDFName.of('First'), PDFDict), 'Title')).toBe(') >> /A << /S /JavaScript /JS (app.alert(1)) >> <<');
  });
});

describe('hostile destination names', () => {
  it('a name defined twice, a huge name, an empty one and too many are refused', () => fast(() => {
    const pdf = createPdf({ write() {} });
    pdf.destination('a', 1);
    expect(() => pdf.destination('a', 2)).toThrow(/"a" is already defined/);
    expect(() => pdf.destination('\uD800', 1)).not.toThrow(); // a lone surrogate encodes as U+FFFD…
    expect(() => pdf.destination('\uDBFF', 1)).toThrow(/already defined/); // …so another one collides with it, by bytes
    expect(() => pdf.destination('x'.repeat(1 << 20), 1)).toThrow(/at most 1024 bytes/);
    expect(() => pdf.destination('é'.repeat(600), 1)).toThrow(/at most 1024 bytes/); // 1,200 UTF-8 bytes
    expect(() => pdf.destination('', 1)).toThrow(/non-empty string/);
    expect(() => pdf.destination('b', 1, { fit: 'JavaScript' })).toThrow(/fit is one of/);
    expect(() => pdf.destination('c', 1, { fit: 'FitR', left: 5, top: 5, right: 1, bottom: 9 })).toThrow(/FitR needs/);
    expect(() => pdf.destination('d', 1, { zoom: Infinity })).toThrow(/Not a usable number/);
    for (let i = 0; i < 99_998; i++) pdf.destination(`n${i}`, 1);
    expect(() => pdf.destination('one more', 1)).toThrow(/at most 100000 named destinations/);
  }));

  it('names full of delimiters are hex strings', async () => {
    const name = ') /JavaScript (app.alert(1)) /Launch <<';
    const out = await toBytes((pdf) => { const p = pdf.addPage(); pdf.destination(name, 1); p.link(0, 0, 9, 9, { dest: name }); pdf.outline({ title: 'x', dest: name }); }, { compress: false, creationDate: new Date(0) });
    expect(latin(out)).not.toMatch(ACTIVE);
    expect(bytesOf(annots(await load(out))[0].get(PDFName.of('Dest'))).toString()).toBe(name);
  });
});

describe('hostile annotations', () => {
  it('contents, authors and FreeText full of PDF delimiters are escaped (no active entries in the output)', async () => {
    const evil = ') >> /A << /S /JavaScript /JS (app.alert(1)) >> /AA << /O << /S /Launch /F (cmd.exe) >> >> (';
    const out = await fast(() => toBytes(async (pdf) => {
      const f = await pdf.embedFont(INTER), p = pdf.addPage();
      p.note(10, 10, { contents: evil, author: evil });
      p.highlight({ x: 0, y: 0, width: 9, height: 9 }, { contents: evil });
      p.freeText(evil, { x: 10, y: 40, width: 200, height: 60, font: f });
      p.stamp({ x: 10, y: 120, width: 100, height: 30, font: f, contents: evil });
      p.markup('Ink', [[[0, 0], [5, 5]]], { contents: evil });
      p.attachFile(new Uint8Array(3), { name: 'a.txt', description: evil });
      p.link(0, 0, 9, 9, { page: 1 }, { alt: evil });
    }, { compress: false, creationDate: new Date(0) }));
    expect(latin(out)).not.toMatch(ACTIVE);
    for (const a of annots(await load(out))) expect(get(a, 'Contents')).toBe(evil);
  });

  it('a page takes at most 100,000 annotations', () => fast(() => {
    const p = page();
    for (let i = 0; i < 100_000; i++) p.link(0, 0, 1, 1, { page: 1 });
    expect(() => p.link(0, 0, 1, 1, { page: 1 })).toThrow(/at most 100000 annotations a page/);
  }));

  it('huge point lists, rectangles and contents are refused', () => fast(() => {
    const p = page();
    expect(() => p.markup('PolyLine', Array.from({ length: 100_001 }, (_, i) => [i % 500, 1]))).toThrow(/at most 100000 points/);
    expect(() => p.markup('Ink', Array.from({ length: 10_001 }, () => [[0, 0]]))).toThrow(/1–10000 strokes/);
    expect(() => p.highlight(Array.from({ length: 10_001 }, () => ({ x: 0, y: 0, width: 1, height: 1 })))).toThrow(/1–10000 rectangles/);
    expect(() => p.note(0, 0, { contents: 'x'.repeat(1_000_001) })).toThrow(/at most 1000000 characters/);
    expect(() => p.squiggly({ x: 0, y: 0, width: 1e8, height: 1e-3 })).not.toThrow(); // at most 2,000 waves, however wide
  }));
});
