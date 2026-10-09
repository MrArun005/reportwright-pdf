// @ts-check
/**
 * pdf.sign(field, { signer, … }): one PAdES signature (B-B; B-T with a timestamp) per document, made while the file
 * streams. Every byte written is hashed as it goes out (createPdf's `sign` option starts the hash); the signature
 * dictionary is the file's LAST object, and it, the xref stream and the trailer (the tail) are built in memory, so the
 * /ByteRange is known before anything after /Contents is written: hash(prefix + tail) → the signer → /Contents. The
 * field's widget references the signature object reserved here (/V); the AcroForm gets /SigFlags 3; certify adds the
 * DocMDP /Reference and the catalog's /Perms. Incremental updates (a second signature) belong to group H.
 */
import { kindOf, unbrand } from '../core/brand.js';
import { text, pdfDate } from '../core/serialize.js';
import { raced } from '../core/sink.js';
import { BYTERANGE } from '../core/objects.js';
import { checkContentInfo } from './cms.js';

export const DEFAULT_RESERVE = 16 * 1024, MAX_RESERVE = 1024 * 1024;
const KEYS = ['signer', 'reason', 'location', 'contactInfo', 'name', 'date', 'certify', 'timestamp', 'subFilter', 'reserve'];

/** @param {any} doc @param {any} form pdf.form @param {{ hash: string | null, when: Date }} o */
export function createSigning(doc, form, o) {
  let used = false;
  /** @param {any} field @param {any} opt */
  return function sign(field, opt) {
    const who = 'pdf.sign';
    if (!o.hash) throw new TypeError(`${who}: create the PDF with { sign: true } (or { sign: { hash: 'SHA-384' } }): every byte is hashed as it streams out, from the first`);
    if (used) throw new Error(`${who}: one signature per document as it is created (more need an incremental update)`);
    if (opt == null || typeof opt !== 'object') throw new TypeError(`${who}: options are { signer, reason, location, contactInfo, name, date, certify, timestamp, subFilter, reserve }`);
    for (const k of Object.keys(opt)) if (!KEYS.includes(k)) throw new TypeError(`${who}: unknown option ${JSON.stringify(k.slice(0, 40))} (${KEYS.join(', ')})`);
    if (typeof opt.signer !== 'function') throw new TypeError(`${who}: signer is an async function ({ digest, hash, … }) → CMS bytes (nodeSigner and cmsSigner make one)`);
    if (opt.timestamp != null && typeof opt.timestamp !== 'function') throw new TypeError(`${who}: timestamp is an async function (signature value) → RFC 3161 TimeStampToken bytes`);
    const sf = opt.subFilter ?? 'ETSI.CAdES.detached';
    if (sf !== 'ETSI.CAdES.detached' && sf !== 'adbe.pkcs7.detached') throw new TypeError(`${who}: subFilter is 'ETSI.CAdES.detached' (PAdES, the default) or 'adbe.pkcs7.detached'`);
    const size = opt.reserve ?? DEFAULT_RESERVE;
    if (!(Number.isInteger(size) && size >= 1024 && size <= MAX_RESERVE)) throw new RangeError(`${who}: reserve (bytes for the CMS) is a whole number 1024–${MAX_RESERVE}`);
    const date = opt.date ?? o.when;
    if (!(date instanceof Date) || isNaN(+date)) throw new TypeError(`${who}: date is a valid Date`);
    const certify = opt.certify;
    if (certify != null && ![1, 2, 3].includes(certify)) throw new TypeError(`${who}: certify is 1 (no changes), 2 (form filling and signing) or 3 (also annotations)`);
    let s = '';
    for (const [k, key] of /** @type {const} */ ([['name', 'Name'], ['reason', 'Reason'], ['location', 'Location'], ['contactInfo', 'ContactInfo']])) {
      const v = opt[k];
      if (v == null) continue;
      if (typeof v !== 'string' || v.length > 4096) throw new TypeError(`${who}: ${k} is a string of at most 4096 characters`);
      s += ` /${key} ${text(v)}`;
    }
    // the field: a signature field handle, or { name, page, x, y, width, height, … } to make one
    let f;
    if (kindOf(field) === 'field') f = unbrand(field, 'field', doc, 'field');
    else if (field != null && typeof field === 'object' && typeof field.name === 'string') {
      const { name, ...rest } = field;
      f = unbrand(form.signature(name, rest), 'field', doc, 'field');
    } else throw new TypeError(`${who}: field is a signature field from pdf.form.signature, or { name, page, x, y, width, height } to make one`);
    if (f.kind !== 'signature') throw new TypeError(`${who}: ${JSON.stringify(f.full)} is not a signature field`);
    if (!f.ref || !f.sig) throw new TypeError(`${who}: a flattened form has no fields to sign`);
    if (f.sig.v) throw new Error(`${who}: that field is signed already`);

    used = true;
    const n = doc.reserve();
    f.sig.v = n;
    doc.sigFlags = 3; // SignaturesExist | AppendOnly
    const ref = certify ? ` /Reference [<< /Type /SigRef /TransformMethod /DocMDP /TransformParams << /Type /TransformParams /P ${certify} /V /1.2 >> >>]` : '';
    if (certify) doc.catalog('Perms', `<< /DocMDP ${n} 0 R >>`);
    const signer = opt.signer, timestamp = opt.timestamp;
    doc.last = {
      n, size,
      head: `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /${sf} ${BYTERANGE} /Contents `,
      after: ` /M ${pdfDate(date)}${s}${ref} >>`,
      /** @param {Uint8Array} digest */
      async sign(digest) {
        const cms = await raced(Promise.resolve().then(() => signer({ digest, hash: o.hash, subFilter: sf, date, timestamp: timestamp ?? undefined, signal: doc.signal })), doc.signal);
        if (cms instanceof Uint8Array && cms.length > size) throw new RangeError(`${who}: the signer's CMS is ${cms.length} bytes, more than the ${size} reserved: pass a larger reserve (at most ${MAX_RESERVE})`);
        checkContentInfo(cms, size, `${who}: the signer's CMS`);
        return cms;
      },
    };
    return Promise.resolve();
  };
}
