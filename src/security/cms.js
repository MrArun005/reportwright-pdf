// @ts-check
/**
 * CMS SignedData (RFC 5652), detached, for PDF signatures: cmsSigner({ certs, keyAlgorithm, sign }) builds it around
 * any raw signer (an HSM, a cloud KMS: sign(bytes, hash) → signature bytes); nodeSigner({ key, certs }) signs with
 * node:crypto (RSA PKCS#1 v1.5 or PSS, ECDSA P-256 / P-384; SHA-256/384/512).
 *
 * Signed attributes: content-type, message-digest, ESS signing-certificate-v2 (PAdES needs it: it binds the signer's
 * certificate) and, for /adbe.pkcs7.detached only, signing-time (PAdES baseline puts the time in /M and forbids the
 * attribute, ETSI EN 319 142-1 §5.4.2). A timestamp (RFC 3161 TimeStampToken, from the caller's callback: no network
 * here) goes in as the unsigned attribute id-aa-timeStampToken over the signature value (PAdES B-T).
 */
import { builtin } from '../core/lazy.js';
import { seq, set, ctx, tlv, oid, int, octets, time, NULL, read, kids } from './der.js';
import { sha, concat } from './crypto.js';

const node = () => builtin('node:crypto');
export const MAX_CERTS = 10, MAX_CERT = 64 * 1024, MAX_SIGNATURE = 16 * 1024, MAX_TOKEN = 64 * 1024;
const DIGEST = { 'SHA-256': '2.16.840.1.101.3.4.2.1', 'SHA-384': '2.16.840.1.101.3.4.2.2', 'SHA-512': '2.16.840.1.101.3.4.2.3' };
const RSA = { 'SHA-256': '1.2.840.113549.1.1.11', 'SHA-384': '1.2.840.113549.1.1.12', 'SHA-512': '1.2.840.113549.1.1.13' };
const ECDSA = { 'SHA-256': '1.2.840.10045.4.3.2', 'SHA-384': '1.2.840.10045.4.3.3', 'SHA-512': '1.2.840.10045.4.3.4' };
const SIGNED_DATA = '1.2.840.113549.1.7.2', DATA = '1.2.840.113549.1.7.1';
const attr = (/** @type {string} */ id, /** @type {Uint8Array} */ v) => seq(oid(id), set(v));
const algId = (/** @type {string} */ h) => seq(oid(DIGEST[/** @type {keyof typeof DIGEST} */ (h)]));

/** the certificates (PEM text with one or more, DER bytes, or an array of either), first the signer's @param {any} certs @param {string} who */
export function readCerts(certs, who) {
  const list = Array.isArray(certs) ? certs : [certs];
  /** @type {Uint8Array[]} */
  const out = [];
  for (const c of list) {
    if (c instanceof Uint8Array) out.push(c);
    else if (typeof c === 'string') {
      if (c.length > MAX_CERTS * MAX_CERT * 2) throw new RangeError(`${who}: certs is too long`);
      for (const m of c.matchAll(/-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+?)-----END CERTIFICATE-----/g)) {
        out.push(Uint8Array.from(atob(m[1].replace(/\s+/g, '')), (ch) => ch.charCodeAt(0)));
        if (out.length > MAX_CERTS) break;
      }
    } else throw new TypeError(`${who}: certs is PEM text, DER bytes or an array of them (the signer's certificate first)`);
    if (out.length > MAX_CERTS) throw new RangeError(`${who}: at most ${MAX_CERTS} certificates`);
  }
  if (!out.length) throw new TypeError(`${who}: no certificate (PEM "-----BEGIN CERTIFICATE-----" or DER bytes)`);
  return out.map((d) => {
    if (d.length > MAX_CERT) throw new RangeError(`${who}: a certificate is at most ${MAX_CERT} bytes`);
    try {
      const c = read(d, 0);
      if (c.tag !== 0x30 || c.end !== d.length) throw new Error();
      const tbs = kids(d, c)[0], t = kids(d, tbs);
      const i = t[0].tag === 0xa0 ? 1 : 0; // [0] version
      if (t[i].tag !== 0x02 || t[i + 2].tag !== 0x30) throw new Error();
      return { der: d, serial: t[i].whole, issuer: t[i + 2].whole };
    } catch { throw new TypeError(`${who}: a certificate is not a DER X.509 certificate`); }
  });
}

/**
 * A signer for pdf.sign from a raw signature function. @param {{ certs: any, keyAlgorithm: 'rsa' | 'rsa-pss' | 'ecdsa',
 *   sign: (bytes: Uint8Array, hash: string) => Uint8Array | Promise<Uint8Array> }} o
 */
