// @ts-check
/**
 * The XMP metadata packet (the catalog's /Metadata, uncompressed as PDF/A wants), mirroring the Info dictionary:
 * dc:title, dc:creator, dc:description, the dates, the producer; with PDF/A and PDF/UA identification. From
 * ReportWright's xmpPacket (src/exporters/pdfa.js).
 */
export const PRODUCER = '@reportwright/pdf';

/** a text value or attribute, escaped; C0 controls (but tab, LF, CR), lone surrogates and U+FFFE/FFFF dropped (XML 1.0 cannot carry them) @param {any} s */
export const xml = (s) => String(s)
  .replace(/[\0-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
  .replace(/[<>&"']/g, (c) => /** @type {any} */ ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

/** PDF/A wants every schema it does not predefine described in the file (pdfuaid is one). */
const PDFUA_SCHEMA = '<rdf:Description rdf:about="" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#"><pdfaExtension:schemas><rdf:Bag><rdf:li rdf:parseType="Resource"><pdfaSchema:schema>PDF/UA identification schema</pdfaSchema:schema><pdfaSchema:namespaceURI>http://www.aiim.org/pdfua/ns/id/</pdfaSchema:namespaceURI><pdfaSchema:prefix>pdfuaid</pdfaSchema:prefix><pdfaSchema:property><rdf:Seq><rdf:li rdf:parseType="Resource"><pdfaProperty:name>part</pdfaProperty:name><pdfaProperty:valueType>Integer</pdfaProperty:valueType><pdfaProperty:category>internal</pdfaProperty:category><pdfaProperty:description>PDF/UA version identifier</pdfaProperty:description></rdf:li></rdf:Seq></pdfaSchema:property></rdf:li></rdf:Bag></pdfaExtension:schemas></rdf:Description>\n';

/**
 * @param {{ title?: string, author?: string, subject?: string, stamp: string, pdfa?: string | null, ua?: boolean }} o
 *   stamp: ISO date to the second ("2026-01-01T00:00:00Z"); pdfa: the conformance level ("B") or null
 */
export function xmpPacket({ title, author, subject, stamp, pdfa = null, ua = false }) {
  const dc = `${title != null ? `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xml(title)}</rdf:li></rdf:Alt></dc:title>` : ''}${author != null ? `<dc:creator><rdf:Seq><rdf:li>${xml(author)}</rdf:li></rdf:Seq></dc:creator>` : ''}${subject != null ? `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xml(subject)}</rdf:li></rdf:Alt></dc:description>` : ''}`;
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
${pdfa ? `<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>2</pdfaid:part><pdfaid:conformance>${pdfa}</pdfaid:conformance></rdf:Description>\n` : ''}${ua ? '<rdf:Description rdf:about="" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/"><pdfuaid:part>1</pdfuaid:part></rdf:Description>\n' : ''}${ua && pdfa ? PDFUA_SCHEMA : ''}<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:format>application/pdf</dc:format>${dc}</rdf:Description>
<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/"><xmp:CreatorTool>${PRODUCER}</xmp:CreatorTool><xmp:CreateDate>${stamp}</xmp:CreateDate><xmp:ModifyDate>${stamp}</xmp:ModifyDate><xmp:MetadataDate>${stamp}</xmp:MetadataDate></rdf:Description>
<rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/"><pdf:Producer>${PRODUCER}</pdf:Producer></rdf:Description>
</rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}
