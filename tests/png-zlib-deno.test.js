// PNGs with Deno 2.1's node:zlib (Supabase Edge Functions run it): its crc32 returns a signed number and its
// inflateSync ignores { info: true }, returning the bytes alone. Before the fix every PNG was refused there ("bad CRC
// in the IHDR chunk", then "truncated image data"). The library is loaded with process.getBuiltinModule returning
// such a zlib, and must embed the same PNGs, into the same bytes, as with Node's.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import zlib from 'node:zlib';
import { createPdf, toBytes } from '../src/index.js';
import { png } from './image-fixtures.js';

const deno21 = {
  ...zlib,
  crc32: (/** @type {Uint8Array} */ b) => zlib.crc32(b) | 0,
  inflateSync: (/** @type {Uint8Array} */ b, /** @type {any} */ o) => zlib.inflateSync(b, { ...o, info: false }),
};
const DATE = new Date('2026-01-01');
const IMAGES = {
  rgb: png({ w: 9, h: 7, type: 2, depth: 8, px: (x, y) => [x * 20, y * 30, 99] }),
  rgba: png({ w: 9, h: 7, type: 6, depth: 8, px: (x, y) => [x * 20, y * 30, 99, (x + y) * 15] }),
  interlaced: png({ w: 9, h: 7, type: 2, depth: 8, interlace: 1, px: (x, y) => [x * 20, y * 30, 99] }),
  grey16: png({ w: 5, h: 5, type: 0, depth: 16, px: (x, y) => [x * 9000 + y] }),
  palette: png({
    w: 6,
    h: 3,
    type: 3,
    depth: 2,
    palette: [
      [0, 0, 0],
      [255, 0, 0],
      [0, 255, 0],
    ],
    px: (x) => [x % 3],
  }),
};
/** @param {any} lib @param {Uint8Array} image */
const embed = (lib, image) =>
  lib.toBytes(
    async (/** @type {any} */ pdf) => {
      const img = await pdf.embedImage(image);
      pdf.addPage({ width: 100, height: 100 }).image(img, { x: 0, y: 0, width: 80, height: 80 });
    },
    { creationDate: DATE, compress: false },
  );

let lib,
  asked = 0;
const real = process.getBuiltinModule;
beforeAll(async () => {
  process.getBuiltinModule = (m) => {
    if (m === 'node:zlib' || m === 'zlib') {
      asked++;
      return deno21;
    }
    return real.call(process, m);
  };
  vi.resetModules();
  lib = await import('../src/index.js');
});
afterAll(() => {
  process.getBuiltinModule = real;
});

describe("PNG with Deno 2.1's node:zlib", () => {
  it('the stub behaves as Deno 2.1 does', () => {
    expect(deno21.crc32(Buffer.from('123456789'))).toBe(-873187034); // 0xcbf43926 as a signed int
    expect(deno21.inflateSync(zlib.deflateSync(Buffer.from('abc')), { info: true }).engine).toBeUndefined();
  });
  for (const [name, image] of Object.entries(IMAGES))
    it(`embeds ${name} as with Node's zlib`, async () => {
      const got = Buffer.from(await embed(lib, image));
      const want = Buffer.from(await embed({ createPdf, toBytes }, image));
      expect(asked).toBeGreaterThan(0); // the library did use the stubbed zlib
      expect(got.equals(want)).toBe(true);
    });
});
