// Group F encryption: the key derivations against vectors from qpdf (Algorithm 2.B for R6; Algorithms 2, 3, 5 for
// R4), WebCrypto and node:crypto agreeing, poppler opening AES-256 and AES-128 files with the user and the owner
// password (and refusing a wrong one), pdfinfo's permissions, the /P bit math, EncryptMetadata false, pdf-lib parsing
// the structure, streaming, and the PDF/A and PDF/UA rules. qpdf runs through pikepdf when PIKEPDF_PY names a Python
// that has it (pikepdf bundles libqpdf): it decrypts every string and stream and checks the syntax.
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import { createPdf, toBytes } from '../src/index.js';
import { r6, r4, hash2B, permBits, pad32, saslprep } from '../src/security/encrypt.js';
import { aesCbc, aesCbcWeb, sha, shaWeb, md5, unhex, hex } from '../src/security/crypto.js';
import { md5 as md5js } from '../src/core/md5.js';
import { HAS, run, save, latin, INTER } from './tools.js';

const DATE = new Date('2026-01-01');
const PY = process.env.PIKEPDF_PY;
const poppler = HAS.poppler ? it : it.skip;

/** a 2-page document with a title, an outline and a big (direct) dictionary of strings */
const build = (o = {}) =>
  toBytes(
    async (pdf) => {
      const font = pdf.standardFont('Helvetica');
      const pages = [1, 2].map((i) => pdf.addPage().text(`Secret page ${i}`, { x: 40, y: 40, font, size: 14 }));
      pdf.outline({ title: 'Chapter één', page: 2 });
      // > 4096 characters: written directly (not in an object stream), so its strings go through the dictionary hook
      pdf.form.comboBox('big', {
        page: pages[0],
        x: 40,
        y: 80,
        width: 200,
        height: 20,
        font,
        options: Array.from({ length: 200 }, (_, i) => `Option ${i}`),
        value: 'Option 7',
      });
    },
    { title: 'Encrypted', creationDate: DATE, ...o },
  );
const text = (bytes, ...a) => run('pdftotext', [...a, save(bytes), '-']);
const info = (bytes, ...a) => run('pdfinfo', [...a, save(bytes)]);

