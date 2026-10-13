// Rendering (experimental): the rasterizer's coverage, fill rules and strokes, glyph outlines (TrueType and CFF), PNG
// output, hostile input, and every fixture page against pdf.js (pdfjs-dist + @napi-rs/canvas, dev dependencies) pixel
// by pixel: the share of inked pixels that differ by more than 48 levels (anti-aliasing differences stay under it).
import { describe, it, expect, beforeAll } from 'vitest';
import zlib from 'node:zlib';
import { loadPdf, renderPage, toPng } from '../src/index.js';
import { rasterizer, flatten, stroke } from '../src/render/raster.js';
import { glyfOutlines, cffOutlines } from '../src/render/glyphs.js';
import { sfntTables, parseFont } from '../src/fonts/truetype.js';
import { INTER } from './tools.js';
import { onePage, rawPdf, enc } from './reader-tools.js';
import { ours, pdfLib } from './render-fixtures.js';
import { HAS_PDFJS, pdfjsOpen, pdfjsRender, diff } from './pdfjs-render.js';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './tools.js';

/** coverage of a W × H device after filling polys @param {number[][]} polys */
function cover(W, H, polys, eo = false) {
  const m = new Float32Array(W * H);
  rasterizer(W, H).fill(polys, eo, (y, a, b, c) => {
    for (let x = a; x < b; x++) m[y * W + x] = c[x];
  });
  return m;
}
const px = (r, x, y) => Array.from(r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4));

describe('rasterizer', () => {
  it('exact coverage: a square on half pixels covers its edge pixels by half', () => {
    const m = cover(4, 4, [[0.5, 0, 3.5, 0, 3.5, 4, 0.5, 4]]);
    expect([m[0], m[1], m[2], m[3]]).toEqual([0.5, 1, 1, 0.5]);
  });
  it('non-zero fills a same-direction inner square, even-odd leaves it a hole', () => {
    const outer = [0, 0, 8, 0, 8, 8, 0, 8],
      inner = [2, 2, 6, 2, 6, 6, 2, 6];
    expect(cover(8, 8, [outer, inner])[4 * 8 + 4]).toBe(1);
    expect(cover(8, 8, [outer, inner], true)[4 * 8 + 4]).toBe(0);
  });
  it('strokes: width, butt / square / round caps, miter joins', () => {
    const line = flatten([0, 2, 5, 1, 8, 5], 0.1);
    const area = (polys) => cover(16, 16, polys).reduce((a, b) => a + b, 0);
    expect(area(stroke(line, 1, 0, 0, 10, 32))).toBeCloseTo(12, 1); // 6 long, 2 wide
    expect(area(stroke(line, 1, 2, 0, 10, 32))).toBeCloseTo(16, 1); // + 1 at each end
    expect(area(stroke(line, 1, 1, 0, 10, 32))).toBeCloseTo(12 + Math.PI, 0);
    const corner = flatten([0, 2, 2, 1, 8, 2, 1, 8, 8], 0.1);
    expect(cover(16, 16, stroke(corner, 1, 0, 0, 10, 32))[1 * 16 + 8]).toBe(1); // the miter's outer corner
    expect(cover(16, 16, stroke(corner, 1, 0, 2, 10, 32))[1 * 16 + 8]).toBeLessThan(0.6); // a bevel cuts it
  });
});

describe('glyph outlines', () => {
  it('TrueType (glyf, quadratics as cubics) and CFF (Type 2 charstrings)', () => {
    const f = parseFont(INTER);
    const g = glyfOutlines(sfntTables(INTER), f.indexToLocFormat, f.numGlyphs)(f.glyphFor(0x4f)); // O
    expect(g.filter((v, i) => i === 0 || g[i - 1] === 3).filter((v) => v === 0).length).toBe(2); // two contours
    expect(g).toContain(2);
    const SC = fs.readFileSync(path.join(ROOT, 'tests/fixtures/fonts/NotoSansSC-Subset.otf'));
    const sc = parseFont(SC);
    const c = cffOutlines(sfntTables(SC).get('CFF ')).glyph(sc.glyphFor(0x4e2d)); // 中
    expect(c.length).toBeGreaterThan(20);
    const xs = c.filter((_, i) => i > 0); // the glyph lies inside its em
    expect(Math.max(...xs)).toBeLessThan(1100);
  });
});

