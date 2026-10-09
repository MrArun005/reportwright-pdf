// A Factur-X (ZUGFeRD 2.1+) invoice: a tagged PDF/A-3a page with the CII XML embedded as factur-x.xml.
//
//   node examples/factur-x.mjs invoice.xml font.ttf out.pdf [profile]
//
// The XML must be a UN/CEFACT CrossIndustryInvoice whose GuidelineSpecifiedDocumentContextParameter ID names the
// profile (EN 16931 by default: urn:cen.eu:en16931:2017). pdf.facturX checks that, refuses any DOCTYPE or entity, and
// writes the fx XMP schema; it does not validate the invoice itself (run the Factur-X XSD and Schematron for that).
// The page here only shows a few fields; a real one draws the whole invoice from the same data as the XML.
import fs from 'node:fs';
import { createPdf } from '../dist/index.js';

const [xmlFile, fontFile, outFile, profile = 'EN 16931'] = process.argv.slice(2);
if (!outFile) { console.error('node examples/factur-x.mjs invoice.xml font.ttf out.pdf [profile]'); process.exit(2); }
const xml = fs.readFileSync(xmlFile);
const text = xml.toString('utf8');
/** the first <ram:tag> after anchor (display only: the page shows a few fields of the XML) */
const field = (tag, anchor = '') => new RegExp(`${anchor}[\\s\\S]*?<ram:${tag}[^>]*>([^<]*)<`).exec(text)?.[1] ?? '';
const number = field('ID', '<rsm:ExchangedDocument>'), seller = field('Name', '<ram:SellerTradeParty>');

const pdf = createPdf(fs.createWriteStream(outFile), {
  title: `Invoice ${number}`, author: seller, subject: 'Factur-X invoice', keywords: `invoice, Factur-X, ${profile}`,
  pdfa: { part: 3, conformance: 'a' }, tagged: { lang: 'en' },
});
const font = await pdf.embedFont(fs.readFileSync(fontFile));
const page = pdf.addPage({ trimBox: [0, 0, 595.28, 841.89] });
const line = (s, y, size = 11) => page.text(s, { x: 56, y, font, size });
page.artifact({ type: 'Pagination', subtype: 'Header' }, () => line('Factur-X invoice: the XML inside this PDF is the legal invoice', 24, 8));
page.tag('H1', () => line(`Invoice ${number}`, 60, 22));
page.tag('P', () => line(`Seller: ${seller}`, 110));
page.tag('Table', () => {
  page.tag('TR', () => ['Net', 'VAT', 'Total'].forEach((h, i) => page.tag('TH', () => page.text(h, { x: 56 + i * 140, y: 150, font }), { scope: 'Column', id: `h${i}` })));
  page.tag('TR', () => [field('TaxBasisTotalAmount'), field('TaxTotalAmount'), field('GrandTotalAmount')].forEach((v, i) =>
    page.tag('TD', () => page.text(`${v} ${field('InvoiceCurrencyCode')}`, { x: 56 + i * 140, y: 170, font }), { headers: [`h${i}`] })));
});
await pdf.facturX(xml, { profile });
await pdf.end();
console.log(`wrote ${outFile}: PDF/A-3a with factur-x.xml (${profile})`);
