// @ts-check
/**
 * Colours as their operators. Device colours: a gray level 0–1 → "v g"; '#rgb', '#rrggbb', 'rgb(255, 0, 0)',
 * 'rgb(100% 0% 0%)', [r, g, b] (0–1) → "r g b rg"; cmyk(c, m, y, k) or [c, m, y, k] (0–1) → "c m y k k".
 * Colour spaces (branded handles, core/brand.js): a spot colour (pdf.spotColor: Separation with a tint transform to a
 * device alternate) and ICC-based colours (pdf.iccColorSpace(profile).color(...)) → "/CS1 cs 0.5 scn", the space
 * registered with doc.resource('ColorSpace', …). Their colour space arrays are built here from checked parts only
 * (pdfName, num, object numbers) and kept in the brand's private data, never read from the handle.
 *
 * PDF/A (ISO 19005-2, 6.2.4.3): device colour must match the output intent. With an RGB intent DeviceCMYK is refused;
 * with a CMYK intent DeviceRGB is refused (DeviceGray is fine with either). Spot alternates follow the same rule.
 */
import { num, pdfName } from '../core/serialize.js';
import { brand, kindOf, unbrand } from '../core/brand.js';
import { parseIcc } from '../standards/icc.js';

/** @typedef {{ cs: string, comps: number[] }} Resolved  cs: '/DeviceGray' | '/DeviceRGB' | '/DeviceCMYK' | '[/Separation …]' | '[/ICCBased n 0 R]' */

/** @type {Record<number, string>} */
export const DEVICE = { 1: '/DeviceGray', 3: '/DeviceRGB', 4: '/DeviceCMYK' };
const unit = (/** @type {any} */ v) => typeof v === 'number' && v >= 0 && v <= 1;
const CSS_RGB = /^rgb\(\s*(\d{1,3}(?:\.\d+)?%?)\s*(?:,\s*|\s+)(\d{1,3}(?:\.\d+)?%?)\s*(?:,\s*|\s+)(\d{1,3}(?:\.\d+)?%?)\s*\)$/i;

/** cmyk(c, m, y, k), each 0–1: a CMYK colour (a frozen [c, m, y, k]) @param {number} c @param {number} m @param {number} y @param {number} k */
export function cmyk(c, m, y, k) {
  const v = [c, m, y, k];
  if (!v.every(unit)) throw new RangeError(`cmyk(c, m, y, k): each is 0–1, not ${v.join(', ')}`);
  return Object.freeze(v);
}

/** the document (a pattern cell's page has a stand-in for it) @param {any} doc */
const base = (doc) => doc?.base ?? doc;

/** PDF/A: throws when this device space does not match the output intent @param {any} doc @param {string} cs */
export function checkDevice(doc, cs) {
  const d = base(doc);
  if (!d?.pdfa) return;
  const intent = d.outputIntent ?? 'RGB';
  if (cs === DEVICE[4] && intent !== 'CMYK') throw new TypeError('PDF/A: CMYK colour (DeviceCMYK) needs a CMYK output intent: createPdf(sink, { pdfa: { outputIntent: cmykProfileBytes } }). Or use RGB, an ICC-based colour, or a spot colour with an RGB alternate');
  if (cs === DEVICE[3] && intent === 'CMYK') throw new TypeError('PDF/A: with a CMYK output intent, RGB colour (DeviceRGB) is not allowed; use CMYK, gray, an ICC-based colour or a spot colour with a CMYK alternate');
}

/** A device colour (gray, RGB, CMYK) as { cs, comps }, or null when c is none @param {any} c @returns {Resolved | null} */
export function device(c) {
  if (typeof c === 'number') { if (!unit(c)) throw new RangeError(`A gray level is 0–1, not ${c}`); return { cs: DEVICE[1], comps: [c] }; }
  if (Array.isArray(c) && (c.length === 3 || c.length === 4) && c.every(unit)) return { cs: DEVICE[c.length], comps: [...c] };
  if (typeof c === 'string' && c.length <= 64) {
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) {
      const h = c.length === 4 ? [...c.slice(1)].map((x) => x + x).join('') : c.slice(1);
      return { cs: DEVICE[3], comps: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) };
    }
    const m = CSS_RGB.exec(c);
    if (m) {
      const comps = m.slice(1).map((s) => (s.endsWith('%') ? Number(s.slice(0, -1)) / 100 : Number(s) / 255));
      if (comps.every(unit)) return { cs: DEVICE[3], comps };
      throw new RangeError(`rgb(): each is 0–255 or 0%–100%, in ${JSON.stringify(c)}`);
    }
  }
  return null;
}

