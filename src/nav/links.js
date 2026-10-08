// @ts-check
/**
 * Page method: a link annotation over a box, to a URL, to a page with a fit (which may not exist yet: its destination
 * is written when that page's height is known, else at the end), to a named destination, or one of the four named
 * navigation actions. Highlight mode, border style and colour, quad points. Tagged, the link gets a Link structure
 * element.
 *
 * SECURITY: a library that writes PDFs must not be a vector for active content. There is no way to write a
 * JavaScript, Launch, GoToR, GoToE, SubmitForm, ImportData or any other action: targets are checked against the forms
 * above and anything else throws. URLs: http, https and mailto only (allowSchemes widens that, never to javascript:,
 * vbscript:, data: or file:), no control characters, normalised by the WHATWG URL parser, percent-encoded, written as
 * a hex string.
 */
import { ascii, num, text as pdfText } from '../core/serialize.js';
import { device, checkDevice } from '../graphics/color.js';
import { pageIndex, fitOf, destArray, namedDests } from './dest.js';

const NEVER = new Set(['javascript', 'vbscript', 'data', 'file']);
const DEFAULT_SCHEMES = ['http', 'https', 'mailto'];
const ACTIVE = /^(javascript|js|launch|file|gotor|gotoe|submit|submitform|importdata|resetform|action|actions|rendition|movie|sound|hide|setocgstate|trans|goto3dview|richmediaexecute)$/i;
const NAMED = ['NextPage', 'PrevPage', 'FirstPage', 'LastPage'];
const MAX_URL = 32_768, MAX_QUADS = 10_000;
const HIGHLIGHT = { none: 'N', invert: 'I', outline: 'O', push: 'P' };
const BORDER = { solid: 'S', dashed: 'D', beveled: 'B', inset: 'I', underline: 'U' };

/**
 * A URL as written: checked, normalised and percent-encoded (see SECURITY above). @param {any} raw @param {any} allow @param {string} who
 */
