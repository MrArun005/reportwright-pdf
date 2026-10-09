// @ts-check
/**
 * loadPdf(bytes, { password, budget, timeoutMs, signal }) → a loaded document: what it says (info, XMP, PDF/A level,
 * pages and their boxes, outlines, form fields, attachments, signatures, page text) and what to change (pages copied
 * from other documents, removed, moved, rotated, drawn on; fields filled; forms flattened; info and XMP; annotations
 * removed). Changes are a plan: nothing is written until save() (a new file, through the writer: reader/save.js) or
 * saveIncremental() (appended to the original bytes: reader/incremental.js).
 *
 * Reading is lazy (reader/source.js): loading parses the cross-reference and the page tree, nothing else; a stream is
 * decoded only when something needs it. Every walk over the file's structures (page tree, outlines, fields, name
 * trees) is iterative, remembers what it has visited (a /Kids or /Next loop ends there) and is bounded.
 */
import { fflate } from '../core/lazy.js';
import { createBudget, fail, PdfReadError } from './budget.js';
import { openSource } from './source.js';
import { Ref, PdfString, PdfStream, latin1 } from './lexer.js';
import { decodeText, extractText, own } from './text.js';
import { checkFileName } from '../core/filename.js';

export const MAX_PAGES = 1_000_000, MAX_OUTLINE = 100_000, MAX_FIELDS = 100_000, MAX_NAMES = 1_000_000;

/** @type {WeakMap<object, any>} a loaded document's private side (its handle can be passed back: copyPages, merge) */
const inside = new WeakMap();
/** @param {any} v @param {string} who @returns {any} */
export function internal(v, who) {
  const d = v !== null && typeof v === 'object' ? inside.get(v) : undefined;
  if (!d) throw new TypeError(`${who}: not a document from loadPdf`);
  return d;
}

/** a PDF date (D:YYYYMMDDHHmmSSOHH'mm) → Date, or null @param {string} s */
export function pdfDateOf(s) {
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?/.exec(s.trim());
  if (!m) return null;
  const [y, mo = '01', d = '01', h = '00', mi = '00', se = '00'] = m.slice(1, 7).map((x, i) => x ?? ['', '01', '01', '00', '00', '00'][i]);
  let t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  if (m[7] === '+' || m[7] === '-') t -= (m[7] === '+' ? 1 : -1) * ((+(m[8] ?? 0)) * 60 + +(m[9] ?? 0)) * 60000;
  return Number.isFinite(t) ? new Date(t) : null;
}

/**
 * @param {Uint8Array | ArrayBuffer} input
 * @param {{ password?: string, budget?: { maxDecoded?: number, maxStream?: number, maxSteps?: number }, timeoutMs?: number, signal?: AbortSignal }} [o]
 */
export async function loadPdf(input, o = {}) {
  if (o == null || typeof o !== 'object') throw new TypeError('loadPdf: options are { password, budget, timeoutMs, signal }');
  for (const k of Object.keys(o)) if (!['password', 'budget', 'timeoutMs', 'signal'].includes(k)) throw new TypeError(`loadPdf: unknown option ${JSON.stringify(k.slice(0, 40))} (password, budget, timeoutMs, signal)`);
  const bytes = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : null;
  if (!bytes) throw new TypeError('loadPdf: bytes are a Uint8Array or an ArrayBuffer');
  if (o.password != null && typeof o.password !== 'string') throw new TypeError('loadPdf: password is a string');
  if (o.budget != null && typeof o.budget !== 'object') throw new TypeError('loadPdf: budget is { maxDecoded, maxStream, maxSteps }');
  if (o.signal?.aborted) fail('E_ABORTED', 'Reading the PDF was aborted');
  const budget = createBudget({ ...o.budget, timeoutMs: o.timeoutMs, signal: o.signal });
  await fflate(); // FlateDecode (filters.js) inflates synchronously
  const src = await openSource(bytes, budget, { password: o.password });
  return makeDoc(read(src));
}

/**
 * What the document is, read once at load: the catalog and the pages (the tree walked iteratively, a node seen twice
 * is skipped, at most MAX_PAGES). @param {import('./source.js').Source} src
 */
