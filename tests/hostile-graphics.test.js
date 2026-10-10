// Hostile input to the graphics of @reportwright/pdf: each case throws a clear error or renders safely, in under 1 s,
// and nothing broken reaches the file.
import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { toBytes } from '../src/index.js';
import { Path, MAX_SEGMENTS } from '../src/graphics/path.js';
import { MAX_SVG } from '../src/graphics/svg.js';
import { latin } from './tools.js';

const DATE = new Date('2026-01-01');
/** fn throws re, fast */
function failsFast(fn, re) {
  const t = performance.now();
  expect(fn).toThrow(re);
  expect(performance.now() - t).toBeLessThan(1000);
}
/** draw on a page; the PDF still ends and parses @returns {Promise<string>} the file as text */
async function page(draw, o = {}) {
  const out = await toBytes((pdf) => draw(pdf.addPage({ width: 100, height: 100 })), { compress: false, creationDate: DATE, ...o });
  await PDFDocument.load(out);
  return latin(out);
}

describe('hostile graphics', () => {
  it('a huge SVG string is refused before parsing; one under the limit but with too many segments stops at the cap', () => {
    const huge = 'M0 0' + ' L1 1'.repeat(MAX_SVG / 5 + 1);
    failsFast(() => new Path().svg(huge), /at most 10485760 \(10 MB\)/);
    const many = 'M0 0' + 'L1 1'.repeat(1_200_000); // 4.8 MB, 1.2 M segments
    failsFast(() => new Path().svg(many), /at most 1,000,000 segments/);
    const p = new Path();
    expect(() => { for (let i = 0; i <= MAX_SEGMENTS; i++) p.lineTo(i % 7, 1); }).toThrow(/at most 1,000,000 segments/);
  });
  it('malformed path data throws a SyntaxError; nothing is drawn', async () => {
    for (const d of ['', 'M', 'M1', 'M 1 1 L', 'L 1 1', 'M1 1 Q1', 'M1 1 A 1 1 0 2 0 3 3', 'M1 1 ??', 'M1,,1', 'M1 1 e5', 'M1 1 1e+', 'Z']) {
      if (d === '') { expect(new Path().svg(d).segments).toBe(0); continue; }
      failsFast(() => new Path().svg(d), SyntaxError);
    }
    const text = await page((p) => { try { p.svgPath('M10 10 L20 20 L'); } catch { /* refused */ } });
    expect(text).not.toMatch(/10 90 m/);
    failsFast(() => new Path().svg(/** @type {any} */ (null)), /is a string/);
  });
  it('a pathological SVG (deep nesting has no meaning; long runs of numbers) parses in linear time', () => {
    const d = 'M0 0' + ' 1e-3.5.5'.repeat(150_000) + 'z'.repeat(1) + 'M0 0' + 'c1 1 1 1 1 1'.repeat(100_000);
    const t = performance.now();
    expect(new Path().svg(d).segments).toBeGreaterThan(250_000);
    expect(performance.now() - t).toBeLessThan(1000);
  });
  it('NaN and Infinity throw before anything is drawn: coordinates, transforms, styles, stops, opacity', async () => {
    const nan = [
      (p) => p.path().moveTo(NaN, 0), (p) => p.path().lineTo(0, Infinity), (p) => p.path().bezierCurveTo(0, 0, 0, 0, NaN, 0),
      (p) => p.path().arc(0, 0, 1, 0, NaN), (p) => p.path().roundedRect(0, 0, 1, 1, [NaN]), (p) => p.path().svg('M0 0 L1e400 0'),
      (p) => p.translate(NaN, 0), (p) => p.rotate(Infinity), (p) => p.scale(NaN), (p) => p.skew(NaN), (p) => p.transform(1, 0, 0, 1, 0, -Infinity),
      (p) => p.stroke(p.path().rect(0, 0, 1, 1), { width: NaN }), (p) => p.stroke(p.path().rect(0, 0, 1, 1), { dash: [1, NaN] }),
      (p) => p.stroke(p.path().rect(0, 0, 1, 1), { dash: [1], dashPhase: Infinity }), (p) => p.stroke(p.path().rect(0, 0, 1, 1), { miterLimit: NaN }),
      (p) => p.linearGradient(0, 0, NaN, 0, [[0, 0]]), (p) => p.linearGradient(0, 0, 1, 0, [[NaN, 0]]), (p) => p.fill(p.path().rect(0, 0, 1, 1), { opacity: NaN }),
      (p) => p.tilingPattern({ width: NaN, height: 1 }, () => {}),
    ];
    const text = await page((p) => { for (const f of nan) expect(() => f(p)).toThrow(RangeError); });
    expect(text).not.toMatch(/NaN|Infinity/);
    expect(text).not.toMatch(/ cm\n/);
  });
  it('a 1e308 radius (canvas arc, ellipse, roundedRect, SVG arc) throws clearly', () => {
    failsFast(() => new Path().arc(0, 0, 1e308, 0, Math.PI), /1e\+308 is not a usable number/);
    failsFast(() => new Path().ellipse(0, 0, 1, 1e308, 0, 0, 1), /not a usable number/);
    failsFast(() => new Path().roundedRect(0, 0, 10, 10, 1e308), /not a usable number/);
    failsFast(() => new Path().svg('M0 0 A1e308 1e308 0 0 1 10 10'), /svgPath arc radius: 1e\+308 is not a usable number/);
    failsFast(() => new Path().arcTo(0, 0, 1, 1, 1e308), /not a usable number/);
  });
  it('a 1e6-element dash array, an all-zero one and a negative length are refused', async () => {
    await page((p) => {
      const l = p.path().moveTo(0, 0).lineTo(9, 9);
      failsFast(() => p.stroke(l, { dash: new Array(1e6).fill(1) }), /at most 100 lengths/);
      failsFast(() => p.stroke(l, { dash: [0, 0, 0] }), /cannot all be 0/);
      failsFast(() => p.stroke(l, { dash: [1, -1] }), /≥ 0/);
    });
  });
  it('10,000 nested saves stop at the limit with a clear error; the page still ends balanced (with a warning)', async () => {
    let warnings;
    const out = await toBytes(async (pdf) => {
      const p = pdf.addPage();
      const t = performance.now();
      expect(() => { for (let i = 0; i < 10_000; i++) p.save(); }).toThrow(/at most 1000 nested saves/);
      expect(performance.now() - t).toBeLessThan(1000);
      const end = pdf.end.bind(pdf);
      pdf.end = async () => (warnings = (await end()).warnings, { warnings });
    }, { compress: false, creationDate: DATE });
    const t = latin(out);
    expect(t.match(/^q$/gm)).toHaveLength(1000);
    expect(t.match(/^Q$/gm)).toHaveLength(1000);
    expect(warnings).toEqual(['Page 1: 1000 page.save() without a page.restore(); restored at the end of the page']);
    await PDFDocument.load(out);
  });
  it('10,000 balanced save/restore pairs are fine; more restores than saves throw', async () => {
    const t0 = performance.now();
    const text = await page((p) => {
      for (let i = 0; i < 10_000; i++) { p.save(); p.translate(1, 1); p.restore(); }
      expect(() => p.restore()).toThrow(/no page\.save\(\) to restore/);
    });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(text.match(/^q$/gm)).toHaveLength(10_000);
  });
  it('too many gradient stops, bad colours and bad blend names are refused; names cannot inject', async () => {
    await page((p) => {
      failsFast(() => p.linearGradient(0, 0, 1, 0, new Array(257).fill([0, 0])), /1–256 colour stops/);
      failsFast(() => p.linearGradient(0, 0, 1, 0, [[0, '#zzzzzz']]), /Not a colour/);
      failsFast(() => p.radialGradient(0, 0, -1, 0, 0, 1, [[0, 0]]), /negative/);
      failsFast(() => p.fill(p.path().rect(0, 0, 1, 1), { blendMode: 'Multiply /JS (x)' }), /blendMode is one of/);
      failsFast(() => p.stroke(p.path().rect(0, 0, 1, 1), { cap: '0 J /JS' }), /cap is butt/);
    });
  });
  it('a pattern cell cannot draw text, links or end the page; an async draw is refused', async () => {
    await page((p) => {
      failsFast(() => p.tilingPattern({ width: 1, height: 1 }, (c) => c.link(0, 0, 1, 1, { url: 'x' })), /cannot be used in a tiling pattern's cell/);
      failsFast(() => p.tilingPattern({ width: 1, height: 1 }, (c) => c.end()), /cannot be used in a tiling pattern's cell/);
      failsFast(() => p.tilingPattern({ width: 1, height: 1 }, async () => {}), /synchronous/);
    });
  });
});
