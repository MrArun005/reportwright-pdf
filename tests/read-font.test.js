// readFont (metrics and cmap of a font file) and checkSubset (is a subset safe to embed), on the repo's fixtures and on
// deliberately broken copies of them.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { readFont, checkSubset } from '../src/index.js';
import { ROOT } from './tools.js';

const load = (rel) => new Uint8Array(fs.readFileSync(`${ROOT}/${rel}`));
const TTF = load('public/fonts/Inter-Regular.ttf');
const DEVA = load('public/fonts/NotoSansDevanagari-Regular.ttf');
const CFF = load('tests/fixtures/fonts/NotoSansSC-Subset.otf');

/** a table's directory entry in a font: its position, data offset and length, with a DataView to edit it */
function entry(bytes, tag) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < dv.getUint16(4); i++) {
    const p = 12 + 16 * i;
    if (String.fromCharCode(...bytes.subarray(p, p + 4)) === tag)
      return { p, off: dv.getUint32(p + 8), len: dv.getUint32(p + 12), dv };
  }
  throw new Error(`no ${tag} table in the fixture`);
}
const copy = (b) => new Uint8Array(b);

describe('readFont', () => {
  it('reads the values of a TrueType font', () => {
    const f = readFont(TTF);
    expect(f.isCFF).toBe(false);
    expect(f.postscriptName).toBe('Inter-Regular');
    expect(f.unitsPerEm).toBe(2048);
    expect(f.numGlyphs).toBe(2926);
    expect(f.ascent).toBe(1984);
    expect(f.descent).toBe(-494);
    expect(f.fsType).toBe(0);
    expect(f.advance(2)).toBe(1413); // glyph 2 is 'A'
    expect(f.advance(999999)).toBe(0);
  });

  it('reads the values of a CFF (OpenType) font', () => {
    const f = readFont(CFF);
    expect(f.isCFF).toBe(true);
    expect(f.numGlyphs).toBe(230);
    expect(f.unitsPerEm).toBe(1000);
  });

  it('maps Latin, Devanagari and CJK code points to glyphs', () => {
    const latin = readFont(TTF);
    expect(latin.hasGlyph(0x41)).toBe(true);
    expect(latin.glyphForCodePoint(0x41)).toBe(2);
    expect(latin.hasGlyph(0x20ac)).toBe(true); // euro sign
    expect(latin.hasGlyph(0x4e2d)).toBe(false); // CJK is not in Inter

    const deva = readFont(DEVA);
    expect(deva.hasGlyph(0x915)).toBe(true); // ka
    expect(deva.glyphForCodePoint(0x915)).toBeGreaterThan(0);
    expect(deva.hasGlyph(0x41)).toBe(false); // this Devanagari file has no Latin letters
    expect(deva.hasGlyph(0x1f600)).toBe(false);

    const cjk = readFont(CFF);
    expect(cjk.hasGlyph(0x4e2d)).toBe(true);
    expect(cjk.glyphForCodePoint(0x4e2d)).toBe(115);
    expect(cjk.glyphForCodePoint(0x6587)).toBe(152);
    expect(cjk.hasGlyph(0x1f600)).toBe(false);
  });

  it('throws a TypeError on bytes that are not a font', () => {
    expect(() => readFont(new Uint8Array(0))).toThrow(TypeError);
    expect(() => readFont(new Uint8Array(100))).toThrow(TypeError);
    expect(() => readFont(new Uint8Array(randomBytes(64)))).toThrow(TypeError);
    expect(() => readFont(/** @type {any} */ ('not bytes'))).toThrow(TypeError);
    expect(() => readFont(TTF.subarray(0, 300))).toThrow(TypeError);
  });

  it('never throws a RangeError or hangs on random and hostile input', () => {
    const start = Date.now();
    for (let i = 0; i < 300; i++) {
      const b = new Uint8Array(randomBytes(12 + (i % 200)));
      if (i % 2) b.set([0, 1, 0, 0]); // a valid sfnt magic, so the table walk runs
      try {
        readFont(b);
      } catch (e) {
        expect(e).toBeInstanceOf(TypeError);
      }
    }
    // a huge numGlyphs in maxp: bounds, not a loop of that size
    const huge = copy(TTF);
    const maxp = entry(huge, 'maxp');
    maxp.dv.setUint16(maxp.off + 4, 0xffff);
    try {
      readFont(huge);
    } catch (e) {
      expect(e).toBeInstanceOf(TypeError);
    }
    expect(Date.now() - start).toBeLessThan(5000);
  });
});

describe('checkSubset', () => {
  it('is null for good fonts', () => {
    expect(checkSubset(TTF)).toBeNull();
    expect(checkSubset(DEVA)).toBeNull();
    expect(checkSubset(CFF)).toBeNull();
  });

  it('reports a buffer cut short', () => {
    expect(checkSubset(TTF.subarray(0, 100))).toMatch(/runs past the end|too short/);
    expect(checkSubset(TTF.subarray(0, 2000))).toMatch(/runs past the end/);
    expect(checkSubset(CFF.subarray(0, 1000))).toMatch(/runs past the end/);
  });

  it('reports a glyf table of length 0', () => {
    const b = copy(TTF);
    const g = entry(b, 'glyf');
    g.dv.setUint32(g.p + 12, 0);
    expect(checkSubset(b)).toMatch(/glyf is empty/);
  });

  it('reports a loca entry beyond glyf', () => {
    const b = copy(TTF);
    const g = entry(b, 'glyf');
    g.dv.setUint32(g.p + 12, g.len - 1000); // glyf shrinks: a late loca entry now points past it
    expect(checkSubset(b)).toMatch(/beyond glyf/);
  });

  it('reports a corrupt CFF header', () => {
    const major = copy(CFF);
    major[entry(major, 'CFF ').off] = 7;
    expect(checkSubset(major)).toMatch(/header version is 7/);
    const size = copy(CFF);
    size[entry(size, 'CFF ').off + 2] = 0;
    expect(checkSubset(size)).toMatch(/header size 0/);
  });

  it('reports a bad INDEX offSize', () => {
    const b = copy(CFF);
    const c = entry(b, 'CFF ');
    const nameIndex = c.off + b[c.off + 2]; // the Name INDEX follows the header
    b[nameIndex + 2] = 5; // offSize must be 1 to 4
    expect(checkSubset(b)).toMatch(/Name INDEX has offset size 5/);
  });

  it('never throws on random input', () => {
    for (let i = 0; i < 300; i++) {
      const r = checkSubset(new Uint8Array(randomBytes(i % 256)));
      expect(r === null || typeof r === 'string').toBe(true);
    }
  });
});
