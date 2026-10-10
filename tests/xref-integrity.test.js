// The xref stream and every other Flate stream inflate with a strict zlib, and every xref offset points at its object.
// fflate's streaming Zlib let the xref stream's first matches reach before the stream (qpdf: "invalid distance too far
// back"); which files hit it depends on the offsets, so on zlib's output, so on the Node version: this runs here and,
// when /usr/local/bin/node is another Node (22 on the dev machine), again under it.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { HAS, run, save } from './tools.js';
import { toBytes } from '../src/index.js';
import { build, check, VARIANTS, ICC } from './xref-integrity.mjs';

const OTHER = ['/usr/local/bin/node'].find((n) => {
  try { return fs.existsSync(n) && execFileSync(n, ['-v']).toString().trim() !== process.version; } catch { return false; }
});

describe('xref stream integrity', () => {
  it(`a large ICC profile, large images, many pages: every stream inflates, every offset is right (${process.version}, profile ${ICC?.length ?? 0} B)`, async () => {
    for (const [v, big] of VARIANTS) {
      const bytes = await build(v, big);
      expect(check(bytes), `variant ${v}${big ? ' (big)' : ''}`).toEqual([]);
      if (HAS.qpdf && (big || v % 8 === 1)) expect(run('qpdf', ['--check', save(bytes)])).toMatch(/No syntax or stream encoding errors/);
    }
  }, 120_000);

  it.skipIf(!OTHER)(`the same under ${OTHER ?? 'another Node (none at /usr/local/bin/node: skipped)'}`, () => {
    const r = JSON.parse(execFileSync(/** @type {string} */ (OTHER), [new URL('./xref-integrity.mjs', import.meta.url).pathname], { maxBuffer: 1 << 24 }).toString());
    expect(r.node).not.toBe(process.version);
    expect(r.out.length).toBe(VARIANTS.length);
    expect(r.out.filter((x) => x.bad.length)).toEqual([]);
  }, 120_000);

  it("a caller's bytes reused after the call resolves do not change what is written (they were queued by reference)", async () => {
    const icc = new Uint8Array(fs.readFileSync(new URL('../public/icc/sRGB-v2-magic.icc', import.meta.url)));
    const keep = icc.slice();
    const bytes = await toBytes(async (pdf) => {
      const cs = await pdf.iccColorSpace(icc);
      icc.fill(0x41); // the caller reuses its buffer
      pdf.addPage().rect(10, 10, 50, 50, { fill: cs.color(1, 0, 0) });
    }, { compress: false, creationDate: new Date(0) });
    expect(Buffer.from(bytes).indexOf(keep)).toBeGreaterThan(0);
    expect(check(bytes)).toEqual([]);
  });
});
