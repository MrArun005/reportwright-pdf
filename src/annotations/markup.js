// @ts-check
/**
 * Page methods for annotations (annot.js has what they share): page.note (Text, a sticky note, with replies),
 * page.highlight / underline / strikeOut / squiggly (text markup over rectangles, QuadPoints computed from them),
 * page.freeText (a text box drawn with the package's own text), page.markup (Square, Circle, Line with line endings,
 * Polygon, PolyLine, Ink) and page.stamp (a standard stamp, or your own appearance). Each draws its appearance stream.
 *
 * Bounds: 10,000 rectangles a text markup, 100,000 points a shape (10,000 ink strokes); squiggles at most 2,000 waves.
 */
import { num, pdfName } from '../core/serialize.js';
import { unbrand } from '../core/brand.js';
import { colorOp, device } from '../graphics/color.js';
import { quadPoints, dashArray, colorArray } from '../nav/links.js';
import { shared, addAnnot, FLAGS } from './annot.js';

export const NOTE_ICONS = ['Comment', 'Key', 'Note', 'Help', 'NewParagraph', 'Paragraph', 'Insert'];
export const STAMPS = ['Approved', 'Experimental', 'NotApproved', 'AsIs', 'Expired', 'NotForPublicRelease', 'Confidential', 'Final', 'Sold', 'Departmental', 'ForComment', 'TopSecret', 'Draft', 'ForPublicRelease'];
export const LINE_ENDINGS = ['None', 'Square', 'Circle', 'Diamond', 'OpenArrow', 'ClosedArrow', 'Butt', 'ROpenArrow', 'RClosedArrow', 'Slash'];
const MAX_POINTS = 100_000, MAX_STROKES = 10_000;

/** a default colour the output intent allows @param {any} doc @param {string} rgb @param {number[]} cmyk */
const dflt = (doc, rgb, cmyk) => (doc.outputIntent === 'CMYK' ? cmyk : rgb);
/** the box option ({ x, y, width, height }) @param {any} o @param {string} who */
function boxOf(o, who) {
  const b = [o?.x ?? 0, o?.y ?? 0, o?.width, o?.height];
  for (const v of b) if (typeof v !== 'number') throw new TypeError(`${who}: x, y, width and height are numbers`);
  return b;
}
/** @param {any} v @param {string} who @param {number} [d] */
function widthOf(v, who, d = 1) {
  const w = v ?? d;
  num(w);
  if (!(w >= 0 && w <= 100)) throw new RangeError(`${who}: lineWidth is 0–100`);
  return w;
}

/**
 * A sticky note (Text annotation) with its icon at (x, y), 20 × 20, not zoomed or rotated with the page.
 * @this {any} @param {number} x @param {number} y @param {import('./annot.js').AnnotOptions & { icon?: string, open?: boolean, replyTo?: any }} [o]
 */
export function note(x, y, o = {}) {
  const who = 'page.note', doc = this.doc;
  const icon = o.icon ?? 'Note';
  if (!NOTE_ICONS.includes(icon)) throw new TypeError(`${who}: icon is one of ${NOTE_ICONS.join(', ')}`);
  const irt = o.replyTo != null ? ` /IRT ${unbrand(o.replyTo, 'annotation', doc, 'annotation').ref} 0 R /RT /R` : '';
  const color = o.color ?? dflt(doc, '#ffd84d', [0, 0.12, 0.75, 0]);
  const common = shared(doc, o, who, { flags: FLAGS.print | FLAGS.noZoom | FLAGS.noRotate, color });
  return addAnnot(this, 'Text', [x, y, 20, 20], ` /Name /${icon}${o.open ? ' /Open true' : ' /Open false'}${irt}`, common, (ap) => {
    const line = { stroke: 0.2, width: 1 };
    if (icon === 'Comment') ap.fillAndStroke(ap.path().roundedRect(1.5, 1.5, 17, 12, 2).moveTo(5, 13.5).lineTo(5, 18.5).lineTo(10, 13.5), { fill: color, ...line, join: 'round' });
    else if (icon === 'Help') ap.fillAndStroke(ap.path().arc(10, 10, 8.5, 0, 2 * Math.PI), { fill: color, ...line });
    else ap.fillAndStroke(ap.path().moveTo(1.5, 1.5).lineTo(18.5, 1.5).lineTo(18.5, 13.5).lineTo(13.5, 18.5).lineTo(1.5, 18.5).closePath(), { fill: color, ...line, join: 'round' });
    if (icon === 'Help') ap.stroke(ap.path().moveTo(7.2, 7.5).bezierCurveTo(7.2, 3.8, 12.8, 3.8, 12.8, 7.5).bezierCurveTo(12.8, 9.8, 10, 9.8, 10, 12.2).moveTo(10, 14).lineTo(10, 15.6), { ...line, width: 1.6 });
    else ap.stroke(ap.path().moveTo(4.5, 5.5).lineTo(15.5, 5.5).moveTo(4.5, 8.5).lineTo(15.5, 8.5).moveTo(4.5, 11.5).lineTo(icon === 'Comment' ? 15.5 : 12, 11.5), line);
  });
}

