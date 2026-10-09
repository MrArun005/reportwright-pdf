// @ts-check
/**
 * Page boxes and rotation for addPage({ cropBox, bleedBox, trimBox, artBox, rotate, userUnit }). Boxes are given as
 * [x, y, width, height] in the page's top-left space (as everything else), relative to the MediaBox, and written as
 * PDF rectangles. Checked: inside the MediaBox, a positive size, the TrimBox and ArtBox inside the BleedBox when both
 * are given. rotate (0, 90, 180, 270: clockwise, as viewers show it) only turns the displayed page: drawing coordinates
 * stay those of the unrotated MediaBox. userUnit (PDF 1.6; not in PDF/A-1) scales the default unit.
 */
import { num } from '../core/serialize.js';
import { refuseInA1 } from './level.js';

const BOXES = /** @type {const} */ (['cropBox', 'bleedBox', 'trimBox', 'artBox']);
const EPS = 1e-6;

/**
 * Set the page's box entries. @param {any} page @param {{ cropBox?: number[], bleedBox?: number[], trimBox?: number[], artBox?: number[], rotate?: number, userUnit?: number }} o
 */
export function pageBoxes(page, o) {
  const W = page.width, H = page.height, who = 'addPage';
  /** @type {Record<string, number[]>} x0, y0, x1, y1 in top-left space */
  const got = {};
  for (const k of BOXES) {
    const b = o[k];
    if (b == null) continue;
    if (!Array.isArray(b) || b.length !== 4) throw new TypeError(`${who}: ${k} is [x, y, width, height]`);
    const [x, y, w, h] = b.map((v) => { num(v); return v; });
    if (!(w > 0 && h > 0)) throw new RangeError(`${who}: ${k} has a positive width and height`);
    if (x < -EPS || y < -EPS || x + w > W + EPS || y + h > H + EPS) throw new RangeError(`${who}: ${k} [${b.join(', ')}] lies outside the page (the MediaBox, ${W} × ${H})`);
    got[k] = [x, y, x + w, y + h];
  }
  const inside = (/** @type {string} */ a, /** @type {string} */ b) => {
    const A = got[a], B = got[b];
    if (A && B && (A[0] < B[0] - EPS || A[1] < B[1] - EPS || A[2] > B[2] + EPS || A[3] > B[3] + EPS)) throw new RangeError(`${who}: ${a} lies outside ${b}`);
  };
  inside('trimBox', 'bleedBox'); inside('artBox', 'bleedBox');
  for (const k of BOXES) {
    const r = got[k];
    if (r) page.entries.set(k[0].toUpperCase() + k.slice(1).replace('box', 'Box'), `[${num(r[0])} ${num(H - r[3])} ${num(r[2])} ${num(H - r[1])}]`);
  }
  if (o.rotate != null) {
    if (![0, 90, 180, 270].includes(o.rotate)) throw new RangeError(`${who}: rotate is 0, 90, 180 or 270`);
    if (o.rotate) page.entries.set('Rotate', String(o.rotate));
  }
  if (o.userUnit != null) {
    if (typeof o.userUnit !== 'number' || !(o.userUnit > 0 && o.userUnit <= 75000)) throw new RangeError(`${who}: userUnit is a number above 0, at most 75,000`);
    refuseInA1(page.doc, who, 'is PDF 1.4, which has no UserUnit');
    if (o.userUnit !== 1) page.entries.set('UserUnit', num(o.userUnit));
  }
}
