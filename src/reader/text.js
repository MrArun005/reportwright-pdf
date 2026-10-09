// @ts-check
/**
 * Text, read: text strings (UTF-16BE, UTF-8 with its BOM, PDFDocEncoding) and page.extractText(): the content stream's
 * text operators in order, each code mapped to Unicode by the font's ToUnicode CMap, else its encoding (WinAnsi,
 * MacRoman, Standard, Differences with glyph names), placed with the text and graphics matrices, and grouped into lines
 * (a new line when the baseline moves by half the font size; a space when the gap is a quarter of it, or a TJ
 * adjustment is that wide). NOT layout-perfect: no columns, no reading order beyond the stream's, no RTL reordering.
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

export const MAX_FORMS = 16, MAX_CMAP = 1_000_000;
/** a CMap destination's bytes (64 UTF-16 code units), the characters one CMap makes, and what one extraction's fonts hold (an entry 8, a character 1) */
export const MAX_DST = 128, MAX_CMAP_CHARS = 4_000_000, MAX_HELD = 16_000_000;
/** the widths a CIDFont's /W may set in all (a font has at most 65,536 CIDs) */
export const MAX_W = 1_000_000;

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
/** a glyph name → its text @param {string} n */
export function glyphText(n) {
  if (NAMES[n]) return NAMES[n];
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

/** a budget error (time, abort, a cap): never swallowed as a broken font @param {any} e */
const stops = (e) => e?.code === 'E_TIMEOUT' || e?.code === 'E_ABORTED' || e?.code === 'E_BUDGET';

/**
 * A font as the extractor needs it: decode(bytes) → [{ text, w, space }] (w: width in 1/1000 of the size).
 * @param {any} src the source @param {Map<string, any>} font
 */
function fontOf(src, font, held = { n: 0 }) {
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
    return {
      /** @param {Uint8Array} b */
      decode(b) {
        const out = [];
        for (let i = 0; i < b.length;) {
          let L = lens[lens.length - 1], c = 0;
          for (const l of lens) { // the shortest length whose range holds the code
            let v = 0; for (let k = 0; k < l && i + k < b.length; k++) v = v * 256 + b[i + k];
            if (!spaces.length || spaces.some((s) => s[0] === l && v >= s[1] && v <= s[2])) { L = l; break; }
          }
          for (let k = 0; k < L && i + k < b.length; k++) c = c * 256 + b[i + k];
          i += L;
          out.push({ text: toU?.get(c) ?? '', w: W.get(c) ?? dw, space: false });
        }
        return out;
      },
    };
  }
  // a simple font: one byte a code
  const fc = R(font.get('FirstChar')), widths = R(font.get('Widths'));
  let scale = 1;
  if (sub === 'Type3') { const m = R(font.get('FontMatrix')); if (Array.isArray(m) && typeof R(m[0]) === 'number') scale = R(m[0]) * 1000; }
  const base = String(R(font.get('BaseFont')) ?? '').replace(/^[A-Z]{6}\+/, '');
  const std = /** @type {any} */ (METRICS)[base] ?? /** @type {any} */ (METRICS)[{ Arial: 'Helvetica', 'Arial-BoldMT': 'Helvetica-Bold', ArialMT: 'Helvetica', TimesNewRoman: 'Times-Roman', TimesNewRomanPSMT: 'Times-Roman', CourierNew: 'Courier' }[base] ?? ''];
  const enc = R(font.get('Encoding'));
  const baseName = typeof enc === 'string' ? enc : enc instanceof Map && typeof R(enc.get('BaseEncoding')) === 'string' ? R(enc.get('BaseEncoding')) : base === 'Symbol' || base === 'ZapfDingbats' ? null : sub === 'TrueType' ? 'WinAnsiEncoding' : 'StandardEncoding';
  const baseFn = (baseName && BASE[baseName]) || BASE.StandardEncoding;
  /** @type {Map<number, string>} */
  const diff = new Map();
  const d = enc instanceof Map ? R(enc.get('Differences')) : null;
  if (Array.isArray(d)) { let c = 0; for (const x0 of d.slice(0, 4096)) { const x = R(x0); if (typeof x === 'number') c = x; else if (typeof x === 'string') diff.set(c++ & 255, glyphText(x)); } }
  const symbolic = base === 'Symbol' || base === 'ZapfDingbats';
  const symMap = symbolic ? new Map() : null;
  if (symMap) { const p = /** @type {any} */ (ENCODINGS)[base]; for (let i = 0; i < p.length; i += 2) symMap.set(p[i + 1], p[i]); }
  return {
    /** @param {Uint8Array} b */
    decode(b) {
      const out = [];
      for (const c of b) {
        let t = toU?.get(c);
        if (t === undefined) t = diff.get(c);
        if (t === undefined) { const u = symMap ? symMap.get(c) : baseFn(c); t = u === undefined ? '' : String.fromCodePoint(u); }
        let w = Array.isArray(widths) && typeof fc === 'number' && c >= fc && c - fc < widths.length ? R(widths[c - fc]) : std ? std.widths[c] : 500;
        if (typeof w !== 'number' || !Number.isFinite(w)) w = 0;
        out.push({ text: t, w: w * scale, space: c === 32 });
      }
      return out;
    },
  };
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
 * The text of a page, in content order, in lines. @param {any} src @param {Map<string, any>} pageDict @param {any} resources
 * @returns {string}
 */
export function extractText(src, pageDict, resources) {
  const R = src.resolve, budget = src.budget;
  /** @type {{ x: number, y: number, end: number, size: number, text: string, gap: boolean }[]} */
  const pieces = [];
  /** @type {Map<any, any>} */
  const fonts = new Map();
  const held = { n: 0 }; // what this extraction's fonts hold (MAX_HELD)
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
  let Tm = ID, Tlm = ID;
  /** @type {any[]} */
  let args = [];
  const show = (/** @type {Uint8Array} */ b, /** @type {M} */ ctm) => {
    if (!ts.font) return;
    for (const g of ts.font.decode(b)) {
      const M0 = mul([ts.size * ts.Th, 0, 0, ts.size, 0, ts.Ts], mul(Tm, ctm));
      const x = M0[4], y = M0[5], size = Math.hypot(M0[2], M0[3]) || ts.size;
      const tx = ((g.w / 1000) * ts.size + ts.Tc + (g.space ? ts.Tw : 0)) * ts.Th;
      Tm = mul([1, 0, 0, 1, tx, 0], Tm);
      const end = mul([ts.size * ts.Th, 0, 0, ts.size, 0, ts.Ts], mul(Tm, ctm))[4];
      if (g.text) {
        if (pieces.length >= budget.maxTextItems) throw new PdfReadError('E_BUDGET', `A page has more than ${budget.maxTextItems.toLocaleString('en')} pieces of text (budget.maxTextItems)`);
        pieces.push({ x, y, end, size, text: g.text, gap: false });
      }
    }
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
      case 'BT': Tm = Tlm = ID; break;
      case 'Tf': ts = { ...ts, font: typeof a[0] === 'string' ? fontFor(f.res, a[0]) : null, size: typeof a[1] === 'number' ? a[1] : 0 }; break;
      case 'Tc': if (typeof a[0] === 'number') ts = { ...ts, Tc: a[0] }; break;
      case 'Tw': if (typeof a[0] === 'number') ts = { ...ts, Tw: a[0] }; break;
      case 'Tz': if (typeof a[0] === 'number') ts = { ...ts, Th: a[0] / 100 }; break;
      case 'TL': if (typeof a[0] === 'number') ts = { ...ts, TL: a[0] }; break;
      case 'Ts': if (typeof a[0] === 'number') ts = { ...ts, Ts: a[0] }; break;
      case 'TD': if (typeof a[1] === 'number') ts = { ...ts, TL: -a[1] }; // falls through
      case 'Td': if (typeof a[0] === 'number' && typeof a[1] === 'number') Tm = Tlm = mul([1, 0, 0, 1, a[0], a[1]], Tlm); break;
      case 'Tm': { const m = matrixOf(a); if (m) Tm = Tlm = m; break; }
      case 'T*': Tm = Tlm = mul([1, 0, 0, 1, 0, -ts.TL], Tlm); break;
      case 'Tj': if (a[0] instanceof PdfString) show(a[0].bytes, f.ctm); break;
      case "'": Tm = Tlm = mul([1, 0, 0, 1, 0, -ts.TL], Tlm); if (a[0] instanceof PdfString) show(a[0].bytes, f.ctm); break;
      case '"': if (typeof a[0] === 'number') ts = { ...ts, Tw: a[0] }; if (typeof a[1] === 'number') ts = { ...ts, Tc: a[1] }; Tm = Tlm = mul([1, 0, 0, 1, 0, -ts.TL], Tlm); if (a[2] instanceof PdfString) show(a[2].bytes, f.ctm); break;
      case 'TJ':
        if (Array.isArray(a[0])) for (const x of a[0]) {
          if (x instanceof PdfString) show(x.bytes, f.ctm);
          else if (typeof x === 'number') {
            Tm = mul([1, 0, 0, 1, (-x / 1000) * ts.size * ts.Th, 0], Tm);
            if (x < -180 && pieces.length) pieces[pieces.length - 1].gap = true;
          }
        }
        break;
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
  // lines: in stream order; a new line when the baseline moves, a space at a gap
  let out = '', ly = NaN, lend = 0, lsize = 0, lgap = false;
  for (const p of pieces) {
    const tol = Math.max(p.size, lsize, 1) * 0.5;
    if (out && Math.abs(p.y - ly) > tol) out += '\n';
    else if (out && !out.endsWith(' ') && !p.text.startsWith(' ') && (lgap || p.x - lend > Math.max(p.size, 1) * 0.25 || p.x < lend - Math.max(p.size, 1) * 2)) out += ' ';
    out += p.text;
    ly = p.y; lend = p.end; lsize = p.size; lgap = p.gap;
  }
  return out;
}