/**
 * Text markup over rectangles (the text's boxes, top-left space): QuadPoints from each, Rect their union.
 * @param {'Highlight' | 'Underline' | 'StrikeOut' | 'Squiggly'} subtype @param {string} rgb @param {number[]} cmyk
 */
function textMarkup(subtype, rgb, cmyk) {
  const who = `page.${subtype[0].toLowerCase()}${subtype.slice(1)}`;
  /** @this {any} @param {any} rects @param {import('./annot.js').AnnotOptions} [o] */
  return function (rects, o = {}) {
    const doc = this.doc;
    const { q, box, list } = quadPoints(rects, this.height, who);
    const color = o.color ?? dflt(doc, rgb, cmyk);
    const common = shared(doc, o, who, { color });
    const [bx, by, , bh] = box;
    return addAnnot(this, subtype, box, ` /QuadPoints ${q}`, common, (ap) => {
      const p = ap.path();
      for (const r of list) {
        const x = r.x - bx, y = r.y - by, w = r.width, h = r.height, t = Math.max(0.5, h / 14);
        if (subtype === 'Highlight') p.rect(x, y, w, h);
        else if (subtype === 'Underline') p.rect(x, y + h - t * 1.5, w, t);
        else if (subtype === 'StrikeOut') p.rect(x, y + h * 0.55 - t / 2, w, t);
        else { // squiggly: a zigzag along the bottom, at most 2,000 waves
          const n = Math.min(2000, Math.max(1, Math.round(w / Math.max(1, h / 5)))), step = w / n, base = y + h - t * 2, amp = Math.max(0.75, h / 16);
          p.moveTo(x, base);
          for (let k = 1; k <= n; k++) p.lineTo(x + k * step, base + (k % 2 ? amp : -amp) / 2);
        }
      }
      if (subtype === 'Highlight') ap.fill(p, { fill: color, blendMode: 'Multiply' }); // the text shows through
      else if (subtype === 'Squiggly') ap.stroke(p, { stroke: color, width: Math.max(0.5, bh / 28) });
      else ap.fill(p, { fill: color });
    });
  };
}
export const highlight = textMarkup('Highlight', '#ffeb3b', [0, 0, 0.8, 0]);
export const underline = textMarkup('Underline', '#1a9a1a', [0.8, 0, 1, 0.1]);
export const strikeOut = textMarkup('StrikeOut', '#d32f2f', [0, 0.9, 0.85, 0.1]);
export const squiggly = textMarkup('Squiggly', '#d32f2f', [0, 0.9, 0.85, 0.1]);

/**
 * A FreeText annotation: str in a box, drawn with the package's own text (wrapped as page.textBox) over a background,
 * inside a border. @this {any} @param {string} str
 * @param {import('./annot.js').AnnotOptions & { x?: number, y?: number, width: number, height: number, font: any, size?: number, textColor?: any,
 *   align?: 'left' | 'center' | 'right', border?: { width?: number, color?: any } | false, background?: any, padding?: number }} o
 */
