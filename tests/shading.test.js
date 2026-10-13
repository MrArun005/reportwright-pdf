// Shadings and patterns (src/render/shading.js, functions.js and the painter): every fixture page against pdf.js
// pixel by pixel, function Types 0/2/3/4 by value, ShadingType 1 (pdf.js does not draw it) by its colours, and
// hostile input against each cap.
import { describe, it, expect, beforeAll } from 'vitest';
import zlib from 'node:zlib';
import { loadPdf, renderPage } from '../src/index.js';
import { compile, MAX_SAMPLES, MAX_PS_TOKENS, MAX_PS_STACK } from '../src/render/functions.js';
import { compileShading, MAX_VERTICES, MAX_PATCHES } from '../src/render/shading.js';
import { PdfStream } from '../src/reader/lexer.js';
import { cacheStats } from '../src/render/render.js';
import { shadingPdfs } from './shading-fixtures.js';
import { rawPdf } from './reader-tools.js';
import { HAS_PDFJS, pdfjsOpen, pdfjsRender, diff } from './pdfjs-render.js';
import { stdFonts } from '../packages/std-fonts/index.js';

const px = (r, x, y) => Array.from(r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 3));
const ctx = { R: (v) => v, data: (s) => s.bytes, tick() {} };
const strm = (dict, bytes) => new PdfStream(new Map(Object.entries(dict)), Buffer.from(bytes), -1, 0);
const quick = (fn, re) => {
  const t = Date.now();
  expect(fn).toThrow(re);
  expect(Date.now() - t).toBeLessThan(3000);
};
// streams built by hand carry their data in .bytes for these unit tests
const S = (dict, bytes) => Object.assign(strm(dict, bytes), { bytes: Buffer.from(bytes) });

let pdfs;
beforeAll(async () => {
  pdfs = await shadingPdfs();
});

describe('functions', () => {
  it('Type 2, Type 3 stitching, Type 0 sampled (interpolated), Type 4 calculator', () => {
    const f2 = compile(new Map(Object.entries({ FunctionType: 2, Domain: [0, 1], C0: [0], C1: [10], N: 2 })), ctx);
    expect(f2([0.5])).toEqual([2.5]);
    const f3 = compile(
      new Map(
        Object.entries({
          FunctionType: 3,
          Domain: [0, 1],
          Bounds: [0.5],
          Encode: [0, 1, 1, 0],
          Functions: [
            new Map(Object.entries({ FunctionType: 2, Domain: [0, 1], C0: [0], C1: [1], N: 1 })),
            new Map(Object.entries({ FunctionType: 2, Domain: [0, 1], C0: [0], C1: [1], N: 1 })),
          ],
        }),
      ),
      ctx,
    );
    expect(f3([0.25])[0]).toBeCloseTo(0.5);
    expect(f3([0.75])[0]).toBeCloseTo(0.5); // the second piece's Encode runs backwards
    const f0 = compile(
      S({ FunctionType: 0, Domain: [0, 1], Range: [0, 1], Size: [3], BitsPerSample: 8 }, [0, 255, 0]),
      ctx,
    );
    expect(f0([0.25])[0]).toBeCloseTo(0.5);
    expect(f0([0.5])[0]).toBeCloseTo(1);
    const f4 = compile(
      S(
        { FunctionType: 4, Domain: [0, 1, 0, 1], Range: [0, 10, 0, 10] },
        '{ 2 copy add 3 1 roll mul 4 1 index 2 gt { 1 add } if pop }',
      ),
      ctx,
    );
    expect(f4([0.5, 1])).toEqual([1.5, 0.5]);
  });
});

describe('ShadingType 1 (function-based) by its colours', () => {
  it('a PostScript function over a Matrix-mapped Domain', async () => {
    const r = renderPage(await loadPdf(pdfs['sh-function']), 0, { scale: 2 });
    // domain (x, y) → (xy, y > 0.5 ? 1 : 2y, x): corners of the 260 × 180 box at (20, 20)
    const at = (x, y) => px(r, Math.round((20 + 260 * x) * 2), Math.round((220 - 20 - 180 * y) * 2));
    const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 6);
    expect(near(at(0.02, 0.98), [0, 255, 5])).toBe(true);
    expect(near(at(0.98, 0.02), [5, 10, 250])).toBe(true);
    expect(near(at(0.5, 0.25), [32, 128, 128])).toBe(true);
  });
});

describe.runIf(HAS_PDFJS)('against pdf.js, pixel by pixel', () => {
  // meshes: no anti-aliasing at their edges in either, so their outlines differ by a pixel; tiling: cell resampling
  const limit = { 'mesh-4': 2, 'mesh-5': 2, 'patch-6': 3, 'patch-7': 3, tiling: 4 };
  for (const name of [
    'sh-axial',
    'sh-radial',
    'mesh-4',
    'mesh-5',
    'patch-6',
    'patch-7',
    'pattern-shading',
    'tiling',
    'chart',
  ])
    it(name, async () => {
      const bytes = pdfs[name];
      const ours = renderPage(await loadPdf(bytes), 0, { scale: 2, fonts: stdFonts });
      const r = diff(ours, await pdfjsRender(await pdfjsOpen(bytes), 0, 2));
      console.log(`${name}: ${r.pct.toFixed(2)}% of pixels differ, ${r.inkPct.toFixed(2)}% of inked ones`);
      expect(r.ink).toBeGreaterThan(1000);
      expect(r.inkPct).toBeLessThan(limit[name] ?? 1);
    });
});

