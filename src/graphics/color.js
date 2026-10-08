// @ts-check
/**
 * Colours as their operators: '#rgb', '#rrggbb', [r, g, b] (0–1) → "r g b rg"; a gray level 0–1 → "v g".
 * Extension point for colour spaces (CMYK, ICC, spot): parse more forms here and return their operators
 * ("c m y k k", "/CS1 cs 0.5 scn"), registering the colour space with doc.resource('ColorSpace', …).
 */
import { num } from '../core/serialize.js';

/**
 * @param {any} c @param {boolean} stroke @returns {string} the operator that sets it
 */
export function colorOp(c, stroke) {
  let v;
  if (typeof c === 'number') { if (!(c >= 0 && c <= 1)) throw new RangeError(`A gray level is 0–1, not ${c}`); return `${num(c)} ${stroke ? 'G' : 'g'}`; }
  if (Array.isArray(c) && c.length === 3 && c.every((x) => typeof x === 'number' && x >= 0 && x <= 1)) v = c;
  else if (typeof c === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) {
    const h = c.length === 4 ? [...c.slice(1)].map((x) => x + x).join('') : c.slice(1);
    v = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  } else throw new TypeError(`Not a colour: ${JSON.stringify(c)} (use '#rrggbb', [r, g, b] in 0–1, or a gray level 0–1)`);
  return `${v.map(num).join(' ')} ${stroke ? 'RG' : 'rg'}`;
}
