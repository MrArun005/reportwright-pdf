// Helpers for the @reportwright/pdf tests: fonts, poppler and veraPDF runs, a temp folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const ROOT = path.join(import.meta.dirname, '..');
export const INTER = fs.readFileSync(path.join(ROOT, 'public/fonts/Inter-Regular.ttf'));
export const MONO = fs.readFileSync(path.join(ROOT, 'public/fonts/JetBrainsMono-Regular.ttf'));
export const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-pdf-'));

const has = (cmd) => { try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; } };
export const HAS = { poppler: has('pdftotext'), verapdf: has('verapdf'), qpdf: has('qpdf') };

let n = 0;
/** write bytes to a temp file @param {Uint8Array} bytes */
export const save = (bytes, name = `t${++n}.pdf`) => { const f = path.join(DIR, name); fs.writeFileSync(f, bytes); return f; };
/** run a tool; its stdout (also when it exits non-zero) */
export function run(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { if (e.stdout) return String(e.stdout); throw e; }
}
export const pdftotext = (bytes) => run('pdftotext', ['-layout', save(bytes), '-']);
export const pdffonts = (bytes) => run('pdffonts', [save(bytes)]);
export const pdfinfo = (bytes, ...a) => run('pdfinfo', [...a, save(bytes)]);
/** veraPDF: { ok, failed: ["clause-test (n): description"] } @param {'ua1'|'2b'} flavour */
export function verapdf(bytes, flavour) {
  const xml = run('verapdf', ['--flavour', flavour, '--format', 'xml', save(bytes)]);
  const failed = [...xml.matchAll(/<rule [^>]*clause="([^"]+)"[^>]*testNumber="(\d+)"[^>]*status="failed"[^>]*failedChecks="(\d+)"[^>]*>\s*<description>([^<]*)/g)].map(m => `${m[1]}-${m[2]} (${m[3]}): ${m[4].trim()}`);
  return { ok: /isCompliant="true"/.test(xml), failed };
}

/** the table directory of a font: tag → { rec (record's position), off, len } @param {Uint8Array} b */
export function directory(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), t = new Map();
  for (let i = 0; i < dv.getUint16(4); i++) {
    const p = 12 + 16 * i;
    t.set(String.fromCharCode(...b.subarray(p, p + 4)), { rec: p, off: dv.getUint32(p + 8), len: dv.getUint32(p + 12) });
  }
  return t;
}
/** inflate-free view of a PDF written with compress: false, as text */
export const latin = (bytes) => Buffer.from(bytes).toString('latin1');

/** page 1 rendered by pdftoppm in gray, no anti-aliasing: { w, h, px(x, y) 0–255, ink(x0, y0, x1, y1) dark pixels in the box, box() the bounding box of all ink } */
export function gray(bytes, dpi = 72) {
  const file = save(bytes);
  run('pdftoppm', ['-r', String(dpi), '-gray', '-aa', 'no', '-aaVector', 'no', '-singlefile', file, file]);
  const pgm = fs.readFileSync(`${file}.pgm`);
  let at = 0; const f = [];
  while (f.length < 4) { const e = pgm.indexOf(0x0a, at); f.push(...pgm.subarray(at, e).toString().trim().split(/\s+/)); at = e + 1; }
  const w = Number(f[1]), h = Number(f[2]);
  const px = (x, y) => pgm[at + y * w + x];
  const ink = (x0 = 0, y0 = 0, x1 = w, y1 = h) => { let n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (px(x, y) < 128) n++; return n; };
  const box = () => { let a = w, b = h, c = -1, d = -1; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px(x, y) < 128) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); } return c < 0 ? null : [a, b, c + 1, d + 1]; };
  return { w, h, px, ink, box, raw: pgm.subarray(at) };
}
