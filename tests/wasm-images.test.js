// The image sampler in the WASM kernel (kernel-images.wat, wasm-images.js): byte-identical to the JS path on the image
// fixtures and on 200 random and extreme transforms, and the boundary cases fall back to JS.
import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import fs from 'node:fs';
import { loadPdf, renderPage } from '../src/index.js';
import { imageSampler } from '../src/render/wasm-images.js';
import { ours, pdfLib } from './render-fixtures.js';
import { rawPdf } from './reader-tools.js';

const INTER = fs.readFileSync(new URL('../public/fonts/Inter-Regular.ttf', import.meta.url));
const same = (a, b) =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (xs) => xs[(rnd() * xs.length) | 0];

describe('wasm images: the fixtures are byte-identical with wasm on and off', () => {
  it('images, jpeg, jpeg-cmyk, pdflib-image-form', async () => {
    const all = { ...(await ours()), ...(await pdfLib()) };
    const names = ['images', 'jpeg', 'jpeg-cmyk', 'pdflib-image-form'];
    const off = [];
    for (const name of names) {
      const d = await loadPdf(all[name]);
      for (const scale of [1, 2]) {
        const a = renderPage(d, 0, { scale, fonts: { default: INTER } });
        const b = renderPage(d, 0, { scale, fonts: { default: INTER }, wasm: false });
        if (!same(a.data, b.data)) off.push(`${name}@${scale}`);
      }
    }
    expect(off).toEqual([]);
  });
});