export function freeText(str, o) {
  const who = 'page.freeText', doc = this.doc;
  if (typeof str !== 'string') throw new TypeError(`${who}: the text is a string`);
  const box = boxOf(o, who), [, , w, h] = box;
  unbrand(o?.font, 'font', doc, 'font'); // a forged font is refused before its name is read
  const size = o.size ?? 12;
  num(size);
  if (!(size > 0)) throw new RangeError(`${who}: size is above 0`);
  const align = o.align ?? 'left', Q = ['left', 'center', 'right'].indexOf(align);
  if (Q < 0) throw new TypeError(`${who}: align is left, center or right`);
  const bw = o.border === false ? 0 : widthOf(o.border?.width, who), bc = (o.border && o.border.color) ?? 0;
  const pad = o.padding ?? 2;
  num(pad);
  const tc = o.textColor ?? 0;
  const da = `${pdfName(o.font.name)} ${num(size)} Tf ${device(tc) ? colorOp(tc, false, doc) : '0 g'}`; // the font's resource name
  const common = shared(doc, o, who, { contents: str, color: o.background ?? undefined }); // /C: the background (as Acrobat reads it)
  const inner = bw + pad;
  return addAnnot(this, 'FreeText', box, ` /DA ${asciiHex(da)} /Q ${Q} /BS << /W ${num(bw)} >>`, common, (ap) => {
    if (o.background != null) ap.fill(ap.path().rect(0, 0, w, h), { fill: o.background });
    if (bw > 0) ap.stroke(ap.path().rect(bw / 2, bw / 2, w - bw, h - bw), { stroke: bc, width: bw });
    if (str && w - 2 * inner > 0) {
      ap.save(); ap.clip(ap.path().rect(bw, bw, w - 2 * bw, h - 2 * bw));
      ap.textBox(str, { x: inner, y: inner, width: w - 2 * inner, height: Math.max(0, h - 2 * inner), font: o.font, size, color: tc, align });
      ap.restore();
    }
  });
}
/** @param {string} s ASCII text as a hex string */
const asciiHex = (s) => { let h = '<'; for (let i = 0; i < s.length; i++) h += (s.charCodeAt(i) & 255).toString(16).padStart(2, '0'); return `${h}>`; };

/** points [[x, y], …] or [{ x, y }, …], checked and counted against the budget @param {any} list @param {string} who @param {number} min @param {{ left: number }} budget */
function pointsOf(list, who, min, budget) {
  if (!Array.isArray(list) || list.length < min) throw new TypeError(`${who}: at least ${min} points [[x, y], …]`);
  if ((budget.left -= list.length) < 0) throw new RangeError(`${who}: at most ${MAX_POINTS} points`);
  return list.map((p) => {
    const x = Array.isArray(p) ? p[0] : p?.x, y = Array.isArray(p) ? p[1] : p?.y;
    num(x); num(y);
    return /** @type {[number, number]} */ ([x, y]);
  });
}

/**
 * Draw a line ending at (x, y), the line arriving along the unit vector (dx, dy). @param {any} ap @param {string} kind
 * @param {number} x @param {number} y @param {number} dx @param {number} dy @param {number} s its size @param {any} st stroke options @param {any} fill interior colour or null
 */
function ending(ap, kind, x, y, dx, dy, s, st, fill) {
  const px = -dy, py = dx, p = ap.path();
  const closed = kind === 'ClosedArrow' || kind === 'RClosedArrow' || kind === 'Square' || kind === 'Circle' || kind === 'Diamond';
  if (kind === 'OpenArrow' || kind === 'ClosedArrow') p.moveTo(x - s * dx + s / 2 * px, y - s * dy + s / 2 * py).lineTo(x, y).lineTo(x - s * dx - s / 2 * px, y - s * dy - s / 2 * py);
  else if (kind === 'ROpenArrow' || kind === 'RClosedArrow') p.moveTo(x + s * dx + s / 2 * px, y + s * dy + s / 2 * py).lineTo(x, y).lineTo(x + s * dx - s / 2 * px, y + s * dy - s / 2 * py);
  else if (kind === 'Square') p.rect(x - s / 2, y - s / 2, s, s);
  else if (kind === 'Circle') p.arc(x, y, s / 2, 0, 2 * Math.PI);
  else if (kind === 'Diamond') p.moveTo(x, y - s / 2).lineTo(x + s / 2, y).lineTo(x, y + s / 2).lineTo(x - s / 2, y);
  else if (kind === 'Butt') p.moveTo(x + s / 2 * px, y + s / 2 * py).lineTo(x - s / 2 * px, y - s / 2 * py);
  else if (kind === 'Slash') { const c = Math.cos(Math.PI / 6), sn = Math.sin(Math.PI / 6), ux = c * px + sn * dx, uy = c * py + sn * dy; p.moveTo(x + s / 2 * ux, y + s / 2 * uy).lineTo(x - s / 2 * ux, y - s / 2 * uy); }
  else return;
  if (closed) p.closePath();
  if (closed && fill != null) ap.fillAndStroke(p, { ...st, fill });
  else ap.stroke(p, st);
}