export function cmsSigner(o) {
  const who = 'cmsSigner';
  if (o == null || typeof o.sign !== 'function') throw new TypeError(`${who}: sign(bytes, hash) is a function giving the raw signature`);
  if (!['rsa', 'rsa-pss', 'ecdsa'].includes(o.keyAlgorithm)) throw new TypeError(`${who}: keyAlgorithm is 'rsa' (PKCS#1 v1.5), 'rsa-pss' or 'ecdsa'`);
  const certs = readCerts(o.certs, who), alg = o.keyAlgorithm, raw = o.sign;
  /** @param {{ digest: Uint8Array, hash: 'SHA-256' | 'SHA-384' | 'SHA-512', subFilter: string, date: Date, timestamp?: (sig: Uint8Array) => any, signal?: AbortSignal }} r */
  return async (r) => {
    const h = r.hash, me = certs[0];
    const signed = set(
      attr('1.2.840.113549.1.9.3', oid(DATA)),
      attr('1.2.840.113549.1.9.4', octets(r.digest)),
      // ESS signing-certificate-v2: SHA-256 (the default, so no algorithm) of the signer's certificate, and its issuer and serial
      attr('1.2.840.113549.1.9.16.2.47', seq(seq(seq(octets(await sha('SHA-256', me.der)), seq(seq(ctx(4, me.issuer)), me.serial))))),
      ...(r.subFilter === 'adbe.pkcs7.detached' ? [attr('1.2.840.113549.1.9.5', time(r.date))] : []),
    );
    const sig = await raw(signed, h);
    if (!(sig instanceof Uint8Array) || !sig.length || sig.length > MAX_SIGNATURE) throw new TypeError(`${who}: sign() gave ${sig instanceof Uint8Array ? `${sig.length} bytes` : 'no bytes'}: a signature is 1–${MAX_SIGNATURE} bytes`);
    r.signal?.throwIfAborted();
    const sigAlg = alg === 'ecdsa' ? seq(oid(ECDSA[h])) : alg === 'rsa' ? seq(oid(RSA[h]), NULL)
      : seq(oid('1.2.840.113549.1.1.10'), seq(ctx(0, algId(h)), ctx(1, seq(oid('1.2.840.113549.1.1.8'), algId(h))), ctx(2, int({ 'SHA-256': 32, 'SHA-384': 48, 'SHA-512': 64 }[h]))));
    let unsigned = new Uint8Array(0);
    if (r.timestamp) {
      const tst = await r.timestamp(sig);
      checkContentInfo(tst, MAX_TOKEN, 'timestamp: the TimeStampToken');
      unsigned = ctx(1, attr('1.2.840.113549.1.9.16.2.14', tst));
    }
    const signerInfo = seq(int(1), seq(me.issuer, me.serial), algId(h), concat([Uint8Array.of(0xa0), signed.subarray(1)]), sigAlg, octets(sig), unsigned);
    const certSet = tlv(0xa0, ...certs.map((c) => c.der).sort((a, b) => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; }));
    return seq(oid(SIGNED_DATA), ctx(0, seq(int(1), set(algId(h)), seq(oid(DATA)), certSet, set(signerInfo))));
  };
}

/**
 * Bytes that must be one DER ContentInfo of SignedData (a CMS signature, a TimeStampToken), within max bytes.
 * @param {any} b @param {number} max @param {string} what
 */
export function checkContentInfo(b, max, what) {
  if (!(b instanceof Uint8Array)) throw new TypeError(`${what} is not bytes (a Uint8Array)`);
  if (b.length > max) throw new RangeError(`${what} is ${b.length} bytes, more than ${max}`);
  try {
    const c = read(b, 0);
    if (c.tag !== 0x30 || c.end !== b.length) throw new Error();
    const k = kids(b, c);
    if (k[0].tag !== 0x06 || !eq(k[0].whole, oid(SIGNED_DATA)) || k[1]?.tag !== 0xa0) throw new Error();
  } catch { throw new TypeError(`${what} is not a DER CMS ContentInfo of SignedData`); }
}
const eq = (/** @type {Uint8Array} */ a, /** @type {Uint8Array} */ b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * A signer for pdf.sign with node:crypto. key: a private key (PEM, DER, { key, passphrase } or a KeyObject); certs: the
 * PEM chain, the signer's certificate first; pss: RSA-PSS instead of PKCS#1 v1.5. @param {{ key: any, certs: any, pss?: boolean }} o
 */
export function nodeSigner(o) {
  const who = 'nodeSigner';
  if (!node()) throw new TypeError(`${who} needs Node (node:crypto); elsewhere use cmsSigner with WebCrypto or your HSM`);
  if (o == null || typeof o !== 'object') throw new TypeError(`${who}: options are { key, certs, pss }`);
  let k;
  try { k = o.key instanceof node().KeyObject ? o.key : node().createPrivateKey(o.key); }
  catch { throw new TypeError(`${who}: key is not a private key (PEM, DER, { key, passphrase } or a KeyObject)`); } // the cause is dropped: never echo key material
  if (k.type !== 'private') throw new TypeError(`${who}: key is not a private key`);
  const type = k.asymmetricKeyType, curve = k.asymmetricKeyDetails?.namedCurve;
  if (!['rsa', 'rsa-pss', 'ec'].includes(type) || (type === 'ec' && !['prime256v1', 'secp384r1'].includes(curve))) throw new TypeError(`${who}: the key is RSA or ECDSA P-256 / P-384`);
  const certs = readCerts(o.certs, who);
  let ok = false;
  try { ok = new (node().X509Certificate)(certs[0].der).checkPrivateKey(k); } catch { /* not a certificate node can read */ }
  if (!ok) throw new TypeError(`${who}: the key does not match the first certificate (the signer's)`);
  const pss = type === 'rsa-pss' || (type === 'rsa' && !!o.pss);
  return cmsSigner({
    certs: certs.map((c) => c.der),
    keyAlgorithm: type === 'ec' ? 'ecdsa' : pss ? 'rsa-pss' : 'rsa',
    sign: (bytes, h) => new Uint8Array(node().sign(h.replace('-', '').toLowerCase(), bytes, pss
      ? { key: k, padding: node().constants.RSA_PKCS1_PSS_PADDING, saltLength: { 'SHA-256': 32, 'SHA-384': 48, 'SHA-512': 64 }[h] }
      : { key: k, dsaEncoding: 'der' })),
  });
}
