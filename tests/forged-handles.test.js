// Handles the library makes (gradients, tiling patterns, fonts, pages) are branded: a forged object, a copy of a real
// one, or one from another document is refused, so nothing a caller builds is written into the PDF as raw syntax.
import { describe, it, expect } from 'vitest';
import { toBytes } from '../src/index.js';
import { latin } from './tools.js';

const DATE = new Date('2026-01-01');
const EVIL = '<< /S /JavaScript /JS (app.alert(1)) >>';

/** draw(page, pdf) must throw re; the PDF written without that call has no /JavaScript */
async function refused(draw, re) {
  let err;
  const out = await toBytes(
    async (pdf) => {
      const p = pdf.addPage();
      try {
        await draw(p, pdf);
      } catch (e) {
        err = e;
      }
    },
    { compress: false, creationDate: DATE },
  );
  expect(err?.message).toMatch(re);
  expect(latin(out)).not.toContain('/JavaScript');
}

describe('forged handles', () => {
  it('a forged gradient as fill, stroke or shade', async () => {
    const forged = { type: 'gradient', dict: EVIL };
    await refused(
      (p) => p.fill(p.path().rect(0, 0, 9, 9), { fill: forged }),
      /Not a gradient or pattern .*made by this library/,
    );
    await refused(
      (p) => p.stroke(p.path().rect(0, 0, 9, 9), { stroke: forged }),
      /Not a gradient or pattern .*made by this library/,
    );
    await refused((p) => p.shade(forged), /Not a gradient .* made by this library/);
  });
  it('a forged tiling pattern', async () => {
    const forged = {
      type: 'tiling',
      w: 1,
      h: 1,
      xs: 1,
      ys: 1,
      res: EVIL,
      content: 'Q',
      transparent: false,
      refs: new Map(),
    };
    await refused(
      (p) => p.fill(p.path().rect(0, 0, 9, 9), { fill: forged }),
      /Not a gradient or pattern .*made by this library/,
    );
  });
  it('a copy of a real gradient or pattern (frozen or not)', async () => {
    await refused((p) => {
      const g = p.linearGradient(0, 0, 9, 0, [
        [0, 0],
        [1, 1],
      ]);
      p.fill(p.path().rect(0, 0, 9, 9), { fill: Object.freeze(Object.assign({}, g, { dict: EVIL })) });
    }, /Not a gradient or pattern .*made by this library/);
    await refused((p) => {
      const t = p.tilingPattern({ width: 2, height: 2 }, (c) => c.fill(c.path().rect(0, 0, 1, 1)));
      p.fill(p.path().rect(0, 0, 9, 9), { fill: { ...t } });
    }, /Not a gradient or pattern .*made by this library/);
  });
  it('a real gradient or pattern from another document', async () => {
    let g, t;
    await toBytes(
      (pdf) => {
        const p = pdf.addPage();
        g = p.linearGradient(0, 0, 9, 0, [
          [0, 0],
          [1, 1],
        ]);
        t = p.tilingPattern({ width: 2, height: 2 }, (c) => c.fill(c.path().rect(0, 0, 1, 1)));
      },
      { creationDate: DATE },
    );
    await refused((p) => p.fill(p.path().rect(0, 0, 9, 9), { fill: g }), /belongs to another PDF/);
    await refused((p) => p.fill(p.path().rect(0, 0, 9, 9), { fill: t }), /belongs to another PDF/);
    await refused((p) => p.shade(g), /belongs to another PDF/);
  });
  it('a real handle cannot be altered (frozen) and its type tag means nothing', async () => {
    await toBytes(
      (pdf) => {
        const p = pdf.addPage();
        const g = p.linearGradient(0, 0, 9, 0, [
          [0, 0],
          [1, 1],
        ]);
        expect(Object.isFrozen(g)).toBe(true);
        expect(() => {
          'use strict';
          g.dict = EVIL;
        }).toThrow();
      },
      { creationDate: DATE },
    );
  });
  it('a forged or copied font, and a font whose methods were swapped', async () => {
    await refused(
      (p) => p.text('x', { font: { encode: () => ') Tj /JavaScript', name: 'F1', ascent: 1, doc: p.doc } }),
      /Not a font made by this library/,
    );
    await refused((p, pdf) => {
      const f = pdf.standardFont('Helvetica');
      p.text('x', { font: { ...f, encode: () => '/JavaScript' } });
    }, /Not a font made by this library/);
    await refused((p, pdf) => {
      const f = pdf.standardFont('Helvetica');
      f.encode = () => '/JavaScript';
    }, /read.only|Cannot assign/);
    let other;
    await toBytes(
      (pdf) => {
        other = pdf.standardFont('Helvetica');
      },
      { creationDate: DATE },
    );
    await refused((p) => p.text('x', { font: other }), /belongs to another PDF/);
  });
  it('a forged page object as a link or outline target; a page whose index was changed still links to itself', async () => {
    await refused(
      (p) => p.link(0, 0, 9, 9, { page: { index: '0 0 R /JavaScript' } }),
      /Not a page made by this library/,
    );
    await refused(
      (p, pdf) => pdf.outline({ title: 'x', page: { index: '0 /JavaScript' } }),
      /Not a page made by this library/,
    );
    await refused((p) => p.link(0, 0, 9, 9, { page: 1.5 }), /whole number/);
    const out = await toBytes(
      (pdf) => {
        const a = pdf.addPage(),
          b = pdf.addPage();
        b.index = '0 /JavaScript';
        a.link(0, 0, 9, 9, { page: b });
        pdf.outline({ title: 'B', page: b });
      },
      { compress: false, creationDate: DATE },
    );
    expect(latin(out)).not.toContain('/JavaScript');
  });
});

