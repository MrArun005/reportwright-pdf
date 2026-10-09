// @ts-check
/**
 * Images: `await pdf.embedImage(bytes)` writes a JPEG (DCTDecode passthrough, jpeg.js) or PNG (png.js) as an image
 * XObject right away and returns a branded handle; `page.image(img, { x, y, width, height, fit, opacity, alt })`
 * draws it with `Do`. However often an image is drawn, it is written once (one XObject, one resource name).
 * Images are always XObjects, never inline (BI … EI): an inline image is repeated in every content stream that draws
 * it and cannot carry an /SMask.
 *
 * Handles (core/brand.js): the XObject's number, size, orientation and transparency live in the brand's private data;
 * the handle's own width/height are only for the caller.
 */
import { builtin } from '../core/lazy.js';
import { num } from '../core/serialize.js';
import { deflate, deflateStream } from '../core/deflate.js';
import { brand, unbrand } from '../core/brand.js';
import { toBytes } from '../standards/icc.js';
import { checkDevice, DEVICE } from '../graphics/color.js';
import { gstate, mul, matrix, transparent } from '../graphics/draw.js';
import { isPng, readPng, decodePng, filterRow, MAX_DECODED } from './png.js';
import { isJpeg, readJpeg } from './jpeg.js';
import { refuseInA1 } from '../standards/level.js';

const MAX_INPUT = 256 << 20;
/** EXIF orientation 1–8 → the matrix that turns the stored image upright in the unit square (PDF image space) */
const ORIENT = [null, [1, 0, 0, 1, 0, 0], [-1, 0, 0, 1, 1, 0], [-1, 0, 0, -1, 1, 1], [1, 0, 0, -1, 0, 1],
  [0, -1, -1, 0, 1, 1], [0, -1, 1, 0, 0, 1], [0, 1, 1, 0, 0, 0], [0, 1, -1, 0, 1, 0]];

/**
 * @param {any} doc @param {any} bytes a JPEG or PNG @param {{ colorSpace?: any, maxDecodedBytes?: number, compression?: 'default' | 'fast' | number }} [opt]
 * colorSpace: an ICC colour space (pdf.iccColorSpace) to tag the image with instead of the device space (same number of
 * components); maxDecodedBytes: the decoded size a PNG that must be decoded (alpha, interlacing) may have (64 MB)
 */
export async function embedImage(doc, bytes, opt = {}) {
  const b = toBytes(bytes, 'embedImage');
  const own = (/** @type {string} */ k) => (opt != null && Object.hasOwn(opt, k) ? /** @type {any} */ (opt)[k] : undefined);
  const o = { colorSpace: own('colorSpace'), maxDecodedBytes: own('maxDecodedBytes') ?? MAX_DECODED, compression: own('compression') ?? 'default' };
  if (!(o.compression === 'default' || o.compression === 'fast' || (Number.isInteger(o.compression) && o.compression >= 1 && o.compression <= 9))) throw new TypeError("embedImage: compression is 'default', 'fast' or a zlib level 1–9");
  if (!(Number.isSafeInteger(o.maxDecodedBytes) && o.maxDecodedBytes > 0)) throw new TypeError('embedImage: maxDecodedBytes is a whole number of bytes > 0');
  if (b.length > MAX_INPUT) throw new RangeError(`embedImage: at most ${MAX_INPUT >> 20} MB`);
  // the same bytes and options in the same document: the same handle and XObject (written once)
  let seen = SEEN.get(doc);
  if (!seen) SEEN.set(doc, (seen = new Map()));
  const { key, copy } = await digest(b);
  const k = `${key} ${o.colorSpace == null ? '-' : idOf(o.colorSpace)} ${o.maxDecodedBytes} ${o.compression}`;
  const hit = seen.get(k);
  if (hit && (!hit.copy || same(hit.copy, b))) return hit.img;
  const img = embed(doc, b, o);
  if (!hit) seen.set(k, { img, copy });
  img.catch(() => { if (seen.get(k)?.img === img) seen.delete(k); }); // a failure is not remembered
  return img;
}

/** per document: digest + options → { img: the handle's promise, copy: the bytes, kept only with the fallback hash } */
const SEEN = /** @type {WeakMap<any, Map<string, { img: Promise<any>, copy: Uint8Array | null }>>} */ (new WeakMap());
const IDS = /** @type {WeakMap<object, number>} */ (new WeakMap());
let nextId = 0;
const idOf = (/** @type {any} */ v) => (v !== null && typeof v === 'object' ? (IDS.get(v) ?? (IDS.set(v, ++nextId), nextId)) : `?${String(v)}`);

