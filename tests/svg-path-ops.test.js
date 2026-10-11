// svgPathOps: SVG path data as PDF path operators (same parser as page.svgPath), plus a byte-identity guard on page.svgPath.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { toBytes, svgPathOps } from '../src/index.js';

describe('svgPathOps', () => {
  it('M/m and L/l', () => {
    expect(svgPathOps('M10 20 L30 40')).toBe('10 20 m 30 40 l');
    expect(svgPathOps('m10 20 l30 40')).toBe('10 20 m 40 60 l');
  });
  it('H/h and V/v', () => {
    expect(svgPathOps('M10 10 H50 V30')).toBe('10 10 m 50 10 l 50 30 l');
    expect(svgPathOps('M10 10 h5 v5')).toBe('10 10 m 15 10 l 15 15 l');
  });
  it('C/c and S/s (reflected control point)', () => {
    expect(svgPathOps('M0 0 C1 2 3 4 5 6')).toBe('0 0 m 1 2 3 4 5 6 c');
    expect(svgPathOps('M0 0 c1 2 3 4 5 6')).toBe('0 0 m 1 2 3 4 5 6 c');
    // S reflects the previous C's second control point (3 4) about (5 6): 7 8
    expect(svgPathOps('M0 0 C1 2 3 4 5 6 S9 10 11 12')).toBe('0 0 m 1 2 3 4 5 6 c 7 8 9 10 11 12 c');
  });
  it('Q/q and T/t (quadratics as cubics)', () => {
    // quadratic (0,0) ctrl (6,6) end (12,0): cubic controls at 2/3 of the way
    expect(svgPathOps('M0 0 Q6 6 12 0')).toBe('0 0 m 4 4 8 4 12 0 c');
    expect(svgPathOps('M0 0 q6 6 12 0')).toBe('0 0 m 4 4 8 4 12 0 c');
    expect(svgPathOps('M0 0 Q6 6 12 0 T24 0')).toBe('0 0 m 4 4 8 4 12 0 c 16 -4 20 -4 24 0 c');
  });
  it('A/a converts to cubics that end at the arc end point', () => {
    const ops = svgPathOps('M0 0 A10 10 0 0 1 20 0');
    expect(ops).not.toMatch(/ a/);
    expect(ops.endsWith(' c')).toBe(true);
    const tail = ops.split(' ').slice(-7, -1).map(Number);
    expect(tail[4]).toBeCloseTo(20, 6);
    expect(tail[5]).toBeCloseTo(0, 6);
  });
  it('Z/z closes the subpath with h', () => {
    expect(svgPathOps('M0 0 L10 0 L10 10 Z')).toBe('0 0 m 10 0 l 10 10 l h');
    expect(svgPathOps('M0 0 L10 0 z L5 5')).toBe('0 0 m 10 0 l h 5 5 l');
  });
  it('relative commands are relative to the current point, and after z to the subpath start', () => {
    expect(svgPathOps('M10 10 l5 5 l5 -5 z l3 3')).toBe('10 10 m 15 15 l 20 10 l h 13 13 l');
  });
  it('implicit repeats: extra coordinate sets after M are L, after m are l', () => {
    expect(svgPathOps('M0 0 10 0 10 10')).toBe('0 0 m 10 0 l 10 10 l');
    expect(svgPathOps('m0 0 10 0 10 10')).toBe('0 0 m 10 0 l 20 10 l');
    expect(svgPathOps('M0 0 L10 0 20 0 30 0')).toBe('0 0 m 10 0 l 20 0 l 30 0 l');
  });
  it('numbers may be separated by commas, spaces, signs or nothing ("1.5.5", "-1e3", ".5-.5")', () => {
    expect(svgPathOps('M1.5.5L-1e1,.5-.5 2')).toBe('1.5 0.5 m -10 0.5 l -0.5 2 l');
  });
  it('scaleY multiplies y (and -1 flips it)', () => {
    expect(svgPathOps('M10 20 L30 40', { scaleY: -1 })).toBe('10 -20 m 30 -40 l');
    expect(svgPathOps('M10 20 L30 40', { scaleY: 2 })).toBe('10 40 m 30 80 l');
  });
  it('malformed data throws a TypeError, quickly', () => {
    const t = performance.now();
    for (const bad of ['L10 10', 'M10', 'M10 10 X5 5', 'M10 10 A5 5 0 2 0 5 5', 'M1e 2', 'M10 10 L', 'M10 10 Z 5 5']) {
      expect(() => svgPathOps(bad), bad).toThrow(TypeError);
    }
    expect(performance.now() - t).toBeLessThan(1000);
  });
  it('a 100k-command path finishes in bounded time relative to a 10x smaller one', () => {
    const make = (n) => 'M0 0' + ' l1 1 c1 1 2 2 3 3'.repeat(n);
    const time = (d) => {
      const t = performance.now();
      svgPathOps(d);
      return performance.now() - t;
    };
    // 100k commands: 50k repeats of an l and a c; the small path is a tenth of that
    const small = make(5_000);
    time(small);
    const tSmall = Math.max(time(small), 1);
    const tBig = time(make(50_000));
    expect(tBig).toBeLessThan(tSmall * 10 * 3 + 200);
  });
});

describe('page.svgPath stays byte-identical', () => {
  it('a generated PDF with fixed date hashes to the pre-change value', async () => {
    const d =
      'M10 10 C20 0 40 0 50 10 Q60 20 70 10 A15 15 0 0 1 100 30 S120 60 130 40 T150 40 l0 20 h-20 v-10 z m5 5 a5 5 0 1 0 10 0 Z';
    const out = await toBytes(
      (pdf) => {
        const p = pdf.addPage({ width: 200, height: 200 });
        p.svgPath(d, { fill: [1, 0, 0], stroke: [0, 0, 1] });
        p.svgPath('M0 0 L50 50', { stroke: [0, 0, 0] });
      },
      { compress: false, creationDate: new Date('2026-01-01') },
    );
    // up to the xref stream: its compressed bytes come from the platform's zlib (beta.15), so they are not hashed
    const head = Buffer.from(out).toString('latin1');
    const body = head.slice(0, head.lastIndexOf('/Type /XRef'));
    expect(createHash('sha256').update(body, 'latin1').digest('hex')).toBe(
      'af35b5669785938e2c636702670ae8050be4d73feb262027c13357fca2c6662b',
    );
  });
});
