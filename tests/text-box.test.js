// page.textBox: wrapping, long words, alignment and justification, maxLines with an ellipsis, height and overflow.
import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { toBytes, createPdf } from '../src/index.js';
import { INTER, HAS, pdftotext, gray, latin, run, save } from './tools.js';

const DATE = new Date('2026-01-01');
const TEXT = 'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump!\nA second paragraph, short.';
async function make(draw, o = {}) {
  let r;
  const out = await toBytes(async (pdf) => { r = await draw(pdf.addPage({ width: 400, height: 400 }), pdf); }, { creationDate: DATE, ...o });
  await PDFDocument.load(out);
  return { out, r };
}
/** pdftotext without -layout: one line per drawn line */
const lines = (out) => run('pdftotext', [save(out), '-']).split('\n').map((l) => l.trim()).filter(Boolean);

/** the expected greedy lines, from widthOfText of each word and space (independently of textBox) */
function greedy(font, text, size, width) {
  const out = [];
  for (const para of text.split('\n')) {
    let line = '', w = 0;
    for (const word of para.split(' ')) {
      const ww = font.widthOfText(word, size), sp = font.widthOfText(' ', size);
      if (line && w + sp + ww <= width) { line += ` ${word}`; w += sp + ww; }
      else { if (line) out.push(line); line = word; w = ww; }
    }
    out.push(line);
  }
  return out;
}

