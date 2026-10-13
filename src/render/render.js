// @ts-check
/**
 * Rendering (experimental): a page of a loaded document → RGBA pixels, in pure JS (docs/RENDERER.md). The content
 * stream is read with the reader's lexer, streams decoded with its filters, fonts with its sfnt and CFF parsers;
 * the rasterizer (raster.js) fills anti-aliased polygons. Phase 1: paths (fill non-zero / even-odd, stroke with
 * width, caps, joins, miter limit, dashes), the CTM, clipping, Gray / RGB / CMYK / ICCBased / Indexed colour,
 * constant opacity (ca / CA), text with embedded TrueType and CFF fonts (substitute fonts for the standard 14),
 * Flate / LZW / raw images (stencil masks, /SMask, /Decode, 1–16 bits), inline images, form XObjects, and annotation
 * appearance streams (form fields), JPEG images, shadings (sh and shading patterns, types 1–7) and tiling patterns.
 * Transparency: blend modes, groups (as isolated) and ExtGState soft masks. Not yet: Type 3 and Type 1 fonts, JPX / JBIG2 / CCITT images,
 * Separation / DeviceN tints, text clipping.
 *
 * HOSTILE input: every operator is a budget step under the document's budget and a time limit, forms nest at most
 * MAX_FORMS deep and never re-enter themselves, the device is at most MAX_SIDE a side and MAX_PIXELS in all, and a
 * broken font or image draws as nothing (a budget error still stops the render).
 */
import { internal, pageAt } from '../reader/pdf.js';
import { Lexer, parseValue, PdfString, PdfStream, Op } from '../reader/lexer.js';
import { decode } from '../reader/filters.js';
import { decodeJpeg } from '../images/jpeg-decode.js';
import { compileShading, LUT } from './shading.js';
import { compile as compileFn } from './functions.js';
import { blendOf, blendInto, blendTable } from './blend.js';
import { fail } from '../reader/budget.js';
import { skipInline, glyphText } from '../reader/text.js';
import { ENCODINGS, METRICS } from '../fonts/standard-metrics.js';
import { sfntTables, parseFont } from '../fonts/truetype.js';
import { rasterizer, flatten, stroke, dashed, MAX_POINTS } from './raster.js';
import { glyfOutlines, cffOutlines } from './glyphs.js';

export const MAX_FORMS = 16,
  MAX_SIDE = 16384,
  MAX_PIXELS = 64_000_000,
  RENDER_TIMEOUT_MS = 60_000,
  /** numbers one path may hold, form XObjects one page may draw, q nesting, clip-mask bytes one render may make, image pixels */
  MAX_PATH = 4_000_000,
  MAX_FORM_DRAWS = 10_000,
  MAX_Q = 256,
  MAX_CLIP_BYTES = 1_000_000_000,
  MAX_IMAGE_PIXELS = 25_000_000,
  /** outline numbers one font keeps decoded */
  MAX_GLYPH_CACHE = 8_000_000,
  /** what one document's caches may hold: glyph outline numbers (all fonts), decoded image bytes, content bytes */
  MAX_DOC_GLYPHS = 32_000_000,
  /** glyph coverage bitmaps a document's renders keep (entries, and bytes of coverage), and the largest one */
  MAX_GLYPH_BITMAPS = 8192,
  MAX_GLYPH_BITMAP_BYTES = 16_000_000,
  MAX_GLYPH_BITMAP_SIDE = 256,
  /** shading triangles' numbers and tiling cells' bytes one document keeps; a cell's pixels; copies of a cell per period; tiling patterns inside tiling patterns */
  MAX_DOC_SHADING_NUMBERS = 16_000_000,
  MAX_DOC_SHADINGS = 4096,
  MAX_DOC_TILE_BYTES = 64 << 20,
  MAX_CELL_PIXELS = 1 << 20,
  MAX_CELL_COPIES = 4,
  MAX_PATTERN_DEPTH = 8,
  /** transparency layers (groups, soft masks, blended or masked objects) open at once */
  MAX_GROUP_DEPTH = 8,
  MAX_DOC_FONTS = 1024,
  MAX_DOC_IMAGE_BYTES = 256 << 20,
  MAX_DOC_CONTENT_BYTES = 64 << 20;

