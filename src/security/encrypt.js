// @ts-check
/**
 * The standard security handler: AES-256 (V5/R6, ISO 32000-2 §7.6.4.3.3, the default) or AES-128 (V4/R4, /CFM /AESV2,
 * for old readers). RC4 is refused: it is broken (and so are V1–V3 / R2–R3, which only have RC4).
 *
 * It plugs into the encryption hook of core/objects.js: every string the library writes into a dictionary is a hex
 * string, so dict() finds them all and replaces each with IV + AES-CBC(PKCS#7) of its bytes; stream() does the same to
 * a stream's (filtered) bytes. A random 16-byte IV each time (crypto.getRandomValues). The xref stream is never
 * passed, the Encrypt dictionary is written as it is, and strings inside object streams are not encrypted on their own
 * (the object stream is, as a stream: ISO 32000-1 §7.6.2).
 *
 * Hand-written here, and only here: the key derivations the spec defines (Algorithm 2.B for R6; Algorithms 2, 3, 5
 * for R4, whose /O and /U use RC4 as a key-stretching step only: no content is ever RC4-encrypted). Each is checked
 * against qpdf (/O, /U, /UE, /OE, /Perms of a file qpdf made) and by poppler opening our files with each password.
 * Passwords and keys are never logged or put in an error message.
 */
import { aesCbc, sha, md5, random, concat, hex, unhex } from './crypto.js';

export const MAX_PASSWORD = 1024; // characters, refused above (before any work); the spec keeps 127 bytes (R6) or 32 (R4)
const PERMS = { print: 3, modify: 4, copy: 5, annotate: 6, fillForms: 9, accessibility: 10, assemble: 11, printHighQuality: 12 };
const PAD = unhex('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a');
const UTF8 = new TextEncoder();

/**
 * /P: bits 1–2 are 0, 7–8 and 13–32 are 1 (reserved, ISO 32000-2 Table 22), then a bit per permission granted; a
 * signed 32-bit integer. @param {Record<string, boolean>} p every key of PERMS
 */
export function permBits(p) {
  let P = 0xFFFFF0C0;
  for (const [k, bit] of Object.entries(PERMS)) if (p[k]) P |= 1 << (bit - 1);
  return P | 0;
}

/**
 * SASLprep (RFC 4013), simplified as ISO 32000-2 §7.6.4.3.3 allows in spirit: non-ASCII spaces become U+0020, the
 * characters "commonly mapped to nothing" are dropped, NFKC, then prohibited characters (controls, private use,
 * surrogates, non-characters, unassigned, bidi and tagging controls) throw. Not done: the bidi rule (RFC 3454 §6).
 * Then the UTF-8 bytes, cut at 127 (as readers cut them). @param {string} pw @param {string} who
 */
export function saslprep(pw, who) {
  const s = pw.replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    .replace(/[\u00AD\u034F\u1806\u180B-\u180D\u200B-\u200D\u2060\uFE00-\uFE0F\uFEFF]/g, '').normalize('NFKC');
  if (/[\p{Cc}\p{Co}\p{Cs}\p{Cn}\u0340\u0341\u06DD\u070F\u180E\u200E\u200F\u2028-\u202E\u2061-\u2063\u206A-\u206F\uFFF9-\uFFFD\u2FF0-\u2FFB]|[\u{E0001}\u{E0020}-\u{E007F}\u{1D173}-\u{1D17A}]/u.test(s)) {
    throw new TypeError(`${who}: the password has a control, private-use, unassigned or bidi character, which SASLprep (ISO 32000-2 §7.6.4.3.3) prohibits`);
  }
  return UTF8.encode(s).subarray(0, 127);
}
/** R4: the password's bytes (Latin-1 only: PDFDocEncoding is not defined past it for passwords), padded to 32 @param {string} pw @param {string} who */
export function pad32(pw, who) {
  const b = new Uint8Array(32);
  let n = 0;
  for (const ch of pw) {
    const c = /** @type {number} */ (ch.codePointAt(0));
    if (c < 0x20 || c > 0xff || (c >= 0x7f && c < 0xa0)) throw new TypeError(`${who}: an AES-128 password is printable Latin-1 only (use AES-256 for any Unicode password)`);
    if (n < 32) b[n++] = c;
  }
  b.set(PAD.subarray(0, 32 - n), n);
  return b;
}

