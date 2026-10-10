// filterRow is branch-free for speed: it must pick and write exactly what the plain PNG heuristic does (min sum of
// |signed bytes|, ties to None, Sub, Up, Paeth), byte for byte, on noisy and smooth rows at every bpp.
import { describe, it, expect } from 'vitest';
import { filterRow } from '../src/images/png.js';

const paeth = (a, b, c) => {
  const p = a + b - c,
    pa = Math.abs(p - a),
    pb = Math.abs(p - b),
    pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};
function ref(x, up, bpp) {
  const n = x.length,
    w = (v) => (v < 128 ? v : 256 - v);
  const f = [x.slice(), x.map((v, i) => (v - (i >= bpp ? x[i - bpp] : 0)) & 255)];
  if (up)
    f.push(
      x.map((v, i) => (v - up[i]) & 255),
      null,
      x.map((v, i) => (v - paeth(i >= bpp ? x[i - bpp] : 0, up[i], i >= bpp ? up[i - bpp] : 0)) & 255),
    );
  let best = -1,
    bs = Infinity;
  f.forEach((r, k) => {
    if (!r) return;
    const s = r.reduce((t, v) => t + w(v), 0);
    if (s < bs) {
      bs = s;
      best = k;
    }
  });
  const out = new Uint8Array(n + 1);
  out[0] = best;
  out.set(f[best], 1);
  return out;
}

describe('filterRow', () => {
  it('matches the plain heuristic on random, smooth and edge rows', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
    for (const bpp of [1, 2, 3, 4, 6, 8])
      for (let trial = 0; trial < 300; trial++) {
        const n = 1 + (trial % 37) * bpp,
          kind = trial % 3;
        const row = () =>
          Uint8Array.from({ length: n }, (_, i) =>
            kind === 0 ? rnd() : kind === 1 ? (i * 3 + (rnd() & 3)) & 255 : [0, 255, 128, 127][rnd() & 3],
          );
        const up = trial % 4 ? row() : null,
          x = row(),
          out = new Uint8Array(n + 3),
          t = new Uint8Array(n);
        filterRow(x, up, bpp, out, 2, t);
        expect(out.subarray(2, 3 + n)).toEqual(ref(x, up, bpp));
      }
  });
});

describe('embedImage compression', async () => {
  const { toBytes } = await import('../src/index.js');
  const { deflateSync } = await import('node:zlib');
  // an RGBA PNG (so it is re-compressed) of w × h
  const png = (w, h) => {
    const crc = (b) => {
      let c = ~0;
      for (const x of b) {
        c ^= x;
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
      }
      return ~c >>> 0;
    };
    const chunk = (t, d) => {
      const b = Buffer.alloc(12 + d.length);
      b.writeUInt32BE(d.length);
      b.write(t, 4, 'latin1');
      Buffer.from(d).copy(b, 8);
      b.writeUInt32BE(crc(b.subarray(4, 8 + d.length)), 8 + d.length);
      return b;
    };
    const ih = Buffer.alloc(13);
    ih.writeUInt32BE(w);
    ih.writeUInt32BE(h, 4);
    ih[8] = 8;
    ih[9] = 6;
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let i = 0; i < raw.length; i++) raw[i] = i % (w * 4 + 1) ? (i * 7) & 255 : 0;
    return new Uint8Array(
      Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ih),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
      ]),
    );
  };
  const make = (bytes, o) =>
    toBytes(
      async (pdf) => {
        const p = pdf.addPage();
        p.image(await pdf.embedImage(bytes, o), { width: 10 });
        await p.end();
      },
      { creationDate: new Date(0) },
    );
  it("'default' is level 6 under 2 MP (small images unchanged) and refuses a bad value", async () => {
    const b = png(64, 64);
    expect(Buffer.compare(await make(b), await make(b, { compression: 6 }))).toBe(0);
    expect(Buffer.compare(await make(b), await make(b, { compression: 1 }))).not.toBe(0);
    for (const c of [0, 10, 2.5, 'slow']) await expect(make(b, { compression: c })).rejects.toThrow(/compression is/);
  });
});
