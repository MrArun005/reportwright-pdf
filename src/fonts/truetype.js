// @ts-check
/**
 * A small sfnt reader (TrueType glyf, or OpenType CFF): what a PDF needs to embed a font and measure text. Tables
 * read: cmap (formats 4 and 12), head, hhea, hmtx, maxp, OS/2, post, name. No layout tables (no kerning, no shaping).
 */

const tagOf = (/** @type {Uint8Array} */ b, /** @type {number} */ p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);

/** The tables of a single-face sfnt as tag → bytes. @param {Uint8Array} bytes */
export function sfntTables(bytes) {
  if (bytes.length < 12) throw new TypeError('Not a font: too short');
  const v = tagOf(bytes, 0);
  if (v === 'ttcf') throw new TypeError('Font collections (.ttc) are not supported: pass a single font');
  if (v === 'wOFF' || v === 'wOF2') throw new TypeError('WOFF fonts are not supported: pass the TrueType or OpenType file');
  if (v !== '\0\x01\0\0' && v !== 'OTTO' && v !== 'true') throw new TypeError('Not a TrueType or OpenType font');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  /** @type {Map<string, Uint8Array>} */
  const t = new Map();
  const n = dv.getUint16(4);
  for (let i = 0; i < n; i++) {
    const p = 12 + i * 16, off = dv.getUint32(p + 8), len = dv.getUint32(p + 12);
    if (off + len > bytes.length) throw new TypeError(`Broken font: table ${tagOf(bytes, p)} runs past the end`);
    t.set(tagOf(bytes, p), bytes.subarray(off, off + len));
  }
  return t;
}

const view = (/** @type {Uint8Array} */ b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** @param {Uint8Array} bytes */
export function parseFont(bytes) {
  const tables = sfntTables(bytes);
  const need = (/** @type {string} */ tg) => { const x = tables.get(tg); if (!x) throw new TypeError(`Broken font: no ${tg} table`); return view(x); };
  const head = need('head'), hhea = need('hhea'), maxp = need('maxp'), hmtx = need('hmtx'), cmap = need('cmap');
  const os2 = tables.has('OS/2') ? view(/** @type {Uint8Array} */ (tables.get('OS/2'))) : null;
  const post = tables.has('post') ? view(/** @type {Uint8Array} */ (tables.get('post'))) : null;
  const unitsPerEm = head.getUint16(18);
  const numGlyphs = maxp.getUint16(4);
  const nh = hhea.getUint16(34);
  const advance = (/** @type {number} */ g) => hmtx.getUint16(4 * Math.min(g, nh - 1));
  const cff = tables.has('CFF ') || tables.has('CFF2');
  if (!cff && !(tables.has('glyf') && tables.has('loca'))) throw new TypeError('Broken font: no glyf/loca and no CFF table');
  return {
    tables, unitsPerEm, numGlyphs, cff,
    indexToLocFormat: head.getInt16(50),
    bbox: [head.getInt16(36), head.getInt16(38), head.getInt16(40), head.getInt16(42)],
    ascent: hhea.getInt16(4), descent: hhea.getInt16(6),
    capHeight: os2 && os2.byteLength >= 90 && os2.getUint16(0) >= 2 ? os2.getInt16(88) : hhea.getInt16(4),
    xHeight: os2 && os2.byteLength >= 88 && os2.getUint16(0) >= 2 ? os2.getInt16(86) : 0,
    fsType: os2 ? os2.getUint16(8) : 0,
    italicAngle: post ? post.getInt32(4) / 65536 : 0,
    fixedPitch: post ? post.getUint32(12) !== 0 : false,
    postscriptName: psName(tables.get('name')),
    advance,
    glyphFor: cmapLookup(cmap),
  };
}

/** @param {Uint8Array | undefined} nm the name table → its PostScript name (nameID 6), letters only */
function psName(nm) {
  if (!nm) return 'Font';
  const dv = view(nm), count = dv.getUint16(2), store = dv.getUint16(4);
  for (let i = 0; i < count; i++) {
    const p = 6 + 12 * i;
    if (dv.getUint16(p + 6) !== 6) continue;
    const platform = dv.getUint16(p), len = dv.getUint16(p + 8), off = store + dv.getUint16(p + 10);
    const b = nm.subarray(off, off + len);
    let s = '';
    if (platform === 1) for (const c of b) s += String.fromCharCode(c);
    else for (let k = 0; k + 1 < b.length; k += 2) s += String.fromCharCode((b[k] << 8) | b[k + 1]);
    s = s.replace(/[^A-Za-z0-9_.-]/g, '');
    if (s) return s.slice(0, 63);
  }
  return 'Font';
}

/** code point → glyph ID (0: none), from the best Unicode subtable (format 12, else 4) @param {DataView} dv */
function cmapLookup(dv) {
  const n = dv.getUint16(2);
  /** @type {{ score: number, off: number }} */
  let best = { score: 0, off: 0 };
  for (let i = 0; i < n; i++) {
    const pid = dv.getUint16(4 + i * 8), eid = dv.getUint16(6 + i * 8), off = dv.getUint32(8 + i * 8);
    const fmt = dv.getUint16(off);
    const uni = pid === 0 || (pid === 3 && (eid === 1 || eid === 10)), sym = pid === 3 && eid === 0;
    const score = fmt === 12 && uni ? 4 : fmt === 4 && uni ? 3 : fmt === 4 && sym ? 2 : 0;
    if (score > best.score) best = { score, off };
  }
  if (!best.score) throw new TypeError('The font has no Unicode character map (cmap format 4 or 12)');
  const o = best.off;
  const memo = new Map();
  if (dv.getUint16(o) === 12) {
    const groups = dv.getUint32(o + 12);
    return (/** @type {number} */ cp) => {
      let g = memo.get(cp);
      if (g !== undefined) return g;
      let lo = 0, hi = groups - 1;
      g = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1, p = o + 16 + mid * 12;
        if (cp < dv.getUint32(p)) hi = mid - 1;
        else if (cp > dv.getUint32(p + 4)) lo = mid + 1;
        else { g = dv.getUint32(p + 8) + cp - dv.getUint32(p); break; }
      }
      memo.set(cp, g);
      return g;
    };
  }
  const segs = dv.getUint16(o + 6) / 2;
  const ends = o + 14, starts = ends + segs * 2 + 2, deltas = starts + segs * 2, ranges = deltas + segs * 2;
  const symbol = best.score === 2; // a symbol font maps U+F000–F0FF; plain bytes are read there
  return (/** @type {number} */ cp) => {
    let g = memo.get(cp);
    if (g !== undefined) return g;
    const c = symbol && cp < 256 ? 0xf000 + cp : cp;
    g = 0;
    if (c <= 0xffff) {
      let lo = 0, hi = segs - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (dv.getUint16(ends + mid * 2) < c) lo = mid + 1; else hi = mid; }
      const start = dv.getUint16(starts + lo * 2);
      if (c >= start && c <= dv.getUint16(ends + lo * 2)) {
        const delta = dv.getUint16(deltas + lo * 2), ro = dv.getUint16(ranges + lo * 2);
        if (!ro) g = (c + delta) & 0xffff;
        else {
          const at = ranges + lo * 2 + ro + (c - start) * 2;
          g = at + 2 <= dv.byteLength ? dv.getUint16(at) : 0;
          if (g) g = (g + delta) & 0xffff;
        }
      }
    }
    memo.set(cp, g);
    return g;
  };
}
