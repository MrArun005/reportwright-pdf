// @ts-check
/**
 * saveIncremental(): the original bytes, unchanged, then only the changed and new objects, a new cross-reference
 * section (an xref stream when the file uses them, else a classic table) with /Prev pointing at the last one, and a
 * trailer. So signatures already in the file stay valid: the bytes they cover are not touched (a viewer then says
 * the document was changed after signing, which is what happened).
 *
 * What it can change: filled fields (new values and appearances: reader/fill.js), Info entries, the XMP, page
 * rotation; and it can sign (sign: { field, signer, … }): a signature dictionary written last but for the
 * cross-reference, its /ByteRange over the WHOLE file (the original bytes included) but /Contents, the digest given
 * to group F's signer (security/cms.js nodeSigner or cmsSigner) and checked as group F checks it. Page edits (copies,
 * removals, overlays, flattening) need save(). An encrypted file's new objects are encrypted with its own key (AES
 * only: an RC4 file cannot be updated, as writing RC4 is refused).
 *
 * Active content (FAIL CLOSED): an update cannot remove bytes — the original objects stay, and a reader that rebuilds
 * the cross-reference, shows an earlier revision or follows /Prev reaches them again — so nothing is "stripped" here.
 * The whole file's bytes are checked first (reader/active.js: every object, every version, every object stream, with
 * save()'s allowlists); if anything is found, or the check cannot finish, the update is REFUSED (PdfReadError
 * E_ACTIVE) unless keepActiveContent: true, and the result lists what is present (activeContent). save() is the
 * way to remove it.
 *
 * Signatures already in the file (shadow attacks, Mainka et al., USENIX 2021: an update that changes what a signed
 * document shows while its signature stays valid) — an update a signer did not permit is REFUSED (E_SIGNED):
 * - DocMDP (a certification: the catalog's /Perms /DocMDP, or a signature's /Reference with /TransformMethod /DocMDP,
 *   or a field /Lock /P; the lowest /P wins): P 1 permits no update at all (a new signature is a change too); P 2
 *   and 3 permit filling fields and signing an existing empty signature field, never rotation, Info or XMP changes
 *   or a new signature field (a new widget). P 3's annotations are not something this update adds.
 * - FieldMDP (a signature's /Reference /TransformMethod /FieldMDP, or a signed field's /Lock: /Action /All,
 *   /Include or /Exclude with /Fields): a locked field is not filled; nor is a ReadOnly one (Ff bit 1).
 * - Signed without DocMDP: fields can be filled and new signatures added; rotation and Info/XMP changes are refused
 *   unless allowChangesAfterSigning: true (viewers then show the signature as "modified after signing").
 * - A fill's appearance is made from the file's own /Rect, /MK and /DA, so a planted widget can paint over the
 *   signed content (the "replace" shadow attack). HEURISTIC: a fill is refused when a widget it redraws covers more
 *   than 40% of its page, or more than 15% with an opaque /MK /BG background. A real field is far smaller.
 */
import { Ref, PdfString } from './lexer.js';
import { createCopier, hexText } from './copy.js';
import { findActive } from './active.js';
import { PdfReadError } from './budget.js';
import { fillReplacements, utf16 } from './fill.js';
import { decodeText } from './text.js';
import { BYTERANGE } from '../core/objects.js';
import { DEFAULT_RESERVE, MAX_RESERVE, TST_OID, has } from '../security/sign.js';
import { checkContentInfo } from '../security/cms.js';
import { hasher, HASHES, md5, hex, concat } from '../security/crypto.js';
import { pdfDate } from '../core/serialize.js';
import { latin1 as toLatin1 } from '../core/serialize.js';

const SIGN_KEYS = ['field', 'signer', 'reason', 'location', 'contactInfo', 'name', 'date', 'timestamp', 'subFilter', 'reserve', 'hash'];

