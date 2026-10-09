// @ts-check
/**
 * Text, read: text strings (UTF-16BE, UTF-8 with its BOM, PDFDocEncoding) and page.extractText(): the content stream's
 * text operators in order, each code mapped to Unicode by the font's ToUnicode CMap, else its encoding (WinAnsi,
 * MacRoman, Standard, Differences with glyph names), placed with the text and graphics matrices, and grouped into lines
 * (a new line when the baseline moves by half the font size; a space when the gap is a quarter of it, or a TJ
 * adjustment is that wide). A marked-content span with /ActualText reads as that text, in place of its glyphs. A code
 * the font gives no Unicode for (no ToUnicode entry, no encoding or glyph name) reads as U+FFFD, never dropped; one
 * mapped to nothing on purpose (an empty ToUnicode entry) reads as nothing. Right-to-left letters drawn in visual
 * order are put back in logical order within a line (a run of them, with the spaces and numbers between, reversed;
 * numbers kept left to right). NOT layout-perfect: no columns, no reading order beyond the stream's, no full UAX #9.
 *
 * HOSTILE input: operators are read with the reader's lexer (no recursion), form XObjects on an explicit stack at most
 * MAX_FORMS deep and never re-entered while open, CMaps capped at MAX_CMAP entries and ranges at 65,536 codes,
 * inline image data skipped by its EI, every operator a budget step. A CMap destination longer than MAX_DST bytes is
 * skipped (the spec's limit is 512; real ones are a few characters), every character a CMap makes counts against
 * MAX_CMAP_CHARS for it and MAX_HELD for the extraction (E_BUDGET), and a range's every code is a budget step: an
 * 831-byte file cannot make 65,536 copies of a 20 KB string.
 */
import { Lexer, parseValue, PdfString, PdfStream, Op, T, indexOf } from './lexer.js';
import { ENCODINGS, METRICS } from '../fonts/standard-metrics.js';
import { PdfReadError, fail } from './budget.js';
import { parseFont } from '../fonts/truetype.js';

export const MAX_FORMS = 16, MAX_CMAP = 1_000_000;
/** marked-content sequences open at once that are tracked (deeper ones are counted, not read) */
const MAX_MARKS = 1000;
/** the longest /ActualText read (UTF-16 units), and the characters one page's extraction may make in all */
export const MAX_ACTUAL = 4096, MAX_TEXT_CHARS = 16_000_000;
/** a CMap destination's bytes (64 UTF-16 code units), the characters one CMap makes, and what one extraction's fonts hold (an entry 8, a character 1) */
export const MAX_DST = 128, MAX_CMAP_CHARS = 4_000_000, MAX_HELD = 16_000_000;
/** the widths a CIDFont's /W may set in all (a font has at most 65,536 CIDs) */
export const MAX_W = 1_000_000;
/** form XObjects a page's extraction may draw (each one's data is decoded and read again), and its time when the document has none */
export const MAX_DO = 10_000, TEXT_TIMEOUT_MS = 30_000;

const DOC = new Map([[0x18, 0x02d8], [0x19, 0x02c7], [0x1a, 0x02c6], [0x1b, 0x02d9], [0x1c, 0x02dd], [0x1d, 0x02db], [0x1e, 0x02da], [0x1f, 0x02dc],
  [0x80, 0x2022], [0x81, 0x2020], [0x82, 0x2021], [0x83, 0x2026], [0x84, 0x2014], [0x85, 0x2013], [0x86, 0x0192], [0x87, 0x2044], [0x88, 0x2039], [0x89, 0x203a],
  [0x8a, 0x2212], [0x8b, 0x2030], [0x8c, 0x201e], [0x8d, 0x201c], [0x8e, 0x201d], [0x8f, 0x2018], [0x90, 0x2019], [0x91, 0x201a], [0x92, 0x2122], [0x93, 0xfb01],
  [0x94, 0xfb02], [0x95, 0x0141], [0x96, 0x0152], [0x97, 0x0160], [0x98, 0x0178], [0x99, 0x017d], [0x9a, 0x0131], [0x9b, 0x0142], [0x9c, 0x0153], [0x9d, 0x0161],
  [0x9e, 0x017e], [0xa0, 0x20ac]]);

/** a text string (Info, outline titles, field values): UTF-16BE or UTF-8 by their BOM, else PDFDocEncoding @param {any} v */
export function decodeText(v) {
  if (!(v instanceof PdfString)) return typeof v === 'string' ? v : v == null ? '' : String(v);
  const b = v.bytes;
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    let s = '';
    for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
    return s;
  }
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder().decode(b.subarray(3));
  let s = '';
  for (const x of b) s += String.fromCharCode(DOC.get(x) ?? x);
  return s;
}

