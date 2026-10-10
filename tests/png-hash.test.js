// PNG decode/refilter output is unchanged since the node:zlib + tight-loop speedup: hashes of the PDF made from PNGs of
// every colour type / depth / interlace, rows refiltered with all 5 filters. The hash is of the DECODED file (every
// Flate stream inflated, /Length and the xref stream left out), so it does not depend on the zlib build (deflate output
// differs between Node/zlib versions; the inflated bytes, the pixels and the dictionaries, do not).
import { it, expect } from 'vitest';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { toBytes } from '../src/index.js';
import { png, chunk, SIG } from './image-fixtures.js';
const CH = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
function refilter(b, w, h, type, depth) { // non-interlaced: row y gets filter y % 5
  const idat = []; let at = 8; const head = [];
  while (at < b.length) { const n = Buffer.from(b).readUInt32BE(at), t = Buffer.from(b.subarray(at + 4, at + 8)).toString('latin1'); if (t === 'IDAT') idat.push(b.subarray(at + 8, at + 8 + n)); else if (t !== 'IEND') head.push(Buffer.from(b.subarray(at, at + 12 + n))); at += 12 + n; }
  const raw = zlib.inflateSync(Buffer.concat(idat)), bits = CH[type] * depth, rb = Math.ceil(w * bits / 8), bpp = Math.max(1, bits >> 3);
  const out = Buffer.alloc(raw.length);
  for (let y = 0; y < h; y++) {
    const f = y % 5, o = y * (rb + 1); out[o] = f;
    for (let i = 0; i < rb; i++) {
      const x = raw[o + 1 + i], a = i >= bpp ? raw[o + 1 + i - bpp] : 0, u = y ? raw[o - rb + i] : 0, c = y && i >= bpp ? raw[o - rb + i - bpp] : 0;
      let p = 0; if (f === 1) p = a; else if (f === 2) p = u; else if (f === 3) p = (a + u) >> 1; else if (f === 4) { const pp = a + u - c, pa = Math.abs(pp - a), pb = Math.abs(pp - u), pc = Math.abs(pp - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? u : c; }
      out[o + 1 + i] = (x - p) & 255;
    }
  }
  return new Uint8Array(Buffer.concat([SIG, ...head, chunk('IDAT', zlib.deflateSync(out)), chunk('IEND', Buffer.alloc(0))]));
}
/** the file with every Flate stream inflated, /Length dropped and the XRef stream (byte offsets, /ID) skipped */
function decoded(out) {
  const s = Buffer.from(out).toString('latin1'), parts = [];
  for (const m of s.matchAll(/(\d+) 0 obj\n([\s\S]*?)\nendobj/g)) {
    const at = m[2].indexOf('\nstream\n'), dict = (at < 0 ? m[2] : m[2].slice(0, at)).replace(/\/Length \d+ ?/, '');
    if (/\/Type \/XRef\b/.test(dict)) continue;
    parts.push(Buffer.from(`${m[1]} ${dict}\n`, 'latin1'));
    if (at >= 0) {
      const len = +/\/Length (\d+)/.exec(m[2])[1], body = Buffer.from(m[2].slice(at + 8, at + 8 + len), 'latin1');
      parts.push(/\/Filter \/FlateDecode/.test(dict) ? zlib.inflateSync(body) : body);
    }
  }
  return Buffer.concat(parts);
}
const WANT = `0/1/0 e94990ce9c908fc7
0/1/1 b1a0a7ade52319b5
0/2/0 b7e49fc55201c85d
0/2/1 fb73778921a2ff0c
0/4/0 97dbf77fdb1ce0c1
0/4/1 bb24f97cd463c5c4
0/8/0 45c4b36ff7037b38
0/8/1 f6a02f1d4bb9978a
0/16/0 ade93d8329c3a044
0/16/1 ade93d8329c3a044
2/8/0 d32babdbe1e3c92d
2/8/1 ff1ec67f1fb73628
2/16/0 adc7f14e529614b2
2/16/1 4616ec35a59b83cb
3/1/0 bfd3bc5eae80287d
3/1/1 bfd3bc5eae80287d
3/2/0 bfee56c3d11ea790
3/2/1 bfee56c3d11ea790
3/4/0 3fd667533b3dd86f
3/4/1 3fd667533b3dd86f
3/8/0 45b757944342a3e8
3/8/1 45b757944342a3e8
4/8/0 ada09709be5120a3
4/8/1 ada09709be5120a3
4/16/0 2a47f0c985a30260
4/16/1 2a47f0c985a30260
6/8/0 29750d17356080fc
6/8/1 29750d17356080fc
6/16/0 b657e61171862d1d
6/16/1 b657e61171862d1d`;
it('PNG output bytes are unchanged (every type, depth, interlace, filters 0-4)', async () => {
const lines = [];
for (const [type, depths] of [[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]]) for (const depth of depths) for (const il of [0, 1]) {
  const w = 37, h = 23, M = (1 << depth) - 1;
  const px = (x, y) => Array.from({ length: CH[type] }, (_, k) => type === 3 ? (x * 7 + y * 3) % (M + 1) % 4 : ((x * 31 + y * 17 + k * 101) * 2654435761 >>> 7) % (M + 1));
  let b = png({ w, h, type, depth, interlace: il, px, palette: type === 3 ? [[255, 0, 0], [0, 255, 0], [0, 0, 255], [9, 9, 9]] : undefined, trns: type === 3 ? [255, 0, 128] : type === 0 && depth === 16 ? [0, 5] : undefined });
  if (!il) b = refilter(b, w, h, type, depth);
  const out = await toBytes(async (pdf) => { pdf.addPage({ width: 100, height: 100 }).image(await pdf.embedImage(b), { x: 0, y: 0, width: 80 }); }, { creationDate: new Date('2026-01-01') });
  expect(decoded(out).includes('/Subtype /Image')).toBe(true); // the image itself is in what is hashed
  lines.push(`${type}/${depth}/${il} ${crypto.createHash('sha256').update(decoded(out)).digest('hex').slice(0, 16)}`);
}
expect(lines.join('\n')).toBe(WANT);
});