/** @param {any} self @param {any} o */
export async function saveIncremental(self, o = {}) {
  const who = 'saveIncremental';
  if (o == null || typeof o !== 'object') throw new TypeError(`${who}: options are { sign, keepActiveContent }`);
  for (const k of Object.keys(o)) if (!['sign', 'keepActiveContent', 'allowChangesAfterSigning'].includes(k)) throw new TypeError(`${who}: unknown option ${JSON.stringify(k.slice(0, 40))} (sign, keepActiveContent, allowChangesAfterSigning)`);
  const src = self.r.src, R = src.resolve, pages = self.r.pages;
  if (self.plan.length !== pages.length || self.plan.some((/** @type {any} */ p, /** @type {number} */ i) => p.owner !== self || p.index !== i || p.draws.length || p.dropAnnots)) throw new TypeError(`${who}: copied, removed, moved or drawn-on pages and removed annotations need save() (a new file); an incremental update can fill fields, change the info, the XMP and page rotation, and sign`);
  if (self.edits.flatten) throw new TypeError(`${who}: flattening needs save() (a new file)`);
  if (src.recovered) throw new TypeError(`${who}: the file's cross-reference was broken and rebuilt; an update would point at it. Use save()`);
  const rootRef = src.trailer.get('Root');
  if (!(rootRef instanceof Ref)) throw new TypeError(`${who}: the catalog is not an indirect object`);
  const sec = src.security;
  if (sec && sec.algorithm === 'rc4') throw new TypeError(`${who}: this file is RC4-encrypted: reading it is allowed, writing RC4 is not. Use save() (with encrypt: { … } for AES)`);
  const sig = o.sign == null ? null : checkSign(o.sign, who);

  /** @type {string[]} */
  const warnings = [];
  let next = src.maxNum;
  /** @type {Map<number, { text: string, stream: Uint8Array | null, dict: Map<string, any> | null }>} objects written in the update */
  const out = new Map();
  const put = (/** @type {number} */ n, /** @type {string} */ text, /** @type {Uint8Array | null} */ stream = null, /** @type {Map<string, any> | null} */ dict = null) => { out.set(n, { text, stream, dict }); };
  const copier = createCopier({
    reserve: () => next++,
    write: async (n, dict, stream, d) => put(n, dict, stream, d),
    keepActive: true, compress: true, dedupe: true, report() {}, keepSignatures: true, // checked above: the file is clean or kept knowingly
    page: (owner, n) => (owner === self ? n : undefined), // the file's own objects are referred to, never copied
    keepStruct: () => true,
  });
  /** override object n with a value (its references kept) @param {number} n @param {any} v */
  const override = async (n, v) => put(n, await copier.text(self, v), null, v instanceof Map ? v : null);

  // active content: an update cannot remove bytes, so the whole file is checked first and the update REFUSED when it
  // has any (fail closed: an error while checking refuses too), unless the caller keeps it knowingly
  /** @type {{ what: string, count: number }[]} */
  let present;
  try { present = findActive(self); }
  catch (e) { throw new PdfReadError('E_ACTIVE', `${who}: the file could not be checked for active content (${/** @type {Error} */ (e).message}); use save() to rewrite the file without it (this invalidates existing signatures)`); }
  checkSigned(self, sig, !!o.allowChangesAfterSigning, who);
  if (present.length && !o.keepActiveContent) throw new PdfReadError('E_ACTIVE', `${who}: the file has active content (${present.map((p) => `${p.what} ×${p.count}`).join(', ')}), which an incremental update cannot remove (the original bytes stay). Use save() to rewrite the file without it (this invalidates existing signatures), or pass keepActiveContent: true to keep it knowingly`);
  // fills
  const fills = await fillReplacements(self, { pdfa: !!self.pdfa(), warn: (m) => warnings.push(m) });
  for (const [n, v] of fills) await override(n, v);
  // info
  const infoRef = src.trailer.get('Info');
  let info = infoRef;
  if (self.edits.info) {
    const I0 = R(infoRef);
    const I = new Map(I0 instanceof Map ? I0 : []);
    for (const [k, v] of Object.entries(self.edits.info)) { const K = k[0].toUpperCase() + k.slice(1); if (v == null) I.delete(K); else I.set(K, utf16(/** @type {string} */ (v))); }
    I.set('ModDate', new PdfString(toLatin1(pdfDate(new Date()).slice(1, -1).replace(/../g, (h) => String.fromCharCode(parseInt(h, 16)))), true));
    if (infoRef instanceof Ref) await override(infoRef.n, I);
    else { info = new Ref(next++, 0); await override(info.n, I); }
  }
  // the catalog, when it changes (XMP, a new AcroForm)
  let catalog = /** @type {Map<string, any> | null} */ (null);
  const cat = () => { if (!catalog) { const c = out.get(rootRef.n)?.dict ?? R(rootRef); catalog = new Map(c); } return catalog; };
  if (self.edits.xmp != null) {
    const m = next++;
    put(m, '<< /Type /Metadata /Subtype /XML >>', new TextEncoder().encode(self.edits.xmp), new Map([['Type', 'Metadata']]));
    cat().set('Metadata', new Ref(m, 0));
  }
  // rotation
  self.plan.forEach((/** @type {any} */ p, /** @type {number} */ i) => {
    if (p.rotate == null || p.rotate === self.boxes(i).rotation) return;
    if (pages[i].n < 0) throw new TypeError(`${who}: page ${i} is a direct object and cannot be updated`);
    const d = new Map(out.get(pages[i].n)?.dict ?? pages[i].dict);
    d.set('Rotate', p.rotate);
    out.set(pages[i].n, { text: '', stream: null, dict: d }); // written below
  });
  for (const [n, e] of out) if (!e.text && e.dict) await override(n, e.dict);

  // the signature: its field (new or an empty one), the AcroForm, the dictionary
  let sigN = 0;
  if (sig) {
    sigN = next++;
    const fields = self.fields();
    const af0 = R(cat().get('AcroForm'));
    const afRef = cat().get('AcroForm') instanceof Ref ? cat().get('AcroForm') : null;
    const af = new Map(af0 instanceof Map ? (afRef && out.get(afRef.n)?.dict) || af0 : []);
    af.set('SigFlags', 3);
    if (typeof sig.field === 'string') {
      const f = fields.find((/** @type {any} */ x) => x.name === sig.field);
      if (!f || f.type !== 'signature') throw new TypeError(`${who}: sign.field ${JSON.stringify(sig.field.slice(0, 200))} is not a signature field of this form`);
      if (f.value != null) throw new TypeError(`${who}: the field ${JSON.stringify(sig.field.slice(0, 200))} is signed already`);
      if (f.ref < 0) throw new TypeError(`${who}: that signature field is a direct object`);
      const fd = new Map(out.get(f.ref)?.dict ?? R(new Ref(f.ref, 0)));
      fd.set('V', new Ref(sigN, 0));
      await override(f.ref, fd);
    } else {
      const s = sig.field, i = s.page ?? 0;
      if (!Number.isInteger(i) || i < 0 || i >= pages.length) throw new RangeError(`${who}: sign.field.page is a page index 0–${pages.length - 1}`);
      if (fields.some((/** @type {any} */ x) => x.name === s.name)) throw new TypeError(`${who}: a field named ${JSON.stringify(s.name.slice(0, 200))} exists already`);
      const pg = pages[i];
      if (pg.n < 0) throw new TypeError(`${who}: page ${i} is a direct object and cannot be updated`);
      const b = self.boxes(i).mediaBox;
      const w = s.width ?? 0, h = s.height ?? 0, x = s.x ?? 0, y = s.y ?? 0;
      for (const v of [w, h, x, y]) if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 14400) throw new RangeError(`${who}: sign.field x, y, width and height are numbers`);
      const rect = w > 0 && h > 0 ? [b[0] + x, b[3] - y - h, b[0] + x + w, b[3] - y] : [0, 0, 0, 0];
      const wn = next++, apn = next++;
      put(apn, `<< /Type /XObject /Subtype /Form /BBox [0 0 ${Math.max(w, 0)} ${Math.max(h, 0)}] /Resources << >> >>`, new Uint8Array(0));
      put(wn, `<< /Type /Annot /Subtype /Widget /FT /Sig /T ${hexText(utf16(s.name).bytes)} /F 132 /Rect [${rect.join(' ')}] /P ${pg.n} 0 R /V ${sigN} 0 R /AP << /N ${apn} 0 R >> >>`, null, new Map());
      // the page's /Annots: its array object, or the page itself
      const pd = new Map(out.get(pg.n)?.dict ?? pg.dict);
      const ann = pd.get('Annots');
      if (ann instanceof Ref) { const arr = [...(R(ann) ?? []), new Ref(wn, 0)]; await override(ann.n, arr); }
      else { pd.set('Annots', [...(Array.isArray(ann) ? ann : []), new Ref(wn, 0)]); await override(pg.n, pd); }
      af.set('Fields', [...(Array.isArray(R(af.get('Fields'))) ? R(af.get('Fields')) : []), new Ref(wn, 0)]);
    }
    if (afRef) await override(afRef.n, af); else cat().set('AcroForm', af);
  }
  if (catalog) await override(rootRef.n, catalog);
  if (!out.size && !sig) return { bytes: src.bytes, size: src.bytes.length, activeContent: present, warnings: ['nothing changed'] };

  // ---- the update's bytes ----
  const B = src.bytes;
  /** @type {Uint8Array[]} */
  const parts = [B];
  let pos = B.length;
  const add = (/** @type {Uint8Array | string} */ x) => { const u = typeof x === 'string' ? toLatin1(x) : x; parts.push(u); pos += u.length; };
  if (B[B.length - 1] !== 10 && B[B.length - 1] !== 13) add('\n');
  /** @type {Map<number, [number, number]>} object → [offset, generation] */
  const at = new Map();
  for (const [n, e] of [...out].sort((a, b) => a[0] - b[0])) {
    const g = n < src.maxNum ? src.genOf(n) : 0;
    let text = e.text, stream = e.stream;
    if (sec) {
      if (stream) stream = await sec.encrypt(n, g, stream, true, e.dict);
      text = await sealStrings(text, (b) => sec.encrypt(n, g, b, false));
    }
    at.set(n, [pos, g]);
    if (stream) { add(`${n} ${g} obj\n${text.replace(/>>$/, `/Length ${stream.length} >>`)}\nstream\n`); add(stream); add('\nendstream\nendobj\n'); }
    else add(`${n} ${g} obj\n${text}\nendobj\n`);
  }
  // the signature dictionary, last but the cross-reference: /Contents' place is known, its value filled at the end
  let contentsAt = 0, size = 0;
  if (sig) {
    size = sig.reserve;
    let after = ` /M ${hexText(toLatin1(pdfDate(sig.date).slice(1, -1).replace(/../g, (h) => String.fromCharCode(parseInt(h, 16)))))}`;
    for (const [k, K] of [['name', 'Name'], ['reason', 'Reason'], ['location', 'Location'], ['contactInfo', 'ContactInfo']]) if (sig[k] != null) after += ` /${K} ${hexText(utf16(sig[k]).bytes)}`;
    if (sec) after = await sealStrings(after, (b) => sec.encrypt(sigN, 0, b, false));
    at.set(sigN, [pos, 0]);
    add(`${sigN} 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /${sig.subFilter} ${BYTERANGE} /Contents `);
    contentsAt = pos;
    add(`<${'0'.repeat(2 * size)}>`);
    add(`${after} >>\nendobj\n`);
  }
  // the cross-reference section
  const id0 = src.id ? src.id[0] : md5(B.subarray(0, Math.min(B.length, 1 << 20)));
  const id1 = md5(concat([id0, toLatin1(String(pos))]));
  const enc = src.trailer.get('Encrypt');
  const trailer = `/Root ${rootRef.n} ${rootRef.g} R${info instanceof Ref ? ` /Info ${info.n} ${info.g} R` : ''} /ID [<${hex(id0)}> <${hex(id1)}>]${enc instanceof Ref ? ` /Encrypt ${enc.n} ${enc.g} R` : ''} /Prev ${src.startxref}`;
  const xrefAt = pos;
  if (src.xrefIsStream) {
    const xn = next++;
    at.set(xn, [xrefAt, 0]);
    const nums = [...at.keys()].sort((a, b) => a - b);
    const index = [], rows = [];
    for (let i = 0; i < nums.length;) { let j = i; while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++; index.push(nums[i], j - i + 1); for (let k = i; k <= j; k++) rows.push(nums[k]); i = j + 1; }
    const data = new Uint8Array(rows.length * 7);
    rows.forEach((n, k) => { const [off, g] = /** @type {[number, number]} */ (at.get(n)); data.set([1, off >>> 24 & 255, off >>> 16 & 255, off >>> 8 & 255, off & 255, g >> 8, g & 255], k * 7); });
    add(`${xn} 0 obj\n<< /Type /XRef /Size ${next} /Index [${index.join(' ')}] /W [1 4 2] ${trailer} /Length ${data.length} >>\nstream\n`);
    add(data); add('\nendstream\nendobj\n');
  } else {
    const nums = [...at.keys()].sort((a, b) => a - b);
    let t = 'xref\n';
    for (let i = 0; i < nums.length;) {
      let j = i; while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      t += `${nums[i]} ${j - i + 1}\n`;
      for (let k = i; k <= j; k++) { const [off, g] = /** @type {[number, number]} */ (at.get(nums[k])); t += `${String(off).padStart(10, '0')} ${String(g).padStart(5, '0')} n\r\n`; }
      i = j + 1;
    }
    add(`${t}trailer\n<< /Size ${next} ${trailer} >>\n`);
  }
  add(`startxref\n${xrefAt}\n%%EOF\n`);
  let total = 0; for (const p of parts) total += p.length;
  const bytes = new Uint8Array(total);
  { let k = 0; for (const p of parts) { bytes.set(p, k); k += p.length; } }

  if (sig) {
    const a = contentsAt, b = contentsAt + 2 * size + 2, c = total - b;
    const range = `/ByteRange [0 ${a} ${b} ${c}]`.padEnd(BYTERANGE.length);
    const ph = bytes.subarray(0, a).lastIndexOf(0x2f /* / */);
    const brAt = indexOfBytes(bytes, toLatin1(BYTERANGE), Math.max(0, a - BYTERANGE.length - 200), a);
    if (brAt < 0 || ph < 0) throw new Error('internal: the /ByteRange placeholder was not found');
    bytes.set(toLatin1(range), brAt);
    const H = hasher(sig.hash);
    H.update(bytes.subarray(0, a)); H.update(bytes.subarray(b));
    const digest = await H.digest();
    const cms = await Promise.resolve().then(() => sig.signer({ digest, hash: sig.hash, subFilter: sig.subFilter, date: sig.date, timestamp: sig.timestamp ?? undefined }));
    checkContentInfo(cms, size, `${who}: the signer's CMS`);
    if (sig.timestamp && !has(cms, TST_OID)) throw new Error(`${who}: a timestamp was asked for but the signer's CMS has no id-aa-timeStampToken`);
    bytes.set(toLatin1(hex(cms).padEnd(2 * size, '0')), a + 1);
  }
  return { bytes, size: total, activeContent: present, warnings };
}

