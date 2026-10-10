// @reportwright/pdf images: every PNG colour type and bit depth, Adam7, tRNS, alpha as an SMask, IDAT passthrough;
// JPEG passthrough (baseline, progressive, gray, RGB, CMYK with Adobe's inversion, EXIF orientation); fit, opacity,
// reuse; checked with pdfimages, pdftoppm pixels and pdf-lib.
import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { toBytes } from '../src/index.js';
import { HAS, latin } from './tools.js';
import { png, sharp, sipsJpeg, pixels, near, pdfimages } from './image-fixtures.js';

const DATE = new Date('2026-01-01');
/** a 100 × 100 page with a blue background and the image drawn over (0, 0, 80, 80) by default */
async function page(bytes, o = {}, bg = '#0000ff', opts = {}) {
  const out = await toBytes(
    async (pdf) => {
      const p = pdf.addPage({ width: 100, height: 100 });
      p.rect(0, 0, 100, 100, { fill: bg });
      const img = await pdf.embedImage(bytes);
      p.image(img, { x: 0, y: 0, width: 80, height: 80, ...o });
    },
    { creationDate: DATE, ...opts },
  );
  await PDFDocument.load(out); // an independent parser reads it
  return out;
}
const max = (d) => (1 << d) - 1;

describe.skipIf(!HAS.poppler)('PNG', () => {
  // an 8 × 8 image: the left half one value, the right half another, so pixels prove orientation and scale
  const cases = [];
  for (const [type, depths] of [
    [0, [1, 2, 4, 8, 16]],
    [2, [8, 16]],
    [3, [1, 2, 4, 8]],
    [4, [8, 16]],
    [6, [8, 16]],
  ]) {
    for (const depth of depths) for (const interlace of [0, 1]) cases.push([type, depth, interlace]);
  }
  it.each(cases)(
    'colour type %i, depth %i, interlace %i: the right type, size, bit depth and pixels',
    async (type, depth, interlace) => {
      const M = max(depth);
      const left = { 0: [0], 2: [M, 0, 0], 3: [0], 4: [0, M], 6: [M, 0, 0, M] }[type];
      const right = { 0: [M], 2: [0, M, 0], 3: [1], 4: [M, M], 6: [0, M, 0, M] }[type];
      const bytes = png({
        w: 8,
        h: 8,
        type,
        depth,
        interlace,
        px: (x) => (x < 4 ? left : right),
        palette:
          type === 3
            ? [
                [255, 0, 0],
                [0, 255, 0],
              ]
            : undefined,
      });
      const out = await page(bytes);
      const list = pdfimages(out);
      const want = { 0: 'gray', 2: 'rgb', 3: 'index', 4: 'gray', 6: 'rgb' }[type];
      expect(list[0]).toMatchObject({ type: 'image', width: 8, height: 8, color: want, bpc: depth });
      if (type === 4 || type === 6)
        expect(list[1]).toMatchObject({ type: 'smask', width: 8, height: 8, color: 'gray', bpc: depth });
      else expect(list).toHaveLength(1);
      const px = pixels(out);
      const L = { 0: [0, 0, 0], 2: [255, 0, 0], 3: [255, 0, 0], 4: [0, 0, 0], 6: [255, 0, 0] }[type];
      const R = { 0: [255, 255, 255], 2: [0, 255, 0], 3: [0, 255, 0], 4: [255, 255, 255], 6: [0, 255, 0] }[type];
      expect(px(20, 40)).toEqual(L);
      expect(px(60, 40)).toEqual(R);
      expect(px(90, 90)).toEqual([0, 0, 255]); // the background outside the image
    },
  );
  it('non-interlaced gray/RGB/palette without alpha: the IDAT bytes are passed through with the PNG predictor', async () => {
    const bytes = png({ w: 16, h: 4, type: 2, depth: 8, px: (x, y) => [x * 16, y * 60, 128] });
    const out = await page(bytes, {}, '#0000ff', { compress: false });
    const t = latin(out);
    // the IDAT data (two chunks, joined) appears verbatim in the file
    const idat = [];
    for (let at = 8; at < bytes.length;) {
      const n = ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0,
        type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
      if (type === 'IDAT') idat.push(...bytes.subarray(at + 8, at + 8 + n));
      at += 12 + n;
    }
    expect(t).toContain(Buffer.from(idat).toString('latin1'));
    expect(t).toMatch(/\/DecodeParms << \/Predictor 15 \/Colors 3 \/Columns 16 >>/);
  });
  it('RGBA over a coloured background blends; the SMask carries the alpha', async () => {
    const bytes = png({ w: 4, h: 4, type: 6, depth: 8, px: (x) => [255, 0, 0, x < 2 ? 128 : 0] });
    const px = pixels(await page(bytes));
    expect(near(px(10, 40), [128, 0, 127], 6)).toBe(true); // half red over blue
    expect(px(70, 40)).toEqual([0, 0, 255]); // alpha 0: the background
  });
  it('tRNS: a colour key on 8-bit gray (passed through with /Mask), 16-bit RGB and palettes (an SMask)', async () => {
    const g = png({ w: 4, h: 4, type: 0, depth: 8, px: (x) => [x < 2 ? 0 : 200], trns: [0, 200] });
    let px = pixels(await page(g));
    expect(px(10, 40)).toEqual([0, 0, 0]);
    expect(px(70, 40)).toEqual([0, 0, 255]); // keyed out
    const rgb = png({
      w: 4,
      h: 4,
      type: 2,
      depth: 16,
      px: (x) => (x < 2 ? [65535, 0, 0] : [0, 65535, 0]),
      trns: [0, 0, 255, 255, 0, 0],
    });
    const out = await page(rgb, {}, '#0000ff', { compress: false });
    expect(latin(out)).not.toContain('/Mask'); // 16-bit: an SMask (poppler ignores 16-bit colour keys)
    expect(pdfimages(out).map((r) => r.type)).toEqual(['image', 'smask']);
    px = pixels(out);
    expect(px(10, 40)).toEqual([255, 0, 0]);
    expect(px(70, 40)).toEqual([0, 0, 255]);
    const pal = png({
      w: 4,
      h: 4,
      type: 3,
      depth: 2,
      px: (x) => [x < 2 ? 0 : 1],
      palette: [
        [255, 0, 0],
        [0, 255, 0],
      ],
      trns: [255, 0],
    });
    const po = await page(pal);
    expect(pdfimages(po).map((r) => r.type)).toEqual(['image', 'smask']);
    px = pixels(po);
    expect(px(10, 40)).toEqual([255, 0, 0]);
    expect(px(70, 40)).toEqual([0, 0, 255]);
  });
  it('a palette index past the palette draws (the palette is padded), never an out-of-range index', async () => {
    const out = await page(
      png({ w: 4, h: 4, type: 3, depth: 4, px: () => [15], palette: [[255, 0, 0]] }),
      {},
      '#0000ff',
      { compress: false },
    );
    expect(latin(out)).toMatch(/\/Indexed \/DeviceRGB 15 <ff0000(000000){15}>/);
  });
  it('larger interlaced images (odd sizes, every pass; RGBA 8-bit, gray 2-bit) decode to the same pixels as non-interlaced', async () => {
    const w = 37,
      h = 23,
      S = 8; // drawn 8 points per pixel: block centres are exact
    for (const [type, depth, f] of [
      [6, 8, (x, y) => [(x * 7) & 255, (y * 11) & 255, (x * y) & 255, 255]],
      [0, 2, (x, y) => [(x + y) & 3]],
    ]) {
      const draw = (interlace) =>
        toBytes(
          async (pdf) => {
            const p = pdf.addPage({ width: w * S, height: h * S });
            p.image(await pdf.embedImage(png({ w, h, type, depth, interlace, px: f })), { x: 0, y: 0, width: w * S });
          },
          { creationDate: DATE },
        );
      const a = pixels(await draw(0)),
        b = pixels(await draw(1));
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) expect(b(x * S + 4, y * S + 4)).toEqual(a(x * S + 4, y * S + 4));
      for (const [x, y] of [
        [0, 0],
        [5, 3],
        [36, 22],
        [17, 11],
        [30, 1],
      ]) {
        const want = type === 6 ? f(x, y).slice(0, 3) : Array(3).fill(f(x, y)[0] * 85);
        expect(near(a(x * S + 4, y * S + 4), want, 3), `${x},${y}`).toBe(true);
      }
    }
  });
});

