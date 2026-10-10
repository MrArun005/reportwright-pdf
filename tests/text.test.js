// Group C text: OpenType/CFF fonts, kerning (GPOS and kern table), spacing, scaling, rise, render modes, rotation.
// Checked with poppler (pdftotext exact text, pdffonts types, pdftoppm pixels) and pdf-lib (parses every file).
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { toBytes, createPdf } from '../src/index.js';
import { parseFont, sfntTables } from '../src/fonts/truetype.js';
import { buildSfnt } from '../src/fonts/subset.js';
import { harfbuzzShaper } from '../examples/harfbuzz-shaper.mjs';
import { INTER, ROOT, DIR, HAS, pdftotext, pdffonts, gray, latin } from './tools.js';

const DATE = new Date('2026-01-01');
/** a PDF from draw(page, pdf); parsed by pdf-lib before it is returned */
async function make(draw, o = {}) {
  const out = await toBytes(
    async (pdf) => {
      await draw(pdf.addPage({ width: o.width ?? 400, height: o.height ?? 200 }), pdf);
    },
    { creationDate: DATE, ...o },
  );
  await PDFDocument.load(out);
  return out;
}
const text = (out) => pdftotext(out).trim();

// an OpenType/CFF font from the system, copied into the test's temp folder at run time (never committed)
const STIX_SRC = '/System/Library/Fonts/Supplemental/STIXGeneral.otf';
const STIX = fs.existsSync(STIX_SRC)
  ? (fs.copyFileSync(STIX_SRC, path.join(DIR, 'STIXGeneral.otf')), fs.readFileSync(path.join(DIR, 'STIXGeneral.otf')))
  : null;
const SC = fs.readFileSync(path.join(ROOT, 'tests/fixtures/fonts/NotoSansSC-Subset.otf')); // a CID-keyed CFF (the repo's fixture)

describe('kerning', () => {
  it('Inter: GPOS pair kerning in measuring and drawing (TJ), the same advances HarfBuzz gives; off with kerning: false', async () => {
    const s = 'AVATAR To Yo WAVE Ta.';
    const hb = harfbuzzShaper(INTER)(s, null, { direction: 'ltr', kerning: true });
    const upem = parseFont(INTER).unitsPerEm;
    let kerned, plain, raw;
    const out = await make(
      async (p, pdf) => {
        const f = await pdf.embedFont(INTER);
        kerned = f.widthOfText(s, 20);
        plain = f.widthOfText(s, 20, { kerning: false });
        raw = f.widthOf(s, 20);
        p.text(s, { x: 10, y: 10, font: f, size: 20 });
        p.text(s, { x: 10, y: 60, font: f, size: 20, kerning: false });
      },
      { compress: false },
    );
    expect(kerned).toBeCloseTo((hb.reduce((t, g) => t + g.ax, 0) * 20) / upem, 2); // /W widths are written to 3 decimals, and measured as written
    expect(plain).toBeCloseTo(raw, 3);
    expect(kerned).toBeLessThan(plain - 5);
    const c = latin(out);
    expect(c).toMatch(/\] TJ\n/); // the kerned line
    expect(c).toMatch(/\) Tj\n/); // the unkerned one
    if (HAS.poppler) {
      expect(text(out).split(/\n+/)).toEqual([s, s]);
      const one = async (kerning) =>
        gray(
          await make(async (p, pdf) =>
            p.text(s, { x: 10, y: 10, font: await pdf.embedFont(INTER), size: 20, kerning }),
          ),
        ).box();
      const a = await one(true),
        b = await one(false);
      expect(Math.abs(b[2] - b[0] - (a[2] - a[0]) - (plain - kerned))).toBeLessThanOrEqual(1.5); // drawn as measured, to a pixel or so
    }
  });

  it('the legacy kern table is read when there is no GPOS kerning', async () => {
    const F = parseFont(INTER),
      A = F.glyphFor(65),
      V = F.glyphFor(86);
    const t = sfntTables(INTER);
    t.delete('GPOS');
    const kern = new Uint8Array(4 + 14 + 6),
      dv = new DataView(kern.buffer);
    dv.setUint16(2, 1);
    dv.setUint16(6, 14 + 6);
    dv.setUint16(8, 1);
    dv.setUint16(10, 1);
    dv.setUint16(18, A);
    dv.setUint16(20, V);
    dv.setInt16(22, -300);
    t.set('kern', kern);
    const font = buildSfnt(t);
    const pdf = createPdf({ write() {} });
    const f = await pdf.embedFont(font);
    expect(f.widthOfText('AV', 10)).toBeCloseTo(f.widthOf('AV', 10) - (300 * 10) / F.unitsPerEm, 3);
    expect(f.widthOfText('VA', 10)).toBeCloseTo(f.widthOf('VA', 10), 3);
    const out = await make(async (p, d) => p.text('AVA', { x: 10, y: 10, font: await d.embedFont(font), size: 20 }));
    if (HAS.poppler) expect(text(out)).toBe('AVA');
  });

  it('standard fonts are not kerned (their AFM metrics here carry no pairs)', async () => {
    const pdf = createPdf({ write() {} });
    const h = pdf.standardFont('Helvetica');
    expect(h.widthOfText('AVATAR', 12)).toBe(h.widthOf('AVATAR', 12));
    expect(h.lineHeight(10)).toBe(12);
  });
});

