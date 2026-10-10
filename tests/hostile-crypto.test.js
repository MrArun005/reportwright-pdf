// Group F against hostile input: huge passwords, control characters, the 127-byte cut, signers (and timestamp
// callbacks) that return too much, garbage or the wrong type, that throw or never resolve (timeoutMs and the signal
// stop them), hostile certificates, and IVs: never reused across strings and streams. Passwords and keys never appear
// in an error message.
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { createPdf, toBytes, nodeSigner, cmsSigner } from '../src/index.js';
import { encryptor } from '../src/security/encrypt.js';
import { readCerts } from '../src/security/cms.js';
import { execFileSync } from 'node:child_process';
import { HAS, run, save, latin } from './tools.js';

const PY = process.env.PIKEPDF_PY;

const KEY = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
/** a minimal signer whose output we control @param {(r: any) => any} fn */
const fake = (fn) => fn;
/** a 1-page PDF signed by `signer` @param {any} signer @param {any} [o] */
const sign = (signer, o = {}, so = {}) =>
  toBytes(
    async (pdf) => {
      const f = pdf.form.signature('s', { page: pdf.addPage(), x: 40, y: 40, width: 100, height: 30 });
      await pdf.sign(f, { signer, ...so });
    },
    { sign: true, ...o },
  );
const errOf = async (p) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('did not throw');
};
const errSync = (fn) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('did not throw');
};

describe('hostile passwords', () => {
  it('a 10 MB password is refused at once, and the error does not quote it', () => {
    const pw = 'S3cr3t!'.repeat(1_500_000);
    for (const algorithm of ['aes-256', 'aes-128'])
      for (const key of ['userPassword', 'ownerPassword']) {
        const t = performance.now();
        const e = errSync(() => createPdf({ write() {} }, { encrypt: { [key]: pw, algorithm } }));
        expect(performance.now() - t).toBeLessThan(500); // no work on it (generous: the suite runs two workers)
        expect(e).toBeInstanceOf(RangeError);
        expect(e.message).toMatch(/at most 1024 characters/);
        expect(e.message).not.toContain('S3cr3t');
      }
  });
  it('control, bidi, private-use and unassigned characters are refused (SASLprep), without quoting the password', () => {
    for (const pw of [0, 7, 10, 9, 0x202e, 0xe000, 0x378, 0x7f, 0x85].map((c) => `abc${String.fromCodePoint(c)}def`)) {
      const e = errSync(() => createPdf({ write() {} }, { encrypt: { userPassword: pw, ownerPassword: 'owner-ok' } }));
      expect(e.message).toMatch(/SASLprep/);
      expect(e.message).not.toContain(pw);
      const e4 = errSync(() =>
        createPdf({ write() {} }, { encrypt: { userPassword: pw, ownerPassword: 'owner-ok', algorithm: 'aes-128' } }),
      );
      expect(e4.message).toMatch(/printable Latin-1/);
      expect(e4.message).not.toContain(pw);
    }
  });
  // poppler's command-line tools keep 32 characters of -upw, so the 127-byte cut is checked with qpdf (pikepdf)
  (HAS.poppler ? it : it.skip)(
    'a long password is cut at 127 UTF-8 bytes (AES-256, checked by qpdf) or 32 characters (AES-128, by poppler)',
    async () => {
      const doc = (o) =>
        toBytes(
          (pdf) => {
            pdf.addPage().text('Opened', { x: 40, y: 40, font: pdf.standardFont('Helvetica'), size: 12 });
          },
          { encrypt: o },
        );
      const long = 'p'.repeat(200);
      const b4 = await doc({ userPassword: long, ownerPassword: 'o', algorithm: 'aes-128' });
      expect(run('pdftotext', ['-upw', long.slice(0, 32), save(b4), '-'])).toContain('Opened');
      expect(() => execFileSync('pdftotext', ['-upw', long.slice(0, 31), save(b4), '-'], { stdio: 'pipe' })).toThrow(
        /Incorrect password/,
      );
      if (!PY) return;
      // 127 bytes, cut inside a 2-byte character: 'é' × 100 is 200 bytes
      for (const pw of [long, 'é'.repeat(100)]) {
        const f = save(await doc({ userPassword: pw, ownerPassword: 'o' }));
        const cut = Buffer.from(pw).subarray(0, 127),
          short = Buffer.from(pw).subarray(0, 126);
        const out = execFileSync(
          PY,
          [
            '-c',
            `
import pikepdf, sys
r = []
for pw in (bytes.fromhex(sys.argv[2]), bytes.fromhex(sys.argv[3]), bytes.fromhex(sys.argv[4])):
    try: pikepdf.open(sys.argv[1], password=pw); r.append('ok')
    except pikepdf.PasswordError: r.append('no')
print(' '.join(r))`,
            f,
            Buffer.from(pw).toString('hex'),
            cut.toString('hex'),
            short.toString('hex'),
          ],
          { encoding: 'utf8' },
        );
        expect(out.trim()).toBe('ok ok no');
      }
    },
  );
});

