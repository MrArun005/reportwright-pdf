// Fonts passed to embedFont are untrusted: crafted names must not inject PDF syntax, and broken tables must fail fast
// with a clear error (no out-of-bounds reads, endless loops or allocations sized from the font's numbers).
import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { toBytes } from '../src/index.js';
import { buildSfnt } from '../src/fonts/subset.js';
import { sfntTables, parseFont } from '../src/fonts/truetype.js';
import { pdfName, fontName } from '../src/core/serialize.js';
import { INTER, HAS, pdffonts, pdftotext, directory, latin, run, save } from './tools.js';

const EVIL = 'A /OpenAction << /S /JavaScript /JS (app.alert(1)) >>';

/** Inter with its name table replaced by one record (nameID 6, Windows, UTF-16BE) */
function withName(ps) {
  const s = Buffer.from(ps, 'utf16le').swap16();
  const nm = new Uint8Array(18 + s.length),
    dv = new DataView(nm.buffer);
  dv.setUint16(2, 1);
  dv.setUint16(4, 18);
  dv.setUint16(6, 3);
  dv.setUint16(8, 1);
  dv.setUint16(10, 0x409);
  dv.setUint16(12, 6);
  dv.setUint16(14, s.length);
  dv.setUint16(16, 0);
  nm.set(s, 18);
  const t = sfntTables(INTER);
  t.set('name', nm);
  return buildSfnt(t);
}
const copy = () => new Uint8Array(INTER);
/** set Inter's loca entry g (long format) @param {Uint8Array} b */
const setLoca = (b, g, v) => {
  const L = directory(b).get('loca');
  new DataView(b.buffer).setUint32(L.off + g * 4, v);
};
const getLoca = (b, g) => new DataView(b.buffer).getUint32(directory(b).get('loca').off + g * 4);
/** draw a line with the font and end the PDF */
const draw = (bytes, txt = 'Hello Ä', opt = {}) =>
  toBytes(
    async (pdf) => {
      const f = await pdf.embedFont(bytes, opt);
      pdf.addPage().text(txt, { x: 10, y: 10, font: f });
    },
    { compress: false, creationDate: new Date(0) },
  );
/** throws quickly with a message matching re */
async function failsFast(fn, re) {
  const t = performance.now();
  await expect(fn()).rejects.toThrow(re);
  expect(performance.now() - t).toBeLessThan(1000);
}