// ---- encodings ----
const WIN = new Map(); { const p = ENCODINGS.WinAnsi; for (let i = 0; i < p.length; i += 2) WIN.set(p[i + 1], p[i]); WIN.set(0xad, 0xad); }
const MAC_HIGH = 'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';
/** @type {Record<string, (c: number) => number | undefined>} */
const BASE = {
  WinAnsiEncoding: (c) => WIN.get(c) ?? (c >= 32 && c < 127 ? c : undefined),
  MacRomanEncoding: (c) => (c >= 128 ? MAC_HIGH.codePointAt(c - 128) : c >= 32 && c < 127 ? c : undefined),
  StandardEncoding: (c) => (c === 0x27 ? 0x2019 : c === 0x60 ? 0x2018 : c >= 32 && c < 127 ? c : STD_HIGH.get(c)),
  PDFDocEncoding: (c) => DOC.get(c) ?? c,
};
const STD_HIGH = new Map([[0xa1, 0xa1], [0xa2, 0xa2], [0xa3, 0xa3], [0xa5, 0xa5], [0xa7, 0xa7], [0xa9, 0x27], [0xaa, 0x201c], [0xab, 0xab], [0xae, 0xfb01], [0xaf, 0xfb02],
  [0xb1, 0x2013], [0xb2, 0x2020], [0xb3, 0x2021], [0xb4, 0xb7], [0xb6, 0xb6], [0xb7, 0x2022], [0xba, 0x201d], [0xbb, 0xbb], [0xbc, 0x2026], [0xbd, 0x2030], [0xbf, 0xbf],
  [0xd0, 0x2014], [0xe1, 0xc6], [0xe8, 0x141], [0xe9, 0xd8], [0xea, 0x152], [0xf1, 0xe6], [0xf5, 0x131], [0xf8, 0x142], [0xf9, 0xf8], [0xfa, 0x153], [0xfb, 0xdf]]);

const NAMES = /** @type {Record<string, string>} */ ({
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: "'", quoteright: '’', quoteleft: '‘',
  parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-', minus: '−', period: '.', slash: '/', colon: ':', semicolon: ';', less: '<',
  equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_', grave: '`',
  braceleft: '{', bar: '|', braceright: '}', asciitilde: '~', bullet: '•', endash: '–', emdash: '—', quotedblleft: '“', quotedblright: '”', quotesinglbase: '‚',
  quotedblbase: '„', ellipsis: '…', fi: 'ﬁ', fl: 'ﬂ', dagger: '†', daggerdbl: '‡', Euro: '€', trademark: '™', copyright: '©', registered: '®', degree: '°',
  section: '§', paragraph: '¶', germandbls: 'ß', ae: 'æ', AE: 'Æ', oslash: 'ø', Oslash: 'Ø', eth: 'ð', Eth: 'Ð', thorn: 'þ', Thorn: 'Þ', lslash: 'ł', Lslash: 'Ł',
  oe: 'œ', OE: 'Œ', dotlessi: 'ı', sterling: '£', yen: '¥', cent: '¢', currency: '¤', florin: 'ƒ', guillemotleft: '«', guillemotright: '»', guilsinglleft: '‹',
  guilsinglright: '›', periodcentered: '·', multiply: '×', divide: '÷', plusminus: '±', exclamdown: '¡', questiondown: '¿', ordfeminine: 'ª', ordmasculine: 'º',
  mu: 'µ', perthousand: '‰', nbspace: ' ', zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
});
const ACCENT = /** @type {Record<string, string>} */ ({ acute: '́', grave: '̀', circumflex: '̂', tilde: '̃', dieresis: '̈', ring: '̊', cedilla: '̧', caron: '̌' });
/** a table's own value for a key from the file, never an inherited one (constructor, __proto__, toString) @param {object} t @param {any} k @returns {any} */
export const own = (t, k) => (typeof k === 'string' && Object.hasOwn(t, k) ? /** @type {any} */ (t)[k] : undefined);
const STD_ALIAS = { Arial: 'Helvetica', 'Arial-BoldMT': 'Helvetica-Bold', ArialMT: 'Helvetica', TimesNewRoman: 'Times-Roman', TimesNewRomanPSMT: 'Times-Roman', CourierNew: 'Courier' };
/** a glyph name → its text @param {string} n */
export function glyphText(n) {
  if (Object.hasOwn(NAMES, n)) return NAMES[n];
  if (n.length === 1) return n;
  let m = /^uni([0-9A-Fa-f]{4})+$/.exec(n);
  if (m) { let s = ''; for (let i = 3; i + 4 <= n.length; i += 4) s += String.fromCharCode(parseInt(n.slice(i, i + 4), 16)); return s; }
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(n);
  if (m) { const c = parseInt(m[1], 16); return c <= 0x10ffff ? String.fromCodePoint(c) : ''; }
  m = /^([A-Za-z])(acute|grave|circumflex|tilde|dieresis|ring|cedilla|caron)$/.exec(n);
  if (m) return (m[1] + ACCENT[m[2]]).normalize('NFC');
  const dot = n.indexOf('.'); // "a.sc", "f_i"
  if (dot > 0) return glyphText(n.slice(0, dot));
  if (n.includes('_')) return n.split('_').map(glyphText).join('');
  return '';
}

/**
 * A ToUnicode (or encoding) CMap: code → text, and the code lengths its codespace ranges allow. held: what the
 * extraction holds so far (characters and entries), shared by its fonts.
 * @param {Uint8Array} data @param {import('./budget.js').Budget} budget @param {{ n: number }} [held]
 */
export function parseCMap(data, budget, held = { n: 0 }) {
  /** @type {Map<number, string>} */
  const map = new Map();
  /** @type {[number, number, number][]} [length, lo, hi] */
  const spaces = [];
  const lx = new Lexer(data, budget);
  const code = (/** @type {PdfString} */ s) => { let v = 0; for (const b of s.bytes.subarray(0, 4)) v = v * 256 + b; return v; };
  // one flat string (a += loop makes a rope of a node per character: 30 times the memory)
  const utf16 = (/** @type {Uint8Array} */ b) => { if (b.length === 1) return String.fromCharCode(b[0]); const u = []; for (let i = 0; i + 1 < b.length; i += 2) u.push((b[i] << 8) | b[i + 1]); return String.fromCharCode(...u); };
  let chars = 0;
  /** code → text, every character counted (made, not only stored: a code set twice counts twice) @param {number} c @param {string} t */
  const set = (c, t) => {
    chars += t.length; held.n += 8 + t.length;
    if (chars > MAX_CMAP_CHARS) fail('E_BUDGET', `A CMap maps codes to more than ${MAX_CMAP_CHARS.toLocaleString('en')} characters`);
    if (held.n > MAX_HELD) fail('E_BUDGET', `A page's fonts hold more than ${MAX_HELD.toLocaleString('en')} units of code mappings (an entry 8, a character 1)`);
    map.set(c, t);
  };
  const long = (/** @type {any} */ d) => d instanceof PdfString && d.bytes.length > MAX_DST;
  for (;;) {
    const k = lx.next();
    if (k === T.EOF) break;
    if (k !== T.KW) continue;
    const w = lx.val;
    if (w === 'begincodespacerange') {
      for (;;) {
        const a = parseValue(lx); if (!(a instanceof PdfString)) break;
        const b = parseValue(lx); if (!(b instanceof PdfString)) break;
        if (spaces.length < 100 && a.bytes.length >= 1 && a.bytes.length <= 4) spaces.push([a.bytes.length, code(a), code(b)]); // codes are 1–4 bytes
      }
    } else if (w === 'beginbfchar') {
      for (;;) {
        const a = parseValue(lx); if (!(a instanceof PdfString)) break;
        const b = parseValue(lx);
        if (map.size < MAX_CMAP && !long(b)) set(code(a), b instanceof PdfString ? utf16(b.bytes) : typeof b === 'string' ? glyphText(b) : '');
      }
    } else if (w === 'beginbfrange') {
      for (;;) {
        const a = parseValue(lx); if (!(a instanceof PdfString)) break;
        const b = parseValue(lx); if (!(b instanceof PdfString)) break;
        const d = parseValue(lx);
        const lo = code(a), hi = Math.min(code(b), lo + 65535);
        if (long(d)) continue; // past any real destination: skipped, never copied per code
        budget.tick(1 + Math.max(0, hi - lo)); // every code a step
        for (let c = lo, i = 0; c <= hi && map.size < MAX_CMAP; c++, i++) {
          if (Array.isArray(d)) { const x = d[i]; if (x instanceof PdfString && !long(x)) set(c, utf16(x.bytes)); else if (i >= d.length) break; }
          else if (d instanceof PdfString && d.bytes.length) {
            const t = d.bytes.slice(), L = t.length; // the last 16 bits count up
            if (L >= 2) { const v = ((t[L - 2] << 8) | t[L - 1]) + i; t[L - 2] = (v >> 8) & 255; t[L - 1] = v & 255; } else t[0] += i;
            set(c, utf16(t));
          }
        }
      }
    }
  }
  return { map, spaces };
}

