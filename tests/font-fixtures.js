// PDFs for the font-coverage tests: a Type 1 font written here (eexec, subrs, flex, seac), bare CFF simple fonts (one
// from pdf.js's standard fonts, one written here with a FontMatrix ≠ 1/1000), Type 3, an embedded CMap with usecmap,
// vertical writing (Identity-V, W2 / DW2) and text render modes 4–7 (clipping).
import fs from 'node:fs';
import zlib from 'node:zlib';
import { rawPdf } from './reader-tools.js';
import { parseFont } from '../src/fonts/truetype.js';

const ROOT = new URL('..', import.meta.url);
export const INTER = fs.readFileSync(new URL('public/fonts/Inter-Regular.ttf', ROOT));
export const FOXIT_SERIF = fs.readFileSync(new URL('node_modules/pdfjs-dist/standard_fonts/FoxitSerif.pfb', ROOT));

const page = (content, resources, objs = [], box = '0 0 300 220') =>
  rawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [${box}] /Contents 4 0 R /Resources ${resources} >>`,
    [`<< /Length ${Buffer.byteLength(content, 'latin1')} >>`, Buffer.from(content, 'latin1')],
    ...objs,
  ]);
const stream = (dict, bytes) => {
  const z = zlib.deflateSync(Buffer.from(bytes));
  return [`<< ${dict} /Filter /FlateDecode /Length ${z.length} >>`, z];
};

// ---- a Type 1 font ----
/** a Type 1 charstring: numbers and operators ('name' or [12, x]) */
function cs(...items) {
  const out = [];
  const OPS = {
    hstem: 1,
    vstem: 3,
    vmoveto: 4,
    rlineto: 5,
    hlineto: 6,
    vlineto: 7,
    rrcurveto: 8,
    closepath: 9,
    callsubr: 10,
    return: 11,
    hsbw: 13,
    endchar: 14,
    rmoveto: 21,
    hmoveto: 22,
    vhcurveto: 30,
    hvcurveto: 31,
    dotsection: [12, 0],
    seac: [12, 6],
    sbw: [12, 7],
    div: [12, 12],
    callothersubr: [12, 16],
    pop: [12, 17],
    setcurrentpoint: [12, 33],
  };
  for (const it of items) {
    if (typeof it === 'number') {
      if (it >= -107 && it <= 107) out.push(it + 139);
      else if (it >= 108 && it <= 1131) out.push(247 + ((it - 108) >> 8), (it - 108) & 255);
      else if (it >= -1131 && it <= -108) out.push(251 + ((-it - 108) >> 8), (-it - 108) & 255);
      else out.push(255, (it >>> 24) & 255, (it >>> 16) & 255, (it >>> 8) & 255, it & 255);
    } else {
      const o = OPS[it];
      if (o === undefined) throw new Error(it);
      out.push(...(Array.isArray(o) ? o : [o]));
    }
  }
  return Uint8Array.from(out);
}
const encrypt = (b, r, lead = 4) => {
  const src = Uint8Array.from([...new Array(lead).fill(0), ...b]);
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const c = src[i] ^ (r >> 8);
    out[i] = c;
    r = ((c + r) * 52845 + 22719) & 0xffff;
  }
  return out;
};
const ascii = (s) => Buffer.from(s, 'latin1');

/** a Type 1 font: glyphs A (lines), O (curves), B (subrs and flex), acute, Aacute (seac), space */
export function type1Font({ matrix = '0.001 0 0 0.001 0 0', encoding = 'StandardEncoding' } = {}) {
  const subrs = [
    cs(3, 0, 'callothersubr', 'pop', 'pop', 'setcurrentpoint', 'return'),
    cs(0, 1, 'callothersubr', 'return'),
    cs(0, 2, 'callothersubr', 'return'),
    cs('return'),
    cs(0, 300, 'rlineto', 'return'), // subr 4: a line used by B
  ];
  const glyphs = {
    '.notdef': cs(0, 500, 'hsbw', 'endchar'),
    space: cs(0, 250, 'hsbw', 'endchar'),
    A: cs(
      20,
      620,
      'hsbw',
      0,
      0,
      'rmoveto',
      290,
      680,
      'rlineto',
      290,
      -680,
      'rlineto',
      -120,
      0,
      'rlineto',
      -170,
      420,
      'rlineto',
      -170,
      -420,
      'rlineto',
      'closepath',
      'endchar',
    ),
    // O: an outer ring by rrcurveto, the hole by hvcurveto / vhcurveto (the other way round)
    O: cs(
      40,
      700,
      'hsbw',
      0,
      340,
      'rmoveto',
      0,
      200,
      140,
      160,
      170,
      0,
      'rrcurveto',
      170,
      0,
      140,
      -160,
      0,
      -200,
      'rrcurveto',
      0,
      -200,
      -140,
      -140,
      -170,
      0,
      'rrcurveto',
      -170,
      0,
      -140,
      140,
      0,
      200,
      'rrcurveto',
      'closepath',
      80,
      0,
      'rmoveto',
      -150,
      90,
      0,
      0,
      'vhcurveto',
      90,
      0,
      0,
      150,
      'hvcurveto',
      150,
      -90,
      0,
      0,
      'vhcurveto',
      -90,
      0,
      0,
      -150,
      'hvcurveto',
      'closepath',
      'endchar',
    ),
    // B: a stem by subr 4, then a flex bump: 1 callsubr, seven rmoveto + 2 callsubr, 50 x y 0 callsubr
    B: cs(
      60,
      640,
      'hsbw',
      0,
      0,
      'rmoveto',
      4,
      'callsubr',
      200,
      0,
      'rlineto',
      1,
      'callsubr',
      0,
      -50,
      'rmoveto',
      2,
      'callsubr',
      0,
      -30,
      'rmoveto',
      2,
      'callsubr',
      80,
      -40,
      'rmoveto',
      2,
      'callsubr',
      80,
      0,
      'rmoveto',
      2,
      'callsubr',
      80,
      0,
      'rmoveto',
      2,
      'callsubr',
      80,
      40,
      'rmoveto',
      2,
      'callsubr',
      0,
      -130,
      'rmoveto',
      2,
      'callsubr',
      50,
      520,
      40,
      0,
      'callsubr',
      -440,
      0,
      'rlineto',
      'closepath',
      'endchar',
    ),
    acute: cs(
      100,
      333,
      'hsbw',
      0,
      560,
      'rmoveto',
      160,
      160,
      'rlineto',
      80,
      0,
      'rlineto',
      -160,
      -160,
      'rlineto',
      'closepath',
      'endchar',
    ),
    Aacute: cs(20, 620, 'hsbw', 100, 150, 120, 65, 194, 'seac'),
  };
  let priv =
    '/Private 8 dict dup begin\n/RD{string currentfile exch readstring pop}executeonly def\n/ND{noaccess def}executeonly def\n/NP{noaccess put}executeonly def\n/lenIV 4 def\n';
  const parts = [];
  const add = (s) => parts.push(typeof s === 'string' ? ascii(s) : s);
  add(priv);
  add(`/Subrs ${subrs.length} array\n`);
  subrs.forEach((b, i) => {
    const e = encrypt(b, 4330);
    add(`dup ${i} ${e.length} RD `);
    add(e);
    add(' NP\n');
  });
  add('ND\n2 index /CharStrings ' + Object.keys(glyphs).length + ' dict dup begin\n');
  for (const [n, b] of Object.entries(glyphs)) {
    const e = encrypt(b, 4330);
    add(`/${n} ${e.length} RD `);
    add(e);
    add(' ND\n');
  }
  add('end\nend\nreadonly put\nnoaccess put\ndup /FontName get exch definefont pop\nmark currentfile closefile\n');
  const plain = Buffer.concat(parts);
  const enc = encrypt(plain, 55665);
  const encDef =
    encoding === 'StandardEncoding'
      ? '/Encoding StandardEncoding def\n'
      : `/Encoding 256 array\n0 1 255 {1 index exch /.notdef put} for\n${encoding}readonly def\n`;
  const clear = ascii(
    `%!PS-AdobeFont-1.0: TestOne 001\n12 dict begin\n/FontInfo 2 dict dup begin /FullName (TestOne) readonly def end readonly def\n/FontName /TestOne def\n/PaintType 0 def\n/FontType 1 def\n/FontMatrix [${matrix}] readonly def\n${encDef}/FontBBox {0 -200 1000 900} readonly def\ncurrentdict end\ncurrentfile eexec\n`,
  );
  const tail = ascii(
    '0'
      .repeat(64)
      .replace(/(.{64})/g, '$1\n')
      .repeat(8) + 'cleartomark\n',
  );
  return { file: Buffer.concat([clear, enc, tail]), len1: clear.length, len2: enc.length, len3: tail.length };
}

// ---- a minimal CFF (name-keyed) with a FontMatrix ----
const index = (items) => {
  if (!items.length) return [0, 0];
  const total = items.reduce((s, b) => s + b.length, 1);
  const os = total < 256 ? 1 : total < 65536 ? 2 : 3;
  const out = [(items.length >> 8) & 255, items.length & 255, os];
  let off = 1;
  const put = (v) => {
    for (let k = os - 1; k >= 0; k--) out.push((v >> (8 * k)) & 255);
  };
  put(off);
  for (const b of items) put((off += b.length));
  for (const b of items) out.push(...b);
  return out;
};
const dint = (v) => [29, (v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const dreal = (v) => {
  const s = String(v).replace('e-', 'm');
  const nib = [];
  for (const ch of s) nib.push(ch === '.' ? 0xa : ch === 'm' ? 0xc : ch === 'e' ? 0xb : ch === '-' ? 0xe : Number(ch));
  nib.push(0xf);
  if (nib.length & 1) nib.push(0xf);
  const out = [30];
  for (let i = 0; i < nib.length; i += 2) out.push((nib[i] << 4) | nib[i + 1]);
  return out;
};
/** Type 2 charstring numbers (-107..107 only) and ops */
const t2 = (...xs) => xs.flatMap((x) => (typeof x === 'number' ? [x + 139] : x));
export function cffFont(matrix = [0.002, 0, 0.0005, 0.002, 0, 0]) {
  // glyphs: .notdef, A (SID 34): a triangle; drawn in units of 1/500 em (FontMatrix 0.002)
  const notdef = t2(250, [14]);
  const A = t2(310, 0, 0, [21], 100, 0, [5], -50, 100, [5], [14]);
  const name = [...ascii('Mini')];
  const build = (charsetOff, csOff, privOff) => [
    ...matrix.flatMap(dreal),
    12,
    7,
    ...dint(charsetOff),
    15,
    ...dint(csOff),
    17,
    ...dint(0),
    ...dint(privOff),
    18,
  ];
  // layout: header, Name, Top DICT, String and Global Subr INDEXes (empty), charset, CharStrings; Private: empty
  const head = [1, 0, 4, 1];
  const nameIdx = index([name]);
  const topLen = index([build(0, 0, 0)]).length; // offsets are fixed-width: the size does not depend on them
  const charsetOff = head.length + nameIdx.length + topLen + 2 + 2,
    charset = [0, 0, 34],
    csOff = charsetOff + charset.length;
  const csIdx = index([notdef, A]);
  const privOff = csOff + csIdx.length;
  const bytes = Uint8Array.from([
    ...head,
    ...nameIdx,
    ...index([build(charsetOff, csOff, privOff)]),
    0,
    0,
    0,
    0,
    ...charset,
    ...csIdx,
  ]);
  return bytes;
}

const gidsOf = (bytes) => {
  const f = parseFont(bytes, true);
  return (s) => [...s].map((ch) => f.glyphFor(ch.codePointAt(0)));
};

export function fontPdfs() {
  const out = {};
  const t1 = type1Font();
  const t1dict = (fontFile) =>
    `<< /Type /Font /Subtype /Type1 /BaseFont /TestOne /FirstChar 32 /LastChar 255 /Widths [${Array.from({ length: 224 }, (_, i) => ({ 32: 250, 65: 620, 66: 640, 79: 700, 193: 620 })[i + 32] ?? 500).join(' ')}] /Encoding /WinAnsiEncoding /FontDescriptor 6 0 R >>`;
  const desc = (key) =>
    `<< /Type /FontDescriptor /FontName /TestOne /Flags 32 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 /${key} 7 0 R >>`;
  out['type1'] = page(
    'BT /F1 48 Tf 20 140 Td (ABO\xc1 B) Tj ET BT /F1 30 Tf 20 60 Td 2 Tr 1 w (OAB) Tj ET',
    '<< /Font << /F1 5 0 R >> >>',
    [
      t1dict(),
      desc('FontFile'),
      [`<< /Length1 ${t1.len1} /Length2 ${t1.len2} /Length3 ${t1.len3} /Length ${t1.file.length} >>`, t1.file],
    ],
  );
  // the font's own encoding (codes 1, 2, 3 → A, B, O), no /Encoding in the PDF; a skewed FontMatrix
  const t1b = type1Font({
    matrix: '0.001 0 0.0003 0.0012 0 0',
    encoding: 'dup 1 /A put\ndup 2 /B put\ndup 3 /O put\n',
  });
  out['type1-builtin'] = page('BT /F1 40 Tf 20 120 Td (\x01\x02\x03\x01) Tj ET', '<< /Font << /F1 5 0 R >> >>', [
    '<< /Type /Font /Subtype /Type1 /BaseFont /TestOne /FirstChar 1 /LastChar 3 /Widths [620 640 700] /FontDescriptor 6 0 R >>',
    desc('FontFile').replace('/Flags 32', '/Flags 4'),
    [`<< /Length1 ${t1b.len1} /Length2 ${t1b.len2} /Length3 ${t1b.len3} /Length ${t1b.file.length} >>`, t1b.file],
  ]);
  out['cff-simple'] = page(
    'BT /F1 36 Tf 20 140 Td (Hello \xc1\xe9!) Tj ET BT /F1 24 Tf 20 70 Td [(W) 120 (orld)] TJ ET',
    '<< /Font << /F1 5 0 R >> >>',
    [
      `<< /Type /Font /Subtype /Type1 /BaseFont /FoxitSerif /FirstChar 32 /LastChar 255 /Widths [${Array(224).fill(560).join(' ')}] /Encoding /WinAnsiEncoding /FontDescriptor 6 0 R >>`,
      desc('FontFile3'),
      stream('/Subtype /Type1C', FOXIT_SERIF),
    ],
  );
  out['cff-matrix'] = page('BT /F1 40 Tf 20 100 Td (AAA) Tj ET', '<< /Font << /F1 5 0 R >> >>', [
    '<< /Type /Font /Subtype /Type1 /BaseFont /Mini /FirstChar 65 /LastChar 65 /Widths [620] /Encoding << /Differences [65 /A] >> /FontDescriptor 6 0 R >>',
    desc('FontFile3'),
    stream('/Subtype /Type1C', cffFont()),
  ]);
  // Type 3: a square (d1: the fill colour), a circle in its own colour (d0), a glyph showing another glyph
  const circle =
    '50 0 m 50 27.6 27.6 50 0 50 c -27.6 50 -50 27.6 -50 0 c -50 -27.6 -27.6 -50 0 -50 c 27.6 -50 50 -27.6 50 0 c f';
  out['type3'] = page(
    'BT /T3 20 Tf 20 120 Td 0 0 1 rg (abcab) Tj ET BT /T3 40 Tf 2 Tz 20 40 Td 1 0 0 rg (ba) Tj ET',
    '<< /Font << /T3 5 0 R >> >>',
    [
      '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 100 100] /FontMatrix [0.01 0 0 0.01 0 0] /CharProcs << /sq 6 0 R /ci 7 0 R /nest 8 0 R >> /Encoding << /Type /Encoding /Differences [97 /sq /ci /nest] >> /FirstChar 97 /LastChar 99 /Widths [110 110 110] /Resources << /Font << /T3 5 0 R >> >> >>',
      stream('', '100 0 0 0 100 100 d1 10 10 80 80 re f'),
      stream('', `110 0 d0 0 0.6 0 rg q 1 0 0 1 50 50 cm ${circle} Q`),
      stream('', '110 0 d0 BT /T3 50 Tf 0 0 Td (a) Tj ET'), // re-enters its own font: not drawn
    ],
  );
  // an embedded CMap (1-byte codes A–Z → CIDs) using another embedded CMap (2-byte codes) by /UseCMap
  const g = gidsOf(INTER);
  const [gA] = g('A');
  const gHello = g('HELLO');
  const base = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Base def 1 begincodespacerange <0000> <00FF> endcodespacerange 1 begincidrange <0000> <00FF> 0 endcidrange endcmap CMapName currentdict /CMap defineresource pop end end`;
  const top = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Top def /WMode 0 def 1 begincodespacerange <41> <5A> endcodespacerange 1 begincidrange <41> <5A> ${gA} endcidrange 2 begincidchar <48> ${gHello[0]} <4F> ${gHello[4]} endcidchar endcmap CMapName currentdict /CMap defineresource pop end end`;
  const cid = (enc, extra = '') => [
    `<< /Type /Font /Subtype /Type0 /BaseFont /Inter /Encoding ${enc} /DescendantFonts [6 0 R] >>`,
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Inter /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R /CIDToGIDMap /Identity /DW 600 ${extra} >>`,
    '<< /Type /FontDescriptor /FontName /Inter /Flags 4 /FontBBox [-500 -300 2000 1100] /ItalicAngle 0 /Ascent 969 /Descent -242 /CapHeight 727 /StemV 80 /FontFile2 8 0 R >>',
    stream('', INTER),
  ];
  out['cmap'] = page(
    'BT /F1 36 Tf 20 140 Td (HELLO) Tj ET BT /F1 24 Tf 20 80 Td (ABCXYZ) Tj ET',
    '<< /Font << /F1 5 0 R >> >>',
    [
      ...cid('9 0 R'),
      stream('/Type /CMap /CMapName /Top /UseCMap 10 0 R', top),
      stream('/Type /CMap /CMapName /Base', base),
    ],
  );
  // vertical: Identity-V, DW2 and W2 (one CID with its own vertical metrics)
  const hv = g('HV');
  out['vertical'] = page(
    `BT /F1 30 Tf 100 260 Td <${g('VERT')
      .map((x) => x.toString(16).padStart(4, '0'))
      .join(
        '',
      )}> Tj ET BT /F1 30 Tf 200 260 Td 5 Tc <${hv.map((x) => x.toString(16).padStart(4, '0')).join('')}> Tj ET`,
    '<< /Font << /F1 5 0 R >> >>',
    cid('/Identity-V', `/DW2 [880 -1100] /W2 [${hv[1]} [-1400 300 900]]`),
    '0 0 300 300',
  );
  // text render modes 4–7: clips (7 alone; 4 fill + clip; 5 stroke + clip; 6 both), each then a filled band
  out['text-clip'] = page(
    [
      'q BT /F1 60 Tf 7 Tr 10 150 Td (ABO) Tj ET 0 0.5 1 rg 0 140 300 80 re f Q',
      'q BT /F1 40 Tf 4 Tr 0 g 10 90 Td (OB) Tj 5 Tr 2 w 0 0 1 RG (A) Tj ET 1 0 0 rg 0 95 300 15 re f Q',
      'q BT /F1 40 Tf 6 Tr 1 0 0 rg 0 0 1 RG 10 20 Td (BAO) Tj ET 0 1 0 rg 0 30 300 10 re f Q',
    ].join(' '),
    '<< /Font << /F1 5 0 R >> >>',
    [
      t1dict(),
      desc('FontFile'),
      [`<< /Length1 ${t1.len1} /Length2 ${t1.len2} /Length3 ${t1.len3} /Length ${t1.file.length} >>`, t1.file],
    ],
  );
  return out;
}
