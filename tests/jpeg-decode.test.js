// The JPEG decoder (src/images/jpeg-decode.js): the fixtures (made with cjpeg / sharp) against libjpeg, and hostile
// JPEGs that must stop early with a clear error. Pixel comparison with pdf.js: render.test.js (the jpeg pages).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { decodeJpeg, MAX_SCANS } from '../src/images/jpeg-decode.js';
import { ROOT } from './tools.js';

const DIR = path.join(ROOT, 'tests/fixtures/jpeg');
const read = (f) => fs.readFileSync(path.join(DIR, f));
const opts = { maxPixels: 25_000_000, tick() {} };
let sharp = null;
try {
  sharp = (await import('sharp')).default;
} catch {}

describe('decodeJpeg: fixtures', () => {
  it.runIf(sharp)('4:4:4 baseline and progressive match libjpeg within 2 levels', async () => {
    for (const f of ['baseline-444.jpg', 'progressive-444.jpg']) {
      const ours = decodeJpeg(read(f), opts);
      const ref = await sharp(read(f)).raw().toBuffer();
      expect([ours.w, ours.h, ours.comps]).toEqual([61, 45, 3]);
      expect(ours.data.every((v, i) => Math.abs(v - ref[i]) <= 2)).toBe(true);
    }
  });
  it('restart markers, Huffman-optimised and progressive 4:2:0 decode alike (same quality)', () => {
    const a = decodeJpeg(read('optimized.jpg'), opts).data;
    for (const f of ['restart.jpg', 'progressive-420.jpg']) {
      const b = decodeJpeg(read(f), opts).data;
      expect(b.every((v, i) => Math.abs(v - a[i]) <= 2)).toBe(true);
    }
  });
  it('4:2:2, gray progressive, Adobe CMYK', () => {
    expect(decodeJpeg(read('baseline-422.jpg'), opts).comps).toBe(3);
    expect(decodeJpeg(read('gray-progressive.jpg'), opts).comps).toBe(1);
    const c = decodeJpeg(read('cmyk-adobe.jpg'), opts);
    expect(c.comps).toBe(4);
    expect(c.data.length).toBe(61 * 45 * 4);
  });
});

/** a JPEG from segments: [marker, bytes] */
const jpeg = (...segs) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...segs.map(([m, b]) =>
      Buffer.concat([Buffer.from([0xff, m, (b.length + 2) >> 8, (b.length + 2) & 255]), Buffer.from(b)]),
    ),
    Buffer.from([0xff, 0xd9]),
  ]);
const sof = (w, h, comps, bits = 8, m = 0xc0) => [
  m,
  [bits, h >> 8, h & 255, w >> 8, w & 255, comps.length, ...comps.flatMap((s, i) => [i + 1, s, 0])],
];

describe('decodeJpeg: hostile input stops early, before allocating', () => {
  const quick = (b, re, o = opts) => {
    const t = Date.now();
    expect(() => decodeJpeg(b, o)).toThrow(re);
    expect(Date.now() - t).toBeLessThan(2000);
  };
  it('dimensions over the pixel cap', () => quick(jpeg(sof(65535, 65535, [0x11])), /more than 25,000,000 pixels/));
  it('more than 4 components, and bad sampling', () => {
    quick(jpeg(sof(8, 8, [0x11, 0x11, 0x11, 0x11, 0x11])), /1 to 4 components/);
    quick(jpeg(sof(8, 8, [0x51])), /bad component/);
    quick(jpeg(sof(8, 8, [0x44, 0x22, 0x11])), /10 blocks per MCU/);
  });
  it('12-bit, arithmetic, lossless: not supported', () => {
    quick(jpeg(sof(8, 8, [0x11], 12)), /12-bit samples are not supported/);
    quick(jpeg(sof(8, 8, [0x11], 8, 0xc9)), /arithmetic coding is not supported/);
    quick(jpeg(sof(8, 8, [0x11], 8, 0xc3)), /lossless/);
  });
  it('a Huffman table with more codes than its lengths allow, or too many codes', () => {
    quick(jpeg([0xc4, [0x00, 3, ...Array(15).fill(0), 1, 2, 3]]), /more codes than its lengths allow/);
    quick(
      jpeg([0xc4, [0x00, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 0, 0, 0, 0, 0, 0, ...Array(510).fill(0)]]),
      /too many codes/,
    );
  });
  it('more scans than the cap', () => {
    const dht = [0xc4, [0x00, 1, ...Array(15).fill(0), 0]];
    const scan = [0xda, [1, 1, 0x00, 0, 0, 0]];
    quick(
      jpeg(sof(8, 8, [0x11], 8, 0xc2), dht, ...Array(MAX_SCANS + 1).fill(scan)),
      new RegExp(`more than ${MAX_SCANS} scans`),
    );
  });
  it('the coefficient buffers are charged to the budget before they exist', () => {
    let charged = 0;
    const tick = (n) => {
      charged += n;
      if (charged > 1000) throw new Error('budget');
    };
    quick(jpeg(sof(5000, 5000, [0x11, 0x11, 0x11])), /budget/, { maxPixels: 25_000_000, tick });
  });
  it('truncated and garbage-filled data stop, never loop', () => {
    const b = read('progressive-420.jpg');
    for (const cut of [20, 200, 400, b.length - 10]) {
      const t = Date.now();
      try {
        decodeJpeg(b.subarray(0, cut), opts);
      } catch (e) {
        expect(e).toBeInstanceOf(TypeError);
      }
      expect(Date.now() - t).toBeLessThan(1000);
    }
    const g = Buffer.from(b);
    for (let i = 300; i < g.length - 2; i += 7) g[i] ^= 0x5a;
    const t = Date.now();
    try {
      decodeJpeg(g, opts);
    } catch (e) {
      expect(e).toBeInstanceOf(TypeError);
    }
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
