// @ts-check
/**
 * A small sfnt reader (TrueType glyf, or OpenType CFF): what a PDF needs to embed a font and measure text. Tables
 * read: cmap (formats 4 and 12), head, hhea, hmtx, maxp, OS/2, post, name. No layout tables (no kerning, no shaping).
 *
 * A font file is UNTRUSTED input. Everything read later (cmap lookups, advances, loca offsets) is bounds-checked here,
 * up front, so a broken or hostile font fails at embedFont() with a clear TypeError instead of reading out of bounds,
 * looping or allocating from bogus sizes later. Names read from it are sanitised where they are written (pdfName).
 */
const broken = (/** @type {string} */ why) => new TypeError(`Broken font: ${why}`);

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
  if (n === 0 || n > 256 || 12 + n * 16 > bytes.length) throw broken(`a directory of ${n} tables does not fit the file`);
  for (let i = 0; i < n; i++) {
    const p = 12 + i * 16, tg = tagOf(bytes, p), off = dv.getUint32(p + 8), len = dv.getUint32(p + 12);
    if (off < 12 + n * 16 || off + len > bytes.length) throw broken(`table ${JSON.stringify(tg)} lies outside the file`);
    if (t.has(tg)) throw broken(`table ${JSON.stringify(tg)} appears twice`);
    t.set(tg, bytes.subarray(off, off + len)); // read-only views: overlapping tables cannot make a write go astray
  }
  return t;
}

const view = (/** @type {Uint8Array} */ b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** @param {Uint8Array} bytes */
export function parseFont(bytes) {
  const tables = sfntTables(bytes);
  const need = (/** @type {string} */ tg, /** @type {number} */ min) => {
    const x = tables.get(tg);
    if (!x) throw broken(`no ${tg} table`);
    if (x.length < min) throw broken(`the ${tg} table is too short`);
    return view(x);
  };
  const head = need('head', 54), hhea = need('hhea', 36), maxp = need('maxp', 6), cmap = need('cmap', 4);
  const os2 = tables.get('OS/2')?.length >= 10 ? view(/** @type {Uint8Array} */ (tables.get('OS/2'))) : null;
  const post = tables.get('post')?.length >= 16 ? view(/** @type {Uint8Array} */ (tables.get('post'))) : null;
  const unitsPerEm = head.getUint16(18);
  if (unitsPerEm < 16 || unitsPerEm > 16384) throw broken(`unitsPerEm ${unitsPerEm} is outside 16–16384`);
  const numGlyphs = maxp.getUint16(4);
  if (!numGlyphs) throw broken('it has no glyphs');
  const nh = hhea.getUint16(34);
  if (!nh || nh > numGlyphs) throw broken(`numberOfHMetrics ${nh} does not fit ${numGlyphs} glyphs`);
  const hmtx = need('hmtx', 4 * nh);
  const advance = (/** @type {number} */ g) => (g < numGlyphs ? hmtx.getUint16(4 * Math.min(g, nh - 1)) : 0);
  const cff = tables.has('CFF ') || tables.has('CFF2');
  if (!cff && !(tables.has('glyf') && tables.has('loca'))) throw broken('no glyf/loca and no CFF table');
  if (!cff) checkLoca(/** @type {Uint8Array} */ (tables.get('loca')), head.getInt16(50), numGlyphs, /** @type {Uint8Array} */ (tables.get('glyf')).length);
  const lookup = cmapLookup(cmap);
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
    /** @param {number} cp @returns {number} its glyph ID, 0 when none (or when the cmap points past the glyphs) */
    glyphFor: (cp) => { const g = lookup(cp); return g < numGlyphs ? g : 0; },
  };
}

/**
 * loca must have numGlyphs + 1 offsets in its format, rising, none past glyf: then every glyph's bytes lie inside glyf.
 * @param {Uint8Array} loca @param {number} format @param {number} n @param {number} glyfLength
 */
export function checkLoca(loca, format, n, glyfLength) {
  if (format !== 0 && format !== 1) throw broken(`indexToLocFormat ${format} is neither 0 nor 1`);
  const lv = view(loca), size = format ? 4 : 2;
  if (loca.length < (n + 1) * size) throw broken(`loca has room for fewer than ${n + 1} offsets`);
  let prev = 0;
  for (let g = 0; g <= n; g++) {
    const at = format ? lv.getUint32(g * 4) : lv.getUint16(g * 2) * 2;
    if (at < prev) throw broken(`loca goes backwards at glyph ${g}`);
    if (at > glyfLength) throw broken(`loca points past the end of glyf at glyph ${g}`);
    prev = at;
  }
}

/** @param {Uint8Array | undefined} nm the name table → its PostScript name (nameID 6), as written there (untrusted) */
function psName(nm) {
  if (!nm || nm.length < 6) return 'Font';
  const dv = view(nm), count = Math.min(dv.getUint16(2), Math.floor((nm.length - 6) / 12)), store = dv.getUint16(4);
  for (let i = 0; i < count; i++) {
    const p = 6 + 12 * i;
    if (dv.getUint16(p + 6) !== 6) continue;
    const platform = dv.getUint16(p), len = dv.getUint16(p + 8), off = store + dv.getUint16(p + 10);
    const b = nm.subarray(off, off + len);
    let s = '';
    if (platform === 1) for (const c of b) s += String.fromCharCode(c);
    else for (let k = 0; k + 1 < b.length; k += 2) s += String.fromCharCode((b[k] << 8) | b[k + 1]);
    if (s) return s.slice(0, 127); // raw: pdfName sanitises it where it is written
  }
  return 'Font';
}

/** code point → glyph ID (0: none), from the best Unicode subtable (format 12, else 4) @param {DataView} dv */
function cmapLookup(dv) {
  const L = dv.byteLength;
  const n = Math.min(dv.getUint16(2), Math.floor((L - 4) / 8));
  /** @type {{ score: number, off: number }} */
  let best = { score: 0, off: 0 };
  for (let i = 0; i < n; i++) {
    const pid = dv.getUint16(4 + i * 8), eid = dv.getUint16(6 + i * 8), off = dv.getUint32(8 + i * 8);
    if (off + 16 > L) continue; // a subtable outside cmap is ignored
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
    if (o + 16 + groups * 12 > L) throw broken('its cmap (format 12) runs past the table');
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
  if (!segs || ranges + segs * 2 > L) throw broken('its cmap (format 4) runs past the table');
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
