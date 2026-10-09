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
import { num } from '../core/serialize.js';
import { deflate } from '../core/deflate.js';
import { brand, unbrand } from '../core/brand.js';
import { toBytes } from '../standards/icc.js';
import { checkDevice, DEVICE } from '../graphics/color.js';
import { gstate, mul, matrix, transparent } from '../graphics/draw.js';
import { isPng, readPng, decodePng, filterRows } from './png.js';
import { isJpeg, readJpeg } from './jpeg.js';
import { refuseInA1 } from '../standards/level.js';

const MAX_INPUT = 256 << 20;
/** EXIF orientation 1–8 → the matrix that turns the stored image upright in the unit square (PDF image space) */
const ORIENT = [null, [1, 0, 0, 1, 0, 0], [-1, 0, 0, 1, 1, 0], [-1, 0, 0, -1, 1, 1], [1, 0, 0, -1, 0, 1],
  [0, -1, -1, 0, 1, 1], [0, -1, 1, 0, 0, 1], [0, 1, 1, 0, 0, 0], [0, 1, -1, 0, 1, 0]];

/**
 * @param {any} doc @param {any} bytes a JPEG or PNG @param {{ colorSpace?: any }} [o] colorSpace: an ICC colour space
 * (pdf.iccColorSpace) to tag the image with instead of the device space (same number of components)
 */
export async function embedImage(doc, bytes, o = {}) {
  const b = toBytes(bytes, 'embedImage');
  if (b.length > MAX_INPUT) throw new RangeError(`embedImage: at most ${MAX_INPUT >> 20} MB`);
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
    out.push([ref, `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace ${space(j.comps)} /BitsPerComponent 8 /Filter /DCTDecode${decode} >>`, b]);
  } else if (isPng(b)) {
    const p = decodePng(readPng(b));
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
    const [[data, dp], a] = await Promise.all([ // colour and alpha compress side by side
      p.filtered ? [p.data, parms(ch, p.bpc)] : encode(p.data, h, rb, bpp, parms(ch, p.bpc)),
      p.alpha ? encode(p.alpha, h, arb, Math.max(1, abpc >> 3), parms(1, abpc)) : null,
    ]);
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
 * Deflate decoded rows with the PNG predictor; a small image (≤ 256 KB) is also tried without it, and the smaller
 * (counting the /DecodeParms it needs) is kept. @param {Uint8Array} px @param {number} rows @param {number} rb
 * @param {number} bpp @param {string} dp its /DecodeParms entry @returns {Promise<[Uint8Array, string]>}
 */
async function encode(px, rows, rb, bpp, dp) {
  if (px.length > 256 << 10) return [await deflate(filterRows(px, rows, rb, bpp)), dp];
  const [f, plain] = await Promise.all([deflate(filterRows(px, rows, rb, bpp)), deflate(px)]); // on zlib's thread pool, side by side
  return plain.length <= f.length + dp.length ? [plain, ''] : [f, dp];
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