describe('page.image placement', () => {
  const img = png({ w: 20, h: 10, type: 2, depth: 8, px: () => [255, 0, 0] });
  it.skipIf(!HAS.poppler)(
    "fit: 'fill' stretches, 'contain' centres the whole image, 'cover' fills the box and is cut to it",
    async () => {
      let px = pixels(await page(img, { x: 10, y: 10, width: 40, height: 40, fit: 'contain' }));
      expect(px(30, 30)).toEqual([255, 0, 0]);
      expect(px(30, 15)).toEqual([0, 0, 255]); // above the contained 40 × 20 band (y 20–40)
      px = pixels(await page(img, { x: 10, y: 10, width: 40, height: 40, fit: 'cover' }));
      expect(px(12, 12)).toEqual([255, 0, 0]);
      expect(px(5, 30)).toEqual([0, 0, 255]); // cut at the box's left edge
      expect(px(55, 30)).toEqual([0, 0, 255]);
      px = pixels(await page(img, { x: 10, y: 10, width: 40, height: 40 }));
      expect(px(12, 48)).toEqual([255, 0, 0]);
    },
  );
  it('one dimension keeps the aspect ratio; neither is pixels as points; opacity uses an ExtGState', async () => {
    const out = await toBytes(
      async (pdf) => {
        const p = pdf.addPage({ width: 100, height: 100 });
        const i = await pdf.embedImage(img);
        expect([i.width, i.height]).toEqual([20, 10]);
        p.image(i, { width: 40 });
        p.image(i, { x: 50 });
        p.image(i, { height: 5, opacity: 0.5 });
      },
      { creationDate: DATE, compress: false },
    );
    const t = latin(out);
    expect(t).toContain('40 0 0 20 0 80 cm');
    expect(t).toContain('20 0 0 10 50 90 cm');
    expect(t).toMatch(/q \/GS1 gs 10 0 0 5 0 95 cm \/[A-Za-z0-9]+ Do Q/);
    expect(t).toContain('/ca 0.5');
  });
  it('the same image drawn many times is one XObject', async () => {
    const out = await toBytes(
      async (pdf) => {
        const i = await pdf.embedImage(img);
        for (let k = 0; k < 3; k++) {
          const p = pdf.addPage();
          for (let j = 0; j < 10; j++) p.image(i, { x: j * 20, y: 0, width: 20 });
        }
      },
      { creationDate: DATE, compress: false },
    );
    expect(latin(out).match(/\/Subtype \/Image/g)).toHaveLength(1);
    expect(latin(out).match(/ Do Q/g)).toHaveLength(30);
  });
  it('bad options throw; images are handles of their own PDF', async () => {
    await expect(
      toBytes(async (pdf) => {
        const i = await pdf.embedImage(img);
        pdf.addPage().image(i, { fit: 'stretch' });
      }),
    ).rejects.toThrow(/fit is/);
    await expect(
      toBytes(async (pdf) => {
        const i = await pdf.embedImage(img);
        pdf.addPage().image(i, { width: -1 });
      }),
    ).rejects.toThrow(/> 0/);
    await expect(
      toBytes(async (pdf) => {
        const i = await pdf.embedImage(img);
        pdf.addPage().image(i, { x: NaN });
      }),
    ).rejects.toThrow(/usable number/);
    await expect(
      toBytes(async (pdf) => {
        pdf.addPage().image({ type: 'image', width: 1, height: 1 });
      }),
    ).rejects.toThrow(/Not an image/);
    let other;
    await toBytes(async (pdf) => {
      other = await pdf.embedImage(img);
    });
    await expect(
      toBytes(async (pdf) => {
        pdf.addPage().image(other);
      }),
    ).rejects.toThrow(/another PDF/);
    await expect(
      toBytes(async (pdf) => {
        await pdf.embedImage(new Uint8Array([1, 2, 3]));
      }),
    ).rejects.toThrow(/not a JPEG or PNG/);
    await expect(
      toBytes(async (pdf) => {
        await pdf.embedImage('x.png');
      }),
    ).rejects.toThrow(/Uint8Array/);
  });
});

