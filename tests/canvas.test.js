// renderToCanvas: the same pages through a CanvasRenderingContext2D (@napi-rs/canvas, a dev dependency), against
// this renderer's own pixels and pdf.js on the same canvas, and hostile input against the caps it shares.
import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import { loadPdf, renderPage, renderToCanvas } from '../src/index.js';
import { ours, pdfLib } from './render-fixtures.js';
import { shadingPdfs } from './shading-fixtures.js';
import { transparencyPdfs } from './transparency-fixtures.js';
import { rawPdf } from './reader-tools.js';
import { HAS_PDFJS, pdfjsOpen, pdfjsRender, diff } from './pdfjs-render.js';

let napi = null;
try {
  napi = await import('@napi-rs/canvas');
} catch {
  napi = null;
}
const run = napi ? describe : describe.skip;
const opts = (o = {}) => ({
  scale: 2,
  ...o,
  createCanvas: napi.createCanvas,
  Path2D: napi.Path2D,
  ImageData: napi.ImageData,
});
const onCanvas = (d, o) => {
  const c = napi.createCanvas(1, 1),
    x = c.getContext('2d');
  renderToCanvas(d, 0, x, opts(o));
  return { width: c.width, height: c.height, data: x.getImageData(0, 0, c.width, c.height).data };
};
const doc = (size, content, resources, objs = []) =>
  rawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size} ${size}] /Contents 4 0 R /Resources ${resources} >>`,
    [
      `<< /Filter /FlateDecode /Length ${zlib.deflateSync(Buffer.from(content)).length} >>`,
      zlib.deflateSync(Buffer.from(content)),
    ],
    ...objs,
  ]);
const form = (dict, body) => [`<< /Type /XObject /Subtype /Form ${dict} /Length ${body.length} >>`, body];

run('renderToCanvas', () => {
  it('asks for a 2D context, and Path2D / ImageData where they are not globals', async () => {
    const d = await loadPdf(transparencyPdfs()['page-group']);
    expect(() => renderToCanvas(d, 0, {})).toThrow(/CanvasRenderingContext2D/);
    const x = napi.createCanvas(1, 1).getContext('2d');
    expect(() => renderToCanvas(d, 0, x, { scale: 1, Path2D: null })).toThrow(/Path2D and ImageData/);
  });
  it('every fixture page: its pixels as this renderer draws them, or as pdf.js does (on the same canvas)', async () => {
    const pages = { ...(await ours()), ...(await pdfLib()), ...(await shadingPdfs()), ...transparencyPdfs() };
    for (const [name, bytes] of Object.entries(pages)) {
      const d = await loadPdf(bytes);
      const cv = onCanvas(d);
      const js = renderPage(d, 0, { scale: 2 });
      expect([cv.width, cv.height], name).toEqual([js.width, js.height]);
      // edges are antialiased differently; colours, shapes and placement are the same
      let off = diff(cv, js, 48).inkPct;
      if (HAS_PDFJS && off > 1)
        off = Math.min(off, diff(cv, await pdfjsRender(await pdfjsOpen(bytes), 0, 2), 48).inkPct);
      expect(off, name).toBeLessThan(5);
    }
  });
});

run('renderToCanvas caps: hostile input stops early', () => {
  it('soft masks share the page allowance and are charged a step a pixel', async () => {
    const d = await loadPdf(
      doc(
        2000,
        '1 0 0 1 0.001 0 cm /S gs 0 0 10 10 re f '.repeat(2000),
        '<< /ExtGState << /S << /SMask << /S /Alpha /G 5 0 R >> >> >> >>',
        [form('/BBox [0 0 1 1] /Group << /S /Transparency >>', '0 0 1 1 re f')],
      ),
    );
    const t = Date.now();
    expect(() => onCanvas(d, { scale: 1 })).toThrow(/transparency|steps/);
    expect(Date.now() - t).toBeLessThan(20000);
  });
  it('group compositing on the canvas is charged before it is drawn', async () => {
    const d = await loadPdf(
      doc(1000, '/G Do '.repeat(5000), '<< /XObject << /G 5 0 R >> >>', [
        form('/BBox [0 0 1000 1000] /Group << /S /Transparency >>', '0 0 1000 1000 re f'),
      ]),
    );
    const t = Date.now();
    expect(() => onCanvas(d, { scale: 1 })).toThrow(/steps/);
    expect(Date.now() - t).toBeLessThan(20000);
  });
  it('fills, strokes and glyphs drawn by the canvas are charged as the rasterizer charges them', async () => {
    const d = await loadPdf(doc(400, '0 0 400 400 re f 0 0 m 400 400 l S '.repeat(20000), '<< >>'), {
      budget: { maxSteps: 2_000_000 },
    });
    const t = Date.now();
    expect(() => onCanvas(d, { scale: 1 })).toThrow(/steps/);
    expect(Date.now() - t).toBeLessThan(10000);
  });
  it('groups nested past the cap: the deep ones are not drawn', async () => {
    const objs = [];
    for (let k = 0; k < 15; k++)
      objs.push(
        form(
          `/BBox [0 0 100 100] /Group << /S /Transparency >> /Resources << /XObject << /G ${6 + k} 0 R >> >>`,
          `0 g ${k} ${k} 2 2 re f /G Do`,
        ),
      );
    objs.push(form('/BBox [0 0 100 100]', '0 g 50 50 10 10 re f'));
    const r = onCanvas(await loadPdf(doc(100, '/G Do', '<< /XObject << /G 5 0 R >> >>', objs)), { scale: 1 });
    const at = (x, y) => Array.from(r.data.subarray((y * 100 + x) * 4, (y * 100 + x) * 4 + 3));
    expect(at(1, 98)).toEqual([0, 0, 0]);
    expect(at(55, 45)).toEqual([255, 255, 255]);
  });
});
