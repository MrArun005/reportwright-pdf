// @ts-check
/**
 * pdf.facturX(xml, { profile, version }): a Factur-X 1.0 / ZUGFeRD 2.1+ hybrid invoice (also XRechnung in a PDF): the CII
 * XML embedded as factur-x.xml (xrechnung.xml for XRECHNUNG), MIME text/xml, /AFRelationship Data for MINIMUM and
 * BASIC WL (they are not a full invoice) and Alternative for the others (Factur-X 1.0.07 §6.2.2), listed in the
 * catalog's /AF; and the fx: XMP properties with their PDF/A extension schema (Factur-X 1.0.07 §6.2.3, Appendix
 * "XMP extension schema"). Requires PDF/A-3.
 *
 * The XML is DATA. It is never parsed with a general XML parser: a size-capped, linear scan (no entity expansion, no
 * recursion) refuses any DOCTYPE, ENTITY or other markup declaration, reads the root element's name (it must be
 * CrossIndustryInvoice) and the one ExchangedDocumentContext > GuidelineSpecifiedDocumentContextParameter > ID, which
 * must name the profile given (comments, CDATA sections and processing instructions are cut out first: text in them is
 * never read as the guideline).
 * Not checked: the CII schema and the EN 16931 / Factur-X business rules (Schematron); validate the XML with the
 * official tools before it is embedded.
 */
import { createFiles } from './files.js';

export const MAX_XML = 10 << 20;
/** profile → [the guideline ID (or its prefix, for XRECHNUNG's versions), its AFRelationship] */
export const PROFILES = /** @type {Record<string, [string, 'Data' | 'Alternative']>} */ ({
  MINIMUM: ['urn:factur-x.eu:1p0:minimum', 'Data'],
  'BASIC WL': ['urn:factur-x.eu:1p0:basicwl', 'Data'],
  BASIC: ['urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic', 'Alternative'],
  'EN 16931': ['urn:cen.eu:en16931:2017', 'Alternative'],
  EXTENDED: ['urn:cen.eu:en16931:2017#conformant#urn:factur-x.eu:1p0:extended', 'Alternative'],
  XRECHNUNG: ['urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_', 'Alternative'],
});
const FX_NS = 'urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#';

/**
 * Read what the embedding needs from the invoice XML, refusing anything that could expand: the root's local name and
 * the guideline ID. @param {Uint8Array} b @returns {{ root: string, guideline: string | null }}
 */
export function readInvoice(b) {
  if (b.length > MAX_XML) throw new RangeError(`pdf.facturX: the XML is ${b.length} bytes, over ${MAX_XML >> 20} MB`);
  let s;
  try { s = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(b); } catch { throw new TypeError('pdf.facturX: the XML is not UTF-8 (Factur-X invoices are UTF-8)'); }
  // markup that is not elements is cut out before anything is read (a comment, CDATA section or processing
  // instruction can hold text that looks like a guideline); any other "<!" is a markup declaration and is refused
  const re = /<!--|<!\[CDATA\[|<\?|<!/g;
  let clean = '', from = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const open = m[0], close = open === '<!--' ? '-->' : open === '<?' ? '?>' : open === '<!' ? '' : ']]>';
    if (!close) throw new TypeError(`pdf.facturX: the XML has a markup declaration (${JSON.stringify(s.slice(m.index, m.index + 10))}…): a DOCTYPE or ENTITY is refused (entity expansion); a Factur-X invoice has none`);
    const e = s.indexOf(close, m.index + open.length);
    if (e < 0) throw new TypeError(`pdf.facturX: the XML has an unterminated ${open === '<?' ? 'processing instruction' : open === '<!--' ? 'comment' : 'CDATA section'}`);
    clean += `${s.slice(from, m.index)} `;
    from = re.lastIndex = e + close.length;
  }
  clean += s.slice(from);
  const root = /^\s*<(?:[A-Za-z_][\w.-]{0,63}:)?([A-Za-z_][\w.-]{0,63})[\s/>]/.exec(clean.slice(0, 4096))?.[1] ?? '';
  // ExchangedDocumentContext > GuidelineSpecifiedDocumentContextParameter > ID, exactly one
  const ids = [];
  for (const ctx of elements(clean, 'ExchangedDocumentContext')) for (const g of elements(ctx, 'GuidelineSpecifiedDocumentContextParameter')) ids.push(...elements(g, 'ID'));
  const ent = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const guideline = ids.length === 1 && !ids[0].includes('<') ? ids[0].replace(/&(amp|lt|gt|quot|apos);/g, (_, k) => /** @type {any} */ (ent)[k]).trim() : null;
  return { root, guideline };
}

/**
 * The contents of every element with this local name (any prefix), in a string without comments, CDATA or PIs; linear
 * (indexOf for each closing tag). An element nested in one of the same name is not a CII shape: the outer one wins.
 * @param {string} s @param {string} local @returns {string[]}
 */
function elements(s, local) {
  const out = [], re = new RegExp(`<((?:[A-Za-z_][\\w.-]{0,63}:)?${local})(?=[\\s/>])[^<>]{0,4096}>`, 'g');
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m[0].endsWith('/>')) { out.push(''); continue; }
    const closeRe = new RegExp(`</${m[1].replace(/\./g, "\\.")}\\s{0,4096}>`, 'g');
    closeRe.lastIndex = re.lastIndex;
    const c = closeRe.exec(s);
    if (!c) break;
    out.push(s.slice(re.lastIndex, c.index));
    re.lastIndex = closeRe.lastIndex;
  }
  return out;
}

