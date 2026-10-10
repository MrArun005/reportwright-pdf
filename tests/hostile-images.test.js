// Hostile images and ICC profiles: each must throw a clear error quickly, without a large allocation.
import zlib from 'node:zlib';
import { describe, it, expect } from 'vitest';
import { toBytes } from '../src/index.js';
import { png, chunk, ihdr, SIG, profile } from './image-fixtures.js';

/** run fn on a fresh PDF; expect it to throw re within 1 s and grow memory by under 64 MB */
async function refuses(fn, re) {
  global.gc?.();
  const before = process.memoryUsage();
  const t = performance.now();
  await expect(
    toBytes(async (pdf) => {
      await fn(pdf);
    }),
  ).rejects.toThrow(re);
  const ms = performance.now() - t,
    after = process.memoryUsage();
  expect(ms).toBeLessThan(1000);
  expect(after.arrayBuffers - before.arrayBuffers).toBeLessThan(64 << 20);
  expect(after.heapUsed - before.heapUsed).toBeLessThan(64 << 20);
}
const good = png({ w: 16, h: 16, type: 6, depth: 8, px: (x, y) => [x * 16, y * 16, 0, 255] });

describe('hostile PNGs', () => {
  it('a truncated PNG', async () => {
    for (const cut of [20, 40, good.length - 30, good.length - 5])
      await refuses((pdf) => pdf.embedImage(good.subarray(0, cut)), /PNG: truncated/);
  });
  it('a zip bomb: IDAT inflates to 100× its declared size', async () => {
    // declared 100 × 100 gray 8-bit (10,100 bytes); the IDAT holds 1,010,000 zero bytes (100×), then 16 MiB (1,660×)
    for (const n of [1_010_000, 16 << 20]) {
      const z = zlib.deflateSync(Buffer.alloc(n), { level: 9 });
      const f = Buffer.concat([SIG, ihdr(100, 100, 8, 0), chunk('IDAT', z), chunk('IEND', Buffer.alloc(0))]);
      await refuses((pdf) => pdf.embedImage(f), /inflates past the 10,100 bytes its header allows/);
      // with alpha (the decoding path) too
      const g = Buffer.concat([SIG, ihdr(50, 101, 8, 4), chunk('IDAT', z), chunk('IEND', Buffer.alloc(0))]);
      await refuses((pdf) => pdf.embedImage(g), /inflates past/);
    }
  });
  it('a huge width × height header', async () => {
    const huge = (w, h) =>
      Buffer.concat([
        SIG,
        ihdr(w, h, 8, 6),
        chunk('IDAT', zlib.deflateSync(Buffer.alloc(10))),
        chunk('IEND', Buffer.alloc(0)),
      ]);
    await refuses((pdf) => pdf.embedImage(huge(65535, 65535)), /over 100 megapixels/);
    await refuses((pdf) => pdf.embedImage(huge(0x7fffffff, 1)), /each side is 1–65535/);
    await refuses((pdf) => pdf.embedImage(huge(0, 10)), /each side/);
    // under the pixel cap but over the decoded-size cap for an interlaced 16-bit RGBA image
    const big = Buffer.concat([
      SIG,
      ihdr(10000, 9000, 16, 6, 1),
      chunk('IDAT', zlib.deflateSync(Buffer.alloc(10))),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    await refuses((pdf) => pdf.embedImage(big), /MB decoded/);
  });
  it('bad colour type and bit depth combinations', async () => {
    for (const [depth, type] of [
      [16, 3],
      [4, 2],
      [1, 6],
      [2, 4],
      [8, 5],
      [8, 7],
      [3, 0],
      [32, 0],
    ]) {
      const f = Buffer.concat([
        SIG,
        ihdr(4, 4, depth, type),
        chunk('IDAT', zlib.deflateSync(Buffer.alloc(100))),
        chunk('IEND', Buffer.alloc(0)),
      ]);
      await refuses((pdf) => pdf.embedImage(f), /colour type|bit depth/);
    }
  });
  it('lying chunk lengths, a bad CRC, missing chunks, a palette image without PLTE, a bad filter byte', async () => {
    const lying = Buffer.from(good);
    lying.writeUInt32BE(0x7ffffff0, 33); // the first IDAT's length
    await refuses((pdf) => pdf.embedImage(lying), /claims 2147483632 bytes/);
    const crc = Buffer.from(good);
    crc[30] ^= 1; // inside IHDR's CRC
    await refuses((pdf) => pdf.embedImage(crc), /bad CRC/);
    await refuses(
      (pdf) => pdf.embedImage(Buffer.concat([SIG, ihdr(4, 4, 8, 0), chunk('IEND', Buffer.alloc(0))])),
      /no image data/,
    );
    await refuses(
      (pdf) => pdf.embedImage(Buffer.concat([SIG, chunk('IEND', Buffer.alloc(0))])),
      /IHDR is not the first/,
    );
    await refuses(
      (pdf) =>
        pdf.embedImage(
          Buffer.concat([
            SIG,
            ihdr(4, 4, 8, 3),
            chunk('IDAT', zlib.deflateSync(Buffer.alloc(20))),
            chunk('IEND', Buffer.alloc(0)),
          ]),
        ),
      /without PLTE/,
    );
    const rows = Buffer.alloc(4 * 5 * 2);
    rows[0] = 9; // filter 9 does not exist
    await refuses(
      (pdf) =>
        pdf.embedImage(
          Buffer.concat([
            SIG,
            ihdr(4, 4, 8, 4),
            chunk('IDAT', zlib.deflateSync(rows.subarray(0, 4 * 9))),
            chunk('IEND', Buffer.alloc(0)),
          ]),
        ),
      /row filter 9/,
    );
    await refuses(
      (pdf) =>
        pdf.embedImage(
          Buffer.concat([
            SIG,
            ihdr(4, 4, 8, 0),
            chunk('IDAT', Buffer.from('not zlib data')),
            chunk('IEND', Buffer.alloc(0)),
          ]),
        ),
      /corrupt image data/,
    );
  });
});

describe('hostile JPEGs', () => {
  const seg = (m, data) =>
    Buffer.concat([Buffer.from([0xff, m, (data.length + 2) >> 8, (data.length + 2) & 255]), data]);
  const sof = (w, h, comps = 3, len) => {
    const d = Buffer.alloc(6 + 3 * comps);
    d[0] = 8;
    d.writeUInt16BE(h, 1);
    d.writeUInt16BE(w, 3);
    d[5] = comps;
    const s = seg(0xc0, d);
    if (len != null) s.writeUInt16BE(len, 2);
    return s;
  };
  const SOI = Buffer.from([0xff, 0xd8]),
    SOS = seg(0xda, Buffer.alloc(10));
  it('bogus marker lengths', async () => {
    const app = seg(0xe0, Buffer.alloc(14));
    app.writeUInt16BE(60000, 2);
    await refuses((pdf) => pdf.embedImage(Buffer.concat([SOI, app, sof(10, 10), SOS])), /claims 60000 bytes/);
    const zero = seg(0xe0, Buffer.alloc(4));
    zero.writeUInt16BE(1, 2);
    await refuses((pdf) => pdf.embedImage(Buffer.concat([SOI, zero, sof(10, 10), SOS])), /bogus length/);
    await refuses(
      (pdf) => pdf.embedImage(Buffer.concat([SOI, sof(10, 10, 3, 20), SOS])),
      /does not match its 3 components/,
    );
    await refuses((pdf) => pdf.embedImage(Buffer.concat([SOI, sof(10, 10)])), /truncated|no SOS/);
    await refuses((pdf) => pdf.embedImage(Buffer.concat([SOI, Buffer.from([0xff, 0xe0, 0x00])])), /truncated/);
    await refuses((pdf) => pdf.embedImage(Buffer.concat([SOI, SOS])), /before the frame header/);
  });
  it('a SOF claiming 65535 × 65535, a zero height, 2 or 5 components, 12-bit and arithmetic coding', async () => {
    await refuses((pdf) => pdf.embedImage(Buffer.concat([SOI, sof(65535, 65535), SOS])), /over 100 megapixels/);
    await refuses((pdf) => pdf.embedImage(Buffer.concat([SOI, sof(100, 0), SOS])), /DNL/);
    await refuses((pdf) => pdf.embedImage(Buffer.concat([SOI, sof(10, 10, 2), SOS])), /2 components/);
    const twelve = sof(10, 10);
    twelve[4] = 12;
    await refuses((pdf) => pdf.embedImage(Buffer.concat([SOI, twelve, SOS])), /12-bit/);
    const arith = sof(10, 10);
    arith[1] = 0xc9;
    await refuses((pdf) => pdf.embedImage(Buffer.concat([SOI, arith, SOS])), /arithmetic-coded/);
  });
  it('a hostile EXIF block (offsets past the segment, a huge entry count) is ignored, not followed', async () => {
    const tiff = Buffer.alloc(30);
    tiff.write('MM', 0);
    tiff.writeUInt16BE(42, 2);
    tiff.writeUInt32BE(8, 4);
    tiff.writeUInt16BE(65535, 8);
    const exif = seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]));
    const far = Buffer.from(tiff);
    far.writeUInt32BE(0xfffffff0, 4);
    for (const e of [exif, seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), far]))]) {
      // the file is not a real JPEG past SOS, so it only has to get as far as being written
      const out = await toBytes(async (pdf) => {
        const i = await pdf.embedImage(Buffer.concat([SOI, e, sof(10, 10), SOS, Buffer.from([0xff, 0xd9])]));
        expect([i.width, i.height]).toEqual([10, 10]);
      });
      expect(out.length).toBeGreaterThan(0);
    }
  });
});