describe.skipIf(!HAS.poppler || !sharp)('JPEG (DCTDecode passthrough)', () => {
  /** 40 × 20: left half red, right half blue */
  const halves = () =>
    sharp(Buffer.from(Array.from({ length: 40 * 20 }, (_, i) => (i % 40 < 20 ? [255, 0, 0] : [0, 0, 255])).flat()), {
      raw: { width: 40, height: 20, channels: 3 },
    });
  it('baseline and progressive RGB: the file is embedded unchanged', async () => {
    for (const progressive of [false, true]) {
      const jpg = new Uint8Array(await halves().jpeg({ quality: 95, progressive }).toBuffer());
      const out = await page(jpg, { width: 80, height: 40 }, '#ffffff', { compress: false });
      expect(latin(out)).toContain(Buffer.from(jpg).toString('latin1'));
      expect(pdfimages(out)[0]).toMatchObject({ enc: 'jpeg', color: 'rgb', comp: 3, bpc: 8, width: 40, height: 20 });
      const px = pixels(out);
      expect(near(px(20, 20), [255, 0, 0], 20)).toBe(true);
      expect(near(px(60, 20), [0, 0, 255], 20)).toBe(true);
    }
  });
  it('gray', async () => {
    const jpg = new Uint8Array(await halves().toColourspace('b-w').jpeg().toBuffer());
    const out = await page(jpg, { width: 80, height: 40 });
    expect(pdfimages(out)[0]).toMatchObject({ enc: 'jpeg', color: 'gray', comp: 1 });
  });
  it("CMYK: Adobe's inverted CMYK is drawn with /Decode [1 0 …] and renders the right colours", async () => {
    const jpg = new Uint8Array(await halves().toColourspace('cmyk').jpeg({ quality: 95 }).toBuffer());
    const out = await page(jpg, { width: 80, height: 40 }, '#ffffff', { compress: false });
    expect(latin(out)).toContain(
      '/ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /DCTDecode /Decode [1 0 1 0 1 0 1 0]',
    );
    expect(pdfimages(out)[0]).toMatchObject({ enc: 'jpeg', color: 'cmyk', comp: 4 });
    const px = pixels(out);
    const [r, g, b] = px(20, 20),
      [r2, g2, b2] = px(60, 20);
    expect(r).toBeGreaterThan(180);
    expect(g).toBeLessThan(90);
    expect(b).toBeLessThan(90); // red-ish
    expect(b2).toBeGreaterThan(120);
    expect(r2).toBeLessThan(110); // blue-ish
  });
  it('EXIF orientation 6 (rotate 90° clockwise) is honoured: width and height swap, the left half ends on top', async () => {
    const jpg = new Uint8Array(await halves().jpeg().withMetadata({ orientation: 6 }).toBuffer());
    let size;
    const out = await toBytes(
      async (pdf) => {
        const p = pdf.addPage({ width: 100, height: 100 });
        const i = await pdf.embedImage(jpg);
        size = [i.width, i.height];
        p.image(i, { x: 0, y: 0, width: 40, height: 80 });
      },
      { creationDate: DATE },
    );
    expect(size).toEqual([20, 40]);
    const px = pixels(out);
    expect(near(px(20, 20), [255, 0, 0], 30)).toBe(true); // top: was the left
    expect(near(px(20, 60), [0, 0, 255], 30)).toBe(true);
  });
  it('every EXIF orientation puts the stored top-left corner where it belongs', async () => {
    // a 40 × 20 image, red only in its top-left 10 × 10 corner
    const raw = Buffer.from(
      Array.from({ length: 800 }, (_, i) => (i % 40 < 10 && i < 400 ? [255, 0, 0] : [255, 255, 255])).flat(),
    );
    // where the stored top-left corner lands on the drawn image (top-left, top-right, bottom-right, bottom-left)
    const corner = { 1: 'tl', 2: 'tr', 3: 'br', 4: 'bl', 5: 'tl', 6: 'tr', 7: 'br', 8: 'bl' };
    for (let o = 1; o <= 8; o++) {
      const jpg = new Uint8Array(
        await sharp(raw, { raw: { width: 40, height: 20, channels: 3 } })
          .jpeg({ quality: 98 })
          .withMetadata({ orientation: o })
          .toBuffer(),
      );
      const out = await toBytes(
        async (pdf) => {
          const p = pdf.addPage({ width: 100, height: 100 });
          p.image(await pdf.embedImage(jpg), { x: 0, y: 0 });
        },
        { creationDate: DATE },
      );
      const px = pixels(out);
      const W = o >= 5 ? 20 : 40,
        H = o >= 5 ? 40 : 20;
      const at = { tl: [3, 3], tr: [W - 4, 3], br: [W - 4, H - 4], bl: [3, H - 4] }[corner[o]];
      expect(near(px(...at), [255, 0, 0], 40), `orientation ${o}`).toBe(true);
    }
  });
  it('a JPEG made by sips (macOS) embeds too', async () => {
    const jpg = sipsJpeg(png({ w: 16, h: 16, type: 2, depth: 8, px: () => [0, 200, 0] }));
    if (!jpg) return;
    const px = pixels(await page(jpg));
    expect(near(px(40, 40), [0, 200, 0], 20)).toBe(true);
  });
});

