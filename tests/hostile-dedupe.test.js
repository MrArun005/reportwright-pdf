// Group H security: objects are shared when equal (a font embedded by two merged files is written once), found by
// SHA-256 and then compared byte for byte, so a hash collision cannot swap one font or image for another. The test
// stubs the hash to collide on everything: different streams must still be written apart, equal ones once.
import { describe, it, expect } from 'vitest';
import { loadPdf } from '../src/index.js';
import { internal } from '../src/reader/pdf.js';
import { createCopier } from '../src/reader/copy.js';
import { Ref } from '../src/reader/lexer.js';
import { rawPdf, enc } from './reader-tools.js';

const withStream = (body) => rawPdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>', ['<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] >>', enc(body)]]);
function copier(hash) {
  const written = [];
  let n = 0;
  const c = createCopier({ reserve: () => ++n, write: async (k, dict, data) => { written.push([k, dict, data && Buffer.from(data).toString('latin1')]); }, keepActive: false, compress: false, dedupe: true, report() {}, page: () => undefined, keepStruct: () => false, hash });
  return { c, written };
}

describe('de-duplication compares bytes, not just a hash', () => {
  it('a colliding hash (stubbed) does not merge two different streams; equal streams are still shared', async () => {
    const a = internal(await loadPdf(withStream('0 0 1 1 re f')), 't'), b = internal(await loadPdf(withStream('1 0 0 rg 0 0 1 1 re f')), 't'), c = internal(await loadPdf(withStream('0 0 1 1 re f')), 't');
    const { c: cp, written } = copier(async () => new Uint8Array(32)); // every object "collides"
    const ta = await cp.text(a, new Ref(3, 0)), tb = await cp.text(b, new Ref(3, 0)), tc = await cp.text(c, new Ref(3, 0));
    expect(ta).not.toBe(tb); // different bytes: two objects despite the equal hash
    expect(tc).toBe(ta); // equal bytes: one object
    expect(written.map((w) => w[2])).toEqual(['0 0 1 1 re f', '1 0 0 rg 0 0 1 1 re f']);
  });
  it('the real hash is SHA-256 and shares equal objects across documents', async () => {
    const a = internal(await loadPdf(withStream('x')), 't'), b = internal(await loadPdf(withStream('x')), 't');
    const { c: cp, written } = copier();
    expect(await cp.text(a, new Ref(3, 0))).toBe(await cp.text(b, new Ref(3, 0)));
    expect(written.length).toBe(1);
  });
});