describe('key derivation: vectors from qpdf', () => {
  // made by qpdf 12.4.2 (pikepdf): R6, user "Ünïcödé user", owner "owner pass", P -3096
  const V6 = {
    key: '3312a7bf17126534785177de80bc942aa24df784e26d8fee0a8c3472bb579dc2',
    P: -3096,
    O: '3b31fb865717aed220c6482d30ae2eb8fab156152bd6a27230c87a70b6e60c4909fa4b2e4cb971d984d53293748619a1',
    U: 'cac539d058bb271bc66cfc2f221962f8b022015f4792d69d1bdfad3e4885eb9aae82a9caccc1edefe72ab367da590531',
    OE: '89baced0446a1ec24c51b76c4b38b636f32df6debb07141af680af58fd8a2669',
    UE: 'cef6833f700849edb7200f281d1fab5ac7113693ec802df427d907ffd3ff2643',
    Perms: '269e275ef5fc413de8a366eab3df4c8d',
  };
  it('Algorithm 2.B (R6): /U, /O, /UE, /OE and /Perms match qpdf byte for byte', async () => {
    const user = saslprep('Ünïcödé user', 't'),
      owner = saslprep('owner pass', 't'),
      U = unhex(V6.U),
      O = unhex(V6.O);
    expect(hex(await hash2B(user, U.subarray(32, 40), new Uint8Array(0)))).toBe(V6.U.slice(0, 64)); // the user validation hash
    expect(hex(await hash2B(owner, O.subarray(32, 40), U))).toBe(V6.O.slice(0, 64)); // the owner's, over /U
    // /Perms' 4 random bytes, read back with node:crypto (ECB = one block)
    const d = crypto.createDecipheriv('aes-256-ecb', unhex(V6.key), null).setAutoPadding(false).update(unhex(V6.Perms));
    expect([...d.subarray(4, 12)]).toEqual([255, 255, 255, 255, 0x54, 0x61, 0x64, 0x62]);
    const v = await r6(
      user,
      owner,
      unhex(V6.key),
      V6.P,
      true,
      Uint8Array.from([...U.subarray(32, 48), ...O.subarray(32, 48), ...d.subarray(12, 16)]),
    );
    expect([hex(v.U), hex(v.O), hex(v.UE), hex(v.OE), hex(v.Perms)]).toEqual([V6.U, V6.O, V6.UE, V6.OE, V6.Perms]);
  });
  it('Algorithms 2, 3 and 5 (R4): /O, the file key and /U match qpdf', () => {
    const id = unhex('25f809b4a84c75ca80addce6886a7e4f');
    const U = unhex('b862c51231c19590bd8cfeb6eb455d450021446990b9e4114071a4d9104984c1');
    const v = r4(pad32('user', 't'), pad32('owner', 't'), -1044, id, true, U.subarray(16));
    expect(hex(v.O)).toBe('0ba3835f88f90388e74e54584125ce142be0de24c6b0d37746e075b891756671');
    expect(hex(v.key)).toBe('0c4bdd4778e50abdd504335c3c4cf5b9');
    expect(hex(v.U)).toBe(hex(U)); // readers compare the first 16 bytes; the rest is ours, given here
  });
  it('/P: reserved bits set, a signed 32-bit integer, a bit per permission', () => {
    const all = {
      print: true,
      printHighQuality: true,
      modify: true,
      copy: true,
      annotate: true,
      fillForms: true,
      accessibility: true,
      assemble: true,
    };
    expect(permBits(all)).toBe(-4); // bits 1–2 clear, everything else set
    expect(permBits({})).toBe(0xfffff0c0 | 0); // only the reserved bits: 7, 8, 13–32
    expect(permBits({})).toBe(-3904);
    expect(permBits({ ...all, print: false, printHighQuality: false, copy: false })).toBe(-2072); // -4 less bits 3, 5, 12
    // qpdf's P for the same choices (pikepdf also turned assembly off): -3096
    expect(permBits({ ...all, print: false, printHighQuality: false, copy: false, assemble: false })).toBe(-3096);
  });
  it('WebCrypto and node:crypto give the same bytes (AES-CBC padded and not, SHA-2, MD5)', async () => {
    const key = crypto.randomBytes(32),
      iv = crypto.randomBytes(16);
    for (const n of [0, 1, 15, 16, 17, 64, 1000]) {
      const data = crypto.randomBytes(n);
      expect(hex(await aesCbcWeb(key, iv, data))).toBe(hex(await aesCbc(key, iv, data)));
      expect(hex(await aesCbcWeb(key.subarray(0, 16), iv, data))).toBe(
        hex(await aesCbc(key.subarray(0, 16), iv, data)),
      );
      if (n % 16 === 0)
        expect(hex(await aesCbcWeb(key, iv, data, false))).toBe(hex(await aesCbc(key, iv, data, false)));
      for (const h of ['SHA-256', 'SHA-384', 'SHA-512'])
        expect(hex(await shaWeb(h, data))).toBe(hex(await sha(h, data)));
      expect(md5js(data)).toBe(hex(md5(data)));
    }
    // AES-CBC is AES-CBC: node's decipher reads ours
    const ct = await aesCbcWeb(key, iv, Buffer.from('hello world'));
    const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
    expect(Buffer.concat([d.update(ct), d.final()]).toString()).toBe('hello world');
  });
});

