// @ts-check
/**
 * Reading encrypted files: the standard security handler, every revision found in the wild. R2/R3 (RC4 40–128 bit),
 * R4 (RC4 or AES-128 crypt filters), R5 (Adobe's deprecated AES-256) and R6 (AES-256, ISO 32000-2). The password is
 * tried as the user password, then as the owner password. RC4 is allowed here for READING only: writing stays
 * AES-only (security/encrypt.js refuses RC4; an incremental save of an RC4 file is refused).
 *
 * Reused from group F: the key derivations' parts (hash2B, PAD, rc4, saslprep), MD5, SHA-2 and the platform's AES
 * (security/crypto.js; decryption is node:crypto's, synchronous, so objects can still load lazily).
 * Passwords and keys never appear in an error message.
 */
import { hash2B, PAD, rc4, saslprep } from '../security/encrypt.js';
import { md5, sha, concat, aesCbc, aesCbcDecryptSync, random } from '../security/crypto.js';
import { PdfString } from './lexer.js';
import { fail } from './budget.js';

const PERMS = { print: 3, modify: 4, copy: 5, annotate: 6, fillForms: 9, accessibility: 10, assemble: 11, printHighQuality: 12 };

/** bytes of a string option (Latin-1 when it fits, else UTF-8) for R2–R4, padded to 32 @param {string} pw */
function pad32(pw) {
  const b = [...pw].every((c) => /** @type {number} */ (c.codePointAt(0)) <= 255) ? Uint8Array.from([...pw].map((c) => /** @type {number} */ (c.codePointAt(0)))) : new TextEncoder().encode(pw);
  const out = new Uint8Array(32);
  out.set(b.subarray(0, 32));
  if (b.length < 32) out.set(PAD.subarray(0, 32 - b.length), b.length);
  return out;
}
const bytesOf = (/** @type {any} */ v, /** @type {number} */ n) => (v instanceof PdfString ? v.bytes : new Uint8Array(n));
const le32 = (/** @type {number} */ P) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, P, true); return b; };
const eq = (/** @type {Uint8Array} */ a, /** @type {Uint8Array} */ b, n = a.length) => a.length >= n && b.length >= n && a.subarray(0, n).every((x, i) => x === b[i]);

/**
 * @param {Map<string, any>} E the Encrypt dictionary (resolved) @param {Uint8Array} id0 the first file ID
 * @param {string} password @param {(v: any) => any} resolve
 */
