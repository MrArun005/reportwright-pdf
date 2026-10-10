// Cases the 20,000-mutation fuzz run found (pdf-read-fuzz, seed 20261009), rebuilt as minimal edits of our own files:
// an AES-256 file whose /UE is empty (node:crypto threw "Unknown cipher" from inside loadPdf), AESV3 under a
// revision-4 key, and saves of a PDF/A file whose XMP declares a part we do not write or whose output intent profile
// is of the wrong class (both threw save-option TypeErrors aimed at a caller who passed no such option).
import { describe, it, expect } from 'vitest';
import { loadPdf, toBytes, PdfReadError } from '../src/index.js';

const D = new Date('2026-01-01');
const latin = (/** @type {Uint8Array} */ b) => Buffer.from(b).toString('latin1');
/** a same-length edit, so the xref offsets still hold @param {Uint8Array} b @param {RegExp} re @param {(m: string) => string} to */
const edit = (b, re, to) => {
  const s = latin(b),
    m = re.exec(s);
  expect(m, String(re)).toBeTruthy();
  const r = to(/** @type {any} */ (m)[0]);
  expect(r.length).toBe(/** @type {any} */ (m)[0].length);
  return new Uint8Array(
    Buffer.from(
      s.slice(0, /** @type {any} */ (m).index) + r + s.slice(/** @type {any} */ (m).index + r.length),
      'latin1',
    ),
  );
};
const code = async (/** @type {Promise<any>} */ p) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    expect(e).toBeInstanceOf(PdfReadError);
    return /** @type {any} */ (e).code;
  }
};

describe('encrypted files with crypt parameters AES cannot use fail as PdfReadError', () => {
  it('AES-256 with an empty /UE: E_MALFORMED, not node:crypto\'s "Unknown cipher"', async () => {
    const b = await toBytes(
      async (pdf) => {
        pdf.addPage({ width: 100, height: 100 }).text('x', { x: 10, y: 10, font: pdf.standardFont('Helvetica') });
      },
      { encrypt: { userPassword: '' }, creationDate: D, compress: false },
    );
    expect(await code(loadPdf(edit(b, /\/UE <[0-9a-fA-F]+>/, (m) => '/UE <>'.padEnd(m.length, ' '))))).toBe(
      'E_MALFORMED',
    );
  });
  it('AESV3 under a revision-4 (MD5, 5-byte) key: E_MALFORMED', async () => {
    const b = await toBytes(
      async (pdf) => {
        pdf.addPage({ width: 100, height: 100 }).text('x', { x: 10, y: 10, font: pdf.standardFont('Helvetica') });
      },
      { encrypt: { userPassword: '', ownerPassword: 'o', algorithm: 'aes-128' }, creationDate: D, compress: false },
    );
    let e = edit(b, /\/AESV2/, () => '/AESV3');
    e = edit(e, /\/Length 128/, () => '/Length 40 ');
    expect(await code(loadPdf(e))).toBe('E_MALFORMED');
  });
});

describe('saving a PDF/A file whose own claim is unusable drops or replaces it, never a save-option TypeError', () => {
  const pdfa = () =>
    toBytes(
      async (pdf) => {
        pdf.addPage({ width: 100, height: 100 });
      },
      { pdfa: { part: 2, conformance: 'b' }, compress: false, creationDate: D },
    );
  for (const part of ['0', '4']) {
    it(`XMP part ${part}: saved without the PDF/A claim`, async () => {
      const d = await loadPdf(edit(await pdfa(), /pdfaid:part>2</, () => `pdfaid:part>${part}<`));
      const out = await loadPdf((await d.save()).bytes);
      expect(out.pdfa).toBeNull();
    });
  }
  it('an output intent profile of class scnr: saved with the bundled sRGB profile instead', async () => {
    const d = await loadPdf(edit(await pdfa(), /mntr/, () => 'scnr'));
    const out = (await d.save()).bytes;
    expect(latin(out)).not.toContain('scnr');
    expect((await loadPdf(out)).pdfa).toMatchObject({ part: 2 });
  });
});