/** what a code with no Unicode reads as */
const NONE = '\ufffd';
/** @typedef {(text: string, w: number, space: boolean) => void} Emit a glyph: its text, its width in 1/1000 of the size, a space */
/** a budget error (time, abort, a cap): never swallowed as a broken font @param {any} e */
const stops = (e) => e?.code === 'E_TIMEOUT' || e?.code === 'E_ABORTED' || e?.code === 'E_BUDGET';

/**
 * A font as the extractor needs it: decode(bytes) → [{ text, w, space }] (w: width in 1/1000 of the size).
 * @param {any} src the source @param {Map<string, any>} font
 */
function fontOf(src, font, held = /** @type {Held} */ ({ n: 0, cmaps: new Map() })) {
  const R = src.resolve;
  const sub = R(font.get('Subtype'));
  let toU = null, spaces = /** @type {[number, number, number][]} */ ([]);
  const tu = R(font.get('ToUnicode'));
  if (tu instanceof PdfStream) { try { ({ map: toU, spaces } = parseCMap(src.decodeStream(tu).data, src.budget, held)); } catch (e) { if (stops(e)) throw e; } }
  if (sub === 'Type0') {
    const enc = R(font.get('Encoding'));
    if (enc instanceof PdfStream && !spaces.length) { try { spaces = parseCMap(src.decodeStream(enc).data, src.budget, held).spaces; } catch (e) { if (stops(e)) throw e; /* the default: 2 bytes */ } }
    const dsc = R(font.get('DescendantFonts')), cid = R(Array.isArray(dsc) ? dsc[0] : null);
    const dw = cid instanceof Map && typeof R(cid.get('DW')) === 'number' ? R(cid.get('DW')) : 1000;
    /** @type {Map<number, number>} */
    const W = new Map();
    const w = cid instanceof Map ? R(cid.get('W')) : null;
    if (Array.isArray(w)) {
      // every code set is a budget step, and the codes set over the whole /W are capped (MAX_W), not only the distinct
      // ones: "0 65535 500" repeated sets the same 65,536 codes again each time, which W.size never sees
      let made = 0;
      const step = (/** @type {number} */ n) => {
        made += n; held.n += 8 * n; src.budget.tick(n);
        if (made > MAX_W) fail('E_BUDGET', `A CIDFont's /W sets more than ${MAX_W.toLocaleString('en')} widths`);
        if (held.n > MAX_HELD) fail('E_BUDGET', `A page's fonts hold more than ${MAX_HELD.toLocaleString('en')} units of code mappings (an entry 8, a character 1)`);
      };
      for (let i = 0; i < w.length && W.size < MAX_CMAP;) {
        const a = R(w[i]), b = R(w[i + 1]);
        if (!Number.isInteger(a)) { step(1); i++; continue; }
        if (Array.isArray(b)) { step(1 + b.length); for (let k = 0; k < b.length && W.size < MAX_CMAP; k++) W.set(a + k, R(b[k])); i += 2; }
        else { const c = R(w[i + 2]), hi = typeof b === 'number' ? Math.min(b, a + 65535) : a - 1; step(1 + Math.max(0, hi - a + 1)); for (let k = a; k <= hi && W.size < MAX_CMAP; k++) W.set(k, c); i += 3; }
      }
    }
    const lens = spaces.length ? [...new Set(spaces.map((s) => s[0]))].sort() : [2];
    // no ToUnicode entry: an embedded TrueType font's own cmap, read backwards (glyph → character), through the
    // CIDToGIDMap (as MuPDF and PDFBox do: an Identity-H font with no ToUnicode is otherwise no text at all)
    /** @type {Map<number, string> | null | undefined} */
    let back;
    const fromFont = (/** @type {number} */ c) => {
      if (back === undefined) back = fontCmap(src, cid, held);
      if (!back) return undefined;
      const m = cid instanceof Map ? R(cid.get('CIDToGIDMap')) : null;
      let g = c;
      if (m instanceof PdfStream) {
        if (!gidMap) { try { gidMap = src.decodeStream(m).data.slice(0, 0x20000); } catch (e) { if (stops(e)) throw e; gidMap = new Uint8Array(0); } } // 65,536 CIDs at most
        g = 2 * c + 1 < gidMap.length ? (gidMap[2 * c] << 8) | gidMap[2 * c + 1] : 0;
      }
      return back.get(g);
    };
    /** @type {Uint8Array | undefined} */
    let gidMap;
    return {
      /** each glyph to emit, none held (a 16 MB string is not 16 M objects) @param {Uint8Array} b @param {Emit} emit */
      decode(b, emit) {
        for (let i = 0; i < b.length;) {
          let L = lens[lens.length - 1], c = 0;
          for (const l of lens) { // the shortest length whose range holds the code
            let v = 0; for (let k = 0; k < l && i + k < b.length; k++) v = v * 256 + b[i + k];
            if (!spaces.length || spaces.some((s) => s[0] === l && v >= s[1] && v <= s[2])) { L = l; break; }
          }
          for (let k = 0; k < L && i + k < b.length; k++) c = c * 256 + b[i + k];
          i += L;
          emit(toU?.get(c) ?? fromFont(c) ?? NONE, W.get(c) ?? dw, false);
        }
      },
    };
  }
  // a simple font: one byte a code
  const fc = R(font.get('FirstChar')), widths = R(font.get('Widths'));
  let scale = 1;
  if (sub === 'Type3') { const m = R(font.get('FontMatrix')); if (Array.isArray(m) && typeof R(m[0]) === 'number') scale = R(m[0]) * 1000; }
  const base = String(R(font.get('BaseFont')) ?? '').replace(/^[A-Z]{6}\+/, '');
  // tables keyed by names from the file: own keys only (a /BaseFont /__proto__ is not Object.prototype)
  const std = own(METRICS, base) ?? own(METRICS, own(STD_ALIAS, base) ?? '');
  const enc = R(font.get('Encoding'));
  const baseName = typeof enc === 'string' ? enc : enc instanceof Map && typeof R(enc.get('BaseEncoding')) === 'string' ? R(enc.get('BaseEncoding')) : base === 'Symbol' || base === 'ZapfDingbats' ? null : sub === 'TrueType' ? 'WinAnsiEncoding' : 'StandardEncoding';
  const baseFn = own(BASE, baseName) ?? BASE.StandardEncoding;
  /** @type {Map<number, string>} */
  const diff = new Map();
  const d = enc instanceof Map ? R(enc.get('Differences')) : null;
  if (Array.isArray(d)) { let c = 0; for (const x0 of d.slice(0, 4096)) { const x = R(x0); if (typeof x === 'number') c = x; else if (typeof x === 'string') diff.set(c++ & 255, x === '.notdef' ? '' : glyphText(x) || NONE); } } // .notdef: nothing, on purpose
  const symbolic = base === 'Symbol' || base === 'ZapfDingbats';
  const symMap = symbolic ? new Map() : null;
  if (symMap) { const p = /** @type {any} */ (ENCODINGS)[base]; for (let i = 0; i < p.length; i += 2) symMap.set(p[i + 1], p[i]); }
  return {
    /** @param {Uint8Array} b @param {Emit} emit */
    decode(b, emit) {
      for (const c of b) {
        let t = toU?.get(c);
        if (t === undefined) t = diff.get(c);
        if (t === undefined) { const u = symMap ? symMap.get(c) : baseFn(c); t = u === undefined ? NONE : String.fromCodePoint(u); }
        let w = Array.isArray(widths) && typeof fc === 'number' && c >= fc && c - fc < widths.length ? R(widths[c - fc]) : std ? std.widths[c] : 500;
        if (typeof w !== 'number' || !Number.isFinite(w)) w = 0;
        emit(t, w * scale, c === 32);
      }
    },
  };
}

