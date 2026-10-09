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
 * Active content: unless keepActiveContent, every object in the file that carries /AA, /JS or an active action (or the
 * catalog's /OpenAction, the /Names /JavaScript tree) is overridden in the update by a copy without it (an active
 * action object by null), and reported.
 */
import { Ref, PdfString } from './lexer.js';
import { createCopier, activeReason, hexText } from './copy.js';
import { fillReplacements, utf16 } from './fill.js';
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
  for (const k of Object.keys(o)) if (k !== 'sign' && k !== 'keepActiveContent') throw new TypeError(`${who}: unknown option ${JSON.stringify(k.slice(0, 40))} (sign, keepActiveContent)`);
  const src = self.r.src, R = src.resolve, pages = self.r.pages;
  if (self.plan.length !== pages.length || self.plan.some((/** @type {any} */ p, /** @type {number} */ i) => p.owner !== self || p.index !== i || p.draws.length || p.dropAnnots)) throw new TypeError(`${who}: copied, removed, moved or drawn-on pages and removed annotations need save() (a new file); an incremental update can fill fields, change the info, the XMP and page rotation, and sign`);
  if (self.edits.flatten) throw new TypeError(`${who}: flattening needs save() (a new file)`);
  if (src.recovered) throw new TypeError(`${who}: the file's cross-reference was broken and rebuilt; an update would point at it. Use save()`);
  const rootRef = src.trailer.get('Root');
  if (!(rootRef instanceof Ref)) throw new TypeError(`${who}: the catalog is not an indirect object`);
  const sec = src.security;
  if (sec && sec.algorithm === 'rc4') throw new TypeError(`${who}: this file is RC4-encrypted: reading it is allowed, writing RC4 is not. Use save() (with encrypt: { … } for AES)`);
  const sig = o.sign == null ? null : checkSign(o.sign, who);

  /** @type {Map<string, number>} */
  const stripped = new Map();
  const report = (/** @type {string} */ w) => stripped.set(w, (stripped.get(w) ?? 0) + 1);
  /** @type {string[]} */
  const warnings = [];
  let next = src.maxNum;
  /** @type {Map<number, { text: string, stream: Uint8Array | null, dict: Map<string, any> | null }>} objects written in the update */
  const out = new Map();
  const put = (/** @type {number} */ n, /** @type {string} */ text, /** @type {Uint8Array | null} */ stream = null, /** @type {Map<string, any> | null} */ dict = null) => { out.set(n, { text, stream, dict }); };
  const copier = createCopier({
    reserve: () => next++,
    write: async (n, dict, stream, d) => put(n, dict, stream, d),
    keepActive: !!o.keepActiveContent, compress: true, dedupe: true, report, keepSignatures: true,
    page: (owner, n) => (owner === self ? n : undefined), // the file's own objects are referred to, never copied
    keepStruct: () => true,
  });
  /** override object n with a value (its references kept) @param {number} n @param {any} v */
  const override = async (n, v) => put(n, await copier.text(self, v), null, v instanceof Map ? v : null);

  // active content in the file: overridden without it
  if (!o.keepActiveContent) {
    for (const n of src.numbers()) {
      const v = src.get(n);
      if (!(v instanceof Map)) continue;
      if (activeReason(v, R)) { report(activeReason(v, R)); put(n, 'null'); continue; }
      if (hasActive(v, R)) await override(n, n === rootRef.n ? withoutDocScripts(v, R, report) : v);
    }
  }
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
  if (!out.size && !sig) return { bytes: src.bytes, size: src.bytes.length, stripped: [], warnings: ['nothing changed'] };

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
  return { bytes, size: total, stripped: [...stripped].map(([what, count]) => ({ what, count })), warnings };
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

/** a dictionary (or one directly inside it) carries /AA, /JS or an active action, or document JavaScript @param {Map<string, any>} v @param {(v: any) => any} R */
function hasActive(v, R) {
  const stack = [v];
  for (let k = 0; stack.length && k < 100_000; k++) {
    const x = stack.pop();
    if (Array.isArray(x)) { for (const y of x) if (y instanceof Map || Array.isArray(y)) stack.push(y); continue; }
    if (!(x instanceof Map)) continue;
    if (x.has('AA') || x.has('JS') || (x !== v && activeReason(x, R))) return true;
    if (x.has('JavaScript') && x !== v) return true;
    const oa = R(x.get('OpenAction'));
    if (oa instanceof Map && activeReason(oa, R)) return true;
    for (const y of x.values()) if (y instanceof Map || Array.isArray(y)) stack.push(y);
  }
  const nm = R(v.get('Names'));
  return v.get('Type') === 'Catalog' && nm instanceof Map && nm.has('JavaScript');
}
/** the catalog without document scripts (the /Names /JavaScript tree, a script /OpenAction) @param {Map<string, any>} c @param {(v: any) => any} R @param {(w: string) => void} report */
function withoutDocScripts(c, R, report) {
  const d = new Map(c);
  const nm = R(d.get('Names'));
  if (nm instanceof Map && nm.has('JavaScript')) { const n2 = new Map(nm); n2.delete('JavaScript'); d.set('Names', n2); report('document JavaScript (/Names /JavaScript)'); }
  const oa = R(d.get('OpenAction'));
  if (oa instanceof Map && activeReason(oa, R)) { d.delete('OpenAction'); report(`${activeReason(oa, R)} (/OpenAction)`); }
  return d;
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
