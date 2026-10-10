// The shaping hook (embedFont(bytes, { shaper })), with a fake shaper (deterministic glyph IDs) and with harfbuzzjs
// (examples/harfbuzz-shaper.mjs) on Arabic and Devanagari; fallback fonts; veraPDF UA-1 and A-2b on all of it.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { toBytes, loadPdf } from '../src/index.js';
import { parseFont } from '../src/fonts/truetype.js';
import { harfbuzzShaper } from '../examples/harfbuzz-shaper.mjs';
import { INTER, ROOT, HAS, pdftotext, pdffonts, latin, verapdf } from './tools.js';

const DATE = new Date('2026-01-01');
const font = (n) => fs.readFileSync(path.join(ROOT, 'public/fonts', n));
const ARABIC = font('NotoSansArabic-Regular.ttf'),
  DEVA = font('NotoSansDevanagari-Regular.ttf');
const AR = 'مرحبا بالعالم',
  HI = 'किताब हिन्दी क्षत्रिय';
/** pdftotext without the bidi embedding marks poppler adds around right-to-left runs */
const plain = (out) => pdftotext(out).replace(/[‪-‮]/g, '').trim();
async function make(draw, o = {}) {
  let res;
  const out = await toBytes(
    async (pdf) => {
      await draw(pdf.addPage({ width: 500, height: 300 }), pdf);
      const end = pdf.end;
      pdf.end = async () => (res = await end());
    },
    { creationDate: DATE, ...o },
  );
  await PDFDocument.load(out);
  return Object.assign(out, { warnings: res.warnings });
}

describe('the shaping hook', () => {
  const F = parseFont(INTER),
    gid = (c) => F.glyphFor(c.codePointAt(0)),
    adv = (c) => F.advance(gid(c));
  const LIG = gid('ﬁ') || gid('f'),
    ACUTE = gid('´');
  /** "fi" → one ligature glyph; "x" → two glyphs (x and a raised accent with no advance); others one each */
  const fake = (calls) => (text, f, opt) => {
    calls?.push([text, opt]);
    const out = [];
    for (let i = 0; i < text.length; i++) {
      if (text.startsWith('fi', i)) {
        out.push({ g: LIG, cl: i, ax: F.advance(LIG) });
        i++;
      } else if (text[i] === 'x')
        out.push({ g: gid('x'), cl: i, ax: adv('x') }, { g: ACUTE, cl: i, ax: 0, dx: -adv('x') / 2, dy: 300 });
      else out.push({ g: gid(text[i]), cl: i, ax: adv(text[i]) });
    }
    return out;
  };

  it('a fake shaper: ligature mapped in ToUnicode, an accent with no advance drawn after the run in a span of no text, offsets as TJ and Ts', async () => {
    const calls = [];
    const out = await make(
      async (p, pdf) => {
        const f = await pdf.embedFont(INTER, { shaper: fake(calls) });
        p.text('fix fine', { x: 10, y: 10, font: f, size: 20 });
        p.text('fi', { x: 10, y: 60, font: f, size: 20, kerning: false, direction: 'rtl' });
      },
      { compress: false },
    );
    expect(calls).toEqual([
      ['fix fine', { direction: 'ltr', kerning: true }],
      ['fi', { direction: 'rtl', kerning: false }],
    ]);
    const s = latin(out),
      hex = (g) => g.toString(16).padStart(4, '0');
    expect(s).toContain(`<${hex(LIG)}> <00660069>`); // the ligature stands for "fi"
    expect(s).toContain(`<${hex(gid('x'))}> <0078>`); // x + accent: x has the cluster's text, the accent WJ
    expect(s).toContain(`<${hex(ACUTE)}> <2060>`);
    expect(s).toMatch(/\/Span << \/ActualText <feff> >> BDC\n0 0 Td\n[^]*?\nEMC\n/); // the accents, out of the flow
    expect(s).not.toContain('<feff0078>');
    expect(s).toMatch(/\n2\.93 Ts\n[^]*?\n0 Ts\n/); // the accent raised 300 units (20 pt, 2048 an em), then back
    if (HAS.poppler) expect(plain(out).split(/\n+/)).toEqual(['fix fine', 'fi']);
  });

  it('a shaper returning nonsense is refused with a clear error', async () => {
    const bad = [
      [() => 'nope', /no array/],
      [() => [{ g: 1e9, cl: 0, ax: 1 }], /glyph 1000000000/],
      [() => [{ g: 1, cl: 99, ax: 1 }], /cluster 99/],
      [() => [{ g: 1, cl: 0, ax: NaN }], /bad advance/],
      [() => [{ g: 1, cl: 0, ax: 1, dy: Infinity }], /bad offset/],
      [(t) => Array.from({ length: t.length * 4 + 65 }, () => ({ g: 1, cl: 0, ax: 1 })), /glyphs for/],
    ];
    for (const [shaper, re] of bad)
      await expect(
        make(async (p, pdf) => p.text('ab', { font: await pdf.embedFont(INTER, { shaper }) })),
      ).rejects.toThrow(re);
    await expect(make(async (p, pdf) => pdf.embedFont(INTER, { shaper: 42 }))).rejects.toThrow(/shaper is a function/);
  });

  it("harfbuzzjs: Arabic (right to left, joined) and Devanagari (reordered marks, conjuncts) draw HarfBuzz's glyphs and extract exactly", async () => {
    const ar = harfbuzzShaper(ARABIC)(AR, null, { direction: 'rtl', kerning: true });
    const hi = harfbuzzShaper(DEVA)(HI, null, { direction: 'ltr', kerning: true });
    const out = await make(
      async (p, pdf) => {
        p.text(AR, {
          x: 20,
          y: 20,
          size: 24,
          direction: 'rtl',
          font: await pdf.embedFont(ARABIC, { shaper: harfbuzzShaper(ARABIC) }),
        });
        p.text(HI, { x: 20, y: 80, size: 24, font: await pdf.embedFont(DEVA, { shaper: harfbuzzShaper(DEVA) }) });
      },
      { compress: false },
    );
    // the glyph IDs in the content, in order, are HarfBuzz's
    const drawn = [...latin(out).matchAll(/\(([^)]*)\)/g)].map((m) =>
      m[1].replace(/\\([()\\])/g, '$1').replace(/\\r/g, '\r'),
    );
    const ids = (strs) =>
      strs.flatMap((s) =>
        Array.from({ length: s.length / 2 }, (_, i) => (s.charCodeAt(2 * i) << 8) | s.charCodeAt(2 * i + 1)),
      );
    const all = ids(drawn);
    // the glyphs with no advance (dots, marks) come after their run, out of the flow; each glyph is drawn once
    const sorted = (x) => [...x].sort((p, q) => p - q);
    // a code past the font's glyphs is a second code for a glyph (another text): the CIDToGIDMap says which
    const maps = [...latin(out).matchAll(/\/CIDToGIDMap (\d+) 0 R/g)].map((m) => {
      const at = latin(out).indexOf(`\n${m[1]} 0 obj`);
      const st = latin(out).indexOf('stream\n', at) + 7;
      return Buffer.from(out.subarray(st, latin(out).indexOf('\nendstream', st)));
    });
    const gid = (n) => (c) => (c < n ? c : maps.find((m) => 2 * c + 1 < m.length)?.readUInt16BE(2 * c));
    expect(sorted(all.slice(0, ar.length).map(gid(parseFont(ARABIC).numGlyphs)))).toEqual(sorted(ar.map((g) => g.g)));
    expect(sorted(all.slice(ar.length, ar.length + hi.length).map(gid(parseFont(DEVA).numGlyphs)))).toEqual(
      sorted(hi.map((g) => g.g)),
    );
    expect(latin(out)).toContain('/ActualText'); // Devanagari's i-matra cluster
    if (HAS.poppler) expect(plain(out).split(/\n+/)).toEqual([AR, HI]);
    expect((await loadPdf(out)).page(0).extractText().split('\n')).toEqual([AR, HI]);
  });
});

