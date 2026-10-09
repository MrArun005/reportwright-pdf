// @ts-check
/**
 * @reportwright/pdf: a streaming PDF writer. createPdf(sink, options) → pdf; toBytes(build, options) → Uint8Array.
 * See README.md for the API and ARCHITECTURE.md for the modules and their extension points.
 */
import { openSink } from './core/sink.js';
import { createDoc } from './document.js';
import { snapshot, guarded } from './core/brand.js';
import { Page } from './page.js';
import { standardFont } from './fonts/standard.js';
import { embedFont } from './fonts/embed.js';
import { createOutline } from './nav/outline.js';
import { namedDests } from './nav/dest.js';
import { createPageLabels } from './nav/labels.js';
import { createViewer } from './nav/viewer.js';
import { createTagger } from './tags/tags.js';
import { addOutputIntent } from './standards/pdfa.js';
import { pdfaLevel } from './standards/level.js';
import { createFiles } from './standards/files.js';
import { createFacturX } from './standards/facturx.js';
import { createLayers } from './standards/layers.js';
import { pageBoxes } from './standards/boxes.js';
import { spotColor, iccColorSpace } from './graphics/color.js';
import { embedImage } from './images/image.js';
import { createForm } from './forms/form.js';
import { encryptor } from './security/encrypt.js';
import { createSigning } from './security/sign.js';
import { hasher, HASHES } from './security/crypto.js';

export { Page } from './page.js';
export { STANDARD_NAMES } from './fonts/standard.js';
export { cmyk } from './graphics/color.js';
export { nodeSigner, cmsSigner } from './security/cms.js';
export { loadPdf } from './reader/pdf.js';
export { PdfReadError } from './reader/budget.js';
export { bulk, BULK_TASKS, __bulkWorker } from './bulk.js';

/**
 * Merge loaded documents (every page of each, in order) into a new file: the first document's catalog (form, outline,
 * files…) with what the others bring. @param {any[]} docs from loadPdf @param {any} [o] save()'s options
 */
export async function mergePdfs(docs, o) {
  if (!Array.isArray(docs) || !docs.length) throw new TypeError('mergePdfs: an array of documents from loadPdf');
  return docs[0].fork().merge(docs.slice(1)).save(o);
}

/**
 * @param {any} sink a Node Writable, a WritableStream, or { write(bytes) }
 * @param {import('../index.js').PdfOptions} [options]
 * @returns {import('../index.js').Pdf}
 */
