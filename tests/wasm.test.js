// The WASM kernel (src/render/kernel.wat): the same pixels as the JS path on every fixture, the same coverage on
// hostile polygons, and the generated module in step with its source.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { loadPdf, renderPage } from '../src/index.js';
import { rasterizer } from '../src/render/raster.js';
import { kernel } from '../src/render/wasm.js';
import { ours, pdfLib } from './render-fixtures.js';
import { shadingPdfs } from './shading-fixtures.js';
import { transparencyPdfs } from './transparency-fixtures.js';
import { rawPdf } from './reader-tools.js';
import { stdFonts } from '../packages/std-fonts/index.js';

const INTER = fs.readFileSync(new URL('../public/fonts/Inter-Regular.ttf', import.meta.url));
const same = (a, b) =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

describe('wasm kernel', () => {
  it('is available here (Node has WebAssembly SIMD)', () => {
    expect(kernel()).not.toBeNull();
  });
  it('kernel.js is built from kernel.wat', () => {
    const r = spawnSync(process.execPath, ['scripts/build-kernel.mjs', '--check'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  });
  it('every fixture page: byte-identical with wasm on and off', async () => {
    const sets = [
      [{ ...(await ours()), ...(await pdfLib()) }, { default: INTER }],
      [await shadingPdfs(), stdFonts],
      [transparencyPdfs(), stdFonts],
    ];
    const off = [];
    for (const [all, fonts] of sets)
      for (const [name, bytes] of Object.entries(all)) {
        const d = await loadPdf(bytes);
        for (const scale of [1, 2]) {
          const a = renderPage(d, 0, { scale, fonts }),
            b = renderPage(d, 0, { scale, fonts, wasm: false });
          if (!same(a.data, b.data)) off.push(`${name}@${scale}`);
        }
      }
    expect(off).toEqual([]);
  });
  it('a result is the caller’s own: the next render does not change it', async () => {
    const d = await loadPdf((await ours()).vector);
    const a = renderPage(d, 0, { scale: 1 });
    const copy = a.data.slice();
    renderPage(d, 0, { scale: 1, background: [0, 0, 0, 255] });
    expect(same(a.data, copy)).toBe(true);
  });
});

describe('wasm kernel: hostile polygons give the JS coverage', () => {
  const spans = (wasm, polys, eo) => {
    const out = [];
    const r = rasterizer(97, 61, () => {}, wasm);
    r.fill(polys, eo, (y, xa, xb, cov) => out.push(y, xa, xb, ...Array.from(cov.subarray(xa, xb))));
    return out;
  };
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const extremes = [0, -0, 1e-300, -1e300, 1e300, 96.99999999, 97, 61, -5, 0.5, NaN, Infinity, -Infinity];
  it('random, degenerate and extreme coordinates', () => {
    for (let t = 0; t < 400; t++) {
      const n = 1 + (t % 9);
      const polys = Array.from({ length: 1 + (t % 3) }, () =>
        Float64Array.from({ length: 2 * (n + 2) }, () =>
          t % 4 === 0 ? extremes[(rnd() * extremes.length) | 0] : rnd() * 140 - 20,
        ),
      );
      for (const eo of [false, true]) expect(spans(true, polys, eo)).toEqual(spans(false, polys, eo));
    }
  });
  it('the kernel memory is never grown (a grown memory detaches its buffer, slowing V8 typed arrays)', () => {
    const k = kernel(),
      before = k.memory.buffer;
    const big = new Float64Array(2 * 2_000_000).map((_, i) => (i & 1 ? 30 + 25 * Math.sin(i) : 48 + 40 * Math.cos(i)));
    spans(true, [big], false);
    expect(k.memory.buffer).toBe(before);
  });
  it('a fill past the kernel’s room falls back to JS (same coverage)', () => {
    const big = new Float64Array(2 * 300000);
    for (let i = 0; i < big.length; i += 2)
      ((big[i] = 48 + 40 * Math.cos(i)), (big[i + 1] = 30 + 25 * Math.sin(i * 1.0001)));
    const a = spans(true, [big], false),
      b = spans(false, [big], false);
    expect(a.length).toBe(b.length);
    expect(a.every((v, i) => v === b[i])).toBe(true);
  });
  it('a page with many clip masks: pixels unchanged', async () => {
    const body = Array.from(
      { length: 300 },
      (_, k) => `q ${k % 50} ${k % 40} 30 30 re W n 0 0 1 rg 0 0 100 100 re f Q`,
    ).join(' ');
    const content = zlib.deflateSync(Buffer.from(body));
    const d = await loadPdf(
      rawPdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>',
        [`<< /Filter /FlateDecode /Length ${content.length} >>`, content],
      ]),
    );
    expect(same(renderPage(d, 0, { scale: 3 }).data, renderPage(d, 0, { scale: 3, wasm: false }).data)).toBe(true);
  });
});
