/**
 * The PDF blend modes (ISO 32000-1 §11.3.5), on RGB 0–255: blendInto(mode, b, s, out) writes B(Cb, Cs) to out.
 * Separable modes work per channel; Hue, Saturation, Color and Luminosity on the whole colour.
 */
export const BLEND_MODES = [
  'Normal',
  'Multiply',
  'Screen',
  'Overlay',
  'Darken',
  'Lighten',
  'ColorDodge',
  'ColorBurn',
  'HardLight',
  'SoftLight',
  'Difference',
  'Exclusion',
  'Hue',
  'Saturation',
  'Color',
  'Luminosity',
];

/** a /BM value (a name or an array of names, the first known one) → a mode index; Compatible is Normal */
export function blendOf(/** @type {any} */ v) {
  for (const n of Array.isArray(v) ? v : [v]) {
    const i = BLEND_MODES.indexOf(n === 'Compatible' ? 'Normal' : n);
    if (i >= 0) return i;
  }
  return 0;
}

const hard = (/** @type {number} */ b, /** @type {number} */ s) =>
  s <= 0.5 ? b * 2 * s : b + (2 * s - 1) - b * (2 * s - 1);
/** one channel, 0–1 */
function sep(/** @type {number} */ m, /** @type {number} */ b, /** @type {number} */ s) {
  switch (m) {
    case 1:
      return b * s;
    case 2:
      return b + s - b * s;
    case 3:
      return hard(s, b);
    case 4:
      return Math.min(b, s);
    case 5:
      return Math.max(b, s);
    case 6:
      return b === 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s));
    case 7:
      return b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s);
    case 8:
      return hard(b, s);
    case 9: {
      if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
      const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
      return b + (2 * s - 1) * (d - b);
    }
    case 10:
      return Math.abs(b - s);
    case 11:
      return b + s - 2 * b * s;
    default:
      return s;
  }
}
const lum = (/** @type {number} */ r, /** @type {number} */ g, /** @type {number} */ b) =>
  0.3 * r + 0.59 * g + 0.11 * b;
/** SetLum(c, l) with ClipColor, into out (0–255) */
function setLum(
  /** @type {number} */ r,
  /** @type {number} */ g,
  /** @type {number} */ b,
  /** @type {number} */ l,
  /** @type {number[]} */ out,
) {
  const d = l - lum(r, g, b);
  ((r += d), (g += d), (b += d));
  const L = lum(r, g, b),
    n = Math.min(r, g, b),
    x = Math.max(r, g, b);
  if (n < 0) ((r = L + ((r - L) * L) / (L - n)), (g = L + ((g - L) * L) / (L - n)), (b = L + ((b - L) * L) / (L - n)));
  if (x > 1)
    ((r = L + ((r - L) * (1 - L)) / (x - L)),
      (g = L + ((g - L) * (1 - L)) / (x - L)),
      (b = L + ((b - L) * (1 - L)) / (x - L)));
  ((out[0] = r * 255), (out[1] = g * 255), (out[2] = b * 255));
  return out;
}
const T3 = [0, 0, 0];
/** SetSat(c, s) into T3 */
function setSat(/** @type {number} */ r, /** @type {number} */ g, /** @type {number} */ b, /** @type {number} */ s) {
  const mn = Math.min(r, g, b),
    mx = Math.max(r, g, b);
  if (mx <= mn) return ((T3[0] = T3[1] = T3[2] = 0), T3);
  const k = s / (mx - mn);
  ((T3[0] = (r - mn) * k), (T3[1] = (g - mn) * k), (T3[2] = (b - mn) * k));
  return T3;
}

/** B(Cb, Cs) for mode m on 0–255 colours, into out (0–255) */
export function blendInto(
  /** @type {number} */ m,
  /** @type {ArrayLike<number>} */ b,
  /** @type {number} */ bi,
  /** @type {ArrayLike<number>} */ s,
  /** @type {number} */ si,
  /** @type {number[]} */ out,
) {
  const br = b[bi] / 255,
    bg = b[bi + 1] / 255,
    bb = b[bi + 2] / 255,
    sr = s[si] / 255,
    sg = s[si + 1] / 255,
    sb = s[si + 2] / 255;
  if (m < 12) {
    ((out[0] = sep(m, br, sr) * 255), (out[1] = sep(m, bg, sg) * 255), (out[2] = sep(m, bb, sb) * 255));
    return out;
  }
  const lb = lum(br, bg, bb);
  if (m === 12) {
    const t = setSat(sr, sg, sb, Math.max(br, bg, bb) - Math.min(br, bg, bb));
    return setLum(t[0], t[1], t[2], lb, out);
  }
  if (m === 13) {
    const t = setSat(br, bg, bb, Math.max(sr, sg, sb) - Math.min(sr, sg, sb));
    return setLum(t[0], t[1], t[2], lb, out);
  }
  if (m === 14) return setLum(sr, sg, sb, lb, out);
  return setLum(br, bg, bb, lum(sr, sg, sb), out);
}

/** a separable mode (1–11) as a 256 × 256 table of B(Cb, Cs), rounded: index Cb * 256 + Cs (made once per mode) */
const tables = /** @type {Uint8ClampedArray[]} */ ([]);
export function blendTable(/** @type {number} */ m) {
  if (m < 1 || m > 11) return null;
  if (!tables[m]) {
    const t = new Uint8ClampedArray(65536);
    for (let b = 0; b < 256; b++) for (let c = 0; c < 256; c++) t[b * 256 + c] = sep(m, b / 255, c / 255) * 255;
    tables[m] = t;
  }
  return tables[m];
}
