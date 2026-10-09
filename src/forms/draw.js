// @ts-check
/**
 * Appearance streams of form fields, drawn with the package's own text and graphics on an appearance's stand-in page
 * (annotations/annot.js appearance(): its own top-left space, w × h): the frame (background and border), a text
 * field's value (one line, several, or a comb), a choice field's value or rows, a check box's or radio button's mark,
 * a push button's label and icon. Everything here draws; the checks are done by form.js before.
 */
import { Content } from '../content/content.js';
import { drawLine, textState } from '../text/text.js';
import { segments, runWidth, spacing } from '../text/runs.js';

/** the marks a check box or radio button can draw (and the ZapfDingbats character /MK /CA names for viewers) */
export const MARKS = { check: '4', cross: '8', circle: 'l', square: 'n', diamond: 'u', star: 'H' };
const PLAIN = spacing({});
const AUTO_MAX = 12, AUTO_MIN = 4;

/**
 * @typedef {{ fonts: { font: any, impl: any }[], impl: any, ascent: number, descent: number, size: number, color: any }} TextLook
 *   the field's fonts (main and fallbacks), its ascent and descent (of the size), size (0: auto), text colour
 * @typedef {{ bw: number, bc: any, bg: any }} Frame  border width (0: none), border colour, background (null: none)
 */

/** the width of str in the fonts at size @param {TextLook} t @param {string} str @param {number} size */
export const widthOf = (t, str, size) => { let w = 0; for (const s of segments(str, t.fonts, { measure: true })) w += runWidth(s.run, size, PLAIN); return w; };

/** background and border @param {any} ap @param {number} w @param {number} h @param {Frame} f @param {any} [bg] another background (a pressed button) */
export function frame(ap, w, h, f, bg = f.bg) {
  if (bg != null) ap.fill(ap.path().rect(0, 0, w, h), { fill: bg });
  if (f.bw > 0) ap.stroke(ap.path().rect(f.bw / 2, f.bw / 2, w - f.bw, h - f.bw), { stroke: f.bc, width: f.bw });
}

/** the inside of the frame clipped; fn draws there @param {any} ap @param {number} w @param {number} h @param {Frame} f @param {() => void} fn */
function inside(ap, w, h, f, fn) {
  if (w - 2 * f.bw <= 0 || h - 2 * f.bw <= 0) return;
  ap.save(); ap.clip(ap.path().rect(f.bw, f.bw, w - 2 * f.bw, h - 2 * f.bw));
  try { fn(); } finally { ap.restore(); }
}

/** the size of one line of str in a box iw × ih: the field's, or (auto) the largest up to 12 that fits @param {TextLook} t @param {string} str @param {number} iw @param {number} ih */
export function lineSize(t, str, iw, ih) {
  if (t.size) return t.size;
  let s = Math.min(AUTO_MAX, ih / (t.ascent - t.descent));
  const w = str ? widthOf(t, str, s) : 0;
  if (w > iw) s *= iw / w;
  return Math.max(1, Math.floor(s * 100) / 100);
}

/**
 * one line of text in the band [x, x + iw] × [y, y + h], aligned (0 left, 1 centre, 2 right), centred vertically
 * @param {any} ap @param {TextLook} t @param {string} str @param {number} x @param {number} y @param {number} iw @param {number} h @param {number} q @param {number} size
 */
function line(ap, t, str, x, y, iw, h, q, size) {
  if (!str) return;
  const dx = q === 0 ? 0 : (iw - widthOf(t, str, size)) / (q === 1 ? 2 : 1);
  const base = y + h / 2 + (t.ascent + t.descent) / 2 * size;
  drawLine(ap, t.fonts, str, x + dx, base, size, textState({}), { color: t.color });
}

/**
 * A text field (and an editable combo box's) value. @param {any} ap @param {number} w @param {number} h @param {Frame} f
 * @param {TextLook} t @param {string} value @param {{ q: number, multiline?: boolean, comb?: number }} o
 */
export function textValue(ap, w, h, f, t, value, o) {
  frame(ap, w, h, f);
  const pad = f.bw + 2, iw = w - 2 * pad, ih = h - 2 * f.bw;
  if (o.comb) { // each character centred in its cell; lines between the cells when there is a border
    const cell = w / o.comb;
    if (f.bw > 0) { const p = ap.path(); for (let i = 1; i < o.comb; i++) p.moveTo(i * cell, 0).lineTo(i * cell, h); ap.stroke(p, { stroke: f.bc, width: f.bw }); }
    if (!value) return;
    const size = t.size || lineSize(t, 'W', cell - 2, ih);
    inside(ap, w, h, f, () => { let i = 0; for (const ch of value) { line(ap, t, ch, i * cell, 0, cell, h, 1, size); i++; } });
    return;
  }
  if (!value || iw <= 0) return;
  inside(ap, w, h, f, () => {
    if (!o.multiline) return line(ap, t, value, pad, 0, iw, h, o.q, lineSize(t, value, iw, ih));
    const box = { x: pad, y: pad, width: iw, height: Math.max(0, h - 2 * pad), font: t.fonts[0].font, fallback: t.fonts.slice(1).map((x) => x.font), color: t.color, align: /** @type {const} */ (['left', 'center', 'right'])[o.q] };
    let size = t.size;
    if (!size) { // auto: the largest of 12, 11 … 4 at which the whole value fits (laid out on a scratch copy, not drawn)
      for (size = AUTO_MAX; size > AUTO_MIN; size--) {
        const scratch = Object.create(ap);
        scratch.content = new Content();
        if (!scratch.textBox(value, { ...box, size }).overflow) break;
      }
    }
    ap.textBox(value, { ...box, size });
  });
}

