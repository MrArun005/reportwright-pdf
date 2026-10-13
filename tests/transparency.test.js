// Transparency (src/render/blend.js and the painter's layers): every fixture page against pdf.js pixel by pixel,
// Luminosity soft masks by value (pdf.js under Node does not apply them: it masks through a canvas filter Node lacks),
// and hostile input against each cap.
import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import { loadPdf, renderPage } from '../src/index.js';
import { blendInto, blendOf, BLEND_MODES } from '../src/render/blend.js';
import { transparencyPdfs } from './transparency-fixtures.js';
import { rawPdf } from './reader-tools.js';
import { HAS_PDFJS, pdfjsOpen, pdfjsRender, diff } from './pdfjs-render.js';

const pdfs = transparencyPdfs();
const px = (r, x, y) => Array.from(r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 3));
const near = (a, b, t = 2) => a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThanOrEqual(t));
/** a one-page PDF: page size, content, resources, objects from 5 on */
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
const quick = async (f, re, ms = 5000) => {
  const t = Date.now();
  await expect(f).rejects.toThrow(re);
  expect(Date.now() - t).toBeLessThan(ms);
};

describe('blend modes by value', () => {
  it('each mode on two colours', () => {
    const b = [200, 100, 50],
      s = [60, 180, 240];
    const at = (m) => blendInto(blendOf(m), b, 0, s, 0, [0, 0, 0]).map(Math.round);
    expect(at('Normal')).toEqual(s);
    expect(at('Multiply')).toEqual([47, 71, 47]);
    expect(at('Screen')).toEqual([213, 209, 243]);
    expect(at('Darken')).toEqual([60, 100, 50]);
    expect(at('Lighten')).toEqual([200, 180, 240]);
    expect(at('Difference')).toEqual([140, 80, 190]);
    expect(at('Exclusion')).toEqual([166, 139, 196]);
    expect(blendOf(['Foo', 'Screen'])).toBe(2);
    expect(blendOf('Compatible')).toBe(0);
    expect(BLEND_MODES).toHaveLength(16);
  });
});

describe('Luminosity soft masks by value', () => {
  it('gray, the /BC backdrop outside the mask form, and /TR', async () => {
    const r = renderPage(await loadPdf(pdfs['smask-luminosity']), 0);
    // (device y down.) /L: a white → black gradient from x 20 to 280 masks red over the yellow stripe: red at the
    // left, yellow at the right
    near(px(r, 22, 200), [204, 26, 26], 3);
    near(px(r, 285, 200), [255, 217, 51], 3);
    // /W: inside the form's BBox black (masked out: cyan shows), then 0.5 gray (half green over cyan); outside it
    // the white backdrop (green, not masked)
    near(px(r, 120, 110), [51, 178, 230], 3);
    near(px(r, 170, 110), [38, 153, 128], 3);
    near(px(r, 20, 110), [26, 128, 26], 3);
    // /T: /TR turns the gradient over: the gray stripe at the left, blue at the right
    near(px(r, 22, 40), [77, 77, 77], 3);
    near(px(r, 285, 40), [26, 26, 204], 3);
  });
});

describe.runIf(HAS_PDFJS)('against pdf.js, pixel by pixel', () => {
  for (const name of Object.keys(pdfs).filter((n) => n !== 'smask-luminosity'))
    it(name, async () => {
      const bytes = pdfs[name];
      const ours = renderPage(await loadPdf(bytes), 0, { scale: 2 });
      const r = diff(ours, await pdfjsRender(await pdfjsOpen(bytes), 0, 2), 8);
      console.log(
        `${name}: ${r.pct.toFixed(2)}% of pixels differ by more than 8, ${r.inkPct.toFixed(2)}% of inked ones`,
      );
      expect(r.ink).toBeGreaterThan(1000);
      expect(r.inkPct).toBeLessThan(0.5);
    });
});

describe('caps: hostile input stops early', () => {
  it('groups nested past the cap: the deep ones are not drawn, the render ends', async () => {
    const objs = [];
    for (let k = 0; k < 15; k++)
      objs.push(
        form(
          `/BBox [0 0 100 100] /Group << /S /Transparency >> /Resources << /XObject << /G ${6 + k} 0 R >> >>`,
          `0 g ${k} ${k} 2 2 re f /G Do`,
        ),
      );
    objs.push(form('/BBox [0 0 100 100]', '0 g 50 50 10 10 re f'));
    const r = renderPage(await loadPdf(doc(100, '/G Do', '<< /XObject << /G 5 0 R >> >>', objs)), 0);
    expect(px(r, 1, 98)).toEqual([0, 0, 0]); // the first group drew
    expect(px(r, 55, 45)).toEqual([255, 255, 255]); // the innermost form, past the cap, did not
  });
  it('a soft mask whose form sets that soft mask again is not re-entered', async () => {
    const d = await loadPdf(
      doc(100, '/S gs 0 0 100 100 re f', '<< /ExtGState << /S 5 0 R >> >>', [
        '<< /SMask << /S /Alpha /G 6 0 R >> >>',
        form(
          '/BBox [0 0 100 100] /Group << /S /Transparency >> /Resources << /ExtGState << /S 5 0 R >> >>',
          '/S gs 0 0 50 50 re f',
        ),
      ]),
    );
    const t = Date.now();
    renderPage(d, 0);
    expect(Date.now() - t).toBeLessThan(3000);
  });
  it('a soft mask set again in the same space is drawn once', async () => {
    const d = await loadPdf(
      doc(2000, '/S gs '.repeat(5000), '<< /ExtGState << /S << /SMask << /S /Luminosity /G 5 0 R >> >> >> >>', [
        form('/BBox [0 0 1 1]', '0 0 1 1 re f'),
      ]),
    );
    const t = Date.now();
    renderPage(d, 0);
    expect(Date.now() - t).toBeLessThan(5000);
  });
  it('soft masks count as form draws', async () => {
    const d = await loadPdf(
      doc(
        10,
        '1 0 0 1 0.001 0 cm /S gs '.repeat(12000),
        '<< /ExtGState << /S << /SMask << /S /Alpha /G 5 0 R >> >> >> >>',
        [form('/BBox [0 0 10 10]', '0 0 5 5 re f')],
      ),
    );
    await quick(async () => renderPage(d, 0), /form XObjects/);
  });
  it("soft masks share the page's mask allowance and are charged a step a pixel", async () => {
    const d = await loadPdf(
      doc(
        2000,
        '1 0 0 1 0.001 0 cm /S gs '.repeat(2000),
        '<< /ExtGState << /S << /SMask << /S /Luminosity /G 5 0 R >> >> >> >>',
        [form('/BBox [0 0 1 1]', '0 0 1 1 re f')],
      ),
    );
    await quick(async () => renderPage(d, 0), /transparency|steps/, 20000);
  });
  it('group compositing is charged a step a pixel', async () => {
    const d = await loadPdf(
      doc(1000, '/G Do '.repeat(5000), '<< /XObject << /G 5 0 R >> >>', [
        form('/BBox [0 0 1000 1000] /Group << /S /Transparency >>', '0 0 1000 1000 re f'),
      ]),
    );
    await quick(async () => renderPage(d, 0), /steps/, 20000);
  });
});