/** RC4, only as Algorithms 3 and 5 use it to compute /O and /U (R4). Never used on content. @param {Uint8Array} key @param {Uint8Array} data */
function rc4(key, data) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  for (let i = 0, j = 0; i < 256; i++) { j = (j + S[i] + key[i % key.length]) & 255; [S[i], S[j]] = [S[j], S[i]]; }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255; j = (j + S[i]) & 255; [S[i], S[j]] = [S[j], S[i]];
    out[k] = data[k] ^ S[(S[i] + S[j]) & 255];
  }
  return out;
}
/** Algorithms 3 and 5's 20 passes: RC4 with the key, then with each byte XOR 1…19 @param {Uint8Array} key @param {Uint8Array} data */
function rc4x20(key, data) {
  let d = rc4(key, data);
  for (let i = 1; i <= 19; i++) d = rc4(key.map((b) => b ^ i), d);
  return d;
}

/**
 * Algorithm 2.B (ISO 32000-2 §7.6.4.3.4): the R6 hash. @param {Uint8Array} pw prepared, ≤ 127 bytes
 * @param {Uint8Array} salt 8 bytes @param {Uint8Array} udata the 48-byte /U when hashing for the owner, else empty
 */
export async function hash2B(pw, salt, udata) {
  let K = /** @type {Uint8Array} */ (await sha('SHA-256', concat([pw, salt, udata])));
  let E = /** @type {Uint8Array} */ (new Uint8Array(0));
  for (let i = 0; i < 64 || E[E.length - 1] > i - 32; i++) {
    const one = concat([pw, K, udata]), K1 = new Uint8Array(one.length * 64);
    for (let r = 0; r < 64; r++) K1.set(one, r * one.length);
    E = await aesCbc(K.subarray(0, 16), K.subarray(16, 32), K1, false);
    let m = 0; for (let b = 0; b < 16; b++) m += E[b];
    K = await sha(/** @type {any} */ (['SHA-256', 'SHA-384', 'SHA-512'][m % 3]), E);
  }
  return K.subarray(0, 32);
}

/**
 * R6: /U, /UE, /O, /OE, /Perms for a 32-byte file key (salts random unless given: the test vectors pass them).
 * @param {Uint8Array} user @param {Uint8Array} owner prepared passwords @param {Uint8Array} key @param {number} P @param {boolean} meta
 * @param {Uint8Array} [salts] 16 bytes for U then 16 for O (validation, key), and 4 for /Perms
 */
export async function r6(user, owner, key, P, meta, salts = random(36)) {
  const zero = new Uint8Array(16);
  const U = concat([await hash2B(user, salts.subarray(0, 8), new Uint8Array(0)), salts.subarray(0, 16)]);
  const UE = await aesCbc(await hash2B(user, salts.subarray(8, 16), new Uint8Array(0)), zero, key, false);
  const O = concat([await hash2B(owner, salts.subarray(16, 24), U), salts.subarray(16, 32)]);
  const OE = await aesCbc(await hash2B(owner, salts.subarray(24, 32), U), zero, key, false);
  const p = new Uint8Array(16);
  new DataView(p.buffer).setInt32(0, P, true);
  p.set([0xff, 0xff, 0xff, 0xff, meta ? 0x54 : 0x46, 0x61, 0x64, 0x62], 4); // T/F, "adb"
  p.set(salts.subarray(32, 36), 12);
  const Perms = await aesCbc(key, zero, p, false); // AES-256-ECB of one block = CBC with a zero IV
  return { U, UE, O, OE, Perms };
}

/**
 * R4: /O (Algorithm 3), the file key (Algorithm 2), /U (Algorithm 5). @param {Uint8Array} user @param {Uint8Array} owner padded to 32
 * @param {number} P @param {Uint8Array} id the first file ID @param {boolean} meta @param {Uint8Array} [tail] /U's 16 arbitrary bytes
 */
