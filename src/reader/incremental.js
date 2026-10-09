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
 * document shows while its signature stays valid). The policy is read from EVERY version of every object and FAILS
 * CLOSED (anything unreadable or unknown refuses, E_SIGNED); the strictest source wins:
 * - DocMDP (the catalog's /Perms /DocMDP and every signature's /Reference /TransformMethod /DocMDP, a field /Lock
 *   /P; no /P is 2, the default): P 1 permits no update at all, not even a new signature; P 2 and 3 permit filling
 *   fields and signing (an existing empty signature field or a new one), never rotation, Info or XMP changes.
 * - FieldMDP (every signature's /Reference /FieldMDP and every signed field's /Lock: /All, /Include, /Exclude, a
 *   listed parent locking its kids): a locked field is not filled; nor a read-only one (Ff bit 1 on it or any parent).
 * - SECURE DEFAULT: on a signed document a fill is refused unless allowFillAfterSigning: true (viewers then show the
 *   signature as "changed after signing"; refilling the widgets a file already has is the shadow-attack class, since
 *   the new appearance is built from the file's own /Rect, /MK and /DA). With it, defence in depth: the widgets one
 *   update refills may cover at most 40% of a page IN SUM (an overlay split into many small fields counts whole), and
 *   a widget with an opaque /MK /BG may not lie over the page's text.
 * - Without DocMDP, rotation and Info/XMP changes need allowChangesAfterSigning: true.
 */
import { Ref, PdfString, PdfStream } from './lexer.js';
import { createCopier, hexText } from './copy.js';
import { findActive } from './active.js';
import { PdfReadError } from './budget.js';
import { fillReplacements, utf16 } from './fill.js';
import { decodeText, textPieces } from './text.js';
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
  for (const k of Object.keys(o)) if (!['sign', 'keepActiveContent', 'allowChangesAfterSigning', 'allowFillAfterSigning'].includes(k)) throw new TypeError(`${who}: unknown option ${JSON.stringify(k.slice(0, 40))} (sign, keepActiveContent, allowChangesAfterSigning, allowFillAfterSigning)`);
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
  /** @type {[number, any][]} every object read, every version (the signature policy reads them) */
  const objects = [];
  try { present = findActive(self, (n, v) => { const d = v instanceof PdfStream ? v.dict : v; if (d instanceof Map && (d.has('ByteRange') || d.has('Perms') || d.has('Lock') || R(d.get('FT')) === 'Sig' || d.has('V') || nestedSigs(d).length)) objects.push([n, v]); }); }
  catch (e) { throw new PdfReadError('E_ACTIVE', `${who}: the file could not be checked for active content (${/** @type {Error} */ (e).message}); use save() to rewrite the file without it (this invalidates existing signatures)`); }
  checkSigned(self, sig, o, objects, who);
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

/** the most the widgets one update refills may cover of a page, summed (allowFillAfterSigning only): see the header */
export const MAX_WIDGET_SHARE = 0.4;
const TRANSFORMS = new Set(['DocMDP', 'FieldMDP', 'UR', 'UR3']);

/**
 * The file's signature policy, read from EVERY version of every object (a later revision cannot hide an earlier
 * certification) and FAIL CLOSED: anything that cannot be read or understood refuses the update.
 * @param {any} self @param {[number, any][]} objects every object read by the whole-file check
 */
/** a signature dictionary: /ByteRange with /Contents, /Type or /Filter (some writers omit /Type) @param {any} d */
const isSigDict = (d) => d instanceof Map && d.has('ByteRange') && (d.has('Contents') || d.has('Type') || d.has('Filter'));
/**
 * every signature dictionary written directly inside v (indirect ones are objects of their own, judged as such), at any
 * depth: a bounded walk with no recursion (fail closed: past the bound it refuses)
 * @param {any} v @returns {Map<string, any>[]}
 */
function nestedSigs(v) {
  const out = [], stack = [], seen = new Set();
  for (const x of v instanceof Map ? v.values() : Array.isArray(v) ? v : []) stack.push([x, 1]);
  let steps = 0;
  while (stack.length) {
    const [x, depth] = /** @type {[any, number]} */ (stack.pop());
    if (!(x instanceof Map) && !Array.isArray(x)) continue;
    if (seen.has(x)) continue;
    seen.add(x);
    if (++steps > 100000 || depth > 64) throw new PdfReadError('E_SIGNED', 'saveIncremental: an object is too deep or too large to check for signatures; refused');
    if (isSigDict(x)) out.push(x);
    for (const y of x instanceof Map ? x.values() : x) stack.push([y, depth + 1]);
  }
  return out;
}

function readPolicy(self, objects) {
  const R = self.r.src.resolve;
  const bad = (/** @type {string} */ m) => { throw new PdfReadError('E_SIGNED', `saveIncremental: the document's signature policy cannot be read (${m}); refused`); };
  /** @type {number | null} */
  let P = null;
  let lockAll = false, signed = false;
  /** @type {Set<string>} */
  const include = new Set();
  /** @type {Set<string>[]} each /Exclude's names */
  const excludes = [];
  const pOf = (/** @type {any} */ v, /** @type {string} */ where) => {
    const p = R(v);
    if (p === undefined || p === null) return 2; // the spec's default
    if (!Number.isInteger(p) || p < 1 || p > 3) bad(`${where} /P is not 1, 2 or 3`);
    return p;
  };
  const docMDP = (/** @type {number} */ p) => { P = P == null ? p : Math.min(P, p); };
  const names = (/** @type {any} */ v, /** @type {string} */ where) => {
    const a = R(v);
    if (!Array.isArray(a) || a.length > 100_000) bad(`${where} /Fields is not an array`);
    return new Set(a.map((x) => { const t = R(x); if (!(t instanceof PdfString)) bad(`${where} /Fields holds something other than text`); return decodeText(t); }));
  };
  const lock = (/** @type {any} */ d, /** @type {string} */ where) => {
    if (!(d instanceof Map)) bad(`${where} is not a dictionary`);
    const action = R(d.get('Action'));
    if (action === 'All') lockAll = true;
    else if (action === 'Include') for (const n of names(d.get('Fields'), where)) include.add(n);
    else if (action === 'Exclude') excludes.push(names(d.get('Fields'), where));
    else bad(`${where} /Action is not /All, /Include or /Exclude`);
  };
  const reference = (/** @type {any} */ sd) => {
    if (!sd.has('Reference')) return;
    const list = R(sd.get('Reference'));
    if (!Array.isArray(list) || list.length > 1000) bad('a signature\'s /Reference is not an array');
    for (const r0 of list) {
      const r = R(r0);
      if (!(r instanceof Map)) bad('a signature reference is not a dictionary');
      const m = R(r.get('TransformMethod'));
      if (!TRANSFORMS.has(m)) bad(`a signature reference has an unknown /TransformMethod`);
      const tp = R(r.get('TransformParams'));
      if (m === 'DocMDP') { if (tp != null && !(tp instanceof Map)) bad('DocMDP /TransformParams is not a dictionary'); docMDP(pOf(tp instanceof Map ? tp.get('P') : null, 'DocMDP')); }
      else if (m === 'FieldMDP') lock(tp, 'FieldMDP /TransformParams');
    }
  };
  const rootN = self.r.src.trailer.get('Root')?.n;
  /** @type {Set<number>} */
  const sigFields = new Set();
  for (const f of self.fields()) if (f.type === 'signature' && f.ref >= 0) sigFields.add(f.ref);
  /** @type {Map<number, any[]>} every version of each signature field */
  const fieldVersions = new Map();
  for (const [n, v0] of objects) {
    const v = v0 instanceof PdfStream ? v0.dict : v0;
    if (!(v instanceof Map)) continue;
    if (v.has('ByteRange') && (v.has('Contents') || R(v.get('Type')) === 'Sig')) { signed = true; reference(v); } // a signature, in any version
    if (n === rootN && v.has('Perms')) { // a catalog's /Perms, in any version
      const pm = R(v.get('Perms'));
      if (!(pm instanceof Map)) bad('the catalog /Perms is not a dictionary');
      if (pm.has('DocMDP')) {
        const d = R(pm.get('DocMDP'));
        if (!(d instanceof Map)) bad('the catalog /Perms /DocMDP is not a signature dictionary');
        signed = true;
        const before = P;
        reference(d);
        if (P === before && before == null) docMDP(2); // a certification with no DocMDP reference: the default
      }
    }
    if (sigFields.has(n) || (R(v.get('FT')) === 'Sig' && v.has('Lock'))) { const l = fieldVersions.get(n) ?? []; l.push(v); fieldVersions.set(n, l); }
    // a signature dictionary written DIRECTLY inside another object (a field's /V, whatever its /FT or a parent's;
    // or nested deeper) is not a top-level object: find every one, in every version (fail closed: a match counts)
    for (const sd of nestedSigs(v)) { signed = true; reference(sd); }
    { const sv = v.get('V'); if (sv != null && !(sv instanceof Map)) { const r = R(sv); if (r instanceof Map && isSigDict(r)) { signed = true; reference(r); } } }
  }
  // belt and braces: whatever the reader lists as a signature makes the document signed
  if (self.signatures().length) signed = true;
  // a signature field's /Lock: applies once it is signed (any version holding a /V)
  for (const [, versions] of fieldVersions) {
    if (!versions.some((v) => v.has('V'))) continue;
    for (const v of versions) if (v.has('Lock')) { const lk = R(v.get('Lock')); lock(lk, 'a signature field /Lock'); if (lk.has('P')) docMDP(pOf(lk.get('P'), 'a /Lock')); }
  }
  /** a full field name is locked: listed (or a parent of it is), or not excluded @param {string} name */
  const locked = (name) => {
    const under = (/** @type {Set<string>} */ set) => { for (const x of set) if (name === x || name.startsWith(`${x}.`)) return true; return false; };
    return lockAll || under(include) || excludes.some((ex) => !under(ex));
  };
  return { signed, P, locked };
}

/**
 * What the file's signatures permit, checked against this update (E_SIGNED when not). @param {any} self
 * @param {any} sig the new signature, or null @param {{ allowChangesAfterSigning?: boolean, allowFillAfterSigning?: boolean }} o
 * @param {[number, any][]} objects every object read @param {string} who
 */
function checkSigned(self, sig, o, objects, who) {
  const pol = readPolicy(self, objects);
  if (!pol.signed) return;
  const R = self.r.src.resolve, P = pol.P;
  const refuse = (/** @type {string} */ m) => { throw new PdfReadError('E_SIGNED', `${who}: ${m}`); };
  const fills = [...self.edits.fills.keys()];
  const rotated = self.plan.some((/** @type {any} */ p, /** @type {number} */ i) => p.rotate != null && p.rotate !== self.boxes(i).rotation);
  const other = [self.edits.info && 'the Info', self.edits.xmp != null && 'the XMP', rotated && 'page rotation'].filter(Boolean);
  if (P === 1 && (fills.length || other.length || sig)) refuse('the document is certified with no changes permitted (DocMDP P 1): no update, not even a new signature, keeps its certification. A new file (save()) invalidates it');
  if (P != null && other.length) refuse(`the document is certified (DocMDP P ${P}), which permits filling fields and signing only, not changes to ${other.join(', ')}`);
  if (P == null && other.length && !o.allowChangesAfterSigning) refuse(`the document is signed: changing ${other.join(', ')} after signing shows as a modification; pass allowChangesAfterSigning: true to do it knowingly`);
  if (!fills.length) return;
  if (!o.allowFillAfterSigning) refuse('the document is signed: filling its fields after signing shows as "changed after signing", and refilling widgets the file already has is how shadow attacks change what a signed document shows. Pass allowFillAfterSigning: true to fill knowingly');
  const byName = new Map(self.fields().map((/** @type {any} */ f) => [f.name, f]));
  /** @type {Map<number, number>} page → the area the refilled widgets cover */
  const covered = new Map();
  /** @type {Map<number, any[]>} */
  const pieces = new Map();
  for (const name of fills) {
    const f = byName.get(name);
    if (!f) continue;
    if (pol.locked(name)) refuse(`the field ${JSON.stringify(name.slice(0, 200))} is locked by a signature (FieldMDP)`);
    if (f.readOnly || f.inh.ReadOnlyAny) refuse(`the field ${JSON.stringify(name.slice(0, 200))} is read-only`);
    for (const w of f.widgets) {
      const wd = w.ref >= 0 ? R(new Ref(w.ref, 0)) : null;
      if (!(wd instanceof Map)) continue;
      if (!w.rect) refuse(`the field ${JSON.stringify(name.slice(0, 200))} has a widget without a usable /Rect`);
      let pg = w.page;
      if (pg == null) pg = self.r.pages.findIndex((/** @type {any} */ p) => { const a = R(p.dict.get('Annots')); return Array.isArray(a) && a.some((x) => x instanceof Ref && x.n === w.ref); });
      pg = Math.max(0, pg ?? 0);
      const mb = self.boxes(pg).mediaBox;
      const ix = Math.max(0, Math.min(w.rect[2], mb[2]) - Math.max(w.rect[0], mb[0])), iy = Math.max(0, Math.min(w.rect[3], mb[3]) - Math.max(w.rect[1], mb[1]));
      covered.set(pg, (covered.get(pg) ?? 0) + ix * iy); // summed: an overlay split into many small fields counts whole
      const page = (mb[2] - mb[0]) * (mb[3] - mb[1]);
      if (!(page > 0) || /** @type {number} */ (covered.get(pg)) / page > MAX_WIDGET_SHARE) refuse(`the fields filled cover more than ${MAX_WIDGET_SHARE * 100}% of page ${pg}: refilling them in a signed document could paint over the signed content (a shadow attack)`);
      const mk = R(wd.get('MK')), bg = mk instanceof Map ? R(mk.get('BG')) : null;
      if (Array.isArray(bg) && bg.length) { // an opaque background over the page's own text hides it
        if (!pieces.has(pg)) { const p = self.r.pages[pg]; pieces.set(pg, textPieces(self.r.src, p.dict, R(p.inh.Resources))); }
        const r = w.rect;
        if (/** @type {any[]} */ (pieces.get(pg)).some((t) => t.end > r[0] && t.x < r[2] && t.y + t.size * 0.8 > r[1] && t.y - t.size * 0.2 < r[3])) refuse(`the field ${JSON.stringify(name.slice(0, 200))} has an opaque background over the page's signed text: refilling it could hide that text (a shadow attack)`);
      }
    }
  }
}
