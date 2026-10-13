// The WASM kernel (src/render/kernel.wat): the same pixels as the JS path on every fixture, the same coverage on
// hostile polygons, and the generated module in step with its source.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { loadPdf, renderPage } from '../src/index.js';
import { rasterizer } from '../src/render/raster.js';
import { kernel, rowsFor } from '../src/render/wasm.js';
import { ours, pdfLib } from './render-fixtures.js';
import { shadingPdfs } from './shading-fixtures.js';
import { transparencyPdfs } from './transparency-fixtures.js';
import { rawPdf } from './reader-tools.js';
import { stdFonts } from '../packages/std-fonts/index.js';

const INTER = fs.readFileSync(new URL('../public/fonts/Inter-Regular.ttf', import.meta.url));
const same = (a, b) =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

describe('wasm kernel', () => {
  it('is not made unless asked for (wasm: true)', async () => {
    const { spawnSync: run } = await import('node:child_process');
    const r = run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      const m = await import(${JSON.stringify(new URL('../src/index.js', import.meta.url).href)});
      const w = await import(${JSON.stringify(new URL('../src/render/wasm.js', import.meta.url).href)});
      const { ours } = await import(${JSON.stringify(new URL('./render-fixtures.js', import.meta.url).href)});
      const d = await m.loadPdf((await ours()).vector); m.renderPage(d, 0, { scale: 2 });
      console.log(w.loadedKernel() === null ? 'none' : 'made');`,
      ],
      { encoding: 'utf8' },
    );
    expect(r.stdout.trim()).toBe('none');
  });
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
          const a = renderPage(d, 0, { scale, fonts, wasm: true }),
            b = renderPage(d, 0, { scale, fonts, wasm: false });
          if (!same(a.data, b.data)) off.push(`${name}@${scale}`);
        }
      }
    expect(off).toEqual([]);
  });
  it('a result is the caller’s own: the next render does not change it', async () => {
    const d = await loadPdf((await ours()).vector);
    const a = renderPage(d, 0, { scale: 1, wasm: true });
    const copy = a.data.slice();
    renderPage(d, 0, { scale: 1, wasm: true, background: [0, 0, 0, 255] });
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
    expect(same(renderPage(d, 0, { scale: 3, wasm: true }).data, renderPage(d, 0, { scale: 3 }).data)).toBe(true);
  });
});

describe('wasm kernel: layer rows as composite() writes them', () => {
  it('random layer, backdrop, mask and alpha: the JS bytes', () => {
    const k = kernel(),
      w = 257,
      kr = rowsFor(k, w);
    let seed = 3;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 255;
    for (let t = 0; t < 200; t++) {
      const L = Uint8ClampedArray.from({ length: w * 4 }, () => (t % 5 === 0 ? [0, 255][rnd() & 1] : rnd())),
        D = Uint8ClampedArray.from({ length: w * 4 }, rnd),
        M = Uint8Array.from({ length: w }, rnd);
      const plain = t % 3 === 0,
        mask = !plain && t % 2 === 0,
        ga = plain ? 1 : [0, 0.3, 0.5, 1, 1.7][t % 5];
      // the JS (render.js composite, Normal)
      const J = D.slice(),
        L32 = new Uint32Array(L.buffer);
      for (let i = 0; i < w; i++) {
        if (!L32[i]) continue;
        const p = i * 4,
          la = L[p + 3];
        if (plain) {
          if (la === 255) {
            J.set(L.subarray(p, p + 4), p);
            continue;
          }
          const q = 255 - la;
          for (let c = 0; c < 3; c++) J[p + c] = L[p + c] + (J[p + c] * q + 127) / 255;
          J[p + 3] = la + (J[p + 3] * q + 127) / 255;
          continue;
        }
        const s = mask ? (ga * M[i]) / 255 : ga;
        if (!la || s <= 0) continue;
        const a = (la / 255) * s,
          q = 1 - a;
        for (let c = 0; c < 3; c++) J[p + c] = J[p + c] * q + L[p + c] * s;
        J[p + 3] = J[p + 3] * q + la * s;
      }
      kr.lrow.set(L);
      kr.pix.set(D);
      kr.clip.set(M);
      k.layer(kr.lrowOff, kr.pixOff, mask ? kr.clipOff : 0, 0, w, ga, plain ? 1 : 0);
      expect(Buffer.from(kr.pix).equals(Buffer.from(J)), `case ${t}`).toBe(true);
    }
  });
});
