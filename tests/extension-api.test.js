// The engine-facing extension API (pdf.core and the exports a caller writing its own content needs): what index.d.ts
// declares exists, and each piece does what it says.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createPdf, toBytes, loadPdf } from '../src/index.js';
import { HAS, run, save, latin } from './tools.js';
import { png, sharp } from './image-fixtures.js';

const DATE = new Date('2026-01-02T03:04:05Z');

const DTS = fs.readFileSync(path.join(import.meta.dirname, '../index.d.ts'), 'utf8');
/** the members of an interface in index.d.ts: name → 'method' | 'property' */
function members(name) {
  const m = DTS.match(new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`));
  if (!m) throw new Error(`no interface ${name}`);
  const body = m[1].replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Map();
  for (const l of body.split('\n')) {
    const x = l.match(/^ {2}(?:readonly )?(?:get )?([A-Za-z]\w*)(?:<[^>]*>)?(\??)(\(|:)/);
    if (x) out.set(x[1], x[3] === '(' ? 'method' : 'property');
  }
  return out;
}

describe('A0: pdf.core is typed as it is', () => {
  it('every PdfCore member declared in index.d.ts exists on pdf.core, methods as functions', async () => {
    const pdf = createPdf({ write() {} });
    const decl = members('PdfCore');
    expect(decl.size).toBeGreaterThan(20);
    for (const [k, kind] of decl) {
      expect(k in pdf.core, k).toBe(true);
      if (kind === 'method') expect(typeof pdf.core[k], k).toBe('function');
    }
    expect(DTS).toMatch(/readonly core: PdfCore;/);
    await pdf.end();
  });
  it('the engine-facing members are declared', () => {
    const decl = members('PdfCore');
    for (const k of [
      'reserve',
      'write',
      'writeBig',
      'writeStream',
      'object',
      'resource',
      'resourcesRef',
      'catalog',
      'pageRef',
      'onFinish',
      'info',
      'xmp',
      'warn',
      'serial',
      'tags',
    ])
      expect(decl.has(k), k).toBe(true);
  });
});

const ppm = (bytes) => {
  const f = save(bytes);
  run('pdftoppm', ['-r', '72', '-singlefile', f, f]);
  return fs.readFileSync(`${f}.ppm`);
};
/** a 40 × 20 RGBA PNG: red left, blue right, the bottom rows half transparent */
const RGBA = png({
  w: 40,
  h: 20,
  type: 6,
  depth: 8,
  px: (x, y) => (x < 20 ? [220, 0, 0] : [0, 0, 220]).concat(y >= 15 ? 128 : 255),
});

describe('A1: an embedded image drawn from a caller-written content stream', () => {
  for (const [what, bytes] of [
    ['an RGBA PNG', async () => RGBA],
    [
      'an EXIF-rotated JPEG',
      async () =>
        sharp &&
        new Uint8Array(
          await sharp(Buffer.from(RGBA))
            .flatten({ background: '#fff' })
            .jpeg()
            .withMetadata({ orientation: 6 })
            .toBuffer(),
        ),
    ],
  ])
    it(`core.imageResource gives the name, ref, alpha and orientation: raw Do renders as page.image (${what})`, async () => {
      const src = await bytes();
      if (!src) return;
      const box = { x: 30, y: 40, width: 120, height: 90 };
      const byPage = await toBytes(
        async (pdf) => {
          const img = await pdf.embedImage(src);
          pdf.addPage({ width: 200, height: 200 }).image(img, box);
        },
        { creationDate: DATE },
      );
      let r;
      const raw = await toBytes(
        async (pdf) => {
          const img = await pdf.embedImage(src);
          r = pdf.core.imageResource(img);
          const p = pdf.addPage({ width: 200, height: 200 });
          if (r.alpha) p.entries.set('Group', '<< /Type /Group /S /Transparency /CS /DeviceRGB >>');
          p.content.op(
            `q ${box.width} 0 0 ${box.height} ${box.x} ${200 - box.y - box.height} cm ${r.orientation.join(' ')} cm /${r.name} Do Q`,
          );
        },
        { creationDate: DATE },
      );
      expect(r.name).toMatch(/^X\d+$/);
      expect(Number.isInteger(r.ref)).toBe(true);
      expect(r.alpha).toBe(what.includes('PNG'));
      if (what.includes('JPEG')) expect(r.orientation).not.toEqual([1, 0, 0, 1, 0, 0]);
      if (!HAS.poppler) return;
      const want = ppm(byPage);
      expect(want.some((b) => b < 100)).toBe(true); // something was drawn
      expect(ppm(raw).equals(want)).toBe(true);
      if (HAS.qpdf) expect(run('qpdf', ['--check', save(raw)])).toMatch(/No syntax or stream encoding errors/);
    });
  it('refuses anything but an image of this document', async () => {
    const pdf = createPdf({ write() {} });
    expect(() => pdf.core.imageResource({ type: 'image', width: 1, height: 1 })).toThrow(
      /Not an image \(pdf.embedImage\) made by this library/,
    );
    await pdf.end();
  });
});

describe('A2: encryption covers every string written through core, literal or hex', () => {
  const SECRETS = [
    'SecretTitle',
    'secret.example',
    'xx-SECRETLANG',
    'SecretActual',
    'SecretBig',
    'SecretLong',
    'SecretHexSpace',
  ];
  /** an encrypted file whose strings come in through core.write as literals (and one spaced hex string) */
  const build = (algorithm) =>
    toBytes(
      async (pdf) => {
        const { core } = pdf;
        core.info = '<< /Title (SecretTitle \\(one\\) \\101\\\n) /Producer (x) >>';
        core.catalog('Lang', '(xx-SECRETLANG)');
        const p = pdf.addPage({ width: 200, height: 200 });
        p.annotate(
          () =>
            '<< /Type /Annot /Subtype /Link /Rect [0 0 50 50] /Border [0 0 0] /A << /S /URI /URI (https://secret.example/a\\)b) >> >>',
        );
        // direct objects: a stream's dictionary, a long dictionary, a big object, nested arrays and dictionaries
        const r = [core.reserve(), core.reserve(), core.reserve()];
        r.forEach((n, i) => core.catalog(`RwTest${i}`, `${n} 0 R`)); // reachable: qpdf keeps them
        await core.write(
          r[0],
          '<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /ActualText (SecretActual) >>',
          new Uint8Array(0),
        );
        await core.write(r[1], `<< /K [(SecretLong) [<< /T (nested) >>]] /Pad <${'00'.repeat(2100)}> >>`);
        await core.writeBig(r[2], '[', ['(SecretBig)', ' <53 65 63 72 65 74 48 65 78 53 70 61 63 65>'], ']');
      },
      { creationDate: DATE, encrypt: { userPassword: 'pw', ownerPassword: 'owner', algorithm } },
    );
  for (const algorithm of ['aes-256', 'aes-128'])
    it(`${algorithm}: no plaintext in the file; qpdf decrypts each string to its text`, async () => {
      const out = await build(algorithm);
      const raw = latin(out);
      for (const s of SECRETS) expect(raw.includes(s), s).toBe(false);
      const doc = await loadPdf(out, { password: 'pw' });
      expect(doc.info.title).toBe('SecretTitle (one) A');
      expect(doc.page(0).annotations()[0].uri).toBe('https://secret.example/a)b');
      if (!HAS.qpdf) return;
      const f = save(out);
      expect(run('qpdf', ['--password=pw', '--show-encryption', f])).toMatch(
        algorithm === 'aes-256' ? /AESv3/ : /AESv2/,
      );
      expect(run('qpdf', ['--password=pw', '--check', f])).toMatch(/No syntax or stream encoding errors/);
      const plain = f + '.plain.pdf';
      run('qpdf', ['--password=pw', '--decrypt', '--qdf', '--object-streams=disable', f, plain]);
      const dec = fs.readFileSync(plain, 'latin1');
      for (const s of [
        'SecretTitle (one) A',
        'https://secret.example/a)b',
        'xx-SECRETLANG',
        'SecretActual',
        'SecretLong',
        'nested',
        'SecretBig',
        'SecretHexSpace',
      ])
        expect(dec.includes(s) || dec.includes(s.replace(/[()]/g, '\\$&')), s).toBe(true);
    });
  it('a malformed string or a comment in an encrypted object throws rather than leaving text in the clear', async () => {
    for (const bad of ['<< /T (unclosed >>', '<< /T <4g> >>', '<< /T 1 % (comment) \n >>'])
      await expect(
        toBytes(async (pdf) => pdf.core.write(pdf.core.reserve(), bad, new Uint8Array(0)), {
          encrypt: { userPassword: 'pw' },
        }),
      ).rejects.toThrow(/cannot be encrypted/);
  });
});
