// @ts-check
/**
 * @reportwright/pdf: a streaming PDF writer. createPdf(sink, options) → pdf; toBytes(build, options) → Uint8Array.
 * See README.md for the API and ARCHITECTURE.md for the modules and their extension points.
 */
import { openSink } from './core/sink.js';
import { createDoc } from './document.js';
import { Page } from './page.js';
import { standardFont } from './fonts/standard.js';
import { embedFont } from './fonts/embed.js';
import { createOutline } from './nav/outline.js';
import { createTagger } from './tags/tags.js';
import { addOutputIntent } from './standards/pdfa.js';

export { Page, install } from './page.js';
export { STANDARD_NAMES } from './fonts/standard.js';

/**
 * @param {any} sink a Node Writable, a WritableStream, or { write(bytes) }
 * @param {import('../index.js').PdfOptions} [options]
 * @returns {import('../index.js').Pdf}
 */
export function createPdf(sink, options = {}) {
  const o = options;
  if (o.tagged && (o.title == null || o.title === '')) throw new TypeError('createPdf: a tagged PDF (PDF/UA) needs a title');
  if (o.creationDate != null && !(o.creationDate instanceof Date && !isNaN(+o.creationDate))) throw new TypeError('createPdf: creationDate must be a valid Date');
  if (o.id != null && !/^[0-9a-f]{32}$/i.test(o.id)) throw new TypeError('createPdf: id is 32 hex digits');
  o.signal?.throwIfAborted();
  // one signal for every wait: the caller's and the time limit
  const ctl = new AbortController();
  const onAbort = () => ctl.abort(o.signal?.reason);
  o.signal?.addEventListener('abort', onAbort, { once: true });
  const ms = Number(o.timeoutMs);
  const timer = ms > 0 ? setTimeout(() => ctl.abort(Object.assign(new Error(`The PDF took longer than ${ms} ms (timeoutMs)`), { name: 'TimeoutError', code: 'ETIMEDOUT' })), ms) : null;
  /** @type {any} */ (timer)?.unref?.();
  const cleanup = () => { if (timer) clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort); };

  const out = openSink(sink);
  const when = new Date(Math.floor((o.creationDate ?? new Date()).getTime() / 1000) * 1000);
  const doc = createDoc(out, {
    compress: o.compress !== false, pdfa: !!o.pdfa, tagged: !!o.tagged, signal: ctl.signal, encrypt: /** @type {any} */ (o).encrypt || null,
    info: { title: o.title, author: o.author, subject: o.subject, creationDate: when }, id: o.id,
  });
  if (o.tagged) doc.tags = createTagger(doc, typeof o.tagged === 'object' ? o.tagged : {});
  if (o.pdfa) addOutputIntent(doc);
  const outline = createOutline(doc);
  /** @type {Map<string, any>} */
  const standard = new Map();
  /** stop: a failure (or the signal) ends the export; a WritableStream is aborted so it is not left locked */
  const guard = (/** @type {Promise<any>} */ p) => p.catch((e) => {
    const err = ctl.signal.aborted ? ctl.signal.reason : e;
    cleanup(); out.abort(err);
    throw err;
  });
  const live = () => { ctl.signal.throwIfAborted(); if (doc.failed) throw doc.failed; };

  const addPage = ({ width = 595.28, height = 841.89 } = {}) => {
    live();
    if (!(width > 0 && height > 0 && width <= 14400 && height <= 14400)) throw new RangeError('addPage: width and height are 1–14400 points');
    const page = new Page(doc, doc.newPage({ height }), width, height);
    doc.opened(page);
    const end = page.end.bind(page);
    page.end = () => { live(); return guard(end()); };
    return page;
  };

  return /** @type {any} */ ({
    core: doc,
    standardFont(name) {
      live();
      let f = standard.get(name);
      if (!f) standard.set(name, f = standardFont(doc, name));
      return f;
    },
    async embedFont(bytes, opt) { live(); return embedFont(doc, bytes, opt); },
    addPage,
    outline(e) { live(); outline(e); },
    async end() {
      live();
      const r = await guard(doc.finish(() => addPage()));
      await guard(out.close());
      cleanup();
      return r;
    },
  });
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
