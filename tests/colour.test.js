// @reportwright/pdf colour: DeviceGray / RGB / CMYK, hex and CSS rgb(), spot colours (Separation), ICC-based colour
// spaces; as fills, strokes and gradient stops; the PDF/A output-intent rules (veraPDF); rendered with pdftoppm.
import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { toBytes, cmyk } from '../src/index.js';
import { HAS, INTER, latin, verapdf } from './tools.js';
import { pixels, near, profile, png, sharp } from './image-fixtures.js';

const DATE = new Date('2026-01-01');
const SRGB = profile('sRGB Profile.icc'), CMYK = profile('Generic CMYK Profile.icc'), GRAY = profile('Generic Gray Gamma 2.2 Profile.icc');
/** the page's content operators (compress off) */
async function ops(draw, o = {}) {
  const out = await toBytes(async (pdf) => { await draw(pdf.addPage({ width: 100, height: 100 }), pdf); }, { creationDate: DATE, compress: false, ...o });
  await PDFDocument.load(out);
  return latin(out);
}

describe('colour values', () => {
  it('gray, RGB (#hex, rgb(), arrays), CMYK (cmyk(), 4-arrays) for fill and stroke, set only when they change', async () => {
    const t = await ops((p) => {
      p.rect(0, 0, 10, 10, { fill: cmyk(0, 1, 1, 0) });
      p.rect(0, 0, 10, 10, { fill: [0, 1, 1, 0] }); // the same: not set again
      p.line(0, 0, 10, 10, { color: cmyk(1, 0, 0, 0.5) });
      p.rect(0, 0, 10, 10, { fill: 'rgb(255, 128, 0)' });
      p.rect(0, 0, 10, 10, { fill: 'rgb(0% 50% 100%)' });
      p.rect(0, 0, 10, 10, { fill: 'RGB( 10 , 20 , 30 )' });
      p.fill(p.path().rect(0, 0, 5, 5), { fill: cmyk(0.1, 0.2, 0.3, 0.4), stroke: 0.5 });
      p.stroke(p.path().moveTo(0, 0).lineTo(5, 5), { stroke: cmyk(0, 0, 0, 1) });
    });
    expect(t.match(/0 1 1 0 k\n/g)).toHaveLength(1);
    expect(t).toContain('1 0 0 0.5 K\n');
    expect(t).toContain('1 0.502 0 rg\n');
    expect(t).toContain('0 0.5 1 rg\n');
    expect(t).toContain('0.039 0.078 0.118 rg\n');
    expect(t).toContain('0.1 0.2 0.3 0.4 k\n');
    expect(t).toContain('0 0 0 1 K\n');
  });
  it('bad colours throw', async () => {
    for (const c of ['rgb(256, 0, 0)', 'rgb(0, 0)', 'rgb(1,2,3);/JavaScript', 'rgba(1, 2, 3, 0.5)', [0, 0, 0, 2], [0, 0], 'cmyk(0,0,0,0)', NaN, {}, { type: 'color' }])
      await expect(ops((p) => p.rect(0, 0, 1, 1, { fill: c }))).rejects.toThrow(/colour|0–255|Not a|gray level/);
    expect(() => cmyk(0, 0, 0, 1.5)).toThrow(/each is 0–1/);
    expect(() => cmyk(0, 0, NaN, 0)).toThrow(/each is 0–1/);
  });
});

