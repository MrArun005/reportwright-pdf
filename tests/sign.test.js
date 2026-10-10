// Group F signatures: throwaway RSA and EC keys and self-signed certificates made with openssl, documents signed as
// they stream, then (1) the /ByteRange covers the whole file but /Contents, (2) `openssl cms -verify` passes on the
// extracted CMS over the ByteRange bytes, (3) poppler's pdfsig says "Signature is Valid", (4) one byte changed fails
// both, (5) pdf-lib parses the file. Also RSA-PSS and ECDSA P-256 / P-384 with SHA-256/384/512, /adbe.pkcs7.detached,
// an RFC 3161 timestamp from `openssl ts` (B-T), DocMDP, encrypted and signed, a signed PDF/A through veraPDF, and
// the rules (one signature, a signature field, a flattened form, the reserve).
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef } from 'pdf-lib';
import { createPdf, toBytes, nodeSigner, cmsSigner } from '../src/index.js';
import { read } from '../src/security/der.js';
import { HAS, DIR, run, save, latin, verapdf, INTER } from './tools.js';

const has = (c) => {
  try {
    execFileSync('which', [c], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const OPENSSL = has('openssl'),
  PDFSIG = has('pdfsig');
const PY = process.env.PIKEPDF_PY;
const DATE = new Date('2026-03-01T10:00:00Z');
const K = {};
const ossl = (...a) => execFileSync('openssl', a, { stdio: 'pipe', cwd: DIR });

beforeAll(() => {
  if (!OPENSSL) return;
  const make = (name, newkey, extra = []) => {
    ossl(
      'req',
      '-x509',
      '-newkey',
      newkey,
      ...extra,
      '-nodes',
      '-keyout',
      `${name}.key`,
      '-out',
      `${name}.crt`,
      '-days',
      '30',
      '-subj',
      `/CN=Test ${name}`,
    );
    K[name] = {
      key: fs.readFileSync(path.join(DIR, `${name}.key`)),
      certs: fs.readFileSync(path.join(DIR, `${name}.crt`), 'utf8'),
      crt: path.join(DIR, `${name}.crt`),
    };
  };
  make('rsa', 'rsa:2048');
  make('p256', 'ec', ['-pkeyopt', 'ec_paramgen_curve:P-256']);
  make('p384', 'ec', ['-pkeyopt', 'ec_paramgen_curve:P-384']);
  make('tsa', 'rsa:2048', ['-addext', 'extendedKeyUsage=critical,timeStamping']);
  fs.writeFileSync(
    path.join(DIR, 'tsa.cnf'),
    `[ tsa ]\ndefault_tsa = t\n[ t ]\nserial = ${path.join(DIR, 'tsa.serial')}\nsigner_cert = ${K.tsa.crt}\nsigner_key = ${path.join(DIR, 'tsa.key')}\nsigner_digest = sha256\ndefault_policy = 1.2.3.4.1\ndigests = sha256, sha384, sha512\ness_cert_id_alg = sha256\n`,
  );
  fs.writeFileSync(path.join(DIR, 'tsa.serial'), '01\n');
});

/** a 1-page invoice with a signature field, signed @param {any} so sign options @param {any} [o] createPdf options */
async function signed(so, o = {}) {
  return toBytes(
    async (pdf) => {
      const font = o.pdfa ? await pdf.embedFont(INTER) : pdf.standardFont('Helvetica');
      const p = pdf.addPage();
      p.text('Invoice 42: 1,250.00 EUR', { x: 40, y: 40, font, size: 14 });
      const f = pdf.form.signature('approval', { page: p, x: 40, y: 100, width: 200, height: 40, tooltip: 'Approval' });
      await pdf.sign(f, {
        reason: 'Approved',
        location: 'Paris',
        name: 'Test Signer',
        contactInfo: 'signer@example.com',
        ...so,
      });
    },
    { title: 'Invoice', creationDate: DATE, sign: true, ...o },
  );
}
/** the signature's parts: ByteRange, the CMS, the signed bytes @param {Uint8Array} b */
function parts(b) {
  const s = latin(b);
  const m = /\/ByteRange \[0 (\d+) (\d+) (\d+)\]\s*\/Contents </.exec(s);
  const [a, c, d] = [m[1], m[2], m[3]].map(Number);
  const hex = s.slice(a + 1, c - 1),
    raw = Buffer.from(hex, 'hex');
  return {
    a,
    c,
    d,
    hex,
    cms: raw.subarray(0, read(raw, 0).end),
    signedBytes: Buffer.concat([b.subarray(0, a), b.subarray(c, c + d)]),
  };
}
/** openssl cms -verify on the CMS over the signed bytes; true when it passes */
function opensslVerify(cms, signedBytes) {
  fs.writeFileSync(path.join(DIR, 'sig.der'), cms);
  fs.writeFileSync(path.join(DIR, 'signed.bin'), signedBytes);
  try {
    ossl(
      'cms',
      '-verify',
      '-inform',
      'DER',
      '-in',
      'sig.der',
      '-binary',
      '-content',
      'signed.bin',
      '-noverify',
      '-out',
      path.join(DIR, 'out.bin'),
    );
    return true;
  } catch {
    return false;
  }
}
const cmsPrint = (cms) => {
  fs.writeFileSync(path.join(DIR, 'p.der'), cms);
  return ossl('cms', '-cmsout', '-print', '-inform', 'DER', '-in', 'p.der').toString();
};
const pdfsig = (b, ...a) => run('pdfsig', [...a, save(b)]);
const T = OPENSSL ? it : it.skip;

describe('PAdES signatures', () => {
  T(
    'RSA SHA-256, ETSI.CAdES.detached: ByteRange covers all but /Contents, openssl and pdfsig verify, one changed byte fails both, pdf-lib parses it',
    async () => {
      const b = await signed({ signer: nodeSigner({ key: K.rsa.key, certs: K.rsa.certs }) });
      const { a, c, d, hex, cms, signedBytes } = parts(b);
      expect(b[a]).toBe(0x3c);
      expect(b[c - 1]).toBe(0x3e); // < … >
      expect(c + d).toBe(b.length); // to the last byte
      expect(hex).toMatch(/^[0-9a-f]+$/);
      expect(hex.length).toBe(2 * 16384); // the default reserve, zero-padded
      expect(opensslVerify(cms, signedBytes)).toBe(true);
      const p = cmsPrint(cms);
      expect(p).toContain('signingCertificateV2'); // ESS signing-certificate-v2 (PAdES)
      expect(p).toContain('messageDigest');
      expect(p).not.toContain('signingTime'); // PAdES: the time is /M
      if (PDFSIG) {
        const out = pdfsig(b);
        expect(out).toContain('Signature Validation: Signature is Valid.');
        expect(out).toContain('Total document signed');
        expect(out).toContain('Signature Type: ETSI.CAdES.detached');
        expect(out).toContain('Signer Certificate Common Name: Test rsa');
      }
      // one byte changed anywhere signed: the page text, the tail
      for (const at of [latin(b).indexOf('Invoice'), a - 5, b.length - 3]) {
        const x = Buffer.from(b);
        x[at] ^= 1;
        expect(opensslVerify(cms, Buffer.concat([x.subarray(0, a), x.subarray(c, c + d)]))).toBe(false); // the same ranges
        if (PDFSIG) expect(pdfsig(x)).not.toContain('Signature is Valid');
      }
      // pdf-lib: the field's /V is the /Sig dictionary, the AcroForm has /SigFlags 3
      const doc = await PDFDocument.load(b, { updateMetadata: false });
      const af = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
      expect(af.get(PDFName.of('SigFlags')).asNumber()).toBe(3);
      const field = af.lookup(PDFName.of('Fields'), PDFArray).lookup(0, PDFDict);
      const v = field.lookup(PDFName.of('V'), PDFDict);
      expect(v.get(PDFName.of('Type')).toString()).toBe('/Sig');
      expect(v.get(PDFName.of('SubFilter')).toString()).toBe('/ETSI.CAdES.detached');
      expect(
        doc
          .getForm()
          .getFields()
          .map((f) => f.getName()),
      ).toEqual(['approval']);
    },
  );

  T(
    'RSA-PSS SHA-384, ECDSA P-256 SHA-256 and P-384 SHA-512 (adbe.pkcs7.detached, with signing-time) all verify',
    async () => {
      const cases = [
        [nodeSigner({ key: K.rsa.key, certs: K.rsa.certs, pss: true }), 'SHA-384', 'ETSI.CAdES.detached', 'rsassaPss'],
        [nodeSigner({ key: K.p256.key, certs: K.p256.certs }), 'SHA-256', 'ETSI.CAdES.detached', 'ecdsa-with-SHA256'],
        [nodeSigner({ key: K.p384.key, certs: K.p384.certs }), 'SHA-512', 'adbe.pkcs7.detached', 'ecdsa-with-SHA512'],
      ];
      for (const [signer, hash, subFilter, alg] of cases) {
        const b = await signed({ signer, subFilter }, { sign: { hash } });
        const { cms, signedBytes } = parts(b);
        expect(opensslVerify(cms, signedBytes)).toBe(true);
        const p = cmsPrint(cms);
        expect(p).toContain(alg);
        expect(p.includes('signingTime')).toBe(subFilter === 'adbe.pkcs7.detached');
        if (PDFSIG) {
          const out = pdfsig(b);
          expect(out).toContain('Signature is Valid.');
          expect(out).toContain(`Signature Type: ${subFilter}`);
          expect(out).toContain(`Signing Hash Algorithm: ${hash}`);
        }
      }
    },
  );

  T(
    'B-T: an RFC 3161 timestamp from the caller (openssl ts) over the signature value is an unsigned attribute',
    async () => {
      let value;
      const timestamp = (sig) => {
        value = Buffer.from(sig);
        fs.writeFileSync(path.join(DIR, 'value.bin'), sig);
        ossl('ts', '-query', '-data', 'value.bin', '-sha256', '-cert', '-out', 'q.tsq');
        ossl('ts', '-reply', '-config', 'tsa.cnf', '-queryfile', 'q.tsq', '-token_out', '-out', 'token.der');
        return new Uint8Array(fs.readFileSync(path.join(DIR, 'token.der')));
      };
      const b = await signed({ signer: nodeSigner({ key: K.rsa.key, certs: K.rsa.certs }), timestamp });
      const { cms, signedBytes } = parts(b);
      expect(opensslVerify(cms, signedBytes)).toBe(true);
      expect(cmsPrint(cms)).toContain('id-smime-aa-timeStampToken');
      // the token's imprint is the hash of the signature value
      fs.writeFileSync(path.join(DIR, 'value.bin'), value);
      expect(
        ossl('ts', '-verify', '-data', 'value.bin', '-in', 'token.der', '-token_in', '-CAfile', K.tsa.crt).toString(),
      ).toContain('Verification: OK');
      if (PDFSIG) expect(pdfsig(b)).toContain('Signature is Valid.');
    },
  );

  T('DocMDP: certify adds the /Reference and the catalog /Perms; pdfsig still verifies', async () => {
    const b = await signed({ signer: nodeSigner({ key: K.rsa.key, certs: K.rsa.certs }), certify: 2 });
    const doc = await PDFDocument.load(b, { updateMetadata: false });
    const perms = doc.catalog.lookup(PDFName.of('Perms'), PDFDict);
    const sig = perms.lookup(PDFName.of('DocMDP'), PDFDict);
    const ref = sig.lookup(PDFName.of('Reference'), PDFArray).lookup(0, PDFDict);
    expect(ref.get(PDFName.of('TransformMethod')).toString()).toBe('/DocMDP');
    expect(ref.lookup(PDFName.of('TransformParams'), PDFDict).get(PDFName.of('P')).toString()).toBe('2');
    expect(perms.get(PDFName.of('DocMDP'))).toBeInstanceOf(PDFRef);
    const { cms, signedBytes } = parts(b);
    expect(opensslVerify(cms, signedBytes)).toBe(true);
    if (PDFSIG) expect(pdfsig(b)).toContain('Signature is Valid.');
  });

  T(
    'encrypted and signed (AES-256 and AES-128): /Contents is not encrypted, the other strings are; both verify',
    async () => {
      for (const algorithm of ['aes-256', 'aes-128']) {
        const b = await signed(
          { signer: nodeSigner({ key: K.p256.key, certs: K.p256.certs }) },
          { encrypt: { userPassword: 'u', ownerPassword: 'o', algorithm } },
        );
        const { cms, signedBytes } = parts(b);
        expect(opensslVerify(cms, signedBytes)).toBe(true); // the CMS read straight from the file
        expect(latin(b)).not.toContain(Buffer.from('﻿Paris', 'utf16le').swap16().toString('hex')); // /Location encrypted
        if (PDFSIG) {
          const out = pdfsig(b, '-upw', 'u');
          expect(out).toContain('Signature is Valid.');
          expect(out).toContain('Total document signed');
        }
        if (PY)
          expect(
            execFileSync(
              PY,
              [
                '-c',
                "import pikepdf,sys; p=pikepdf.open(sys.argv[1], password='u'); v=p.Root.AcroForm.Fields[0].V; print(str(v.Location), str(v.Reason), p.check_pdf_syntax())",
                save(b),
              ],
              { encoding: 'utf8' },
            ).trim(),
          ).toBe('Paris Approved []');
      }
    },
  );

  T(
    'a field signed after its page has ended (the widget waits for the end); a field made by pdf.sign; streamed in chunks',
    async () => {
      const chunks = [];
      const pdf = createPdf(
        {
          write: async (x) => {
            chunks.push(x);
            await new Promise((r) => setImmediate(r));
          },
        },
        { sign: true, creationDate: DATE },
      );
      const font = pdf.standardFont('Helvetica');
      let field;
      for (let i = 1; i <= 40; i++) {
        const p = pdf.addPage();
        for (let r = 0; r < 40; r++) p.text(`Page ${i} line ${r}`, { x: 40, y: 40 + r * 18, font, size: 11 });
        if (i === 1) field = pdf.form.signature('early', { page: p, x: 40, y: 760, width: 150, height: 30 });
        await p.end();
      }
      await pdf.sign(field, { signer: nodeSigner({ key: K.rsa.key, certs: K.rsa.certs }) });
      await pdf.end();
      const b = Buffer.concat(chunks);
      expect(chunks.length).toBeGreaterThan(1);
      const { cms, signedBytes } = parts(b);
      expect(opensslVerify(cms, signedBytes)).toBe(true);
      if (PDFSIG) expect(pdfsig(b)).toContain('Signature is Valid.');
    },
  );

  T('pdf.sign makes the field from { name, page, x, y, width, height }', async () => {
    const b = await toBytes(
      async (pdf) => {
        await pdf.sign(
          { name: 'made', page: pdf.addPage(), x: 40, y: 40, width: 150, height: 30, tooltip: 'Sign' },
          { signer: nodeSigner({ key: K.rsa.key, certs: K.rsa.certs }) },
        );
      },
      { sign: true },
    );
    const { cms, signedBytes } = parts(b);
    expect(opensslVerify(cms, signedBytes)).toBe(true);
    if (PDFSIG) expect(pdfsig(b)).toContain('Signature Field Name: made');
  });

  T('RSA PKCS#1 v1.5 is deterministic: the same input and date give the same signed bytes', async () => {
    const signer = nodeSigner({ key: K.rsa.key, certs: K.rsa.certs });
    expect(Buffer.from(await signed({ signer })).equals(Buffer.from(await signed({ signer })))).toBe(true);
  });

  T('cmsSigner wraps a raw signature function (an HSM or KMS stand-in)', async () => {
    const crypto = await import('node:crypto');
    const key = crypto.createPrivateKey(K.p256.key);
    let calls = 0;
    const signer = cmsSigner({
      certs: K.p256.certs,
      keyAlgorithm: 'ecdsa',
      sign: async (bytes, hash) => {
        calls++;
        expect(hash).toBe('SHA-256');
        return crypto.sign('sha256', bytes, key);
      },
    });
    const b = await signed({ signer });
    expect(calls).toBe(1);
    const { cms, signedBytes } = parts(b);
    expect(opensslVerify(cms, signedBytes)).toBe(true);
  });

  (OPENSSL && HAS.verapdf ? it : it.skip)(
    'a signed PDF/A-2b passes veraPDF (signatures are allowed in PDF/A)',
    async () => {
      const b = await signed({ signer: nodeSigner({ key: K.rsa.key, certs: K.rsa.certs }) }, { pdfa: true });
      const r = verapdf(b, '2b');
      expect(r.failed).toEqual([]);
      expect(r.ok).toBe(true);
      if (PDFSIG) expect(pdfsig(b)).toContain('Signature is Valid.');
    },
    60000,
  );

  T(
    'the rules: the sign option, one signature, a signature field, no flattened form, the reserve, the options',
    async () => {
      const signer = nodeSigner({ key: K.rsa.key, certs: K.rsa.certs });
      const field = (pdf) => pdf.form.signature('s', { page: pdf.addPage(), x: 0, y: 0, width: 10, height: 10 });
      await expect(toBytes(async (pdf) => pdf.sign(field(pdf), { signer }))).rejects.toThrow(
        /create the PDF with \{ sign: true \}/,
      );
      await expect(
        toBytes(
          async (pdf) => {
            const f = field(pdf);
            await pdf.sign(f, { signer });
            await pdf.sign(f, { signer });
          },
          { sign: true },
        ),
      ).rejects.toThrow(/one signature per document/);
      await expect(
        toBytes(
          async (pdf) =>
            pdf.sign(
              pdf.form.textField('t', {
                page: pdf.addPage(),
                x: 0,
                y: 0,
                width: 10,
                height: 10,
                font: pdf.standardFont('Helvetica'),
              }),
              { signer },
            ),
          { sign: true },
        ),
      ).rejects.toThrow(/is not a signature field/);
      await expect(
        toBytes(async (pdf) => pdf.sign(field(pdf), { signer }), { sign: true, form: { flatten: true } }),
      ).rejects.toThrow(/flattened form has no fields/);
      await expect(
        toBytes(async (pdf) => pdf.sign(field(pdf), { signer, reserve: 1024 }), { sign: true }),
      ).rejects.toThrow(/more than the 1024 reserved: pass a larger reserve/);
      await expect(
        toBytes(async (pdf) => pdf.sign(field(pdf), { signer, reserve: 10 }), { sign: true }),
      ).rejects.toThrow(/reserve/);
      await expect(
        toBytes(async (pdf) => pdf.sign(field(pdf), { signer, certify: 4 }), { sign: true }),
      ).rejects.toThrow(/certify is 1/);
      await expect(
        toBytes(async (pdf) => pdf.sign(field(pdf), { signer, subFilter: 'adbe.x509.rsa_sha1' }), { sign: true }),
      ).rejects.toThrow(/subFilter is/);
      await expect(
        toBytes(async (pdf) => pdf.sign(field(pdf), { signer, js: 'app.alert(1)' }), { sign: true }),
      ).rejects.toThrow(/unknown option "js"/);
      await expect(
        toBytes(async (pdf) => pdf.sign({ type: 'field', kind: 'signature', name: 's' }, { signer }), { sign: true }),
      ).rejects.toThrow(/Not a field made by this library/);
      expect(() => createPdf({ write() {} }, { sign: { hash: 'MD5' } })).toThrow(/sign is true or \{ hash/);
      expect(() => nodeSigner({ key: K.p256.key, certs: K.rsa.certs })).toThrow(/does not match the first certificate/);
      expect(() => nodeSigner({ key: 'not a key', certs: K.rsa.certs })).toThrow(/key is not a private key/);
      expect(() => nodeSigner({ key: K.rsa.key, certs: 'no pem here' })).toThrow(/no certificate/);
    },
  );
});