/** the font programs whose cmap one extraction may read backwards */
export const MAX_CMAP_FONTS = 100;
/**
 * @typedef {{ n: number, cmaps: Map<any, Map<number, string> | null> }} Held what an extraction's fonts hold (entries
 *   and characters, against MAX_HELD) and the reversed cmaps read, by font program (read once however many fonts share it)
 */
/**
 * A CIDFontType2's embedded font's cmap, backwards: glyph → the lowest character mapped to it (private-use ones left
 * out), or null (no font, CFF, no Unicode cmap, broken). Read with the writer's TrueType parser (fonts/truetype.js):
 * the font program's bytes count against maxDecoded, every BMP code point is a lookup and a budget step, each entry
 * counts against MAX_HELD, and an extraction reads at most MAX_CMAP_FONTS font programs (E_BUDGET past it).
 * @param {any} src @param {any} cid the CIDFont dictionary @param {Held} held @returns {Map<number, string> | null}
 */
function fontCmap(src, cid, held) {
  const R = src.resolve;
  if (!(cid instanceof Map) || R(cid.get('Subtype')) !== 'CIDFontType2') return null;
  const fd = R(cid.get('FontDescriptor')), ff = fd instanceof Map ? R(fd.get('FontFile2')) : null;
  if (!(ff instanceof PdfStream)) return null;
  const was = held.cmaps.get(ff);
  if (was !== undefined) return was;
  if (held.cmaps.size >= MAX_CMAP_FONTS) fail('E_BUDGET', `A page's text reads the character maps of more than ${MAX_CMAP_FONTS} embedded fonts (fonts with no ToUnicode)`);
  held.cmaps.set(ff, null);
  let f;
  try { f = parseFont(src.decodeStream(ff).data); } catch (e) { if (stops(e)) throw e; return null; }
  src.budget.tick(0x10000);
  /** @type {Map<number, string>} */
  const back = new Map();
  for (let cp = 0x20; cp <= 0xffff; cp++) { // at most 63,456 entries
    if (cp === 0xd800) cp = 0xf900; // no surrogates, no private use
    const g = f.glyphFor(cp);
    if (g && !back.has(g)) back.set(g, String.fromCharCode(cp));
  }
  held.n += 9 * back.size;
  if (held.n > MAX_HELD) fail('E_BUDGET', `A page's fonts hold more than ${MAX_HELD.toLocaleString('en')} units of code mappings (an entry 8, a character 1)`);
  held.cmaps.set(ff, back);
  return back;
}