describe('hostile fonts', () => {
  it('a PostScript name that tries to inject a dictionary is sanitised (subset and whole)', async () => {
    for (const subset of [true, false]) {
      const out = await draw(withName(EVIL), 'Hello', { subset });
      const s = latin(out);
      expect(s).not.toMatch(/\/OpenAction|\/JavaScript|\/JS\b|\(app\.alert/); // the words survive inside one name, the syntax does not
      expect(s).toMatch(/\/BaseFont \/(?:[A-Z]{6}\+)?A--OpenAction-----S--JavaScript--JS--app.alert-1-----/);
      const doc = await PDFDocument.load(out); // parses: the structure is intact
      expect(doc.catalog.get(doc.context.obj('OpenAction'))).toBeUndefined();
      if (HAS.poppler) {
        expect(pdftotext(out)).toMatch('Hello');
        expect(pdffonts(out)).toMatch('A--OpenAction');
      }
      if (HAS.qpdf) expect(run('qpdf', ['--check', save(out)])).toMatch(/No syntax or stream encoding errors/);
    }
  });

  it('unsafe characters become "-", an empty name is "Font", long names are cut to 63', async () => {
    expect(latin(await draw(withName('()<>[]{}/% \u00e9'), 'Hi', { subset: false }))).toMatch(
      /\/BaseFont \/------------ /,
    );
    expect(latin(await draw(withName(''), 'Hi', { subset: false }))).toMatch(/\/BaseFont \/Font /);
    expect(fontName('')).toBe('/Font');
    expect(fontName(null, 'X')).toBe('/X');
    expect(fontName('a b/c#d')).toBe('/a-b-c-d');
    const long = latin(await draw(withName('N'.repeat(500)), 'Hi', { subset: false }));
    expect(long).toMatch(new RegExp(`/BaseFont /${'N'.repeat(63)} `));
  });

  it('loca pointing past the end of glyf is refused', async () => {
    const b = copy();
    setLoca(b, 40, directory(b).get('glyf').len + 1000);
    await failsFast(() => draw(b), /Broken font: loca/);
  });

  it('loca going backwards is refused', async () => {
    const b = copy();
    setLoca(b, 41, getLoca(b, 40) - 4);
    await failsFast(() => draw(b), /Broken font: loca goes backwards/);
  });

  it('loca with a huge offset (a would-be giant allocation) is refused', async () => {
    const b = copy();
    setLoca(b, 2925, 0xfffffff0);
    setLoca(b, 2926, 0xfffffff0);
    await failsFast(() => draw(b), /Broken font: loca/);
  });

  // a composite glyph of Inter (Ä): its first component's glyph index is at +12 in the glyph's data
  const composite = () => {
    const f = parseFont(INTER),
      g = f.glyphFor(0xc4),
      D = directory(INTER);
    const at = getLoca(INTER, g),
      pos = D.get('glyf').off + at;
    expect(new DataView(INTER.buffer, INTER.byteOffset).getInt16(pos)).toBeLessThan(0); // composite
    return { g, comp: pos + 12 };
  };

  it('a composite glyph that uses itself ends (no endless walk) and embeds', async () => {
    const { g, comp } = composite(),
      b = copy();
    new DataView(b.buffer).setUint16(comp, g);
    const t = performance.now();
    const out = await draw(b, 'Ä');
    expect(performance.now() - t).toBeLessThan(1000);
    if (HAS.poppler) expect(pdffonts(out)).toMatch(/Inter-Regular/);
  });

  it('a composite glyph using a glyph past the font is refused', async () => {
    const { comp } = composite(),
      b = copy();
    new DataView(b.buffer).setUint16(comp, 0xfff0);
    await failsFast(() => draw(b, 'Ä'), /Broken font: composite glyph \d+ uses glyph 65520/);
  });

  it('a table directory of 65535 tables is refused', async () => {
    const b = copy();
    new DataView(b.buffer).setUint16(4, 0xffff);
    await failsFast(() => draw(b), /Broken font: a directory of 65535 tables/);
  });

  it('a table that lies past the end of the file is refused', async () => {
    const b = copy();
    new DataView(b.buffer).setUint32(directory(b).get('hmtx').rec + 8, b.length - 10);
    await failsFast(() => draw(b), /Broken font: table "hmtx" lies outside the file/);
  });

  it('numberOfHMetrics larger than the glyphs, and a cmap past its table, are refused', async () => {
    const b = copy();
    new DataView(b.buffer).setUint16(directory(b).get('hhea').off + 34, 0xffff);
    await failsFast(() => draw(b), /numberOfHMetrics/);
    const c = copy(),
      cm = directory(c).get('cmap');
    const dv = new DataView(c.buffer),
      n = dv.getUint16(cm.off + 2);
    for (let i = 0; i < n; i++) {
      const st = cm.off + dv.getUint32(cm.off + 8 + i * 8);
      if (dv.getUint16(st) === 4) dv.setUint16(st + 6, 0xfffe);
      if (dv.getUint16(st) === 12) dv.setUint32(st + 12, 0x0fffffff);
    }
    await failsFast(() => draw(c), /Broken font: its cmap/);
  });

  it('garbage, collections and WOFF are refused with a clear error', async () => {
    await failsFast(() => draw(new Uint8Array(100)), /Not a TrueType or OpenType font/);
    await failsFast(() => draw(new TextEncoder().encode('ttcf' + '\0'.repeat(40))), /collections/);
    await failsFast(() => draw(new TextEncoder().encode('wOFF' + '\0'.repeat(40))), /WOFF/);
    await failsFast(() => draw(new Uint8Array(4)), /too short/);
  });
});

// OpenType/CFF and layout tables: the repo's CID-keyed CFF fixture and Inter's GPOS, made to lie.
import { parseCff } from '../src/fonts/cff.js';
import { ROOT } from './tools.js';
import nodePath from 'node:path';
import nodeFs from 'node:fs';

const SC = nodeFs.readFileSync(nodePath.join(ROOT, 'tests/fixtures/fonts/NotoSansSC-Subset.otf'));
/** the fixture with its CFF table changed by fix(cff, info) (or replaced by its return value), rebuilt */
function cffFont(fix) {
  const t = sfntTables(SC),
    F = parseFont(SC);
  const cff = new Uint8Array(t.get('CFF ')),
    c = parseCff(cff, F.numGlyphs);
  t.set('CFF ', fix(cff, { c, A: F.glyphFor(65), dv: new DataView(cff.buffer) }) ?? cff);
  return buildSfnt(t, [0x4f, 0x54, 0x54, 0x4f]);
}
/** Inter with its GPOS changed by fix(gpos, dv) */
function gposFont(fix) {
  const t = sfntTables(INTER),
    g = new Uint8Array(t.get('GPOS'));
  fix(g, new DataView(g.buffer));
  t.set('GPOS', g);
  return buildSfnt(t);
}
/** the offset (in GPOS) of the first lookup of Inter's 'kern' feature */
function kernLookup(g, dv) {
  const fl = dv.getUint16(6),
    ll = dv.getUint16(8);
  for (let i = 0; i < dv.getUint16(fl); i++) {
    const r = fl + 2 + i * 6;
    if (String.fromCharCode(...g.subarray(r, r + 4)) !== 'kern') continue;
    const f = fl + dv.getUint16(r + 4);
    return ll + dv.getUint16(ll + 2 + dv.getUint16(f + 4) * 2);
  }
  throw new Error('no kern feature');
}
/** embeds, draws and ends in under 1 s; the warnings */
async function embedsSafely(bytes, txt = 'AVATAR') {
  const t = performance.now();
  let r;
  const out = await toBytes(
    async (pdf) => {
      const f = await pdf.embedFont(bytes);
      expect(f.widthOfText(txt, 10)).toBeCloseTo(f.widthOf(txt, 10), 3); // kerning off
      pdf.addPage().text(txt, { x: 10, y: 10, font: f });
      const end = pdf.end;
      pdf.end = async () => (r = await end());
    },
    { creationDate: new Date(0) },
  );
  expect(performance.now() - t).toBeLessThan(1000);
  await PDFDocument.load(out);
  if (HAS.poppler) expect(pdftotext(out).trim()).toBe(txt);
  return r.warnings;
}

describe('hostile OpenType/CFF fonts', () => {
  it('a CharStrings INDEX whose count lies is refused when embedded', async () => {
    const b = cffFont((cff, { c, dv }) => {
      dv.setUint16(c.cs.p, 0xffff);
    });
    await failsFast(() => draw(b, 'ABC'), /Broken font: the CFF CharStrings INDEX says 65535 entries/);
  });

  it('an INDEX whose offsets go backwards, or whose offset size is 7, is refused', async () => {
    const back = cffFont((cff, { c }) => {
      const os = c.cs.os,
        at = c.cs.p + 3 + 5 * os;
      for (let k = 0; k < os; k++) cff[at + k] = 0;
      cff[at + os - 1] = 1;
    });
    await failsFast(() => draw(back, 'ABC'), /Broken font: the CFF CharStrings INDEX (goes backwards|does not start)/);
    const os7 = cffFont((cff, { c }) => {
      cff[c.gsubrs.p + 2] = 7;
    });
    await failsFast(() => draw(os7, 'ABC'), /Broken font: the CFF Global Subr INDEX has offset size 7/);
  });

  it('a subroutine that calls itself stops at depth 10 with a clear error', async () => {
    const b = cffFont((cff, { c, A }) => {
      const [s] = c.gsubrs.at(0);
      cff.set([32, 29], s); // gsubr 0: push -107 (+ bias 107 = 0), callgsubr: itself
      const [a, e] = c.cs.at(A);
      expect(e - a).toBeGreaterThanOrEqual(3);
      cff.set([32, 29, 14], a); // glyph A calls it
    });
    await failsFast(() => draw(b, 'A'), /Broken font: glyph \d+ nests subroutines deeper than 10/);
  });

  it('a charstring over 65,535 bytes is refused', async () => {
    const b = cffFont((cff, { c, A }) => {
      // a new CharStrings INDEX (offset size 4) at the end of the table, glyph A 70,000 bytes long; the Top DICT's
      // CharStrings operand (29 + 4 bytes, 17) pointed at it
      const n = c.cs.count,
        parts = Array.from({ length: n }, (_, g) =>
          g === A ? new Uint8Array(70_000).fill(139) : cff.subarray(...c.cs.at(g)),
        );
      const size = parts.reduce((t, x) => t + x.length, 0),
        idx = new Uint8Array(3 + (n + 1) * 4 + size),
        dv = new DataView(idx.buffer);
      dv.setUint16(0, n);
      idx[2] = 4;
      let off = 1,
        at = 3 + (n + 1) * 4;
      parts.forEach((x, g) => {
        dv.setUint32(3 + g * 4, off);
        idx.set(x, at);
        at += x.length;
        off += x.length;
      });
      dv.setUint32(3 + n * 4, off);
      const out = new Uint8Array(cff.length + idx.length);
      out.set(cff);
      out.set(idx, cff.length);
      const p = c.cs.p,
        odv = new DataView(out.buffer);
      const op = out.findIndex((v, i) => v === 29 && odv.getInt32(i + 1) === p && out[i + 5] === 17); // 29: a 4-byte operand
      expect(op).toBeGreaterThan(0);
      odv.setInt32(op + 1, cff.length);
      return out;
    });
    await failsFast(() => draw(b, 'A'), /Broken font: the charstring of glyph \d+ is 70000 bytes \(at most 65535\)/);
  });

  it('GPOS with a lying lookup count: kerning off with a warning, the font embeds', async () => {
    const w = await embedsSafely(gposFont((g, dv) => dv.setUint16(dv.getUint16(8), 0xffff)));
    expect(w.join()).toMatch(/Broken font: GPOS lookup list lies outside the table: GPOS kerning is off/);
  });

  it('GPOS with a kern subtable offset past the table, or a pair set count that lies: kerning off with a warning', async () => {
    let w = await embedsSafely(
      gposFont((g, dv) => {
        const L = kernLookup(g, dv);
        dv.setUint16(L + 6, 0xfff0);
      }),
    );
    expect(w.join()).toMatch(
      /Broken font: GPOS (.* lies outside the table|has a coverage table of format \d+): GPOS kerning is off/,
    ); // garbage there, or nothing
    w = await embedsSafely(
      gposFont((g, dv) => {
        const L = kernLookup(g, dv);
        dv.setUint16(L + 4, 0xffff);
      }),
    );
    expect(w.join()).toMatch(/GPOS kerning is off/);
  });

  it('a legacy kern table whose pair count lies: kerning off with a warning', async () => {
    const t = sfntTables(INTER);
    t.delete('GPOS');
    const kern = new Uint8Array(4 + 14 + 6),
      dv = new DataView(kern.buffer);
    dv.setUint16(2, 1);
    dv.setUint16(6, 20);
    dv.setUint16(8, 1);
    dv.setUint16(10, 0xffff);
    t.set('kern', kern);
    expect((await embedsSafely(buildSfnt(t))).join()).toMatch(
      /Broken font: kern a subtable lies outside the table: kern-table kerning is off/,
    );
  });
});