/** sha256 (node:crypto, else WebCrypto); with neither, a fast 64-bit hash and a copy of the bytes to confirm a hit @param {Uint8Array} b */
async function digest(b) {
  const C = builtin('node:crypto');
  if (C) return { key: C.createHash('sha256').update(b).digest('hex'), copy: null };
  const subtle = globalThis.crypto?.subtle;
  if (subtle) return { key: Array.from(new Uint8Array(await subtle.digest('SHA-256', b.slice())), (x) => x.toString(16).padStart(2, '0')).join(''), copy: null };
  let h1 = 0x811c9dc5, h2 = 0x9747b28c; // ponytail: FNV-1a + a multiply mix; collisions are caught by the byte compare
  for (let i = 0; i < b.length; i++) { h1 = Math.imul(h1 ^ b[i], 0x01000193); h2 = Math.imul(h2 ^ b[i], 0x5bd1e995) ^ (h2 >>> 15); }
  return { key: `f${b.length}:${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`, copy: b.slice() };
}
/** @param {Uint8Array} a @param {Uint8Array} b */
const same = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

/** @param {any} doc @param {Uint8Array} b @param {{ colorSpace: any, maxDecodedBytes: number, compression: 'default' | 'fast' | number }} o */
async function embed(doc, b, o) {
  /** @param {number} n components @returns {string} the colour space for n components (PDF/A-checked) */
  const space = (n) => {
    if (o.colorSpace != null) {
      const icc = unbrand(o.colorSpace, 'icc', doc, 'ICC colour space (pdf.iccColorSpace)');
      if (icc.n !== n) throw new TypeError(`embedImage: the image has ${n} colour components, the ICC colour space ${icc.n}`);
      return icc.cs;
    }
    checkDevice(doc, DEVICE[n]);
    return DEVICE[n];
  };
  const ref = doc.reserve();
  /** @type {[number, string, Uint8Array][]} objects to write: number, dictionary, filtered bytes */
  const out = [];
  let w, h, orientation = 1, alpha = false;
  if (isJpeg(b)) {
    const j = readJpeg(b);
    ({ w, h, orientation } = j);
    const decode = j.comps === 4 && j.adobe ? ' /Decode [1 0 1 0 1 0 1 0]' : '';
    out.push([ref, `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace ${space(j.comps)} /BitsPerComponent 8 /Filter /DCTDecode${decode} >>`, b.subarray(0, j.end)]); // nothing after its EOI
  } else if (isPng(b)) {
    const p = await decodePng(readPng(b), o.maxDecodedBytes);
    ({ w, h } = p);
    let cs;
    if (p.space === 'indexed') {
      const pal = /** @type {Uint8Array} */ (p.palette), n = 1 << p.bpc; // padded: every index is defined
      let hex = '';
      for (let i = 0; i < n * 3; i++) hex += (i < pal.length ? pal[i] : 0).toString(16).padStart(2, '0');
      cs = `[/Indexed ${space(3)} ${n - 1} <${hex}>]`;
    } else cs = space(p.colors);
    const ch = p.space === 'rgb' ? 3 : 1, rb = Math.ceil((w * ch * p.bpc) / 8), bpp = Math.max(1, (ch * p.bpc) >> 3);
    const parms = (/** @type {number} */ colors, /** @type {number} */ bpc) => ` /DecodeParms << /Predictor 15${colors !== 1 ? ` /Colors ${colors}` : ''}${bpc !== 8 ? ` /BitsPerComponent ${bpc}` : ''} /Columns ${w} >>`;
    const abpc = p.abpc, arb = (w * abpc) >> 3;
    /** @type {[Uint8Array, string]} */
    let color, a = null;
    if (p.filtered) color = [p.data, parms(ch, p.bpc)];
    else { // decoded a row at a time; colour and alpha compress side by side as the rows come
      // zlib level: 6, or 3 above 2 MP, where 6 costs ~2× the time for ~2–3% smaller (the deflate is the critical path)
      const lv = o.compression === 'fast' ? 1 : o.compression === 'default' ? (w * h > 2e6 ? 3 : 6) : o.compression;
      const ce = encoder(h, rb, bpp, parms(ch, p.bpc), lv), ae = p.alpha ? encoder(h, arb, Math.max(1, abpc >> 3), parms(1, abpc), lv) : null;
      try {
        await p.rows(async (c, al) => { await Promise.all([ce.row(c), ae && al ? ae.row(al) : null]); });
        [color, a] = await Promise.all([ce.end(), ae ? ae.end() : null]);
      } catch (e) { ce.abort(); ae?.abort(); throw e; }
    }
    const [data, dp] = color;
    let smask = '';
    if (a) refuseInA1(doc, 'embedImage: an image with transparency (an alpha channel)', 'forbids soft masks (transparency); flatten the image onto its background first');
    if (p.bpc === 16 || p.abpc === 16) refuseInA1(doc, 'embedImage: a 16-bit image', 'is PDF 1.4, which has 8 bits a component at most');
    if (a) {
      const sm = doc.reserve();
      out.push([sm, `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent ${abpc} /Filter /FlateDecode${a[1]} >>`, a[0]]);
      smask = ` /SMask ${sm} 0 R`;
      alpha = true;
    }
    const mask = p.mask ? ` /Mask [${p.mask.join(' ')}]` : '';
    out.push([ref, `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace ${cs} /BitsPerComponent ${p.bpc} /Filter /FlateDecode${dp}${smask}${mask} >>`, data]);
  } else throw new TypeError('embedImage: not a JPEG or PNG file');
  await doc.serial(async () => { for (const [n, dict, data] of out) await doc.write(n, dict, data); });
  const turned = orientation >= 5;
  return brand(Object.freeze({ type: 'image', width: turned ? h : w, height: turned ? w : h }), 'image', doc,
    { ref, w: turned ? h : w, h: turned ? w : h, orient: ORIENT[orientation], alpha });
}