export function createPdf(sink, options = {}) {
  const o = snapshot(options); // each option read once (core/brand.js)
  if (o == null || typeof o !== 'object') throw new TypeError('createPdf: options are an object');
  if (o.tagged && (o.title == null || o.title === '')) throw new TypeError('createPdf: a tagged PDF (PDF/UA) needs a title');
  if (o.creationDate != null && !(o.creationDate instanceof Date && !isNaN(+o.creationDate))) throw new TypeError('createPdf: creationDate must be a valid Date');
  if (o.id != null && !/^[0-9a-f]{32}$/i.test(o.id)) throw new TypeError('createPdf: id is 32 hex digits');
  for (const k of /** @type {const} */ (['title', 'author', 'subject', 'keywords'])) if (o[k] != null && (typeof o[k] !== 'string' || o[k].length > 65536)) throw new TypeError(`createPdf: ${k} is a string of at most 65,536 characters`);
  if (o.objectStreamLevel != null && !(Number.isInteger(o.objectStreamLevel) && o.objectStreamLevel >= 0 && o.objectStreamLevel <= 9)) throw new TypeError('createPdf: objectStreamLevel is a zlib level, an integer 0–9 (default 6)');
  if (o.metadata != null && typeof o.metadata !== 'boolean') throw new TypeError('createPdf: metadata is true (the default: an XMP stream) or false (Info only)');
  if (o.metadata === false && (o.pdfa || o.tagged)) throw new TypeError('createPdf: metadata: false cannot be combined with pdfa or tagged: PDF/A and PDF/UA require the XMP metadata stream');
  const level = pdfaLevel(o.pdfa, o.tagged);
  o.signal?.throwIfAborted();
  // one signal for every wait: the caller's and the time limit
  const ctl = new AbortController();
  const onAbort = () => ctl.abort(o.signal?.reason);
  o.signal?.addEventListener('abort', onAbort, { once: true });
  const ms = Number(o.timeoutMs);
  const timer = ms > 0 ? setTimeout(() => ctl.abort(Object.assign(new Error(`The PDF took longer than ${ms} ms (timeoutMs)`), { name: 'TimeoutError', code: 'ETIMEDOUT' })), ms) : null;
  /** @type {any} */ (timer)?.unref?.();
  const cleanup = () => { if (timer) clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort); };

  /** @type {string[]} */
  const early = []; // warnings before the document exists
  const enc = o.encrypt != null && /** @type {any} */ (o.encrypt) !== false ? encryptor(o.encrypt, { id: o.id, tagged: !!o.tagged, pdfa: !!o.pdfa, warn: (m) => early.push(m) }) : null;
  const signHash = o.sign == null || o.sign === false ? null : o.sign === true ? 'SHA-256' : typeof o.sign === 'object' ? o.sign.hash ?? 'SHA-256' : '';
  if (signHash != null && !HASHES.includes(signHash)) throw new TypeError(`createPdf: sign is true or { hash: ${HASHES.map((h) => `'${h}'`).join(' | ')} }`);
  const out = openSink(sink);
  const when = new Date(Math.floor((o.creationDate ?? new Date()).getTime() / 1000) * 1000);
  const doc = createDoc(out, {
    compress: o.compress !== false, objectStreamLevel: o.objectStreamLevel, pdfa: !!o.pdfa, pdfaLevel: level, tagged: !!o.tagged, metadata: o.metadata !== false, signal: ctl.signal, encrypt: enc, hash: signHash ? hasher(/** @type {any} */ (signHash)) : null,
    info: { title: o.title, author: o.author, subject: o.subject, keywords: o.keywords, creationDate: when }, id: o.id,
  });
  if (o.tagged) doc.tags = createTagger(doc, typeof o.tagged === 'object' ? o.tagged : {});
  if (o.pdfa) addOutputIntent(doc, o.pdfa);
  if (enc) {
    enc.ref = doc.reserve();
    enc.trailer = ` /Encrypt ${enc.ref} 0 R`;
    if (enc.extensions) doc.catalog('Extensions', enc.extensions);
    doc.onFinish(async () => doc.write(enc.ref, await enc.setup));
  }
  for (const m of early) doc.warn(m);
  const outline = createOutline(doc);
  const pageLabels = createPageLabels(doc);
  const viewer = createViewer(doc);
  const form = createForm(doc, o.form ?? {});
  const signing = createSigning(doc, form, { hash: signHash, when });
  const attach = createFiles(doc, when);
  const facturX = createFacturX(doc, attach);
  const layer = createLayers(doc);
  /** @type {Map<string, any>} */
  const standard = new Map();
  /** stop: a failure (or the signal) ends the export; a WritableStream is aborted so it is not left locked */
  const guard = (/** @type {Promise<any>} */ p) => p.catch((e) => {
    const err = ctl.signal.aborted ? ctl.signal.reason : e;
    cleanup(); out.abort(err);
    throw err;
  });
  let ended = false; // after pdf.end(), nothing may be written (an image or ICC stream would land after the xref)
  const live = () => { ctl.signal.throwIfAborted(); if (doc.failed) throw doc.failed; };
  const open = () => { live(); if (ended) throw new Error('The PDF has ended'); };

  const addPage = (/** @type {any} */ po = {}) => {
    const { width = 595.28, height = 841.89 } = po;
    live();
    if (!(width > 0 && height > 0 && width <= 14400 && height <= 14400)) throw new RangeError('addPage: width and height are 1–14400 points');
    const boxes = new Map(); // checked before the page exists: a bad box adds no page
    pageBoxes({ width, height, doc, entries: boxes }, po);
    const page = new Page(doc, doc.newPage({ height }), width, height);
    for (const [k, v] of boxes) page.entries.set(k, v);
    doc.opened(page);
    const end = page.end.bind(page);
    page.end = () => { live(); return guard(end()); };
    return page;
  };

  return /** @type {any} */ (guarded({
    core: doc,
    standardFont(name) {
      live();
      let f = standard.get(name);
      if (!f) standard.set(name, f = standardFont(doc, name));
      return f;
    },
    async embedFont(bytes, opt) { live(); return embedFont(doc, bytes, opt); },
    async embedImage(bytes, opt) { open(); return embedImage(doc, bytes, opt); },
    spotColor(name, alternate) { open(); return spotColor(doc, name, alternate); },
    async iccColorSpace(bytes) { open(); return iccColorSpace(doc, bytes); },
    addPage,
    outline(e) { live(); outline(e); },
    destination(name, page, fit) { open(); namedDests(doc).define(name, page, fit); },
    pageLabels(ranges) { open(); pageLabels(ranges); },
    viewer(o) { open(); viewer(o); },
    form,
    sign(field, opt) { open(); return signing(field, opt); },
    async attach(bytes, opt) { open(); return attach(bytes, opt); },
    async facturX(xml, opt) { open(); return facturX(xml, opt); },
    layer(name, opt) { open(); return layer(name, opt); },
    async end() {
      live();
      ended = true;
      const r = await guard(doc.finish(() => addPage()));
      await guard(out.close());
      cleanup();
      return r;
    },
  }));
}

/**
 * Build a PDF in memory. @param {(pdf: import('../index.js').Pdf) => any} build @param {import('../index.js').PdfOptions} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function toBytes(build, options) {
  /** @type {Uint8Array[]} */
  const parts = [];
  let n = 0;
  const pdf = createPdf({ write(/** @type {Uint8Array} */ b) { parts.push(b); n += b.length; } }, options);
  await build(pdf);
  await pdf.end();
  const all = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  return all;
}
