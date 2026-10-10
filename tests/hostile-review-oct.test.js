// Regressions for the two independent security reviews of October 2026 (inputs and crypto; output injection).
// Each describe is one finding; each test failed before its fix.
import { describe, it, expect } from 'vitest';
import { createPdf, toBytes } from '../src/index.js';
import { buildSfnt } from '../src/fonts/subset.js';
import { sfntTables } from '../src/fonts/truetype.js';
import { INTER } from './tools.js';
import zlib from 'node:zlib';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SIG, ihdr, chunk, png } from './image-fixtures.js';
import { EN16931 } from './standards-fixture.js';
import { readInvoice } from '../src/standards/facturx.js';

const sink = () => ({ write() {} });

describe('F2: a cmap format 4 with an odd segCountX2 is a broken font', () => {
  it('refuses it at embedFont with the typed error, not a RangeError at text time', async () => {
    const cmap = new Uint8Array(32), dv = new DataView(cmap.buffer);
    dv.setUint16(2, 1); dv.setUint16(4, 3); dv.setUint16(6, 1); dv.setUint32(8, 12);
    dv.setUint16(12, 4); dv.setUint16(14, 20); dv.setUint16(18, 1); // segCountX2 = 1
    dv.setUint16(26, 0xffff);
    const t = sfntTables(INTER);
    t.set('cmap', cmap);
    const pdf = createPdf(sink());
    await expect(pdf.embedFont(buildSfnt(t))).rejects.toThrow(/^Broken font: .*segCountX2/);
  });
});

