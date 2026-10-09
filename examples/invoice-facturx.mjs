// A self-contained Factur-X invoice: a tagged PDF/A-3a page drawn from the same data as the CII XML embedded in it.
// (examples/factur-x.mjs does the same from an XML file you already have.)
//
//   node examples/invoice-facturx.mjs font.ttf [out.pdf]     any TrueType font, e.g. Inter-Regular.ttf
//
// The XML below is a short EN 16931 skeleton for the example. pdf.facturX checks its root, profile ID and that it has
// no DOCTYPE or entities; it does not validate the invoice: run the Factur-X XSD and Schematron on real invoices.
import fs from 'node:fs';
import { createPdf } from '../dist/index.js';

const [fontFile, out = 'invoice-facturx.pdf'] = process.argv.slice(2);
if (!fontFile) { console.error('node examples/invoice-facturx.mjs font.ttf [out.pdf]'); process.exit(2); }
const inv = { number: 'INV-2026-001', date: '20261009', seller: 'Example Ltd', buyer: 'Acme GmbH', currency: 'EUR',
  lines: [['Consulting, 10 h', '1000.00'], ['Licence', '250.00']], net: '1250.00', vat: '237.50', total: '1487.50' };
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
<rsm:ExchangedDocumentContext><ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>urn:cen.eu:en16931:2017</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter></rsm:ExchangedDocumentContext>
<rsm:ExchangedDocument><ram:ID>${inv.number}</ram:ID><ram:TypeCode>380</ram:TypeCode><ram:IssueDateTime><udt:DateTimeString format="102">${inv.date}</udt:DateTimeString></ram:IssueDateTime></rsm:ExchangedDocument>
<rsm:SupplyChainTradeTransaction><ram:ApplicableHeaderTradeAgreement><ram:SellerTradeParty><ram:Name>${inv.seller}</ram:Name></ram:SellerTradeParty><ram:BuyerTradeParty><ram:Name>${inv.buyer}</ram:Name></ram:BuyerTradeParty></ram:ApplicableHeaderTradeAgreement>
<ram:ApplicableHeaderTradeSettlement><ram:InvoiceCurrencyCode>${inv.currency}</ram:InvoiceCurrencyCode><ram:SpecifiedTradeSettlementHeaderMonetarySummation><ram:TaxBasisTotalAmount>${inv.net}</ram:TaxBasisTotalAmount><ram:TaxTotalAmount currencyID="${inv.currency}">${inv.vat}</ram:TaxTotalAmount><ram:GrandTotalAmount>${inv.total}</ram:GrandTotalAmount><ram:DuePayableAmount>${inv.total}</ram:DuePayableAmount></ram:SpecifiedTradeSettlementHeaderMonetarySummation></ram:ApplicableHeaderTradeSettlement></rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;

const pdf = createPdf(fs.createWriteStream(out), {
  title: `Invoice ${inv.number}`, author: inv.seller, pdfa: { part: 3, conformance: 'a' }, tagged: { lang: 'en' },
});
const font = await pdf.embedFont(fs.readFileSync(fontFile));   // PDF/A: every font embedded
const page = pdf.addPage();
const t = (s, x, y, size = 11) => page.text(s, { x, y, font, size });
page.tag('H1', () => t(`Invoice ${inv.number}`, 56, 56, 22));
page.tag('P', () => t(`From ${inv.seller} to ${inv.buyer}`, 56, 96));
page.tag('Table', () => {
  page.tag('TR', () => ['Item', `Amount (${inv.currency})`].forEach((h, i) => page.tag('TH', () => t(h, 56 + i * 300, 140), { scope: 'Column', id: `h${i}` })));
  [...inv.lines, ['Net', inv.net], ['VAT 19%', inv.vat], ['Total', inv.total]].forEach(([item, amount], r) =>
    page.tag('TR', () => [item, amount].forEach((v, i) => page.tag('TD', () => t(v, 56 + i * 300, 162 + r * 20), { headers: [`h${i}`] }))));
});
page.stroke(page.path().moveTo(56, 156).lineTo(540, 156), { width: 0.5 });   // outside any tag: an artifact
await pdf.facturX(new TextEncoder().encode(xml), { profile: 'EN 16931' });
await page.end();
const { warnings } = await pdf.end();
console.log(`wrote ${out}: PDF/A-3a + factur-x.xml (EN 16931)`, warnings.length ? warnings : '');