describe('caps: hostile input stops early', () => {
  it('a sampled function larger than the cap is refused before its data is read', () => {
    quick(
      () =>
        compile(
          S(
            { FunctionType: 0, Domain: [0, 1, 0, 1], Range: [0, 1, 0, 1, 0, 1], Size: [1001, 1001], BitsPerSample: 8 },
            [],
          ),
          ctx,
        ),
      new RegExp(`more than ${MAX_SAMPLES.toLocaleString('en')} samples`),
    );
  });
  it('calculator: too many tokens, too deep a stack, blocks nested too deep', () => {
    const f = (p) => compile(S({ FunctionType: 4, Domain: [0, 1], Range: [0, 1] }, p), ctx);
    quick(() => f(`{ ${'1 pop '.repeat(MAX_PS_TOKENS / 2 + 1)}}`), /tokens/);
    quick(() => f(`{ ${'1 '.repeat(MAX_PS_STACK + 1)}}`)([0]), /stack deeper/);
    quick(() => f(`${'{ '.repeat(200)}${'} '.repeat(200)}`), /nest too deep/);
  });
  it('a stitching of stitchings that would multiply past the function cap', () => {
    let f = new Map(Object.entries({ FunctionType: 2, Domain: [0, 1], C0: [0], C1: [1], N: 1 }));
    for (let i = 0; i < 4; i++)
      f = new Map(
        Object.entries({
          FunctionType: 3,
          Domain: [0, 1],
          Bounds: Array.from({ length: 199 }, (_, k) => (k + 1) / 200),
          Encode: Array(400).fill(0),
          Functions: Array(200).fill(f),
        }),
      );
    quick(() => compile(f, ctx), /more than 1024 functions/);
  });
  it('functions that contain themselves, or nest past the cap', () => {
    const self = new Map(Object.entries({ FunctionType: 3, Domain: [0, 1], Bounds: [], Encode: [0, 1] }));
    self.set('Functions', [self]);
    quick(() => compile(self, ctx), /contains itself/);
    let deep = new Map(Object.entries({ FunctionType: 2, Domain: [0, 1], C0: [0], C1: [1], N: 1 }));
    for (let i = 0; i < 12; i++)
      deep = new Map(
        Object.entries({ FunctionType: 3, Domain: [0, 1], Bounds: [], Encode: [0, 1], Functions: [deep] }),
      );
    quick(() => compile(deep, ctx), /nest more than/);
  });
  const mesh = (type, extra, bytes) =>
    compileShading(
      S(
        {
          ShadingType: type,
          ColorSpace: 'DeviceGray',
          BitsPerCoordinate: 8,
          BitsPerComponent: 8,
          BitsPerFlag: 8,
          Decode: [0, 1, 0, 1, 0, 1],
          ...extra,
        },
        bytes,
      ),
      { ...ctx, space: () => ({ n: 1, rgb: (c) => [c[0], c[0], c[0]] }) },
    );
  it('a mesh with more vertices than the cap is refused before any is read', () =>
    quick(() => mesh(4, {}, Buffer.alloc(4 * (MAX_VERTICES + 1))), /more than 1,000,000 vertices/));
  it('more patches than the cap', () =>
    quick(() => mesh(6, {}, Buffer.alloc(30 * (MAX_PATCHES + 1))), /more than 100,000 patches/));
  it('the per-document shading cache stops growing at its cap', async () => {
    const n = 4200;
    const names = Array.from({ length: n }, (_, i) => `/S${i} ${5 + i} 0 R`).join(' ');
    const content = Array.from({ length: n }, (_, i) => `/S${i} sh`).join(' ');
    const d = await loadPdf(
      rawPdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 4 4] /Contents 4 0 R /Resources << /Shading << ${names} >> >> >>`,
        [`<< /Length ${content.length} >>`, content],
        ...Array.from(
          { length: n },
          () =>
            '<< /ShadingType 2 /ColorSpace /DeviceGray /Coords [0 0 4 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 1 >> >>',
        ),
      ]),
    );
    renderPage(d, 0);
    expect(cacheStats(d)[0].shadings).toBeLessThanOrEqual(4096);
  });
  it('a calculator is charged for every operator it runs, on every evaluation', () => {
    let steps = 0;
    const c = { ...ctx, tick: (n) => (steps += n) };
    const body = Array(2000).fill('1 add').join(' ');
    const f = compile(S({ FunctionType: 4, Domain: [0, 1], Range: [0, 1e6] }, `{ true { ${body} } if }`), c);
    steps = 0;
    for (let i = 0; i < 10; i++) f([0]);
    expect(steps).toBeGreaterThanOrEqual(10 * 4000);
  });
  it('a sampled function over many inputs is charged for its corner lookups', () => {
    let steps = 0;
    const c = { ...ctx, tick: (n) => (steps += n) };
    const m = 8;
    const f = compile(
      S(
        {
          FunctionType: 0,
          Domain: Array(m).fill([0, 1]).flat(),
          Range: [0, 1],
          Size: Array(m).fill(2),
          BitsPerSample: 8,
        },
        Array(256).fill(128),
      ),
      c,
    );
    steps = 0;
    for (let i = 0; i < 10; i++) f(Array(m).fill(0.5));
    expect(steps).toBeGreaterThanOrEqual(10 * (1 << m) * 0.25);
  });
  it("tiling cells share the page's clip-mask budget", async () => {
    const n = 20,
      clips = Array(60).fill('1 1 998 998 re W n').join(' ');
    const use = Array.from({ length: n }, (_, k) => `/P${k} scn 0 0 1 1 re f`).join(' ');
    const d = await loadPdf(
      rawPdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 1000] /Contents 4 0 R /Resources << /Pattern << ${Array.from({ length: n }, (_, k) => `/P${k} ${5 + k} 0 R`).join(' ')} >> >> >>`,
        [`<< /Length ${12 + use.length} >>`, `/Pattern cs ${use}`],
        ...Array.from({ length: n }, () => [
          `<< /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 1000 1000] /XStep 1000 /YStep 1000 /Length ${clips.length} >>`,
          clips,
        ]),
      ]),
    );
    expect(() => renderPage(d, 0)).toThrow(/clipping/);
  });
  it('a tiny XStep over a huge area draws one small cell, not millions', async () => {
    const d = await loadPdf(
      rawPdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 1000] /Contents 4 0 R /Resources << /Pattern << /P 5 0 R >> >> >>',
        ['<< /Length 37 >>', '/Pattern cs /P scn 0 0 1000 1000 re f'],
        [
          '<< /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 0.001 0.001] /XStep 0.001 /YStep 0.001 /Length 19 >>',
          '0 0 0.0005 0.001 re f',
        ],
      ]),
    );
    const t = Date.now();
    renderPage(d, 0, { scale: 2 });
    expect(Date.now() - t).toBeLessThan(5000);
  });
  it('a tiling pattern that paints with itself is not re-entered; a chain stops at the depth cap', async () => {
    const objs = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources << /Pattern << /P 5 0 R >> >> >>',
      ['<< /Length 35 >>', '/Pattern cs /P scn 0 0 100 100 re f'],
    ];
    // pattern k (object 5 + k) fills its cell with pattern k + 1; the last one with pattern 0 (itself, through the chain)
    for (let k = 0; k < 20; k++)
      objs.push([
        `<< /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources << /Pattern << /P ${k < 19 ? 6 + k : 5} 0 R >> >> /Length 33 >>`,
        '/Pattern cs /P scn 0 0 10 10 re f',
      ]);
    const d = await loadPdf(rawPdf(objs));
    const t = Date.now();
    renderPage(d, 0, { scale: 2 });
    expect(Date.now() - t).toBeLessThan(5000);
  });
  it('many sh of a mesh on one page: drawn once, each paint charged per pixel against the budget', async () => {
    const w = Buffer.from([0, 0, 0, 0, 0, 255, 0, 0, 0, 0, 255, 0]); // one triangle, gray, 8-bit coordinates
    const d = await loadPdf(
      rawPdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Contents 4 0 R /Resources << /Shading << /M 5 0 R >> >> >>',
        [
          `<< /Filter /FlateDecode /Length ${zlib.deflateSync(Buffer.from('/M sh '.repeat(20000))).length} >>`,
          zlib.deflateSync(Buffer.from('/M sh '.repeat(20000))),
        ],
        [
          `<< /ShadingType 4 /ColorSpace /DeviceGray /BitsPerCoordinate 8 /BitsPerComponent 8 /BitsPerFlag 8 /Decode [0 400 0 400 0 1] /Length 12 >>`,
          w,
        ],
      ]),
    );
    const t = Date.now();
    expect(() => renderPage(d, 0, { scale: 2 })).toThrow(/steps/); // the default budget
    expect(Date.now() - t).toBeLessThan(10_000);
  });
});

describe('tiling steps too small to sample', () => {
  it('a subnormal XStep draws nothing and ends (it looped forever)', { timeout: 10000 }, async () => {
    const s = Buffer.from((await shadingPdfs()).tiling)
      .toString('latin1')
      .replace('/XStep 20 /YStep 20', '/XStep 1e-320 /YStep 1e-320');
    const d = await loadPdf(Buffer.from(s, 'latin1'));
    const t = Date.now();
    renderPage(d, 0, { scale: 1 });
    expect(Date.now() - t).toBeLessThan(5000);
  });
});