/**
 * Rows → a FlateDecode stream with the PNG predictor, each row filtered as it comes and deflated a strip (~1 MB) at a
 * time; a small image (≤ 256 KB) is also tried without the predictor, and the smaller (counting the /DecodeParms it
 * needs) is kept. row(r) copies r. @param {number} rows @param {number} rb @param {number} bpp @param {string} dp its /DecodeParms entry @param {number} level zlib 1–9
 * @returns {{ row(r: Uint8Array): Promise<void>, end(): Promise<[Uint8Array, string]>, abort(): void }}
 */
function encoder(rows, rb, bpp, dp, level) {
  const z = deflateStream(level), per = Math.max(1, Math.floor((1 << 20) / (rb + 1))), t = new Uint8Array(rb);
  const plain = rows * rb <= 256 << 10 ? new Uint8Array(rows * rb) : null;
  // two strips: one fills while the stream reads the other
  const strips = [new Uint8Array(per * (rb + 1)), new Uint8Array(per * (rb + 1))], busy = [Promise.resolve(), Promise.resolve()];
  let s = 0, strip = strips[0], k = 0, y = 0;
  const prev = new Uint8Array(rb);
  return {
    async row(r) {
      filterRow(r, y ? prev : null, bpp, strip, k * (rb + 1), t);
      prev.set(r);
      if (plain) plain.set(r, y * rb);
      y++;
      if (++k === per) { busy[s] = z.push(strip); s ^= 1; k = 0; await busy[s]; strip = strips[s]; }
    },
    async end() {
      if (k) await z.push(strip.subarray(0, k * (rb + 1)));
      await busy[s ^ 1];
      const f = await z.end();
      if (!plain) return [f, dp];
      const p = await deflate(plain, level);
      return p.length <= f.length + dp.length ? [p, ''] : [f, dp];
    },
    abort: () => z.abort(),
  };
}

/**
 * Draw an image in the box (x, y, width, height) (top-left, y down). Only width or height: the other keeps the
 * aspect ratio; neither: its size in pixels as points. fit: 'fill' (stretch, default), 'contain' (all of it, centred),
 * 'cover' (fill the box, centred, cut to it). alt: tagged PDFs make it a Figure; without alt it is an artifact.
 * @this {any} @param {any} img @param {{ x?: number, y?: number, width?: number, height?: number, fit?: 'fill' | 'contain' | 'cover', opacity?: number, alt?: string }} [o]
 */
export function image(img, o = {}) {
  const page = this, doc = page.doc.base ?? page.doc;
  const d = unbrand(img, 'image', doc, 'image (pdf.embedImage)');
  const x = o.x ?? 0, y = o.y ?? 0;
  for (const v of [x, y, o.width ?? 1, o.height ?? 1]) num(v);
  if ((o.width != null && !(o.width > 0)) || (o.height != null && !(o.height > 0))) throw new RangeError('page.image: width and height are > 0');
  const W = o.width ?? (o.height != null ? (o.height * d.w) / d.h : d.w), H = o.height ?? (o.width != null ? (o.width * d.h) / d.w : d.h);
  const fit = o.fit ?? 'fill';
  if (fit !== 'fill' && fit !== 'contain' && fit !== 'cover') throw new TypeError(`page.image: fit is 'fill', 'contain' or 'cover', not ${JSON.stringify(fit)}`);
  let dw = W, dh = H;
  if (fit !== 'fill') { const s = (fit === 'contain' ? Math.min : Math.max)(W / d.w, H / d.h); dw = d.w * s; dh = d.h * s; }
  const dx = x + (W - dw) / 2, dy = y + (H - dh) / 2;
  if (this.doc.tagged && o.alt != null && !(typeof o.alt === 'string' && o.alt.trim())) throw new TypeError('page.image: alt is a non-empty string');
  const gs = gstate(page, { opacity: o.opacity });
  if (d.alpha) transparent(page);
  const name = page.doc.resource('XObject', `${d.ref} 0 R`);
  const m = matrix(mul(d.orient, [dw, 0, 0, dh, dx, page.height - dy - dh]));
  const clip = fit === 'cover' ? `${num(x)} ${num(page.height - y - H)} ${num(W)} ${num(H)} re W n ` : '';
  const draw = () => page.content.op(`q ${gs.trim()}${gs ? ' ' : ''}${clip}${m} cm /${name} Do Q`);
  if (o.alt != null && page.doc.tagged) page.tag('Figure', draw, { alt: o.alt }); else draw();
  return page;
}