describe('hostile signers', () => {
  it('too much data, garbage, the wrong type, a throw: each fails pdf.end with a clear error', async () => {
    const big = new Uint8Array(20_000);
    big[0] = 0x30;
    expect((await errOf(sign(fake(() => big)))).message).toMatch(
      /20000 bytes, more than the 16384 reserved: pass a larger reserve/,
    );
    expect((await errOf(sign(fake(() => new Uint8Array(3_000_000))))).message).toMatch(/pass a larger reserve/);
    expect((await errOf(sign(fake(() => crypto.randomBytes(500))))).message).toMatch(
      /not a DER CMS ContentInfo of SignedData/,
    );
    expect((await errOf(sign(fake(() => Uint8Array.of(0x30, 0x84, 0xff, 0xff, 0xff, 0xff))))).message).toMatch(
      /not a DER CMS/,
    );
    expect((await errOf(sign(fake(() => Uint8Array.of(0x30, 0x80, 0, 0))))).message).toMatch(/not a DER CMS/); // indefinite length
    expect(await errOf(sign(fake(() => 'MIIB...')))).toBeInstanceOf(TypeError);
    expect(await errOf(sign(fake(() => null)))).toBeInstanceOf(TypeError);
    const mine = new Error('HSM offline');
    expect(
      await errOf(
        sign(
          fake(async () => {
            throw mine;
          }),
        ),
      ),
    ).toBe(mine);
    expect(
      await errOf(
        sign(
          fake(() => {
            throw mine;
          }),
        ),
      ),
    ).toBe(mine);
  });
  it('a signer that never resolves is stopped by timeoutMs and by the signal; it gets the signal', async () => {
    let seen;
    const never = fake((r) => {
      seen = r.signal;
      return new Promise(() => {});
    });
    const t = performance.now();
    const e = await errOf(sign(never, { timeoutMs: 300 }));
    expect(e.name).toBe('TimeoutError');
    expect(performance.now() - t).toBeLessThan(3000);
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen.aborted).toBe(true);
    const ctl = new AbortController();
    const p = sign(
      fake(() => {
        setTimeout(() => ctl.abort(new Error('stop')), 10);
        return new Promise(() => {});
      }),
      { signal: ctl.signal },
    );
    expect((await errOf(p)).message).toBe('stop');
  });
  it('a raw signer (cmsSigner) or a timestamp callback returning too much, garbage or throwing is refused', async () => {
    const pem = crypto.createPublicKey(KEY); // not a certificate
    expect(() =>
      cmsSigner({
        certs: pem.export({ type: 'spki', format: 'pem' }),
        keyAlgorithm: 'ecdsa',
        sign: () => new Uint8Array(1),
      }),
    ).toThrow(/no certificate/);
    // a certificate with a hostile length
    expect(() => readCerts(Uint8Array.of(0x30, 0x84, 0x7f, 0xff, 0xff, 0xff, 1, 2), 't')).toThrow(
      /not a DER X.509 certificate/,
    );
    expect(() => readCerts(Uint8Array.of(0x30, 0x03, 0x30, 0x01), 't')).toThrow(/not a DER X.509 certificate/);
    const certs = '-----BEGIN CERTIFICATE-----\nMAA=\n-----END CERTIFICATE-----\n'.repeat(11);
    expect(() => readCerts(certs, 't')).toThrow(/at most 10 certificates/);
    // a real self-signed certificate for the rest (node has no certificate builder: openssl when present)
    if (!HAS.poppler) return;
    const dir = (await import('./tools.js')).DIR;
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:P-256',
        '-nodes',
        '-keyout',
        `${dir}/h.key`,
        '-out',
        `${dir}/h.crt`,
        '-days',
        '1',
        '-subj',
        '/CN=h',
      ],
      { stdio: 'pipe' },
    );
    const fs = await import('node:fs');
    const ok = { key: fs.readFileSync(`${dir}/h.key`), certs: fs.readFileSync(`${dir}/h.crt`, 'utf8') };
    const raw = (sig) => cmsSigner({ certs: ok.certs, keyAlgorithm: 'ecdsa', sign: sig });
    expect((await errOf(sign(raw(() => new Uint8Array(100_000))))).message).toMatch(/a signature is 1–16384 bytes/);
    expect((await errOf(sign(raw(() => new Uint8Array(0))))).message).toMatch(/a signature is 1–16384 bytes/);
    expect(await errOf(sign(raw(() => 'sig')))).toBeInstanceOf(TypeError);
    const n = nodeSigner(ok);
    expect((await errOf(sign(n, {}, { timestamp: () => new Uint8Array(100_000) }))).message).toMatch(
      /TimeStampToken is 100000 bytes, more than 65536/,
    );
    expect((await errOf(sign(n, {}, { timestamp: () => crypto.randomBytes(64) }))).message).toMatch(
      /TimeStampToken is not a DER CMS/,
    );
    expect(
      (
        await errOf(
          sign(
            n,
            {},
            {
              timestamp: () => {
                throw new Error('TSA down');
              },
            },
          ),
        )
      ).message,
    ).toBe('TSA down');
    expect((await errOf(sign(n, { timeoutMs: 300 }, { timestamp: () => new Promise(() => {}) }))).name).toBe(
      'TimeoutError',
    );
    // a custom signer that ignores the timestamp callback would downgrade B-T to B-B silently: refused
    expect(
      (await errOf(sign((r) => n({ ...r, timestamp: undefined }), {}, { timestamp: () => new Uint8Array(0) }))).message,
    ).toMatch(/has no id-aa-timeStampToken/);
    // key material never in an error: a wrong key for the certificate, a broken key
    const e1 = errSync(() => nodeSigner({ key: KEY, certs: ok.certs }));
    const e2 = errSync(() => nodeSigner({ key: ok.key.toString().replace('MI', 'XX'), certs: ok.certs }));
    for (const e of [e1, e2]) {
      expect(e.message).not.toMatch(/PRIVATE KEY|MI[A-Za-z0-9+/]{20}/);
      expect(e.cause).toBeUndefined();
    }
  });
});