export function checkUrl(raw, allow, who) {
  if (typeof raw !== 'string') throw new TypeError(`${who}: url is a string`);
  if (raw.length > MAX_URL) throw new RangeError(`${who}: a URL is at most ${MAX_URL} characters`);
  if (/[\x00-\x1f\x7f]/.test(raw)) throw new TypeError(`${who}: the URL has a control character (refused: browsers drop them, which hides schemes like java\\tscript:)`);
  const s = raw.replace(/^ +| +$/g, '');
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  if (!m) throw new TypeError(`${who}: the URL needs a scheme (https:, http: or mailto:), not ${JSON.stringify(s.slice(0, 80))}`);
  const scheme = m[1].toLowerCase();
  if (NEVER.has(scheme)) throw new TypeError(`${who}: ${scheme}: URLs are never written (active content or local files)`);
  const ok = [...DEFAULT_SCHEMES];
  if (allow != null) {
    if (!Array.isArray(allow) || allow.length > 64) throw new TypeError(`${who}: allowSchemes is an array of scheme names`);
    for (const a of allow) {
      if (typeof a !== 'string' || !/^[a-z][a-z0-9+.-]{0,31}$/i.test(a)) throw new TypeError(`${who}: allowSchemes: ${JSON.stringify(a)} is not a scheme name`);
      if (NEVER.has(a.toLowerCase())) throw new TypeError(`${who}: allowSchemes cannot allow ${a}: (javascript:, vbscript:, data: and file: are never written)`);
      ok.push(a.toLowerCase());
    }
  }
  if (!ok.includes(scheme)) throw new TypeError(`${who}: ${scheme}: URLs are not allowed (http, https and mailto are; widen with { allowSchemes: ['${scheme}'] })`);
  let u;
  try { u = new URL(s); } catch { throw new TypeError(`${who}: not a valid URL: ${JSON.stringify(s.slice(0, 80))}`); }
  if (u.protocol !== `${scheme}:`) throw new TypeError(`${who}: the URL's scheme changed when normalised`);
  return u.href.replace(/[()'"<>\\`{}|^]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** throw when a target or option names an action this library never writes @param {any} o @param {string} who */
export function refuseActive(o, who) {
  for (const k of Object.keys(o)) if (ACTIVE.test(k)) throw new TypeError(`${who}: ${k}: JavaScript, Launch, GoToR, GoToE, SubmitForm, ImportData and other actions are never written (a PDF writer must not carry active content); targets are { url }, { page, fit… }, { dest } or { named }`);
}

/** a device colour as a /C array (annotation and link border colours) @param {any} c @param {any} doc @param {string} who */
export function colorArray(c, doc, who) {
  const d = device(c);
  if (!d) throw new TypeError(`${who}: an annotation colour is a gray level, '#rrggbb', [r, g, b] or [c, m, y, k] (not a spot or ICC colour)`);
  checkDevice(doc, d.cs);
  return `[${d.comps.map(num).join(' ')}]`;
}

/** rects ({ x, y, width, height }, top-left) as QuadPoints in PDF space (Acrobat's order: top-left, top-right, bottom-left, bottom-right) @param {any} rects @param {number} H @param {string} who */
export function quadPoints(rects, H, who) {
  const list = Array.isArray(rects) ? rects : [rects];
  if (!list.length || list.length > MAX_QUADS) throw new RangeError(`${who}: 1–${MAX_QUADS} rectangles`);
  let q = '', x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of list) {
    const x = r?.x, y = r?.y, w = r?.width, h = r?.height;
    for (const v of [x, y, w, h]) num(v);
    if (!(w > 0 && h > 0)) throw new RangeError(`${who}: a rectangle's width and height are above 0`);
    const t = num(H - y), b = num(H - y - h), l = num(x), rr = num(x + w);
    q += `${l} ${t} ${rr} ${t} ${l} ${b} ${rr} ${b} `;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
  }
  return { q: `[${q.trim()}]`, box: [x0, y0, x1 - x0, y1 - y0], list };
}

/**
 * @this {import('../page.js').Page}
 * @param {number} x @param {number} y @param {number} w @param {number} h
 * @param {{ url?: string, page?: number | import('../page.js').Page, dest?: string, named?: string, fit?: string, left?: number, top?: number, right?: number, bottom?: number, zoom?: number }} target
 * @param {{ alt?: string, allowSchemes?: string[], highlight?: 'none' | 'invert' | 'outline' | 'push', border?: { width?: number, style?: string, dash?: number[], color?: any }, quadPoints?: any }} [o]
 *   alt: the description a screen reader says (default: the URL or "Page n")
 */
export function link(x, y, w, h, target, o = {}) {
  const doc = this.doc, H = this.height, who = 'page.link';
  for (const v of [x, y, w, h]) num(v);
  const rect = `[${num(x)} ${num(H - y - h)} ${num(x + w)} ${num(H - y)}]`;
  if (!target || typeof target !== 'object') throw new TypeError(`${who}: the target is { url }, { page, fit… }, { dest } or { named }`);
  refuseActive(target, who);
  refuseActive(o, who);
  /** @type {string | null} */
  let action = null, say = o.alt ?? null;
  let to = -1;
  /** @type {import('./dest.js').Fit | null} */
  let fit = null;
  if (target.url != null) { action = `/A << /Type /Action /S /URI /URI ${ascii(checkUrl(target.url, o.allowSchemes, who))} >>`; say ??= target.url; }
  else if (target.dest != null) { action = `/Dest ${namedDests(doc).use(target.dest, who)}`; say ??= `Go to ${target.dest}`; }
  else if (target.named != null) {
    if (!NAMED.includes(target.named)) throw new TypeError(`${who}: named is one of ${NAMED.join(', ')}`);
    action = `/A << /Type /Action /S /Named /N /${target.named} >>`; say ??= target.named.replace(/(?=[A-Z])/g, ' ').trim();
  } else if (target.page != null) {
    to = pageIndex(doc, target.page, `${who}: target.page`);
    if (!(Number.isInteger(to) && to >= 0)) throw new RangeError(`${who}: target.page is a whole number from 1`);
    fit = fitOf(target, who);
    say ??= `Page ${to + 1}`;
  } else throw new TypeError(`${who}: the target is { url }, { page, fit… }, { dest } or { named }`);

  let style = ' /Border [0 0 0]';
  if (o.border != null) {
    const b = o.border, bw = b.width ?? 1, bs = b.style ?? 'solid';
    num(bw);
    if (!(bw >= 0 && bw <= 100)) throw new RangeError(`${who}: border width is 0–100`);
    if (!Object.hasOwn(BORDER, bs)) throw new TypeError(`${who}: border style is one of ${Object.keys(BORDER).join(', ')}`);
    const dash = b.dash != null ? dashArray(b.dash, who) : '';
    style = ` /BS << /Type /Border /W ${num(bw)} /S /${/** @type {any} */ (BORDER)[bs]}${dash ? ` /D ${dash}` : ''} >>${b.color != null ? ` /C ${colorArray(b.color, doc, who)}` : ''}`;
  }
  if (o.highlight != null) {
    if (!Object.hasOwn(HIGHLIGHT, o.highlight)) throw new TypeError(`${who}: highlight is one of ${Object.keys(HIGHLIGHT).join(', ')}`);
    style += ` /H /${/** @type {any} */ (HIGHLIGHT)[o.highlight]}`;
  }
  if (o.quadPoints != null) style += ` /QuadPoints ${quadPoints(o.quadPoints, H, who).q}`;
  const alt = pdfText(say);
  let key = -1;
  const ref = this.annotate((_ref, final) => {
    let dest = action;
    if (!dest) {
      const a = destArray(doc, to, /** @type {any} */ (fit));
      if (a === null && !final) return undefined; // the page is not there yet: asked again at the end
      if (a === null) doc.warn(`A link points to page ${to + 1}, but the PDF has ${doc.pageCount} pages`);
      dest = a === null ? '' : `/Dest ${a}`;
    }
    return `<< /Type /Annot /Subtype /Link /F 4 /Rect ${rect}${style} ${dest} /Contents ${alt}${key >= 0 ? ` /StructParent ${key}` : ''} >>`;
  });
  if (doc.tags) key = doc.tags.link(this, ref);
  return this;
}

/** a dash array [on off …] @param {any} d @param {string} who */
export function dashArray(d, who) {
  if (!Array.isArray(d) || !d.length || d.length > 16 || !d.every((v) => typeof v === 'number' && v >= 0 && v < 1e6) || !d.some((v) => v > 0)) throw new RangeError(`${who}: dash is 1–16 lengths ≥ 0, not all 0`);
  return `[${d.map(num).join(' ')}]`;
}