export function r4(user, owner, P, id, meta, tail = random(16)) {
  let h = md5(owner);
  for (let i = 0; i < 50; i++) h = md5(h);
  const O = rc4x20(h, user);
  const p = new Uint8Array(4); new DataView(p.buffer).setInt32(0, P, true);
  let key = md5(concat([user, O, p, id, meta ? new Uint8Array(0) : Uint8Array.of(255, 255, 255, 255)]));
  for (let i = 0; i < 50; i++) key = md5(key);
  const U = concat([rc4x20(key, md5(concat([PAD, id]))), tail]);
  return { O, U, key };
}

/**
 * The Encryptor for createPdf's `encrypt` option. @param {any} opt @param {{ id?: string, tagged: boolean, pdfa: boolean, warn: (m: string) => void }} doc
 * @returns {import('../core/objects.js').Encryptor & { ref: number, setup: Promise<string>, extensions: string }}
 */
export function encryptor(opt, doc) {
  const who = 'createPdf: encrypt';
  if (doc.pdfa) throw new TypeError(`${who}: PDF/A forbids encryption (ISO 19005-2 §6.1.3): a PDF/A file must open in any reader, forever, without a password`);
  if (opt === true) opt = {};
  if (opt == null || typeof opt !== 'object') throw new TypeError(`${who} is { userPassword, ownerPassword, algorithm, permissions, encryptMetadata }`);
  for (const k of Object.keys(opt)) if (!['userPassword', 'ownerPassword', 'algorithm', 'permissions', 'encryptMetadata'].includes(k)) throw new TypeError(`${who}: unknown option ${JSON.stringify(k.slice(0, 40))} (userPassword, ownerPassword, algorithm, permissions, encryptMetadata)`);
  const alg = opt.algorithm ?? 'aes-256';
  if (typeof alg === 'string' && /rc4|40|v1|v2|r2|r3/i.test(alg)) throw new TypeError(`${who}: RC4 (40- and 128-bit) is refused: it is broken (its key stream is biased and its 40-bit keys are brute-forced in minutes), so it would only look like protection. Use 'aes-256' (the default) or 'aes-128' for old readers`);
  if (alg !== 'aes-256' && alg !== 'aes-128') throw new TypeError(`${who}: algorithm is 'aes-256' (default) or 'aes-128'`);
  const pw = (/** @type {any} */ v, /** @type {string} */ what) => {
    if (typeof v !== 'string') throw new TypeError(`${who}: ${what} is a string`);
    if (v.length > MAX_PASSWORD) throw new RangeError(`${who}: ${what} is at most ${MAX_PASSWORD} characters (the PDF keeps ${alg === 'aes-256' ? '127 bytes' : '32 characters'})`);
    return v;
  };
  const user = pw(opt.userPassword ?? '', 'userPassword');
  if (opt.ownerPassword === '') throw new TypeError(`${who}: an empty ownerPassword would give everyone full access; leave it out for a random one (nobody can then change the permissions)`);
  const owner = opt.ownerPassword == null ? null : pw(opt.ownerPassword, 'ownerPassword');
  const perms = { print: true, printHighQuality: true, modify: true, copy: true, annotate: true, fillForms: true, accessibility: true, assemble: true };
  if (opt.permissions != null) {
    if (typeof opt.permissions !== 'object') throw new TypeError(`${who}: permissions is an object of booleans`);
    for (const [k, v] of Object.entries(opt.permissions)) {
      if (!Object.hasOwn(perms, k)) throw new TypeError(`${who}: permissions: unknown ${JSON.stringify(k.slice(0, 40))} (${Object.keys(perms).join(', ')})`);
      if (typeof v !== 'boolean') throw new TypeError(`${who}: permissions.${k} is true or false`);
      /** @type {any} */ (perms)[k] = v;
    }
  }
  if (doc.tagged && !perms.accessibility) { perms.accessibility = true; doc.warn('encrypt: the accessibility permission was turned back on: PDF/UA (ISO 14289-1 §7.16) needs assistive technology to read the content'); }
  if (owner != null && owner === user && user !== '') doc.warn('encrypt: the owner password is the user password, so whoever opens the file has full access and the permissions do not apply');
  const meta = opt.encryptMetadata ?? true;
  if (typeof meta !== 'boolean') throw new TypeError(`${who}: encryptMetadata is true or false`);
  const P = permBits(perms);
  const aes256 = alg === 'aes-256';
  // prepared before the first await: a bad password throws from createPdf, not later
  const u = aes256 ? saslprep(user, `${who}: userPassword`) : pad32(user, `${who}: userPassword`);
  const ow = owner == null ? (aes256 ? random(32).map((b) => 0x21 + (b % 94)) : pad32(String.fromCharCode(...random(32).map((b) => 0x21 + (b % 94))), who))
    : aes256 ? saslprep(owner, `${who}: ownerPassword`) : pad32(owner, `${who}: ownerPassword`);
  const id = doc.id ?? hex(random(16)); // fixed up front: the R4 key depends on it, and the file is streamed
  let key = /** @type {Uint8Array} */ (new Uint8Array(0));
  const setup = (async () => {
    const m = meta ? '' : ' /EncryptMetadata false';
    if (aes256) {
      key = random(32);
      const v = await r6(u, ow, key, P, meta);
      return `<< /Filter /Standard /V 5 /R 6 /Length 256 /CF << /StdCF << /Type /CryptFilter /CFM /AESV3 /AuthEvent /DocOpen /Length 32 >> >> /StmF /StdCF /StrF /StdCF /O <${hex(v.O)}> /U <${hex(v.U)}> /OE <${hex(v.OE)}> /UE <${hex(v.UE)}> /P ${P} /Perms <${hex(v.Perms)}>${m} >>`;
    }
    const v = r4(u, ow, P, unhex(id), meta);
    key = v.key;
    return `<< /Filter /Standard /V 4 /R 4 /Length 128 /CF << /StdCF << /Type /CryptFilter /CFM /AESV2 /AuthEvent /DocOpen /Length 16 >> >> /StmF /StdCF /StrF /StdCF /O <${hex(v.O)}> /U <${hex(v.U)}> /P ${P}${m} >>`;
  })();
  setup.catch(() => {});
  /** the key for object n: R6 uses the file key; R4 MD5(key, n, 0, "sAlT") (Algorithm 1) @param {number} n */
  const keyOf = (n) => (aes256 ? key : md5(concat([key, Uint8Array.of(n & 255, (n >> 8) & 255, (n >> 16) & 255, 0, 0), Uint8Array.of(0x73, 0x41, 0x6c, 0x54)])));
  /** @param {Uint8Array} k @param {Uint8Array} b */
  const seal = async (k, b) => { const iv = random(16); return concat([iv, await aesCbc(k, iv, b)]); };
  const self = {
    id, ref: 0, setup, trailer: '',
    /** R6 is PDF 2.0's: a 1.7 file says so with Adobe's extension level 8 */
    extensions: aes256 ? '<< /ADBE << /BaseVersion /1.7 /ExtensionLevel 8 >> >>' : '',
    /** @param {number} n @param {string} d */
    async dict(n, d) {
      if (n === self.ref) return d; // the Encrypt dictionary is never encrypted
      // EncryptMetadata false: the XMP stream says so too (the Identity crypt filter), or poppler decrypts it anyway
      if (!meta && /^<< \/Type \/Metadata\b/.test(d) && !d.includes('/Filter')) return d.replace(/>>\s*$/, '/Filter /Crypt /DecodeParms << /Name /Identity >> >>');
      await setup;
      const k = keyOf(n), out = [];
      let at = 0;
      for (const m of d.matchAll(/(?<!<)<(?!<)([0-9A-Fa-f]*)>/g)) {
        const i = /** @type {number} */ (m.index);
        if (d.slice(at, i).includes('(')) throw new Error('internal: a literal string in a dictionary cannot be encrypted (every dictionary string must be hex)');
        out.push(d.slice(at, i), `<${hex(await seal(k, unhex(m[1])))}>`);
        at = i + m[0].length;
      }
      if (d.slice(at).includes('(')) throw new Error('internal: a literal string in a dictionary cannot be encrypted (every dictionary string must be hex)');
      out.push(d.slice(at));
      return out.join('');
    },
    /** @param {number} n @param {Uint8Array} b @param {string} d */
    async stream(n, b, d) {
      if (!meta && /\/Type\s*\/Metadata\b/.test(d)) return b; // EncryptMetadata false: XMP stays readable
      await setup;
      return seal(keyOf(n), b);
    },
  };
  return self;
}