export async function openSecurity(E, id0, password, resolve) {
  const g = (/** @type {string} */ k) => resolve(E.get(k));
  if (g('Filter') !== 'Standard') fail('E_UNSUPPORTED', `The PDF is encrypted with the ${String(g('Filter')).slice(0, 40)} security handler; only the standard (password) handler is read`);
  const V = g('V') ?? 0, R = g('R') ?? 2, P = (g('P') ?? -4) | 0;
  const meta = g('EncryptMetadata') !== false;
  const O = bytesOf(g('O'), 48), U = bytesOf(g('U'), 48);
  if (![2, 3, 4, 5, 6].includes(R)) fail('E_UNSUPPORTED', `Encryption revision ${String(R).slice(0, 10)} is not supported`);
  if (typeof password !== 'string' || password.length > 1024) throw new TypeError('loadPdf: password is a string of at most 1024 characters');

  // crypt filters: method per strings and streams
  const cf = g('CF') instanceof Map ? g('CF') : new Map();
  const methodOf = (/** @type {any} */ name) => {
    if (V < 4) return 'RC4';
    if (name == null || name === 'Identity') return 'None';
    const f = resolve(cf.get(name));
    const m = f instanceof Map ? resolve(f.get('CFM')) : null;
    return m === 'AESV2' ? 'AESV2' : m === 'AESV3' ? 'AESV3' : m === 'V2' ? 'RC4' : 'None';
  };
  const stm = methodOf(g('StmF') ?? (V >= 4 ? 'Identity' : null)), str = methodOf(g('StrF') ?? (V >= 4 ? 'Identity' : null));
  if (R < 5 && (stm === 'AESV3' || str === 'AESV3')) fail('E_MALFORMED', `AESV3 (AES-256) needs revision 5 or 6, not ${R}`);

  /** @type {Uint8Array | null} */
  let key = null, owner = false;
  if (R >= 5) {
    let pw;
    try { pw = saslprep(password, 'loadPdf: password'); } catch { pw = null; }
    if (pw) {
      const h = async (/** @type {Uint8Array} */ salt, /** @type {Uint8Array} */ ud) => (R === 6 ? hash2B(pw, salt, ud) : sha('SHA-256', concat([pw, salt, ud])));
      const zero = new Uint8Array(16), U48 = U.subarray(0, 48);
      // /UE and /OE hold the 32-byte file key, encrypted: shorter ones would give a key AES cannot use
      const wrapped = (/** @type {string} */ k) => { const b = bytesOf(g(k), 32); if (b.length < 32) fail('E_MALFORMED', `The Encrypt dictionary's /${k} is ${b.length} bytes, not 32`); return b.subarray(0, 32); };
      if (eq(await h(U.subarray(32, 40), new Uint8Array(0)), U, 32)) {
        key = aesCbcDecryptSync(await h(U.subarray(40, 48), new Uint8Array(0)), zero, wrapped('UE'), false);
      } else if (eq(await h(O.subarray(32, 40), U48), O, 32)) {
        key = aesCbcDecryptSync(await h(O.subarray(40, 48), U48), zero, wrapped('OE'), false);
        owner = true;
      }
      if (key === null && !aesCbcDecryptSync(new Uint8Array(16), new Uint8Array(16), new Uint8Array(16))) fail('E_UNSUPPORTED', 'Reading an AES-encrypted PDF needs node:crypto (WebCrypto has no synchronous AES)');
    }
  } else {
    const n = R === 2 ? 5 : Math.min(16, Math.max(5, Math.floor((g('Length') ?? 40) / 8)));
    const fileKey = (/** @type {Uint8Array} */ padded) => {
      let k = md5(concat([padded, O.subarray(0, 32), le32(P), id0, R >= 4 && !meta ? Uint8Array.of(255, 255, 255, 255) : new Uint8Array(0)]));
      if (R >= 3) for (let i = 0; i < 50; i++) k = md5(k.subarray(0, n));
      return k.subarray(0, n);
    };
    const userOk = (/** @type {Uint8Array} */ k) => {
      if (R === 2) return eq(rc4(k, PAD), U, 32);
      let x = rc4(k, md5(concat([PAD, id0])));
      for (let i = 1; i <= 19; i++) x = rc4(k.map((b) => b ^ i), x);
      return eq(x, U, 16);
    };
    const pw = pad32(password);
    let k = fileKey(pw);
    if (userOk(k)) key = k;
    else { // the owner password: it decrypts /O to the padded user password
      let h = md5(pw);
      if (R >= 3) for (let i = 0; i < 50; i++) h = md5(h);
      const ok = h.subarray(0, n);
      let x = O.subarray(0, 32);
      if (R === 2) x = rc4(ok, x);
      else for (let i = 19; i >= 0; i--) x = rc4(ok.map((b) => b ^ i), x);
      k = fileKey(x);
      if (userOk(k)) { key = k; owner = true; }
    }
  }
  if (!key) fail('E_PASSWORD', password ? 'The password is wrong (neither the user nor the owner password)' : 'The PDF is encrypted: a password is needed (loadPdf(bytes, { password }))');
  const K = /** @type {Uint8Array} */ (key);

  /** the key for object n g (Algorithm 1; AES-256: the file key) @param {number} n @param {number} gen @param {boolean} aes */
  const objKey = (n, gen, aes) => {
    const k = md5(concat([K, Uint8Array.of(n & 255, (n >> 8) & 255, (n >> 16) & 255, gen & 255, (gen >> 8) & 255), aes ? Uint8Array.of(0x73, 0x41, 0x6c, 0x54) : new Uint8Array(0)]));
    return k.subarray(0, Math.min(16, K.length + 5));
  };
  /** @param {string} m @param {number} n @param {number} gen @param {Uint8Array} b */
  const dec = (m, n, gen, b) => {
    if (m === 'None') return b;
    if (m === 'RC4') return rc4(objKey(n, gen, false), b);
    if (b.length < 16) return new Uint8Array(0);
    const out = aesCbcDecryptSync(m === 'AESV3' ? K : objKey(n, gen, true), b.subarray(0, 16), b.subarray(16));
    if (!out) fail('E_UNSUPPORTED', 'Reading an AES-encrypted PDF needs node:crypto (WebCrypto has no synchronous AES)');
    return /** @type {Uint8Array} */ (out);
  };
  /** @param {string} m @param {number} n @param {number} gen @param {Uint8Array} b */
  const enc = async (m, n, gen, b) => {
    if (m === 'None') return b;
    if (m === 'RC4') fail('E_UNSUPPORTED', 'This PDF is encrypted with RC4: reading it is allowed, writing RC4 is not (save() a new file, with encrypt: { … } for AES)');
    const iv = random(16);
    return concat([iv, await aesCbc(m === 'AESV3' ? K : objKey(n, gen, true), iv, b)]);
  };
  const perms = Object.fromEntries(Object.entries(PERMS).map(([k, bit]) => [k, owner || !!(P & (1 << (bit - 1)))]));
  return {
    owner, P, permissions: perms, algorithm: stm === 'AESV3' || str === 'AESV3' ? 'aes-256' : stm === 'AESV2' || str === 'AESV2' ? 'aes-128' : 'rc4', revision: R,
    /** decrypt a string of object n @param {number} n @param {number} gen @param {Uint8Array} b */
    string: (n, gen, b) => dec(str, n, gen, b),
    /** decrypt a stream of object n (its dictionary says whether: /Type /Metadata with EncryptMetadata false, a /Crypt filter) @param {number} n @param {number} gen @param {Uint8Array} b @param {Map<string, any>} d */
    stream(n, gen, b, d) {
      let m = stm;
      if (!meta && resolve(d.get('Type')) === 'Metadata') m = 'None';
      const f = resolve(d.get('Filter'));
      if (f === 'Crypt' || (Array.isArray(f) && f.map(resolve)[0] === 'Crypt')) {
        const p = resolve(Array.isArray(f) ? (Array.isArray(resolve(d.get('DecodeParms'))) ? resolve(d.get('DecodeParms'))[0] : null) : d.get('DecodeParms'));
        m = methodOf(p instanceof Map ? resolve(p.get('Name')) ?? 'Identity' : 'Identity');
      }
      return dec(m, n, gen, b);
    },
    /** encrypt for an incremental save (AES only) @param {number} n @param {number} gen @param {Uint8Array} b @param {boolean} isStream @param {Map<string, any> | null} [d] */
    encrypt(n, gen, b, isStream, d) {
      if (isStream && !meta && d && resolve(d.get('Type')) === 'Metadata') return Promise.resolve(b);
      return enc(isStream ? stm : str, n, gen, b);
    },
  };
}
/** @typedef {Awaited<ReturnType<typeof openSecurity>>} Security */