/** @param {Uint8Array} b @param {Uint8Array} n @param {number} from @param {number} to */
function indexOfBytes(b, n, from, to) {
  outer: for (let i = from; i + n.length <= to + n.length && i + n.length <= b.length; i++) { for (let j = 0; j < n.length; j++) if (b[i + j] !== n[j]) continue outer; return i; }
  return -1;
}

/** every hex string of a dictionary's text encrypted @param {string} t @param {(b: Uint8Array) => Promise<Uint8Array>} seal */
async function sealStrings(t, seal) {
  const outp = [];
  let k = 0;
  for (const m of t.matchAll(/(?<!<)<(?!<)([0-9A-Fa-f]*)>/g)) {
    const i = /** @type {number} */ (m.index);
    const raw = new Uint8Array(m[1].length >> 1);
    for (let j = 0; j < raw.length; j++) raw[j] = parseInt(m[1].slice(2 * j, 2 * j + 2), 16);
    outp.push(t.slice(k, i), hexText(await seal(raw)));
    k = i + m[0].length;
  }
  outp.push(t.slice(k));
  return outp.join('');
}

/** @param {any} s @param {string} who */
function checkSign(s, who) {
  if (typeof s !== 'object') throw new TypeError(`${who}: sign is { field, signer, … }`);
  for (const k of Object.keys(s)) if (!SIGN_KEYS.includes(k)) throw new TypeError(`${who}: sign: unknown option ${JSON.stringify(k.slice(0, 40))} (${SIGN_KEYS.join(', ')})`);
  if (typeof s.signer !== 'function') throw new TypeError(`${who}: sign.signer is an async function ({ digest, hash, … }) → CMS bytes (nodeSigner and cmsSigner make one)`);
  if (s.timestamp != null && typeof s.timestamp !== 'function') throw new TypeError(`${who}: sign.timestamp is an async function`);
  const f = s.field;
  if (typeof f !== 'string' && !(f && typeof f === 'object' && typeof f.name === 'string' && f.name && f.name.length <= 256 && !f.name.includes('.'))) throw new TypeError(`${who}: sign.field is the name of an empty signature field, or { name, page, x, y, width, height } for a new one (no '.' in the name)`);
  const subFilter = s.subFilter ?? 'ETSI.CAdES.detached';
  if (subFilter !== 'ETSI.CAdES.detached' && subFilter !== 'adbe.pkcs7.detached') throw new TypeError(`${who}: sign.subFilter is 'ETSI.CAdES.detached' or 'adbe.pkcs7.detached'`);
  const reserve = s.reserve ?? DEFAULT_RESERVE;
  if (!(Number.isInteger(reserve) && reserve >= 1024 && reserve <= MAX_RESERVE)) throw new RangeError(`${who}: sign.reserve is a whole number 1024–${MAX_RESERVE}`);
  const hash = s.hash ?? 'SHA-256';
  if (!HASHES.includes(hash)) throw new TypeError(`${who}: sign.hash is ${HASHES.join(', ')}`);
  const date = s.date ?? new Date();
  if (!(date instanceof Date) || isNaN(+date)) throw new TypeError(`${who}: sign.date is a valid Date`);
  for (const k of ['name', 'reason', 'location', 'contactInfo']) if (s[k] != null && (typeof s[k] !== 'string' || s[k].length > 4096)) throw new TypeError(`${who}: sign.${k} is a string of at most 4096 characters`);
  return { ...s, subFilter, reserve, hash, date };
}