/**
 * A shape annotation: Square or Circle ({ x, y, width, height }), Line ({ x1, y1, x2, y2 }, lineEndings), Polygon or
 * PolyLine ([[x, y], …]), Ink ([[[x, y], …], …]: strokes). Options: color (the line), interior (fill), lineWidth, dash.
 * @this {any} @param {'Square' | 'Circle' | 'Line' | 'Polygon' | 'PolyLine' | 'Ink'} type @param {any} g
 * @param {import('./annot.js').AnnotOptions & { interior?: any, lineWidth?: number, dash?: number[], lineEndings?: [string, string] }} [o]
 */
export function markup(type, g, o = {}) {
  const who = `page.markup('${type}')`, doc = this.doc, H = this.height;
  const lw = widthOf(o.lineWidth, who), dash = o.dash != null ? dashArray(o.dash, who) : '';
  const color = o.color ?? 0;
  const common = shared(doc, o, who, { color });
  const ic = o.interior != null ? ` /IC ${colorArray(o.interior, doc, who)}` : '';
  const bs = ` /BS << /W ${num(lw)} /S /${dash ? 'D' : 'S'}${dash ? ` /D ${dash}` : ''} >>`;
  const st = { stroke: color, width: lw, dash: o.dash ?? undefined, join: 'round', cap: 'round' };
  const fill = o.interior ?? null;
  if (type === 'Square' || type === 'Circle') {
    const box = boxOf(g, who), [, , w, h] = box;
    return addAnnot(this, type, box, `${bs}${ic}`, common, (ap) => {
      const p = type === 'Square' ? ap.path().rect(lw / 2, lw / 2, w - lw, h - lw) : ap.path().ellipse(w / 2, h / 2, Math.max(0, (w - lw) / 2), Math.max(0, (h - lw) / 2), 0, 0, 2 * Math.PI);
      if (fill != null) ap.fillAndStroke(p, { ...st, fill }); else if (lw > 0) ap.stroke(p, st);
    });
  }
  /** @type {[number, number][][]} */
  let strokes;
  const budget = { left: MAX_POINTS };
  if (type === 'Line') {
    const pts = [g?.x1, g?.y1, g?.x2, g?.y2];
    for (const v of pts) num(v);
    strokes = [[[pts[0], pts[1]], [pts[2], pts[3]]]];
  } else if (type === 'Polygon' || type === 'PolyLine') strokes = [pointsOf(g, who, type === 'Polygon' ? 3 : 2, budget)];
  else if (type === 'Ink') {
    if (!Array.isArray(g) || !g.length || g.length > MAX_STROKES) throw new TypeError(`${who}: 1–${MAX_STROKES} strokes [[[x, y], …], …]`);
    strokes = g.map((s) => pointsOf(s, who, 1, budget));
  } else throw new TypeError(`page.markup: type is Square, Circle, Line, Polygon, PolyLine or Ink, not ${JSON.stringify(type)}`);
  const ends = o.lineEndings ?? ['None', 'None'];
  if (o.lineEndings != null && (type === 'Polygon' || type === 'Ink')) throw new TypeError(`${who}: lineEndings are for Line and PolyLine`);
  if (!Array.isArray(ends) || ends.length !== 2 || !ends.every((e) => LINE_ENDINGS.includes(e))) throw new TypeError(`${who}: lineEndings is [start, end], each one of ${LINE_ENDINGS.join(', ')}`);
  const s = 4 + 3 * lw, pad = lw + (ends[0] !== 'None' || ends[1] !== 'None' ? s : 0) + 1;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of strokes) for (const [x, y] of k) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const list = (/** @type {[number, number][]} */ k) => k.map(([x, y]) => `${num(x)} ${num(H - y)}`).join(' ');
  const own = type === 'Line' ? ` /L [${list(strokes[0])}]` : type === 'Ink' ? ` /InkList [${strokes.map((k) => `[${list(k)}]`).join(' ')}]` : ` /Vertices [${list(strokes[0])}]`;
  const le = type === 'Line' || type === 'PolyLine' ? ` /LE [/${ends[0]} /${ends[1]}]` : '';
  return addAnnot(this, type, [x0, y0, x1 - x0, y1 - y0], `${own}${le}${bs}${type !== 'Ink' ? ic : ''}`, common, (ap) => {
    for (const k of strokes) {
      const p = ap.path().moveTo(k[0][0] - x0, k[0][1] - y0);
      if (k.length === 1) p.lineTo(k[0][0] - x0 + 0.01, k[0][1] - y0); // a dot
      for (let i = 1; i < k.length; i++) p.lineTo(k[i][0] - x0, k[i][1] - y0);
      if (type === 'Polygon') p.closePath();
      if (type === 'Polygon' && fill != null) ap.fillAndStroke(p, { ...st, fill }); else if (lw > 0) ap.stroke(p, st);
    }
    if (le) {
      const k = strokes[0], n = k.length;
      const dir = (/** @type {number[]} */ a, /** @type {number[]} */ b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
      const [ax, ay] = dir(k[1], k[0]), [bx, by] = dir(k[n - 2], k[n - 1]);
      ending(ap, ends[0], k[0][0] - x0, k[0][1] - y0, ax, ay, s, { ...st, dash: undefined }, fill);
      ending(ap, ends[1], k[n - 1][0] - x0, k[n - 1][1] - y0, bx, by, s, { ...st, dash: undefined }, fill);
    }
  });
}

