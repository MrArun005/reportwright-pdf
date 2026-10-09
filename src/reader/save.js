// @ts-check
/**
 * save(): the plan written as a NEW file through the writer (createPdf): a full rewrite. Pages are written as they are
 * copied (the writer streams; each page's objects go out with it), and source objects are read lazily. Each output page
 * is a writer page whose dictionary is the source page's (reader/copy.js copies what it refers to, de-duplicated across
 * documents), its inherited MediaBox, CropBox, Rotate and Resources made explicit. Drawing on a page (page.draw) and
 * flattening a form add form XObjects after the page's own content, which is wrapped in q … Q (with a Q for each q the
 * content leaves open), so the old content's graphics state cannot change what is drawn on top.
 *
 * Document level, from the first document (the one save() is called on), with what merged documents bring: the form
 * (every contributing document's fields; /DR fonts merged; no XFA, no signatures' values), the outline (each document's,
 * remapped to the new pages; entries to pages not copied lose their destination), embedded files (merged into one
 * tree), the structure tree (only when every page comes from the first document), page labels (only when the pages are
 * unchanged), layers, viewer preferences, the open action (a page destination only), PDF/A: kept when every document
 * declares the same level and output intent (the output intent's profile, the XMP and the identification are kept;
 * overlays obey the writer's PDF/A rules), else dropped with a warning.
 *
 * Active content is stripped unless keepActiveContent (reader/copy.js); the result reports what was.
 */
import { createPdf } from '../index.js';
import { Page } from '../page.js';
import { appearance } from '../annotations/annot.js';
import { writeTree, setNames } from '../nav/trees.js';
import { parseIcc } from '../standards/icc.js';
import { Ref, PdfStream, Lexer, parseValue, Op, latin1 } from './lexer.js';
import { createCopier, nameText, numText, hexText, Foreign, refuseFile, refuseAnnot } from './copy.js';
import { fillReplacements } from './fill.js';
import { flatTree, rectOf, pageAt } from './pdf.js';
import { contentBytes } from './text.js';
import { PdfReadError } from './budget.js';

/** graphics states a page's content may leave open and still be drawn on (each needs a Q: the count comes from the file) */
export const MAX_OPEN = 256;
const KEYS = ['compress', 'keepActiveContent', 'encrypt', 'pdfa', 'creationDate', 'signal', 'timeoutMs', 'keepStructure'];
/** page keys written from the plan, or never copied */
const OWN = new Set(['Type', 'Parent', 'Contents', 'Resources', 'Annots', 'MediaBox', 'CropBox', 'Rotate', 'B']);

/** the unbalanced q's a content stream leaves open (operators only: strings and inline images skipped) @param {Uint8Array} data @param {any} budget */
export function openSaves(data, budget) {
  const lx = new Lexer(data, budget);
  let depth = 0;
  for (;;) {
    const v = parseValue(lx);
    if (v === undefined) break;
    if (!(v instanceof Op)) continue;
    if (v.v === 'q') depth++;
    else if (v.v === 'Q') depth = Math.max(0, depth - 1);
    else if (v.v === 'BI') { for (let k = 0; k < 4096; k++) { const t = parseValue(lx); if (t === undefined || (t instanceof Op && t.v === 'ID')) break; } const e = latin1(data.subarray(lx.pos)).search(/\sEI(\s|$)/); lx.pos = e < 0 ? data.length : lx.pos + e + 3; }
  }
  return depth;
}

/** @param {any} self @param {any} o */
function options(self, o = {}) {
  if (o == null || typeof o !== 'object') throw new TypeError(`save: options are { ${KEYS.join(', ')} }`);
  for (const k of Object.keys(o)) if (!KEYS.includes(k)) throw new TypeError(`save: unknown option ${JSON.stringify(k.slice(0, 40))} (${KEYS.join(', ')})`);
  if (o.pdfa != null && o.pdfa !== false && o.pdfa !== 'keep') throw new TypeError('save: pdfa is \'keep\' (the default: kept when every document declares the same level) or false');
  return o;
}

