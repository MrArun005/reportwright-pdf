// @ts-check
/**
 * The platform's crypto, and nothing hand-written: AES-CBC and SHA-2 from WebCrypto (crypto.subtle), randomness from
 * crypto.getRandomValues only. node:crypto is a Node-only fast path with the same results (tests/pdf/encrypt.test.js
 * compares the two). MD5 (needed only by the AES-128 / R4 key derivation the PDF spec defines) is node:crypto's, else
 * core/md5.js in browsers (WebCrypto has no MD5).
 * Keys never leave these functions in an error message or a log.
 */
import { builtin } from '../core/lazy.js';
import { md5 as md5js } from '../core/md5.js';

const node = () => builtin('node:crypto');
/** WebCrypto, read on use (in Node, reading globalThis.crypto loads it) */
const web = () => /** @type {any} */ (globalThis).crypto;

/** n random bytes (crypto.getRandomValues) @param {number} n */
export const random = (n) => web().getRandomValues(new Uint8Array(n));

/** @param {Uint8Array[]} parts */
export function concat(parts) {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); n = 0;
  for (const p of parts) { out.set(p, n); n += p.length; }
  return out;
}

/**
 * AES-CBC encryption with a 16- or 32-byte key. padding false: data is a whole number of blocks, no padding block
 * is added (WebCrypto always pads, so its last block, the padding of a whole-block input, is dropped: CBC's earlier
 * blocks do not depend on it). @param {Uint8Array} key @param {Uint8Array} iv @param {Uint8Array} data @param {boolean} [padding]
 * @returns {Promise<Uint8Array>}
 */
export async function aesCbc(key, iv, data, padding = true) {
  if (!node()) return aesCbcWeb(key, iv, data, padding);
  const c = node().createCipheriv(`aes-${key.length * 8}-cbc`, key, iv);
  c.setAutoPadding(padding);
  return concat([c.update(data), c.final()]);
}
/**
 * AES-CBC with PKCS#7 padding, IV first: iv + ciphertext in one buffer (one allocation), synchronously with node:crypto,
 * else null (the caller takes aesCbc's async path). @param {Uint8Array} key @param {Uint8Array} iv @param {Uint8Array} data
 * @returns {Uint8Array | null}
 */
export function sealSync(key, iv, data) {
  if (!node()) return null;
  const c = node().createCipheriv(`aes-${key.length * 8}-cbc`, key, iv);
  const out = new Uint8Array(16 + (data.length & ~15) + 16);
  out.set(iv);
  const a = c.update(data); out.set(a, 16);
  out.set(c.final(), 16 + a.length);
  return out;
}
/** the WebCrypto path of aesCbc (exported for the test that compares both) @param {Uint8Array} key @param {Uint8Array} iv @param {Uint8Array} data @param {boolean} [padding] */
export async function aesCbcWeb(key, iv, data, padding = true) {
  if (!padding && data.length % 16) throw new RangeError('internal: unpadded AES-CBC needs whole blocks');
  const k = await web().subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt']);
  const out = new Uint8Array(await web().subtle.encrypt({ name: 'AES-CBC', iv }, k, data));
  return padding ? out : out.subarray(0, data.length);
}

/** @typedef {'SHA-256' | 'SHA-384' | 'SHA-512'} Hash */
export const HASHES = ['SHA-256', 'SHA-384', 'SHA-512'];
const nodeName = (/** @type {string} */ h) => h.replace('-', '').toLowerCase();

/** a SHA-2 digest @param {Hash} name @param {Uint8Array} data @returns {Promise<Uint8Array>} */
export async function sha(name, data) {
  if (node()) return new Uint8Array(node().createHash(nodeName(name)).update(data).digest());
  return shaWeb(name, data);
}
/** @param {Hash} name @param {Uint8Array} data */
export async function shaWeb(name, data) { return new Uint8Array(await web().subtle.digest(name, data)); }

/** MD5, for the R4 key derivation only @param {Uint8Array} data @returns {Uint8Array} */
export function md5(data) {
  if (node()) return new Uint8Array(node().createHash('md5').update(data).digest());
  const h = md5js(data), out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/**
 * An incremental hash of every byte the file writes (the signature's digest). Node: node:crypto's incremental hash, so
 * nothing is held. Browsers: WebCrypto has no incremental digest, so the bytes are held until digest().
 * ponytail: a browser holds the signed file in memory; a streaming SHA would need a hand-written one, which is not allowed here.
 * @param {Hash} name @returns {{ update(b: Uint8Array): void, digest(): Promise<Uint8Array> }}
 */
export function hasher(name) {
  if (node()) { const h = node().createHash(nodeName(name)); return { update: (b) => { h.update(b); }, digest: async () => new Uint8Array(h.digest()) }; }
  /** @type {Uint8Array[]} */
  const parts = [];
  return { update: (b) => { parts.push(b.slice()); }, digest: () => shaWeb(name, concat(parts)) };
}

export const hex = (/** @type {Uint8Array} */ b) => { let s = ''; for (const x of b) s += x.toString(16).padStart(2, '0'); return s; };
export const unhex = (/** @type {string} */ s) => { const b = new Uint8Array(s.length >> 1); for (let i = 0; i < b.length; i++) b[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return b; };

/**
 * AES-CBC decryption for the reader (reader/crypt.js), synchronous: node:crypto only (WebCrypto is async and the
 * reader loads objects lazily, synchronously), so null without it. The PKCS#7 padding is removed when it is valid and
 * left otherwise (damaged files are read as viewers read them); strip false keeps every block (a key's 32 bytes).
 * @param {Uint8Array} key @param {Uint8Array} iv @param {Uint8Array} data @param {boolean} [strip]
 * @returns {Uint8Array | null}
 */
export function aesCbcDecryptSync(key, iv, data, strip = true) {
  if (!node()) return null;
  const whole = data.subarray(0, data.length - (data.length % 16));
  const d = node().createDecipheriv(`aes-${key.length * 8}-cbc`, key, iv);
  d.setAutoPadding(false);
  const out = concat([d.update(whole), d.final()]);
  const p = out[out.length - 1];
  if (strip && p >= 1 && p <= 16 && p <= out.length && out.subarray(out.length - p).every((x) => x === p)) return out.subarray(0, out.length - p);
  return out;
}
