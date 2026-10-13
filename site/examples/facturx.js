// Factur-X / ZUGFeRD: a tagged PDF/A-3a invoice with the EN 16931 CII XML attached, drawn from the same data.
// pdf.facturX checks the XML's root, profile and that it has no DOCTYPE; validate real invoices with the Factur-X XSD.
import { toBytes } from '@reportwright/pdf';

const FONTS = 'https://cdn.jsdelivr.net/gh/MrArun005/reportwright-pdf@main/public/fonts/';
const inter = new Uint8Array(await (await fetch(FONTS + 'Inter-Regular.ttf')).arrayBuffer());

const inv = { number: 'INV-2026-001', date: '20261009', due: '20261108', seller: 'Example Ltd', sellerVat: 'DE123456789',
  buyer: 'Acme GmbH', currency: 'EUR', vatRate: '19.00',
  // [description, quantity, UN/ECE unit, unit price, line net]
  lines: [['Consulting, 10 h', '10', 'HUR', '100.00', '1000.00'], ['Licence', '1', 'C62', '250.00', '250.00']],
  net: '1250.00', vat: '237.50', total: '1487.50' };
const line = ([name, qty, unit, price, amount], i) => `<ram:IncludedSupplyChainTradeLineItem>
<ram:AssociatedDocumentLineDocument><ram:LineID>${i + 1}</ram:LineID></ram:AssociatedDocumentLineDocument>
<ram:SpecifiedTradeProduct><ram:Name>${name}</ram:Name></ram:SpecifiedTradeProduct>
<ram:SpecifiedLineTradeAgreement><ram:NetPriceProductTradePrice><ram:ChargeAmount>${price}</ram:ChargeAmount></ram:NetPriceProductTradePrice></ram:SpecifiedLineTradeAgreement>
<ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="${unit}">${qty}</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>
<ram:SpecifiedLineTradeSettlement><ram:ApplicableTradeTax><ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>S</ram:CategoryCode><ram:RateApplicablePercent>${inv.vatRate}</ram:RateApplicablePercent></ram:ApplicableTradeTax>
<ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>${amount}</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation></ram:SpecifiedLineTradeSettlement>
</ram:IncludedSupplyChainTradeLineItem>`;
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
<rsm:ExchangedDocumentContext><ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>urn:cen.eu:en16931:2017</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter></rsm:ExchangedDocumentContext>
<rsm:ExchangedDocument><ram:ID>${inv.number}</ram:ID><ram:TypeCode>380</ram:TypeCode><ram:IssueDateTime><udt:DateTimeString format="102">${inv.date}</udt:DateTimeString></ram:IssueDateTime></rsm:ExchangedDocument>
<rsm:SupplyChainTradeTransaction>
${inv.lines.map(line).join('\n')}
<ram:ApplicableHeaderTradeAgreement>
<ram:SellerTradeParty><ram:Name>${inv.seller}</ram:Name><ram:PostalTradeAddress><ram:CountryID>DE</ram:CountryID></ram:PostalTradeAddress><ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${inv.sellerVat}</ram:ID></ram:SpecifiedTaxRegistration></ram:SellerTradeParty>
<ram:BuyerTradeParty><ram:Name>${inv.buyer}</ram:Name><ram:PostalTradeAddress><ram:CountryID>DE</ram:CountryID></ram:PostalTradeAddress></ram:BuyerTradeParty>
</ram:ApplicableHeaderTradeAgreement>
<ram:ApplicableHeaderTradeDelivery/>
<ram:ApplicableHeaderTradeSettlement><ram:InvoiceCurrencyCode>${inv.currency}</ram:InvoiceCurrencyCode>
<ram:ApplicableTradeTax><ram:CalculatedAmount>${inv.vat}</ram:CalculatedAmount><ram:TypeCode>VAT</ram:TypeCode><ram:BasisAmount>${inv.net}</ram:BasisAmount><ram:CategoryCode>S</ram:CategoryCode><ram:RateApplicablePercent>${inv.vatRate}</ram:RateApplicablePercent></ram:ApplicableTradeTax>
<ram:SpecifiedTradePaymentTerms><ram:DueDateDateTime><udt:DateTimeString format="102">${inv.due}</udt:DateTimeString></ram:DueDateDateTime></ram:SpecifiedTradePaymentTerms>
<ram:SpecifiedTradeSettlementHeaderMonetarySummation><ram:LineTotalAmount>${inv.net}</ram:LineTotalAmount><ram:TaxBasisTotalAmount>${inv.net}</ram:TaxBasisTotalAmount><ram:TaxTotalAmount currencyID="${inv.currency}">${inv.vat}</ram:TaxTotalAmount><ram:GrandTotalAmount>${inv.total}</ram:GrandTotalAmount><ram:DuePayableAmount>${inv.total}</ram:DuePayableAmount></ram:SpecifiedTradeSettlementHeaderMonetarySummation>
</ram:ApplicableHeaderTradeSettlement>
</rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;

const bytes = await toBytes(async (pdf) => {
  const font = await pdf.embedFont(inter);                      // PDF/A: every font embedded
  const page = pdf.addPage();
  const t = (s, x, y, size = 11) => page.text(s, { x, y, font, size });
  page.tag('H1', () => t(`Invoice ${inv.number}`, 56, 56, 22));
  page.tag('P', () => t(`From ${inv.seller} to ${inv.buyer}`, 56, 96));
  page.tag('Table', () => {
    page.tag('TR', () => ['Item', `Amount (${inv.currency})`].forEach((h, i) => page.tag('TH', () => t(h, 56 + i * 300, 140), { scope: 'Column', id: `h${i}` })));
    [...inv.lines.map(([name, , , , amount]) => [name, amount]), ['Net', inv.net], ['VAT 19%', inv.vat], ['Total', inv.total]].forEach(([item, amount], r) =>
      page.tag('TR', () => [item, amount].forEach((v, i) => page.tag('TD', () => t(v, 56 + i * 300, 162 + r * 20), { headers: [`h${i}`] }))));
  });
  page.stroke(page.path().moveTo(56, 156).lineTo(540, 156), { width: 0.5 });   // outside any tag: an artifact
  await pdf.facturX(new TextEncoder().encode(xml), { profile: 'EN 16931' });
  await page.end();
}, { title: `Invoice ${inv.number}`, author: inv.seller, pdfa: { part: 3, conformance: 'a' }, tagged: { lang: 'en' } });

log('PDF/A-3a + factur-x.xml (EN 16931),', bytes.length, 'bytes');
show(bytes, 'invoice-facturx.pdf');