describe('spot colours (Separation)', () => {
  it("a named spot goes through pdfName, with a tint transform to its alternate; tints; used for fill, stroke, text", async () => {
    const t = await ops((p, pdf) => {
      const s = pdf.spotColor('PANTONE 185 C', cmyk(0, 0.91, 0.76, 0));
      expect(s.name).toBe('PANTONE 185 C');
      p.rect(0, 0, 10, 10, { fill: s });
      p.rect(0, 0, 10, 10, { stroke: s.tint(0.25) });
      const r = pdf.spotColor('Brand / Red <</JS>>', '#CC0000');
      p.fill(p.path().rect(0, 0, 50, 50), { fill: r.tint(0.5) });
    });
    expect(t).toContain('[/Separation /PANTONE#20185#20C /DeviceCMYK << /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 0.91 0.76 0] /N 1 >>]');
    expect(t).toContain('[/Separation /Brand#20#2F#20Red#20#3C#3C#2FJS#3E#3E /DeviceRGB << /FunctionType 2 /Domain [0 1] /C0 [1 1 1] /C1 [0.8 0 0] /N 1 >>]');
    expect(t).toMatch(/\/C1 cs 1 scn\n/);
    expect(t).toMatch(/\/C1 CS 0.25 SCN\n/);
    expect(t).toMatch(/\/C2 cs 0.5 scn\n/);
  });
  it('one name, one definition; bad names, alternates and tints throw; forged and foreign spots are refused', async () => {
    await expect(ops((p, pdf) => { pdf.spotColor('X', '#F00'); pdf.spotColor('X', '#00f'); })).rejects.toThrow(/already defined/);
    await expect(ops((p, pdf) => { pdf.spotColor('X', '#F00'); pdf.spotColor('X', '#F00'); })).resolves.toBeTruthy();
    await expect(ops((p, pdf) => pdf.spotColor('', '#F00'))).rejects.toThrow(/1–127/);
    await expect(ops((p, pdf) => pdf.spotColor('X'.repeat(128), '#F00'))).rejects.toThrow(/1–127/);
    await expect(ops((p, pdf) => pdf.spotColor('X', 'red'))).rejects.toThrow(/alternate is a device colour/);
    await expect(ops((p, pdf) => pdf.spotColor('X', 0).tint(2))).rejects.toThrow(/tint is 0–1/);
    await expect(ops((p) => p.rect(0, 0, 1, 1, { fill: Object.freeze({ type: 'spot', name: 'X', tint() {} }) }))).rejects.toThrow(/Not a colour/);
    let other;
    await toBytes((pdf) => { other = pdf.spotColor('X', 0); });
    await expect(ops((p) => p.rect(0, 0, 1, 1, { fill: other }))).rejects.toThrow(/another PDF/);
  });
  it.skipIf(!HAS.poppler)("renders as its alternate (CMYK and RGB), tints lighter", async () => {
    const out = await toBytes(async (pdf) => {
      const p = pdf.addPage({ width: 100, height: 100 });
      const red = pdf.spotColor('Red', '#FF0000'), cyan = pdf.spotColor('Cyan ink', cmyk(1, 0, 0, 0));
      p.rect(0, 0, 50, 50, { fill: red });
      p.rect(50, 0, 50, 50, { fill: red.tint(0.5) });
      p.rect(0, 50, 50, 50, { fill: cyan });
    }, { creationDate: DATE });
    const px = pixels(out);
    expect(px(25, 25)).toEqual([255, 0, 0]);
    expect(near(px(75, 25), [255, 128, 128], 3)).toBe(true);
    const [r, g, b] = px(25, 75);
    expect(r).toBeLessThan(60); expect(g).toBeGreaterThan(130); expect(b).toBeGreaterThan(200); // cyan-ish
  });
});

describe.skipIf(!SRGB)('ICC-based colour spaces', () => {
  it('/N comes from the profile header; the stream is written once; colours take that many components', async () => {
    const t = await ops(async (p, pdf) => {
      const rgb = await pdf.iccColorSpace(SRGB), gray = await pdf.iccColorSpace(GRAY), k = await pdf.iccColorSpace(CMYK);
      expect([rgb.components, gray.components, k.components]).toEqual([3, 1, 4]);
      p.rect(0, 0, 10, 10, { fill: rgb.color(1, 0, 0) });
      p.rect(0, 0, 10, 10, { fill: rgb.color(0, 1, 0) });
      p.rect(0, 0, 10, 10, { stroke: gray.color(0.5) });
      p.rect(0, 0, 10, 10, { fill: k.color(0, 0, 0, 1) });
      expect(() => rgb.color(1, 0)).toThrow(/takes 3 components/);
      expect(() => rgb.color(1, 0, 2)).toThrow(/each 0–1/);
    });
    expect(t.match(/<< \/N 3 \/Length \d+ >>/g)).toHaveLength(1);
    expect(t).toMatch(/<< \/N 1 \/Length \d+ >>/);
    expect(t).toMatch(/<< \/N 4 \/Length \d+ >>/);
    expect(t).toMatch(/\/ColorSpace << \/C1 \[\/ICCBased \d+ 0 R\] \/C2 \[\/ICCBased \d+ 0 R\] \/C3 \[\/ICCBased \d+ 0 R\] >>/);
    expect(t).toContain('/C1 cs 1 0 0 scn\n');
    expect(t).toContain('/C1 cs 0 1 0 scn\n');
    expect(t).toContain('/C2 CS 0.5 SCN\n');
  });
  it.skipIf(!HAS.poppler)('an sRGB ICC red renders red', async () => {
    const out = await toBytes(async (pdf) => { const s = await pdf.iccColorSpace(SRGB); pdf.addPage({ width: 100, height: 100 }).rect(0, 0, 100, 100, { fill: s.color(1, 0, 0) }); }, { creationDate: DATE });
    expect(near(pixels(out)(50, 50), [255, 0, 0], 10)).toBe(true);
  });
});

