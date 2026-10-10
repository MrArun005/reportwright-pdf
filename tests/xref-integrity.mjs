// Builds PDFs with a large ICC profile, large images and many pages, and checks every byte of their structure: every
// Flate stream inflates (node:zlib, which rejects "invalid distance too far back"), the xref stream decodes, and every
// offset in it points at "N 0 obj". Imported by xref-integrity.test.js, and run by it under another Node (zlib's output,
// and so every offset in the file, differs between Node versions): `node xref-integrity.mjs` prints JSON.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { toBytes } from '../src/index.js';
import { png } from './image-fixtures.js';

const ROOT = new URL('../', import.meta.url).pathname;
const first = (...f) => {
  const hit = f.find((x) => fs.existsSync(x));
  return hit ? new Uint8Array(fs.readFileSync(hit)) : null;
};
/** a large CMYK profile (Ghostscript's default_cmyk.icc, 187 KB, broke the xref stream on Node 22), else macOS's */
export const ICC = first(
  ...[
    '/usr/share/color/icc/ghostscript/',
    '/opt/homebrew/share/ghostscript/iccprofiles/',
    '/usr/share/ghostscript/iccprofiles/',
  ].map((d) => d + 'default_cmyk.icc'),
  '/System/Library/ColorSync/Profiles/Generic CMYK Profile.icc',
);
const SRGB = new Uint8Array(fs.readFileSync(ROOT + 'public/icc/sRGB-v2-magic.icc'));

/** noise PNGs: they compress little, so their sizes (and the offsets after them) vary with zlib */
const noise = (w, h, seed) => {
  let s = seed;
  return png({
    w,
    h,
    type: 2,
    depth: 8,
    px: () => {
      s = (s * 1103515245 + 12345) >>> 0;
      return [s >>> 24, (s >>> 16) & 255, (s >>> 8) & 255];
    },
  });
};
const IMAGES = [noise(300, 200, 1), noise(256, 256, 2), noise(400, 120, 3)];

/**
 * variant v: a small noise image v + 1 pixels wide moves every offset after it (the old xref encoder broke on about
 * 4 in 10 of these, on any Node); big: also three large images and 300 pages. @param {number} v @param {boolean} big
 */
export function build(v, big) {
  return toBytes(
    async (pdf) => {
      const h = pdf.standardFont('Helvetica');
      const p = pdf.addPage({ width: 595, height: 842 });
      if (ICC) p.rect(40, 50, 120, 80, { fill: (await pdf.iccColorSpace(ICC)).color(0, 1, 1, 0) });
      p.image(await pdf.embedImage(noise(v + 1, 3, v)), { x: 40, y: 150, width: 20 });
      if (!big) return;
      p.rect(180, 50, 120, 80, { fill: (await pdf.iccColorSpace(SRGB)).color(1, 0, 0) });
      for (const [i, b] of IMAGES.entries()) p.image(await pdf.embedImage(b), { x: 40 + i * 150, y: 200, width: 140 });
      for (let i = 1; i < 300; i++)
        pdf.addPage().text(`Page ${i + 1} ${'y'.repeat((v * 7 + i) % 40)}`, { x: 40, y: 40, font: h, size: 12 });
    },
    { creationDate: new Date(0) },
  );
}

/** problems with the file's structure ([] when sound) @param {Uint8Array} bytes */
export function check(bytes) {
  const f = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length),
    s = f.toString('latin1'),
    bad = [];
  /** @type {Map<number, number>} object number → offset of "N 0 obj" */
  const at = new Map();
  for (const m of s.matchAll(/(?<=^|[\r\n])(\d+) 0 obj\b/g)) at.set(+m[1], m.index);
  let xref = null;
  for (const [n, o] of at) {
    const d = s.indexOf('stream', o),
      e = s.indexOf('endobj', o);
    if (d < 0 || d > e) continue;
    const dict = s.slice(o, d),
      len = Number(/\/Length (\d+)/.exec(dict)?.[1]);
    const start = d + 6 + (s[d + 6] === '\r' ? 2 : 1);
    if (!/^\s*endstream/.test(s.slice(start + len, start + len + 12))) {
      bad.push(`object ${n}: /Length ${len} does not end at endstream`);
      continue;
    }
    if (!dict.includes('/FlateDecode')) continue;
    let raw;
    try {
      raw = zlib.inflateSync(f.subarray(start, start + len));
    } catch (err) {
      bad.push(`object ${n}: ${/** @type {Error} */ (err).message}`);
      continue;
    }
    if (dict.includes('/Type /XRef')) xref = { n, dict, raw };
  }
  if (!xref) return [...bad, 'no xref stream that inflates'];
  const W = /\/W \[(\d+) (\d+) (\d+)\]/.exec(xref.dict).slice(1).map(Number),
    cols = W[0] + W[1] + W[2],
    size = Number(/\/Size (\d+)/.exec(xref.dict)[1]);
  if (xref.raw.length !== size * (cols + 1)) bad.push(`xref: ${xref.raw.length} bytes for ${size} rows`);
  const prev = new Uint8Array(cols),
    num = (r, a, w) => {
      let x = 0;
      for (let i = a; i < a + w; i++) x = x * 256 + r[i];
      return x;
    };
  for (let k = 0; k < size; k++) {
    const r = xref.raw.subarray(k * (cols + 1), (k + 1) * (cols + 1));
    if (r[0] !== 2) {
      bad.push(`xref row ${k}: predictor ${r[0]}`);
      break;
    }
    for (let i = 0; i < cols; i++) prev[i] = (prev[i] + r[i + 1]) & 255;
    const t = num(prev, 0, W[0]),
      l = num(prev, W[0], W[1]);
    if (t === 1 && at.get(k) !== l) bad.push(`xref row ${k}: offset ${l}, but "${k} 0 obj" is at ${at.get(k)}`);
    if (t === 2 && !/\/Type \/ObjStm/.test(s.slice(at.get(l) ?? 0, (at.get(l) ?? 0) + 200)))
      bad.push(`xref row ${k}: in ${l}, not an object stream`);
  }
  const sx = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(s)?.[1]);
  if (sx !== at.get(xref.n)) bad.push(`startxref ${sx}, but the xref stream is at ${at.get(xref.n)}`);
  return bad;
}

/** the variants the test runs: 48 small files and 4 big ones */
export const VARIANTS = [...Array.from({ length: 48 }, (_, v) => [v, false]), ...[9, 10, 40, 41].map((v) => [v, true])];

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const out = [];
  for (const [v, big] of VARIANTS) out.push({ v, big, bad: check(await build(v, big)) });
  console.log(JSON.stringify({ node: process.version, icc: ICC?.length ?? 0, out }));
}
