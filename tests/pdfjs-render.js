// pdf.js (pdfjs-dist + @napi-rs/canvas, dev dependencies only) rendering a page to RGBA, for the renderer's
// pixel comparison. null when either is not installed.
import { createRequire } from 'node:module';
import path from 'node:path';

let pdfjs = null,
  canvas = null;
try {
  pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  canvas = await import('@napi-rs/canvas');
} catch {
  pdfjs = null;
}
export const HAS_PDFJS = !!(pdfjs && canvas);
const fontsDir = HAS_PDFJS
  ? path.join(path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'standard_fonts') + '/'
  : '';

/** open a PDF in pdf.js @param {Uint8Array} bytes */
export const pdfjsOpen = (bytes) =>
  pdfjs.getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: fontsDir,
    verbosity: 0,
    isEvalSupported: false,
  }).promise;

/** render page index of an open pdf.js document → { width, height, data } @param {any} doc @param {number} index @param {number} scale */
export async function pdfjsRender(doc, index, scale) {
  const page = await doc.getPage(index + 1);
  const vp = page.getViewport({ scale });
  const c = canvas.createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = c.getContext('2d');
  await page.render({
    canvasContext: ctx,
    canvas: c,
    viewport: vp,
    annotationMode: pdfjs.AnnotationMode.ENABLE,
    background: 'white',
  }).promise;
  const im = ctx.getImageData(0, 0, c.width, c.height);
  return { width: c.width, height: c.height, data: im.data };
}

/**
 * The share of pixels whose channels differ by more than tol (0–255) between two renders of one size; also how many
 * are non-white in either (the ink), so a blank render cannot match. @param {any} a @param {any} b
 */
export function diff(a, b, tol = 48) {
  let bad = 0,
    ink = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let d = 0,
      inkA = false,
      inkB = false;
    for (let k = 0; k < 3; k++) {
      d = Math.max(d, Math.abs(a.data[i + k] - b.data[i + k]));
      if (a.data[i + k] < 245) inkA = true;
      if (b.data[i + k] < 245) inkB = true;
    }
    if (inkA || inkB) ink++;
    if (d > tol) bad++;
  }
  const n = a.data.length / 4;
  return { pct: (100 * bad) / n, inkPct: (100 * bad) / Math.max(1, ink), ink };
}