function read(src) {
  const R = src.resolve;
  const root = /** @type {Map<string, any>} */ (R(src.trailer.get('Root')));
  /** @type {{ n: number, dict: Map<string, any>, inh: Record<string, any>, checked?: boolean, emptied?: string }[]} */
  const pages = [];
  /** @type {Map<number, number>} page object number → index */
  const pageIndex = new Map();
  const seen = new Set();
  /** @type {{ node: any, inh: Record<string, any> }[]} */
  const stack = [{ node: root.get('Pages'), inh: {} }];
  while (stack.length) {
    const { node, inh } = /** @type {any} */ (stack.pop());
    src.budget.tick();
    const n = node instanceof Ref ? node.n : -1;
    if (n >= 0) { if (seen.has(n)) { src.warn('the page tree has a loop (a node is its own descendant); it was cut'); continue; } seen.add(n); }
    const d = R(node);
    if (!(d instanceof Map)) continue;
    const here = { ...inh };
    for (const k of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) if (d.has(k)) here[k] = d.get(k);
    const kids = R(d.get('Kids'));
    if (d.get('Type') === 'Pages' || (d.get('Type') !== 'Page' && Array.isArray(kids))) {
      if (Array.isArray(kids)) {
        // a step per kid, a kid already visited not pushed, and the stack capped: a /Kids array shared by its own
        // kids would push every kid again at every level (quadratic in time and memory)
        src.budget.tick(kids.length);
        for (let i = Math.min(kids.length, MAX_PAGES) - 1; i >= 0; i--) {
          if (kids[i] instanceof Ref && seen.has(kids[i].n)) src.warn('the page tree has a loop (a node is its own descendant); it was cut');
          else stack.push({ node: kids[i], inh: here });
        }
        if (stack.length > MAX_PAGES) fail('E_BUDGET', `The page tree holds more than ${MAX_PAGES.toLocaleString('en')} nodes waiting to be read (a /Kids array shared by its kids?)`);
      }
      continue;
    }
    if (pages.length >= MAX_PAGES) fail('E_BUDGET', `More than ${MAX_PAGES.toLocaleString('en')} pages`);
    if (n >= 0) pageIndex.set(n, pages.length);
    pages.push({ n, dict: d, inh: here });
  }
  if (!pages.length) src.warn('the document has no pages');
  return { src, root, pages, pageIndex };
}