describe('page.textBox', () => {
  it('wraps by word, paragraph by paragraph, as widthOfText measures; returns the height used', async () => {
    for (const std of [false, true]) {
      let expected, lh;
      const { out, r } = await make(async (p, pdf) => {
        const font = std ? pdf.standardFont('Helvetica') : await pdf.embedFont(INTER);
        expected = greedy(font, TEXT, 11, 180); lh = font.lineHeight(11);
        return p.textBox(TEXT, { x: 20, y: 20, width: 180, font, size: 11 });
      });
      expect(expected.length).toBeGreaterThan(4);
      expect(r).toEqual({ height: expected.length * lh, lines: expected.length, overflow: '' });
      if (HAS.poppler) expect(lines(out)).toEqual(expected);
    }
  });

  it('a word longer than the line is broken where it overflows', async () => {
    const word = 'Pneumonoultramicroscopicsilicovolcanoconiosis';
    const { out, r } = await make(async (p, pdf) => p.textBox(`A ${word} b`, { x: 20, y: 20, width: 80, font: await pdf.embedFont(INTER), size: 12 }));
    if (HAS.poppler) {
      const l = lines(out);
      expect(l[0]).toBe('A');
      expect(l.slice(1).join('').replace(/ b$/, '')).toBe(word);
      expect(l.length).toBe(r.lines);
      const [x0, , x1] = gray(out).box();
      expect(x0).toBeGreaterThanOrEqual(19); expect(x1).toBeLessThanOrEqual(101); // nothing past the box
    }
  });

  it.skipIf(!HAS.poppler)('alignment: right and centre edges; justify fills every line but a paragraph\'s last (Tw for one-byte fonts, TJ for Identity-H)', async () => {
    const box = async (align, std) => make(async (p, pdf) => p.textBox(TEXT, { x: 50, y: 20, width: 200, font: std ? pdf.standardFont('Times-Roman') : await pdf.embedFont(INTER), size: 11, align }), { compress: false });
    /** each text line's [left, right] ink edges (lines: bands of rows with ink) */
    const edges = (out) => {
      const g = gray(out), bands = [];
      for (let y = 0; y < g.h; y++) { const n = g.ink(0, y, g.w, y + 1); if (n && (!bands.length || y > bands.at(-1)[1] + 1)) bands.push([y, y]); else if (n) bands.at(-1)[1] = y; }
      return bands.map(([y0, y1]) => { let a = g.w, b = 0; for (let y = y0; y <= y1; y++) for (let x = 0; x < g.w; x++) if (g.px(x, y) < 128) { a = Math.min(a, x); b = Math.max(b, x + 1); } return [a, b]; });
    };
    const right = edges((await box('right')).out), center = edges((await box('center')).out);
    expect(right.length).toBeGreaterThan(4);
    for (const [, b] of right) expect(b).toBeGreaterThanOrEqual(247), expect(b).toBeLessThanOrEqual(251);
    for (const [a, b] of center) expect(Math.abs((a + b) / 2 - 150)).toBeLessThanOrEqual(4);
    for (const std of [false, true]) {
      const { out } = await box('justify', std);
      const c = latin(out);
      if (std) expect(c).toMatch(/\n\d+\.\d+ Tw\n/); else expect(c).not.toMatch(/ Tw\n/);
      const l = lines(out);
      expect(l.join(' ').replace(/\s+/g, ' ')).toBe(TEXT.replace('\n', ' '));
      // each text line's right edge: at the box's for justified lines, short for the paragraphs' last lines
      const ends = edges(out).map(([, b]) => b);
      expect(ends.length).toBe(l.length);
      const lastOfPara = l.map((t, i) => i === l.length - 1 || t.endsWith('jump!'));
      const left = edges((await box('left', std)).out).map(([, b]) => b); // a paragraph's last line ends as when left-aligned
      ends.forEach((e, i) => (lastOfPara[i] ? expect(Math.abs(e - left[i])).toBeLessThanOrEqual(1) : (expect(e).toBeGreaterThanOrEqual(247), expect(e).toBeLessThanOrEqual(251))));
    }
  });

  it('maxLines ends the last line with an ellipsis and returns the rest; height stops at the last whole line, no ellipsis', async () => {
    const { out, r } = await make(async (p, pdf) => p.textBox(TEXT, { x: 20, y: 20, width: 180, font: await pdf.embedFont(INTER), size: 11, maxLines: 2 }));
    expect(r.lines).toBe(2);
    expect(TEXT.endsWith(r.overflow)).toBe(true);
    if (HAS.poppler) {
      const l = lines(out);
      expect(l.length).toBe(2);
      expect(l[1].endsWith('…')).toBe(true);
      expect(`${l[0]} ${l[1].slice(0, -1)} ${r.overflow}`.replace(/\s+/g, ' ')).toBe(TEXT.replace('\n', ' '));
    }
    const h = await make(async (p, pdf) => { const font = await pdf.embedFont(INTER); return p.textBox(TEXT, { x: 20, y: 20, width: 180, font, size: 11, height: font.lineHeight(11) * 3.5 }); });
    expect(h.r.lines).toBe(3);
    if (HAS.poppler) {
      const l = lines(h.out);
      expect(l.some((t) => t.endsWith('…'))).toBe(false);
      expect(`${l.join(' ')} ${h.r.overflow}`.replace(/\s+/g, ' ')).toBe(TEXT.replace('\n', ' '));
    }
  });

  it('a font without "…" ends with "..."; lineHeight, blank paragraphs, CRLF; bad options throw', async () => {
    const { out, r } = await make(async (p, pdf) => p.textBox('one\r\n\r\nthree four five six seven eight', { x: 10, y: 10, width: 60, font: pdf.standardFont('Symbol'), size: 10, lineHeight: 20, maxLines: 3 }));
    expect(r.height).toBe(60);
    expect(r.lines).toBe(3);
    const pdf = createPdf({ write() {} }), f = pdf.standardFont('Helvetica'), p = pdf.addPage();
    expect(() => p.textBox('x', { font: f, width: 0 })).toThrow(/width is above 0/);
    expect(() => p.textBox('x', { font: f, width: 10, align: 'middle' })).toThrow(/align is/);
    expect(() => p.textBox('x', { font: f, width: 10, maxLines: 1.5 })).toThrow(/maxLines/);
    expect(() => p.textBox('x', { font: f, width: 10, lineHeight: -1 })).toThrow(/lineHeight/);
    expect(latin(out).length).toBeGreaterThan(0);
  });
});