/** the most a filled widget may cover of its page, and with an opaque background (/MK /BG): see the header */
export const MAX_WIDGET_SHARE = 0.4, MAX_OPAQUE_SHARE = 0.15;

/**
 * What the file's signatures permit, checked against this update (E_SIGNED when not). @param {any} self
 * @param {any} sig the new signature, or null @param {boolean} allow allowChangesAfterSigning @param {string} who
 */
function checkSigned(self, sig, allow, who) {
  const src = self.r.src, R = src.resolve;
  const fields = self.fields();
  const signed = fields.filter((/** @type {any} */ f) => f.type === 'signature' && R(f.inh.V) instanceof Map);
  if (!signed.length) return;
  let P = /** @type {number | null} */ (null);
  const lowest = (/** @type {any} */ p) => { const v = R(p); const n = v == null ? 2 : Number.isInteger(v) && v >= 1 && v <= 3 ? v : 1; P = P == null ? n : Math.min(P, n); }; // a /P that is not 1–3: the strictest
  /** @type {Set<string>} */
  const locked = new Set();
  let lockAll = false;
  const all = fields.map((/** @type {any} */ f) => f.name);
  const lock = (/** @type {any} */ d) => {
    if (!(d instanceof Map)) return;
    const action = R(d.get('Action')), list = R(d.get('Fields'));
    const names = new Set(Array.isArray(list) ? list.slice(0, 100_000).map((x) => decodeText(R(x))) : []);
    if (action === 'All') lockAll = true;
    else if (action === 'Include') for (const n of names) locked.add(n);
    else if (action === 'Exclude') { for (const n of all) if (!names.has(n)) locked.add(n); }
    else if (action != null) lockAll = true; // an action we do not know: everything
  };
  /** a signature dictionary's /Reference entries @param {any} v */
  const refs = (v) => {
    const list = R(v instanceof Map ? v.get('Reference') : null);
    for (const r0 of Array.isArray(list) ? list.slice(0, 1000) : []) {
      const r = R(r0);
      if (!(r instanceof Map)) continue;
      const m = R(r.get('TransformMethod')), tp = R(r.get('TransformParams'));
      if (m === 'DocMDP') lowest(tp instanceof Map ? tp.get('P') : null);
      else if (m === 'FieldMDP') lock(tp);
    }
  };
  for (const f of signed) {
    refs(R(f.inh.V));
    const fd = f.ref >= 0 ? R(new Ref(f.ref, 0)) : null;
    const lk = fd instanceof Map ? R(fd.get('Lock')) : null;
    if (lk instanceof Map) { lock(lk); if (lk.has('P')) lowest(lk.get('P')); }
  }
  const perms = R(self.r.root.get('Perms'));
  if (perms instanceof Map && perms.has('DocMDP')) { const d = R(perms.get('DocMDP')); if (d instanceof Map) refs(d); else lowest(1); } // a /DocMDP that cannot be read: the strictest
  const refuse = (/** @type {string} */ m) => { throw new PdfReadError('E_SIGNED', `${who}: ${m}`); };
  const fills = [...self.edits.fills.keys()];
  const rotated = self.plan.some((/** @type {any} */ p, /** @type {number} */ i) => p.rotate != null && p.rotate !== self.boxes(i).rotation);
  const other = [self.edits.info && 'the Info', self.edits.xmp != null && 'the XMP', rotated && 'page rotation'].filter(Boolean);
  if (P === 1 && (fills.length || other.length || sig)) refuse('the document is certified with no changes permitted (DocMDP P 1): no update, not even a new signature, keeps its certification. A new file (save()) invalidates it');
  if (P != null) {
    if (other.length) refuse(`the document is certified (DocMDP P ${P}), which permits filling fields and signing only, not changes to ${other.join(', ')}`);
    if (sig && typeof sig.field !== 'string') refuse(`the document is certified (DocMDP P ${P}): sign an existing empty signature field; a new field (a new widget) is not a permitted change`);
  } else if (other.length && !allow) refuse(`the document is signed: changing ${other.join(', ')} after signing shows as a modification; pass allowChangesAfterSigning: true to do it knowingly`);
  const byName = new Map(fields.map((/** @type {any} */ f) => [f.name, f]));
  for (const name of fills) {
    const f = byName.get(name);
    if (!f) continue;
    if (lockAll || locked.has(name)) refuse(`the field ${JSON.stringify(name.slice(0, 200))} is locked by a signature (FieldMDP)`);
    if (f.readOnly) refuse(`the field ${JSON.stringify(name.slice(0, 200))} is read-only`);
    for (const w of f.widgets) {
      const wd = w.ref >= 0 ? R(new Ref(w.ref, 0)) : null;
      if (!w.rect || !(wd instanceof Map)) continue;
      let pg = w.page;
      if (pg == null) pg = self.r.pages.findIndex((/** @type {any} */ p) => { const a = R(p.dict.get('Annots')); return Array.isArray(a) && a.some((x) => x instanceof Ref && x.n === w.ref); });
      const mb = self.boxes(Math.max(0, pg ?? 0)).mediaBox;
      const page = (mb[2] - mb[0]) * (mb[3] - mb[1]);
      const ix = Math.max(0, Math.min(w.rect[2], mb[2]) - Math.max(w.rect[0], mb[0])), iy = Math.max(0, Math.min(w.rect[3], mb[3]) - Math.max(w.rect[1], mb[1]));
      const share = page > 0 ? (ix * iy) / page : 1;
      const mk = R(wd.get('MK')), bg = mk instanceof Map ? R(mk.get('BG')) : null;
      const opaque = Array.isArray(bg) && bg.length > 0;
      if (share > MAX_WIDGET_SHARE || (opaque && share > MAX_OPAQUE_SHARE)) refuse(`the field ${JSON.stringify(name.slice(0, 200))} has a widget covering ${Math.round(share * 100)}% of its page${opaque ? ' with an opaque background' : ''}: filling it in a signed document could paint over the signed content (a shadow attack)`);
    }
  }
}