/** @typedef {number[]} M a matrix [a b c d e f] */
/** A then B (PDF's row vectors: a point times A, then times B) @param {M} A @param {M} B @returns {M} */
const mul = (A, B) => [
  A[0] * B[0] + A[1] * B[2],
  A[0] * B[1] + A[1] * B[3],
  A[2] * B[0] + A[3] * B[2],
  A[2] * B[1] + A[3] * B[3],
  A[4] * B[0] + A[5] * B[2] + B[4],
  A[4] * B[1] + A[5] * B[3] + B[5],
];
/** @param {M} m @returns {M | null} */
const inv = (m) => {
  const d = m[0] * m[3] - m[1] * m[2];
  if (!d || !Number.isFinite(d)) return null;
  return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d];
};
const stops = (/** @type {any} */ e) => e?.code === 'E_TIMEOUT' || e?.code === 'E_ABORTED' || e?.code === 'E_BUDGET';
const num = (/** @type {any} */ v, /** @type {number} */ d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const matrixOf = (/** @type {any} */ a) =>
  Array.isArray(a) && a.length >= 6 && a.slice(0, 6).every((v) => typeof v === 'number' && Number.isFinite(v))
    ? a.slice(0, 6)
    : null;

/**
 * Render page `index` of a document from loadPdf. scale: device pixels per point (1 = 72 dpi); fonts: substitutes
 * for the standard 14 fonts (which have no outlines in the file), { Helvetica: ttfBytes, …, default: ttfBytes };
 * background: [r, g, b, a] 0–255 (white by default); annotations: draw annotation appearances (true by default).
 * @param {any} doc @param {number} index
 * @param {{ scale?: number, fonts?: Record<string, Uint8Array>, background?: number[], annotations?: boolean, timeoutMs?: number }} [o]
 * @returns {{ width: number, height: number, data: Uint8ClampedArray }}
 */
export function renderPage(doc, index, o = {}) {
  return render(doc, index, o, null);
}

/**
 * Render a page onto a CanvasRenderingContext2D (a browser canvas, an OffscreenCanvas or @napi-rs/canvas): fills,
 * strokes, glyphs and images are drawn by the canvas; what it cannot draw exactly (shadings, patterns, soft masks,
 * groups, stencil images) is drawn by this renderer into the canvas's pixels. The canvas is resized to the page.
 * Options as renderPage, plus createCanvas(w, h) for image surfaces (default: OffscreenCanvas, when there is one),
 * and Path2D / ImageData constructors where they are not globals (Node canvas libraries).
 * @param {any} doc @param {number} index @param {any} ctx @param {any} [o]
 */
export function renderToCanvas(doc, index, ctx, o = {}) {
  if (!ctx || typeof ctx.fill !== 'function' || typeof ctx.getImageData !== 'function')
    throw new TypeError('renderToCanvas: ctx is a CanvasRenderingContext2D');
  const { createCanvas, Path2D: P2D = globalThis.Path2D, ImageData: ID = globalThis.ImageData, ...rest } = o ?? {};
  if (typeof P2D !== 'function' || typeof ID !== 'function')
    throw new TypeError('renderToCanvas: needs Path2D and ImageData (pass them as options outside a browser)');
  const make =
    typeof createCanvas === 'function'
      ? createCanvas
      : typeof OffscreenCanvas === 'function'
        ? (/** @type {number} */ w, /** @type {number} */ h) => new OffscreenCanvas(w, h)
        : null;
  return render(doc, index, rest, { ctx, make, P2D, ID });
}

/** @param {any} doc @param {number} index @param {any} o @param {{ ctx: any, make: any, P2D: any, ID: any } | null} cv */
function render(doc, index, o, cv) {
  const self = internal(doc, 'renderPage');
  if (o == null || typeof o !== 'object')
    throw new TypeError('renderPage: options are { scale, fonts, background, annotations, timeoutMs }');
  for (const k of Object.keys(o))
    if (!['scale', 'fonts', 'background', 'annotations', 'timeoutMs'].includes(k))
      throw new TypeError(`renderPage: unknown option ${JSON.stringify(k.slice(0, 40))}`);
  const scale = o.scale ?? 1;
  if (typeof scale !== 'number' || !(scale > 0 && scale <= 100))
    throw new RangeError('renderPage: scale is a number above 0, at most 100');
  const view = doc.page(index);
  const p = self.plan[index],
    r = p.owner.r,
    src = r.src;
  const [x0, y0, x1, y1] = view.cropBox,
    rot = view.rotation;
  const cw = x1 - x0,
    ch = y1 - y0;
  const W = Math.max(1, Math.ceil((rot % 180 ? ch : cw) * scale - 1e-6)),
    H = Math.max(1, Math.ceil((rot % 180 ? cw : ch) * scale - 1e-6));
  if (W > MAX_SIDE || H > MAX_SIDE || W * H > MAX_PIXELS)
    throw new RangeError(
      `renderPage: ${W} × ${H} pixels is too large (at most ${MAX_SIDE} a side, ${MAX_PIXELS} in all)`,
    );
  /** @type {M} */
  let base = [1, 0, 0, -1, -x0, y1]; // crop box → top-left origin, y down
  if (rot === 90) base = mul(base, [0, 1, -1, 0, ch, 0]);
  else if (rot === 180) base = mul(base, [-1, 0, 0, -1, cw, ch]);
  else if (rot === 270) base = mul(base, [0, -1, 1, 0, 0, cw]);
  base = mul(base, [scale, 0, 0, scale, 0, 0]);
  const data = new Uint8ClampedArray(W * H * 4);
  const bg = o.background ?? [255, 255, 255, 255];
  data.subarray(0, 4).set(bg.slice(0, 4));
  new Uint32Array(data.buffer).fill(new Uint32Array(data.buffer, 0, 1)[0]); // the first pixel's bytes, in any byte order
  if (cv) {
    const c = cv.ctx.canvas;
    if (c && (c.width !== W || c.height !== H)) ((c.width = W), (c.height = H));
    // the background (the canvas and data agree)
    const x = cv.ctx;
    if (bg[3] === 255 || bg[3] === undefined) {
      x.save();
      x.setTransform(1, 0, 0, 1, 0, 0);
      x.globalAlpha = 1;
      x.globalCompositeOperation = 'copy';
      x.fillStyle = `rgb(${data[0]},${data[1]},${data[2]})`;
      x.fillRect(0, 0, W, H);
      x.restore();
    } else x.putImageData(new cv.ID(data, W, H), 0, 0);
  }
  const pg = pageAt(r, p.index);
  const ms = o.timeoutMs ?? RENDER_TIMEOUT_MS;
  src.budget.within(ms, () => {
    const ctx = painter(src, data, W, H, o.fonts ?? NO_FONTS, undefined, cv);
    const C = cacheOf(src, o.fonts ?? NO_FONTS);
    let content = C.content.get(pg.dict);
    if (!content) {
      content = contentOf(src, pg.dict.get('Contents'));
      if ((C.contentBytes += content.length) > MAX_DOC_CONTENT_BYTES)
        (C.content.clear(), (C.contentBytes = content.length));
      C.content.set(pg.dict, content);
    }
    ctx.run(content, src.resolve(pg.inh.Resources), base);
    if (o.annotations !== false) ctx.annotations(pg.dict, base);
    ctx.flush();
  });
  return cv ? { width: W, height: H } : { width: W, height: H, data };
}

const NO_FONTS = {};
/** the pattern colour space (a tiling pattern's underlying space in `under`) */
const PATTERN = { n: 0, pattern: true, under: /** @type {any} */ (null), rgb: () => [0, 0, 0] };
/** the tiling patterns being drawn (no re-entry; renders are synchronous) */
const openPatterns = new Set();
const objIds = new WeakMap();
let nextObj = 0;
const idOf = (/** @type {object} */ o) => {
  if (!objIds.has(o)) objIds.set(o, ++nextObj);
  return objIds.get(o);
};
/** a polygon list that is one whole-pixel axis-aligned rectangle → its pixels [x0, y0, x1, y1] on the device, else null @param {ArrayLike<number>[]} polys @param {number} W @param {number} H */
function pixelRect(polys, W, H) {
  const q = Array.isArray(polys) && polys.length === 1 ? polys[0] : null;
  if (!q || q.length !== 8 || q[0] !== q[6] || q[1] !== q[3] || q[2] !== q[4] || q[5] !== q[7]) return null;
  if (!Number.isInteger(q[0]) || !Number.isInteger(q[1]) || !Number.isInteger(q[2]) || !Number.isInteger(q[5]))
    return null;
  const x0 = Math.max(0, Math.min(q[0], q[2])),
    x1 = Math.min(W, Math.max(q[0], q[2])),
    y0 = Math.max(0, Math.min(q[1], q[5])),
    y1 = Math.min(H, Math.max(q[1], q[5]));
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : [0, 0, 0, 0];
}
/** alpha source-over in fixed point: AOVER[k << 8 | da], k the source alpha in 1/256ths (0–256) */
const AOVER = new Uint8Array(257 << 8);
for (let k = 0; k <= 256; k++) for (let d = 0; d < 256; d++) AOVER[(k << 8) | d] = d + (((255 - d) * k + 128) >> 8);
/** a pixel pair, as two int32 and as one float64 */
const F64P = new Float64Array(1),
  I32P = new Int32Array(F64P.buffer);
/** a coverage row for cached glyphs (kept) */
let glyphRow = new Float32Array(0);
const ROW = (/** @type {number} */ w) => (glyphRow.length >= w ? glyphRow : (glyphRow = new Float32Array(w)));
/** a row of full coverage, as wide as asked (kept) */
let ones = new Float32Array(0);
const ONES = (/** @type {number} */ w) => (ones.length >= w ? ones : (ones = new Float32Array(w).fill(1)));
const PX8 = new Uint8ClampedArray(4),
  PX32 = new Uint32Array(PX8.buffer);
/**
 * What renders of one document share (with the same fonts): parsed fonts and their glyph outlines, decoded images,
 * pages' decoded content. Each kind has a cap; past it, that cache is emptied (ponytail: not LRU). Keyed by the fonts'
 * bytes, not the options object, so `{ fonts: { default: f } }` written afresh each call still hits.
 * @type {WeakMap<object, Map<string, any>>}
 */
const CACHES = new WeakMap();
const ids = new WeakMap();
let nextId = 0;
/** @param {any} src @param {Record<string, Uint8Array>} subs */
function cacheOf(src, subs) {
  let byFonts = CACHES.get(src);
  if (!byFonts) CACHES.set(src, (byFonts = new Map()));
  const key = Object.keys(subs)
    .sort()
    .map((k) => {
      const b = subs[k];
      if (!(b instanceof Uint8Array)) return '';
      if (!ids.has(b)) ids.set(b, ++nextId);
      return `${k}\0${ids.get(b)}`;
    })
    .join('\0');
  let c = byFonts.get(key);
  if (!c) {
    if (byFonts.size >= 4) byFonts.clear(); // a few font sets per document at once
    c = {
      shadings: new Map(),
      shadingNumbers: 0,
      tiles: new Map(),
      tileBytes: 0,
      fonts: new Map(),
      images: new Map(),
      subFonts: new Map(),
      content: new Map(),
      glyphs: 0,
      /** glyph coverage, by glyph, transform and quantised subpixel offset @type {Map<string, any>} */
      glyphCov: new Map(),
      glyphCovBytes: 0,
      imageBytes: 0,
      contentBytes: 0,
    };
    byFonts.set(key, c);
  }
  return c;
}

/** what a document's render caches hold (tests) @param {any} doc */
export function cacheStats(doc) {
  const src = internal(doc, 'cacheStats').plan[0]?.owner.r.src;
  const sets = [...(CACHES.get(src)?.values() ?? [])];
  return sets.map((c) => ({
    fonts: c.fonts.size,
    images: c.images.size,
    imageBytes: c.imageBytes,
    glyphs: c.glyphs,
    glyphBitmaps: c.glyphCov.size,
    glyphBitmapBytes: c.glyphCovBytes,
    content: c.content.size,
    shadings: c.shadings.size,
    tiles: c.tiles.size,
  }));
}

/** a page's content: one stream, or an array of them joined @param {any} src @param {any} c */
function contentOf(src, c) {
  c = src.resolve(c);
  const list = Array.isArray(c) ? c.slice(0, 10_000).map(src.resolve) : [c];
  const parts = [];
  for (const s of list)
    if (s instanceof PdfStream)
      try {
        parts.push(src.decodeStream(s).data);
      } catch (e) {
        if (stops(e)) throw e;
      }
  let n = 0;
  for (const x of parts) n += x.length + 1;
  const out = new Uint8Array(n);
  n = 0;
  for (const x of parts) {
    out.set(x, n);
    n += x.length;
    out[n++] = 10;
  }
  return out;
}

/** @param {any} src @param {Uint8ClampedArray} data @param {number} W @param {number} H @param {Record<string, Uint8Array>} subs */
function painter(src, data, W, H, subs, mem = { clip: 0 }, cv = /** @type {any} */ (null)) {
  const R = src.resolve;
  // ---- canvas output: the canvas draws what it draws exactly; the rest is drawn here into page pixels, read from
  // and written back to the canvas around it (page: the page's pixels; one side holds the newer pixels) ----
  const page = data;
  let cvx = cv?.ctx;
  let canvasNewer = false,
    pixelsNewer = false;
  /** drawing onto the page natively now? */
  const native = () => !!cvx && data === page && !alphaOnly;
  /** pixels about to be drawn here: the canvas's first */
  const toPixels = () => {
    if (!cvx || data !== page) return;
    if (canvasNewer) {
      src.budget.tick(1 + ((W * H) >> 6));
      page.set(cvx.getImageData(0, 0, W, H).data);
      canvasNewer = false;
    }
    pixelsNewer = true;
  };
  /** the canvas about to draw: these pixels first */
  const toCanvas = () => {
    if (pixelsNewer) {
      src.budget.tick(1 + ((W * H) >> 6));
      cvx.putImageData(new cv.ID(page, W, H), 0, 0);
      pixelsNewer = false;
    }
    canvasNewer = true;
  };
  /** each clip mask's path (device polygons), its rule and the clip it narrowed @type {WeakMap<Uint8Array, any>} */
  const clipPaths = new WeakMap();
  /** polygons → a Path2D @param {ArrayLike<number>[]} polys */
  const path2d = (polys) => {
    const p = new cv.P2D();
    for (const q of polys) {
      if (q.length < 4) continue;
      p.moveTo(q[0], q[1]);
      for (let i = 2; i + 1 < q.length; i += 2) p.lineTo(q[i], q[i + 1]);
      p.closePath();
    }
    return p;
  };
  /** the canvas clipped to a clip mask's paths (in device space) @param {Uint8Array | null} clip */
  const clipTo = (clip) => {
    for (let c = clip; c;) {
      const e = clipPaths.get(c);
      if (!e) return false;
      if (!e.p) e.p = path2d(e.polys);
      cvx.clip(e.p, e.eo ? 'evenodd' : 'nonzero');
      c = e.old;
    }
    return true;
  };
  /** clip masks the canvas can follow (made from paths, all the way down) @param {Uint8Array | null} clip */
  const clipKnown = (clip) => {
    for (let c = clip; c; c = clipPaths.get(c).old) if (!clipPaths.has(c)) return false;
    return true;
  };
  const GCO = [
    'source-over',
    'multiply',
    'screen',
    'overlay',
    'darken',
    'lighten',
    'color-dodge',
    'color-burn',
    'hard-light',
    'soft-light',
    'difference',
    'exclusion',
    'hue',
    'saturation',
    'color',
    'luminosity',
  ];
  /**
   * fill device polygons on the canvas in one colour, or false (drawn here instead) @param {any} polys
   * @param {boolean} eo @param {number[]} rgb @param {number} alpha @param {Uint8Array | null} clip @param {number} m
   */
  const cvFill = (polys, eo, rgb, alpha, clip, m) => {
    if (!Array.isArray(polys) || !clipKnown(clip)) return false;
    if (!cvFillCharge(polys)) return true;
    toCanvas();
    cvx.save();
    clipTo(clip);
    cvx.globalAlpha = alpha;
    cvx.globalCompositeOperation = GCO[m] ?? 'source-over';
    cvx.fillStyle = `rgb(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)})`;
    cvx.fill(path2d(polys), eo ? 'evenodd' : 'nonzero');
    cvx.restore();
    return true;
  };
  /** image surfaces for the canvas, by image @type {WeakMap<any, any>} */
  const surfaces = new WeakMap();
  /** an image drawn by the canvas, or false @param {any} img @param {any} gs */
  const cvImage = (img, gs) => {
    if (!cv.make || img.stencil || !clipKnown(gs.clip)) return false;
    const m = gs.ctm;
    let sf = surfaces.get(img);
    if (!sf) {
      // its bytes count in the page's allowance (as a decoded image held twice)
      if ((mem.clip += img.w * img.h * 4) > MAX_CLIP_BYTES)
        fail('E_BUDGET', `A page's images on the canvas need more than ${MAX_CLIP_BYTES.toLocaleString('en')} bytes`);
      src.budget.tick(1 + ((img.w * img.h) >> 6));
      sf = cv.make(img.w, img.h);
      sf.getContext('2d').putImageData(new cv.ID(new Uint8ClampedArray(img.rgba), img.w, img.h), 0, 0);
      surfaces.set(img, sf);
    }
    // its device bounds, charged as drawing it here would be
    const pts = toDevice([{ pts: [0, 0, 1, 0, 1, 1, 0, 1] }], m)[0];
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (let i = 0; i < 8; i += 2) {
      x0 = Math.min(x0, pts[i]);
      x1 = Math.max(x1, pts[i]);
      y0 = Math.min(y0, pts[i + 1]);
      y1 = Math.max(y1, pts[i + 1]);
    }
    const rows = Math.max(0, Math.min(H, Math.ceil(y1)) - Math.max(0, Math.floor(y0))),
      cols = Math.max(0, Math.min(W, Math.ceil(x1)) - Math.max(0, Math.floor(x0)));
    src.budget.tick(1 + rows * (1 + cols)); // a step a pixel, as drawImage
    if (!rows || !cols) return true;
    growBox(x0, y0, x1, y1);
    toCanvas();
    cvx.save();
    clipTo(gs.clip);
    cvx.globalAlpha = gs.ca;
    cvx.imageSmoothingEnabled = !!img.smooth;
    cvx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    cvx.transform(1 / img.w, 0, 0, -1 / img.h, 0, 1); // image space: the unit square, its first row at the top
    cvx.drawImage(sf, 0, 0);
    cvx.restore();
    return true;
  };
  /** glyph outlines as Path2D (glyph space), by glyph @type {WeakMap<any, any>} */
  const glyphPaths = new WeakMap();
  /** a glyph outline as a Path2D, kept @param {number[]} g */
  const glyphPath = (g) => {
    let p = glyphPaths.get(g);
    if (!p) glyphPaths.set(g, (p = opsPath(g)));
    return p;
  };
  /**
   * a path (user space) filled or stroked by the canvas in its own space (curves as curves), or false
   * @param {number[]} path @param {any} gs @param {boolean} stroking @param {boolean} eo
   */
  const cvPath = (path, gs, stroking, eo) => {
    if (!native() || (stroking ? gs.spat : gs.fpat) || (xfer && !busy && xfer.smask) || !clipKnown(gs.clip))
      return false;
    const m = gs.ctm,
      u = unit(m);
    // device bounds of its points (a stroke's widened), charged as the rasterizer charges, before the work
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity,
      n = 0;
    for (let i = 0; i < path.length;) {
      const op = path[i++],
        k = op === 0 || op === 1 ? 2 : op === 2 ? 6 : 0;
      for (let j = 0; j < k; j += 2) {
        const x = m[0] * path[i + j] + m[2] * path[i + j + 1] + m[4],
          y = m[1] * path[i + j] + m[3] * path[i + j + 1] + m[5];
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      ((i += k), n++);
    }
    const lw = Math.max(gs.lw, 1 / u),
      pad = stroking ? lw * u * Math.max(1, gs.join === 0 ? gs.ml : 1) : 0;
    const rows = Math.max(0, Math.min(H, Math.ceil(y1 + pad)) - Math.max(0, Math.floor(y0 - pad))),
      cols = Math.max(0, Math.min(W, Math.ceil(x1 + pad)) - Math.max(0, Math.floor(x0 - pad)));
    src.budget.tick(1 + n + rows * (1 + (cols >> 4)));
    if (!rows || !cols || !Number.isFinite(x0 + y0 + x1 + y1)) return true;
    growBox(x0 - pad, y0 - pad, x1 + pad, y1 + pad);
    toCanvas();
    cvx.save();
    clipTo(gs.clip);
    const c = stroking ? gs.strokeC : gs.fill;
    const style = `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
    cvx.globalAlpha = stroking ? gs.CA : gs.ca;
    cvx.globalCompositeOperation = GCO[xfer && !busy ? xfer.bm : 0] ?? 'source-over';
    cvx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    const p = opsPath(path);
    if (stroking) {
      cvx.strokeStyle = style;
      cvx.lineWidth = lw;
      cvx.lineCap = ['butt', 'round', 'square'][gs.cap] ?? 'butt';
      cvx.lineJoin = ['miter', 'round', 'bevel'][gs.join] ?? 'miter';
      cvx.miterLimit = gs.ml;
      if (gs.dash.length) ((cvx.lineDashOffset = gs.phase), cvx.setLineDash(gs.dash));
      cvx.stroke(p);
    } else ((cvx.fillStyle = style), cvx.fill(p, eo ? 'evenodd' : 'nonzero'));
    cvx.restore();
    return true;
  };
  /**
   * an axial or radial shading extended at both ends, filling device polygons, drawn as the canvas's own gradient
   * (stops from its table), or false @param {any} polys @param {number} alpha @param {Uint8Array | null} clip @param {any} pat
   */
  const cvShade = (polys, alpha, clip, pat) => {
    if (!Array.isArray(polys) || pat.kind !== 'shading' || !clipKnown(clip)) return false;
    const sh = shadingOf(pat.obj);
    // radial: extended at both ends only (canvas pads both); axial: an unextended end is a clip
    if (!sh?.grad || sh.bbox || !(sh.type === 2 || (sh.type === 3 && sh.grad.e0 && sh.grad.e1))) return false;
    const m = pat.m,
      im = inv(m);
    if (!im) return false;
    if (!cvFillCharge(polys)) return true;
    toCanvas();
    const c = sh.grad.c,
      lut = sh.lut;
    // the gradient in shading space; 256 stops from the table
    const g =
      sh.type === 2
        ? cvx.createLinearGradient(c[0], c[1], c[2], c[3])
        : cvx.createRadialGradient(c[0], c[1], Math.max(0, c[2]), c[3], c[4], Math.max(0, c[5]));
    const n = 256,
      L = (lut.length / 3 - 1) | 0; // entries before the Background one
    for (let k = 0; k < n; k++) {
      const i = Math.round((k / (n - 1)) * (L - 1)) * 3;
      g.addColorStop(k / (n - 1), `rgb(${Math.round(lut[i])},${Math.round(lut[i + 1])},${Math.round(lut[i + 2])})`);
    }
    cvx.save();
    clipTo(clip);
    cvx.clip(path2d(polys));
    cvx.globalAlpha = alpha;
    cvx.globalCompositeOperation = GCO[xfer && !busy ? xfer.bm : 0] ?? 'source-over';
    cvx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    // the page's corners in shading space: a rectangle covering the device
    let u0 = Infinity,
      v0 = Infinity,
      u1 = -Infinity,
      v1 = -Infinity;
    for (const [x, y] of [
      [0, 0],
      [W, 0],
      [0, H],
      [W, H],
    ]) {
      const u = im[0] * x + im[2] * y + im[4],
        v = im[1] * x + im[3] * y + im[5];
      ((u0 = Math.min(u0, u)), (u1 = Math.max(u1, u)), (v0 = Math.min(v0, v)), (v1 = Math.max(v1, v)));
    }
    if (sh.type === 2 && !(sh.grad.e0 && sh.grad.e1)) {
      // the band the axis covers: from the start (or past it, extended) to the end (or past it)
      const dx = c[2] - c[0],
        dy = c[3] - c[1],
        len = Math.hypot(dx, dy);
      if (!len) return (cvx.restore(), true);
      const big = 4 * Math.hypot(u1 - u0, v1 - v0) + 4 * len;
      const a = sh.grad.e0 ? -big / len : 0,
        b = sh.grad.e1 ? 1 + big / len : 1,
        px = (-dy / len) * big,
        py = (dx / len) * big;
      const band = new cv.P2D();
      band.moveTo(c[0] + a * dx + px, c[1] + a * dy + py);
      band.lineTo(c[0] + b * dx + px, c[1] + b * dy + py);
      band.lineTo(c[0] + b * dx - px, c[1] + b * dy - py);
      band.lineTo(c[0] + a * dx - px, c[1] + a * dy - py);
      band.closePath();
      cvx.clip(band);
    }
    cvx.fillStyle = g;
    cvx.fillRect(u0, v0, u1 - u0, v1 - v0);
    cvx.restore();
    return true;
  };
  /** a canvas draw's device bounds noted in the open layer's box @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 */
  const growBox = (x0, y0, x1, y1) => {
    if (!box) return;
    const xa = Math.max(0, Math.floor(x0) - 1),
      xb = Math.min(W, Math.ceil(x1) + 1),
      ya = Math.max(0, Math.floor(y0) - 1),
      yb = Math.min(H, Math.ceil(y1) + 1);
    if (xb > xa && yb > ya) (grow(ya, xa, xb), grow(yb - 1, xa, xb));
  };
  /** charge a canvas fill of device polygons as the rasterizer would; false when it covers no pixel @param {ArrayLike<number>[]} polys */
  const cvFillCharge = (polys) => {
    let n = 0,
      x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const q of polys) {
      n += q.length;
      for (let i = 0; i + 1 < q.length; i += 2) {
        const x = q[i],
          y = q[i + 1];
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (n > 2 * MAX_POINTS) fail('E_BUDGET', `A fill has more than ${MAX_POINTS.toLocaleString('en')} points`);
    const rows = Math.max(0, Math.min(H, Math.ceil(y1)) - Math.max(0, Math.floor(y0))),
      cols = Math.max(0, Math.min(W, Math.ceil(x1)) - Math.max(0, Math.floor(x0)));
    src.budget.tick(1 + (n >> 3) + rows * (1 + (cols >> 4))); // before the work
    growBox(x0, y0, x1, y1);
    return rows > 0 && cols > 0;
  };
  /** path ops (0 moveTo, 1 lineTo, 2 curveTo, 3 close) as a Path2D @param {number[]} g */
  const opsPath = (g) => {
    const p = new cv.P2D();
    for (let i = 0; i < g.length;) {
      const op = g[i++];
      if (op === 0) p.moveTo(g[i++], g[i++]);
      else if (op === 1) p.lineTo(g[i++], g[i++]);
      else if (op === 2) (p.bezierCurveTo(g[i], g[i + 1], g[i + 2], g[i + 3], g[i + 4], g[i + 5]), (i += 6));
      else if (op === 3) p.closePath();
      else break;
    }
    return p;
  };
  const ras = rasterizer(W, H, (n) => src.budget.tick(n));
  let data32 = new Uint32Array(data.buffer, data.byteOffset, data.length >> 2);
  const C = cacheOf(src, subs),
    { fonts, images, subFonts } = C;
  /** the open forms (never re-entered) */
  const open = new Set();
  /** meshes drawn on this device, by shading and transform (a repeated sh draws once) */
  const layers = new Map();
  /** each clip mask's device bounds (what sh has to cover) */
  const clipBoxes = new WeakMap();
  /** soft masks made this page, by /SMask dictionary and transform; and their forms read, by form @type {WeakMap<any, Map<string, Uint8Array>>} */
  const masks = new WeakMap(),
    rawMasks = new WeakMap();
  let depth = 0,
    formDraws = 0;

  // ---- transparency: objects drawn into a layer, then composited with a blend mode, soft mask and group alpha ----
  /** the graphics state whose blend mode or soft mask applies to the next paint (null: plain drawing) */
  let xfer = /** @type {any} */ (null),
    /** inside a blended object's layer (its paints go straight in) */
    busy = 0,
    /** layers open */
    layerDepth = 0,
    /** the device pixels the open layer has drawn: x0 y0 x1 y1 */
    box = /** @type {number[] | null} */ (null),
    /** drawing an Alpha soft mask's form: colour is not read, plain fills write alpha only */
    alphaOnly = false;
  /** one scratch layer per depth, made once (its bytes count to the page's mask allowance) @type {Uint8ClampedArray[]} */
  const pool = [];
  const scratch = (/** @type {number} */ d) => {
    if (!pool[d]) {
      if ((mem.clip += W * H * 4) > MAX_CLIP_BYTES)
        fail(
          'E_BUDGET',
          `A page's clipping and transparency need more than ${MAX_CLIP_BYTES.toLocaleString('en')} bytes`,
        );
      src.budget.tick(1 + ((W * H) >> 8));
      pool[d] = new Uint8ClampedArray(W * H * 4);
    }
    return pool[d];
  };
  const grow = (/** @type {number} */ y, /** @type {number} */ xa, /** @type {number} */ xb) => {
    const b = /** @type {number[]} */ (box);
    if (xa < b[0]) b[0] = xa;
    if (xb > b[2]) b[2] = xb;
    if (y < b[1]) b[1] = y;
    if (y + 1 > b[3]) b[3] = y + 1;
  };
  /** ras.fill, noting what a layer draws @param {ArrayLike<number>[]} polys @param {boolean} eo @param {(y: number, xa: number, xb: number, cov: Float32Array) => void} f */
  const fill = (polys, eo, f) => {
    if (typeof polys === 'function') {
      // cached glyph coverage: rows from bitmaps (see glyphRows), its bounds known
      const g = /** @type {any} */ (polys);
      if (box && g.x1 > g.x0) (grow(g.y0, g.x0, g.x1), grow(g.y1 - 1, g.x0, g.x1));
      return g(f);
    }
    if (box) {
      // the polygons' bounds (a pixel wider), before they are drawn
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (const q of polys)
        for (let i = 0; i + 1 < q.length; i += 2) {
          const x = q[i],
            y = q[i + 1];
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      if (x1 >= x0) {
        const xa = Math.max(0, Math.floor(x0) - 1),
          xb = Math.min(W, Math.ceil(x1) + 1),
          ya = Math.max(0, Math.floor(y0) - 1),
          yb = Math.min(H, Math.ceil(y1) + 1);
        if (xb > xa && yb > ya) (grow(ya, xa, xb), grow(yb - 1, xa, xb));
      }
    }
    ras.fill(polys, eo, f);
  };
  /**
   * draw into a fresh layer, then composite it onto what is below with g's blend mode and soft mask, times alpha ga
   * @param {any} g @param {number} ga @param {() => void} draw @param {boolean} group (a group's own objects blend inside it)
   */
  function layered(g, ga, draw, group) {
    if (layerDepth >= MAX_GROUP_DEPTH) return; // too deep: not drawn
    if (native() && cv.make) return cvLayered(g, ga, draw, group);
    const L = scratch(layerDepth);
    const od = data,
      o32 = data32,
      ob = box,
      obusy = busy;
    const b = [W, H, 0, 0];
    ((data = L), (data32 = new Uint32Array(L.buffer)), (box = b), (busy = group ? 0 : 1), layerDepth++);
    try {
      draw();
    } finally {
      ((data = od), (data32 = o32), (box = ob), (busy = obusy), layerDepth--);
    }
    if (b[2] <= b[0]) return;
    if (ob) (grow(b[1], b[0], b[2]), grow(b[3] - 1, b[0], b[2]));
    composite(L, b, g.bm, g.smask, ga);
  }
  /** offscreen canvases for groups, one per depth (counted in the page's mask allowance) @type {any[]} */
  const cvPool = [];
  /**
   * a group drawn onto an offscreen canvas (the page's pixels mirror it meanwhile), then drawn over the page with
   * its blend mode and alpha @param {any} g @param {number} ga @param {() => void} draw
   */
  function cvLayered(g, ga, draw, group) {
    let off = cvPool[layerDepth];
    if (!off) {
      if ((mem.clip += W * H * 4) > MAX_CLIP_BYTES)
        fail(
          'E_BUDGET',
          `A page's clipping and transparency need more than ${MAX_CLIP_BYTES.toLocaleString('en')} bytes`,
        );
      src.budget.tick(1 + ((W * H) >> 8));
      const c = cv.make(W, H);
      off = cvPool[layerDepth] = { c, x: c.getContext('2d') };
    }
    src.budget.tick((W * H) >> 4); // clearing it and drawing it over the page, before the work
    toCanvas(); // the page's pixels onto the page canvas, before they mirror the group's
    const main = cvx;
    off.x.setTransform(1, 0, 0, 1, 0, 0);
    if (off.d) off.x.clearRect(off.d[0], off.d[1], off.d[2] - off.d[0], off.d[3] - off.d[1]); // what it drew last
    const obusy = busy,
      ob = box,
      b = [W, H, 0, 0];
    ((cvx = off.x), (canvasNewer = true), (pixelsNewer = false), (busy = group ? 0 : 1), (box = b), layerDepth++);
    try {
      draw();
      flush();
      if (g.smask) {
        // the soft mask as alpha: what the layer keeps
        off.x.save();
        off.x.setTransform(1, 0, 0, 1, 0, 0);
        off.x.globalCompositeOperation = 'destination-in';
        if (b[2] > b[0])
          off.x.drawImage(
            maskCanvas(g.smask),
            b[0],
            b[1],
            b[2] - b[0],
            b[3] - b[1],
            b[0],
            b[1],
            b[2] - b[0],
            b[3] - b[1],
          );
        off.x.restore();
      }
    } finally {
      ((cvx = main), (canvasNewer = true), (pixelsNewer = false), (busy = obusy), (box = ob), layerDepth--);
    }
    // only what the group drew is cleared next time and drawn over the page
    off.d = b[2] > b[0] ? b : null;
    if (!off.d) return;
    if (ob) (grow(b[1], b[0], b[2]), grow(b[3] - 1, b[0], b[2]));
    const w = b[2] - b[0],
      h = b[3] - b[1];
    cvx.save();
    cvx.setTransform(1, 0, 0, 1, 0, 0);
    cvx.globalAlpha = ga;
    cvx.globalCompositeOperation = GCO[g.bm] ?? 'source-over';
    cvx.drawImage(off.c, b[0], b[1], w, h, b[0], b[1], w, h);
    cvx.restore();
  }
  /** soft masks as canvases (alpha = the mask), by mask @type {WeakMap<Uint8Array, any>} */
  const maskCanvases = new WeakMap();
  /** @param {Uint8Array} mask */
  function maskCanvas(mask) {
    let c = maskCanvases.get(mask);
    if (c) return c;
    if ((mem.clip += W * H * 4) > MAX_CLIP_BYTES)
      fail(
        'E_BUDGET',
        `A page's clipping and transparency need more than ${MAX_CLIP_BYTES.toLocaleString('en')} bytes`,
      );
    src.budget.tick(1 + W * H); // a step a pixel, before the work
    const px = new Uint8ClampedArray(W * H * 4);
    for (let i = 0, p = 3; i < mask.length; i++, p += 4) px[p] = mask[i];
    c = cv.make(W, H);
    c.getContext('2d').putImageData(new cv.ID(px, W, H), 0, 0);
    maskCanvases.set(mask, c);
    return c;
  }
  /** the layer being composited, and the pixels px last worked B out for */
  let L32now = new Uint32Array(0),
    lastD = -1,
    lastL = -1,
    lastM = -1;
  const BL = [0, 0, 0],
    CS = [0, 0, 0],
    CB = [0, 0, 0];
  /**
   * layer L (cleared as it goes) over data within b. Both hold colour times alpha (what drawing over transparency
   * leaves), so a layer composites as premultiplied; a blend mode sees both colours unpremultiplied.
   * @param {Uint8ClampedArray} L @param {number[]} b @param {number} m @param {Uint8Array | null} mask @param {number} ga
   */
  function composite(L, b, m, mask, ga) {
    if (data === page) toPixels();
    const [x0, y0, x1, y1] = b,
      D = data,
      D32 = data32;
    src.budget.tick((x1 - x0) * (y1 - y0)); // a step per pixel composited, before the work
    const T = blendTable(m); // a separable mode: B from a table
    const L32 = new Uint32Array(L.buffer);
    ((L32now = L32), (lastD = lastL = lastM = -1));
    const plain = !m && !mask && ga >= 1;
    for (let y = y0; y < y1; y++) {
      const r0 = y * W + x0,
        r1 = y * W + x1;
      if (plain) {
        // Normal at full alpha, no mask: premultiplied source-over, in integers
        for (let i = r0; i < r1; i++) {
          const v = L32[i];
          if (!v) continue;
          const p = i * 4,
            la = L[p + 3];
          if (la === 255) {
            D32[i] = v;
            continue;
          }
          const k = 255 - la;
          D[p] = L[p] + (D[p] * k + 127) / 255;
          D[p + 1] = L[p + 1] + (D[p + 1] * k + 127) / 255;
          D[p + 2] = L[p + 2] + (D[p + 2] * k + 127) / 255;
          D[p + 3] = la + (D[p + 3] * k + 127) / 255;
        }
      } else if (T && !mask) {
        // a separable mode, alpha ga: table lookups, the opaque-backdrop case inline
        for (let i = r0; i < r1; i++) {
          if (!L32[i]) continue;
          const p = i * 4,
            la = L[p + 3];
          if (!la) continue;
          const a = (la / 255) * ga;
          const k = 255 / la;
          if (D[p + 3] === 255) {
            const d0 = D[p],
              d1 = D[p + 1],
              d2 = D[p + 2];
            D[p] = d0 + (T[(d0 << 8) | ((L[p] * k + 0.5) | 0)] - d0) * a;
            D[p + 1] = d1 + (T[(d1 << 8) | ((L[p + 1] * k + 0.5) | 0)] - d1) * a;
            D[p + 2] = d2 + (T[(d2 << 8) | ((L[p + 2] * k + 0.5) | 0)] - d2) * a;
          } else px(D, L, p, a, k, m, T);
        }
      } else if (!m)
        // Normal through a soft mask: D (1 - a) + L s, s the source's alpha scale (a = la / 255 s)
        for (let i = r0; i < r1; i++) {
          if (!L32[i]) continue;
          const p = i * 4,
            la = L[p + 3],
            s = mask ? (ga * mask[i]) / 255 : ga;
          if (!la || s <= 0) continue;
          const a = (la / 255) * s,
            k = 1 - a;
          D[p] = D[p] * k + L[p] * s;
          D[p + 1] = D[p + 1] * k + L[p + 1] * s;
          D[p + 2] = D[p + 2] * k + L[p + 2] * s;
          D[p + 3] = D[p + 3] * k + la * s;
        }
      else
        for (let i = r0; i < r1; i++) {
          if (!L32[i]) continue;
          const p = i * 4,
            la = L[p + 3];
          if (!la) continue;
          let a = (la / 255) * ga;
          if (mask) a *= mask[i] / 255;
          if (a <= 0) continue;
          if (!m && a >= 1) D32[i] = L32[i];
          else px(D, L, p, a, 255 / la, m, T);
        }
      L32.fill(0, r0, r1);
    }
  }
  /** one pixel of a composite, the general case @param {Uint8ClampedArray} D @param {Uint8ClampedArray} L @param {number} p @param {number} a @param {number} k @param {number} m @param {Uint8Array | null} T */
  function px(D, L, p, a, k, m, T) {
    if (T && D[p + 3] === 255) {
      for (let c = 0; c < 3; c++) D[p + c] += (T[(D[p + c] << 8) | ((L[p + c] * k + 0.5) | 0)] - D[p + c]) * a;
      return;
    }
    ((CS[0] = L[p] * k), (CS[1] = L[p + 1] * k), (CS[2] = L[p + 2] * k));
    if (m) {
      // the source mixed with B(backdrop, source) by how opaque the backdrop is
      const ba = D[p + 3],
        ab = ba / 255,
        kb = ba ? 255 / ba : 0;
      const dv = data32[p >> 2],
        lv = L32now[p >> 2];
      if (dv !== lastD || lv !== lastL || m !== lastM) {
        // B for this backdrop and source (flat areas repeat them)
        ((CB[0] = D[p] * kb), (CB[1] = D[p + 1] * kb), (CB[2] = D[p + 2] * kb));
        if (T) for (let c = 0; c < 3; c++) BL[c] = T[(Math.round(CB[c]) << 8) | Math.round(CS[c])];
        else blendInto(m, CB, 0, CS, 0, BL);
        ((lastD = dv), (lastL = lv), (lastM = m));
      }
      for (let c = 0; c < 3; c++) D[p + c] += ((1 - ab) * CS[c] + ab * BL[c] - D[p + c]) * a;
    } else {
      D[p] += (CS[0] - D[p]) * a;
      D[p + 1] += (CS[1] - D[p + 1]) * a;
      D[p + 2] += (CS[2] - D[p + 2]) * a;
    }
    if (D[p + 3] < 255) D[p + 3] += (255 - D[p + 3]) * a;
  }
  /**
   * an ExtGState /SMask → a mask of 0–255 per device pixel (its form drawn now, in the current space), or null
   * @param {Map<string, any>} d @param {any} res @param {any} gs
   */
  function maskOf(d, res, gs) {
    const G = R(d.get('G'));
    if (!(G instanceof PdfStream) || layerDepth >= MAX_GROUP_DEPTH) return null;
    // the same mask in the same space is made once a page
    const ctmKey = gs.ctm.join(',');
    const hit = masks.get(d)?.get(ctmKey);
    if (hit) return (src.budget.tick((1 + W * H) >> 8), hit);
    const raw = rawMask(G, R(d.get('S')) !== 'Alpha', R(d.get('BC')), res, gs, ctmKey);
    if (!raw) return null;
    // the transfer function, as a table
    const f = R(d.get('TR'));
    const fn = f && f !== 'Identity' ? fnOf(f) : null;
    let mask = raw;
    if (fn) {
      charge(W * H);
      const tr = new Uint8Array(256);
      for (let v = 0; v < 256; v++) tr[v] = Math.round(clamp1(fn([v / 255])[0] ?? 0) * 255);
      mask = new Uint8Array(W * H);
      for (let i = 0; i < mask.length; i++) mask[i] = tr[raw[i]];
    }
    let byCtm = masks.get(d);
    if (!byCtm) masks.set(d, (byCtm = new Map()));
    byCtm.set(ctmKey, mask);
    return mask;
  }
  /** a mask's bytes in the page's allowance, and a step a pixel, before the work @param {number} n */
  function charge(n) {
    if ((mem.clip += n) > MAX_CLIP_BYTES)
      fail(
        'E_BUDGET',
        `A page's clipping and transparency need more than ${MAX_CLIP_BYTES.toLocaleString('en')} bytes`,
      );
    src.budget.tick(1 + n);
  }
  /**
   * a soft mask's form drawn and read (luminosity or alpha), before /TR; once a page per form, kind, backdrop and space
   * @param {PdfStream} G @param {boolean} lumi @param {any} bc @param {any} res @param {any} gs @param {string} ctmKey
   */
  function rawMask(G, lumi, bc, res, gs, ctmKey) {
    // the backdrop (Luminosity): /BC in the group's colour space, black by default. The group is isolated, so its
    // form draws onto a clear layer and the backdrop shows through by what it left: l + lum(BC) (1 - alpha)
    let lb = 0;
    if (lumi) {
      const cs = space(R(R(G.dict.get('Group'))?.get?.('CS')) ?? 'DeviceRGB', res);
      const c = Array.isArray(bc) && cs && !cs.pattern ? cs.rgb(bc.map((v) => num(R(v), 0))) : [0, 0, 0];
      lb = (0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]) * 255;
    }
    const key = `${ctmKey}|${lumi ? Math.round(lb) : 'a'}`;
    let byKey = rawMasks.get(G);
    const hit = byKey?.get(key);
    if (hit) return (src.budget.tick((1 + W * H) >> 8), hit);
    charge(W * H); // the mask's allocation, its fill and reading the drawn pixels
    const L = scratch(layerDepth);
    const od = data,
      o32 = data32,
      ob = box,
      obusy = busy,
      ox = xfer,
      oa = alphaOnly;
    const b = [W, H, 0, 0];
    ((data = L), (data32 = new Uint32Array(L.buffer)), (box = b), (busy = 0), (xfer = null), layerDepth++);
    alphaOnly = !lumi;
    try {
      form(G, res, fresh(gs.ctm));
    } finally {
      ((data = od), (data32 = o32), (box = ob), (busy = obusy), (xfer = ox), (alphaOnly = oa), layerDepth--);
    }
    const mask = new Uint8Array(W * H).fill(Math.round(lb)); // where the form drew nothing
    const L32 = new Uint32Array(L.buffer),
      kb = lb / 255;
    const I32 = new Int32Array(L.buffer),
      F64 = new Float64Array(L.buffer, 0, L.length >> 3);
    for (let y = b[1]; y < b[3]; y++) {
      if (lumi && y > b[1]) {
        // a row drawn as the one above (a vertical run of the same colours): its mask row copied
        let i = y * W + b[0];
        const e = y * W + b[2];
        while (i < e && I32[i] === I32[i - W]) i++;
        if (i === e) {
          mask.copyWithin(y * W + b[0], (y - 1) * W + b[0], (y - 1) * W + b[2]);
          continue;
        }
      }
      for (let i = y * W + b[0], e = y * W + b[2]; i < e;) {
        // a run of one pixel value: one mask value, one native fill
        const v = I32[i],
          p = i * 4;
        let j = i + 1;
        if (v) {
          // two pixels a compare (see paint)
          I32P[0] = I32P[1] = v;
          const vv = F64P[0];
          if (j & 1 && j < e && I32[j] === v) j++;
          if (!(j & 1)) while (j + 1 < e && F64[j >> 1] === vv) j += 2;
        }
        while (j < e && I32[j] === v) j++;
        if (v) {
          const mv = lumi
            ? (0.3 * L[p] + 0.59 * L[p + 1] + 0.11 * L[p + 2] + (255 - L[p + 3]) * kb + 0.5) | 0
            : L[p + 3];
          if (j - i < 16) for (let k = i; k < j; k++) mask[k] = mv;
          else mask.fill(mv, i, j);
        }
        i = j;
      }
    }
    for (let y = b[1]; y < b[3]; y++) L32.fill(0, y * W + b[0], y * W + b[2]); // cleared once read (rows compare)
    if (!byKey) rawMasks.set(G, (byKey = new Map()));
    byKey.set(key, mask);
    return mask;
  }
  /** a PDF function, or null @param {any} f */
  const fnOf = (f) => {
    try {
      return compileFn(f, {
        R,
        data: (/** @type {PdfStream} */ st) => src.decodeStream(st).data,
        tick: (/** @type {number} */ n) => src.budget.tick(n),
      });
    } catch (e) {
      if (stops(e)) throw e;
      return null;
    }
  };

  // ---- colour ----
  /** a colour space → { n, rgb(comps) → [r, g, b] 0–1 } or null (a pattern, or one not drawn yet) @param {any} v @param {any} res */
  function space(v, res, d = 0) {
    v = R(v);
    if (typeof v === 'string') {
      if (v === 'DeviceGray' || v === 'G' || v === 'CalGray') return GRAY;
      if (v === 'DeviceRGB' || v === 'RGB' || v === 'CalRGB') return RGB;
      if (v === 'DeviceCMYK' || v === 'CMYK') return CMYK;
      if (v === 'Pattern') return PATTERN;
      const cs = R(res instanceof Map ? R(res.get('ColorSpace')) : null);
      return d < 4 && cs instanceof Map && cs.has(v) ? space(cs.get(v), res, d + 1) : null;
    }
    if (!Array.isArray(v) || !v.length) return null;
    const k = R(v[0]);
    if (k === 'ICCBased') {
      const s = R(v[1]);
      const n = s instanceof PdfStream ? R(s.dict.get('N')) : 0;
      return n === 1 ? GRAY : n === 3 ? RGB : n === 4 ? CMYK : null;
    }
    if (k === 'CalRGB') return RGB;
    if (k === 'CalGray') return GRAY;
    if ((k === 'Indexed' || k === 'I') && d < 4) {
      const b = space(v[1], res, d + 1),
        hi = Math.max(0, Math.min(255, num(R(v[2]), 0)));
      let look = R(v[3]);
      look = look instanceof PdfString ? look.bytes : look instanceof PdfStream ? src.decodeStream(look).data : null;
      if (!b || !look) return null;
      const tab = [];
      for (let i = 0; i <= hi; i++) tab.push(b.rgb(Array.from(look.subarray(i * b.n, i * b.n + b.n), (x) => x / 255)));
      return {
        n: 1,
        indexed: hi,
        rgb: (/** @type {number[]} */ c) => tab[Math.max(0, Math.min(hi, Math.round(c[0])))] ?? [0, 0, 0],
      };
    }
    if (k === 'Separation') return SEP; // ponytail: tint as gray, not through the tint transform (phase 2)
    if (k === 'DeviceN') {
      const names = R(v[1]);
      return {
        n: Array.isArray(names) ? names.length : 1,
        rgb: (/** @type {number[]} */ c) => SEP.rgb([Math.max(...c)]),
      };
    }
    if (k === 'Pattern') {
      const under = v.length > 1 && d < 4 ? space(v[1], res, d + 1) : null;
      return { ...PATTERN, under, n: under ? under.n : 0 };
    }
    return null;
  }

  // ---- the graphics state ----
  const fresh = (/** @type {M} */ ctm) => ({
    ctm,
    fcs: /** @type {any} */ (GRAY),
    scs: /** @type {any} */ (GRAY),
    fill: [0, 0, 0],
    strokeC: [0, 0, 0],
    fnone: false,
    snone: false,
    /** a pattern paint (fill / stroke), or null for a colour */
    fpat: /** @type {any} */ (null),
    spat: /** @type {any} */ (null),
    lw: 1,
    cap: 0,
    join: 0,
    ml: 10,
    dash: /** @type {number[]} */ ([]),
    phase: 0,
    ca: 1,
    CA: 1,
    /** blend mode (an index into BLEND_MODES; 0 Normal) and soft mask (0–255 per device pixel) */
    bm: 0,
    smask: /** @type {Uint8Array | null} */ (null),
    clip: /** @type {Uint8Array | null} */ (null),
    font: /** @type {any} */ (null),
    size: 0,
    Tc: 0,
    Tw: 0,
    Th: 1,
    TL: 0,
    Ts: 0,
    Tr: 0,
  });
  /** @typedef {ReturnType<typeof fresh>} GS */

  /** a pixelRect's rows at full coverage, charged as the rasterizer charges a span @param {number[]} r @param {(y: number, xa: number, xb: number, cov: Float32Array) => void} f */
  function rectRows(r, f) {
    const w = r[2] - r[0];
    src.budget.tick(3 + (r[3] - r[1]) * (1 + (w >> 4)));
    for (let y = r[1]; y < r[3]; y++) f(y, r[0], r[2], ONES(W));
  }
  /**
   * a glyph's coverage at device transform m (its whole-pixel offset left out, the subpixel x offset to 1/16 pixel,
   * y to 1/64), rasterized once per document and kept (bounded), or null to draw it as polygons
   * @param {number[]} g @param {M} m
   */
  function glyphBitmap(g, m) {
    if (!Number.isFinite(m[4]) || !Number.isFinite(m[5])) return null;
    const qx = Math.round((m[4] - Math.floor(m[4])) * 16) / 16,
      qy = Math.round((m[5] - Math.floor(m[5])) * 64) / 64;
    const key = `${idOf(g)} ${m[0]} ${m[1]} ${m[2]} ${m[3]} ${qx} ${qy}`;
    const cache = C.glyphCov;
    let e = cache.get(key);
    if (e !== undefined) return e;
    const lm = /** @type {M} */ ([m[0], m[1], m[2], m[3], qx, qy]);
    const d = toDevice(flatten(g, 0.2 / unit(lm)), lm);
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const q of d)
      for (let i = 0; i + 1 < q.length; i += 2) {
        const x = q[i],
          y = q[i + 1];
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    e = null;
    const ox = Math.floor(x0),
      oy = Math.floor(y0),
      w = Math.ceil(x1) - ox + 1,
      h = Math.ceil(y1) - oy + 1;
    // too big for a bitmap, or for the scratch rasterizer: drawn as polygons (null kept, so asked once)
    if (x1 >= x0 && w <= MAX_GLYPH_BITMAP_SIDE && h <= MAX_GLYPH_BITMAP_SIDE && w <= W && h <= H) {
      for (const q of d) for (let i = 0; i + 1 < q.length; i += 2) ((q[i] -= ox), (q[i + 1] -= oy));
      const cov = new Float32Array(w * h);
      ras.fill(d, false, (y, xa, xb, c) => cov.set(c.subarray(xa, xb), y * w + xa));
      e = { cov, w, h, ox, oy };
      if ((C.glyphCovBytes += cov.byteLength) > MAX_GLYPH_BITMAP_BYTES || cache.size >= MAX_GLYPH_BITMAPS)
        (cache.clear(), (C.glyphCovBytes = cov.byteLength));
    }
    cache.set(key, e);
    return e;
  }
  /** a row source for fill(): cached glyph coverage at device positions [entry, x, y, …] @param {any[]} bits */
  function glyphRows(bits) {
    let x0 = W,
      y0 = H,
      x1 = 0,
      y1 = 0;
    for (let k = 0; k < bits.length; k += 3) {
      const e = bits[k],
        gx = bits[k + 1] + e.ox,
        gy = bits[k + 2] + e.oy;
      x0 = Math.min(x0, Math.max(0, gx));
      y0 = Math.min(y0, Math.max(0, gy));
      x1 = Math.max(x1, Math.min(W, gx + e.w));
      y1 = Math.max(y1, Math.min(H, gy + e.h));
    }
    const rows = (/** @type {(y: number, xa: number, xb: number, cov: Float32Array) => void} */ f) => {
      const row = ROW(W);
      for (let k = 0; k < bits.length; k += 3) {
        const e = bits[k],
          gx = bits[k + 1] + e.ox,
          gy = bits[k + 2] + e.oy;
        const xa = Math.max(0, gx),
          xb = Math.min(W, gx + e.w),
          ya = Math.max(0, gy),
          yb = Math.min(H, gy + e.h);
        if (xb <= xa || yb <= ya) continue;
        src.budget.tick(1 + (yb - ya) * (1 + ((xb - xa) >> 4))); // the rows composited, before the work
        for (let y = ya; y < yb; y++) {
          const o = (y - gy) * e.w - gx;
          row.set(e.cov.subarray(o + xa, o + xb), xa);
          f(y, xa, xb, row);
        }
      }
    };
    return Object.assign(rows, { x0, y0, x1, y1 });
  }
  /** composite polygons in one colour @param {ArrayLike<number>[]} polys @param {boolean} eo @param {number[]} rgb @param {number} alpha @param {Uint8Array | null} clip */
  function paint(polys, eo, rgb, alpha, clip, pat = null) {
    if (native() && xfer && !busy && xfer.smask && cv.make)
      return cvLayered(xfer, 1, () => paint(polys, eo, rgb, alpha, clip, pat), false);
    if (native() && (!xfer || busy || !xfer.smask)) {
      if (pat ? cvShade(polys, alpha, clip, pat) : cvFill(polys, eo, rgb, alpha, clip, xfer && !busy ? xfer.bm : 0))
        return;
    }
    if (data === page) toPixels();
    if (xfer && !busy) {
      if (pat) return layered(xfer, 1, () => paint(polys, eo, rgb, alpha, clip, pat), false);
      return paintBlended(polys, eo, rgb, alpha, clip, xfer.bm, xfer.smask);
    }
    if (pat) return paintWith(polys, eo, alpha, clip, pat);
    const r = rgb[0] * 255,
      g = rgb[1] * 255,
      b = rgb[2] * 255;
    PX8[0] = r;
    PX8[1] = g;
    PX8[2] = b;
    PX8[3] = 255;
    const solid = PX32[0]; // the opaque pixel, in this machine's byte order
    const ao = alphaOnly,
      D = data,
      D32 = data32;
    const I32 = new Int32Array(D32.buffer, D32.byteOffset, D32.length); // pixels compared as int32 (no doubles)
    const F64 = ao && !(D32.byteOffset & 7) ? new Float64Array(D32.buffer, D32.byteOffset, D32.length >> 1) : null;
    const K1 = ((Math.min(alpha, 1) * 256 + 0.5) | 0) << 8; // full coverage, no clip: alpha in 1/256ths
    const edge = (
      /** @type {number} */ row,
      /** @type {number} */ xa,
      /** @type {number} */ xb,
      /** @type {Float32Array} */ cov,
    ) => {
      for (let x = xa, o = (row + xa) * 4 + 3; x < xb; x++, o += 4) {
        const c = cov[x];
        if (c === 1 && !clip) {
          // a run of whole pixels over the same alpha: one native fill (colour bytes are not read here)
          const i = o >> 2,
            v = D32[i];
          let e = x + 1;
          while (e < xb && cov[e] === 1 && D32[row + e] === v) e++;
          PX8[0] = PX8[1] = PX8[2] = 0;
          PX8[3] = AOVER[K1 | D[o]];
          D32.fill(PX32[0], i, row + e);
          o += (e - 1 - x) * 4;
          x = e - 1;
          continue;
        }
        let a = c * alpha;
        if (clip) a *= clip[row + x] / 255;
        if (a > 0) D[o] = AOVER[(((a >= 1 ? 1 : a) * 256 + 0.5) << 8) | D[o]];
      }
    };
    if (ao)
      // an Alpha soft mask's form: only alpha is read; source-over of alpha from a table (a in 1/256ths)
      return fill(polys, eo, (y, xa, xb, cov, i0 = 0, i1 = 0) => {
        const row = y * W;
        if (i1 > i0 && !clip) {
          // a rectangle's whole pixels: runs over the same alpha, one native fill each
          for (let x = i0; x < i1;) {
            const v = I32[row + x];
            let e = x + 1;
            if (F64 && v) {
              // two pixels a compare: (v, v) as a float64 is neither NaN-equal nor ±0 when v ≠ 0, so == is bitwise
              // (a NaN pair only ends the run early)
              I32P[0] = I32P[1] = v;
              const vv = F64P[0];
              let k = row + e;
              if (k & 1 && e < i1 && I32[k] === v) (e++, k++);
              if (!(k & 1)) while (e + 1 < i1 && F64[k >> 1] === vv) ((e += 2), (k += 2));
            }
            while (e < i1 && I32[row + e] === v) e++;
            PX8[0] = PX8[1] = PX8[2] = 0;
            PX8[3] = AOVER[K1 | D[(row + x) * 4 + 3]];
            D32.fill(PX32[0], row + x, row + e);
            x = e;
          }
          edge(row, xa, i0, cov);
          edge(row, i1, xb, cov);
          return;
        }
        edge(row, xa, xb, cov);
      });
    // the last pixel mixed and what it became (flat backdrops repeat it)
    let lastIn = 0,
      lastOut = 0,
      lastK = -1;
    const opaque = alpha >= 1 && !clip;
    fill(polys, eo, (y, xa, xb, cov) => {
      let o = (y * W + xa) * 4;
      const row = y * W;
      for (let x = xa; x < xb; x++, o += 4) {
        if (opaque && cov[x] >= 1) {
          // a run of whole pixels: one native fill
          let e = x + 1;
          while (e < xb && cov[e] >= 1) e++;
          D32.fill(solid, row + x, row + e);
          o += (e - 1 - x) * 4;
          x = e - 1;
          continue;
        }
        let a = cov[x] * alpha;
        if (clip) a *= clip[row + x] / 255;
        if (a <= 0) continue;
        if (a >= 1) {
          D32[o >> 2] = solid;
          continue;
        }
        // fixed point, a in 1/256ths
        const k = (a * 256 + 0.5) | 0;
        const v = I32[o >> 2];
        if (v === lastIn && k === lastK) {
          I32[o >> 2] = lastOut;
          continue;
        }
        const da = D[o + 3];
        D[o + 3] = da + (((255 - da) * k + 128) >> 8);
        const d0 = D[o],
          d1 = D[o + 1],
          d2 = D[o + 2];
        D[o] = d0 + (((r - d0) * k + 128) >> 8);
        D[o + 1] = d1 + (((g - d1) * k + 128) >> 8);
        D[o + 2] = d2 + (((b - d2) * k + 128) >> 8);
        ((lastIn = v), (lastOut = I32[o >> 2]), (lastK = k));
      }
    });
  }
  /**
   * one colour under a blend mode and/or soft mask, composited as it is rasterized: a fill is one object of one
   * colour, so its layer would hold just that colour times coverage (no layer needed)
   * @param {ArrayLike<number>[]} polys @param {boolean} eo @param {number[]} rgb @param {number} alpha @param {Uint8Array | null} clip @param {number} m @param {Uint8Array | null} mask
   */
  function paintBlended(polys, eo, rgb, alpha, clip, m, mask) {
    const T = blendTable(m),
      D = data,
      s0 = rgb[0] * 255,
      s1 = rgb[1] * 255,
      s2 = rgb[2] * 255,
      q0 = (s0 + 0.5) | 0,
      q1 = (s1 + 0.5) | 0,
      q2 = (s2 + 0.5) | 0;
    ((CS[0] = s0), (CS[1] = s1), (CS[2] = s2));
    const D32 = data32,
      I32 = new Int32Array(D32.buffer, D32.byteOffset, D32.length); // pixels as int32: compared without doubles
    let last = -1, // the backdrop pixel B was last worked out for (flat backdrops repeat it)
      mIn = -1, // and the last pixel mixed, at what alpha, and what it became
      mA = -1,
      mOut = 0;
    fill(polys, eo, (y, xa, xb, cov) => {
      src.budget.tick(xb - xa); // a step per pixel composited, before the work
      const row = y * W;
      for (let x = xa, p = (row + xa) * 4; x < xb; x++, p += 4) {
        let a = cov[x] * alpha;
        if (clip) a *= clip[row + x] / 255;
        if (mask) a *= mask[row + x] / 255;
        if (a <= 0) continue;
        if (a > 1) a = 1;
        const v0 = I32[p >> 2];
        if (v0 === mIn && a === mA) {
          I32[p >> 2] = mOut; // the same backdrop and alpha as the pixel before (flat areas)
          continue;
        }
        ((mIn = v0), (mA = a));
        if (!m) {
          // Normal: fixed point, a in 1/256ths
          const k = (a * 256 + 0.5) | 0,
            d0 = D[p],
            d1 = D[p + 1],
            d2 = D[p + 2];
          D[p] = d0 + (((q0 - d0) * k + 128) >> 8);
          D[p + 1] = d1 + (((q1 - d1) * k + 128) >> 8);
          D[p + 2] = d2 + (((q2 - d2) * k + 128) >> 8);
          D[p + 3] = AOVER[(k << 8) | D[p + 3]];
          mOut = I32[p >> 2];
          continue;
        } else if (T && D[p + 3] === 255) {
          const d0 = D[p],
            d1 = D[p + 1],
            d2 = D[p + 2];
          if (a >= 1) ((D[p] = T[(d0 << 8) | q0]), (D[p + 1] = T[(d1 << 8) | q1]), (D[p + 2] = T[(d2 << 8) | q2]));
          else {
            const k = (a * 256 + 0.5) | 0; // fixed point, 1/256ths
            D[p] = d0 + (((T[(d0 << 8) | q0] - d0) * k + 128) >> 8);
            D[p + 1] = d1 + (((T[(d1 << 8) | q1] - d1) * k + 128) >> 8);
            D[p + 2] = d2 + (((T[(d2 << 8) | q2] - d2) * k + 128) >> 8);
          }
          mOut = I32[p >> 2];
          continue;
        } else {
          const ba = D[p + 3],
            ab = ba / 255;
          const v = D32[p >> 2];
          if (v !== last) {
            const kb = ba ? 255 / ba : 0;
            ((CB[0] = D[p] * kb), (CB[1] = D[p + 1] * kb), (CB[2] = D[p + 2] * kb));
            if (T) for (let c = 0; c < 3; c++) BL[c] = T[(Math.round(CB[c]) << 8) | Math.round(CS[c])];
            else blendInto(m, CB, 0, CS, 0, BL);
            last = v;
          }
          for (let c = 0; c < 3; c++) D[p + c] += ((1 - ab) * CS[c] + ab * BL[c] - D[p + c]) * a;
        }
        if (D[p + 3] < 255) D[p + 3] += (255 - D[p + 3]) * a;
        mOut = I32[p >> 2];
      }
    });
  }
  /** composite polygons with a pattern: its colour per device pixel @param {ArrayLike<number>[]} polys @param {boolean} eo @param {number} alpha @param {Uint8Array | null} clip @param {any} pat */
  function paintWith(polys, eo, alpha, clip, pat) {
    const sample = samplerOf(pat);
    if (!sample) return;
    const o = [0, 0, 0, 1];
    const span = /** @type {any} */ (sample).span;
    if (span) return paintSpans(polys, eo, alpha, clip, span);
    fill(polys, eo, (y, xa, xb, cov) => {
      src.budget.tick(xb - xa); // a step per sampled pixel (a pattern costs more than a colour)
      let p = (y * W + xa) * 4;
      for (let x = xa; x < xb; x++, p += 4) {
        let a = cov[x] * alpha;
        if (clip) a *= clip[y * W + x] / 255;
        if (a <= 0) continue;
        if (!sample(x + 0.5, y + 0.5, o)) continue;
        a *= o[3];
        if (a <= 0) continue;
        if (a >= 1) {
          ((PX8[0] = o[0]), (PX8[1] = o[1]), (PX8[2] = o[2]), (PX8[3] = 255));
          data32[p >> 2] = PX32[0];
          continue;
        }
        data[p] += (o[0] - data[p]) * a;
        data[p + 1] += (o[1] - data[p + 1]) * a;
        data[p + 2] += (o[2] - data[p + 2]) * a;
        if (data[p + 3] < 255) data[p + 3] += (255 - data[p + 3]) * a;
      }
    });
  }

  /** paintWith for an axial or radial shading: a row of table entries at a time, opaque pixels written whole */
  function paintSpans(
    /** @type {ArrayLike<number>[]} */ polys,
    /** @type {boolean} */ eo,
    /** @type {number} */ alpha,
    /** @type {Uint8Array | null} */ clip,
    /** @type {any} */ span,
  ) {
    const idx = new Int32Array(W),
      { lut, px } = span,
      opaque = alpha >= 1;
    const row = (
      /** @type {number} */ y,
      /** @type {number} */ xa,
      /** @type {number} */ xb,
      /** @type {Float32Array} */ cov,
    ) => {
      src.budget.tick(xb - xa); // a step per sampled pixel, as paintWith
      span(xa, xb, y, idx);
      const row = y * W;
      for (let x = xa; x < xb; x++) {
        const e = idx[x - xa];
        if (e < 0) continue;
        const cv = cov[x],
          m = clip ? clip[row + x] : 255;
        if (cv >= 1 && m === 255 && opaque) {
          data32[row + x] = px[e]; // the common case: whole pixel, no clip edge
          continue;
        }
        const a = (cv * alpha * m) / 255,
          p = (row + x) * 4;
        if (a <= 0) continue;
        if (a >= 1) {
          data32[p >> 2] = px[e];
          continue;
        }
        const c = e * 3;
        data[p] += (lut[c] - data[p]) * a;
        data[p + 1] += (lut[c + 1] - data[p + 1]) * a;
        data[p + 2] += (lut[c + 2] - data[p + 2]) * a;
        if (data[p + 3] < 255) data[p + 3] += (255 - data[p + 3]) * a;
      }
    };
    // a whole-pixel rectangle (sh over a rectangular clip) covers its pixels exactly: no rasterizing
    const r = pixelRect(polys, W, H);
    if (r) {
      if (box && r[2] > r[0]) (grow(r[1], r[0], r[2]), grow(r[3] - 1, r[0], r[2]));
      if (clip || !opaque) return rectRows(r, row);
      // whole pixels, opaque, no clip: the colours as they are; a row sampling as the one before is copied
      const prev = new Int32Array(W);
      let py = -1;
      return rectRows(r, (y, xa, xb) => {
        src.budget.tick(xb - xa);
        span(xa, xb, y, idx);
        const row = y * W,
          n = xb - xa;
        if (py >= 0) {
          let i = 0;
          while (i < n && idx[i] === prev[i]) i++;
          if (i === n) return data32.copyWithin(row + xa, py * W + xa, py * W + xb);
        }
        for (let i = 0; i < n; i++) {
          const e = idx[i];
          if (e >= 0) data32[row + xa + i] = px[e];
        }
        prev.set(idx.subarray(0, n));
        py = y;
      });
    }
    fill(polys, eo, row);
  }

  // ---- shadings and patterns ----
  /** a compiled shading (cached per document) @param {any} obj */
  function shadingOf(obj) {
    obj = R(obj);
    if (C.shadings.has(obj)) return C.shadings.get(obj);
    let sh = null;
    try {
      sh = compileShading(obj, {
        R,
        data: (/** @type {PdfStream} */ st) => src.decodeStream(st).data,
        tick: (/** @type {number} */ n) => src.budget.tick(n),
        space: (/** @type {any} */ v) => space(v, null),
      });
    } catch (e) {
      if (stops(e)) throw e;
    }
    const n = sh?.tris?.length ?? 0;
    if ((C.shadingNumbers += n + LUT * 3) > MAX_DOC_SHADING_NUMBERS || C.shadings.size >= MAX_DOC_SHADINGS)
      (C.shadings.clear(), (C.shadingNumbers = n));
    C.shadings.set(obj, sh);
    return sh;
  }
  /**
   * a sampler for a pattern paint: (x, y, out) → whether device point (x, y) is painted; out = r, g, b (0–255), alpha
   * @param {any} pat
   */
  function samplerOf(pat) {
    if (pat.kind === 'shading') {
      const sh = shadingOf(pat.obj);
      if (!sh) return null;
      const im = inv(pat.m);
      if (!im) return null;
      const bg = pat.background ? sh.background : null,
        bb = sh.bbox;
      if (sh.tris) {
        const layer = layerFor(sh, pat.m).L;
        return (/** @type {number} */ x, /** @type {number} */ y, /** @type {number[]} */ o) => {
          const i = ((y | 0) * W + (x | 0)) * 4;
          if (layer[i + 3]) ((o[0] = layer[i]), (o[1] = layer[i + 1]), (o[2] = layer[i + 2]));
          else if (bg) ((o[0] = bg[0]), (o[1] = bg[1]), (o[2] = bg[2]));
          else return false;
          o[3] = 1;
          return true;
        };
      }
      const f = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number[]} */ o) => {
        const u = im[0] * x + im[2] * y + im[4],
          v = im[1] * x + im[3] * y + im[5];
        if (bb && (u < bb[0] || u > bb[2] || v < bb[1] || v > bb[3])) return false;
        if (!sh.at(u, v, o)) {
          if (!bg) return false;
          ((o[0] = bg[0]), (o[1] = bg[1]), (o[2] = bg[2]));
        }
        o[3] = 1;
        return true;
      };
      // a row at a time: the same points and colours as f, without a call per pixel
      if (sh.span)
        f.span = Object.assign(
          (
            /** @type {number} */ xa,
            /** @type {number} */ xb,
            /** @type {number} */ y,
            /** @type {Int32Array} */ idx,
          ) => sh.span(im, xa, xb, y, bb, !!bg, idx),
          { lut: sh.lut, px: sh.px },
        );
      return f;
    }
    return tiling(pat);
  }
  /** a mesh drawn on this device (once per shading and transform; its bytes count to the cap) @param {any} sh @param {M} m */
  function layerFor(sh, m) {
    const lk = `${idOf(sh)}|${m.join(',')}`;
    let layer = layers.get(lk);
    if (!layer) {
      if (layers.size >= 16) layers.clear();
      layers.set(lk, (layer = meshLayer(sh.tris, m)));
    }
    return layer;
  }
  /** a mesh's triangles drawn into a device-sized layer (Gouraud, RGB at the corners) @param {Float64Array} T @param {M} m */
  function meshLayer(T, m) {
    if ((mem.clip += W * H * 4) > MAX_CLIP_BYTES)
      fail('E_BUDGET', `A page's clipping and shading need more than ${MAX_CLIP_BYTES.toLocaleString('en')} bytes`);
    src.budget.tick(1 + ((W * H) >> 8) + T.length / 15);
    const L = new Uint8ClampedArray(W * H * 4),
      box = [W, H, 0, 0];
    for (let t = 0; t < T.length; t += 15) {
      const ax = m[0] * T[t] + m[2] * T[t + 1] + m[4],
        ay = m[1] * T[t] + m[3] * T[t + 1] + m[5],
        bx = m[0] * T[t + 5] + m[2] * T[t + 6] + m[4],
        by = m[1] * T[t + 5] + m[3] * T[t + 6] + m[5],
        cx = m[0] * T[t + 10] + m[2] * T[t + 11] + m[4],
        cy = m[1] * T[t + 10] + m[3] * T[t + 11] + m[5];
      const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (!area || !Number.isFinite(area)) continue;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))),
        x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx))),
        y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))),
        y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
      if (x1 < x0 || y1 < y0) continue;
      src.budget.tick(1 + (((x1 - x0 + 1) * (y1 - y0 + 1)) >> 6)); // its pixels, before they are drawn
      ((box[0] = Math.min(box[0], x0)),
        (box[1] = Math.min(box[1], y0)),
        (box[2] = Math.max(box[2], x1 + 1)),
        (box[3] = Math.max(box[3], y1 + 1)));
      for (let y = y0; y <= y1; y++) {
        const py = y + 0.5;
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5;
          const wa = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / area,
            wb = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / area,
            wc = 1 - wa - wb;
          if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) continue;
          const i = (y * W + x) * 4;
          L[i] = wa * T[t + 2] + wb * T[t + 7] + wc * T[t + 12];
          L[i + 1] = wa * T[t + 3] + wb * T[t + 8] + wc * T[t + 13];
          L[i + 2] = wa * T[t + 4] + wb * T[t + 9] + wc * T[t + 14];
          L[i + 3] = 255;
        }
      }
    }
    return { L, box };
  }
  /**
   * a tiling pattern's sampler: one period of its cell drawn at device resolution (cached per document), read by
   * wrapping device pixels into it. The cost is per painted pixel whatever XStep / YStep: a tiny step over a huge
   * area draws one small cell, never one cell per step.
   * @param {any} pat
   */
  function tiling(pat) {
    const st = R(pat.obj);
    if (!(st instanceof PdfStream)) return null;
    const d = st.dict;
    const xs = Math.abs(num(R(d.get('XStep')), 0)),
      ys = Math.abs(num(R(d.get('YStep')), 0)),
      bb = R(d.get('BBox'));
    if (!(xs > 0 && ys > 0 && Number.isFinite(xs) && Number.isFinite(ys)) || !Array.isArray(bb) || bb.length < 4)
      return null;
    const [bx0, by0, bx1, by1] = bb.slice(0, 4).map((v) => num(R(v), 0));
    const m = pat.m,
      im = inv(m);
    if (!im) return null;
    const uncoloured = R(d.get('PaintType')) === 2;
    if (uncoloured && !pat.color) return null;
    // cell pixels per pattern unit, at most MAX_CELL_PIXELS in all
    let cw = Math.max(1, Math.ceil(xs * Math.hypot(m[0], m[1]))),
      ch = Math.max(1, Math.ceil(ys * Math.hypot(m[2], m[3])));
    if (!Number.isFinite(cw * ch)) return null;
    if (cw * ch > MAX_CELL_PIXELS) {
      const f = Math.sqrt(MAX_CELL_PIXELS / (cw * ch));
      cw = Math.max(1, Math.min(MAX_CELL_PIXELS, Math.floor(cw * f)));
      ch = Math.max(1, Math.min(Math.floor(MAX_CELL_PIXELS / cw), Math.floor(ch * f)));
    }
    const kx = cw / xs,
      ky = ch / ys;
    const key = `${idOf(st)}|${m.map((v) => v.toFixed(3)).join(',')}`;
    let cell = C.tiles.get(key);
    if (!cell) {
      if (openPatterns.has(st) || openPatterns.size >= MAX_PATTERN_DEPTH) return null; // no re-entry, bounded nesting
      src.budget.tick(1 + ((cw * ch) >> 6));
      cell = new Uint8ClampedArray(cw * ch * 4);
      const content = src.decodeStream(st).data;
      const res = R(d.get('Resources'));
      const n = Math.min(MAX_CELL_COPIES, Math.max(1, Math.ceil(Math.max(bx1 - bx0, by1 - by0) / Math.min(xs, ys))));
      openPatterns.add(st);
      try {
        const ctx = painter(src, cell, cw, ch, subs, mem); // one mask budget for the page and its cells
        // every copy of the cell that overlaps this period, each clipped to its BBox; cell space: (BBox origin) = 0
        for (let i = -n; i <= n; i++)
          for (let j = -n; j <= n; j++) {
            const ox = i * xs,
              oy = j * ys;
            if (ox + bx1 - bx0 <= 0 || ox >= xs || oy + by1 - by0 <= 0 || oy >= ys) continue;
            const ctm = [kx, 0, 0, ky, (ox - bx0) * kx, (oy - by0) * ky];
            ctx.cell(content, res instanceof Map ? res : null, ctm, [bx0, by0, bx1, by1]);
          }
      } finally {
        openPatterns.delete(st);
      }
      if ((C.tileBytes += cell.length) > MAX_DOC_TILE_BYTES) (C.tiles.clear(), (C.tileBytes = cell.length));
      C.tiles.set(key, cell);
    }
    const c = cell,
      col = uncoloured ? pat.color : null;
    return (/** @type {number} */ x, /** @type {number} */ y, /** @type {number[]} */ o) => {
      let u = (im[0] * x + im[2] * y + im[4] - bx0) % xs,
        v = (im[1] * x + im[3] * y + im[5] - by0) % ys;
      if (u < 0) u += xs;
      if (v < 0) v += ys;
      // bilinear over the wrapped cell (premultiplied), as a canvas pattern is smoothed
      const fx = u * kx - 0.5,
        fy = v * ky - 0.5;
      const x0 = Math.floor(fx),
        y0 = Math.floor(fy),
        tx = fx - x0,
        ty = fy - y0;
      const X0 = (x0 + cw) % cw,
        X1 = (x0 + 1 + cw) % cw,
        Y0 = ((y0 + ch) % ch) * cw,
        Y1 = ((y0 + 1 + ch) % ch) * cw;
      const i00 = (Y0 + X0) * 4,
        i10 = (Y0 + X1) * 4,
        i01 = (Y1 + X0) * 4,
        i11 = (Y1 + X1) * 4;
      const w00 = (1 - tx) * (1 - ty),
        w10 = tx * (1 - ty),
        w01 = (1 - tx) * ty,
        w11 = tx * ty;
      const a = c[i00 + 3] * w00 + c[i10 + 3] * w10 + c[i01 + 3] * w01 + c[i11 + 3] * w11;
      if (a < 0.5) return false;
      if (col) ((o[0] = col[0]), (o[1] = col[1]), (o[2] = col[2]));
      else {
        const k = 255 / a; // drawn over transparency: the colours are premultiplied
        for (let q = 0; q < 3; q++)
          o[q] = (c[i00 + q] * w00 + c[i10 + q] * w10 + c[i01 + q] * w01 + c[i11 + q] * w11) * k;
      }
      o[3] = a / 255;
      return true;
    };
  }
  /** a pattern colour → a paint, or null (nothing drawn) @param {any} name @param {any} res @param {any} cs @param {number[]} comps @param {M} base */
  function patternPaint(name, res, cs, comps, base) {
    const p = R(R(res instanceof Map ? res.get('Pattern') : null)?.get?.(name));
    const d = p instanceof PdfStream ? p.dict : p;
    if (!(d instanceof Map)) return null;
    const m = mul(matrixOf(R(d.get('Matrix'))) ?? [1, 0, 0, 1, 0, 0], base);
    const type = R(d.get('PatternType'));
    if (type === 2) return { kind: 'shading', obj: d.get('Shading'), m, background: true };
    if (type === 1)
      return {
        kind: 'tiling',
        obj: p,
        m,
        color:
          cs.under && comps.length >= cs.under.n ? cs.under.rgb(comps).map((/** @type {number} */ v) => v * 255) : null,
      };
    return null;
  }
  /** a clip mask: the old one (or none) times the polygons' coverage @param {ArrayLike<number>[]} polys @param {boolean} eo @param {Uint8Array | null} old */
  function clipOf(polys, eo, old) {
    const whole = pixelRect(polys, W, H);
    if (whole && !whole[0] && !whole[1] && whole[2] === W && whole[3] === H)
      return (src.budget.tick(4 + ((W * H) >> 10) + H * (1 + (W >> 4))), old); // the whole page: no change (charged as its mask would be)
    if ((mem.clip += W * H) > MAX_CLIP_BYTES)
      fail('E_BUDGET', `A page's clipping needs more than ${MAX_CLIP_BYTES.toLocaleString('en')} bytes of masks`);
    src.budget.tick(1 + ((W * H) >> 10)); // the mask's allocation and clearing
    const m = new Uint8Array(W * H);
    if (cvx) clipPaths.set(m, { polys, eo, old, p: null });
    const box = [W, H, 0, 0];
    const rect = pixelRect(polys, W, H); // a whole-pixel rectangle: its mask without rasterizing
    (rect ? (/** @type {any} */ f) => rectRows(rect, f) : (/** @type {any} */ f) => ras.fill(polys, eo, f))(
      (
        /** @type {number} */ y,
        /** @type {number} */ xa,
        /** @type {number} */ xb,
        /** @type {Float32Array} */ cov,
      ) => {
        ((box[0] = Math.min(box[0], xa)),
          (box[1] = Math.min(box[1], y)),
          (box[2] = Math.max(box[2], xb)),
          (box[3] = Math.max(box[3], y + 1)));
        for (let x = xa; x < xb; x++)
          m[y * W + x] = old ? (cov[x] * old[y * W + x] + 0.5) | 0 : (cov[x] * 255 + 0.5) | 0;
      },
    );
    const ob = old ? clipBoxes.get(old) : null;
    if (ob)
      ((box[0] = Math.max(box[0], ob[0])),
        (box[1] = Math.max(box[1], ob[1])),
        (box[2] = Math.min(box[2], ob[2])),
        (box[3] = Math.min(box[3], ob[3])));
    clipBoxes.set(m, box);
    return m;
  }
  /** polylines (user space) → device polygons @param {{ pts: number[] }[]} lines @param {M} m */
  const toDevice = (lines, m) =>
    lines.map(({ pts }) => {
      const d = new Float64Array(pts.length);
      for (let i = 0; i < pts.length; i += 2) {
        d[i] = m[0] * pts[i] + m[2] * pts[i + 1] + m[4];
        d[i + 1] = m[1] * pts[i] + m[3] * pts[i + 1] + m[5];
      }
      return d;
    });
  const unit = (/** @type {M} */ m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1e-9; // device px per user unit
  /** fill a path (user space) @param {number[]} path @param {GS} gs @param {boolean} eo */
  function fillPath(path, gs, eo) {
    if (gs.fnone || cvPath(path, gs, false, eo)) return;
    paint(toDevice(flatten(path, 0.2 / unit(gs.ctm)), gs.ctm), eo, gs.fill, gs.ca, gs.clip, gs.fpat);
  }
  /** stroke a path (user space) @param {number[]} path @param {GS} gs */
  function strokePath(path, gs) {
    if (gs.snone || cvPath(path, gs, true, false)) return;
    const u = unit(gs.ctm);
    let lines = flatten(path, 0.2 / u);
    if (gs.dash.length) lines = dashed(lines, gs.dash, gs.phase);
    const hw = Math.max(gs.lw, 1 / u) / 2; // a line is at least a device pixel wide (as pdf.js and Acrobat draw it)
    const seg = Math.max(8, Math.min(64, Math.ceil(hw * u * 2)));
    paint(
      toDevice(/** @type {any} */ (stroke(lines, hw, gs.cap, gs.join, gs.ml, seg).map((pts) => ({ pts }))), gs.ctm),
      false,
      gs.strokeC,
      gs.CA,
      gs.clip,
      gs.spat,
    );
  }

  // ---- fonts ----
  /** a font dictionary → { codes(bytes) → [code, single][], width(code), glyph(code) → path, fm } or null @param {any} fd */
  function fontOf(fd) {
    if (fonts.has(fd)) return fonts.get(fd);
    let f = null;
    try {
      f = makeFont(fd);
    } catch (e) {
      if (stops(e)) throw e;
    }
    if (fonts.size >= MAX_DOC_FONTS) fonts.clear(); // ponytail: emptied, not LRU
    fonts.set(fd, f);
    return f;
  }
  /** outlines of a font file stream → { glyph(gid), fm, gidOfCid?, sfnt? } @param {any} desc */
  function program(desc) {
    if (!(desc instanceof Map)) return null;
    const ff2 = R(desc.get('FontFile2')),
      ff3 = R(desc.get('FontFile3'));
    if (ff2 instanceof PdfStream) return sfntProgram(src.decodeStream(ff2).data);
    if (ff3 instanceof PdfStream) {
      const b = src.decodeStream(ff3).data,
        st = R(ff3.dict.get('Subtype'));
      if (st === 'OpenType') return sfntProgram(b);
      const c = cffOutlines(b);
      return { glyph: c.glyph, fm: 0.001, gidOfCid: c.gidOf, sfnt: null };
    }
    return null; // ponytail: Type 1 (FontFile) is phase 2
  }
  /** @param {Uint8Array} b */
  function sfntProgram(b) {
    const t = sfntTables(b);
    if (t.has('CFF ')) {
      const c = cffOutlines(/** @type {Uint8Array} */ (t.get('CFF ')));
      return { glyph: c.glyph, fm: 0.001, gidOfCid: c.gidOf, sfnt: safeFont(b) };
    }
    const f = parseFont(b, false);
    return {
      glyph: glyfOutlines(t, f.indexToLocFormat, f.numGlyphs),
      fm: 1 / f.unitsPerEm,
      gidOfCid: null,
      sfnt: safeFont(b),
    };
  }
  const safeFont = (/** @type {Uint8Array} */ b) => {
    try {
      return parseFont(b, true);
    } catch {
      return null;
    }
  };
  /** @param {any} fd */
  function makeFont(fd) {
    const sub = R(fd.get('Subtype'));
    const cache = new Map();
    let held = 0;
    const cached = (/** @type {number} */ g, /** @type {(g: number) => number[]} */ make) => {
      let p = cache.get(g);
      if (!p) {
        p = make(g);
        src.budget.tick(1 + (p.length >> 4)); // decoding it
        if ((held += p.length) > MAX_GLYPH_CACHE) (cache.clear(), (held = p.length)); // ponytail: drop all, not LRU
        if ((C.glyphs += p.length) > MAX_DOC_GLYPHS) (fonts.clear(), (C.glyphs = 0)); // every font, across renders
        cache.set(g, p);
      }
      return p;
    };
    if (sub === 'Type0') {
      const enc = R(fd.get('Encoding'));
      if (enc !== 'Identity-H' && enc !== 'Identity-V') return null; // ponytail: other CMaps are phase 2
      const dsc = R(fd.get('DescendantFonts')),
        cid = R(Array.isArray(dsc) ? dsc[0] : null);
      if (!(cid instanceof Map)) return null;
      const prog = program(R(cid.get('FontDescriptor')));
      const dw = num(R(cid.get('DW')), 1000);
      const Wm = new Map();
      const w = R(cid.get('W'));
      if (Array.isArray(w))
        for (let i = 0, made = 0; i < w.length && made < 1_000_000;) {
          const a = R(w[i]),
            b = R(w[i + 1]);
          if (!Number.isInteger(a)) {
            i++;
            continue;
          }
          if (Array.isArray(b)) {
            for (let k = 0; k < b.length; k++) Wm.set(a + k, num(R(b[k]), dw));
            made += b.length;
            i += 2;
          } else {
            const hi = Math.min(num(b, a - 1), a + 65535),
              c = num(R(w[i + 2]), dw);
            for (let k = a; k <= hi; k++) Wm.set(k, c);
            made += Math.max(0, hi - a + 1);
            i += 3;
          }
          src.budget.tick();
        }
      const map = R(cid.get('CIDToGIDMap'));
      const gm = map instanceof PdfStream ? src.decodeStream(map).data : null;
      const gidOf = (/** @type {number} */ c) =>
        gm ? (2 * c + 1 < gm.length ? (gm[2 * c] << 8) | gm[2 * c + 1] : 0) : prog?.gidOfCid ? prog.gidOfCid(c) : c;
      return {
        codes: (/** @type {Uint8Array} */ b) => {
          const out = [];
          for (let i = 0; i + 1 < b.length; i += 2) out.push([(b[i] << 8) | b[i + 1], false]);
          return out;
        },
        width: (/** @type {number} */ c) => Wm.get(c) ?? dw,
        glyph: (/** @type {number} */ c) => (prog ? cached(gidOf(c), prog.glyph) : null),
        fm: prog?.fm ?? 0.001,
      };
    }
    if (sub !== 'TrueType' && sub !== 'Type1' && sub !== 'MMType1') return null; // ponytail: Type 3 is phase 2
    const desc = R(fd.get('FontDescriptor'));
    const base = String(R(fd.get('BaseFont')) ?? '').replace(/^[A-Z]{6}\+/, '');
    let prog = null;
    try {
      prog = program(desc);
    } catch (e) {
      if (stops(e)) throw e;
    }
    // code → glyph name: the base encoding (WinAnsi; ponytail: MacRoman / Standard read as WinAnsi) and /Differences
    /** @type {(string | undefined)[]} */ const names = [];
    const enc = R(fd.get('Encoding'));
    const diffs = enc instanceof Map ? R(enc.get('Differences')) : null;
    if (Array.isArray(diffs))
      for (let i = 0, c = 0; i < diffs.length && i < 100_000; i++) {
        const v = R(diffs[i]);
        if (typeof v === 'number') c = v;
        else if (typeof v === 'string' && c >= 0 && c < 256) names[c++] = v;
      }
    const flags = desc instanceof Map ? num(R(desc.get('Flags')), 0) : 0;
    const symbolic = (flags & 4) !== 0 && !(flags & 32);
    const uniOf = (/** @type {number} */ c) => {
      const n = names[c];
      if (n) {
        const t = glyphText(n);
        if (t) return /** @type {number} */ (t.codePointAt(0));
      }
      return WINANSI[c] ?? c;
    };
    const std = METRICS[/** @type {keyof typeof METRICS} */ (STD[base] ?? base)];
    const first = num(R(fd.get('FirstChar')), 0),
      widths = R(fd.get('Widths'));
    const width = (/** @type {number} */ c) => {
      const v = Array.isArray(widths) ? R(widths[c - first]) : undefined;
      if (typeof v === 'number') return v;
      return /** @type {any} */ (std)?.widths?.[c] ?? 500;
    };
    let glyph = /** @type {(c: number) => number[] | null} */ (() => null),
      fm = 0.001;
    if (prog?.sfnt) {
      const sf = prog.sfnt;
      fm = prog.fm;
      glyph = (c) => {
        let g = 0;
        if (symbolic || !Array.isArray(diffs)) g = sf.glyphFor(0xf000 + c) || 0;
        if (!g) g = sf.glyphFor(uniOf(c));
        if (!g && symbolic) g = sf.glyphFor(c);
        return cached(g, prog.glyph);
      };
    } else if (!prog) {
      const sym = base === 'Symbol' || base === 'ZapfDingbats';
      // Symbol and ZapfDingbats draw only with a font given for them by name (codes → their own Unicode table)
      const s = sym ? (subs[base] instanceof Uint8Array ? substitute(base) : null) : substitute(base);
      if (s) {
        fm = s.fm;
        const own = sym ? SYMBOLIC[base] : null;
        glyph = (c) => cached(s.sfnt.glyphFor(own && !names[c] ? (own[c] ?? 0) : uniOf(c)), s.glyph);
      }
    } // ponytail: a bare CFF simple font (FontFile3 /Type1C) needs its charset's glyph names: phase 2
    return {
      codes: (/** @type {Uint8Array} */ b) => Array.from(b, (c) => [c, true]),
      width,
      glyph,
      fm,
    };
  }
  /** a substitute for a font with no outlines in the file (o.fonts) @param {string} name */
  function substitute(name) {
    const key = STD[name] ?? name;
    const fam = key.split('-')[0];
    const bytes = subs[key] ?? subs[fam] ?? subs.default;
    if (!(bytes instanceof Uint8Array)) return null;
    if (!subFonts.has(bytes)) {
      try {
        const p = sfntProgram(bytes);
        subFonts.set(bytes, p.sfnt ? p : null);
      } catch {
        subFonts.set(bytes, null);
      }
    }
    return subFonts.get(bytes);
  }

  // ---- images ----
  /** an image XObject (or inline image) → { w, h, rgba } or null; mask: a stencil (fill colour) @param {PdfStream} st @param {any} res @param {Uint8Array | null} [raw] */
  function imageOf(st, res, raw = null) {
    if (!raw && images.has(st)) return images.get(st);
    let img = null;
    try {
      img = decodeImage(st, res, raw);
    } catch (e) {
      if (stops(e)) throw e;
    }
    if (!raw) {
      if (img && (C.imageBytes += img.rgba.length) > MAX_DOC_IMAGE_BYTES)
        (images.clear(), (C.imageBytes = img.rgba.length));
      images.set(st, img);
    }
    return img;
  }
  /** @param {PdfStream} st @param {any} res @param {Uint8Array | null} raw */
  function decodeImage(st, res, raw) {
    const d = st.dict;
    const g = (/** @type {string} */ k, /** @type {string} */ a) => R(d.get(k) ?? d.get(a));
    const w = g('Width', 'W'),
      h = g('Height', 'H');
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w * h > MAX_IMAGE_PIXELS) return null; // checked before anything is decoded or allocated
    let bytes;
    if (raw) {
      const r = decode(raw, g('Filter', 'F'), g('DecodeParms', 'DP'), src.budget, R);
      if (!r.done) return null;
      bytes = r.data;
    } else {
      const r = src.decodeStream(st);
      bytes = r.done ? r.data : null;
      if (r.filter === 'DCTDecode' || r.filter === 'DCT') {
        const dp = g('DecodeParms', 'DP'),
          p = R(Array.isArray(dp) ? dp[dp.length - 1] : dp);
        const ct = p instanceof Map ? R(p.get('ColorTransform')) : undefined;
        const j = decodeJpeg(r.data, {
          maxPixels: MAX_IMAGE_PIXELS,
          tick: (n) => src.budget.tick(n),
          transform: ct === 0 || ct === 1 ? ct : undefined,
        });
        if (j.w !== w || j.h !== h) return null; // ponytail: the dictionary and the JPEG disagree; not drawn
        bytes = j.data;
      }
      if (!bytes) return null; // ponytail: JPX / JBIG2 / CCITT are phase 2
    }
    const stencil = g('ImageMask', 'IM') === true;
    const bpc = stencil ? 1 : num(g('BitsPerComponent', 'BPC'), 8);
    const cs = stencil ? GRAY : space(g('ColorSpace', 'CS'), res);
    if (!cs || ![1, 2, 4, 8, 16].includes(bpc)) return null;
    const n = cs.n,
      max = (1 << bpc) - 1;
    const dec = g('Decode', 'D');
    const lo = [],
      hi = [];
    for (let k = 0; k < n; k++) {
      const dflt = cs.indexed !== undefined ? [0, max] : [0, 1];
      lo.push(Array.isArray(dec) ? num(R(dec[2 * k]), dflt[0]) : dflt[0]);
      hi.push(Array.isArray(dec) ? num(R(dec[2 * k + 1]), dflt[1]) : dflt[1]);
    }
    const stride = Math.ceil((w * n * bpc) / 8);
    const rgba = new Uint8ClampedArray(w * h * 4);
    const comps = new Array(n);
    const memo = new Map();
    for (let y = 0; y < h; y++) {
      if ((y & 63) === 0) src.budget.tick(1 + ((w * 64) >> 4)); // a step per 16 pixels decoded
      const row = y * stride;
      for (let x = 0; x < w; x++) {
        let key = 0;
        for (let k = 0; k < n; k++) {
          const i = x * n + k;
          let v;
          if (bpc === 8) v = bytes[row + i] ?? 0;
          else if (bpc === 16) v = ((bytes[row + 2 * i] ?? 0) << 8) | (bytes[row + 2 * i + 1] ?? 0);
          else {
            const bit = i * bpc;
            v = ((bytes[row + (bit >> 3)] ?? 0) >> (8 - bpc - (bit & 7))) & max;
          }
          key = key * (max + 1) + v;
          comps[k] = lo[k] + (v * (hi[k] - lo[k])) / max;
        }
        const o = (y * w + x) * 4;
        if (stencil) {
          rgba[o + 3] = comps[0] < 0.5 ? 255 : 0; // sample 0 paints (Decode [1 0] inverts)
          continue;
        }
        let c = n <= 4 && bpc <= 8 ? memo.get(key) : undefined;
        if (!c) {
          c = cs.rgb(comps);
          if (n <= 4 && bpc <= 8 && memo.size < 65536) memo.set(key, c);
        }
        rgba[o] = c[0] * 255;
        rgba[o + 1] = c[1] * 255;
        rgba[o + 2] = c[2] * 255;
        rgba[o + 3] = 255;
      }
    }
    // a soft mask (a gray image, any size) or a colour-key /Mask
    const sm = R(d.get('SMask'));
    if (sm instanceof PdfStream) {
      const m = imageOf(sm, res);
      if (m)
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const mx = Math.min(m.w - 1, Math.floor(((x + 0.5) * m.w) / w)),
              my = Math.min(m.h - 1, Math.floor(((y + 0.5) * m.h) / h));
            rgba[(y * w + x) * 4 + 3] = m.rgba[(my * m.w + mx) * 4];
          }
    }
    const mk = R(d.get('Mask'));
    if (Array.isArray(mk) && mk.length >= 2 * n && n === 1 && bpc <= 8) {
      const a = num(R(mk[0]), -1),
        b = num(R(mk[1]), -1);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const bit = x * bpc,
            v = ((bytes[y * stride + (bit >> 3)] ?? 0) >> (8 - bpc - (bit & 7))) & max;
          if (bpc === 8 ? bytes[y * stride + x] >= a && bytes[y * stride + x] <= b : v >= a && v <= b)
            rgba[(y * w + x) * 4 + 3] = 0;
        }
    } // ponytail: colour-key masks for more than one component, and stencil /Mask streams, are phase 2
    return { w, h, rgba, stencil, smooth: g('Interpolate', 'I') === true };
  }
  /** draw an image in the unit square of gs.ctm @param {{ w: number, h: number, rgba: Uint8ClampedArray, stencil: boolean, smooth: boolean }} img @param {GS} gs */
  function drawImage(img, gs) {
    if (native() && !xfer && cvImage(img, gs)) return;
    if (xfer && !busy) return layered(xfer, 1, () => drawImage(img, gs), false);
    if (data === page) toPixels();
    const m = gs.ctm,
      im = inv(m);
    if (!im) return;
    const quad = toDevice([{ pts: [0, 0, 1, 0, 1, 1, 0, 1] }], m);
    const { w, h, rgba } = img;
    const fr = gs.fill[0] * 255,
      fg = gs.fill[1] * 255,
      fb = gs.fill[2] * 255;
    const alpha = gs.ca,
      clip = gs.clip;
    // bilinear only when the image asks (/Interpolate), as pdf.js and Acrobat draw it. ponytail: no box filter when shrinking
    const smooth = img.smooth;
    const stencil = img.stencil;
    // nearest neighbour, the common case: the source steps by (du, dv) per device pixel; opaque pixels are copied
    const sx0 = im[0] * w,
      sy0 = -im[1] * h;
    const src32 =
      !stencil && !smooth && !(rgba.byteOffset & 3) ? new Uint32Array(rgba.buffer, rgba.byteOffset, (w * h) | 0) : null;
    fill(quad, false, (y, xa, xb, cov) => {
      let o = (y * W + xa) * 4;
      if (!smooth) {
        const py = y + 0.5,
          px0 = xa + 0.5;
        let fx = (im[0] * px0 + im[2] * py + im[4]) * w - 0.5,
          fy = (1 - (im[1] * px0 + im[3] * py + im[5])) * h - 0.5;
        const ci = y * W;
        if (src32 && !clip && alpha >= 1 && sy0 === 0) {
          // an upright, unclipped colour image: one source row; whole, opaque pixels copied as words
          let iy = (fy + 0.5) | 0;
          iy = iy < 0 ? 0 : iy >= h ? h - 1 : iy;
          const sr = iy * w;
          for (let x = xa; x < xb; x++, o += 4, fx += sx0) {
            let ix = (fx + 0.5) | 0;
            ix = ix < 0 ? 0 : ix >= w ? w - 1 : ix;
            const v = src32[sr + ix];
            if (cov[x] >= 1 && rgba[(sr + ix) * 4 + 3] === 255) {
              data32[ci + x] = v;
              continue;
            }
            const p = (sr + ix) * 4,
              a = (cov[x] * rgba[p + 3]) / 255;
            if (a <= 0) continue;
            data[o] += (rgba[p] - data[o]) * a;
            data[o + 1] += (rgba[p + 1] - data[o + 1]) * a;
            data[o + 2] += (rgba[p + 2] - data[o + 2]) * a;
            if (data[o + 3] < 255) data[o + 3] += (255 - data[o + 3]) * a;
          }
          return;
        }
        for (let x = xa; x < xb; x++, o += 4, fx += sx0, fy += sy0) {
          let a = cov[x] * alpha;
          if (clip) a *= clip[ci + x] / 255;
          if (a <= 0) continue;
          let ix = (fx + 0.5) | 0, // round: values below 0 clamp to 0 either way
            iy = (fy + 0.5) | 0;
          ix = ix < 0 ? 0 : ix >= w ? w - 1 : ix;
          iy = iy < 0 ? 0 : iy >= h ? h - 1 : iy;
          const p = (iy * w + ix) * 4,
            sa = rgba[p + 3];
          if (sa === 0) continue;
          const sr = stencil ? fr : rgba[p],
            sg = stencil ? fg : rgba[p + 1],
            sb = stencil ? fb : rgba[p + 2];
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
        return;
      }
      for (let x = xa; x < xb; x++, o += 4) {
        let a = cov[x] * alpha;
        if (clip) a *= clip[y * W + x] / 255;
        if (a <= 0) continue;
        const px = x + 0.5,
          py = y + 0.5;
        const u = im[0] * px + im[2] * py + im[4],
          v = im[1] * px + im[3] * py + im[5];
        let sr, sg, sb, sa;
        const fx = u * w - 0.5,
          fy = (1 - v) * h - 0.5;
        if (smooth) {
          const ix = Math.floor(fx),
            iy = Math.floor(fy),
            tx = fx - ix,
            ty = fy - iy;
          const X0 = Math.max(0, Math.min(w - 1, ix)),
            X1 = Math.max(0, Math.min(w - 1, ix + 1)),
            Y0 = Math.max(0, Math.min(h - 1, iy)),
            Y1 = Math.max(0, Math.min(h - 1, iy + 1));
          const p00 = (Y0 * w + X0) * 4,
            p10 = (Y0 * w + X1) * 4,
            p01 = (Y1 * w + X0) * 4,
            p11 = (Y1 * w + X1) * 4;
          const k00 = (1 - tx) * (1 - ty),
            k10 = tx * (1 - ty),
            k01 = (1 - tx) * ty,
            k11 = tx * ty;
          sa = (rgba[p00 + 3] * k00 + rgba[p10 + 3] * k10 + rgba[p01 + 3] * k01 + rgba[p11 + 3] * k11) / 255;
          const mixc = (/** @type {number} */ c) =>
            sa > 0
              ? (rgba[p00 + c] * rgba[p00 + 3] * k00 +
                  rgba[p10 + c] * rgba[p10 + 3] * k10 +
                  rgba[p01 + c] * rgba[p01 + 3] * k01 +
                  rgba[p11 + c] * rgba[p11 + 3] * k11) /
                (sa * 255)
              : 0;
          sr = mixc(0);
          sg = mixc(1);
          sb = mixc(2);
        } else {
          const p =
            (Math.max(0, Math.min(h - 1, Math.round(fy))) * w + Math.max(0, Math.min(w - 1, Math.round(fx)))) * 4;
          sr = rgba[p];
          sg = rgba[p + 1];
          sb = rgba[p + 2];
          sa = rgba[p + 3] / 255;
        }
        if (img.stencil) ((sr = fr), (sg = fg), (sb = fb));
        a *= sa;
        if (a <= 0) continue;
        data[o] += (sr - data[o]) * a;
        data[o + 1] += (sg - data[o + 1]) * a;
        data[o + 2] += (sb - data[o + 2]) * a;
        if (data[o + 3] < 255) data[o + 3] += (255 - data[o + 3]) * a;
      }
    });
  }

  // ---- the content interpreter ----
  /** run a content stream @param {Uint8Array} bytes @param {any} res @param {M} ctm @param {GS} [inherit] */
  function run(bytes, res, ctm, inherit) {
    const budget = src.budget;
    const lx = new Lexer(bytes, budget);
    /** @type {GS} */
    let gs = inherit ? { ...inherit, ctm } : fresh(ctm);
    const runBase = ctm; // patterns are laid out in the space this content stream started in
    /** @type {GS[]} */
    const stack = [];
    /** @type {number[]} */
    let path = [];
    let cx = 0,
      cy = 0,
      sx = 0,
      sy = 0;
    /** @type {boolean | null} a pending W (true: W*) */
    let pendingClip = null;
    let Tm = [1, 0, 0, 1, 0, 0],
      Tlm = Tm;
    /** @type {any[]} */
    let a = [];
    const end = () => {
      if (pendingClip !== null)
        gs.clip = clipOf(toDevice(flatten(path, 0.2 / unit(gs.ctm)), gs.ctm), pendingClip, gs.clip);
      pendingClip = null;
      path = [];
    };
    const setColor = (/** @type {boolean} */ fill, /** @type {any} */ cs, /** @type {number[]} */ c, pat = null) => {
      // a pattern space draws nothing until scn names a pattern
      const none = !cs || (cs.pattern && !pat);
      if (fill) {
        gs.fcs = cs;
        gs.fnone = none;
        gs.fpat = pat;
        if (cs && !cs.pattern) gs.fill = cs.rgb(c);
      } else {
        gs.scs = cs;
        gs.snone = none;
        gs.spat = pat;
        if (cs && !cs.pattern) gs.strokeC = cs.rgb(c);
      }
    };
    const nums = () => a.map((v) => num(R(v), 0));
    /** show a string @param {Uint8Array} b */
    const show = (b) => {
      const f = gs.font;
      if (!f) return;
      const tr = gs.Tr;
      /** @type {ArrayLike<number>[]} */ const polys = [];
      /** glyphs drawn from cached coverage: [entry, device x, device y] @type {any[]} */ const bits = [];
      // a plain fill onto the canvas: glyphs as Path2D [glyph, transform, …]
      const onCanvas = tr === 0 && native() && !gs.fpat && !gs.fnone && (!xfer || !xfer.smask) && clipKnown(gs.clip);
      /** @type {any[]} */ const cvGlyphs = [];
      let held = 0;
      /** @type {number[]} */ const outline = [];
      for (const [c, single] of f.codes(b)) {
        const trm = mul([gs.size * gs.Th, 0, 0, gs.size, 0, gs.Ts], mul(Tm, gs.ctm));
        const g = tr === 3 || tr === 7 ? null : f.glyph(c);
        if (g && g.length) {
          const m = mul([f.fm, 0, 0, f.fm, 0, 0], trm);
          const e = tr === 0 && !onCanvas ? glyphBitmap(g, m) : null;
          if (onCanvas && tr === 0) {
            // the canvas fills the outline itself (its Path2D kept per glyph), charged as its pixels would be
            const em = Math.abs(m[0] * m[3] - m[1] * m[2]);
            src.budget.tick(1 + Math.min(W * H, em) / 16);
            cvGlyphs.push(g, m);
            const sz = 2000 * Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3])); // past any glyph's box
            growBox(m[4] - sz, m[5] - sz, m[4] + sz, m[5] + sz);
          } else if (e) bits.push(e, Math.floor(m[4]), Math.floor(m[5]));
          else if (tr === 0 || tr === 2 || tr === 4 || tr === 6)
            for (const pl of toDevice(flatten(g, 0.2 / unit(m)), m)) (polys.push(pl), (held += pl.length));
          if (tr === 1 || tr === 2 || tr === 5 || tr === 6) {
            const um = mul([f.fm, 0, 0, f.fm, 0, 0], mul([gs.size * gs.Th, 0, 0, gs.size, 0, gs.Ts], Tm));
            for (let i = 0; i < g.length;) {
              const op = g[i++],
                k = op === 0 || op === 1 ? 2 : op === 2 ? 6 : 0;
              outline.push(op);
              for (let j = 0; j < k; j += 2)
                outline.push(
                  um[0] * g[i + j] + um[2] * g[i + j + 1] + um[4],
                  um[1] * g[i + j] + um[3] * g[i + j + 1] + um[5],
                );
              i += k;
            }
          }
        }
        if (outline.length > MAX_PATH) (strokePath(outline, gs), (outline.length = 0));
        budget.tick(g ? 1 + (g.length >> 4) : 0); // each glyph's flattening, drawn or not
        if (polys.length >= 4096 || held > MAX_PATH) {
          held = 0;
          if (!gs.fnone) paint(polys, false, gs.fill, gs.ca, gs.clip, gs.fpat); // painted in batches: a string's glyphs are not all held
          polys.length = 0;
        }
        if (bits.length >= 3 * 4096) {
          if (!gs.fnone) paint(glyphRows(bits), false, gs.fill, gs.ca, gs.clip, gs.fpat);
          bits.length = 0;
        }
        const tx = ((f.width(c) / 1000) * gs.size + gs.Tc + (single && c === 32 ? gs.Tw : 0)) * gs.Th;
        Tm = mul([1, 0, 0, 1, tx, 0], Tm);
        budget.tick();
      }
      if (polys.length && !gs.fnone) paint(polys, false, gs.fill, gs.ca, gs.clip, gs.fpat);
      if (bits.length && !gs.fnone) paint(glyphRows(bits), false, gs.fill, gs.ca, gs.clip, gs.fpat);
      if (cvGlyphs.length) {
        toCanvas();
        cvx.save();
        clipTo(gs.clip);
        cvx.globalAlpha = gs.ca;
        cvx.globalCompositeOperation = GCO[xfer ? xfer.bm : 0] ?? 'source-over';
        const c = gs.fill;
        cvx.fillStyle = `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
        for (let k = 0; k < cvGlyphs.length; k += 2) {
          const m = cvGlyphs[k + 1];
          cvx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
          cvx.fill(glyphPath(cvGlyphs[k]));
        }
        cvx.restore();
      }
      if (outline.length) strokePath(outline, gs);
    };
    for (;;) {
      const v = parseValue(lx);
      if (v === undefined) break;
      if (!(v instanceof Op)) {
        if (a.length < 64) a.push(v);
        continue;
      }
      budget.tick();
      const op = v.v;
      xfer = gs.bm || gs.smask ? gs : null;
      if (path.length > MAX_PATH) fail('E_BUDGET', `A path holds more than ${MAX_PATH.toLocaleString('en')} numbers`);
      try {
        switch (op) {
          case 'q':
            if (stack.length >= MAX_Q) fail('E_BUDGET', `Graphics states nest more than ${MAX_Q} deep (q)`);
            stack.push({ ...gs });
            break;
          case 'Q':
            if (stack.length) gs = /** @type {GS} */ (stack.pop());
            break;
          case 'cm': {
            const m = matrixOf(a);
            if (m) gs.ctm = mul(m, gs.ctm);
            break;
          }
          case 'w':
            gs.lw = Math.abs(num(a[0], 1));
            break;
          case 'J':
            gs.cap = Math.max(0, Math.min(2, num(a[0], 0) | 0));
            break;
          case 'j':
            gs.join = Math.max(0, Math.min(2, num(a[0], 0) | 0));
            break;
          case 'M':
            gs.ml = num(a[0], 10);
            break;
          case 'd':
            gs.dash = Array.isArray(a[0]) ? a[0].slice(0, 64).map((x) => Math.abs(num(R(x), 0))) : [];
            gs.phase = num(a[1], 0);
            break;
          case 'gs': {
            const eg = R(R(res?.get?.('ExtGState'))?.get?.(a[0]));
            if (eg instanceof Map)
              for (const [k, raw] of eg) {
                const x = R(raw);
                if (k === 'LW') gs.lw = Math.abs(num(x, gs.lw));
                else if (k === 'LC') gs.cap = Math.max(0, Math.min(2, num(x, 0) | 0));
                else if (k === 'LJ') gs.join = Math.max(0, Math.min(2, num(x, 0) | 0));
                else if (k === 'ML') gs.ml = num(x, 10);
                else if (k === 'ca') gs.ca = Math.max(0, Math.min(1, num(x, 1)));
                else if (k === 'CA') gs.CA = Math.max(0, Math.min(1, num(x, 1)));
                else if (k === 'D' && Array.isArray(x) && Array.isArray(R(x[0]))) {
                  gs.dash = R(x[0])
                    .slice(0, 64)
                    .map((/** @type {any} */ y) => Math.abs(num(R(y), 0)));
                  gs.phase = num(R(x[1]), 0);
                } else if (k === 'BM') gs.bm = blendOf(x);
                else if (k === 'SMask') gs.smask = x instanceof Map ? maskOf(x, res, gs) : null;
                else if (k === 'Font' && Array.isArray(x)) {
                  const fd = R(x[0]);
                  gs.font = fd instanceof Map ? fontOf(fd) : null;
                  gs.size = num(R(x[1]), 0);
                }
              }
            break;
          }
          case 'm':
            cx = sx = num(a[0], 0);
            cy = sy = num(a[1], 0);
            path.push(0, cx, cy);
            break;
          case 'l':
            cx = num(a[0], 0);
            cy = num(a[1], 0);
            if (!path.length) path.push(0, cx, cy);
            path.push(1, cx, cy);
            break;
          case 'c':
          case 'v':
          case 'y': {
            const n = nums();
            const [x1, y1, x2, y2, x3, y3] =
              op === 'c' ? n : op === 'v' ? [cx, cy, n[0], n[1], n[2], n[3]] : [n[0], n[1], n[2], n[3], n[2], n[3]];
            if (!path.length) path.push(0, cx, cy);
            path.push(2, x1, y1, x2, y2, x3, y3);
            cx = x3;
            cy = y3;
            break;
          }
          case 'h':
            path.push(3);
            cx = sx;
            cy = sy;
            break;
          case 're': {
            const [x, y, w, h] = nums();
            path.push(0, x, y, 1, x + w, y, 1, x + w, y + h, 1, x, y + h, 3);
            cx = sx = x;
            cy = sy = y;
            break;
          }
          case 'S':
            strokePath(path, gs);
            end();
            break;
          case 's':
            path.push(3);
            strokePath(path, gs);
            end();
            break;
          case 'f':
          case 'F':
          case 'f*':
            fillPath(path, gs, op === 'f*');
            end();
            break;
          case 'B':
          case 'B*':
          case 'b':
          case 'b*':
            if (op[0] === 'b') path.push(3);
            fillPath(path, gs, op.endsWith('*'));
            strokePath(path, gs);
            end();
            break;
          case 'n':
            end();
            break;
          case 'W':
          case 'W*':
            pendingClip = op === 'W*';
            break;
          case 'CS':
          case 'cs': {
            const cs = space(a[0], res);
            setColor(op === 'cs', cs, cs === CMYK ? [0, 0, 0, 1] : [0, 0, 0]);
            break;
          }
          case 'SC':
          case 'SCN':
          case 'sc':
          case 'scn': {
            const f = op[0] === 's',
              cs = f ? gs.fcs : gs.scs;
            if (cs?.pattern) {
              const name = a[a.length - 1];
              const comps = a.slice(0, -1).map((v) => num(R(v), 0));
              setColor(f, cs, [], typeof name === 'string' ? patternPaint(name, res, cs, comps, runBase) : null);
            } else if (cs) setColor(f, cs, nums());
            break;
          }
          case 'g':
          case 'G':
            setColor(op === 'g', GRAY, nums());
            break;
          case 'rg':
          case 'RG':
            setColor(op === 'rg', RGB, nums());
            break;
          case 'k':
          case 'K':
            setColor(op === 'k', CMYK, nums());
            break;
          case 'BT':
            Tm = Tlm = [1, 0, 0, 1, 0, 0];
            break;
          case 'Tc':
            gs.Tc = num(a[0], 0);
            break;
          case 'Tw':
            gs.Tw = num(a[0], 0);
            break;
          case 'Tz':
            gs.Th = num(a[0], 100) / 100;
            break;
          case 'TL':
            gs.TL = num(a[0], 0);
            break;
          case 'Ts':
            gs.Ts = num(a[0], 0);
            break;
          case 'Tr':
            gs.Tr = num(a[0], 0) | 0;
            break;
          case 'Tf': {
            const fd = R(R(res?.get?.('Font'))?.get?.(a[0]));
            gs.font = fd instanceof Map ? fontOf(fd) : null;
            gs.size = num(a[1], 0);
            break;
          }
          case 'Td':
          case 'TD':
            if (op === 'TD') gs.TL = -num(a[1], 0);
            Tm = Tlm = mul([1, 0, 0, 1, num(a[0], 0), num(a[1], 0)], Tlm);
            break;
          case 'Tm': {
            const m = matrixOf(a);
            if (m) Tm = Tlm = m;
            break;
          }
          case 'T*':
            Tm = Tlm = mul([1, 0, 0, 1, 0, -gs.TL], Tlm);
            break;
          case 'Tj':
            if (a[0] instanceof PdfString) show(a[0].bytes);
            break;
          case "'":
          case '"':
            if (op === '"') {
              gs.Tw = num(a[0], 0);
              gs.Tc = num(a[1], 0);
            }
            Tm = Tlm = mul([1, 0, 0, 1, 0, -gs.TL], Tlm);
            if (a[a.length - 1] instanceof PdfString) show(a[a.length - 1].bytes);
            break;
          case 'TJ':
            if (Array.isArray(a[0]))
              for (const x of a[0]) {
                if (x instanceof PdfString) show(x.bytes);
                else if (typeof x === 'number') Tm = mul([1, 0, 0, 1, (-x / 1000) * gs.size * gs.Th, 0], Tm);
              }
            break;
          case 'Do': {
            const x = R(R(res?.get?.('XObject'))?.get?.(a[0]));
            if (!(x instanceof PdfStream)) break;
            const st = R(x.dict.get('Subtype'));
            if (st === 'Image') {
              const img = imageOf(x, res);
              if (img) drawImage(img, gs);
            } else if (st === 'Form') form(x, res, gs);
            break;
          }
          case 'BI': {
            /** @type {Map<string, any>} */
            const d = new Map();
            for (let i = 0; i < 200; i++) {
              const k = parseValue(lx);
              if (k === undefined || k instanceof Op) break;
              const val = parseValue(lx);
              if (typeof k === 'string') d.set(k, val);
            }
            const start = lx.pos + 1;
            skipInline(lx);
            const st = new PdfStream(d, new Uint8Array(0), -1, 0);
            const img = imageOf(st, res, lx.buf.subarray(start, Math.max(start, lx.pos - 3)));
            if (img) drawImage(img, gs);
            break;
          }
          case 'sh': {
            // the shading over the clip (its BBox if it has one), in the current space; no Background (as the spec says)
            const obj = R(R(res?.get?.('Shading'))?.get?.(a[0]));
            const sh = obj == null ? null : shadingOf(obj);
            if (!sh) break;
            const b = sh.bbox;
            const mb = sh.tris ? layerFor(sh, gs.ctm).box : null; // a mesh: only where it drew
            const cb = gs.clip ? clipBoxes.get(gs.clip) : null; // otherwise the clip's bounds
            const polys = mb
              ? [[mb[0], mb[1], mb[2], mb[1], mb[2], mb[3], mb[0], mb[3]]]
              : b
                ? toDevice([{ pts: [b[0], b[1], b[2], b[1], b[2], b[3], b[0], b[3]] }], gs.ctm)
                : [cb ? [cb[0], cb[1], cb[2], cb[1], cb[2], cb[3], cb[0], cb[3]] : [0, 0, W, 0, W, H, 0, H]];
            paint(polys, false, gs.fill, gs.ca, gs.clip, { kind: 'shading', obj, m: gs.ctm, background: false });
            break;
          } // marked content needs nothing to draw
        }
      } catch (e) {
        if (stops(e)) throw e;
        // a broken operand or object: that operator draws nothing
      }
      a = [];
    }
  }
  /** draw a form XObject @param {PdfStream} x @param {any} res @param {GS} gs */
  function form(x, res, gs) {
    if (open.has(x) || depth >= MAX_FORMS) return;
    if (++formDraws > MAX_FORM_DRAWS)
      fail('E_BUDGET', `A page draws more than ${MAX_FORM_DRAWS.toLocaleString('en')} form XObjects`);
    const m = matrixOf(R(x.dict.get('Matrix'))) ?? [1, 0, 0, 1, 0, 0];
    const ctm = mul(m, gs.ctm);
    const inner = { ...gs, ctm };
    const bb = R(x.dict.get('BBox'));
    if (Array.isArray(bb) && bb.length >= 4) {
      const [a, b, c, d] = bb.slice(0, 4).map((v) => num(R(v), 0));
      inner.clip = clipOf(toDevice([{ pts: [a, b, c, b, c, d, a, d] }], ctm), false, gs.clip);
    }
    const r2 = R(x.dict.get('Resources'));
    open.add(x);
    depth++;
    try {
      let body = C.content.get(x);
      if (!body) {
        body = src.decodeStream(x).data;
        if ((C.contentBytes += body.length) > MAX_DOC_CONTENT_BYTES)
          (C.content.clear(), (C.contentBytes = body.length));
        C.content.set(x, body);
      }
      const grp = R(x.dict.get('Group'));
      if (grp instanceof Map && R(grp.get('S')) === 'Transparency') {
        // a transparency group: drawn on its own (isolated, as pdf.js), then composited as one object; inside it the
        // blend mode, soft mask and alphas start over. ponytail: knockout and non-isolated groups draw as isolated
        const g = { ...inner, bm: 0, smask: null, ca: 1, CA: 1 };
        // over a layer nothing has drawn into yet (transparent), a plain group is exactly its contents drawn in place
        if (box && box[2] <= box[0] && !gs.bm && !gs.smask && gs.ca >= 1)
          run(/** @type {Uint8Array} */ (body), r2 instanceof Map ? r2 : res, ctm, g);
        else
          layered(gs, gs.ca, () => run(/** @type {Uint8Array} */ (body), r2 instanceof Map ? r2 : res, ctm, g), true);
        xfer = gs.bm || gs.smask ? gs : null;
      } else run(body, r2 instanceof Map ? r2 : res, ctm, inner);
    } finally {
      open.delete(x);
      depth--;
    }
  }
  /** the page's annotation appearances (normal), hidden and no-view ones skipped @param {Map<string, any>} page @param {M} base */
  function annotations(page, base) {
    const list = R(page.get('Annots'));
    if (!Array.isArray(list)) return;
    for (const ref of list.slice(0, 100_000)) {
      try {
        const an = R(ref);
        if (!(an instanceof Map) || R(an.get('Subtype')) === 'Popup') continue;
        if (num(R(an.get('F')), 0) & 34) continue; // Hidden, NoView
        let ap = R(R(an.get('AP'))?.get?.('N'));
        if (ap instanceof Map) ap = R(ap.get(R(an.get('AS'))));
        if (!(ap instanceof PdfStream)) continue;
        const rect = R(an.get('Rect'));
        if (!Array.isArray(rect) || rect.length < 4) continue;
        const [r0, r1, r2, r3] = rect.slice(0, 4).map((v) => num(R(v), 0));
        const rx0 = Math.min(r0, r2),
          ry0 = Math.min(r1, r3),
          rx1 = Math.max(r0, r2),
          ry1 = Math.max(r1, r3);
        const m = matrixOf(R(ap.dict.get('Matrix'))) ?? [1, 0, 0, 1, 0, 0];
        const bb = R(ap.dict.get('BBox'));
        if (!Array.isArray(bb) || bb.length < 4) continue;
        const [b0, b1, b2, b3] = bb.slice(0, 4).map((v) => num(R(v), 0));
        const corners = [
          [b0, b1],
          [b2, b1],
          [b2, b3],
          [b0, b3],
        ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
        const bx0 = Math.min(...corners.map((c) => c[0])),
          bx1 = Math.max(...corners.map((c) => c[0])),
          by0 = Math.min(...corners.map((c) => c[1])),
          by1 = Math.max(...corners.map((c) => c[1]));
        const sx = bx1 > bx0 ? (rx1 - rx0) / (bx1 - bx0) : 1,
          sy = by1 > by0 ? (ry1 - ry0) / (by1 - by0) : 1;
        const A = [sx, 0, 0, sy, rx0 - bx0 * sx, ry0 - by0 * sy];
        form(ap, null, fresh(mul(A, base)));
      } catch (e) {
        if (stops(e)) throw e;
      }
    }
  }
  /** draw a tiling cell's content, clipped to its BBox @param {Uint8Array} bytes @param {any} res @param {M} ctm @param {number[]} bb */
  function cell(bytes, res, ctm, bb) {
    const g = fresh(ctm);
    g.clip = clipOf(toDevice([{ pts: [bb[0], bb[1], bb[2], bb[1], bb[2], bb[3], bb[0], bb[3]] }], ctm), false, null);
    run(bytes, res, ctm, g);
  }
  /** the canvas brought up to date (canvas output) */
  function flush() {
    if (cvx && pixelsNewer) toCanvas();
  }
  return { run, annotations, cell, flush };
}

const clamp1 = (/** @type {number} */ v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const GRAY = { n: 1, rgb: (/** @type {number[]} */ c) => [clamp1(c[0] ?? 0), clamp1(c[0] ?? 0), clamp1(c[0] ?? 0)] };
const RGB = { n: 3, rgb: (/** @type {number[]} */ c) => [clamp1(c[0] ?? 0), clamp1(c[1] ?? 0), clamp1(c[2] ?? 0)] };
/**
 * CMYK → RGB by the polynomial pdf.js fits to a press profile (pdf.js, Apache-2.0, Mozilla Foundation: its
 * DeviceCmykCS coefficients), so CMYK pages look the same in both. ponytail: no ICC; an OutputIntent is ignored
 */
const CMYK = {
  n: 4,
  rgb: (/** @type {number[]} */ v) => {
    const c = clamp1(v[0] ?? 0),
      m = clamp1(v[1] ?? 0),
      y = clamp1(v[2] ?? 0),
      k = clamp1(v[3] ?? 1);
    const r =
      255 +
      c *
        (-4.387332384609988 * c +
          54.48615194189176 * m +
          18.82290502165302 * y +
          212.25662451639585 * k -
          285.2331026137004) +
      m * (1.7149763477362134 * m - 5.6096736904047315 * y - 17.873870861415444 * k - 5.497006427196366) +
      y * (-2.5217340131683033 * y - 21.248923337353073 * k + 17.5119270841813) +
      k * (-21.86122147463605 * k - 189.48180835922747);
    const g =
      255 +
      c *
        (8.841041422036149 * c +
          60.118027045597366 * m +
          6.871425592049007 * y +
          31.159100130055922 * k -
          79.2970844816548) +
      m * (-15.310361306967817 * m + 17.575251261109482 * y + 131.35250912493976 * k - 190.9453302588951) +
      y * (4.444339102852739 * y + 9.8632861493405 * k - 24.86741582555878) +
      k * (-20.737325471181034 * k - 187.80453709719578);
    const b =
      255 +
      c *
        (0.8842522430003296 * c +
          8.078677503112928 * m +
          30.89978309703729 * y -
          0.23883238689178934 * k -
          14.183576799673286) +
      m * (10.49593273432072 * m + 63.02378494754052 * y + 50.606957656360734 * k - 112.23884253719248) +
      y * (0.03296041114873217 * y + 115.60384449646641 * k - 193.58209356861505) +
      k * (-22.33816807309886 * k - 180.12613974708367);
    return [clamp1(r / 255), clamp1(g / 255), clamp1(b / 255)];
  },
};
const SEP = { n: 1, rgb: (/** @type {number[]} */ c) => GRAY.rgb([1 - clamp1(c[0] ?? 1)]) };
/** Symbol / ZapfDingbats code → code point @type {Record<string, number[]>} */
const SYMBOLIC = { Symbol: [], ZapfDingbats: [] };
for (const k of /** @type {const} */ (['Symbol', 'ZapfDingbats']))
  for (let i = 0; i + 1 < ENCODINGS[k].length; i += 2) SYMBOLIC[k][ENCODINGS[k][i + 1]] = ENCODINGS[k][i];
/** WinAnsi code → code point */
const WINANSI = /** @type {number[]} */ ([]);
for (let i = 0; i + 1 < ENCODINGS.WinAnsi.length; i += 2) WINANSI[ENCODINGS.WinAnsi[i + 1]] = ENCODINGS.WinAnsi[i];
/** @type {Record<string, string>} */
const STD = {
  Arial: 'Helvetica',
  ArialMT: 'Helvetica',
  'Arial,Bold': 'Helvetica-Bold',
  'Arial-BoldMT': 'Helvetica-Bold',
  TimesNewRoman: 'Times-Roman',
  TimesNewRomanPSMT: 'Times-Roman',
  CourierNew: 'Courier',
};
