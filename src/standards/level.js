// @ts-check
/**
 * The PDF/A level from createPdf's `pdfa` option: true is PDF/A-2b (as before); { part: 1 | 2 | 3, conformance:
 * 'a' | 'b' | 'u', outputIntent } picks one. What each level means for the other modules (they read doc.pdfaLevel):
 *
 * | level | rules beyond PDF/A-2b's |
 * |---|---|
 * | 1b | PDF 1.4: no transparency (opacity, blend modes, soft masks: refused), no object or xref streams (a classic xref), no layers, no attachments, 8-bit images |
 * | 2u, 3u | every glyph drawn maps to Unicode: a character the font lacks throws instead of being dropped |
 * | 2a, 3a | as u, and tagged (createPdf's tagged option is required) |
 * | 3b, 3u, 3a | embedded files allowed (pdf.attach, pdf.facturX), each with /AFRelationship and listed in the catalog's /AF |
 *
 * 1a is not offered: PDF/A-1a's structure rules predate PDF/UA and this library's tagging is checked against PDF/UA-1
 * and PDF/A-2a/3a only.
 */

/** @typedef {{ part: 1 | 2 | 3, conformance: 'a' | 'b' | 'u', unicode: boolean }} Level */

/**
 * @param {any} pdfa createPdf's option @param {any} tagged @returns {Level | null}
 */
export function pdfaLevel(pdfa, tagged) {
  if (pdfa == null || pdfa === false) return null;
  if (pdfa === true) return { part: 2, conformance: 'b', unicode: false };
  if (typeof pdfa !== 'object') throw new TypeError('createPdf: pdfa is true or { part: 1 | 2 | 3, conformance: \'a\' | \'b\' | \'u\', outputIntent? }');
  const part = pdfa.part ?? 2, conformance = pdfa.conformance ?? 'b';
  if (part !== 1 && part !== 2 && part !== 3) throw new TypeError(`createPdf: pdfa.part is 1, 2 or 3, not ${JSON.stringify(part)}`);
  if (conformance !== 'a' && conformance !== 'b' && conformance !== 'u') throw new TypeError(`createPdf: pdfa.conformance is 'a', 'b' or 'u', not ${JSON.stringify(conformance)}`);
  if (part === 1 && conformance !== 'b') throw new TypeError(`createPdf: PDF/A-1${conformance} is not offered: use PDF/A-1b, or PDF/A-2${conformance} / PDF/A-3${conformance}`);
  if (conformance === 'a' && !tagged) throw new TypeError(`createPdf: PDF/A-${part}a is tagged PDF: pass tagged: { lang } too`);
  return { part, conformance, unicode: conformance !== 'b' };
}

/** throw when the document is PDF/A-1 (what: the feature, why: the rule) @param {any} doc @param {string} what @param {string} why */
export function refuseInA1(doc, what, why) {
  const d = doc.base ?? doc; // a pattern cell's stand-in
  if (d.pdfaLevel?.part === 1) throw new TypeError(`${what}: PDF/A-1 (ISO 19005-1) ${why}; use PDF/A-2 or 3 (pdfa: { part: 2 })`);
}