describe('gradients in every colour space', () => {
  it('gray-only → DeviceGray; gray + RGB → DeviceRGB; CMYK; a spot\'s tints → Separation; ICC; mixing spaces throws', async () => {
    const t = await ops(async (p, pdf) => {
      const s = pdf.spotColor('Gold', cmyk(0, 0.2, 0.8, 0.1));
      p.fill(p.path().rect(0, 0, 10, 10), { fill: p.linearGradient(0, 0, 10, 0, [[0, 0], [1, 1]]) });
      p.fill(p.path().rect(0, 0, 10, 10), { fill: p.linearGradient(0, 0, 10, 0, [[0, 0.5], [1, '#FF0000']]) });
      p.fill(p.path().rect(0, 0, 10, 10), { fill: p.linearGradient(0, 0, 10, 0, [[0, cmyk(1, 0, 0, 0)], [1, [0, 0, 1, 0]]]) });
      p.fill(p.path().rect(0, 0, 10, 10), { fill: p.radialGradient(5, 5, 0, 5, 5, 5, [[0, s.tint(0)], [1, s]]) });
      if (SRGB) { const icc = await pdf.iccColorSpace(SRGB); p.shade(p.linearGradient(0, 0, 10, 0, [[0, icc.color(1, 0, 0)], [1, icc.color(0, 0, 1)]])); }
      expect(() => p.linearGradient(0, 0, 1, 0, [[0, '#F00'], [1, cmyk(0, 0, 0, 1)]])).toThrow(/share one colour space/);
      expect(() => p.linearGradient(0, 0, 1, 0, [[0, s], [1, pdf.spotColor('Silver', 0.7)]])).toThrow(/share one colour space/);
    });
    expect(t).toContain('/ShadingType 2 /ColorSpace /DeviceGray /Coords [0 0 10 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 1 >>');
    expect(t).toContain('/ColorSpace /DeviceRGB /Coords [0 0 10 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [0.5 0.5 0.5] /C1 [1 0 0] /N 1 >>');
    expect(t).toContain('/ColorSpace /DeviceCMYK /Coords [0 0 10 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [1 0 0 0] /C1 [0 0 1 0] /N 1 >>');
    expect(t).toContain('/ShadingType 3 /ColorSpace [/Separation /Gold /DeviceCMYK');
    expect(t).toContain('/C0 [0] /C1 [1] /N 1 >> /Extend [true true]');
    if (SRGB) expect(t).toMatch(/\/ColorSpace \[\/ICCBased \d+ 0 R\] \/Coords/);
  });
  it.skipIf(!HAS.poppler)('a CMYK gradient renders from cyan to yellow', async () => {
    const out = await toBytes((pdf) => { const p = pdf.addPage({ width: 100, height: 100 }); p.fill(p.path().rect(0, 0, 100, 100), { fill: p.linearGradient(0, 0, 100, 0, [[0, cmyk(1, 0, 0, 0)], [1, cmyk(0, 0, 1, 0)]]) }); }, { creationDate: DATE });
    const px = pixels(out);
    const [r0, , b0] = px(1, 50), [r1, , b1] = px(98, 50);
    expect(r0).toBeLessThan(60); expect(b0).toBeGreaterThan(200);
    expect(r1).toBeGreaterThan(200); expect(b1).toBeLessThan(60);
  });
});