/** @typedef {[number, number, number, number, number, number]} M */
const mul = (/** @type {M} */ A, /** @type {M} */ B) => /** @type {M} */ ([A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3], A[4] * B[0] + A[5] * B[2] + B[4], A[4] * B[1] + A[5] * B[3] + B[5]]);
const ID = /** @type {M} */ ([1, 0, 0, 1, 0, 0]);
const matrixOf = (/** @type {any[]} */ a) => (a.length >= 6 && a.slice(0, 6).every((x) => typeof x === 'number' && Number.isFinite(x)) ? /** @type {M} */ (a.slice(0, 6)) : null);

/** the content of a stream or an array of them, decoded and joined @param {any} src @param {any} contents */
export function contentBytes(src, contents) {
  const c = src.resolve(contents);
  const list = Array.isArray(c) ? c.slice(0, 10_000).map(src.resolve) : [c];
  const parts = [];
  for (const s of list) if (s instanceof PdfStream) { try { parts.push(src.decodeStream(s).data); } catch (e) { if (/** @type {any} */ (e)?.code !== 'E_MALFORMED' && /** @type {any} */ (e)?.code !== 'E_UNSUPPORTED') throw e; } }
  let n = parts.length; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); n = 0;
  for (const p of parts) { out.set(p, n); n += p.length; out[n++] = 10; }
  return out;
}

