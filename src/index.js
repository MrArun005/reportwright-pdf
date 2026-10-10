// @ts-check
/**
 * @reportwright/pdf: a streaming PDF writer. createPdf(sink, options) → pdf; toBytes(build, options) → Uint8Array.
 * See README.md for the API and ARCHITECTURE.md for the modules and their extension points.
 */
export { createPdf, toBytes } from './create.js';

export { Page } from './page.js';
export { svgPathOps } from './graphics/path.js';
export { STANDARD_NAMES } from './fonts/standard.js';
export { readFont, checkSubset } from './fonts/read.js';
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
