// The axial span in the WASM kernel (kernel-gradients.wat): the same table indices as shading.js's JS loop, on the
// fixtures and on 200 random and extreme parameter sets, and every argument the kernel cannot take falls back.
import { describe, it, expect } from 'vitest';
import { loadPdf, renderPage } from '../src/index.js';
import { KERNEL_BASE64 } from '../src/render/kernel.js';
import { axialSpan } from '../src/render/wasm-gradients.js';
import { shadingPdfs } from './shading-fixtures.js';
import { stdFonts } from '../packages/std-fonts/index.js';

const LUT_N = 1023;
/** the JS loop of shading.js's axial span, verbatim in its arithmetic */
function jsAxial(idx, m, t, dt, e0, e1, n, out) {
  for (let i = 0; i < m; i++, t += dt) idx[i] = t < 0 ? (e0 ? 0 : out) : t > 1 ? (e1 ? n : out) : (t * n + 0.5) | 0;
}

// the kernel's own instance: its memory is what idx must lie in
const exportsOf = () => new WebAssembly.Instance(new WebAssembly.Module(Buffer.from(KERNEL_BASE64, 'base64'))).exports;
const kernelOf = (e) => ({ axial: e.axial, memory: e.memory });
const view = (k, off = 1024, len = 512) => new Int32Array(k.memory.buffer, off, len);

describe('wasm gradients: axial span', () => {
  it('the kernel exports axial', () => {
    expect(typeof exportsOf().axial).toBe('function');
  });

  it('200 random and extreme parameter sets: indices byte-identical to the JS loop', () => {
    const e = exportsOf(),
      k = kernelOf(e);
    let seed = 11;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const extremes = [0, -0, 1e-300, -1e300, 1e300, 1, 0.5, 1 - 1e-16, 1 + 1e-15, -1e-12, NaN, Infinity, -Infinity];
    const pick = () => (rnd() < 0.3 ? extremes[(rnd() * extremes.length) | 0] : rnd() * 3 - 1);
    let fastPath = 0;
    for (let t = 0; t < 200; t++) {
      const m = (rnd() * 300) | 0,
        t0 = pick(),
        dt = rnd() < 0.2 ? 0 : rnd() < 0.5 ? pick() / 300 : pick() * 1e-3,
        e0 = rnd() < 0.5,
        e1 = rnd() < 0.5,
        out = rnd() < 0.5 ? LUT_N + 1 : -1;
      const a = view(k),
        b = new Int32Array(512);
      a.fill(7777);
      const wrote = axialSpan(k, a, m, t0, dt, e0, e1, LUT_N, out);
      const finite = Number.isFinite(t0) && Number.isFinite(dt);
      expect(wrote).toBe(finite); // non-finite parameters: the JS path, nothing written
      if (!wrote) continue;
      fastPath++;
      jsAxial(b, m, t0, dt, e0, e1, LUT_N, out);
      expect(Array.from(a.subarray(0, m))).toEqual(Array.from(b.subarray(0, m)));
      expect(a[m]).toBe(7777); // nothing past the span
    }
    expect(fastPath).toBeGreaterThan(100);
  });

  it('boundary and degenerate calls fall back (false, nothing written) or are no-ops', () => {
    const e = exportsOf(),
      k = kernelOf(e);
    const a = view(k),
      other = new Int32Array(64);
    a.fill(5);
    const ok = (...args) => axialSpan(k, ...args);
    expect(ok(a, 4, 0.1, 0.1, false, false, LUT_N, -1)).toBe(true);
    expect(axialSpan(null, a, 4, 0, 0, false, false, LUT_N, -1)).toBe(false);
    expect(axialSpan({ memory: e.memory }, a, 4, 0, 0, false, false, LUT_N, -1)).toBe(false); // no axial export
    expect(ok(other, 4, 0.1, 0.1, false, false, LUT_N, -1)).toBe(false); // not in kernel memory
    expect(
      ok(new Int32Array(k.memory.buffer, k.memory.buffer.byteLength - 8, 2), 3, 0, 0, false, false, LUT_N, -1),
    ).toBe(false); // past the end
    expect(ok(a, 4.5, 0, 0, false, false, LUT_N, -1)).toBe(false);
    expect(ok(a, -1, 0, 0, false, false, LUT_N, -1)).toBe(false);
    expect(ok(a, a.length + 1, 0, 0, false, false, LUT_N, -1)).toBe(false);
    expect(ok(a, 4, NaN, 0.1, false, false, LUT_N, -1)).toBe(false);
    expect(ok(a, 4, 0.1, Infinity, false, false, LUT_N, -1)).toBe(false);
    expect(ok(a, 4, 0.1, 0.1, false, false, NaN, -1)).toBe(false);
    expect(ok(a, 4, 0.1, 0.1, false, false, LUT_N, 1.5)).toBe(false);
    expect(ok(a, 4, 0.1, 0.1, false, false, LUT_N, NaN)).toBe(false);
    expect(ok(a, 0, NaN, NaN, false, false, LUT_N, -1)).toBe(false); // non-finite is refused even for no pixels
    a.fill(5);
    expect(ok(a, 0, 0.1, 0.1, false, false, LUT_N, -1)).toBe(true);
    expect(a.every((v) => v === 5)).toBe(true); // m = 0 writes nothing
  });

  it('the fixtures sh-axial and sh-radial render byte-identical with the kernel on and off', async () => {
    const pdfs = await shadingPdfs();
    for (const name of ['sh-axial', 'sh-radial']) {
      const d = await loadPdf(pdfs[name]);
      const a = renderPage(d, 0, { scale: 2, fonts: stdFonts }),
        b = renderPage(d, 0, { scale: 2, fonts: stdFonts, wasm: false });
      expect(
        Buffer.from(a.data.buffer, a.data.byteOffset, a.data.byteLength).equals(
          Buffer.from(b.data.buffer, b.data.byteOffset, b.data.byteLength),
        ),
      ).toBe(true);
    }
  });
});
