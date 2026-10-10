// Group F without node:crypto (the browser path): the library loaded with process.getBuiltinModule('node:crypto')
// hidden, so AES, SHA-2, the incremental hash and randomness all come from WebCrypto (and MD5 from core/md5.js).
// poppler opens the AES-256 and AES-128 files; a document signed through cmsSigner with a WebCrypto ECDSA key
// verifies with openssl.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HAS, DIR, run, save, latin } from './tools.js';
import { read } from '../src/security/der.js';

let lib, denied = 0;
const real = process.getBuiltinModule;
beforeAll(async () => {
  process.getBuiltinModule = (m) => { if (m === 'node:crypto' || m === 'crypto') { denied++; return undefined; } return real.call(process, m); };
  vi.resetModules();
  lib = await import('../src/index.js');
  expect(denied).toBe(0); // importing the library asks for no built-in (core/lazy.js: on first use)
  const c = await import('../src/security/crypto.js');
  expect(c.hasher('SHA-256').update).toBeTypeOf('function');
  expect(denied).toBe(1); // the first use asked for node:crypto (once for crypto.js and cms.js) and did not get it
});
afterAll(() => { process.getBuiltinModule = real; });

/** an ECDSA signature from WebCrypto (r ‖ s) as DER (what CMS wants) @param {Uint8Array} rs */
function der(rs) {
  const int = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.subarray(i); return b[0] & 0x80 ? [0x02, b.length + 1, 0, ...b] : [0x02, b.length, ...b]; };
  const body = [...int(rs.subarray(0, rs.length / 2)), ...int(rs.subarray(rs.length / 2))];
  return Uint8Array.from([0x30, body.length, ...body]);
}

describe('WebCrypto only', () => {
  (HAS.poppler ? it : it.skip)('AES-256 and AES-128 files open in poppler with each password', async () => {
    for (const algorithm of ['aes-256', 'aes-128']) {
      const b = await lib.toBytes((pdf) => { pdf.addPage().text('Browser secret', { x: 40, y: 40, font: pdf.standardFont('Helvetica'), size: 12 }); }, { title: 'Web', encrypt: { userPassword: 'u', ownerPassword: 'o', algorithm } });
      expect(run('pdftotext', ['-upw', 'u', save(b), '-'])).toContain('Browser secret');
      expect(run('pdftotext', ['-opw', 'o', save(b), '-'])).toContain('Browser secret');
      expect(latin(b)).not.toContain('Browser secret');
    }
  });
  it('a document signed with a WebCrypto ECDSA key through cmsSigner verifies with openssl', async () => {
    try { execFileSync('which', ['openssl'], { stdio: 'ignore' }); } catch { return; }
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'w.key', '-out', 'w.crt', '-days', '1', '-subj', '/CN=Web'], { cwd: DIR, stdio: 'pipe' });
    execFileSync('openssl', ['pkcs8', '-topk8', '-nocrypt', '-in', 'w.key', '-outform', 'DER', '-out', 'w.p8'], { cwd: DIR, stdio: 'pipe' });
    const key = await crypto.subtle.importKey('pkcs8', fs.readFileSync(path.join(DIR, 'w.p8')), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const signer = lib.cmsSigner({ certs: fs.readFileSync(path.join(DIR, 'w.crt'), 'utf8'), keyAlgorithm: 'ecdsa', sign: async (bytes) => der(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes))) });
    const b = await lib.toBytes(async (pdf) => { await pdf.sign({ name: 's', page: pdf.addPage(), x: 40, y: 40, width: 100, height: 30 }, { signer }); }, { sign: true });
    const s = latin(b), m = /\/ByteRange \[0 (\d+) (\d+) (\d+)\]/.exec(s), [a, c, d] = [m[1], m[2], m[3]].map(Number);
    const all = Buffer.from(s.slice(a + 1, c - 1), 'hex');
    fs.writeFileSync(path.join(DIR, 'w.der'), all.subarray(0, read(all, 0).end)); // the DER value, without the zero padding
    fs.writeFileSync(path.join(DIR, 'w.bin'), Buffer.concat([b.subarray(0, a), b.subarray(c, c + d)]));
    execFileSync('openssl', ['cms', '-verify', '-inform', 'DER', '-in', 'w.der', '-binary', '-content', 'w.bin', '-noverify', '-out', path.join(DIR, 'w.out')], { cwd: DIR, stdio: 'pipe' });
    if (HAS.poppler) expect(run('pdfsig', [save(b)])).toContain('Signature is Valid.');
  });
});