describe('hostile ICC profiles', () => {
  const srgb = profile('sRGB Profile.icc');
  it.skipIf(!srgb)('a bad size field, a bad signature, an unknown colour space, tags outside the profile', async () => {
    const lie = Buffer.from(srgb);
    lie.writeUInt32BE(srgb.length + 1000, 0);
    await refuses((pdf) => pdf.iccColorSpace(lie), /its header says \d+ bytes/);
    const huge = Buffer.from(srgb);
    huge.writeUInt32BE(0xffffffff, 0);
    await refuses((pdf) => pdf.iccColorSpace(huge), /its header says 4294967295 bytes/);
    const sig = Buffer.from(srgb);
    sig.write('xxxx', 36);
    await refuses((pdf) => pdf.iccColorSpace(sig), /acsp/);
    const lab = Buffer.from(srgb);
    lab.write('Lab ', 16);
    await refuses((pdf) => pdf.iccColorSpace(lab), /colour space "Lab"/);
    const tags = Buffer.from(srgb);
    tags.writeUInt32BE(0x0fffffff, 128);
    await refuses((pdf) => pdf.iccColorSpace(tags), /tags do not fit/);
    const tag = Buffer.from(srgb);
    tag.writeUInt32BE(0xfffffff0, 132 + 4);
    await refuses((pdf) => pdf.iccColorSpace(tag), /outside the profile/);
    await refuses((pdf) => pdf.iccColorSpace(new Uint8Array(100)), /at least 132/);
    await expect(toBytes(() => {}, { pdfa: { outputIntent: lie } })).rejects.toThrow(
      /pdfa.outputIntent: not a usable ICC profile/,
    );
  });
});