describe('F3: the Factur-X guideline is read from ExchangedDocumentContext only, never from comments, CDATA or PIs', () => {
  const A3 = { pdfa: { part: 3, conformance: 'b' } };
  const EXT = 'urn:cen.eu:en16931:2017#conformant#urn:factur-x.eu:1p0:extended';
  const fake = `<ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>${EXT}</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter>`;
  const real = (id) => `<rsm:ExchangedDocumentContext><ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>${id}</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter></rsm:ExchangedDocumentContext>`;
  const inv = (body) => new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>\n<rsm:CrossIndustryInvoice xmlns:rsm="urn:x" xmlns:ram="urn:y">\n${body}\n</rsm:CrossIndustryInvoice>`);
  const hidden = {
    'a comment (the reviewer\'s PoC)': `<!-- ${fake} -->`,
    'a CDATA section': `<rsm:Note><![CDATA[${fake}]]></rsm:Note>`,
    'a processing instruction': `<?note ${fake}?>`,
    'an element outside ExchangedDocumentContext': `<rsm:Other>${fake}</rsm:Other>`,
  };
  for (const [where, decoy] of Object.entries(hidden)) {
    it(`a MINIMUM invoice with an EXTENDED guideline in ${where} is not accepted as EXTENDED`, async () => {
      const b = inv(`${decoy}\n${real('urn:factur-x.eu:1p0:minimum')}`);
      expect(readInvoice(b).guideline).toBe('urn:factur-x.eu:1p0:minimum');
      const pdf = createPdf(sink(), A3);
      await expect(pdf.facturX(b, { profile: 'EXTENDED' })).rejects.toThrow(/is not the EXTENDED profile/);
    });
  }
  it('two guideline IDs are refused (exactly one)', async () => {
    const b = inv(`<rsm:ExchangedDocumentContext><ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>${EXT}</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter><ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>urn:factur-x.eu:1p0:minimum</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter></rsm:ExchangedDocumentContext>`);
    expect(readInvoice(b).guideline).toBe(null);
    const pdf = createPdf(sink(), A3);
    await expect(pdf.facturX(b, { profile: 'EXTENDED' })).rejects.toThrow(/not the EXTENDED profile/);
  });
  it('the real fixture still reads', () => {
    expect(readInvoice(EN16931)).toEqual({ root: 'CrossIndustryInvoice', guideline: 'urn:cen.eu:en16931:2017' });
  });
});

describe('F7: bytes after a JPEG\'s EOI are not embedded', () => {
  const seg = (m, data) => Buffer.concat([Buffer.from([0xff, m, (data.length + 2) >> 8, (data.length + 2) & 255]), data]);
  const sof = Buffer.alloc(15); sof[0] = 8; sof.writeUInt16BE(10, 1); sof.writeUInt16BE(10, 3); sof[5] = 3;
  // two scans (progressive-like, a DHT between them), stuffed FF 00 and a restart marker in the entropy data
  const scans = Buffer.concat([seg(0xda, Buffer.alloc(10)), Buffer.from([1, 2, 0xff, 0x00, 3, 0xff, 0xd0, 4]), seg(0xc4, Buffer.from([0xff, 0xd9, 0, 0])), seg(0xda, Buffer.alloc(10)), Buffer.from([5, 0xff, 0xff, 0xd9])]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xc0, sof), scans]);
  it('cuts the stream at the EOI that ends the image data', async () => {
    const out = Buffer.from(await toBytes(async (pdf) => { await pdf.embedImage(Buffer.concat([jpeg, Buffer.from('APPENDED-SECRET \xff\xd9 more', 'latin1')])); pdf.addPage(); }, { compress: false })).toString('latin1');
    expect(out).not.toContain('APPENDED-SECRET');
    expect(out).toContain(`/Length ${jpeg.length}`);
    expect(out).toContain(jpeg.toString('latin1'));
  });
});

describe('F6: a passed-through PNG (no alpha, not interlaced) is checked row by row and cut at the end of its zlib stream', () => {
  const rgb = (rows, tail = Buffer.alloc(0), split = false) => {
    const z = Buffer.concat([zlib.deflateSync(rows), tail]);
    const idat = split ? [chunk('IDAT', z.subarray(0, 7)), chunk('IDAT', z.subarray(7))] : [chunk('IDAT', z)];
    return Buffer.concat([SIG, ihdr(4, 4, 8, 2), ...idat, chunk('IEND', Buffer.alloc(0))]);
  };
  const rows = () => { const r = Buffer.alloc(4 * 13); for (let y = 0; y < 4; y++) for (let i = 1; i < 13; i++) r[y * 13 + i] = y * 40 + i; return r; };
  it('a row filter byte over 4 is refused', async () => {
    const r = rows(); r[2 * 13] = 7;
    await expect(toBytes(async (pdf) => { await pdf.embedImage(rgb(r)); })).rejects.toThrow(/PNG: unknown row filter 7/);
  });
  it('data after the zlib stream is dropped, in one IDAT or split over two', async () => {
    for (const split of [false, true]) {
      const tail = Buffer.from('TRAILING-SECRET', 'latin1');
      const out = Buffer.from(await toBytes(async (pdf) => { await pdf.embedImage(rgb(rows(), tail, split)); pdf.addPage(); }, { compress: false })).toString('latin1');
      expect(out).not.toContain('TRAILING-SECRET');
      const z = zlib.deflateSync(rows());
      expect(out).toContain(z.toString('latin1'));
      expect(out).toContain(`/Length ${z.length}`);
    }
  });
});

describe('F1: decoding a PNG with alpha holds about one decoded copy, and a smaller default cap', () => {
  /** embed a w × h all-zero RGBA PNG in a child process @returns {{ file: number, decoded: number, growthMB: number, ms: number, error: string | null }} */
  const child = (w, h, interlace = 0, max = '') => JSON.parse(execFileSync(process.execPath, ['--expose-gc', '--max-old-space-size=1024', path.join(import.meta.dirname, 'png-memory-child.mjs'), String(w), String(h), String(interlace), String(max)], { encoding: 'utf8', timeout: 60000 }));
  it('a 4000 × 4000 RGBA PNG (64 MB decoded, ~60 KB of file): peak RSS growth under 1.5 × the decoded size, in bounded time', () => {
    const r = child(4000, 4000);
    expect(r.error).toBe(null);
    expect(r.file).toBeLessThan(200_000);
    expect(r.growthMB * 2 ** 20).toBeLessThan(1.5 * r.decoded);
    expect(r.ms).toBeLessThan(20000);
  }, 70000);
  it('interlaced: one de-interlaced image (6000 × 6000, 144 MB, maxDecodedBytes raised), under 1.5 × too', () => {
    const r = child(6000, 6000, 1, 160 << 20);
    expect(r.error).toBe(null);
    expect(r.growthMB * 2 ** 20).toBeLessThan(1.5 * r.decoded);
    expect(r.ms).toBeLessThan(20000);
  }, 70000);
  it('rows streamed over several strips decode to the same pixels (RGBA 16-bit, gray + alpha, interlaced)', async () => {
    /** the image XObjects' streams, inflated and unpredicted: [width, colours × bpc / 8, rows] */
    const images = (pdf) => {
      const s = Buffer.from(pdf).toString('latin1'), out = [];
      for (const m of s.matchAll(/<< \/Type \/XObject \/Subtype \/Image \/Width (\d+) \/Height (\d+) \/ColorSpace \/Device(Gray|RGB) \/BitsPerComponent (\d+)[^]*?\/Length (\d+) >>\nstream\n/g)) {
        const [w, h, cs, bpc, len] = [Number(m[1]), Number(m[2]), m[3], Number(m[4]), Number(m[5])];
        const bpp = ((cs === 'RGB' ? 3 : 1) * bpc) / 8, rb = w * bpp, raw = zlib.inflateSync(Buffer.from(s.slice(m.index + m[0].length, m.index + m[0].length + len), 'latin1'));
        const px = Buffer.alloc(rb * h);
        if (!/Predictor/.test(m[0])) raw.copy(px); else for (let y = 0; y < h; y++) {
          const f = raw[y * (rb + 1)];
          for (let i = 0; i < rb; i++) {
            const a = i >= bpp ? px[y * rb + i - bpp] : 0, u = y ? px[(y - 1) * rb + i] : 0, c = y && i >= bpp ? px[(y - 1) * rb + i - bpp] : 0;
            const pp = a + u - c, pa = Math.abs(pp - a), pb = Math.abs(pp - u), pc = Math.abs(pp - c);
            const pr = [0, a, u, (a + u) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? u : c][f];
            px[y * rb + i] = (raw[y * (rb + 1) + 1 + i] + pr) & 255;
          }
        }
        out.push({ cs, bpc, px });
      }
      return out;
    };
    const v = (x, y, k) => (x * 7 + y * 13 + k * 101 + ((x * y) % 17)) & 255;
    for (const [type, depth, interlace, w, h] of [[6, 16, 0, 400, 900], [4, 8, 1, 1500, 800], [6, 8, 0, 3000, 300]]) {
      const ch = type === 6 ? 4 : 2, max = depth === 16 ? 65535 : 255;
      const file = png({ w, h, type, depth, interlace, px: (x, y) => Array.from({ length: ch }, (_, k) => (depth === 16 ? v(x, y, k) * 257 + (x & 255) : v(x, y, k)) & max) });
      const [alpha, color] = images(await toBytes(async (pdf) => { await pdf.embedImage(file); }));
      const sb = depth / 8;
      for (const [x, y] of [[0, 0], [w - 1, h - 1], [w >> 1, h >> 1], [17, h - 3], [w - 5, 200]]) {
        for (let k = 0; k < ch - 1; k++) for (let b = 0; b < sb; b++) {
          const want = depth === 16 ? (b ? (v(x, y, k) * 257 + (x & 255)) & 255 : ((v(x, y, k) * 257 + (x & 255)) & 65535) >> 8) : v(x, y, k);
          expect(alpha.px[(y * w + x) * sb + b]).toBe(depth === 16 ? (b ? (v(x, y, ch - 1) * 257 + (x & 255)) & 255 : ((v(x, y, ch - 1) * 257 + (x & 255)) & 65535) >> 8) : v(x, y, ch - 1));
          expect(color.px[(y * w + x) * (ch - 1) * sb + k * sb + b]).toBe(want);
        }
      }
    }
  }, 60000);
  it('the default cap is 64 MB decoded; maxDecodedBytes raises or lowers it', () => {
    expect(child(4200, 4200).error).toMatch(/PNG: 4200 × 4200 needs 71 MB decoded; at most 67 MB .*maxDecodedBytes/);
    expect(child(1000, 1000, 0, 1e6).error).toMatch(/at most 1 MB/);
    expect(child(4200, 4200, 0, 80 << 20).error).toBe(null);
  }, 70000);
});
