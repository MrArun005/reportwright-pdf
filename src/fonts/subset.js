// @ts-check
/**
 * A TrueType (glyf) subsetter that keeps glyph IDs: the glyphs used (and the components of composite glyphs, and
 * .notdef) keep their outlines, every other glyph becomes empty. The page content draws by glyph ID, so nothing there
 * changes. Kept tables: those a PDF's CIDFontType2 needs (head hhea hmtx maxp loca glyf cvt fpgm prep) and OS/2,
 * name, gasp. Dropped: cmap, post and the layout tables (GSUB, GPOS…), which the PDF does not use (veraPDF rejects a
 * font whose post table is version 3, so post goes rather than being cut down). buildSfnt is ReportWright's (src/exporters/subset.js).
 */
import { sfntTables } from './truetype.js';

const KEEP = ['head', 'hhea', 'hmtx', 'maxp', 'cvt ', 'fpgm', 'prep', 'OS/2', 'name', 'gasp'];

/**
 * @param {Uint8Array} bytes a TrueType font @param {Iterable<number>} glyphs IDs to keep
 * @returns {Uint8Array}
 */
export function subsetGlyf(bytes, glyphs) {
  const t = sfntTables(bytes);
  const head = /** @type {Uint8Array} */ (t.get('head')), loca = /** @type {Uint8Array} */ (t.get('loca')), glyf = /** @type {Uint8Array} */ (t.get('glyf'));
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const lv = new DataView(loca.buffer, loca.byteOffset, loca.byteLength);
  const gv = new DataView(glyf.buffer, glyf.byteOffset, glyf.byteLength);
  const long = hv.getInt16(50) === 1;
  const n = new DataView(/** @type {Uint8Array} */ (t.get('maxp')).buffer, /** @type {Uint8Array} */ (t.get('maxp')).byteOffset).getUint16(4);
  const at = (/** @type {number} */ g) => (long ? lv.getUint32(g * 4) : lv.getUint16(g * 2) * 2);
  // the glyphs and, through composite glyphs, their components
  const keep = new Set([0]);
  const todo = [0, ...glyphs];
  while (todo.length) {
    const g = /** @type {number} */ (todo.pop());
    if (g >= n) continue;
    keep.add(g);
    const s = at(g), e = at(g + 1);
    if (e - s < 10 || gv.getInt16(s) >= 0) continue;
    let p = s + 10, flags;
    do {
      flags = gv.getUint16(p);
      const c = gv.getUint16(p + 2);
      if (!keep.has(c)) todo.push(c);
      p += 4 + (flags & 1 ? 4 : 2) + (flags & 8 ? 2 : flags & 0x40 ? 4 : flags & 0x80 ? 8 : 0);
    } while (flags & 0x20 && p < e);
  }
  // new glyf (each glyph 4-byte aligned) and a long loca
  let total = 0;
  for (const g of keep) total += (at(g + 1) - at(g) + 3) & ~3;
  const nglyf = new Uint8Array(total), nloca = new Uint8Array((n + 1) * 4), nl = new DataView(nloca.buffer);
  let off = 0;
  for (let g = 0; g < n; g++) {
    nl.setUint32(g * 4, off);
    if (!keep.has(g)) continue;
    const s = at(g), e = at(g + 1);
    nglyf.set(glyf.subarray(s, e), off);
    off += (e - s + 3) & ~3;
  }
  nl.setUint32(n * 4, off);
  /** @type {Map<string, Uint8Array>} */
  const out = new Map();
  for (const tg of KEEP) { const x = t.get(tg); if (x) out.set(tg, x); }
  const nh = head.slice(); new DataView(nh.buffer).setInt16(50, 1);
  out.set('head', nh);
  out.set('loca', nloca);
  out.set('glyf', nglyf);
  return buildSfnt(out);
}

/** A sfnt from its tables: directory, 4-byte padding, table checksums and head's checkSumAdjustment. @param {Map<string, Uint8Array>} tables */
export function buildSfnt(tables) {
  const tags = [...tables.keys()].sort();
  const n = tags.length, pow = 2 ** Math.floor(Math.log2(n));
  const offs = new Map();
  let total = 12 + 16 * n;
  for (const tg of tags) { offs.set(tg, total); total += (/** @type {Uint8Array} */ (tables.get(tg)).length + 3) & ~3; }
  const out = new Uint8Array(total), dv = new DataView(out.buffer);
  out.set([0, 1, 0, 0], 0);
  dv.setUint16(4, n); dv.setUint16(6, pow * 16); dv.setUint16(8, Math.log2(pow)); dv.setUint16(10, n * 16 - pow * 16);
  tags.forEach((tg, i) => {
    const p = 12 + 16 * i, data = /** @type {Uint8Array} */ (tables.get(tg)), o = offs.get(tg);
    for (let k = 0; k < 4; k++) out[p + k] = tg.charCodeAt(k);
    out.set(data, o);
    if (tg === 'head') dv.setUint32(o + 8, 0);
    dv.setUint32(p + 4, tableSum(out, o, (data.length + 3) & ~3));
    dv.setUint32(p + 8, o); dv.setUint32(p + 12, data.length);
  });
  if (offs.has('head')) dv.setUint32(offs.get('head') + 8, (0xB1B0AFBA - tableSum(out, 0, out.length)) >>> 0);
  return out;
}
/** @param {Uint8Array} b @param {number} o @param {number} len */
const tableSum = (b, o, len) => { const dv = new DataView(b.buffer, b.byteOffset + o, len); let s = 0; for (let i = 0; i < len; i += 4) s = (s + dv.getUint32(i)) >>> 0; return s; };