describe('group B handles: images, spot colours, ICC colour spaces and colours', () => {
  const PNG = new Uint8Array(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  it('a forged image, spot, ICC colour space or colour carrying raw PDF is refused', async () => {
    await refused(
      (p) => p.image({ type: 'image', width: 1, height: 1, ref: EVIL }),
      /Not an image \(pdf.embedImage\) made by this library/,
    );
    await refused((p) => p.rect(0, 0, 1, 1, { fill: { type: 'spot', name: EVIL, tint: () => ({}) } }), /Not a colour/);
    await refused((p) => p.rect(0, 0, 1, 1, { fill: { type: 'color', cs: EVIL, comps: [1] } }), /Not a colour/);
    await refused(
      (p, pdf) => pdf.embedImage(PNG, { colorSpace: { type: 'iccColorSpace', components: 1, cs: EVIL } }),
      /Not an ICC colour space/,
    );
  });
  it('copies of real ones are refused; real ones cannot be altered', async () => {
    await refused(async (p, pdf) => {
      const img = await pdf.embedImage(PNG),
        s = pdf.spotColor('S', 0);
      expect(Object.isFrozen(img) && Object.isFrozen(s)).toBe(true);
      expect(() => {
        img.ref = EVIL;
      }).toThrow();
      p.rect(0, 0, 1, 1, { fill: { ...s } });
    }, /Not a colour/);
    await refused(async (p, pdf) => p.image({ ...(await pdf.embedImage(PNG)) }), /Not an image/);
  });
  it('handles from another PDF are refused', async () => {
    let img, spot, icc, col;
    await toBytes(async (pdf) => {
      img = await pdf.embedImage(PNG);
      spot = pdf.spotColor('S', 0);
      col = spot.tint(0.5);
      icc = spot;
    });
    await refused((p) => p.image(img), /another PDF/);
    await refused((p) => p.rect(0, 0, 1, 1, { fill: spot }), /another PDF/);
    await refused((p) => p.rect(0, 0, 1, 1, { fill: col }), /another PDF/);
    await refused((p, pdf) => pdf.embedImage(PNG, { colorSpace: icc }), /Not an ICC colour space/);
  });
});
