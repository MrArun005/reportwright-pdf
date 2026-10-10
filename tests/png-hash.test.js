// PNG decode/refilter output is byte-identical to before the node:zlib + tight-loop speedup: hashes of the PDF made from PNGs of every colour type / depth / interlace, rows refiltered with all 5 filters
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
const WANT = `0/1/0 2250d870ccb030f3
0/1/1 5eb5d6de37677e02
0/2/0 413082cf45cde02b
0/2/1 64c38821dd96ce3c
0/4/0 3beb37bce4f9a7da
0/4/1 afd2df0eebdf963c
0/8/0 2d46d9529ad9786a
0/8/1 1aa984d94fc086a8
0/16/0 e0fba62b6ac0b729
0/16/1 e0fba62b6ac0b729
2/8/0 cda50e42f129578d
2/8/1 9f9e13b396cd2624
2/16/0 d328eb044710d3a0
2/16/1 ab255cf510a1301a
3/1/0 b2d749fdbaa4b7bf
3/1/1 b2d749fdbaa4b7bf
3/2/0 f7ebd844fc19cebc
3/2/1 f7ebd844fc19cebc
3/4/0 0ee0cff274f53350
3/4/1 0ee0cff274f53350
3/8/0 4a61472ecfd50d9d
3/8/1 4a61472ecfd50d9d
4/8/0 d23aa875ff731bdd
4/8/1 d23aa875ff731bdd
4/16/0 f5da5927b61a19b8
4/16/1 f5da5927b61a19b8
6/8/0 8d7ceea200ed9640
6/8/1 8d7ceea200ed9640
6/16/0 c8fa5a4d1b1063e5
6/16/1 c8fa5a4d1b1063e5`;
it('PNG output bytes are unchanged (every type, depth, interlace, filters 0-4)', async () => {
const lines = [];
for (const [type, depths] of [[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]]) for (const depth of depths) for (const il of [0, 1]) {
  const w = 37, h = 23, M = (1 << depth) - 1;
  const px = (x, y) => Array.from({ length: CH[type] }, (_, k) => type === 3 ? (x * 7 + y * 3) % (M + 1) % 4 : ((x * 31 + y * 17 + k * 101) * 2654435761 >>> 7) % (M + 1));
  let b = png({ w, h, type, depth, interlace: il, px, palette: type === 3 ? [[255, 0, 0], [0, 255, 0], [0, 0, 255], [9, 9, 9]] : undefined, trns: type === 3 ? [255, 0, 128] : type === 0 && depth === 16 ? [0, 5] : undefined });
  if (!il) b = refilter(b, w, h, type, depth);
  const out = await toBytes(async (pdf) => { pdf.addPage({ width: 100, height: 100 }).image(await pdf.embedImage(b), { x: 0, y: 0, width: 80 }); }, { creationDate: new Date('2026-01-01') });
  lines.push(`${type}/${depth}/${il} ${crypto.createHash('sha256').update(out).digest('hex').slice(0, 16)}`);
}
expect(lines.join('\n')).toBe(WANT);
});