/** A new file in memory: { bytes, pages, stripped, warnings }. @param {any} self @param {any} [o] */
export async function save(self, o) {
  /** @type {Uint8Array[]} */
  const parts = [];
  let n = 0;
  const r = await run(self, { write(/** @type {Uint8Array} */ b) { parts.push(b); n += b.length; } }, options(self, o));
  const bytes = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { bytes.set(p, at); at += p.length; }
  return { bytes, ...r };
}
/** A new file into a sink: { size, pages, stripped, warnings }. @param {any} self @param {any} sink @param {any} [o] */
export async function saveTo(self, sink, o) { return run(self, sink, options(self, o)); }

/** @param {any} self @param {any} sink @param {any} o */
async function run(self, sink, o) {
  const plan = self.plan;
  /** @type {Map<string, number>} */
  const stripped = new Map();
  /** @type {string[]} */
  const warnings = [];
  const warn = (/** @type {string} */ m) => { if (!warnings.includes(m) && warnings.length < 200) warnings.push(m); };
  const report = (/** @type {string} */ w) => stripped.set(w, (stripped.get(w) ?? 0) + 1);
  const owners = [...new Set(plan.map((/** @type {any} */ p) => p.owner))];
  if (!owners.includes(self)) owners.unshift(self);
  const single = owners.length === 1;
  const R = self.r.src.resolve;

  // PDF/A: kept when every document declares the same level and output intent profile
  const intentOf = (/** @type {any} */ d) => {
    const ois = d.r.src.resolve(d.r.root.get('OutputIntents'));
    const oi = Array.isArray(ois) ? d.r.src.resolve(ois[0]) : null;
    const prof = oi instanceof Map ? d.r.src.resolve(oi.get('DestOutputProfile')) : null;
    return prof instanceof PdfStream ? d.r.src.decodeStream(prof).data : null;
  };
  let level = o.pdfa === false ? null : self.pdfa();
  let profile = null;
  if (level) {
    profile = intentOf(self);
    for (const d of owners) {
      const l = d.pdfa(), p = d === self ? profile : intentOf(d);
      if (!l || l.part !== level.part || l.conformance !== level.conformance || !sameBytes(p, profile)) { warn(`PDF/A was dropped: the merged documents do not all declare PDF/A-${level.part}${level.conformance} with the same output intent`); level = null; break; }
    }
    if (level && level.conformance === 'a' && !(single && o.keepStructure !== false)) { warn('PDF/A-a was claimed as PDF/A-b: the structure tree is not kept'); level = { ...level, conformance: 'b' }; }
  }
  if (level && o.encrypt) throw new TypeError('save: PDF/A forbids encryption: pass pdfa: false to drop the PDF/A claim and encrypt');
  const keepStruct = single && o.keepStructure !== false && !self.edits.flatten;

  // Info and XMP: the source's own pair when nothing changed them, else made again from the merged info
  const info = self.info();
  const edited = !!self.edits.info || (level?.conformance !== self.pdfa()?.conformance);
  const srcXmp = self.edits.xmp ?? (edited || (!level && self.pdfa()) ? null : self.xmp());
  const created = o.creationDate ?? (info.creationDate instanceof Date ? info.creationDate : new Date());
  let intentOpt = null;
  if (level && profile) { try { parseIcc(profile, 'pdfa.outputIntent'); intentOpt = profile; } catch { warn('the source\'s output intent profile was not usable; the bundled sRGB profile was written instead'); } }
  const pdf = /** @type {any} */ (createPdf(sink, {
    compress: o.compress !== false, encrypt: o.encrypt, signal: o.signal, timeoutMs: o.timeoutMs, creationDate: created,
    title: info.title ?? undefined, author: info.author ?? undefined, subject: info.subject ?? undefined, keywords: info.keywords ?? undefined,
    ...(level ? { pdfa: { part: level.part, conformance: 'b', ...(intentOpt ? { outputIntent: intentOpt } : {}) } } : {}),
  }));
  const doc = pdf.core;
  if (level) doc.pdfaLevel = { part: level.part, conformance: level.conformance, unicode: level.conformance !== 'b' };

  // where each source page goes
  /** @type {Map<any, Map<number, number>>} owner → source page object → output index (its first copy) */
  const outOf = new Map();
  plan.forEach((/** @type {any} */ p, /** @type {number} */ k) => {
    let m = outOf.get(p.owner); if (!m) outOf.set(p.owner, m = new Map());
    const pn = p.owner.r.pages[p.index].n;
    if (pn >= 0 && !m.has(pn)) m.set(pn, k);
  });
  const fills = await fillReplacements(self, { pdfa: !!level, warn });
  const copier = createCopier({
    reserve: () => doc.reserve(),
    write: (n, dict, stream) => (stream ? doc.write(n, dict, stream) : doc.write(n, dict)),
    keepActive: !!o.keepActiveContent, compress: o.compress !== false, dedupe: true, report,
    page(owner, n) { if (!owner.r.pageIndex.has(n)) return undefined; const k = outOf.get(owner)?.get(n); return k === undefined ? null : doc.pageRef(k); },
    keepStruct: (owner) => keepStruct && owner === self,
    replace: (owner, n) => (owner === self ? fills.get(n) : undefined),
  });
  const qRef = { n: 0 };
  /** fonts and images for page.draw, made once each @type {Map<any, any>} */
  const made = new Map();
  const ready = async (/** @type {any} */ v, /** @type {string} */ kind) => {
    let h = made.get(v);
    if (!h) { h = kind === 'image' ? await pdf.embedImage(v) : typeof v === 'string' ? pdf.standardFont(v) : await pdf.embedFont(v); made.set(v, h); }
    return h;
  };
  // the outline (entries given to the writer's outline before its finisher runs): each document's entries, remapped
  for (const d of owners) {
    /** @type {{ it: any, level: number }[]} */
    const st = [];
    const push = (/** @type {any[]} */ items, /** @type {number} */ lv) => { for (let i = items.length - 1; i >= 0; i--) st.push({ it: items[i], level: lv }); };
    push(d.outlines(), 0);
    while (st.length) {
      const { it, level: lv0 } = /** @type {any} */ (st.pop());
      const k = it.page == null ? undefined : outOf.get(d)?.get(d.r.pages[it.page].n);
      let lv = lv0;
      if (k !== undefined && lv <= 63) pdf.outline({ title: it.title.slice(0, 4096), page: k + 1, level: lv }); else lv--; // an entry without a page: its children move up
      if (it.children.length) push(it.children, lv + 1);
    }
  }

  for (let k = 0; k < plan.length; k++) {
    const p = plan[k], owner = p.owner, src = owner.r.src, OR = src.resolve, pg = pageAt(owner.r, p.index), d = pg.dict;
    if (pg.emptied) warn(pg.emptied);
    const b = owner.boxes(p.index);
    const W = b.mediaBox[2] - b.mediaBox[0], H = b.mediaBox[3] - b.mediaBox[1];
    const page = /** @type {any} */ (new Page(doc, doc.newPage({ height: H }), W, H));
    doc.opened(page);
    /** @type {{ ref: number | null, owner?: any, src?: any, m: string, name?: string }[]} form XObjects drawn after the content */
    const xobjs = [];
    for (const dr of p.draws) {
      const fonts = {}, images = {};
      for (const [n2, v] of Object.entries(dr.fonts)) /** @type {any} */ (fonts)[n2] = await ready(v, 'font');
      for (const [n2, v] of Object.entries(dr.images)) /** @type {any} */ (images)[n2] = await ready(v, 'image');
      xobjs.push({ ref: appearance(page, W, H, (ap) => dr.fn(ap, { fonts, images, pdf })), m: `1 0 0 1 ${numText(b.mediaBox[0])} ${numText(b.mediaBox[1])}` });
    }
    // annotations: dropped, flattened, or links to pages not copied removed (decided now: the content is known before the page ends)
    const list = OR(d.get('Annots'));
    /** @type {any[]} */
    const keep = [];
    if (Array.isArray(list) && !p.dropAnnots) for (const a0 of list.slice(0, 100_000)) {
      const a = OR(a0);
      if (!(a instanceof Map)) { if (!o.keepActiveContent) report('an annotation that is not a dictionary'); continue; }
      if (!o.keepActiveContent) { const why = refuseAnnot(a, OR); if (why) { report(why); continue; } } // the annotation allowlist (policy.js), before anything else
      const st = OR(a.get('Subtype'));
      if (self.edits.flatten && st === 'Widget') { const x = flatten(owner, a0, fills); if (x) xobjs.push(x); continue; }
      if (self.edits.flatten && st === 'Popup') { const par = OR(a.get('Parent')); if (par instanceof Map && OR(par.get('Subtype')) === 'Widget') continue; }
      const act = OR(a.get('A'));
      const dest = a.has('Dest') ? a.get('Dest') : act instanceof Map && OR(act.get('S')) === 'GoTo' ? act.get('D') : undefined;
      if (dest !== undefined) {
        const t = owner.destPage(dest);
        if (t == null || !outOf.get(owner)?.has(owner.r.pages[t].n)) { warn('links to pages that were not copied were removed'); continue; }
      }
      keep.push(a0);
    }
    /** @type {string | null} the XObject resources added, when the content is wrapped */
    if (xobjs.length) {
      const res = OR(pg.inh.Resources), xo = res instanceof Map ? OR(res.get('XObject')) : null;
      const open = openSaves(contentBytes(src, d.get('Contents')), src.budget);
      if (open > MAX_OPEN) throw new PdfReadError('E_MALFORMED', `Page ${k + 1} leaves ${open > 1e6 ? 'over a million' : open} graphics states open (more than ${MAX_OPEN}): it cannot be drawn on or flattened safely`);
      let tail = 'Q\n'.repeat(1 + open), i = 0;
      for (const x of xobjs) {
        let nm; do nm = `RWx${++i}`; while (xo instanceof Map && xo.has(nm));
        x.name = nm;
        tail += `q ${x.m} cm /${nm} Do Q\n`;
      }
      page.content.s = tail;
    }
    let text = '', annotsText = '';
    /** @type {string | null} the source content (references) when wrapped in q … Q */
    let wrapped = null;
    page.onWrite(async () => {
      for (const [key, v] of d) {
        if (OWN.has(key)) continue;
        if (key === 'StructParents' && !(keepStruct && owner === self)) continue;
        if (key === 'AA') { if (!o.keepActiveContent) { report('additional actions (/AA)'); continue; } }
        text += ` ${nameText(key)} ${await copier.text(owner, v)}`;
      }
      const rot = p.rotate ?? b.rotation;
      text += ` /MediaBox [${b.mediaBox.map(numText).join(' ')}]`;
      if (b.cropBox.some((x, i) => x !== b.mediaBox[i])) text += ` /CropBox [${b.cropBox.map(numText).join(' ')}]`;
      if (rot) text += ` /Rotate ${rot}`;
      const res0 = pg.inh.Resources;
      if (!xobjs.length) {
        if (res0 != null) text += ` /Resources ${await copier.text(owner, res0)}`;
        if (d.get('Contents') != null) text += ` /Contents ${await copier.text(owner, d.get('Contents'))}`;
      } else {
        const res = OR(res0);
        const rd = new Map(res instanceof Map ? res : []);
        const xo = new Map(OR(rd.get('XObject')) instanceof Map ? OR(rd.get('XObject')) : []);
        rd.delete('XObject');
        const extra = [];
        for (const x of xobjs) extra.push(`${nameText(/** @type {string} */ (x.name))} ${x.ref != null ? `${x.ref} 0 R` : await copier.text(x.owner, x.src)}`);
        const rt = await copier.text(owner, rd), xt = await copier.text(owner, xo);
        text += ` /Resources ${rt.slice(0, -2)} /XObject ${xt.slice(0, -2)} ${extra.join(' ')} >> >>`;
        if (!qRef.n) { qRef.n = doc.reserve(); await doc.write(qRef.n, '<< >>', new Uint8Array([0x71, 0x0a])); }
        const c = OR(d.get('Contents'));
        wrapped = Array.isArray(c) ? (await copier.text(owner, d.get('Contents'))).slice(1, -1).trim() : c instanceof PdfStream ? await copier.text(owner, d.get('Contents')) : '';
      }
      if (keep.length) annotsText = (await copier.text(owner, keep)).slice(1, -1).trim();
    });
    page.own = (/** @type {number} */ parent, /** @type {number} */ contents, /** @type {string[]} */ annots) => {
      const c = wrapped == null ? '' : ` /Contents [${qRef.n} 0 R ${wrapped}${contents ? ` ${contents} 0 R` : ''}]`;
      const ann = [annotsText, ...annots].filter(Boolean).join(' ');
      return `<< /Type /Page /Parent ${parent} 0 R${text}${c}${ann ? ` /Annots [${ann}]` : ''} >>`;
    };
    await page.end();
  }

  // document level
  doc.onFinish(async () => {
    const root = self.r.root;
    const cat = async (/** @type {string} */ k) => { if (root.has(k)) doc.catalog(k, await copier.text(self, root.get(k))); };
    for (const k of ['ViewerPreferences', 'PageMode', 'PageLayout', 'OCProperties', 'Collection', 'URI']) await cat(k);
    if (keepStruct) for (const k of ['StructTreeRoot', 'MarkInfo', 'Lang']) await cat(k);
    else if (root.has('StructTreeRoot')) warn('the structure tree (tags) was dropped: the pages come from several documents, or the form was flattened');
    if (level && (level.part === 3)) await cat('AF');
    if (single && plan.length === self.r.pages.length && plan.every((/** @type {any} */ p, /** @type {number} */ i) => p.index === i)) await cat('PageLabels');
    // the open action: a page destination only
    const oa = R(root.get('OpenAction'));
    if (Array.isArray(oa) || (oa instanceof Map && R(oa.get('S')) === 'GoTo')) {
      const t = self.destPage(Array.isArray(oa) ? oa : oa.get('D'));
      if (t != null && outOf.get(self)?.has(self.r.pages[t].n)) doc.catalog('OpenAction', await copier.text(self, root.get('OpenAction'))); // through the copy rules: a /Next is checked
    } else if (oa instanceof Map && !o.keepActiveContent) report(`${R(oa.get('S'))} action`);
    // the form
    if (!self.edits.flatten) {
      /** @type {string[]} */
      const fields = [];
      let base = null;
      /** @type {Map<string, string>} */
      const drFonts = new Map();
      for (const d of owners) {
        const af = d.r.src.resolve(d.r.root.get('AcroForm'));
        if (!(af instanceof Map)) continue;
        base ??= { af, d };
        const list = d.r.src.resolve(af.get('Fields'));
        if (Array.isArray(list)) for (const f of list) if (fieldOnPages(d, f, outOf.get(d))) fields.push(await copier.text(d, f));
        const dr = d.r.src.resolve(af.get('DR')), fo = dr instanceof Map ? d.r.src.resolve(dr.get('Font')) : null;
        if (fo instanceof Map) for (const [k, v] of fo) if (!drFonts.has(k)) drFonts.set(k, await copier.text(d, v));
        if (af.has('XFA') && !o.keepActiveContent) report('XFA form (scripts)');
      }
      if (base && fields.length) {
        const { af, d } = base;
        let t = `<< /Fields [${fields.join(' ')}]`;
        for (const k of ['DA', 'Q']) if (af.has(k)) t += ` ${nameText(k)} ${await copier.text(d, af.get(k))}`;
        if (o.keepActiveContent && af.has('CO')) t += ` /CO ${await copier.text(d, af.get('CO'))}`;
        if (self.edits.fills.size) t += ' /NeedAppearances false';
        else if (af.has('NeedAppearances')) t += ` /NeedAppearances ${await copier.text(d, af.get('NeedAppearances'))}`;
        if (drFonts.size) t += ` /DR << /Font << ${[...drFonts].map(([k, v]) => `${nameText(k)} ${v}`).join(' ')} >> >>`;
        doc.catalog('AcroForm', `${t} >>`);
      }
    }
    // embedded files, merged
    /** @type {[string, string][]} */
    const files = [];
    const used = new Set();
    for (const d of owners) {
      const nm = d.r.src.resolve(d.r.root.get('Names'));
      if (!(nm instanceof Map)) continue;
      if (nm.has('JavaScript') && !o.keepActiveContent) report('document JavaScript (/Names /JavaScript)');
      if (!nm.has('EmbeddedFiles')) continue;
      for (const [k, v] of flatTree(nm.get('EmbeddedFiles'), d.r.src)) {
        if (!o.keepActiveContent) { const why = refuseFile(v, d.r.src.resolve); if (why) { report(why); continue; } }
        let key = String(k), i = 1;
        while (used.has(key)) key = `${k} (${++i})`;
        used.add(key);
        const kb = new Uint8Array([...key].map((c) => c.charCodeAt(0) & 255));
        files.push([hexText(kb), await copier.text(d, v)]);
      }
    }
    if (files.length) { files.sort((a, b2) => (a[0] < b2[0] ? -1 : a[0] > b2[0] ? 1 : 0)); setNames(doc, 'EmbeddedFiles', await writeTree(doc, 'Names', files)); }
    if (srcXmp != null) {
      doc.xmp = new TextEncoder().encode(srcXmp);
      const I = R(self.r.src.trailer.get('Info'));
      if (I instanceof Map && !edited) doc.info = await copier.text(self, I);
    }
  });
  const res = await pdf.end();
  return { size: res.bytes, pages: res.pages, stripped: [...stripped].map(([what, count]) => ({ what, count })), warnings: [...warnings, ...res.warnings] };
}

