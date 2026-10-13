// @ts-check
/**
 * Rendering (experimental): a page of a loaded document → RGBA pixels, in pure JS (docs/RENDERER.md). The content
 * stream is read with the reader's lexer, streams decoded with its filters, fonts with its sfnt and CFF parsers;
 * the rasterizer (raster.js) fills anti-aliased polygons. Phase 1: paths (fill non-zero / even-odd, stroke with
 * width, caps, joins, miter limit, dashes), the CTM, clipping, Gray / RGB / CMYK / ICCBased / Indexed colour,
 * constant opacity (ca / CA), text with embedded TrueType and CFF fonts (substitute fonts for the standard 14),
 * Flate / LZW / raw images (stencil masks, /SMask, /Decode, 1–16 bits), inline images, form XObjects, and annotation
 * appearance streams (form fields). Not yet: shadings and patterns, transparency groups and soft masks, blend
 * modes, Type 3 and Type 1 fonts, DCT / JPX / JBIG2 / CCITT images, Separation / DeviceN tints, text clipping.
 *
 * HOSTILE input: every operator is a budget step under the document's budget and a time limit, forms nest at most
 * MAX_FORMS deep and never re-enter themselves, the device is at most MAX_SIDE a side and MAX_PIXELS in all, and a
 * broken font or image draws as nothing (a budget error still stops the render).
 */