/** a rectangle [x0 y0 x1 y1], normalised; null when it is not one @param {any} v @param {(v: any) => any} R */
export function rectOf(v, R) {
  const a = R(v);
  if (!Array.isArray(a) || a.length < 4) return null;
  const n = a.slice(0, 4).map(R);
  if (!n.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  return [Math.min(n[0], n[2]), Math.min(n[1], n[3]), Math.max(n[0], n[2]), Math.max(n[1], n[3])];
}

/** a flat name (or number) tree: key → value; iterative, a node seen twice is skipped, at most MAX_NAMES @param {any} rootNode @param {any} src @param {'Names' | 'Nums'} [kind] */
export function flatTree(rootNode, src, kind = 'Names') {
  const R = src.resolve;
  /** @type {Map<string | number, any>} */
  const out = new Map();
  const seen = new Set();
  const stack = [rootNode];
  while (stack.length && out.size < MAX_NAMES) {
    const node = stack.pop();
    src.budget.tick();
    if (node instanceof Ref) { if (seen.has(node.n)) continue; seen.add(node.n); }
    const d = R(node);
    if (!(d instanceof Map)) continue;
    const kids = R(d.get('Kids'));
    if (Array.isArray(kids)) { src.budget.tick(kids.length); for (let i = kids.length - 1; i >= 0; i--) if (!(kids[i] instanceof Ref && seen.has(kids[i].n))) stack.push(kids[i]); }
    if (stack.length > MAX_NAMES) fail('E_BUDGET', `A name tree holds more than ${MAX_NAMES.toLocaleString('en')} nodes waiting to be read`);
    const list = R(d.get(kind));
    if (Array.isArray(list)) src.budget.tick(list.length >> 1); // one array shared by many nodes is read once per node: each pair a step
    if (Array.isArray(list)) for (let i = 0; i + 1 < list.length && out.size < MAX_NAMES; i += 2) {
      const k = R(list[i]);
      const key = k instanceof PdfString ? latin1(k.bytes) : k;
      if (!out.has(key)) out.set(key, list[i + 1]);
    }
  }
  return out;
}

/**
 * The page at source index i, its /Contents checked once: a reference loop there (E_CYCLE) makes that page empty,
 * with a warning, as a page-tree loop is cut; the rest of the document stays usable. @param {ReturnType<typeof read>} r @param {number} i
 */
export function pageAt(r, i) {
  const pg = r.pages[i];
  if (pg.checked) return pg;
  pg.checked = true;
  const R = r.src.resolve;
  try { const c = R(pg.dict.get('Contents')); if (Array.isArray(c)) { r.src.budget.tick(Math.min(c.length, 10_000)); for (const x of c.slice(0, 10_000)) R(x); } }
  catch (e) {
    if (!(e instanceof PdfReadError) || e.code !== 'E_CYCLE') throw e;
    pg.emptied = `page ${i + 1}'s /Contents has a reference loop; the page is read as empty`;
    r.src.warn(pg.emptied);
    pg.dict = new Map(pg.dict); pg.dict.delete('Contents');
  }
  return pg;
}

const ACTIVE_FT = { Tx: 'text', Ch: 'choice', Btn: 'button', Sig: 'signature' };

/** @param {ReturnType<typeof read>} r @param {any} [plan] @param {any} [edits] */
function makeDoc(r, plan, edits) {
  const { src, root, pages, pageIndex } = r;
  const R = src.resolve;
  /** named destinations, flattened once */
  let dests = /** @type {Map<string | number, any> | null} */ (null);
  const named = (/** @type {string} */ key) => {
    if (!dests) {
      dests = new Map();
      const nm = R(root.get('Names'));
      if (nm instanceof Map && nm.has('Dests')) dests = flatTree(nm.get('Dests'), src);
      const old = R(root.get('Dests'));
      if (old instanceof Map) for (const [k, v] of old) if (!dests.has(k)) dests.set(k, v);
    }
    return dests.get(key);
  };
  /** a destination (array, name, string, or a dict with /D) → an explicit array, or null @param {any} d */
  const explicit = (d) => {
    for (let i = 0; i < 4; i++) {
      d = R(d);
      if (Array.isArray(d)) return d;
      if (d instanceof PdfString) d = named(latin1(d.bytes));
      else if (typeof d === 'string') d = named(d);
      else if (d instanceof Map) d = d.get('D');
      else return null;
    }
    return null;
  };
  /** the source page index a destination goes to, or null @param {any} d */
  const destPage = (d) => {
    const a = explicit(d);
    if (!a) return null;
    const p = a[0];
    if (p instanceof Ref) return pageIndex.get(p.n) ?? null;
    return Number.isInteger(p) && p >= 0 && p < pages.length ? p : null;
  };

  const self = {
    r, named, explicit, destPage,
    /** @type {{ owner: any, index: number, rotate: number | null, draws: { fn: (p: any, r: any) => any, fonts: Record<string, any>, images: Record<string, any> }[], dropAnnots: boolean }[]} the output pages */
    plan: plan ?? pages.map((_, i) => ({ owner: null, index: i, rotate: null, draws: [], dropAnnots: false })),
    /** @type {{ info: Record<string, string | null> | null, xmp: string | null, fills: Map<string, any>, fillFont: any, flatten: boolean }} */
    edits: edits ?? { info: null, xmp: null, fills: new Map(), fillFont: null, flatten: false },
  };
  for (const p of self.plan) p.owner ??= self;

  const boxes = (/** @type {number} */ i) => {
    const pg = pages[i], d = pg.dict;
    const media = rectOf(pg.inh.MediaBox, R) ?? [0, 0, 612, 792];
    const clip = (/** @type {number[] | null} */ b) => (b ? [Math.max(b[0], media[0]), Math.max(b[1], media[1]), Math.min(b[2], media[2]), Math.min(b[3], media[3])] : null);
    const crop = clip(rectOf(pg.inh.CropBox, R)) ?? media;
    const rot = R(pg.inh.Rotate);
    const uu = R(d.get('UserUnit'));
    return {
      mediaBox: media, cropBox: crop, bleedBox: clip(rectOf(d.get('BleedBox'), R)) ?? crop, trimBox: clip(rectOf(d.get('TrimBox'), R)) ?? crop, artBox: clip(rectOf(d.get('ArtBox'), R)) ?? crop,
      rotation: Number.isInteger(rot) ? (((rot % 360) + 360) % 360) - ((((rot % 360) + 360) % 360) % 90) : 0,
      userUnit: typeof uu === 'number' && uu > 0 ? uu : 1,
    };
  };
  self.boxes = boxes;

  /** the page at plan position i, as a handle @param {number} i */
  const pageView = (i) => {
    if (!Number.isInteger(i) || i < 0 || i >= self.plan.length) throw new RangeError(`page: no page ${i} (0–${self.plan.length - 1})`);
    const p = self.plan[i], owner = p.owner, b = owner.boxes(p.index);
    const rotation = p.rotate ?? b.rotation;
    return Object.freeze({
      index: i,
      width: b.mediaBox[2] - b.mediaBox[0], height: b.mediaBox[3] - b.mediaBox[1],
      mediaBox: b.mediaBox, cropBox: b.cropBox, bleedBox: b.bleedBox, trimBox: b.trimBox, artBox: b.artBox, rotation, userUnit: b.userUnit,
      /**
       * the page's text in content order, in lines (not layout-perfect); timeoutMs: its time, 30 s by default (the
       * document's timeoutMs when sooner) @param {{ timeoutMs?: number }} [o]
       */
      extractText: (o) => { const pg = pageAt(owner.r, p.index); return extractText(owner.r.src, pg.dict, owner.r.src.resolve(pg.inh.Resources), o); },
      /** the annotations: subtype, rect, contents, uri, the page index a link goes to */
      annotations: () => owner.annots(p.index),
      /**
       * Draw on top of the page with the writer's drawing methods (top-left space of the MediaBox, as addPage's pages),
       * run at save(): fn(page, { fonts, images, pdf }) synchronously, with the fonts and images named in o made ready
       * in the new file (a standard font's name or font bytes; image bytes). Wrapped in q/Q: the page's own graphics
       * state cannot change it. @param {(page: any, r: { fonts: Record<string, any>, images: Record<string, any>, pdf: any }) => void} fn
       * @param {{ fonts?: Record<string, string | Uint8Array>, images?: Record<string, Uint8Array> }} [o]
       */
      draw(fn, o = {}) {
        if (typeof fn !== 'function') throw new TypeError('page.draw(fn): fn draws on the page');
        if (o == null || typeof o !== 'object') throw new TypeError('page.draw: options are { fonts, images }');
        for (const k of Object.keys(o)) if (k !== 'fonts' && k !== 'images') throw new TypeError(`page.draw: unknown option ${JSON.stringify(k.slice(0, 40))} (fonts, images)`);
        for (const [k, v] of Object.entries(o.fonts ?? {})) if (typeof v !== 'string' && !(v instanceof Uint8Array)) throw new TypeError(`page.draw: fonts.${k} is a standard font's name or font bytes`);
        for (const [k, v] of Object.entries(o.images ?? {})) if (!(v instanceof Uint8Array)) throw new TypeError(`page.draw: images.${k} is the bytes of a PNG or JPEG`);
        p.draws.push({ fn, fonts: { ...o.fonts }, images: { ...o.images } });
        return this;
      },
      /** turn the page by deg (a multiple of 90) clockwise @param {number} deg */
      rotate(deg) {
        if (!Number.isInteger(deg) || deg % 90) throw new RangeError('page.rotate: a multiple of 90 degrees');
        p.rotate = (((rotation + deg) % 360) + 360) % 360;
        return this;
      },
      /** drop the page's annotations (links, notes, widgets) in the output */
      removeAnnotations() { p.dropAnnots = true; return this; },
    });
  };

  /** @param {number} i a source page index */
  self.annots = (i) => {
    const out = [];
    const list = R(pages[i].dict.get('Annots'));
    if (!Array.isArray(list)) return out;
    src.budget.tick(Math.min(list.length, 100_000));
    for (const a0 of list.slice(0, 100_000)) {
      const a = R(a0);
      if (!(a instanceof Map)) continue;
      const act = R(a.get('A'));
      const uri = act instanceof Map && R(act.get('S')) === 'URI' ? decodeText(R(act.get('URI'))) : null;
      const target = a.has('Dest') ? destPage(a.get('Dest')) : act instanceof Map && R(act.get('S')) === 'GoTo' ? destPage(act.get('D')) : null;
      out.push({ subtype: String(R(a.get('Subtype')) ?? ''), rect: rectOf(a.get('Rect'), R), contents: a.has('Contents') ? decodeText(R(a.get('Contents'))) : null, uri, page: target });
    }
    return out;
  };

  /** the form's fields (terminal ones), walked iteratively @returns {any[]} */
  self.fields = () => {
    const af = R(root.get('AcroForm'));
    const out = [];
    if (!(af instanceof Map)) return out;
    const top = R(af.get('Fields'));
    if (!Array.isArray(top)) return out;
    const seen = new Set();
    /** @type {{ node: any, name: string, inh: Record<string, any>, parent: any }[]} */
    const stack = [];
    for (let i = top.length - 1; i >= 0; i--) stack.push({ node: top[i], name: '', inh: {}, parent: null });
    while (stack.length && out.length < MAX_FIELDS) {
      const { node, name, inh } = /** @type {any} */ (stack.pop());
      src.budget.tick();
      if (node instanceof Ref) { if (seen.has(node.n)) continue; seen.add(node.n); }
      const d = R(node);
      if (!(d instanceof Map)) continue;
      const t = d.has('T') ? decodeText(R(d.get('T'))) : null;
      const full = t == null ? name : name ? `${name}.${t}` : t;
      const here = { ...inh };
      for (const k of ['FT', 'Ff', 'V', 'DV', 'DA', 'Q', 'Opt', 'MaxLen']) if (d.has(k)) here[k] = d.get(k);
      if ((R(d.get('Ff')) | 0) & 1) here.ReadOnlyAny = true; // read-only on any ancestor: the strictest reading (a kid's own /Ff does not lift it)
      const kids = R(d.get('Kids'));
      if (Array.isArray(kids)) src.budget.tick(kids.length); // a /Kids array shared by many fields is read once per field
      const kidFields = Array.isArray(kids) ? kids.filter((k) => { const kd = R(k); return kd instanceof Map && (kd.has('T') || kd.has('FT')); }) : [];
      if (kidFields.length) { for (let i = kidFields.length - 1; i >= 0; i--) stack.push({ node: kidFields[i], name: full, inh: here, parent: node }); continue; }
      const widgets = Array.isArray(kids) && kids.length ? kids : [node];
      const ft = R(here.FT), ff = R(here.Ff) | 0;
      let type = own(ACTIVE_FT, ft) ?? 'unknown';
      if (type === 'button') type = ff & (1 << 16) ? 'pushbutton' : ff & (1 << 15) ? 'radio' : 'checkbox';
      if (type === 'choice') type = ff & (1 << 17) ? 'combo' : 'list';
      const v = R(here.V);
      const value = v instanceof PdfString ? decodeText(v) : Array.isArray(v) ? v.map((x) => decodeText(R(x))) : typeof v === 'string' ? v : v == null ? null : v instanceof Map ? '(signed)' : String(v);
      const opt = R(here.Opt);
      out.push({
        name: full, type, value, ref: node instanceof Ref ? node.n : -1,
        readOnly: !!(ff & 1), required: !!(ff & 2), flags: ff,
        options: Array.isArray(opt) ? opt.slice(0, 10_000).map((x) => { const y = R(x); return Array.isArray(y) ? decodeText(R(y[1])) : decodeText(y); }) : null,
        exports: Array.isArray(opt) ? opt.slice(0, 10_000).map((x) => { const y = R(x); return Array.isArray(y) ? decodeText(R(y[0])) : decodeText(y); }) : null,
        widgets: widgets.slice(0, 1000).map((w) => {
          const wd = R(w);
          const p = wd instanceof Map ? R(wd.get('P')) : null;
          const pg = wd instanceof Map && wd.get('P') instanceof Ref ? pageIndex.get(wd.get('P').n) : null;
          const ap = wd instanceof Map ? R(wd.get('AP')) : null, N = ap instanceof Map ? R(ap.get('N')) : null;
          return { ref: w instanceof Ref ? w.n : -1, page: pg ?? (p ? null : null), rect: wd instanceof Map ? rectOf(wd.get('Rect'), R) : null,
            states: N instanceof Map ? [...N.keys()] : [], state: wd instanceof Map && typeof R(wd.get('AS')) === 'string' ? R(wd.get('AS')) : null };
        }),
        inh: here,
      });
    }
    return out;
  };

  /** the embedded files (the EmbeddedFiles name tree, then file attachment annotations) */
  self.attachments = () => {
    const out = [];
    const nm = R(root.get('Names'));
    /** @type {[any, number | null][]} */
    const specs = [];
    if (nm instanceof Map && nm.has('EmbeddedFiles')) for (const v of flatTree(nm.get('EmbeddedFiles'), src).values()) specs.push([v, null]);
    pages.forEach((pg, i) => {
      const list = R(pg.dict.get('Annots'));
      if (Array.isArray(list)) { src.budget.tick(Math.min(list.length, 100_000)); for (const a0 of list.slice(0, 100_000)) { const a = R(a0); if (a instanceof Map && R(a.get('Subtype')) === 'FileAttachment' && a.has('FS')) specs.push([a.get('FS'), i]); } }
    });
    for (const [spec, page] of specs.slice(0, 100_000)) {
      const fs = R(spec);
      if (!(fs instanceof Map)) continue;
      const ef = R(fs.get('EF'));
      const stm = ef instanceof Map ? R(ef.get('UF') ?? ef.get('F')) : null;
      if (!(stm instanceof PdfStream)) continue;
      const raw = decodeText(R(fs.get('UF') ?? fs.get('F')));
      const sub = R(stm.dict.get('Subtype'));
      const mimeType = typeof sub === 'string' ? sub : null;
      let name = null, refused = null;
      try { name = checkFileName(raw, { mimeType }, 'attachment').name; } catch (e) { refused = /** @type {Error} */ (e).message; }
      const params = R(stm.dict.get('Params'));
      const sz = params instanceof Map ? R(params.get('Size')) : null;
      out.push({
        rawName: raw, name, refused, mimeType, page, description: fs.has('Desc') ? decodeText(R(fs.get('Desc'))) : null,
        size: typeof sz === 'number' ? sz : null, relationship: typeof R(fs.get('AFRelationship')) === 'string' ? R(fs.get('AFRelationship')) : null,
        /** the file's bytes, decoded under the document's budget */
        bytes: () => src.decodeStream(stm).data,
      });
    }
    return out;
  };

  /** signatures: each signed field's /ByteRange and what it covers (not verified) */
  self.signatures = () => {
    const out = [];
    for (const f of self.fields()) {
      if (f.type !== 'signature') continue;
      const v = R(f.inh.V);
      if (!(v instanceof Map)) continue;
      const br = R(v.get('ByteRange'));
      const range = Array.isArray(br) && br.length === 4 && br.map(R).every((x) => Number.isInteger(x) && x >= 0) ? br.map(R) : null;
      const contents = R(v.get('Contents'));
      const end = range ? range[2] + range[3] : 0;
      const ok = !!range && range[0] === 0 && range[1] <= range[2] && end <= src.size;
      const rev = ok ? src.revisions.findIndex((e) => e >= end) : -1;
      out.push({
        field: f.name, subFilter: typeof R(v.get('SubFilter')) === 'string' ? R(v.get('SubFilter')) : null, byteRange: range,
        name: v.has('Name') ? decodeText(R(v.get('Name'))) : null, reason: v.has('Reason') ? decodeText(R(v.get('Reason'))) : null,
        location: v.has('Location') ? decodeText(R(v.get('Location'))) : null, date: v.has('M') ? pdfDateOf(decodeText(R(v.get('M')))) : null,
        /** the ranges are well formed: from 0, around /Contents, inside the file */
        wellFormed: ok,
        /** the signature covers every byte of the file but its /Contents (no change after it) */
        coversWholeFile: ok && end === src.size,
        /** the revision (0 first) whose end it covers, -1 when none */
        revision: rev,
        /** the bytes after it: an incremental update was appended after signing */
        bytesAfter: ok ? src.size - end : null,
        cms: contents instanceof PdfString ? contents.bytes : null,
        /** the signed bytes (the ranges) */
        signedBytes: () => { if (!ok || !range) throw new PdfReadError('E_MALFORMED', 'The signature\'s /ByteRange is malformed'); const b = src.bytes; const out2 = new Uint8Array(range[1] + range[3]); out2.set(b.subarray(0, range[1])); out2.set(b.subarray(range[2], end), range[1]); return out2; },
      });
    }
    return out;
  };

  /** the outline, as a tree: { title, page, url, children } (iterative; a /Next or /First loop ends there) */
  self.outlines = () => {
    const ol = R(root.get('Outlines'));
    /** @type {any[]} */
    const top = [];
    if (!(ol instanceof Map)) return top;
    const seen = new Set();
    let count = 0;
    /** @type {{ node: any, into: any[] }[]} */
    const stack = [{ node: ol.get('First'), into: top }];
    while (stack.length && count < MAX_OUTLINE) {
      const s = /** @type {any} */ (stack.pop());
      let node = s.node;
      for (let k = 0; node != null && count < MAX_OUTLINE; k++) {
        src.budget.tick();
        if (node instanceof Ref) { if (seen.has(node.n)) { src.warn('the outline has a loop; it was cut'); break; } seen.add(node.n); }
        const d = R(node);
        if (!(d instanceof Map)) break;
        const act = R(d.get('A'));
        const item = {
          title: decodeText(R(d.get('Title'))),
          page: d.has('Dest') ? destPage(d.get('Dest')) : act instanceof Map && R(act.get('S')) === 'GoTo' ? destPage(act.get('D')) : null,
          url: act instanceof Map && R(act.get('S')) === 'URI' ? decodeText(R(act.get('URI'))) : null,
          /** @type {any[]} */ children: [],
          ref: node instanceof Ref ? node.n : -1,
        };
        count++;
        s.into.push(item);
        if (d.has('First')) stack.push({ node: d.get('First'), into: item.children });
        node = d.get('Next');
        if (!(node instanceof Ref)) node = null; // a direct /Next cannot be checked for loops
      }
    }
    return top;
  };

  /** the XMP packet as text, or null */
  self.xmp = () => {
    if (self.edits.xmp != null) return self.edits.xmp;
    const m = R(root.get('Metadata'));
    if (!(m instanceof PdfStream)) return null;
    try { return new TextDecoder().decode(src.decodeStream(m).data); } catch (e) { if (e instanceof PdfReadError && (e.code === 'E_MALFORMED' || e.code === 'E_UNSUPPORTED')) return null; throw e; }
  };
  /** the PDF/A part and conformance the XMP declares, or null */
  self.pdfa = () => {
    const x = self.xmp();
    if (!x) return null;
    const part = /pdfaid:part\s*=\s*["'](\d)["']|<pdfaid:part>\s*(\d)\s*</.exec(x), conf = /pdfaid:conformance\s*=\s*["']([ABUabu])["']|<pdfaid:conformance>\s*([ABUabu])\s*</.exec(x);
    if (!part) return null;
    return { part: Number(part[1] ?? part[2]), conformance: (conf?.[1] ?? conf?.[2] ?? 'b').toLowerCase() };
  };
  /** the Info dictionary's text entries, decoded */
  self.info = () => {
    const I = R(src.trailer.get('Info'));
    /** @type {Record<string, any>} */
    const out = {};
    if (I instanceof Map) for (const k of ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate', 'Trapped']) {
      if (!I.has(k)) continue;
      const v = R(I.get(k));
      const key = k[0].toLowerCase() + k.slice(1);
      out[key] = k.endsWith('Date') ? pdfDateOf(decodeText(v)) : typeof v === 'string' ? v : decodeText(v);
    }
    if (self.edits.info) for (const [k, v] of Object.entries(self.edits.info)) { if (v == null) delete out[k]; else out[k] = v; }
    return out;
  };

  const api = {
    /** pages in the output (as planned: after copies, removals and moves) */
    get pageCount() { return self.plan.length; },
    /** the PDF version in the header */
    get version() { return src.version; },
    get encrypted() { return !!src.security; },
    /** null when not encrypted; else { algorithm, revision, owner (opened with the owner password), permissions } */
    get encryption() { const s = src.security; return s ? { algorithm: s.algorithm, revision: s.revision, owner: s.owner, permissions: { ...s.permissions } } : null; },
    /** the cross-reference was broken and rebuilt by scanning */
    get recovered() { return src.recovered; },
    /** what was repaired or ignored while reading */
    get warnings() { return [...src.warnings]; },
    get info() { return self.info(); },
    get xmp() { return self.xmp(); },
    get pdfa() { return self.pdfa(); },
    get outlines() { return self.outlines(); },
    get fields() { return self.fields().map(({ inh, ref, ...f }) => f); },
    get attachments() { return self.attachments(); },
    get signatures() { return self.signatures(); },
    page: pageView,
    /** every page's text, joined by form feeds; timeoutMs: each page's (30 s by default) @param {{ timeoutMs?: number }} [o] */
    extractText(o) { return self.plan.map((_, i) => pageView(i).extractText(o)).join('\f'); },

    // ---- changes (a plan, written by save) ----
    /**
     * Set or clear (null) Info entries: title, author, subject, keywords, creator. The XMP follows on save().
     * @param {Record<string, string | null>} info
     */
    setInfo(info) {
      if (info == null || typeof info !== 'object') throw new TypeError('setInfo: { title, author, subject, keywords, creator }');
      for (const [k, v] of Object.entries(info)) {
        if (!['title', 'author', 'subject', 'keywords', 'creator'].includes(k)) throw new TypeError(`setInfo: unknown key ${JSON.stringify(k.slice(0, 40))} (title, author, subject, keywords, creator)`);
        if (v != null && (typeof v !== 'string' || v.length > 65536)) throw new TypeError(`setInfo: ${k} is a string of at most 65,536 characters, or null`);
      }
      self.edits.info = { ...self.edits.info, ...info };
      return api;
    },
    /** replace the XMP packet (written as is: the caller's XML) @param {string} xml */
    setXmp(xml) {
      if (typeof xml !== 'string' || xml.length > 16 << 20) throw new TypeError('setXmp: an XMP packet (a string of at most 16 MB)');
      self.edits.xmp = xml;
      return api;
    },
    /** append pages of another loaded document (all by default), or insert them at `at` @param {any} other @param {number[]} [indexes] @param {{ at?: number }} [o] */
    copyPages(other, indexes, o = {}) {
      const d = internal(other, 'copyPages');
      const all = d.plan;
      const idx = indexes ?? all.map((/** @type {any} */ _, /** @type {number} */ i) => i);
      if (!Array.isArray(idx)) throw new TypeError('copyPages: indexes is an array of page indexes');
      const add = idx.map((i) => {
        if (!Number.isInteger(i) || i < 0 || i >= all.length) throw new RangeError(`copyPages: no page ${i} in that document (0–${all.length - 1})`);
        const p = all[i];
        return { owner: p.owner, index: p.index, rotate: p.rotate, draws: [...p.draws], dropAnnots: p.dropAnnots };
      });
      const at = o.at ?? self.plan.length;
      if (!Number.isInteger(at) || at < 0 || at > self.plan.length) throw new RangeError(`copyPages: at is 0–${self.plan.length}`);
      self.plan.splice(at, 0, ...add);
      return api;
    },
    /** append every page of each document @param {any[]} others */
    merge(others) {
      if (!Array.isArray(others)) throw new TypeError('merge: an array of loaded documents');
      for (const x of others) api.copyPages(x);
      return api;
    },
    /** remove pages (indexes in the current order) @param {number[]} indexes */
    removePages(indexes) {
      if (!Array.isArray(indexes)) throw new TypeError('removePages: an array of page indexes');
      const drop = new Set(indexes.map((i) => { if (!Number.isInteger(i) || i < 0 || i >= self.plan.length) throw new RangeError(`removePages: no page ${i}`); return i; }));
      self.plan = self.plan.filter((_, i) => !drop.has(i));
      return api;
    },
    /** the pages in a new order: order[k] is the current index of the page that goes at k (pages left out are removed) @param {number[]} order */
    reorder(order) {
      if (!Array.isArray(order)) throw new TypeError('reorder: an array of page indexes');
      const seen = new Set();
      self.plan = order.map((i) => {
        if (!Number.isInteger(i) || i < 0 || i >= self.plan.length || seen.has(i)) throw new RangeError(`reorder: ${i} is not a page index, or appears twice`);
        seen.add(i);
        return self.plan[i];
      });
      return api;
    },
    /** move one page @param {number} from @param {number} to */
    movePage(from, to) {
      const n = self.plan.length;
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= n || to >= n) throw new RangeError(`movePage: indexes are 0–${n - 1}`);
      const [p] = self.plan.splice(from, 1);
      self.plan.splice(to, 0, p);
      return api;
    },
    /** drop every page's annotations in the output */
    removeAnnotations() { for (const p of self.plan) p.dropAnnots = true; return api; },
    /**
     * Fill fields by full name: a string (text, combo, list, radio export value), a boolean (check box), an array of
     * strings (multi-select list). Appearances are made again on save. font: a TrueType/OpenType font's bytes for the
     * appearances (needed for text outside WinAnsi, and in PDF/A, where the standard fonts cannot be used).
     * @param {Record<string, string | boolean | string[]>} values @param {{ font?: Uint8Array }} [o]
     */
    fill(values, o = {}) {
      if (values == null || typeof values !== 'object') throw new TypeError('fill: { "full.name": value }');
      const fields = new Map(self.fields().map((f) => [f.name, f]));
      for (const [k, v] of Object.entries(values)) {
        const f = fields.get(k);
        if (!f) throw new TypeError(`fill: no field named ${JSON.stringify(k.slice(0, 200))}`);
        checkValue(f, v);
        self.edits.fills.set(k, v);
      }
      if (o.font != null) { if (!(o.font instanceof Uint8Array)) throw new TypeError('fill: font is the bytes of a TrueType/OpenType font'); self.edits.fillFont = o.font; }
      return api;
    },
    /** draw every field's appearance into its page and drop the form, on save() */
    flatten() { self.edits.flatten = true; return api; },
    /** @param {any} [o] */
    async save(o) { return (await import('./save.js')).save(self, o); },
    /** @param {any} sink @param {any} [o] */
    async saveTo(sink, o) { return (await import('./save.js')).saveTo(self, sink, o); },
    /** @param {any} [o] */
    async saveIncremental(o) { return (await import('./incremental.js')).saveIncremental(self, o); },
    /** a copy of this document's plan (the same source), changed independently */
    fork() { const e = self.edits; return makeDoc(r, self.plan.map((p) => ({ owner: p.owner === self ? null : p.owner, index: p.index, rotate: p.rotate, draws: p.draws.length ? [...p.draws] : [], dropAnnots: p.dropAnnots })), { ...e, fills: new Map(e.fills) }); },
  };
  self.api = api;
  inside.set(api, self);
  return api;
}

/** a fill value checked against the field @param {any} f @param {any} v */
function checkValue(f, v) {
  const who = `fill: ${JSON.stringify(f.name.slice(0, 200))}`;
  if (f.type === 'text' || f.type === 'combo') { if (typeof v !== 'string' || v.length > 100_000) throw new TypeError(`${who} takes a string of at most 100,000 characters`); return; }
  if (f.type === 'checkbox') { if (typeof v !== 'boolean') throw new TypeError(`${who} is a check box: true or false`); return; }
  if (f.type === 'radio') {
    const on = new Set(f.widgets.flatMap((/** @type {any} */ w) => w.states.filter((/** @type {string} */ s) => s !== 'Off')));
    if (v !== null && (typeof v !== 'string' || !(on.has(v) || f.exports?.includes(v)))) throw new TypeError(`${who} is a radio group: one of ${[...on].map((s) => JSON.stringify(s)).join(', ')}, or null`);
    return;
  }
  if (f.type === 'list') {
    const vs = Array.isArray(v) ? v : [v];
    if (!vs.every((x) => typeof x === 'string')) throw new TypeError(`${who} is a list box: a string or an array of strings`);
    return;
  }
  throw new TypeError(`${who}: a ${f.type} field cannot be filled`);
}