describe('spacing and modes', () => {
  it('characterSpacing (Tc), wordSpacing (Tw for one-byte fonts, TJ at spaces for Identity-H), horizontalScaling (Tz): measured and drawn alike', async () => {
    const s = 'Word spacing works';
    let w;
    const out = await make(
      async (p, pdf) => {
        const f = await pdf.embedFont(INTER),
          h = pdf.standardFont('Helvetica');
        w = {
          tc: f.widthOfText(s, 12, { characterSpacing: 0.5 }) - f.widthOfText(s, 12),
          tw: f.widthOfText(s, 12, { wordSpacing: 10 }) - f.widthOfText(s, 12),
          tz: f.widthOfText(s, 12, { horizontalScaling: 50 }) / f.widthOfText(s, 12),
          htw: h.widthOfText(s, 12, { wordSpacing: 10 }) - h.widthOfText(s, 12),
        };
        p.text(s, { x: 10, y: 10, font: f, characterSpacing: 0.5 });
        p.text(s, { x: 10, y: 40, font: f, wordSpacing: 10 });
        p.text(s, { x: 10, y: 70, font: h, wordSpacing: 10 });
        p.text(s, { x: 10, y: 100, font: f, horizontalScaling: 50 });
      },
      { compress: false },
    );
    expect(w.tc).toBeCloseTo(0.5 * [...s].length, 9);
    expect(w.tw).toBeCloseTo(20, 9);
    expect(w.htw).toBeCloseTo(20, 9);
    expect(w.tz).toBeCloseTo(0.5, 9);
    const c = latin(out);
    expect(c).toMatch(/\n0\.5 Tc\n/);
    expect(c).toMatch(/\n10 Tw\n/); // Helvetica's line only
    expect(c.match(/ Tw\n/g).length).toBe(2); // set for Helvetica, then back to 0 (never set for Inter)
    expect(c).toMatch(/ -833\.333 /); // Inter's word spacing as a TJ adjustment: 10 pt at 12 pt
    expect(c).toMatch(/\n50 Tz\n/);
    if (HAS.poppler)
      expect(
        text(out)
          .split(/\n+/)
          .map((l) => l.replace(/\s+/g, ' ')),
      ).toEqual([s, s, s, s]);
  });

  it.skipIf(!HAS.poppler)(
    'pixels: word spacing and scaling change the drawn width as measured; rise lifts the text',
    async () => {
      const s = 'a b c d';
      const draw = (o) =>
        make(async (p, pdf) => p.text(s, { x: 20, y: 50, font: await pdf.embedFont(INTER), size: 20, ...o }));
      const base = gray(await draw({})).box(),
        ws = gray(await draw({ wordSpacing: 10 })).box(),
        tz = gray(await draw({ horizontalScaling: 200 })).box();
      expect(ws[2] - ws[0] - (base[2] - base[0])).toBeGreaterThanOrEqual(29); // 3 spaces × 10
      expect(ws[2] - ws[0] - (base[2] - base[0])).toBeLessThanOrEqual(31);
      expect((tz[2] - tz[0]) / (base[2] - base[0])).toBeCloseTo(2, 1);
      const up = gray(await draw({ rise: 10 })).box(),
        down = gray(await draw({ rise: -6 })).box();
      expect(base[1] - up[1]).toBe(10);
      expect(down[1] - base[1]).toBe(6);
    },
  );

  it.skipIf(!HAS.poppler)(
    'render modes 0–7: fill, stroke, fill+stroke, invisible (extractable), and the clipping modes',
    async () => {
      const s = 'Om';
      const ink = async (renderMode, after) => {
        const out = await make(async (p, pdf) => {
          p.save();
          p.text(s, {
            x: 20,
            y: 20,
            font: await pdf.embedFont(INTER),
            size: 80,
            renderMode,
            color: 0,
            strokeColor: 0,
            strokeWidth: 1,
          });
          if (after) p.rect(0, 0, 400, 200, { fill: 0 }); // clipped to the glyphs in modes 4–7
          p.restore();
        });
        return { ink: gray(out).ink(), out };
      };
      const fill = (await ink(0)).ink,
        stroke = (await ink(1)).ink,
        both = (await ink('fillStroke')).ink;
      expect(stroke).toBeGreaterThan(0);
      expect(stroke).toBeLessThan(fill); // outlines only
      expect(both).toBeGreaterThan(fill);
      const inv = await ink('invisible');
      expect(inv.ink).toBe(0);
      expect(text(inv.out)).toBe(s);
      for (const m of [4, 5, 6, 7]) {
        const { ink: n } = await ink(m, true);
        expect(n).toBeGreaterThan(fill * 0.8); // the black rectangle shows through the glyphs only
        expect(n).toBeLessThan(400 * 200 * 0.3);
      }
      await expect(
        make(async (p, pdf) => p.text(s, { font: pdf.standardFont('Helvetica'), renderMode: 8 })),
      ).rejects.toThrow(/renderMode is 0–7/);
    },
  );

  it('rotate turns the line about its top-left corner (through save/translate/rotate/restore)', async () => {
    const out = await make(
      async (p, pdf) =>
        p.text('Rotated', { x: 100, y: 20, font: await pdf.embedFont(INTER), size: 20, rotate: Math.PI / 2 }),
      { compress: false },
    );
    expect(latin(out)).toMatch(/\nq\n.* cm\n/);
    if (HAS.poppler) {
      expect(text(out)).toBe('Rotated');
      const [x0, y0, x1, y1] = gray(out).box();
      expect(y1 - y0).toBeGreaterThan(3 * (x1 - x0)); // standing up
      expect(x1).toBeLessThanOrEqual(101);
    }
  });
});

