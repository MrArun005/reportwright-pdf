// Image fixtures for the @reportwright/pdf tests: a small PNG encoder (every colour type, bit depth, Adam7, tRNS,
// PLTE), images from sharp (already in node_modules) and sips, the system ICC profiles, and a pixel reader (pdftoppm).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { DIR, run, save } from './tools.js';

const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** a PNG chunk @param {string} type @param {Uint8Array} data */
export function chunk(type, data) {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); Buffer.from(data).copy(b, 8);
  b.writeUInt32BE(zlib.crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
  return b;
}
export const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export function ihdr(w, h, depth, type, interlace = 0) {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(w, 0); d.writeUInt32BE(h, 4); d[8] = depth; d[9] = type; d[12] = interlace;
  return chunk('IHDR', d);
}

/** rows (filter byte 0) of the pixels px(x, y) → samples, for the given pixel positions @returns {Buffer} */
function rows(xs, ys, ch, depth, px) {
  const parts = [];
  for (const y of ys) {
    const row = [0];
    let acc = 0, n = 0;
    for (const x of xs) for (const s of px(x, y)) {
      if (depth === 16) row.push(s >> 8, s & 255);
      else if (depth === 8) row.push(s);
      else { acc = (acc << depth) | s; n += depth; if (n === 8) { row.push(acc); acc = 0; n = 0; } }
    }
    if (n) row.push(acc << (8 - n));
    parts.push(Buffer.from(row));
  }
  return Buffer.concat(parts);
}

/**
 * A PNG. px(x, y) gives the pixel's samples (ints at the depth; palette: [index]).
 * @param {{ w: number, h: number, type: 0|2|3|4|6, depth: number, interlace?: 0|1, px: (x: number, y: number) => number[], palette?: number[][], trns?: number[] }} o
 */
export function png(o) {
  const { w, h, type, depth, interlace = 0, px } = o;
  const ch = CHANNELS[type];
  let raw;
  if (!interlace) raw = rows([...Array(w).keys()], [...Array(h).keys()], ch, depth, px);
  else raw = Buffer.concat(ADAM7.map(([x0, y0, dx, dy]) => {
    const xs = [], ys = [];
    for (let x = x0; x < w; x += dx) xs.push(x);
    for (let y = y0; y < h; y += dy) ys.push(y);
    return xs.length && ys.length ? rows(xs, ys, ch, depth, px) : Buffer.alloc(0);
  }));
  const parts = [SIG, ihdr(w, h, depth, type, interlace)];
  if (o.palette) parts.push(chunk('PLTE', Buffer.from(o.palette.flat())));
  if (o.trns) parts.push(chunk('tRNS', Buffer.from(o.trns)));
  const z = zlib.deflateSync(raw);
  parts.push(chunk('IDAT', z.subarray(0, z.length >> 1)), chunk('IDAT', z.subarray(z.length >> 1))); // two IDATs
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return new Uint8Array(Buffer.concat(parts));
}

export const sharp = (await import('sharp').catch(() => null))?.default ?? null;

/** a w × h JPEG via sips (macOS) from a PNG, or null without sips */
export function sipsJpeg(pngBytes) {
  try {
    const src = path.join(DIR, `sips-${Date.now()}.png`), dst = src.replace(/png$/, 'jpg');
    fs.writeFileSync(src, pngBytes);
    execFileSync('sips', ['-s', 'format', 'jpeg', src, '--out', dst], { stdio: 'ignore' });
    return new Uint8Array(fs.readFileSync(dst));
  } catch { return null; }
}

const PROFILES = '/System/Library/ColorSync/Profiles';
/** a system ICC profile's bytes, or null @param {string} name */
export function profile(name) { try { return new Uint8Array(fs.readFileSync(path.join(PROFILES, name))); } catch { return null; } }

/** render page 1 at dpi (no anti-aliasing); px(x, y) → [r, g, b] in pixels @param {Uint8Array} bytes */
export function pixels(bytes, dpi = 72) {
  const file = save(bytes);
  run('pdftoppm', ['-r', String(dpi), '-aa', 'no', '-aaVector', 'no', '-singlefile', '-f', '1', '-l', '1', file, file]);
  const ppm = fs.readFileSync(`${file}.ppm`);
  let at = 0; const fields = [];
  while (fields.length < 4) { const e = ppm.indexOf(0x0a, at); fields.push(...ppm.subarray(at, e).toString().trim().split(/\s+/)); at = e + 1; }
  const w = Number(fields[1]);
  return (x, y) => { const i = at + (y * w + x) * 3; return [ppm[i], ppm[i + 1], ppm[i + 2]]; };
}
export const near = (a, b, tol = 8) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
/** pdfimages -list rows: [{ type, width, height, color, comp, bpc, enc, object }] */
export function pdfimages(bytes) {
  return run('pdfimages', ['-list', save(bytes)]).split('\n').slice(2).filter(Boolean).map((l) => {
    const c = l.trim().split(/\s+/);
    return { type: c[2], width: +c[3], height: +c[4], color: c[5], comp: +c[6], bpc: +c[7], enc: c[8], object: +c[10] };
  });
}