import { internal, pageAt } from '../reader/pdf.js';
import { Lexer, parseValue, PdfString, PdfStream, Op } from '../reader/lexer.js';
import { decode } from '../reader/filters.js';
import { decodeJpeg } from '../images/jpeg-decode.js';
import { fail } from '../reader/budget.js';
import { skipInline, glyphText } from '../reader/text.js';
import { ENCODINGS, METRICS } from '../fonts/standard-metrics.js';
import { sfntTables, parseFont } from '../fonts/truetype.js';
import { rasterizer, flatten, stroke, dashed } from './raster.js';
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
  MAX_GLYPH_CACHE = 8_000_000;

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
  const pg = pageAt(r, p.index);
  const ms = o.timeoutMs ?? RENDER_TIMEOUT_MS;
  src.budget.within(ms, () => {
    const ctx = painter(src, data, W, H, o.fonts ?? {});
    ctx.run(contentOf(src, pg.dict.get('Contents')), src.resolve(pg.inh.Resources), base);
    if (o.annotations !== false) ctx.annotations(pg.dict, base);
  });
  return { width: W, height: H, data };
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
function painter(src, data, W, H, subs) {
  const R = src.resolve;
  const ras = rasterizer(W, H, (n) => src.budget.tick(n));
  const fonts = new Map(),
    images = new Map(),
    subFonts = new Map();
  /** the open forms (never re-entered) */
  const open = new Set();
  let depth = 0,
    formDraws = 0,
    clipBytes = 0;

  // ---- colour ----
  /** a colour space → { n, rgb(comps) → [r, g, b] 0–1 } or null (a pattern, or one not drawn yet) @param {any} v @param {any} res */
  function space(v, res, d = 0) {
    v = R(v);
    if (typeof v === 'string') {
      if (v === 'DeviceGray' || v === 'G' || v === 'CalGray') return GRAY;
      if (v === 'DeviceRGB' || v === 'RGB' || v === 'CalRGB') return RGB;
      if (v === 'DeviceCMYK' || v === 'CMYK') return CMYK;
      if (v === 'Pattern') return null;
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
    if (k === 'Pattern') return null;
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
    lw: 1,
    cap: 0,
    join: 0,
    ml: 10,
    dash: /** @type {number[]} */ ([]),
    phase: 0,
    ca: 1,
    CA: 1,
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

  /** composite polygons in one colour @param {ArrayLike<number>[]} polys @param {boolean} eo @param {number[]} rgb @param {number} alpha @param {Uint8Array | null} clip */
  function paint(polys, eo, rgb, alpha, clip) {
    const r = rgb[0] * 255,
      g = rgb[1] * 255,
      b = rgb[2] * 255;
    ras.fill(polys, eo, (y, xa, xb, cov) => {
      let o = (y * W + xa) * 4;
      for (let x = xa; x < xb; x++, o += 4) {
        let a = cov[x] * alpha;
        if (clip) a *= clip[y * W + x] / 255;
        if (a <= 0) continue;
        if (a >= 1) {
          data[o] = r;
          data[o + 1] = g;
          data[o + 2] = b;
        } else {
          data[o] += (r - data[o]) * a;
          data[o + 1] += (g - data[o + 1]) * a;
          data[o + 2] += (b - data[o + 2]) * a;
        }
        if (data[o + 3] < 255) data[o + 3] += (255 - data[o + 3]) * a;
      }
    });
  }
  /** a clip mask: the old one (or none) times the polygons' coverage @param {ArrayLike<number>[]} polys @param {boolean} eo @param {Uint8Array | null} old */
  function clipOf(polys, eo, old) {
    if ((clipBytes += W * H) > MAX_CLIP_BYTES)
      fail('E_BUDGET', `A page's clipping needs more than ${MAX_CLIP_BYTES.toLocaleString('en')} bytes of masks`);
    src.budget.tick(1 + ((W * H) >> 10)); // the mask's allocation and clearing
    const m = new Uint8Array(W * H);
    ras.fill(polys, eo, (y, xa, xb, cov) => {
      for (let x = xa; x < xb; x++) m[y * W + x] = old ? (cov[x] * old[y * W + x] + 0.5) | 0 : (cov[x] * 255 + 0.5) | 0;
    });
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
    if (gs.fnone) return;
    paint(toDevice(flatten(path, 0.2 / unit(gs.ctm)), gs.ctm), eo, gs.fill, gs.ca, gs.clip);
  }
  /** stroke a path (user space) @param {number[]} path @param {GS} gs */
  function strokePath(path, gs) {
    if (gs.snone) return;
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
      const s = substitute(base);
      if (s) {
        fm = s.fm;
        const sym = base === 'Symbol' || base === 'ZapfDingbats';
        glyph = (c) => (sym ? null : cached(s.sfnt.glyphFor(uniOf(c)), s.glyph));
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
    if (!raw) images.set(st, img);
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
    ras.fill(quad, false, (y, xa, xb, cov) => {
      let o = (y * W + xa) * 4;
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
    const setColor = (/** @type {boolean} */ fill, /** @type {any} */ cs, /** @type {number[]} */ c) => {
      if (fill) {
        gs.fcs = cs;
        gs.fnone = !cs;
        if (cs) gs.fill = cs.rgb(c);
      } else {
        gs.scs = cs;
        gs.snone = !cs;
        if (cs) gs.strokeC = cs.rgb(c);
      }
    };
    const nums = () => a.map((v) => num(R(v), 0));
    /** show a string @param {Uint8Array} b */
    const show = (b) => {
      const f = gs.font;
      if (!f) return;
      const tr = gs.Tr;
      /** @type {ArrayLike<number>[]} */ const polys = [];
      let held = 0;
      /** @type {number[]} */ const outline = [];
      for (const [c, single] of f.codes(b)) {
        const trm = mul([gs.size * gs.Th, 0, 0, gs.size, 0, gs.Ts], mul(Tm, gs.ctm));
        const g = tr === 3 || tr === 7 ? null : f.glyph(c);
        if (g && g.length) {
          const m = mul([f.fm, 0, 0, f.fm, 0, 0], trm);
          if (tr === 0 || tr === 2 || tr === 4 || tr === 6)
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
          if (!gs.fnone) paint(polys, false, gs.fill, gs.ca, gs.clip); // painted in batches: a string's glyphs are not all held
          polys.length = 0;
        }
        const tx = ((f.width(c) / 1000) * gs.size + gs.Tc + (single && c === 32 ? gs.Tw : 0)) * gs.Th;
        Tm = mul([1, 0, 0, 1, tx, 0], Tm);
        budget.tick();
      }
      if (polys.length && !gs.fnone) paint(polys, false, gs.fill, gs.ca, gs.clip);
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
                } else if (k === 'Font' && Array.isArray(x)) {
                  const fd = R(x[0]);
                  gs.font = fd instanceof Map ? fontOf(fd) : null;
                  gs.size = num(R(x[1]), 0);
                }
              } // ponytail: SMask, BM and transparency groups are phase 2
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
            if (cs) setColor(f, cs, nums());
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
          } // ponytail: sh (shadings) and patterns are phase 2; marked content needs nothing to draw
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
      run(src.decodeStream(x).data, r2 instanceof Map ? r2 : res, ctm, inner);
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
  return { run, annotations };
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