describe('after pdf.end()', () => {
  it('embedImage, iccColorSpace and spotColor throw instead of writing past the end of the file', async () => {
    const pdf = (await import('../src/index.js')).createPdf({ write() {} });
    await pdf.end();
    await expect(pdf.embedImage(png({ w: 1, h: 1, type: 0, depth: 8, px: () => [0] }))).rejects.toThrow(/has ended/);
    expect(() => pdf.spotColor('X', 0)).toThrow(/has ended/);
    await expect(pdf.end()).rejects.toThrow(/has ended/);
  });
});

describe('automatic image dedup', () => {
  const a = png({ w: 64, h: 64, type: 6, depth: 8, px: (x, y) => [x * 4, y * 4, 9, 200] });
  const count = (out) => (latin(out).match(/\/Subtype \/Image/g) || []).length;
  it('the same bytes twice: one handle, one XObject, a smaller file', async () => {
    let h1, h2;
    const twice = await toBytes(
      async (pdf) => {
        h1 = await pdf.embedImage(a);
        h2 = await pdf.embedImage(a.slice());
        pdf.addPage().image(h1, { width: 50 }).image(h2, { y: 60, width: 50 });
      },
      { creationDate: DATE, compress: false },
    );
    const distinct = await toBytes(
      async (pdf) => {
        const p = pdf.addPage();
        p.image(await pdf.embedImage(a), { width: 50 });
        p.image(await pdf.embedImage(a, { maxDecodedBytes: 1 << 20 }), { y: 60, width: 50 }); // other options: not shared
      },
      { creationDate: DATE, compress: false },
    );
    expect(h1).toBe(h2);
    expect(count(twice)).toBe(2); // the image and its SMask, once
    expect(count(distinct)).toBe(4);
    expect(twice.length).toBeLessThan(distinct.length);
  });
  it('per document: a handle from one PDF is still refused in another', async () => {
    let h;
    await toBytes(async (pdf) => {
      h = await pdf.embedImage(a);
    });
    await expect(
      toBytes(async (pdf) => {
        const h2 = await pdf.embedImage(a);
        expect(h2).not.toBe(h);
        pdf.addPage().image(h);
      }),
    ).rejects.toThrow(/another PDF/);
  });
});