/** Any colour as { cs, comps }, the PDF/A rules checked. @param {any} c @param {any} doc the page's document (or a cell's stand-in) @returns {Resolved} */
export function resolve(c, doc) {
  const d = device(c);
  if (d) { checkDevice(doc, d.cs); return d; }
  const k = kindOf(c);
  if (k === 'spot' || k === 'color') return unbrand(c, k, base(doc), 'colour (pdf.spotColor / pdf.iccColorSpace)');
  throw new TypeError(`Not a colour: ${JSON.stringify(c)} (use '#rrggbb', 'rgb(r, g, b)', [r, g, b] or cmyk(c, m, y, k) in 0–1, a gray level 0–1, a spot colour or an ICC colour)`);
}

/**
 * The operator that sets a fill (or stroke) colour. @param {any} c @param {boolean} stroke @param {any} [doc] the page's
 * document: needed for spot and ICC colours and the PDF/A checks @returns {string}
 */
export function colorOp(c, stroke, doc) {
  const { cs, comps } = resolve(c, doc);
  const v = comps.map(num).join(' ');
  if (cs === DEVICE[1]) return `${v} ${stroke ? 'G' : 'g'}`;
  if (cs === DEVICE[3]) return `${v} ${stroke ? 'RG' : 'rg'}`;
  if (cs === DEVICE[4]) return `${v} ${stroke ? 'K' : 'k'}`;
  const name = doc.resource('ColorSpace', cs);
  return stroke ? `/${name} CS ${v} SCN` : `/${name} cs ${v} scn`;
}

/** @type {WeakMap<object, Map<string, string>>} each document's spot colours: name → colour space */
const spots = new WeakMap();

/**
 * A spot colour (Separation): its name (a PDF name: characters other than A–Z a–z 0–9 _ . + - become '-') and the
 * device colour (gray, RGB or CMYK) that stands in for it at full tint. One name, one definition per document.
 * @param {any} doc @param {string} name @param {any} alternate @returns {any} a handle: as a colour, full tint; .tint(t) a tint 0–1
 */
export function spotColor(doc, name, alternate) {
  if (typeof name !== 'string' || !name || name.length > 127) throw new TypeError('spotColor(name, alternate): name is a string of 1–127 characters');
  const alt = device(alternate);
  if (!alt) throw new TypeError(`spotColor: the alternate is a device colour (gray, '#rrggbb', [r, g, b], cmyk(c, m, y, k)), not ${JSON.stringify(alternate)}`);
  checkDevice(doc, alt.cs);
  const pn = pdfName(name);
  const white = alt.comps.length === 4 ? '0 0 0 0' : alt.comps.map(() => '1').join(' ');
  const cs = `[/Separation ${pn} ${alt.cs} << /FunctionType 2 /Domain [0 1] /C0 [${white}] /C1 [${alt.comps.map(num).join(' ')}] /N 1 >>]`;
  let m = spots.get(doc);
  if (!m) spots.set(doc, m = new Map());
  if (m.has(pn) && m.get(pn) !== cs) throw new TypeError(`spotColor: ${pn} is already defined with another alternate in this PDF (one name, one definition)`);
  m.set(pn, cs);
  const tint = (/** @type {number} */ t) => {
    if (!unit(t)) throw new RangeError(`A tint is 0–1, not ${t}`);
    return brand(Object.freeze({ type: 'color' }), 'color', doc, { cs, comps: [t] });
  };
  return brand(Object.freeze({ type: 'spot', name, tint }), 'spot', doc, { cs, comps: [1] });
}

/**
 * An ICC-based colour space from a profile (gray, RGB or CMYK; checked by standards/icc.js). Its stream is written now.
 * @param {any} doc @param {any} bytes @returns {Promise<any>} a handle: .color(...components) (each 0–1), .components
 */
export async function iccColorSpace(doc, bytes) {
  const icc = parseIcc(bytes, 'iccColorSpace');
  const ref = doc.reserve();
  await doc.serial(() => doc.writeStream(ref, `<< /N ${icc.n} >>`, icc.bytes));
  const cs = `[/ICCBased ${ref} 0 R]`;
  const color = (/** @type {number[]} */ ...v) => {
    if (v.length !== icc.n || !v.every(unit)) throw new RangeError(`This ICC colour space takes ${icc.n} components, each 0–1, not ${v.join(', ')}`);
    return brand(Object.freeze({ type: 'color' }), 'color', doc, { cs, comps: v });
  };
  return brand(Object.freeze({ type: 'iccColorSpace', components: icc.n, color }), 'icc', doc, { cs, n: icc.n });
}