/**
 * A rubber stamp: a standard one (name, its label drawn in font) or your own appearance (draw(ap) on a stand-in page
 * of the box's size). @this {any}
 * @param {import('./annot.js').AnnotOptions & { x?: number, y?: number, width: number, height: number, name?: string, font?: any, draw?: (ap: any) => any }} o
 */
export function stamp(o) {
  const who = 'page.stamp', doc = this.doc;
  const box = boxOf(o, who), [, , w, h] = box;
  const name = o.name ?? (o.draw ? null : 'Draft');
  if (name != null && !STAMPS.includes(name)) throw new TypeError(`${who}: name is one of ${STAMPS.join(', ')}`);
  const label = name ? name.replace(/(?<=[a-z])(?=[A-Z])/g, ' ').toUpperCase() : '';
  const color = o.color ?? dflt(doc, '#c62828', [0, 0.9, 0.85, 0.15]);
  let draw = o.draw;
  if (draw != null && typeof draw !== 'function') throw new TypeError(`${who}: draw is a function (ap) => { … }`);
  if (!draw) {
    const impl = unbrand(o.font, 'font', doc, 'font (a standard stamp draws its label: pass font, or draw your own appearance)');
    const lw = Math.max(1, Math.min(w, h) / 14);
    draw = (ap) => {
      ap.stroke(ap.path().roundedRect(lw, lw, w - 2 * lw, h - 2 * lw, Math.min(w, h) * 0.15), { stroke: color, width: lw });
      const size = Math.min(h * 0.5, (w - 6 * lw) / Math.max(0.01, o.font.widthOf(label, 1)));
      if (size > 0) ap.text(label, { x: (w - o.font.widthOf(label, size)) / 2, y: h / 2 + 0.35 * size - impl.ascent * size, font: o.font, size, color });
    };
  }
  const common = shared(doc, o, who, { color, contents: label ? label[0] + label.slice(1).toLowerCase() : undefined });
  return addAnnot(this, 'Stamp', box, name ? ` /Name /${name}` : '', common, draw);
}