describe('renderPage', () => {
  it('fills, colours and the page size at a scale; toPng writes a valid PNG', async () => {
    const d = await loadPdf(onePage('1 0 0 rg 0 0 100 100 re f 0 0 1 RG 4 w 100 100 m 200 200 l S'));
    const r = renderPage(d, 0, { scale: 0.5 });
    expect([r.width, r.height]).toEqual([100, 100]);
    expect(px(r, 10, 90)).toEqual([255, 0, 0, 255]); // bottom-left red (y down)
    expect(px(r, 10, 10)).toEqual([255, 255, 255, 255]);
    expect(px(r, 75, 25)[2]).toBe(255); // on the line, anti-aliased
    expect(px(r, 75, 25)[0]).toBeLessThan(64);
    const png = await toPng(r);
    expect(Array.from(png.subarray(1, 4))).toEqual([80, 78, 71]);
    const idat = png.indexOf(0x49, 33); // IDAT's data follows its type
    const z = Buffer.from(png.subarray(idat + 4, png.length - 12 - 4));
    expect(zlib.inflateSync(z).length).toBe(100 * (100 * 4 + 1));
  });
  it('clips, CMYK, gray, and constant opacity', async () => {
    const d = await loadPdf(
      onePage(
        'q 0 0 50 200 re W n 0 0 0 1 k 0 0 200 200 re f Q 0.5 g 150 0 50 50 re f /G1 gs 1 0 0 rg 150 150 50 50 re f',
        '<< >>',
      ),
    );
    const r = renderPage(d, 0);
    expect(px(r, 25, 100)).toEqual([0, 0, 0, 255]);
    expect(px(r, 100, 100)).toEqual([255, 255, 255, 255]); // clipped away
    expect(px(r, 175, 175).slice(0, 3)).toEqual([128, 128, 128]);
    expect(px(r, 175, 25).slice(0, 3)).toEqual([255, 0, 0]); // no ExtGState /G1: drawn opaque
  });
  it('inline images: RGB samples and a stencil mask in the fill colour', async () => {
    const d = await loadPdf(
      onePage(
        enc(
          'q 100 0 0 100 0 100 cm BI /W 2 /H 1 /BPC 8 /CS /RGB ID \xff\x00\x00\x00\x00\xff EI Q ' +
            'q 0 1 0 rg 100 0 0 100 100 0 cm BI /W 1 /H 1 /IM true ID \x00 EI Q',
        ),
      ),
    );
    const r = renderPage(d, 0);
    expect(px(r, 25, 50).slice(0, 3)).toEqual([255, 0, 0]);
    expect(px(r, 75, 50).slice(0, 3)).toEqual([0, 0, 255]);
    expect(px(r, 150, 150).slice(0, 3)).toEqual([0, 255, 0]);
  });
  it('standard fonts draw with a substitute when given, nothing otherwise', async () => {
    const d = await loadPdf(onePage('BT /F1 40 Tf 10 80 Td (HH) Tj ET'));
    const ink = (r) => r.data.filter((v, i) => i % 4 === 0 && v < 128).length;
    expect(ink(renderPage(d, 0))).toBe(0);
    expect(ink(renderPage(d, 0, { fonts: { Helvetica: INTER } }))).toBeGreaterThan(100);
  });
  it('hostile: a form drawing itself, a broken font, an absurd scale', async () => {
    const self = await loadPdf(
      rawPdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 50 50] /Contents 4 0 R /Resources << /XObject << /X 5 0 R >> /Font << /F 6 0 R >> >> >>',
        ['<< /Length 30 >>', '/X Do BT /F 9 Tf (a) Tj ET 0 g'],
        [
          '<< /Type /XObject /Subtype /Form /BBox [0 0 50 50] /Resources << /XObject << /X 5 0 R >> >> /Length 20 >>',
          '0 0 10 10 re f /X Do',
        ],
        '<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /DescendantFonts [7 0 R] >>',
        '<< /Type /Font /Subtype /CIDFontType2 /FontDescriptor << /FontFile2 8 0 R >> >>',
        ['<< /Length 8 >>', 'notafont'],
      ]),
    );
    const r = renderPage(self, 0);
    expect(px(r, 5, 45).slice(0, 3)).toEqual([0, 0, 0]);
    expect(() => renderPage(self, 0, { scale: 101 })).toThrow(RangeError);
    const big = await loadPdf(
      rawPdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 14400 14400] >>',
      ]),
    );
    expect(() => renderPage(big, 0, { scale: 2 })).toThrow(/too large/);
    expect(() => renderPage(self, 0, { dpi: 2 })).toThrow(TypeError);
  });
});

describe.runIf(HAS_PDFJS)('against pdf.js, pixel by pixel', () => {
  /** @type {Record<string, Uint8Array>} */
  let all;
  beforeAll(async () => {
    all = { ...(await ours()), ...(await pdfLib()) };
  });
  // pdf-lib's pages use standard Helvetica: we draw Inter in its place, pdf.js its Foxit Sans, so the text differs
  const limit = { 'pdflib-vector': 6, 'pdflib-image-form': 4 };
  for (const name of ['text', 'table', 'vector', 'images', 'form', 'cff', 'pdflib-vector', 'pdflib-image-form'])
    it(name, async () => {
      const bytes = all[name];
      const ours = renderPage(await loadPdf(bytes), 0, { scale: 2, fonts: { default: INTER } });
      const theirs = await pdfjsRender(await pdfjsOpen(bytes), 0, 2);
      expect([ours.width, ours.height]).toEqual([theirs.width, theirs.height]);
      const r = diff(ours, theirs);
      console.log(`${name}: ${r.pct.toFixed(2)}% of pixels differ, ${r.inkPct.toFixed(2)}% of inked ones`);
      expect(r.ink).toBeGreaterThan(1000);
      expect(r.inkPct).toBeLessThan(limit[name] ?? 1);
    });
});
