// Rendering (experimental): the rasterizer's coverage, fill rules and strokes, glyph outlines (TrueType and CFF), PNG
// output, hostile input, and every fixture page against pdf.js (pdfjs-dist + @napi-rs/canvas, dev dependencies) pixel
// by pixel: the share of inked pixels that differ by more than 48 levels (anti-aliasing differences stay under it).
import { describe, it, expect, beforeAll } from 'vitest';
import zlib from 'node:zlib';
import { loadPdf, renderPage, toPng } from '../src/index.js';
import { rasterizer, flatten, stroke, MAX_POINTS } from '../src/render/raster.js';
import { glyfOutlines, cffOutlines } from '../src/render/glyphs.js';
import { MAX_FORM_DRAWS, MAX_DOC_FONTS, cacheStats } from '../src/render/render.js';
import { sfntTables, parseFont } from '../src/fonts/truetype.js';
import { INTER } from './tools.js';
import { onePage, rawPdf, enc } from './reader-tools.js';
import { ours, pdfLib } from './render-fixtures.js';
import { stdFonts } from '../packages/std-fonts/index.js';
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
    expect(px(r, 25, 100)).toEqual([44, 46, 53, 255]); // CMYK K=1 as pdf.js draws it (its press-profile fit)
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
  it('a JPEG it cannot decode (12-bit) is skipped; the page still draws', async () => {
    const j = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 12, 0, 8, 0, 8, 1, 1, 0x11, 0, 0xff, 0xd9]);
    const d = await loadPdf(
      rawPdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Contents 4 0 R /Resources << /XObject << /I 5 0 R >> >> >>',
        ['<< /Length 30 >>', 'q 10 0 0 10 0 0 cm /I Do Q 0 g'],
        [
          `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /BitsPerComponent 8 /ColorSpace /DeviceGray /Filter /DCTDecode /Length ${j.length} >>`,
          j,
        ],
      ]),
    );
    expect(px(renderPage(d, 0), 5, 5)).toEqual([255, 255, 255, 255]);
  });
  it('the optional standard-font package draws all 14, ZapfDingbats and Symbol by their own codes', async () => {
    const page = (font, text) =>
      loadPdf(
        rawPdf([
          '<< /Type /Catalog /Pages 2 0 R >>',
          '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
          '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 60] /Contents 4 0 R /Resources << /Font << /F 5 0 R >> >> >>',
          [`<< /Length ${23 + text.length} >>`, `BT /F 40 Tf 5 10 Td (${text}) Tj ET`],
          `<< /Type /Font /Subtype /Type1 /BaseFont /${font} >>`,
        ]),
      );
    const ink = (r) => r.data.filter((v, i) => i % 4 === 0 && v < 128).length;
    for (const f of Object.keys(stdFonts)) {
      const d = await page(f, f === 'ZapfDingbats' ? '4' : 'ab'); // ZapfDingbats 0x34: a check mark
      expect(ink(renderPage(d, 0, { fonts: stdFonts })), f).toBeGreaterThan(50);
    }
    const sym = await page('Symbol', 'a');
    expect(ink(renderPage(sym, 0, { fonts: { default: INTER } }))).toBe(0); // never a Latin stand-in
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

describe('resource caps (hostile input stops early, with a clear error)', () => {
  const z = (s) => onePage(zlib.deflateSync(Buffer.from(s, 'latin1')), '<< /Filter /FlateDecode >>');
  const quick = async (bytes, re) => {
    const t = Date.now();
    expect(() => renderPage(bytesDoc[bytes], 0)).toThrow(re);
    expect(Date.now() - t).toBeLessThan(10_000);
  };
  const bytesDoc = {};
  const load = async (k, b) => (bytesDoc[k] = await loadPdf(b));
  it('a path of millions of segments', async () => {
    await load('path', z('0 0 m ' + '1 1 l '.repeat(2_100_000) + 'S'));
    await quick('path', /path holds more/);
  });
  it('a dash pattern of tiny dashes', async () => {
    await load('dash', z('[0.0001 0.0001] 0 d 0 0 m 200 0 l S'));
    await quick('dash', /dashes/);
  });
  it('q nested too deep', async () => {
    await load('q', z('q '.repeat(300)));
    await quick('q', /nest more than/);
  });
  it('clip masks past the byte cap', async () => {
    await load('clip', z('q 0 0 10 10 re W n Q '.repeat(30_000)));
    await quick('clip', /clipping needs more/);
  });
  it('form XObjects fanning out (each draws the next 100 times)', async () => {
    const f = (next) => [
      `<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << /XObject << /N ${next} 0 R >> >> /Length ${'/N Do '.length * 100} >>`,
      '/N Do '.repeat(100),
    ];
    await load(
      'forms',
      rawPdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Contents 4 0 R /Resources << /XObject << /N 5 0 R >> >> >>',
        ['<< /Length 5 >>', '/N Do'],
        f(6),
        f(7),
        f(8),
        ['<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Length 0 >>', ''],
      ]),
    );
    await quick('forms', new RegExp(`more than ${MAX_FORM_DRAWS.toLocaleString('en')} form`));
  });
  it('an image declaring 10 G pixels is never decoded or allocated', async () => {
    const d = await loadPdf(
      rawPdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Contents 4 0 R /Resources << /XObject << /I 5 0 R >> >> >>',
        ['<< /Length 5 >>', '/I Do'],
        [
          '<< /Type /XObject /Subtype /Image /Width 100000 /Height 100000 /BitsPerComponent 8 /ColorSpace /DeviceGray /Length 1 >>',
          'x',
        ],
      ]),
    );
    const t = Date.now();
    expect(renderPage(d, 0).width).toBe(10);
    expect(Date.now() - t).toBeLessThan(1000);
  });
  it('curves that flatten to millions of points stop before the points are made', async () => {
    await load('curves', z('0 0 m ' + '0 0 9000 9000 0 9000 c '.repeat(500_000) + 'f'));
    await quick('curves', /flattens to more/);
  });
  it('a round-joined zigzag whose stroke multiplies past the point cap', async () => {
    let s = '200 w 1 j 0 0 m ';
    for (let i = 0; i < 100_000; i++) s += `${i % 2 ? 10 : 0} ${i} l `;
    await load('zig', z(s + 'S'));
    await quick('zig', /stroke expands/);
  });
  it('rows crossed by 200,000 edges: the per-edge work is counted, so a budget stops it early', async () => {
    let s = '';
    for (let i = 0; i < 100_000; i++) s += `${(i * 7919) % 200}.${i % 97} 0 0.001 200 re `;
    const d = await loadPdf(z(s + 'f'), { budget: { maxSteps: 3_000_000 } });
    const t = Date.now();
    expect(() => renderPage(d, 0)).toThrow(/steps/);
    expect(Date.now() - t).toBeLessThan(10_000);
  });
  it('many small fills, clips and strokes each under its cap add up against the budget', async () => {
    const many = (op) => loadPdf(z(op.repeat(20_000)), { budget: { maxSteps: 2_000_000 } });
    for (const op of ['0 0 200 200 re f ', 'q 0 0 200 200 re W n Q ', '[0.01] 0 d 0 0 m 200 200 l S ']) {
      const d = await many(op);
      const t = Date.now();
      expect(() => renderPage(d, 0)).toThrow(/steps/);
      expect(Date.now() - t).toBeLessThan(10_000);
    }
  });
  it('a fill of more points than the cap stops before its edges are allocated', () => {
    const poly = new Float64Array((MAX_POINTS + 1) * 2);
    expect(() => rasterizer(10, 10).fill([poly], false, () => {})).toThrow(/more than 4,000,000 points/);
  });
  it('wide, nearly flat edges: the cells they cross are counted', async () => {
    const d = await loadPdf(z('0 0 m 1e7 1 l 0 2 l f '.repeat(5000)), { budget: { maxSteps: 2_000_000 } });
    const t = Date.now();
    expect(() => renderPage(d, 0, { scale: 20 })).toThrow(/steps/);
    expect(Date.now() - t).toBeLessThan(10_000);
  });
  it('glyph coverage bitmaps stay within their count and byte caps, each drawn glyph charged', async () => {
    // 12,000 sizes and subpixel offsets: a bitmap each, the cache cleared at its caps
    let content = 'BT ';
    for (let i = 0; i < 12000; i++)
      content += `/F1 ${(4 + (i % 120) * 0.25).toFixed(2)} Tf ${i % 7}.${i % 13} 0 Td (H) Tj `;
    const d = await loadPdf(onePage(content + 'ET'));
    renderPage(d, 0, { fonts: { Helvetica: INTER } });
    const s = cacheStats(d)[0];
    expect(s.glyphBitmaps).toBeGreaterThan(0);
    expect(s.glyphBitmaps).toBeLessThanOrEqual(8192);
    expect(s.glyphBitmapBytes).toBeLessThanOrEqual(16_000_000);
    const t = Date.now();
    const big = await loadPdf(onePage('BT /F1 40 Tf ' + '1 0 0 1 10 40 Tm (HHHHHHHHHH) Tj '.repeat(20000) + 'ET'), {
      budget: { maxSteps: 2_000_000 },
    });
    expect(() => renderPage(big, 0, { fonts: { Helvetica: INTER } })).toThrow(/steps/); // cached glyphs still cost
    expect(Date.now() - t).toBeLessThan(10_000);
  });
  it('the per-document caches stop growing at their caps (fonts here)', async () => {
    const n = MAX_DOC_FONTS + 50;
    let content = 'BT ';
    const fonts = [];
    for (let i = 0; i < n; i++) {
      content += `/F${i} 9 Tf (a) Tj `;
      fonts.push(`/F${i} ${5 + i} 0 R`);
    }
    const d = await loadPdf(
      rawPdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Contents 4 0 R /Resources << /Font << ${fonts.join(' ')} >> >> >>`,
        [`<< /Length ${content.length + 2} >>`, content + 'ET'],
        ...Array.from({ length: n }, () => '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
      ]),
    );
    renderPage(d, 0);
    renderPage(d, 0);
    expect(cacheStats(d)[0].fonts).toBeLessThanOrEqual(MAX_DOC_FONTS);
    expect(cacheStats(d)[0].content).toBe(1);
  });
  it('a composite glyph made of itself, 64 times at every level', () => {
    const glyf = Buffer.alloc(10 + 64 * 6);
    glyf.writeInt16BE(-1, 0);
    for (let i = 0; i < 64; i++) {
      glyf.writeUInt16BE(i < 63 ? 0x22 : 0x02, 10 + i * 6); // ARGS_ARE_XY_VALUES (+ MORE_COMPONENTS)
      glyf.writeUInt16BE(0, 12 + i * 6); // glyph 0: itself
    }
    const loca = Buffer.alloc(8);
    loca.writeUInt32BE(glyf.length, 4);
    const t = Date.now();
    const g = glyfOutlines(
      new Map([
        ['glyf', new Uint8Array(glyf)],
        ['loca', new Uint8Array(loca)],
      ]),
      1,
      1,
    )(0);
    expect(g).toEqual([]);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe.runIf(HAS_PDFJS)('against pdf.js, pixel by pixel', () => {
  /** @type {Record<string, Uint8Array>} */
  let all;
  beforeAll(async () => {
    all = { ...(await ours()), ...(await pdfLib()) };
  });
  it.each(['pdflib-vector', 'pdflib-image-form'])('%s with the standard-font package', async (name) => {
    const bytes = all[name];
    const r = diff(
      renderPage(await loadPdf(bytes), 0, { scale: 2, fonts: stdFonts }),
      await pdfjsRender(await pdfjsOpen(bytes), 0, 2),
    );
    console.log(`${name} + std fonts: ${r.inkPct.toFixed(2)}% of inked pixels differ`);
    expect(r.inkPct).toBeLessThan(0.5);
  });
  // without the package: Inter stands in for Helvetica, pdf.js draws Liberation Sans, so the text differs
  const limit = { 'pdflib-vector': 6, 'pdflib-image-form': 4 };
  for (const name of [
    'text',
    'table',
    'vector',
    'images',
    'form',
    'cff',
    'jpeg',
    'jpeg-cmyk',
    'pdflib-vector',
    'pdflib-image-form',
  ])
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
