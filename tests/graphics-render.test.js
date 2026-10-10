// @reportwright/pdf graphics, rendered: poppler's pdftoppm draws each page at 72 dpi (1 pixel = 1 point, origin top-left,
// as the API), and pixels at known points are checked. Plus veraPDF (PDF/UA-1, PDF/A-2b) on a tagged page using
// gradients, opacity, a clip and a pattern.
import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { toBytes } from '../src/index.js';
import { HAS, INTER, run, save, verapdf } from './tools.js';

const DATE = new Date('2026-01-01');

/** render page 1 of a 100 × 100 page drawn by draw(page); → px(x, y) = [r, g, b] */
async function render(draw, o = {}) {
  const out = await toBytes(async (pdf) => { await draw(pdf.addPage({ width: 100, height: 100 }), pdf); }, { creationDate: DATE, ...o });
  await PDFDocument.load(out); // pdf-lib parses it
  const file = save(out);
  run('pdftoppm', ['-r', '72', '-aa', 'no', '-aaVector', 'no', '-singlefile', file, file]);
  const ppm = fs.readFileSync(`${file}.ppm`);
  // header: P6\n100 100\n255\n
  let at = 0, fields = [];
  while (fields.length < 4) { const e = ppm.indexOf(0x0a, at); fields.push(...ppm.subarray(at, e).toString().trim().split(/\s+/)); at = e + 1; }
  const w = Number(fields[1]);
  return (x, y) => { const i = at + (y * w + x) * 3; return [ppm[i], ppm[i + 1], ppm[i + 2]]; };
}
const WHITE = [255, 255, 255], RED = [255, 0, 0], BLUE = [0, 0, 255], BLACK = [0, 0, 0];
const near = (a, b, tol = 6) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