/** @param {import('../document.js').Doc} doc @param {ReturnType<typeof createFiles>} attach */
export function createFacturX(doc, attach) {
  let done = false;
  /** @param {any} xml @param {{ profile: string, version?: string }} o */
  return async function facturX(xml, o) {
    const who = 'pdf.facturX';
    const L = doc.pdfaLevel;
    if (L?.part !== 3) throw new TypeError(`${who}: a Factur-X / ZUGFeRD invoice is a PDF/A-3 file: createPdf(sink, { pdfa: { part: 3, conformance: 'b' } })`);
    if (done) throw new TypeError(`${who}: one invoice a document`);
    const profile = o?.profile, version = o?.version ?? '1.0';
    const p = typeof profile === 'string' && Object.hasOwn(PROFILES, profile) ? PROFILES[profile] : null;
    if (typeof profile !== 'string' || !p) throw new TypeError(`${who}: profile is one of ${Object.keys(PROFILES).map((k) => `'${k}'`).join(', ')}`);
    if (version !== '1.0') throw new TypeError(`${who}: version is '1.0' (Factur-X 1.0, ZUGFeRD 2.1 and later)`);
    if (!(xml instanceof ArrayBuffer || ArrayBuffer.isView(xml))) throw new TypeError(`${who}: the XML is bytes (a Uint8Array, Buffer or ArrayBuffer)`);
    const b = xml instanceof ArrayBuffer ? new Uint8Array(xml) : new Uint8Array(xml.buffer, xml.byteOffset, xml.byteLength);
    const inv = readInvoice(b);
    if (inv.root !== 'CrossIndustryInvoice') throw new TypeError(`${who}: the XML's root is ${JSON.stringify(inv.root)}, not CrossIndustryInvoice (a UN/CEFACT CII invoice)`);
    const ok = profile === 'XRECHNUNG' ? inv.guideline?.startsWith(p[0]) : inv.guideline === p[0];
    if (!ok) throw new TypeError(`${who}: the XML's GuidelineSpecifiedDocumentContextParameter ID is ${JSON.stringify(inv.guideline)}, which is not the ${profile} profile (${p[0]}${profile === 'XRECHNUNG' ? '…' : ''})`);
    const name = profile === 'XRECHNUNG' ? 'xrechnung.xml' : 'factur-x.xml';
    await attach(b, { name, mimeType: 'text/xml', allowTypes: ['xml'] /* xml is not passive by default; the invoice is checked above */, relationship: p[1], description: profile === 'XRECHNUNG' ? 'XRechnung invoice' : 'Factur-X invoice', maxBytes: MAX_XML }, who);
    done = true;
    doc.xmpExtensions.push({
      schema: 'Factur-X PDFA Extension Schema', ns: FX_NS, prefix: 'fx', props: [
        { name: 'DocumentFileName', type: 'Text', category: 'external', description: 'The name of the embedded XML document', value: name },
        { name: 'DocumentType', type: 'Text', category: 'external', description: 'The type of the hybrid document in capital letters, e.g. INVOICE or ORDER', value: 'INVOICE' },
        { name: 'Version', type: 'Text', category: 'external', description: 'The actual version of the standard applying to the embedded XML document', value: version },
        { name: 'ConformanceLevel', type: 'Text', category: 'external', description: 'The conformance level of the embedded XML document', value: profile },
      ],
    });
  };
}