describe('PDF/A output-intent rules (ISO 19005-2 6.2.4.3)', () => {
  it('with the default sRGB intent, DeviceCMYK is refused with a clear error (fills, spot alternates, gradients, images)', async () => {
    const msg = /PDF\/A: CMYK colour \(DeviceCMYK\) needs a CMYK output intent/;
    await expect(ops((p) => p.rect(0, 0, 1, 1, { fill: cmyk(0, 0, 0, 1) }), { pdfa: true })).rejects.toThrow(msg);
    await expect(ops((p, pdf) => pdf.spotColor('S', cmyk(0, 1, 0, 0)), { pdfa: true })).rejects.toThrow(msg);
    await expect(ops((p) => p.linearGradient(0, 0, 1, 0, [[0, [0, 0, 0, 0]], [1, [0, 0, 0, 1]]]), { pdfa: true })).rejects.toThrow(msg);
    if (sharp) {
      const jpg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#F00' } }).toColourspace('cmyk').jpeg().toBuffer();
      await expect(ops(async (p, pdf) => pdf.embedImage(jpg), { pdfa: true })).rejects.toThrow(msg);
    }
  });
  it.skipIf(!CMYK)('with a CMYK output intent, DeviceCMYK is allowed and DeviceRGB refused (colours, gradients, images)', async () => {
    const o = { pdfa: { outputIntent: CMYK } };
    const msg = /with a CMYK output intent, RGB colour \(DeviceRGB\) is not allowed/;
    await expect(ops((p) => p.rect(0, 0, 1, 1, { fill: '#FF0000' }), o)).rejects.toThrow(msg);
    await expect(ops((p) => p.linearGradient(0, 0, 1, 0, [[0, 0], [1, '#FFf']]), o)).rejects.toThrow(msg);
    await expect(ops(async (p, pdf) => pdf.embedImage(png({ w: 2, h: 2, type: 2, depth: 8, px: () => [1, 2, 3] })), o)).rejects.toThrow(msg);
    await expect(ops(async (p, pdf) => pdf.embedImage(png({ w: 2, h: 2, type: 3, depth: 1, px: () => [0], palette: [[0, 0, 0]] })), o)).rejects.toThrow(msg);
    const t = await ops((p) => { p.rect(0, 0, 1, 1, { fill: cmyk(0, 0, 0, 1) }); p.fill(p.path().rect(0, 0, 1, 1), { fill: 0.5, opacity: 0.5 }); }, o);
    expect(t).toContain('0 0 0 1 k');
    expect(t).toContain('/Group << /Type /Group /S /Transparency /CS /DeviceCMYK >>');
    expect(t).toMatch(/\/OutputConditionIdentifier <437573746f6d> \/Info <[0-9a-f]+> \/DestOutputProfile \d+ 0 R/);
  });
  it('an output intent must be an RGB or CMYK output or monitor profile', async () => {
    if (GRAY) await expect(ops(() => {}, { pdfa: { outputIntent: GRAY } })).rejects.toThrow(/RGB or CMYK profile/);
    await expect(ops(() => {}, { pdfa: { outputIntent: 'x' } })).rejects.toThrow(/Uint8Array/);
  });
  it.skipIf(!HAS.verapdf || !SRGB)('veraPDF PDF/A-2b: RGB intent with RGB, gray, ICC and RGB-alternate spot colours — 0 failed rules', async () => {
    const out = await toBytes(async (pdf) => {
      const font = await pdf.embedFont(INTER);
      const p = pdf.addPage();
      const icc = await pdf.iccColorSpace(SRGB), spot = pdf.spotColor('PANTONE 185 C', '#E4002b');
      p.text('Colours', { x: 40, y: 40, font, size: 14, color: icc.color(0.2, 0.2, 0.6) });
      p.rect(40, 70, 100, 40, { fill: spot.tint(0.6), stroke: spot });
      p.rect(160, 70, 100, 40, { fill: 'rgb(30, 120, 200)' });
      p.fill(p.path().rect(280, 70, 100, 40), { fill: p.linearGradient(280, 0, 380, 0, [[0, spot.tint(0)], [1, spot]]) });
      p.fill(p.path().rect(400, 70, 100, 40), { fill: p.linearGradient(400, 0, 500, 0, [[0, icc.color(1, 1, 1)], [1, icc.color(0, 0.5, 0)]]), opacity: 0.7 });
    }, { pdfa: true, title: 'Colours', creationDate: DATE });
    const r = verapdf(out, '2b');
    expect(r.failed).toEqual([]);
    expect(r.ok).toBe(true);
  });
  it.skipIf(!HAS.verapdf || !CMYK)('veraPDF PDF/A-2b: CMYK intent with CMYK, gray, CMYK-alternate spot, CMYK JPEG and transparency — 0 failed rules', async () => {
    const jpg = sharp ? await sharp({ create: { width: 16, height: 16, channels: 3, background: '#2060c0' } }).toColourspace('cmyk').jpeg().toBuffer() : null;
    const out = await toBytes(async (pdf) => {
      const font = await pdf.embedFont(INTER);
      const p = pdf.addPage();
      const spot = pdf.spotColor('Gold', cmyk(0, 0.2, 0.8, 0.1));
      p.text('CMYK', { x: 40, y: 40, font, size: 14, color: cmyk(0, 0, 0, 1) });
      p.rect(40, 70, 100, 40, { fill: cmyk(1, 0.5, 0, 0) });
      p.rect(160, 70, 100, 40, { fill: spot.tint(0.5), stroke: 0.3 });
      p.fill(p.path().rect(280, 70, 100, 40), { fill: p.linearGradient(280, 0, 380, 0, [[0, cmyk(0, 0, 0, 0)], [1, cmyk(0, 1, 1, 0)]]), opacity: 0.6 });
      if (jpg) p.image(await pdf.embedImage(jpg), { x: 40, y: 130, width: 60 });
    }, { pdfa: { outputIntent: CMYK }, title: 'CMYK', creationDate: DATE });
    const r = verapdf(out, '2b');
    expect(r.failed).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
