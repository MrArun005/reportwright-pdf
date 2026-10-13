// @ts-check
/**
 * Image sampling in the WASM kernel (kernel-images.wat): an image's RGBA bytes copied into the kernel's memory once per
 * drawImage, then each destination span sampled there. Validates every offset, width and step before calling in; any
 * failure (or no kernel, no SIMD, a page or image too big for the memory) → null / false, and the JS path draws it with
 * the same pixels. The memory is this module's own instance (wasm.js exports only its rasterizer's functions).
 */
import { KERNEL_BASE64 } from './kernel.js';

/** @type {any} */
let X;
let gen = 0;
/** the kernel's exports with the image functions, or null (no WebAssembly, no SIMD, a kernel without them) */
function kernelImages() {
  if (X !== undefined) return X;
  X = null;
  try {
    const W = /** @type {any} */ (globalThis).WebAssembly;
    const little = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1; // pixels are copied as bytes: LE words
    if (!W || !little || typeof atob !== 'function') return X;
    const bin = Uint8Array.from(atob(KERNEL_BASE64), (c) => c.charCodeAt(0));
    if (!W.validate(bin)) return X;
    const e = new W.Instance(new W.Module(bin)).exports;
    if (typeof e.imgUpright !== 'function' || typeof e.imgAffine !== 'function') return X;
    X = { e, mem8: new Uint8Array(e.memory.buffer), memBytes: e.memory.buffer.byteLength };
  } catch {
    X = null;
  }
  return X;
}

const isInt = (/** @type {any} */ v, /** @type {number} */ lo, /** @type {number} */ hi) =>
  Number.isSafeInteger(v) && v >= lo && v <= hi;

/**
 * A sampler for one image drawn on a page W pixels wide: the image's RGBA bytes are copied into the kernel's memory
 * now. Its methods return true when they drew the span, false when the JS must (nothing drawn then). One sampler at a
 * time: a newer one makes the older one return false.
 * @param {Uint8Array | Uint8ClampedArray} rgba @param {number} w @param {number} h @param {number} pageW
 */
export function imageSampler(rgba, w, h, pageW) {
  const x = kernelImages();
  if (!x || !(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray)) return null;
  if (!isInt(w, 1, 2 ** 26) || !isInt(h, 1, 2 ** 26) || !isInt(pageW, 1, 2 ** 26)) return null;
  const img = w * h * 4;
  if (!(img <= rgba.length)) return null;
  // the layout: the image, then the span's pixels (D), coverage floats (C), clip (CL)
  const D = (img + 15) & ~15,
    C = D + pageW * 4,
    CL = C + pageW * 4,
    end = CL + pageW;
  if (end > x.memBytes) return null;
  x.mem8.set(rgba.subarray(0, img), 0);
  const me = ++gen;
  const cf32 = new Float32Array(x.e.memory.buffer, C, pageW);
  const mine = () => gen === me;
  /** the destination pixels (of data, from ci + xa) copied in */
  const load = (
    /** @type {Uint8ClampedArray} */ data,
    /** @type {number} */ ci,
    /** @type {number} */ xa,
    /** @type {number} */ xb,
  ) => x.mem8.set(data.subarray((ci + xa) * 4, (ci + xb) * 4), D);
  const store = (
    /** @type {Uint8ClampedArray} */ data,
    /** @type {number} */ ci,
    /** @type {number} */ xa,
    /** @type {number} */ xb,
  ) => data.set(x.mem8.subarray(D, D + (xb - xa) * 4), (ci + xa) * 4);
  return {
    /**
     * an upright span: the source row sr (a pixel index, a multiple of w) sampled from fx by sx0
     * @param {Uint8ClampedArray} data @param {number} ci @param {number} xa @param {number} xb @param {Float32Array} cov
     * @param {number} fx @param {number} sx0 @param {number} sr
     */
    upright(data, ci, xa, xb, cov, fx, sx0, sr) {
      if (!mine() || !(data instanceof Uint8ClampedArray) || !(cov instanceof Float32Array)) return false;
      if (!isInt(ci, 0, 2 ** 40) || !isInt(xa, 0, pageW - 1) || !isInt(xb, xa + 1, pageW)) return false;
      if (!isInt(sr, 0, (h - 1) * w) || sr % w !== 0 || (ci + xb) * 4 > data.length || cov.length < xb) return false;
      if (typeof fx !== 'number' || typeof sx0 !== 'number') return false;
      load(data, ci, xa, xb);
      cf32.set(cov.subarray(xa, xb));
      x.e.imgUpright(D, C, sr * 4, xb - xa, w, fx, sx0);
      store(data, ci, xa, xb);
      return true;
    },
    /**
     * a general span (the per-pixel loop): clip (a row mask over the page, or null), fx, fy stepping by sx0, sy0
     * @param {Uint8ClampedArray} data @param {number} ci @param {number} xa @param {number} xb @param {Float32Array} cov
     * @param {Uint8Array | Uint8ClampedArray | null} clip @param {number} fx @param {number} fy @param {number} sx0
     * @param {number} sy0 @param {number} alpha @param {number} fr @param {number} fg @param {number} fb @param {boolean} stencil
     */
    affine(data, ci, xa, xb, cov, clip, fx, fy, sx0, sy0, alpha, fr, fg, fb, stencil) {
      if (!mine() || !(data instanceof Uint8ClampedArray) || !(cov instanceof Float32Array)) return false;
      if (!isInt(ci, 0, 2 ** 40) || !isInt(xa, 0, pageW - 1) || !isInt(xb, xa + 1, pageW)) return false;
      if ((ci + xb) * 4 > data.length || cov.length < xb) return false;
      if (clip && (!(clip instanceof Uint8Array || clip instanceof Uint8ClampedArray) || clip.length < ci + xb))
        return false;
      if ([fx, fy, sx0, sy0, alpha, fr, fg, fb].some((v) => typeof v !== 'number')) return false;
      load(data, ci, xa, xb);
      cf32.set(cov.subarray(xa, xb));
      if (clip) x.mem8.set(clip.subarray(ci + xa, ci + xb), CL);
      x.e.imgAffine(D, C, clip ? CL : 0, 0, w, h, xb - xa, fx, fy, sx0, sy0, alpha, fr, fg, fb, stencil ? 1 : 0);
      store(data, ci, xa, xb);
      return true;
    },
  };
}