describe('encrypted files', () => {
  poppler(
    'AES-256 and AES-128: poppler opens them with the user and the owner password, refuses a wrong one, and shows the permissions',
    async () => {
      for (const [algorithm, name] of [
        ['aes-256', 'AES-256'],
        ['aes-128', 'AES'],
      ]) {
        const b = await build({
          encrypt: {
            userPassword: 'user pw',
            ownerPassword: 'owner pw',
            algorithm,
            permissions: { print: false, copy: false },
          },
        });
        expect(text(b, '-upw', 'user pw')).toContain('Secret page 2');
        expect(text(b, '-opw', 'owner pw')).toContain('Secret page 1');
        expect(() => execFileSync('pdftotext', ['-upw', 'wrong', save(b), '-'], { stdio: 'pipe' })).toThrow(
          /Incorrect password/,
        );
        expect(() => execFileSync('pdftotext', [save(b), '-'], { stdio: 'pipe' })).toThrow(); // a user password is asked for
        const i = info(b, '-upw', 'user pw');
        expect(i).toContain(`Encrypted:       yes (print:no copy:no change:yes addNotes:yes algorithm:${name})`);
        expect(i).toMatch(/Title:\s+Encrypted/); // the Info dictionary, in an object stream, decrypted with it
        // nothing readable is left in the file: no page text, no title
        expect(latin(b)).not.toMatch(/Secret|Encrypted|Option 7/);
      }
    },
  );
  poppler('an empty user password opens without a prompt, the permissions still apply', async () => {
    const b = await build({ encrypt: { ownerPassword: 'o', permissions: { modify: false, annotate: false } } });
    expect(text(b)).toContain('Secret page 1');
    expect(info(b)).toContain('Encrypted:       yes (print:yes copy:yes change:no addNotes:no algorithm:AES-256)');
  });
  it('the Encrypt dictionary: V5/R6 AESV3 (and the 1.7 extension level 8) or V4/R4 AESV2; never in an object stream; the ID is random unless given', async () => {
    const a = latin(await build({ compress: false, encrypt: { ownerPassword: 'o' } }));
    expect(a).toMatch(
      /\d+ 0 obj\n<< \/Filter \/Standard \/V 5 \/R 6 \/Length 256 \/CF << \/StdCF << \/Type \/CryptFilter \/CFM \/AESV3 \/AuthEvent \/DocOpen \/Length 32 >> >> \/StmF \/StdCF \/StrF \/StdCF \/O <[0-9a-f]{96}> \/U <[0-9a-f]{96}> \/OE <[0-9a-f]{64}> \/UE <[0-9a-f]{64}> \/P -4 \/Perms <[0-9a-f]{32}> >>/,
    );
    const b = latin(await build({ compress: false, encrypt: { ownerPassword: 'o', algorithm: 'aes-128' } }));
    expect(b).toMatch(
      /<< \/Filter \/Standard \/V 4 \/R 4 \/Length 128 \/CF << \/StdCF << \/Type \/CryptFilter \/CFM \/AESV2 \/AuthEvent \/DocOpen \/Length 16 >> >> \/StmF \/StdCF \/StrF \/StdCF \/O <[0-9a-f]{64}> \/U <[0-9a-f]{64}> \/P -4 >>/,
    );
    const id = (s) => /\/ID \[<([0-9a-f]{32})>/.exec(s)[1];
    expect(id(a)).not.toBe(id(latin(await build({ compress: false, encrypt: { ownerPassword: 'o' } }))));
    expect(id(latin(await build({ compress: false, id: 'ab'.repeat(16), encrypt: { ownerPassword: 'o' } })))).toBe(
      'ab'.repeat(16),
    );
    // the xref stream is not encrypted: pdf-lib (which cannot decrypt) still parses the structure: every object of
    // the xref, the trailer's /Encrypt (the catalog itself sits in an encrypted object stream, so no further)
    for (const algorithm of ['aes-256', 'aes-128']) {
      const doc = await PDFDocument.load(await build({ encrypt: { ownerPassword: 'o', algorithm } }), {
        ignoreEncryption: true,
        updateMetadata: false,
      });
      expect(doc.isEncrypted).toBe(true);
      expect(doc.context.trailerInfo.Encrypt).toBeTruthy();
      expect(doc.context.enumerateIndirectObjects().length).toBeGreaterThan(5);
    }
  });
  poppler(
    'encryptMetadata false leaves the XMP readable (Identity crypt filter) while everything else is encrypted',
    async () => {
      for (const algorithm of ['aes-256', 'aes-128']) {
        const b = await build({ compress: false, encrypt: { ownerPassword: 'o', algorithm, encryptMetadata: false } });
        expect(latin(b)).toContain('<x:xmpmeta');
        expect(latin(b)).toContain('/EncryptMetadata false');
        expect(run('pdfinfo', ['-meta', save(b)])).toContain('<dc:title>');
        expect(text(b)).toContain('Secret page 1');
        expect(latin(await build({ compress: false, encrypt: { ownerPassword: 'o', algorithm } }))).not.toContain(
          'xmpmeta',
        );
      }
    },
  );
  poppler('streaming: a 60-page encrypted document written to a sink chunk by chunk', async () => {
    const chunks = [];
    const pdf = createPdf(
      {
        write: async (b) => {
          chunks.push(b);
          await new Promise((r) => setImmediate(r));
        },
      },
      { encrypt: { userPassword: 'u', ownerPassword: 'o' } },
    );
    const font = await pdf.embedFont(INTER);
    for (let i = 1; i <= 60; i++) {
      const p = pdf.addPage();
      for (let r = 0; r < 40; r++) p.text(`Page ${i} line ${r} — ünïcode`, { x: 40, y: 40 + r * 18, font, size: 11 });
      p.link(40, 20, 100, 10, { url: `https://example.com/${i}` });
      await p.end();
    }
    await pdf.end();
    expect(chunks.length).toBeGreaterThan(1);
    const b = Buffer.concat(chunks);
    expect(text(b, '-upw', 'u', '-f', '60', '-l', '60')).toContain('Page 60 line 39 — ünïcode');
  });
  it('PDF/A refuses encryption; PDF/UA keeps the accessibility permission on (with a warning)', async () => {
    await expect(toBytes(() => {}, { pdfa: true, encrypt: { ownerPassword: 'o' } })).rejects.toThrow(
      /PDF\/A forbids encryption/,
    );
    const chunks = [];
    const pdf = createPdf(
      {
        write: (b) => {
          chunks.push(b);
        },
      },
      {
        title: 'UA',
        tagged: { lang: 'en' },
        encrypt: { ownerPassword: 'o', permissions: { accessibility: false, copy: false } },
      },
    );
    const f = await pdf.embedFont(INTER);
    const p = pdf.addPage();
    p.tag('P', () => p.text('Readable', { x: 40, y: 40, font: f, size: 12 }));
    const { warnings } = await pdf.end();
    const b = Buffer.concat(chunks);
    expect(warnings.join(' ')).toMatch(/accessibility permission was turned back on/);
    if (HAS.poppler) expect(text(b)).toContain('Readable');
  });
  it('RC4 and unknown algorithms are refused with the reason; an empty owner password is refused', () => {
    for (const algorithm of ['rc4', 'rc4-40', 'rc4-128', 'RC4'])
      expect(() => createPdf({ write() {} }, { encrypt: { algorithm } })).toThrow(
        /RC4 \(40- and 128-bit\) is refused: it is broken/,
      );
    expect(() => createPdf({ write() {} }, { encrypt: { algorithm: 'aes-512' } })).toThrow(/algorithm is 'aes-256'/);
    expect(() => createPdf({ write() {} }, { encrypt: { ownerPassword: '' } })).toThrow(/empty ownerPassword/);
    expect(() => createPdf({ write() {} }, { encrypt: { permissions: { print: 'no' } } })).toThrow(
      /permissions.print is true or false/,
    );
    expect(() => createPdf({ write() {} }, { encrypt: { permissions: { delete: true } } })).toThrow(/unknown "delete"/);
    expect(() => createPdf({ write() {} }, { encrypt: { password: 'x' } })).toThrow(/unknown option "password"/);
  });
  it('an AES-128 password is Latin-1; AES-256 takes Unicode (SASLprep: NFKC, non-ASCII spaces → U+0020)', async () => {
    expect(() => createPdf({ write() {} }, { encrypt: { algorithm: 'aes-128', userPassword: 'пароль' } })).toThrow(
      /printable Latin-1 only/,
    );
    expect(hex(saslprep('A B­Cﬁ', 't'))).toBe(hex(Buffer.from('A BCfi'))); // NBSP → space, soft hyphen dropped, ﬁ → fi
    if (!HAS.poppler) return;
    const b = await build({ encrypt: { userPassword: 'пароль ﬁ', ownerPassword: 'o' } });
    expect(text(b, '-upw', 'пароль fi')).toContain('Secret page 1'); // poppler prepares the NFKC form the same way
  });
  (PY ? it : it.skip)(
    'qpdf (through pikepdf) decrypts every string and stream with each password and finds no syntax error',
    async () => {
      for (const algorithm of ['aes-256', 'aes-128']) {
        for (const encryptMetadata of [true, false]) {
          const f = save(
            await build({
              encrypt: {
                userPassword: 'u',
                ownerPassword: 'o',
                algorithm,
                encryptMetadata,
                permissions: { copy: false },
              },
            }),
          );
          const out = execFileSync(
            PY,
            [
              '-c',
              `
import pikepdf, sys
for pw, own in (('u', False), ('o', True)):
    p = pikepdf.open(sys.argv[1], password=pw)
    assert p.owner_password_matched == own, pw
    assert p.check_pdf_syntax() == [], p.check_pdf_syntax()
    assert str(p.docinfo.Title) == 'Encrypted'
    assert str(p.Root.Outlines.First.Title) == 'Chapter één'
    assert str(p.Root.AcroForm.Fields[0].Opt[199]) == 'Option 199'
    assert b'Secret page 2' in p.pages[1].Contents.read_bytes()
    assert b'xmpmeta' in p.Root.Metadata.read_bytes()
    assert not p.allow.extract
    assert ('/Extensions' in p.Root and int(p.Root.Extensions.ADBE.ExtensionLevel) == 8) == (sys.argv[2] == 'aes-256')
print('ok')`,
              f,
              algorithm,
            ],
            { encoding: 'utf8' },
          );
          expect(out.trim()).toBe('ok');
        }
      }
    },
  );
});