describe('fallback fonts', () => {
  it('characters missing in the main font draw in the first fallback that has them, a run at a time', async () => {
    const s = 'Price ₹100 — किताब and مرحبا';
    const draw = (fallback) =>
      make(async (p, pdf) => {
        const de = await pdf.embedFont(DEVA, { shaper: harfbuzzShaper(DEVA) }),
          ar = await pdf.embedFont(ARABIC, { shaper: harfbuzzShaper(ARABIC) });
        p.text(s, {
          x: 10,
          y: 10,
          size: 20,
          font: await pdf.embedFont(INTER),
          fallback: fallback ? [de, ar] : undefined,
        });
      });
    const out = await draw(true),
      none = await draw(false);
    expect(out.warnings).toEqual([]);
    expect(none.warnings.join()).toMatch(/Inter-Regular has no glyph for "क"/);
    if (HAS.poppler) {
      expect(plain(out)).toBe(s);
      const f = pdffonts(out);
      for (const n of ['Inter-Regular', 'NotoSansDevanagari-Regular', 'NotoSansArabic-Regular'])
        expect(f).toMatch(new RegExp(`\\+${n}\\s+CID TrueType\\s+Identity-H\\s+yes yes yes`));
    }
  });

  it('a forged fallback font is refused', async () => {
    await expect(
      make(async (p, pdf) => {
        const f = await pdf.embedFont(INTER);
        p.text('a', { font: f, fallback: [{ ...f }] });
      }),
    ).rejects.toThrow(/Not a font made by this library/);
  });
});

describe.skipIf(!HAS.verapdf)('veraPDF on a tagged PDF/A page of group C text', () => {
  it('UA-1 and A-2b: 0 failed rules with textBox, kerning, spacing, shaped Arabic and Devanagari, and fallback', async () => {
    const out = await make(
      async (p, pdf) => {
        const inter = await pdf.embedFont(INTER);
        const de = await pdf.embedFont(DEVA, { shaper: harfbuzzShaper(DEVA) }),
          ar = await pdf.embedFont(ARABIC, { shaper: harfbuzzShaper(ARABIC) });
        p.tag('H1', () => p.text('AVATAR Today', { x: 20, y: 20, font: inter, size: 24, characterSpacing: 0.5 }));
        p.tag('P', () =>
          p.textBox(
            'The quick brown fox jumps over the lazy dog, again and again, until the line wraps and is justified.\nA second paragraph.',
            { x: 20, y: 60, width: 220, font: inter, size: 11, align: 'justify' },
          ),
        );
        p.tag('P', () => p.text(HI, { x: 20, y: 140, font: de, size: 16 }), { lang: 'hi' });
        p.tag('P', () => p.text(AR, { x: 20, y: 170, font: ar, size: 16, direction: 'rtl' }), { lang: 'ar' });
        p.tag('P', () =>
          p.text('Price ₹100 — किताब', { x: 20, y: 200, font: inter, size: 14, fallback: [de], rise: 2 }),
        );
      },
      { tagged: { lang: 'en' }, pdfa: true, title: 'Group C text' },
    );
    expect(verapdf(out, 'ua1').failed).toEqual([]);
    expect(verapdf(out, '2b').failed).toEqual([]);
  });
});