/**
 * A list box: the options' rows from `top`, the selected ones highlighted. @param {any} ap @param {number} w @param {number} h
 * @param {Frame} f @param {TextLook} t @param {string[]} rows display texts @param {Set<number>} selected @param {number} top @param {number} q @param {any} hl
 */
export function listRows(ap, w, h, f, t, rows, selected, top, q, hl) {
  frame(ap, w, h, f);
  const size = t.size || AUTO_MAX, lh = t.impl.lineHeight * size, pad = f.bw + 2;
  inside(ap, w, h, f, () => {
    for (let i = top, y = f.bw; i < rows.length && y < h - f.bw; i++, y += lh) {
      if (selected.has(i)) ap.fill(ap.path().rect(f.bw, y, w - 2 * f.bw, lh), { fill: hl });
      line(ap, t, rows[i], pad, y, w - 2 * pad, lh, q, size);
    }
  });
}

/**
 * A check box's or radio button's mark, in the middle of the box. @param {any} ap @param {number} w @param {number} h
 * @param {keyof typeof MARKS} mark @param {any} color
 */
export function drawMark(ap, w, h, mark, color) {
  const s = Math.min(w, h) * 0.7, x = (w - s) / 2, y = (h - s) / 2, p = ap.path();
  const at = (/** @type {number} */ u, /** @type {number} */ v) => [x + u * s, y + v * s];
  if (mark === 'check') {
    p.moveTo(...at(0.12, 0.55)).lineTo(...at(0.4, 0.82)).lineTo(...at(0.9, 0.18));
    return ap.stroke(p, { stroke: color, width: s * 0.14, cap: 'round', join: 'round' });
  }
  if (mark === 'cross') {
    p.moveTo(...at(0.15, 0.15)).lineTo(...at(0.85, 0.85)).moveTo(...at(0.85, 0.15)).lineTo(...at(0.15, 0.85));
    return ap.stroke(p, { stroke: color, width: s * 0.14, cap: 'round' });
  }
  if (mark === 'circle') p.arc(w / 2, h / 2, s * 0.32, 0, 2 * Math.PI);
  else if (mark === 'square') p.rect(...at(0.2, 0.2), s * 0.6, s * 0.6);
  else if (mark === 'diamond') p.moveTo(...at(0.5, 0.08)).lineTo(...at(0.92, 0.5)).lineTo(...at(0.5, 0.92)).lineTo(...at(0.08, 0.5)).closePath();
  else { // star: five points
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 0.19 : 0.46, a = -Math.PI / 2 + i * Math.PI / 5, px = 0.5 + r * Math.cos(a), py = 0.52 + r * Math.sin(a);
      if (i) p.lineTo(...at(px, py)); else p.moveTo(...at(px, py));
    }
    p.closePath();
  }
  ap.fill(p, { fill: color });
}

/** a radio button's round frame @param {any} ap @param {number} w @param {number} h @param {Frame} f */
export function roundFrame(ap, w, h, f) {
  const r = Math.min(w, h) / 2 - f.bw / 2;
  if (r <= 0) return;
  const p = ap.path().arc(w / 2, h / 2, r, 0, 2 * Math.PI);
  if (f.bg != null && f.bw > 0) ap.fillAndStroke(p, { fill: f.bg, stroke: f.bc, width: f.bw });
  else if (f.bg != null) ap.fill(p, { fill: f.bg });
  else if (f.bw > 0) ap.stroke(p, { stroke: f.bc, width: f.bw });
}

/**
 * A push button: its background (bg), frame, icon (an image handle, fitted above the label or alone) and label centred.
 * @param {any} ap @param {number} w @param {number} h @param {Frame} f @param {any} bg @param {TextLook | null} t
 * @param {string} label @param {any} icon
 */
export function buttonFace(ap, w, h, f, bg, t, label, icon) {
  frame(ap, w, h, f, bg);
  const pad = f.bw + 2, iw = w - 2 * pad, ih = h - 2 * pad;
  if (iw <= 0 || ih <= 0) return;
  inside(ap, w, h, f, () => {
    let lh = 0;
    if (t && label) {
      const size = lineSize(t, label, iw, icon ? ih / 3 : ih);
      lh = icon ? (t.ascent - t.descent) * size + 2 : 0;
      if (icon) line(ap, t, label, pad, h - pad - lh, iw, lh, 1, size); // the band at the bottom
      else line(ap, t, label, pad, 0, iw, h, 1, size);
    }
    if (icon) ap.image(icon, { x: pad, y: pad, width: iw, height: Math.max(1, ih - lh), fit: 'contain' });
  });
}