describe('IVs', () => {
  it('a fresh random IV for every string and stream, even for equal plaintexts (AES-256 and AES-128)', async () => {
    for (const algorithm of ['aes-256', 'aes-128']) {
      const e = encryptor({ ownerPassword: 'o', algorithm }, { tagged: false, pdfa: false, warn() {} });
      e.ref = 99;
      const d = await e.dict(5, `<< ${Array.from({ length: 50 }, (_, i) => `/K${i} <00>`).join(' ')} >>`);
      const ivs = [...d.matchAll(/<([0-9a-f]{32})[0-9a-f]*>/g)].map((m) => m[1]);
      expect(ivs.length).toBe(50);
      const streams = await Promise.all(Array.from({ length: 50 }, () => e.stream(5, new Uint8Array(64), '<< >>')));
      for (const s of streams) ivs.push(Buffer.from(s.subarray(0, 16)).toString('hex'));
      expect(new Set(ivs).size).toBe(100);
      expect(await e.dict(99, '<< /O <00> >>')).toBe('<< /O <00> >>'); // the Encrypt dictionary itself is left alone
    }
  });
  it('in a whole file: every stream and every directly written string starts with its own IV', async () => {
    const b = await toBytes(
      async (pdf) => {
        const font = pdf.standardFont('Helvetica');
        const pages = Array.from({ length: 5 }, () =>
          pdf.addPage().text('Same text on every page', { x: 40, y: 40, font, size: 12 }),
        );
        // a direct (> 4096 characters) dictionary of 300 equal display strings
        pdf.form.comboBox('c', {
          page: pages[0],
          x: 40,
          y: 80,
          width: 100,
          height: 20,
          font,
          options: Array.from({ length: 300 }, (_, i) => [`e${i}`, 'Same']),
        });
      },
      { compress: false, encrypt: { ownerPassword: 'o' } },
    );
    const s = latin(b),
      ivs = [];
    for (const m of s.matchAll(/\/Length (\d+) >>\nstream\n/g))
      ivs.push(s.slice(m.index + m[0].length, m.index + m[0].length + 16));
    const direct = s.slice(s.indexOf('/Opt ['), s.indexOf(' /DA', s.indexOf('/Opt [')));
    for (const m of direct.matchAll(/<([0-9a-f]{32})[0-9a-f]+>/g)) ivs.push(m[1]);
    expect(ivs.length).toBeGreaterThan(600 - 2); // 300 pairs (some written as one string) + the streams
    expect(new Set(ivs).size).toBe(ivs.length);
  });
});