/** a page with one image (RGB, optional SMask, or a stencil), drawn under matrix m, optionally clipped and translucent */
function imagePdf({ m, kind, clip, alpha, iw, ih }) {
  const px = Buffer.alloc(iw * ih * 3);
  for (let i = 0; i < px.length; i++) px[i] = (i * 73 + (i >> 5) * 17) & 255;
  const al = Buffer.alloc(iw * ih);
  for (let i = 0; i < al.length; i++) al[i] = (i * 29) & 255;
  const sm = Buffer.alloc(Math.ceil(iw / 8) * ih); // a stencil: one bit a pixel, rows padded to bytes
  for (let i = 0; i < sm.length; i++) sm[i] = (i * 151) & 255;
  const z = (b) => zlib.deflateSync(b);
  const stencilData = z(sm);
  const imgDict =
    kind === 'stencil'
      ? `<< /Type /XObject /Subtype /Image /Width ${iw} /Height ${ih} /ImageMask true /Filter /FlateDecode /Length ${stencilData.length} >>`
      : `<< /Type /XObject /Subtype /Image /Width ${iw} /Height ${ih} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${
          kind === 'smask' ? ' /SMask 6 0 R' : ''
        } /Length ${z(px).length} >>`;
  const imgData = kind === 'stencil' ? stencilData : z(px);
  const smask = z(al);
  const body = [
    clip ? '0 0 40 30 re W n' : '',
    alpha ? '/G gs' : '',
    kind === 'stencil' ? '0.2 0.4 0.9 rg' : '',
    `${m.map((v) => v.toFixed(6)).join(' ')} cm 1 0 0 1 0 0 cm /Im 5 0 R Do`,
  ].join(' ');
  const content = z(Buffer.from(`q ${body} Q`));
  const res = `<< /XObject << /Im 5 0 R >> /ExtGState << /G << /ca 0.5 >> >> >>`;
  return rawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 60 40] /Contents 4 0 R /Resources ${res} >>`,
    [`<< /Filter /FlateDecode /Length ${content.length} >>`, content],
    [imgDict, imgData],
    [
      `<< /Type /XObject /Subtype /Image /Width ${iw} /Height ${ih} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${smask.length} >>`,
      smask,
    ],
  ]);
}

/** a matrix: rotated, skewed, mirrored, tiny, huge, or near-degenerate */
function randomMatrix() {
  const kind = (rnd() * 6) | 0;
  const s = 10 + rnd() * 80;
  const t = rnd() * 6.283;
  switch (kind) {
    case 0:
      return [s * Math.cos(t), s * Math.sin(t), -s * Math.sin(t), s * Math.cos(t), rnd() * 60 - 10, rnd() * 40 - 5];
    case 1:
      return [s, 0, rnd() * 2 - 1, s * 0.5, rnd() * 60, rnd() * 40];
    case 2:
      return [-s, 0, 0, s, 60 + rnd() * 20, rnd() * 40]; // mirrored
    case 3:
      return [1e-3 * (1 + rnd()), 0, 0, 1e-3, rnd() * 60, rnd() * 40]; // tiny
    case 4:
      return [1e6 * (rnd() - 0.5), 0, 0, 1e6 * (rnd() - 0.5), 0, 0]; // huge
    default:
      return [s, 0, 0, s * 1e-7, 3, 2]; // a sliver
  }
}

describe('wasm images: 200 random and extreme transforms', () => {
  it('byte-identical to JS', async () => {
    const bad = [];
    for (let t = 0; t < 200; t++) {
      const doc = await loadPdf(
        imagePdf({
          m: randomMatrix(),
          kind: pick(['plain', 'smask', 'stencil']),
          clip: rnd() < 0.3,
          alpha: rnd() < 0.3,
          iw: 1 + ((rnd() * 24) | 0),
          ih: 1 + ((rnd() * 18) | 0),
        }),
      );
      const a = renderPage(doc, 0, { scale: 1 + (t % 2), fonts: { default: INTER } });
      const b = renderPage(doc, 0, { scale: 1 + (t % 2), fonts: { default: INTER }, wasm: false });
      if (!same(a.data, b.data)) bad.push(t);
    }
    expect(bad).toEqual([]);
  });
});

describe('wasm images: the wrapper', () => {
  const W = 17;
  const img = (w, h) => {
    const u = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < u.length; i++) u[i] = (i * 37 + 11) & 255;
    return u;
  };
  /** the JS per-pixel loop of render.js (its general branch), as the reference */
  function refAffine(data, ci, xa, xb, cov, clip, fx, fy, sx0, sy0, alpha, fr, fg, fb, stencil, rgba, w, h) {
    for (let x = xa; x < xb; x++, fx += sx0, fy += sy0) {
      let a = cov[x] * alpha;
      if (clip) a *= clip[ci + x] / 255;
      if (a <= 0) continue;
      let ix = (fx + 0.5) | 0,
        iy = (fy + 0.5) | 0;
      ix = ix < 0 ? 0 : ix >= w ? w - 1 : ix;
      iy = iy < 0 ? 0 : iy >= h ? h - 1 : iy;
      const p = (iy * w + ix) * 4,
        sa = rgba[p + 3];
      if (sa === 0) continue;
      const sr = stencil ? fr : rgba[p],
        sg = stencil ? fg : rgba[p + 1],
        sb = stencil ? fb : rgba[p + 2];
      const o = (ci + x) * 4;
      if (a >= 1 && sa === 255) {
        data[o] = sr;
        data[o + 1] = sg;
        data[o + 2] = sb;
        data[o + 3] = 255;
        continue;
      }
      a *= sa / 255;
      data[o] += (sr - data[o]) * a;
      data[o + 1] += (sg - data[o + 1]) * a;
      data[o + 2] += (sb - data[o + 2]) * a;
      if (data[o + 3] < 255) data[o + 3] += (255 - data[o + 3]) * a;
    }
  }
  /** the JS upright branch's per-pixel loop (no clip, alpha >= 1), as the reference */
  function refUpright(data, ci, xa, xb, cov, fx, sx0, sr, rgba, w) {
    const d32 = new Uint32Array(data.buffer, data.byteOffset, data.length >> 2),
      s32 = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.length >> 2);
    for (let x = xa; x < xb; x++, fx += sx0) {
      let ix = (fx + 0.5) | 0;
      ix = ix < 0 ? 0 : ix >= w ? w - 1 : ix;
      const v = s32[sr + ix];
      if (cov[x] >= 1 && rgba[(sr + ix) * 4 + 3] === 255) {
        d32[ci + x] = v;
        continue;
      }
      const p = (sr + ix) * 4,
        a = (cov[x] * rgba[p + 3]) / 255;
      if (a <= 0) continue;
      const o = (ci + x) * 4;
      data[o] += (rgba[p] - data[o]) * a;
      data[o + 1] += (rgba[p + 1] - data[o + 1]) * a;
      data[o + 2] += (rgba[p + 2] - data[o + 2]) * a;
      if (data[o + 3] < 255) data[o + 3] += (255 - data[o + 3]) * a;
    }
  }
  const specials = [
    0,
    -0,
    NaN,
    Infinity,
    -Infinity,
    1e300,
    -1e300,
    2 ** 53,
    -(2 ** 40) - 0.25,
    4294967296 + 3.5,
    0.5,
    16.49,
  ];

  it('affine with NaN, infinities and huge steps: the JS loop, exactly', () => {
    const w = 5,
      h = 4,
      rgba = img(w, h);
    const pageW = W,
      data0 = new Uint8ClampedArray(pageW * 3 * 4).map((_, i) => (i * 13) & 255);
    const bad = [];
    for (let t = 0; t < 300; t++) {
      const sam = imageSampler(rgba, w, h, pageW);
      expect(sam).not.toBeNull();
      const pick2 = () => (rnd() < 0.4 ? pick(specials) : rnd() * 12 - 4);
      const cov = new Float32Array(pageW).map(() => pick([0, 1, 0.5, rnd(), 1, 2 / 3]));
      const clip = rnd() < 0.5 ? new Uint8Array(pageW * 3).map(() => (rnd() * 256) | 0) : null;
      const xa = (rnd() * (pageW - 1)) | 0,
        xb = xa + 1 + ((rnd() * (pageW - xa - 1)) | 0);
      const ci = pageW * ((rnd() * 3) | 0);
      const args = [
        pick2(),
        pick2(),
        pick2(),
        pick2(),
        pick([1, 0.5, 2, 0, NaN, 0.25]),
        rnd() * 255,
        rnd() * 255,
        rnd() * 255,
      ];
      const stencil = rnd() < 0.3;
      const a = data0.slice(),
        b = data0.slice();
      const ok = sam.affine(
        a,
        ci,
        xa,
        xb,
        cov,
        clip,
        args[0],
        args[1],
        args[2],
        args[3],
        args[4],
        args[5],
        args[6],
        args[7],
        stencil,
      );
      refAffine(
        b,
        ci,
        xa,
        xb,
        cov,
        clip,
        args[0],
        args[1],
        args[2],
        args[3],
        args[4],
        args[5],
        args[6],
        args[7],
        stencil,
        rgba,
        w,
        h,
      );
      if (!ok || !same(a, b)) bad.push(t);
    }
    expect(bad).toEqual([]);
  });

  it('upright spans: the JS loop, exactly (translucent and opaque pixels)', () => {
    const w = 6,
      h = 3,
      rgba = img(w, h);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = (i * 53) & 255;
    const pageW = W;
    const bad = [];
    for (let t = 0; t < 200; t++) {
      const sam = imageSampler(rgba, w, h, pageW);
      const data0 = new Uint8ClampedArray(pageW * 2 * 4).map((_, i) => (i * 7) & 255);
      const cov = new Float32Array(pageW).map(() => pick([0, 1, 0.3, rnd()]));
      const xa = (rnd() * (pageW - 1)) | 0,
        xb = xa + 1 + ((rnd() * (pageW - xa - 1)) | 0);
      const sr = w * ((rnd() * h) | 0);
      const fx = pick(specials.concat([rnd() * 9 - 2])),
        sx0 = pick([w / 3, -w / 2, 0.37, NaN, 1e9]);
      const a = data0.slice(),
        b = data0.slice();
      const ok = sam.upright(a, pageW, xa, xb, cov, fx, sx0, sr);
      refUpright(b, pageW, xa, xb, cov, fx, sx0, sr, rgba, w);
      if (!ok || !same(a, b)) bad.push(t);
    }
    expect(bad).toEqual([]);
  });

  it('boundaries fall back to JS (false / null), never write out of range', () => {
    const w = 4,
      h = 2,
      rgba = img(w, h),
      pageW = 10;
    expect(imageSampler(rgba, 0, h, pageW)).toBeNull();
    expect(imageSampler(rgba, w, h, 0)).toBeNull();
    expect(imageSampler(rgba.subarray(0, 10), w, h, pageW)).toBeNull(); // shorter than w × h × 4
    expect(imageSampler(rgba, 1.5, h, pageW)).toBeNull();
    expect(imageSampler(rgba, w, h, 2 ** 27)).toBeNull();
    expect(imageSampler([1, 2, 3], 1, 1, pageW)).toBeNull(); // not bytes
    const s = imageSampler(rgba, w, h, pageW);
    const data = new Uint8ClampedArray(pageW * 2 * 4),
      cov = new Float32Array(pageW);
    expect(s.upright(data, 0, 3, 3, cov, 0, 1, 0)).toBe(false); // empty span
    expect(s.upright(data, 0, 0, pageW + 1, cov, 0, 1, 0)).toBe(false); // past the page
    expect(s.upright(data, 0, 0, 4, cov, 0, 1, 1)).toBe(false); // row not a whole row of pixels
    expect(s.upright(data, 0, 0, 4, cov, 0, 1, h * w)).toBe(false); // row past the image
    expect(s.upright(data, pageW * 2, 0, 4, cov, 0, 1, 0)).toBe(false); // past the data
    expect(s.upright(data, 0, 0, 4, new Float64Array(pageW), 0, 1, 0)).toBe(false); // coverage not floats
    expect(s.upright(new Uint8Array(data.buffer), 0, 0, 4, cov, 0, 1, 0)).toBe(false);
    expect(s.affine(data, 0, 0, 4, cov, new Uint8Array(3), 0, 0, 1, 1, 1, 0, 0, 0, false)).toBe(false); // clip too short
    expect(s.affine(data, 0, 0, 4, cov, null, 0, 0, 1, 1, '1', 0, 0, 0, false)).toBe(false); // a step not a number
    // a newer sampler makes the older one step aside (its memory is the newer image's)
    const s2 = imageSampler(rgba, w, h, pageW);
    expect(s.upright(data, 0, 0, 4, cov, 0, 1, 0)).toBe(false);
    expect(s2.upright(data, 0, 0, 4, cov, 0, 1, 0)).toBe(true);
  });

  it('a valid image gets a sampler (the kernel with the image functions is there: no silent JS path)', () => {
    expect(imageSampler(img(2, 2), 2, 2, 8)).not.toBeNull();
  });
});