const RTL = /[\u0590-\u05ff\u0600-\u065f\u066a-\u06ef\u06fa-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/, STRONG_L = /[\p{L}]/u, NUM = /^[\p{Nd}.,٫٬]+$/u;
/**
 * A line's parts from visual order to logical: each run of right-to-left parts (with the neutral parts and numbers
 * between them) reversed, character by character as pdf.js and poppler do (a glyph's text there is in visual order:
 * a ligature of lam and alef maps to "ال"), a number in it kept left to right. ponytail: not UAX #9 (no embedding levels, no mirroring),
 * enough for right-to-left text drawn in visual order as shaping writers draw it.
 * @param {string[]} parts
 */
const rev = (/** @type {string} */ t) => [...t].reverse().join('');
export function logical(parts) {
  if (!parts.some((t) => RTL.test(t))) return parts;
  const kind = (/** @type {string} */ t) => (RTL.test(t) ? 'R' : NUM.test(t) ? 'N' : STRONG_L.test(t) ? 'L' : 'N');
  const k = parts.map(kind), res = parts.slice();
  for (let i = 0; i < parts.length;) {
    if (k[i] !== 'R') { i++; continue; }
    let j = i, e = i; // the run: R and neutral parts, ending at its last R
    while (j < parts.length && k[j] !== 'L') { if (k[j] === 'R') e = j; j++; }
    const run = parts.slice(i, e + 1).reverse().map(rev);
    for (let a = 0; a < run.length;) { // numbers back to left to right
      if (!NUM.test(run[a])) { a++; continue; }
      let b = a; while (b < run.length && NUM.test(run[b])) b++;
      run.splice(a, b - a, ...run.slice(a, b).reverse().map(rev)); a = b;
    }
    res.splice(i, run.length, ...run);
    i = e + 1;
  }
  return res;
}

/** skip an inline image's data: after ID, up to "EI" between white space @param {Lexer} lx */
function skipInline(lx) {
  const b = lx.buf;
  let i = lx.pos + 1;
  for (;;) {
    const e = indexOf(b, 'EI', i, lx.end);
    if (e < 0) { lx.pos = lx.end; return; }
    const before = b[e - 1], after = b[e + 2];
    if ((before === 32 || before === 10 || before === 13 || before === 9) && (e + 2 >= lx.end || after === 32 || after === 10 || after === 13 || after === 9)) { lx.pos = e + 2; return; }
    i = e + 2;
  }
}

/**
 * The text of a page, in content order, in lines. timeoutMs: this extraction's time (TEXT_TIMEOUT_MS by default, or
 * the document's timeoutMs when sooner): a page with no time limit is not unbounded. @param {any} src
 * @param {Map<string, any>} pageDict @param {any} resources @param {{ timeoutMs?: number }} [o] @returns {string}
 */
export function extractText(src, pageDict, resources, o = {}) {
  if (o == null || typeof o !== 'object') throw new TypeError('extractText: options are { timeoutMs }');
  for (const k of Object.keys(o)) if (k !== 'timeoutMs') throw new TypeError(`extractText: unknown option ${JSON.stringify(k.slice(0, 40))} (timeoutMs)`);
  const ms = o.timeoutMs ?? TEXT_TIMEOUT_MS;
  if (typeof ms !== 'number' || !(ms > 0)) throw new TypeError('extractText: timeoutMs is a number above 0 (Infinity: no limit but the document\'s)');
  return src.budget.within(ms, () => pageText(src, pageDict, resources));
}

/**
 * Where a page's text is: { x, y, end, size, text } in user space (the baseline start and end), in content order,
 * under the same budget and default time as extractText. @param {any} src @param {Map<string, any>} pageDict
 * @param {any} resources @param {{ timeoutMs?: number }} [o]
 */
export function textPieces(src, pageDict, resources, o = {}) {
  return src.budget.within(o.timeoutMs ?? TEXT_TIMEOUT_MS, () => pageText(src, pageDict, resources, true));
}

/** @param {any} src @param {Map<string, any>} pageDict @param {any} resources @param {boolean} [raw] the pieces, not joined @returns {any} */
function pageText(src, pageDict, resources, raw = false) {
  const R = src.resolve, budget = src.budget;
  // the pieces, a column each (numbers in packed arrays, no object a piece: 2 M pieces were 450 MB as objects)
  /** @type {number[]} */ const PX = [], PY = [], PE = [], PS = [], PG = [];
  // and along the text's direction: where it starts and ends along the baseline, the baseline across, the direction
  /** @type {number[]} */ const PA = [], PAE = [], PC = [], PD = [];
  /** @type {string[]} */ const PT = [];
  let chars = 0; // the characters made, ActualText included (MAX_TEXT_CHARS)
  let moved = true; // the text was positioned (BT, Td, Tm, T*) since the last piece: the next starts a new object
  /** @type {Map<any, any>} */
  const fonts = new Map();
  /**
   * a piece of text, counted against the budget @param {number} x @param {number} y @param {number} end
   * @param {number} size @param {string} text @param {number[]} dir [along start, along end, across, direction]
   */
  const add = (x, y, end, size, text, dir) => {
    if (PT.length >= budget.maxTextItems) throw new PdfReadError('E_BUDGET', `A page has more than ${budget.maxTextItems.toLocaleString('en')} pieces of text (budget.maxTextItems)`);
    if ((chars += text.length) > MAX_TEXT_CHARS) throw new PdfReadError('E_BUDGET', `A page makes more than ${MAX_TEXT_CHARS.toLocaleString('en')} characters of text`);
    PX.push(x); PY.push(y); PE.push(end); PS.push(size); PT.push(text); PG.push(moved ? 2 : 0); moved = false;
    PA.push(dir[0]); PAE.push(dir[1]); PC.push(dir[2]); PD.push(dir[3]);
  };
  const held = /** @type {Held} */ ({ n: 0, cmaps: new Map() }); // what this extraction's fonts hold (MAX_HELD)
  const fontFor = (/** @type {any} */ res, /** @type {string} */ name) => {
    const fd = R(res instanceof Map ? R(res.get('Font')) instanceof Map ? R(res.get('Font')).get(name) : null : null);
    const key = fd instanceof Map ? fd : null;
    if (!key) return null;
    let f = fonts.get(key);
    if (!f) { f = fontOf(src, key, held); fonts.set(key, f); }
    return f;
  };
  /** @type {{ lx: Lexer, res: any, ctm: M, stack: M[], forms: Set<any>, form: any }[]} */
  const frames = [{ lx: new Lexer(contentBytes(src, pageDict.get('Contents')), budget), res: resources, ctm: ID, stack: [], forms: new Set(), form: null }];
  let ts = { font: /** @type {any} */ (null), size: 0, Tc: 0, Tw: 0, Th: 1, TL: 0, Ts: 0 };
  /** @type {any[]} */
  const tsStack = [];
  let Tm = ID, Tlm = ID, dos = 0;
  /** @type {({ at: string, x: number, y: number, end: number, size: number, dir: number[], seen: boolean } | null)[]} marked content: an ActualText span, or null */
  const marks = [];
  let deep = 0, actual = /** @type {any} */ (null); // marks past MAX_MARKS; the open ActualText span (the outermost)
  /** @type {any[]} */
  let args = [];
  const show = (/** @type {Uint8Array} */ b, /** @type {M} */ ctm) => {
    if (!ts.font) return;
    let k = 0;
    ts.font.decode(b, (/** @type {string} */ text, /** @type {number} */ w, /** @type {boolean} */ space) => {
      if ((++k & 1023) === 0) budget.tick(1024); // glyphs are steps: a 16 MB string is not one
      const M0 = mul([ts.size * ts.Th, 0, 0, ts.size, 0, ts.Ts], mul(Tm, ctm));
      const x = M0[4], y = M0[5], size = Math.hypot(M0[2], M0[3]) || ts.size;
      const tx = ((w / 1000) * ts.size + ts.Tc + (space ? ts.Tw : 0)) * ts.Th;
      Tm = mul([1, 0, 0, 1, tx, 0], Tm);
      const M1 = mul([ts.size * ts.Th, 0, 0, ts.size, 0, ts.Ts], mul(Tm, ctm)), end = M1[4];
      // the direction of the baseline (rotated text reads along it, as pdftotext does)
      const L = Math.hypot(M0[0], M0[1]), ux = L ? M0[0] / L : 1, uy = L ? M0[1] / L : 0;
      const dir = [x * ux + y * uy, M1[4] * ux + M1[5] * uy, y * ux - x * uy, Math.round(Math.atan2(uy, ux) * 180 / Math.PI)];
      if (actual) { if (!actual.seen) Object.assign(actual, { x, y, size, dir, seen: true }); actual.end = end; actual.dir[1] = dir[1]; return; }
      const n = PT.length - 1;
      if (text) add(x, y, end, size, text, dir);
      else if (n >= 0 && PAE[n] < dir[1] && PD[n] === dir[3] && Math.abs(PC[n] - dir[2]) < 0.01) { PE[n] = end; PAE[n] = dir[1]; } // nothing on purpose: its advance is no gap
    });
    budget.tick(1 + (k & 1023));
  };
  while (frames.length) {
    const f = frames[frames.length - 1];
    const v = parseValue(f.lx);
    if (v === undefined) {
      frames.pop();
      if (f.form) { const parent = frames[frames.length - 1]; if (parent) parent.forms.delete(f.form); }
      continue;
    }
    if (!(v instanceof Op)) { if (args.length < 64) args.push(v); continue; }
    budget.tick();
    const op = v.v, a = args; args = [];
    switch (op) {
      case 'q': if (f.stack.length < 1000) f.stack.push(f.ctm); tsStack.push(ts); if (tsStack.length > 1000) tsStack.shift(); break;
      case 'Q': if (f.stack.length) f.ctm = /** @type {M} */ (f.stack.pop()); if (tsStack.length) ts = tsStack.pop(); break;
      case 'cm': { const m = matrixOf(a); if (m) f.ctm = mul(m, f.ctm); break; }
      case 'BT': Tm = Tlm = ID; moved = true; break;
      case 'Tf': ts = { ...ts, font: typeof a[0] === 'string' ? fontFor(f.res, a[0]) : null, size: typeof a[1] === 'number' ? a[1] : 0 }; break;
      case 'Tc': if (typeof a[0] === 'number') ts = { ...ts, Tc: a[0] }; break;
      case 'Tw': if (typeof a[0] === 'number') ts = { ...ts, Tw: a[0] }; break;
      case 'Tz': if (typeof a[0] === 'number') ts = { ...ts, Th: a[0] / 100 }; break;
      case 'TL': if (typeof a[0] === 'number') ts = { ...ts, TL: a[0] }; break;
      case 'Ts': if (typeof a[0] === 'number') ts = { ...ts, Ts: a[0] }; break;
      case 'TD': if (typeof a[1] === 'number') ts = { ...ts, TL: -a[1] }; // falls through
      case 'Td': if (typeof a[0] === 'number' && typeof a[1] === 'number') Tm = Tlm = mul([1, 0, 0, 1, a[0], a[1]], Tlm); moved = true; break;
      case 'Tm': { const m = matrixOf(a); if (m) Tm = Tlm = m; moved = true; break; }
      case 'T*': Tm = Tlm = mul([1, 0, 0, 1, 0, -ts.TL], Tlm); moved = true; break;
      case 'Tj': if (a[0] instanceof PdfString) show(a[0].bytes, f.ctm); break;
      case "'": moved = true; Tm = Tlm = mul([1, 0, 0, 1, 0, -ts.TL], Tlm); if (a[0] instanceof PdfString) show(a[0].bytes, f.ctm); break;
      case '"': if (typeof a[0] === 'number') ts = { ...ts, Tw: a[0] }; if (typeof a[1] === 'number') ts = { ...ts, Tc: a[1] }; Tm = Tlm = mul([1, 0, 0, 1, 0, -ts.TL], Tlm); moved = true; if (a[2] instanceof PdfString) show(a[2].bytes, f.ctm); break;
      case 'TJ':
        if (Array.isArray(a[0])) for (const x of a[0]) {
          if (x instanceof PdfString) show(x.bytes, f.ctm);
          else if (typeof x === 'number') {
            Tm = mul([1, 0, 0, 1, (-x / 1000) * ts.size * ts.Th, 0], Tm);
            if (x < -180 && PT.length) PG[PT.length - 1] |= 1;
          }
        }
        break;
      case 'BMC': case 'BDC': {
        if (marks.length >= MAX_MARKS) { deep++; break; }
        let at = null;
        if (op === 'BDC' && !actual) {
          const pr = a[1] instanceof Map ? a[1] : typeof a[1] === 'string' && f.res instanceof Map ? R(R(f.res.get('Properties')) instanceof Map ? R(f.res.get('Properties')).get(a[1]) : null) : null;
          const t = pr instanceof Map ? R(pr.get('ActualText')) : null;
          // a real one is a word or a cluster: a long one is not read (nor decoded), its glyphs read instead
          if (t instanceof PdfString && t.bytes.length > 2 * MAX_ACTUAL + 2) src.warn(`an /ActualText longer than ${MAX_ACTUAL} characters was ignored`);
          else if (t instanceof PdfString) at = actual = { at: decodeText(t), x: 0, y: 0, end: 0, size: 0, dir: [0, 0, 0, 0], seen: false };
        }
        marks.push(at);
        break;
      }
      case 'EMC': {
        if (deep) { deep--; break; }
        const m = marks.pop();
        if (m && m === actual) { actual = null; if (m.seen && m.at) add(m.x, m.y, m.end, m.size, m.at, m.dir); }
        break;
      }
      case 'BI': { // inline image: its dictionary up to ID, then the data
        for (let k = 0; k < 4096; k++) { const t = parseValue(f.lx); if (t === undefined || (t instanceof Op && t.v === 'ID')) break; }
        skipInline(f.lx);
        break;
      }
      case 'Do': {
        if (typeof a[0] !== 'string' || frames.length >= MAX_FORMS) break;
        const xo = R(f.res instanceof Map ? R(f.res.get('XObject')) : null);
        const ref = xo instanceof Map ? xo.get(a[0]) : null, x = R(ref);
        if (!(x instanceof PdfStream) || R(x.dict.get('Subtype')) !== 'Form' || f.forms.has(x) || frames.some((fr) => fr.form === x)) break;
        if (++dos > MAX_DO) throw new PdfReadError('E_BUDGET', `A page draws form XObjects more than ${MAX_DO.toLocaleString('en')} times`);
        let data;
        try { data = src.decodeStream(x).data; } catch (e) { if (/** @type {any} */ (e)?.code === 'E_MALFORMED' || /** @type {any} */ (e)?.code === 'E_UNSUPPORTED') break; throw e; }
        const m = matrixOf(R(x.dict.get('Matrix')) ?? []) ?? ID;
        f.forms.add(x);
        frames.push({ lx: new Lexer(data, budget), res: R(x.dict.get('Resources')) ?? f.res, ctm: mul(m, f.ctm), stack: [], forms: new Set(), form: x });
        break;
      }
      default:
    }
  }
  if (raw) return PT.map((text, i) => ({ x: PX[i], y: PY[i], end: PE[i], size: PS[i], text, gap: !!(PG[i] & 1) }));
  // lines: in stream order, a new line when the baseline (across the text's direction) moves or the direction turns;
  // a line's pieces in order along it (a glyph drawn after its neighbours, as office suites draw a ₹ from another
  // font, goes back in its place); a space at a gap
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < PT.length;) {
    let j = i + 1;
    while (j < PT.length && PD[j] === PD[j - 1] && Math.abs(PC[j] - PC[j - 1]) <= Math.max(PS[j], PS[j - 1], 1) * 0.5) j++;
    const ix = [];
    for (let k = i; k < j; k++) ix.push(k);
    let sorted = true;
    for (let k = i + 1; k < j && sorted; k++) if (PA[k] < PA[k - 1] - 0.01) sorted = false;
    if (!sorted) ix.sort((a, b) => PA[a] - PA[b]);
    /** @type {string[]} the line's parts, in visual order */
    const line = [];
    let lend = 0, lgap = false, last = '';
    for (const k of ix) {
      const text = PT[k], size = Math.max(PS[k], 1);
      // a space: a wide TJ adjustment, or a gap of a quarter of the size inside a text object, 0.07 of it between two
      // (a spreadsheet's cells "1" and "Alpha", or chart labels, are separate objects a little apart; kerning is inside one)
      if (line.length && last !== ' ' && !text.startsWith(' ') && (lgap || PA[k] - lend > size * (PG[k] & 2 ? 0.07 : 0.25))) line.push(' ');
      line.push(text);
      last = text[text.length - 1];
      lend = Math.max(PAE[k], line.length > 1 ? lend : -Infinity); lgap = !!(PG[k] & 1);
    }
    if (out.length) out.push('\n');
    out.push(logical(line).join(''));
    i = j;
  }
  return out.join('');
}
