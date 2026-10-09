// @ts-check
/**
 * The XMP metadata packet (the catalog's /Metadata, uncompressed as PDF/A wants), mirroring the Info dictionary:
 * dc:title, dc:creator, dc:description, pdf:Keywords, the dates, the producer; with PDF/A and PDF/UA identification and
 * the PDF/A extension schemas that describe any property PDF/A does not predefine (pdfuaid, Factur-X's fx). From
 * ReportWright's xmpPacket (src/exporters/pdfa.js).
 *
 * SECURITY: the packet is built only from escaped values. Every text value goes through xml() (& < > " ' escaped, the
 * characters XML 1.0 cannot carry dropped), so a title of "</rdf:li><evil/>" stays text; schema prefixes and property
 * names are checked as XML names, namespace URIs as URIs without markup characters. No caller XML is ever inserted.
 */
export const PRODUCER = '@reportwright/pdf';

/** a text value or attribute, escaped; C0 controls (but tab, LF, CR), lone surrogates and U+FFFE/FFFF dropped (XML 1.0 cannot carry them) @param {any} s */
export const xml = (s) => String(s)
  .replace(/[\0-\x08\x0b\x0c\x0e-\x1f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
  .replace(/[<>&"']/g, (c) => /** @type {any} */ ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

/**
 * A PDF/A extension schema: the description PDF/A needs, and the values written.
 * @typedef {{ schema: string, ns: string, prefix: string, props: { name: string, type: 'Text' | 'Integer', category: 'internal' | 'external', description: string, value?: string | number }[] }} Extension
 */
const NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
/** @param {Extension} x */
function checkExt(x) {
  if (!NAME.test(x.prefix)) throw new TypeError(`XMP: the schema prefix ${JSON.stringify(x.prefix)} is not an XML name`);
  if (typeof x.ns !== 'string' || !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"'&]{1,256}$/.test(x.ns)) throw new TypeError(`XMP: the namespace ${JSON.stringify(x.ns)} is not a URI`);
  if (x.props.length > 64) throw new RangeError('XMP: at most 64 properties a schema');
  for (const p of x.props) {
    if (!NAME.test(p.name)) throw new TypeError(`XMP: the property name ${JSON.stringify(p.name)} is not an XML name`);
    if (p.type !== 'Text' && p.type !== 'Integer') throw new TypeError('XMP: a property is Text or Integer');
    if (p.category !== 'internal' && p.category !== 'external') throw new TypeError('XMP: a property is internal or external');
  }
}

const PDFUA = /** @type {Extension} */ ({ schema: 'PDF/UA identification schema', ns: 'http://www.aiim.org/pdfua/ns/id/', prefix: 'pdfuaid',
  props: [{ name: 'part', type: 'Integer', category: 'internal', description: 'PDF/UA version identifier', value: 1 }] });

/**
 * @param {{ title?: string, author?: string, subject?: string, keywords?: string, stamp: string, pdfa?: { part: number, conformance: string } | null, ua?: boolean, extensions?: Extension[] }} o
 *   stamp: ISO date to the second ("2026-01-01T00:00:00Z"); pdfa: the level, or null; extensions: more schemas (Factur-X)
 */
export function xmpPacket({ title, author, subject, keywords, stamp, pdfa = null, ua = false, extensions = [] }) {
  const exts = [...(ua ? [PDFUA] : []), ...extensions];
  exts.forEach(checkExt);
  const dc = `${title != null ? `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xml(title)}</rdf:li></rdf:Alt></dc:title>` : ''}${author != null ? `<dc:creator><rdf:Seq><rdf:li>${xml(author)}</rdf:li></rdf:Seq></dc:creator>` : ''}${subject != null ? `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xml(subject)}</rdf:li></rdf:Alt></dc:description>` : ''}`;
  const values = exts.map((x) => `<rdf:Description rdf:about="" xmlns:${x.prefix}="${xml(x.ns)}">${x.props.filter((p) => p.value != null).map((p) => `<${x.prefix}:${p.name}>${xml(p.value)}</${x.prefix}:${p.name}>`).join('')}</rdf:Description>\n`).join('');
  // PDF/A wants every schema it does not predefine described in the file, all in one pdfaExtension:schemas bag
  const described = pdfa && exts.length ? `<rdf:Description rdf:about="" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#"><pdfaExtension:schemas><rdf:Bag>${exts.map((x) => `<rdf:li rdf:parseType="Resource"><pdfaSchema:schema>${xml(x.schema)}</pdfaSchema:schema><pdfaSchema:namespaceURI>${xml(x.ns)}</pdfaSchema:namespaceURI><pdfaSchema:prefix>${x.prefix}</pdfaSchema:prefix><pdfaSchema:property><rdf:Seq>${x.props.map((p) => `<rdf:li rdf:parseType="Resource"><pdfaProperty:name>${p.name}</pdfaProperty:name><pdfaProperty:valueType>${p.type}</pdfaProperty:valueType><pdfaProperty:category>${p.category}</pdfaProperty:category><pdfaProperty:description>${xml(p.description)}</pdfaProperty:description></rdf:li>`).join('')}</rdf:Seq></pdfaSchema:property></rdf:li>`).join('')}</rdf:Bag></pdfaExtension:schemas></rdf:Description>\n` : '';
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
${pdfa ? `<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>${Number(pdfa.part)}</pdfaid:part><pdfaid:conformance>${xml(pdfa.conformance.toUpperCase())}</pdfaid:conformance></rdf:Description>\n` : ''}${values}${described}<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:format>application/pdf</dc:format>${dc}</rdf:Description>
<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/"><xmp:CreatorTool>${PRODUCER}</xmp:CreatorTool><xmp:CreateDate>${stamp}</xmp:CreateDate><xmp:ModifyDate>${stamp}</xmp:ModifyDate><xmp:MetadataDate>${stamp}</xmp:MetadataDate></rdf:Description>
<rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/"><pdf:Producer>${PRODUCER}</pdf:Producer>${keywords != null ? `<pdf:Keywords>${xml(keywords)}</pdf:Keywords>` : ''}</rdf:Description>
</rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}
