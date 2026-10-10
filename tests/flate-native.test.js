import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import * as F from 'fflate';
import { flate } from '../src/reader/filters.js';
import { fflate } from '../src/core/lazy.js';
import { createBudget } from '../src/reader/budget.js';

// FlateDecode through Node's zlib must decode what fflate alone decoded (whole, damaged, truncated, raw, capped)
function fflateOnly(data, budget) {
  const run = (Z) => {
    const parts = [];
    let n = 0,
      ok = true;
    const z = new Z((c) => {
      if (!c.length) return;
      budget.take(c.length, n);
      parts.push(c);
      n += c.length;
    });
    try {
      for (let at = 0; at < data.length; at += 16384)
        z.push(data.subarray(at, Math.min(data.length, at + 16384)), at + 16384 >= data.length);
      if (!data.length) z.push(new Uint8Array(0), true);
    } catch (e) {
      if (e?.name === 'PdfReadError') throw e;
      ok = false;
    }
    return { out: Buffer.concat(parts), ok, n };
  };
  const r = run(F.Unzlib);
  return r.ok || r.n ? r.out : run(F.Inflate).out;
}
const both = (d, o) => {
  const a = (() => {
    try {
      return Buffer.from(flate(d, createBudget(o))).toString('hex');
    } catch (e) {
      return `ERR ${e.code}`;
    }
  })();
  const b = (() => {
    try {
      return Buffer.from(fflateOnly(d, createBudget(o))).toString('hex');
    } catch (e) {
      return `ERR ${e.code}`;
    }
  })();
  return [a, b];
};
describe('flate', () => {
  it('decodes as fflate does', async () => {
    await fflate();
    let seed = 7;
    const rnd = (n) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const text = Buffer.from(Array.from({ length: 3000 }, (_, i) => `BT /F1 ${i % 13} Tf (${i}) Tj ET q Q\n`).join(''));
    const z = zlib.deflateSync(text),
      raw = zlib.deflateRawSync(text);
    const cases = [
      z,
      raw,
      Buffer.alloc(0),
      Buffer.concat([z, Buffer.from('trailing junk')]),
      zlib.deflateSync(Buffer.alloc(0)),
      Buffer.from([0x78, 0x9c]),
    ];
    const badSum = Buffer.from(z);
    badSum[badSum.length - 1] ^= 1;
    cases.push(badSum);
    const fdict = Buffer.from(z);
    fdict[1] = 0xbb;
    cases.push(fdict);
    for (let t = 0; t < 300; t++) {
      cases.push(z.subarray(0, rnd(z.length)));
      const c = Buffer.from(z);
      c[2 + rnd(c.length - 2)] ^= 1 << rnd(8);
      cases.push(c);
    }
    for (const d of cases) {
      const [a, b] = both(d);
      expect(a).toBe(b);
    }
    // the budget's caps: the same error, or the same bytes just under them
    for (const o of [{ maxStream: text.length - 1 }, { maxStream: text.length }, { maxDecoded: 1000 }]) {
      const [a, b] = both(z, o);
      expect(a).toBe(b);
    }
  });
});