/** a top-level field has a widget on a copied page (or no page at all) @param {any} d @param {any} f @param {Map<number, number> | undefined} pages */
function fieldOnPages(d, f, pages) {
  const R = d.r.src.resolve;
  const seen = new Set(), stack = [f];
  let any = false;
  while (stack.length && seen.size < 100_000) {
    const x = stack.pop();
    if (x instanceof Ref) { if (seen.has(x.n)) continue; seen.add(x.n); }
    const v = R(x);
    if (!(v instanceof Map)) continue;
    const kids = R(v.get('Kids'));
    if (Array.isArray(kids) && kids.length) { stack.push(...kids); continue; }
    const p = v.get('P');
    if (!(p instanceof Ref)) any = true;
    else if (pages?.has(p.n)) return true;
  }
  return any;
}

/**
 * A widget's shown appearance as a form XObject placed on its /Rect (ISO 32000-1 §12.5.5: the BBox through the
 * Matrix, then scaled and moved onto the Rect), or null (hidden, no appearance). @param {any} owner @param {any} a0 @param {Map<number, any>} fills
 */
function flatten(owner, a0, fills) {
  const OR = owner.r.src.resolve;
  const a = (a0 instanceof Ref && fills.get(a0.n)) || OR(a0);
  if (!(a instanceof Map) || (OR(a.get('F')) | 0) & 2) return null; // hidden
  const ap = OR(a.get('AP'));
  let N = ap instanceof Map ? ap.get('N') : null, xo = owner;
  if (N instanceof Foreign) { xo = N.owner; N = N.ref; }
  else if (OR(N) instanceof Map) { const as = OR(a.get('AS')); N = typeof as === 'string' ? OR(N).get(as) : null; }
  const XR = xo.r.src.resolve, xs = XR(N);
  if (!(xs instanceof PdfStream)) return null;
  const rect = rectOf(a.get('Rect'), OR);
  if (!rect) return null;
  const bb = rectOf(xs.dict.get('BBox'), XR) ?? [0, 0, 1, 1];
  const mt = XR(xs.dict.get('Matrix'));
  const M = Array.isArray(mt) && mt.length >= 6 && mt.slice(0, 6).every((x) => typeof XR(x) === 'number') ? mt.slice(0, 6).map(XR) : [1, 0, 0, 1, 0, 0];
  const pts = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[0], bb[3]], [bb[2], bb[3]]].map(([x, y]) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]]);
  const xs0 = pts.map((q) => q[0]), ys0 = pts.map((q) => q[1]);
  const x0 = Math.min(...xs0), x1 = Math.max(...xs0), y0 = Math.min(...ys0), y1 = Math.max(...ys0);
  if (!(x1 > x0 && y1 > y0)) return null;
  const sx = (rect[2] - rect[0]) / (x1 - x0), sy = (rect[3] - rect[1]) / (y1 - y0);
  return { ref: null, owner: xo, src: N, m: `${numText(sx)} 0 0 ${numText(sy)} ${numText(rect[0] - x0 * sx)} ${numText(rect[1] - y0 * sy)}` };
}

/** the same bytes (or both absent) @param {Uint8Array | null} a @param {Uint8Array | null} b */
function sameBytes(a, b) {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
