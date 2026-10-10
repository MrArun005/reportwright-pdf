// Helpers for the navigation and annotation tests: pdf-lib objects as plain values, the annotations of a page, a page
// rendered in colour.
import fs from 'node:fs';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFNumber, PDFString, PDFHexString, PDFRef, PDFBool, PDFNull, PDFRawStream } from 'pdf-lib';
import { save, run } from './tools.js';

/** a pdf-lib object as plain JS: names '/X', numbers, strings decoded, arrays, dicts as objects; refs followed `depth` levels (else 'n R') */
export function js(o, ctx, depth = 1) {
  if (o instanceof PDFRef) return depth > 0 ? js(ctx.lookup(o), ctx, depth - 1) : `${o.objectNumber} R`;
  if (o instanceof PDFName) return o.toString();
  if (o instanceof PDFNumber) return o.asNumber();
  if (o instanceof PDFBool) return o.asBoolean();
  if (o === PDFNull || o == null) return null;
  if (o instanceof PDFString || o instanceof PDFHexString) return o.decodeText();
  if (o instanceof PDFArray) return o.asArray().map((x) => js(x, ctx, depth));
  if (o instanceof PDFRawStream) return { stream: o.getContents(), dict: js(o.dict, ctx, depth) };
  if (o instanceof PDFDict) { const r = {}; for (const [k, v] of o.entries()) r[k.asString().slice(1)] = js(v, ctx, depth); return r; }
  return String(o);
}
/** the raw bytes of a hex or literal string */
export const bytesOf = (o) => Buffer.from(o.asBytes());
export async function load(bytes) { return PDFDocument.load(bytes, { updateMetadata: false }); }
/** page i's annotations as dicts */
export function annots(doc, i = 0) {
  const a = doc.getPage(i).node.lookup(PDFName.of('Annots'), PDFArray);
  return a ? a.asArray().map((r) => doc.context.lookup(r, PDFDict)) : [];
}
export const get = (dict, k, depth = 1, doc) => js(dict.get(PDFName.of(k)), doc?.context ?? dict.context, depth);

/** page 1 in colour (pdftoppm, no anti-aliasing): { w, h, rgb(x, y) → [r, g, b] } in pixels at dpi */
export function color(bytes, dpi = 72) {
  const file = save(bytes);
  run('pdftoppm', ['-r', String(dpi), '-aa', 'no', '-aaVector', 'no', '-singlefile', file, file]);
  const ppm = fs.readFileSync(`${file}.ppm`);
  let at = 0; const f = [];
  while (f.length < 4) { const e = ppm.indexOf(0x0a, at); f.push(...ppm.subarray(at, e).toString().trim().split(/\s+/)); at = e + 1; }
  const w = Number(f[1]), h = Number(f[2]);
  return { w, h, rgb: (x, y) => [...ppm.subarray(at + (y * w + x) * 3, at + (y * w + x) * 3 + 3)] };
}