describe.skipIf(!HAS.poppler)('rendered pixels (pdftoppm)', () => {
  it('paths: a filled triangle, a curve, an even-odd hole', async () => {
    const px = await render((p) => {
      p.fill(p.path().moveTo(10, 10).lineTo(50, 10).lineTo(10, 50).closePath(), { fill: '#ff0000' });
      const ring = p.path().arc(70, 70, 25, 0, 2 * Math.PI).closePath().arc(70, 70, 10, 0, 2 * Math.PI).closePath();
      p.fill(ring, { fill: '#0000ff', rule: 'evenodd' });
    });
    expect(px(15, 15)).toEqual(RED); // inside the triangle
    expect(px(45, 45)).toEqual(WHITE); // beyond its hypotenuse
    expect(px(70, 50)).toEqual(BLUE); // in the ring
    expect(px(70, 70)).toEqual(WHITE); // the even-odd hole
    expect(px(97, 97)).toEqual(WHITE); // outside the circle's corner
  });
  it('nonzero fills the same hole', async () => {
    const px = await render((p) => p.fill(p.path().arc(50, 50, 40, 0, 7).closePath().arc(50, 50, 10, 0, 7).closePath(), { fill: '#0000ff' }));
    expect(px(50, 50)).toEqual(BLUE);
  });
  it('clip: a red page clipped to a circle, then restored', async () => {
    const px = await render((p) => {
      p.save();
      p.clip(p.path().arc(50, 50, 30, 0, 2 * Math.PI));
      p.fill(p.path().rect(0, 0, 100, 100), { fill: '#ff0000' });
      p.restore();
      p.fill(p.path().rect(0, 90, 10, 10), { fill: '#0000ff' }); // after restore: not clipped
    });
    expect(px(50, 50)).toEqual(RED);
    expect(px(50, 25)).toEqual(RED);
    expect(px(5, 5)).toEqual(WHITE);
    expect(px(90, 90)).toEqual(WHITE);
    expect(px(5, 95)).toEqual(BLUE);
  });
  it('a dash: on, off, on along a stroked line, with its phase', async () => {
    const px = await render((p) => {
      p.stroke(p.path().moveTo(0, 20).lineTo(100, 20), { width: 6, dash: [10, 10] });
      p.stroke(p.path().moveTo(0, 60).lineTo(100, 60), { width: 6, dash: [10, 10], dashPhase: 10 });
    });
    expect(px(5, 20)).toEqual(BLACK);
    expect(px(15, 20)).toEqual(WHITE);
    expect(px(25, 20)).toEqual(BLACK);
    expect(px(5, 60)).toEqual(WHITE); // phase 10: starts with the gap
    expect(px(15, 60)).toEqual(BLACK);
  });
  it('a linear gradient red → blue, as a fill and with page.shade under a clip; a radial one', async () => {
    const px = await render((p) => {
      const g = p.linearGradient(0, 0, 100, 0, [[0, '#ff0000'], [1, '#0000ff']]);
      p.fill(p.path().rect(0, 0, 100, 30), { fill: g });
      p.save(); p.clip(p.path().rect(0, 40, 100, 20)); p.shade(g); p.restore();
      p.fill(p.path().rect(0, 70, 30, 30), { fill: p.radialGradient(15, 85, 0, 15, 85, 15, [[0, 1], [1, 0]]) });
    });
    for (const y of [15, 50]) {
      expect(near(px(1, y), RED, 12)).toBe(true);
      expect(near(px(98, y), BLUE, 12)).toBe(true);
      const mid = px(50, y);
      expect(near(mid, [128, 0, 128], 12)).toBe(true);
    }
    expect(px(50, 35)).toEqual(WHITE); // between: not shaded
    expect(px(15, 85)[0]).toBeGreaterThan(240); // white centre
    expect(px(1, 71)[0]).toBeLessThan(15); // black beyond the radius (extended)
  });
  it('a gradient follows a transform (rotated 90°: red at the top, blue at the bottom)', async () => {
    const px = await render((p) => {
      p.translate(100, 0); p.rotate(Math.PI / 2); // x now runs down the page
      p.fill(p.path().rect(0, 0, 100, 100), { fill: p.linearGradient(0, 0, 100, 0, [[0, '#ff0000'], [1, '#0000ff']]) });
    });
    expect(near(px(50, 1), RED, 12)).toBe(true);
    expect(near(px(50, 98), BLUE, 12)).toBe(true);
  });
  it('opacity: 50% black over white is mid gray; 50% red over blue with multiply is black', async () => {
    const px = await render((p) => {
      p.fill(p.path().rect(0, 0, 50, 50), { fill: 0, opacity: 0.5 });
      p.fill(p.path().rect(50, 50, 50, 50), { fill: '#0000ff' });
      p.fill(p.path().rect(50, 50, 50, 50), { fill: '#ff0000', blendMode: 'multiply' });
      p.stroke(p.path().moveTo(0, 75).lineTo(50, 75), { width: 10, stroke: 0, strokeOpacity: 0.25 });
    });
    expect(near(px(25, 25), [128, 128, 128], 3)).toBe(true);
    expect(px(75, 75)).toEqual(BLACK); // red × blue
    expect(near(px(25, 75), [191, 191, 191], 3)).toBe(true);
  });
  it('rect and line take opacity and blendMode (an ExtGState inside q/Q), and the state does not leak', async () => {
    const px = await render((p) => {
      p.rect(0, 0, 50, 50, { fill: 0, opacity: 0.5 });
      p.rect(50, 0, 50, 50, { fill: '#0000ff' });
      p.rect(50, 0, 50, 50, { fill: '#ff0000', blendMode: 'multiply' });
      p.rect(0, 50, 50, 50, { stroke: 0, width: 20, strokeOpacity: 0.25 });
      p.line(50, 75, 100, 75, { color: 0, width: 10, opacity: 0.5 });
      p.rect(90, 90, 10, 10, { fill: 0 }); // after: opaque again
    });
    expect(near(px(25, 25), [128, 128, 128], 3)).toBe(true);
    expect(px(75, 25)).toEqual(BLACK); // red × blue
    expect(near(px(2, 75), [191, 191, 191], 3)).toBe(true); // the 25% stroke
    expect(near(px(70, 75), [128, 128, 128], 3)).toBe(true); // the 50% line
    expect(px(95, 95)).toEqual(BLACK);
    await expect(toBytes((pdf) => { pdf.addPage().rect(0, 0, 1, 1, { opacity: 2 }); })).rejects.toThrow(/opacity is 0–1/);
  });
  it('an SVG arc: the top half of a circle through (50, 10), its chord closed', async () => {
    const px = await render((p) => p.svgPath('M10 50 A40 40 0 0 1 90 50 Z', { fill: '#0000ff' }));
    expect(px(50, 12)).toEqual(BLUE); // near the top of the arc
    expect(px(50, 48)).toEqual(BLUE);
    expect(px(50, 55)).toEqual(WHITE); // below the chord
    expect(px(15, 15)).toEqual(WHITE); // outside the circle
  });
  it('a tiling pattern: cells every 20 points (10 drawn, 10 spacing)', async () => {
    const px = await render((p) => {
      const t = p.tilingPattern({ width: 10, height: 10, spacing: 10 }, (c) => c.fill(c.path().rect(0, 0, 10, 10), { fill: '#ff0000' }));
      p.fill(p.path().rect(0, 0, 100, 100), { fill: t });
    });
    expect(px(5, 5)).toEqual(RED);
    expect(px(15, 5)).toEqual(WHITE);
    expect(px(25, 25)).toEqual(RED);
    expect(px(25, 15)).toEqual(WHITE);
  });
  it('rotate and scale move a square where canvas would put it', async () => {
    const px = await render((p) => {
      p.save(); p.translate(50, 50); p.rotate(Math.PI / 4); p.scale(2);
      p.fill(p.path().rect(-5, -5, 10, 10), { fill: '#ff0000' }); // a diamond, 20 wide before rotating
      p.restore();
    });
    expect(px(50, 50)).toEqual(RED);
    expect(px(50, 36)).toEqual(RED); // the top corner reaches 50 − 14.1
    expect(px(40, 40)).toEqual(WHITE); // the square's own corner area, rotated away
  });
});