describe('OpenType/CFF fonts', () => {
  it.skipIf(!STIX)(
    'STIX (name-keyed CFF): embedded as FontFile3/OpenType, subset by glyph ID, kerned, text extracts',
    async () => {
      const s = 'AVATAR Office: x² ∑ ∫ π ≤ ∞';
      const draw = (subset) =>
        make(async (p, pdf) => p.text(s, { x: 10, y: 10, font: await pdf.embedFont(STIX, { subset }), size: 20 }));
      const sub = await draw(true),
        whole = await draw(false);
      expect(sub.length).toBeLessThan(whole.length / 3);
      const pdf = createPdf({ write() {} }),
        f = await pdf.embedFont(STIX);
      expect(f.widthOfText('AV', 20)).toBeLessThan(f.widthOf('AV', 20)); // GPOS kerning
      if (HAS.poppler) {
        expect(pdffonts(sub)).toMatch(/[A-Z]{6}\+STIXGeneral-Regular\s+CID Type 0C \(OT\)\s+Identity-H\s+yes yes yes/);
        expect(pdffonts(whole)).toMatch(/^STIXGeneral-Regular\s+CID Type 0C \(OT\)\s+Identity-H\s+yes no\s+yes/m);
        expect(text(sub)).toBe(s);
        expect(Buffer.compare(gray(sub, 100).raw, gray(whole, 100).raw)).toBe(0); // the subset draws pixel for pixel the same
      }
    },
  );

  it('a CID-keyed CFF (Noto Sans SC subset): drawn by glyph ID with its charset made the identity; subset and whole draw alike', async () => {
    const s = '中文 一七万三 我们好 ABC';
    const draw = (subset) =>
      make(async (p, pdf) => p.text(s, { x: 10, y: 10, font: await pdf.embedFont(SC, { subset }), size: 24 }));
    const sub = await draw(true),
      whole = await draw(false);
    expect(sub.length).toBeLessThan(whole.length / 2);
    if (HAS.poppler) {
      for (const out of [sub, whole]) {
        expect(text(out)).toBe(s);
        expect(pdffonts(out)).toMatch(/CID Type 0C \(OT\)\s+Identity-H\s+yes (yes|no)\s+yes/);
      }
      const ref = gray(whole, 100);
      expect(ref.ink(0, 0, 330, 80)).toBeGreaterThan(1500); // the CJK glyphs are drawn (not blank, not .notdef boxes)
      expect(Buffer.compare(gray(sub, 100).raw, ref.raw)).toBe(0);
    }
  });
});