describe.skipIf(!HAS.verapdf)('veraPDF with graphics', () => {
  it('a tagged PDF/A page with gradients, opacity, a blend mode, a clip, a pattern and an SVG arc passes UA-1 and A-2b', async () => {
    const out = await toBytes(async (pdf) => {
      const f = await pdf.embedFont(INTER);
      const p = pdf.addPage({ width: 300, height: 300 });
      p.tag('H1', () => p.text('Sales by region', { x: 20, y: 10, font: f, size: 18 }));
      p.fill(p.path().rect(0, 0, 300, 5), { fill: p.linearGradient(0, 0, 300, 0, [[0, '#f00'], [0.5, '#0f0'], [1, '#00f']]) }); // decoration: an artifact
      p.figure({ alt: 'A green disc fading out, clipped to a square, beside a hatched square and a blue arc' }, () => {
        p.save(); p.clip(p.path().rect(50, 50, 100, 100));
        p.fill(p.path().arc(100, 100, 60, 0, 2 * Math.PI), { fill: p.radialGradient(100, 100, 0, 100, 100, 60, [[0, '#fff'], [1, '#080']]), opacity: 0.6, blendMode: 'multiply' });
        p.restore();
        const t = p.tilingPattern({ width: 8, height: 8 }, (c) => c.fill(c.path().rect(0, 0, 4, 4), { fill: '#c00', opacity: 0.5 }));
        p.fillAndStroke(p.path().roundedRect(160, 50, 100, 100, [10, 0, 10, 0]), { fill: t, stroke: 0, strokeOpacity: 0.5 });
        p.svgPath('M50 200 A50 50 0 0 1 150 200', { stroke: '#00f', width: 3, dash: [5, 2] });
        p.save(); p.translate(200, 220); p.rotate(0.3); p.shade(p.linearGradient(0, 0, 40, 0, [[0, 0], [1, 1]])); p.restore();
      });
      p.tag('P', () => p.text('Figures are in thousands.', { x: 20, y: 270, font: f }));
    }, { title: 'Graphics', tagged: { lang: 'en' }, pdfa: true, creationDate: DATE });
    await PDFDocument.load(out);
    const ua = verapdf(out, 'ua1'), a = verapdf(out, '2b');
    expect(ua.failed).toEqual([]);
    expect(a.failed).toEqual([]);
    expect(ua.ok && a.ok).toBe(true);
  }, 60000);
});
