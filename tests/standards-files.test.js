// Embedded files (pdf.attach) and Factur-X / ZUGFeRD / XRechnung (pdf.facturX), group G: the EmbeddedFiles name tree
// (sorted, balanced), /AF and /AFRelationship in PDF/A-3, pdfdetach's view, veraPDF A-3b/3u, the fx XMP schema, and
// (when FACTURX_PY points at a Python with the factur-x package) the XML extracted and XSD-checked by an independent tool.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFHexString, PDFString } from 'pdf-lib';
import { toBytes, createPdf } from '../src/index.js';
import { HAS, INTER, ROOT, verapdf, run, save, latin } from './tools.js';
import { DATE, CSV, EN16931 } from './standards-fixture.js';

const withGuideline = (id) => Buffer.from(EN16931.toString('utf8').replace('urn:cen.eu:en16931:2017', id));
const A3 = { title: 'Invoice 2026-001', pdfa: { part: 3, conformance: 'b' }, creationDate: DATE };
const page = async (pdf) => {
  const f = await pdf.embedFont(INTER);
  pdf.addPage().text('Invoice 2026-001: 120.00 EUR', { x: 40, y: 40, font: f });
};
const pdfdetach = (b) => run('pdfdetach', ['-list', save(b)]);
const xmpOf = (b) => /<\?xpacket begin[\s\S]*?<\?xpacket end="w"\?>/.exec(latin(b))?.[0] ?? '';
const str = (o) => (o instanceof PDFHexString || o instanceof PDFString ? o.decodeText() : String(o));

describe('pdf.attach', () => {
  it('files in a sorted name tree with Filespec F/UF/Desc/AFRelationship and EmbeddedFile Subtype/Params; pdfdetach lists them', async () => {
    const out = await toBytes(
      async (pdf) => {
        await page(pdf);
        await pdf.attach(CSV, {
          name: 'lines.csv',
          mimeType: 'text/csv',
          description: 'The invoice lines',
          relationship: 'Data',
        });
        await pdf.attach(new TextEncoder().encode('{"a":1}'), {
          name: 'Données.json',
          mimeType: 'application/json',
          relationship: 'Supplement',
          modified: new Date('2026-02-01'),
        });
        await pdf.attach(new Uint8Array([1, 2, 3]).buffer, { name: 'a-notes.txt' });
      },
      { title: 't', creationDate: DATE, compress: false },
    );
    if (HAS.poppler) {
      const l = pdfdetach(out);
      expect(l).toMatch(/^3 embedded files/);
      expect(l).toMatch(/1: Données\.json\n2: a-notes\.txt\n3: lines\.csv/); // sorted (UTF-16 code units: 'D' < 'a' < 'l')
      const dst = path.join(path.dirname(save(out, 'att.pdf')), 'lines-out.csv');
      run('pdfdetach', ['-save', '3', '-o', dst, save(out, 'att.pdf')]);
      expect(fs.readFileSync(dst, 'utf8')).toBe('item,qty\npen,2\n');
    }
    const doc = await PDFDocument.load(out);
    const tree = doc.catalog.lookup(PDFName.of('Names'), PDFDict).lookup(PDFName.of('EmbeddedFiles'), PDFDict);
    const names = tree.lookup(PDFName.of('Names'), PDFArray).asArray();
    expect(names.filter((_, i) => i % 2 === 0).map(str)).toEqual(['Données.json', 'a-notes.txt', 'lines.csv']);
    const spec = doc.context.lookup(names[5], PDFDict);
    expect(str(spec.get(PDFName.of('UF')))).toBe('lines.csv');
    expect(str(spec.get(PDFName.of('Desc')))).toBe('The invoice lines');
    expect(spec.get(PDFName.of('AFRelationship')).toString()).toBe('/Data');
    expect(latin(out)).toMatch(
      /\/Type \/EmbeddedFile \/Subtype \/text#2Fcsv \/Params << \/Size 15 \/CheckSum <[0-9a-f]{32}> \/CreationDate <[0-9a-f]+> \/ModDate <[0-9a-f]+> >>/,
    );
    expect(doc.catalog.get(PDFName.of('AF'))).toBeUndefined(); // only in PDF/A-3
  });

  it('5,000 files: a balanced tree with Limits (pdf-lib walks it), sorted as bytes', async () => {
    const out = await toBytes(
      async (pdf) => {
        for (let i = 0; i < 5000; i++)
          await pdf.attach(new Uint8Array([i & 255]), { name: `f${String((i * 7919) % 5000).padStart(4, '0')}.txt` });
      },
      { title: 't', creationDate: DATE },
    );
    const doc = await PDFDocument.load(out);
    const root = doc.catalog.lookup(PDFName.of('Names'), PDFDict).lookup(PDFName.of('EmbeddedFiles'), PDFDict);
    const keys = [];
    const walk = [root];
    while (walk.length) {
      const n = walk.shift();
      const kids = n.lookup(PDFName.of('Kids'));
      if (kids) for (const k of kids.asArray()) walk.push(doc.context.lookup(k, PDFDict));
      else {
        const a = n.lookup(PDFName.of('Names'), PDFArray).asArray();
        for (let i = 0; i < a.length; i += 2) keys.push(str(a[i]));
      }
    }
    expect(keys.length).toBe(5000);
    expect(keys).toEqual([...keys].sort());
    if (HAS.poppler) expect(pdfdetach(out)).toMatch(/^5000 embedded files/);
  }, 30000);

  it('PDF/A-3b and 3u: /AF in the catalog, each file with AFRelationship; veraPDF passes; PDF/A-2 refuses', async () => {
    for (const c of ['b', 'u']) {
      const out = await toBytes(
        async (pdf) => {
          await page(pdf);
          await pdf.attach(CSV, {
            name: 'lines.csv',
            mimeType: 'text/csv',
            relationship: 'Source',
            description: 'Lines',
          });
          await pdf.attach(new TextEncoder().encode('# Notes'), { name: 'notes.md', mimeType: 'text/markdown' });
        },
        { ...A3, pdfa: { part: 3, conformance: c } },
      );
      const doc = await PDFDocument.load(out);
      const af = doc.catalog
        .lookup(PDFName.of('AF'), PDFArray)
        .asArray()
        .map((r) => doc.context.lookup(r, PDFDict));
      expect(af.map((d) => [str(d.get(PDFName.of('UF'))), d.get(PDFName.of('AFRelationship')).toString()])).toEqual([
        ['lines.csv', '/Source'],
        ['notes.md', '/Unspecified'],
      ]);
      if (HAS.verapdf) expect(verapdf(out, `3${c}`).failed).toEqual([]);
    }
    const p2 = createPdf({ write() {} }, { title: 't', pdfa: true });
    await expect(p2.attach(CSV, { name: 'a.csv', mimeType: 'text/csv' })).rejects.toThrow(
      /PDF\/A-2 allows only PDF\/A files/,
    );
    const p3 = createPdf({ write() {} }, A3);
    await expect(p3.attach(CSV, { name: 'a.csv' })).rejects.toThrow(/PDF\/A-3 needs each embedded file's mimeType/);
  }, 60000);

  it('checks: names through checkFileName, MIME agreement, duplicates, relationship, sizes, after end', async () => {
    const pdf = createPdf({ write() {} }, { title: 't' });
    await expect(pdf.attach(CSV, { name: 'run.exe' })).rejects.toThrow(/\.exe is not an allowed type/);
    await expect(pdf.attach(CSV, { name: 'invoice‮fdp.exe' })).rejects.toThrow(/bidi/);
    await expect(pdf.attach(CSV, { name: 'a.pdf', mimeType: 'application/x-msdownload' })).rejects.toThrow(
      /does not match the extension/,
    );
    await expect(pdf.attach(CSV, { name: 'a.csv', relationship: 'Evil' })).rejects.toThrow(/relationship is one of/);
    await expect(pdf.attach(CSV, { name: 'a.csv', maxBytes: 4 })).rejects.toThrow(/over maxBytes/);
    await expect(pdf.attach('text', { name: 'a.csv' })).rejects.toThrow(/Uint8Array/);
    await expect(pdf.attach(CSV)).rejects.toThrow(/options with the file's name/);
    await pdf.attach(CSV, { name: 'a.csv' });
    await expect(pdf.attach(CSV, { name: 'a.csv' })).rejects.toThrow(/already attached/);
    await pdf.end();
    await expect(pdf.attach(CSV, { name: 'b.csv' })).rejects.toThrow(/ended/);
  });
});

describe('pdf.facturX', () => {
  it('EN 16931: factur-x.xml, text/xml, AFRelationship Alternative, in /AF; the fx XMP schema; veraPDF A-3b passes', async () => {
    const out = await toBytes(async (pdf) => {
      await page(pdf);
      await pdf.facturX(EN16931, { profile: 'EN 16931' });
    }, A3);
    if (HAS.verapdf) expect(verapdf(out, '3b').failed).toEqual([]);
    if (HAS.poppler) expect(pdfdetach(out)).toBe('1 embedded files\n1: factur-x.xml\n');
    const doc = await PDFDocument.load(out);
    const [spec] = doc.catalog
      .lookup(PDFName.of('AF'), PDFArray)
      .asArray()
      .map((r) => doc.context.lookup(r, PDFDict));
    expect(str(spec.get(PDFName.of('F')))).toBe('factur-x.xml');
    expect(spec.get(PDFName.of('AFRelationship')).toString()).toBe('/Alternative');
    const x = xmpOf(out);
    expect(x).toContain(
      '<rdf:Description rdf:about="" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#"><fx:DocumentFileName>factur-x.xml</fx:DocumentFileName><fx:DocumentType>INVOICE</fx:DocumentType><fx:Version>1.0</fx:Version><fx:ConformanceLevel>EN 16931</fx:ConformanceLevel></rdf:Description>',
    );
    expect(x).toContain(
      '<pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema><pdfaSchema:namespaceURI>urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#</pdfaSchema:namespaceURI><pdfaSchema:prefix>fx</pdfaSchema:prefix>',
    );
    for (const p of ['DocumentFileName', 'DocumentType', 'Version', 'ConformanceLevel'])
      expect(x).toContain(
        `<pdfaProperty:name>${p}</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category>`,
      );
    expect(
      latin(
        await toBytes(
          async (pdf) => {
            await page(pdf);
            await pdf.facturX(EN16931, { profile: 'EN 16931' });
          },
          { ...A3, compress: false },
        ),
      ),
    ).toContain('/Subtype /text#2Fxml');
  }, 60000);

  it('profiles: MINIMUM and BASIC WL are Data, the others Alternative; XRECHNUNG is xrechnung.xml; tagged 3a with UA passes', async () => {
    const cases = [
      ['MINIMUM', 'urn:factur-x.eu:1p0:minimum', 'Data', 'factur-x.xml'],
      ['BASIC WL', 'urn:factur-x.eu:1p0:basicwl', 'Data', 'factur-x.xml'],
      ['BASIC', 'urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic', 'Alternative', 'factur-x.xml'],
      ['EXTENDED', 'urn:cen.eu:en16931:2017#conformant#urn:factur-x.eu:1p0:extended', 'Alternative', 'factur-x.xml'],
      [
        'XRECHNUNG',
        'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0',
        'Alternative',
        'xrechnung.xml',
      ],
    ];
    for (const [profile, id, rel, name] of cases) {
      const out = await toBytes(async (pdf) => {
        await page(pdf);
        await pdf.facturX(withGuideline(id), { profile });
      }, A3);
      const doc = await PDFDocument.load(out);
      const [spec] = doc.catalog
        .lookup(PDFName.of('AF'), PDFArray)
        .asArray()
        .map((r) => doc.context.lookup(r, PDFDict));
      expect([str(spec.get(PDFName.of('UF'))), spec.get(PDFName.of('AFRelationship')).toString()]).toEqual([
        name,
        `/${rel}`,
      ]);
      expect(xmpOf(out)).toContain(
        `<fx:DocumentFileName>${name}</fx:DocumentFileName><fx:DocumentType>INVOICE</fx:DocumentType><fx:Version>1.0</fx:Version><fx:ConformanceLevel>${profile}</fx:ConformanceLevel>`,
      );
    }
    if (HAS.verapdf) {
      const a = await toBytes(
        async (pdf) => {
          const f = await pdf.embedFont(INTER),
            p = pdf.addPage();
          p.tag('H1', () => p.text('Invoice 2026-001', { x: 40, y: 40, font: f, size: 18 }));
          p.tag('P', () => p.text('Total: 120.00 EUR', { x: 40, y: 80, font: f }));
          await pdf.facturX(EN16931, { profile: 'EN 16931' });
        },
        { ...A3, pdfa: { part: 3, conformance: 'a' }, tagged: { lang: 'en' } },
      );
      expect(verapdf(a, '3a').failed).toEqual([]);
      expect(verapdf(a, 'ua1').failed).toEqual([]);
      expect(xmpOf(a)).toMatch(
        /<pdfaSchema:prefix>pdfuaid<\/pdfaSchema:prefix>[\s\S]*<pdfaSchema:prefix>fx<\/pdfaSchema:prefix>/,
      ); // one bag, both schemas
    }
  }, 60000);

  it('checks: PDF/A-3 required, one invoice, the profile must match the XML, the root must be CrossIndustryInvoice, UTF-8', async () => {
    await expect(createPdf({ write() {} }, { title: 't' }).facturX(EN16931, { profile: 'EN 16931' })).rejects.toThrow(
      /PDF\/A-3 file/,
    );
    await expect(
      createPdf({ write() {} }, { title: 't', pdfa: true }).facturX(EN16931, { profile: 'EN 16931' }),
    ).rejects.toThrow(/PDF\/A-3 file/);
    const pdf = createPdf({ write() {} }, A3);
    await expect(pdf.facturX(EN16931, { profile: 'BASIC' })).rejects.toThrow(
      /GuidelineSpecifiedDocumentContextParameter ID is "urn:cen.eu:en16931:2017", which is not the BASIC profile/,
    );
    await expect(pdf.facturX(EN16931, { profile: 'GOLD' })).rejects.toThrow(/profile is one of/);
    await expect(pdf.facturX(EN16931, { profile: 'EN 16931', version: '2.0' })).rejects.toThrow(/version is '1.0'/);
    await expect(
      pdf.facturX(
        Buffer.from('<?xml version="1.0"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"/>'),
        { profile: 'EN 16931' },
      ),
    ).rejects.toThrow(/root is "Invoice", not CrossIndustryInvoice/);
    await expect(pdf.facturX(new Uint8Array([0x3c, 0xff, 0xfe, 0x3e]), { profile: 'EN 16931' })).rejects.toThrow(
      /not UTF-8/,
    );
    await expect(pdf.facturX('<xml/>', { profile: 'EN 16931' })).rejects.toThrow(/bytes/);
    await pdf.facturX(EN16931, { profile: 'EN 16931' });
    await expect(pdf.facturX(EN16931, { profile: 'EN 16931' })).rejects.toThrow(/one invoice a document/);
    await pdf.end();
  });

  it.skipIf(!process.env.FACTURX_PY)(
    'the factur-x Python package (akretion) finds factur-x.xml in the PDF and checks it against the Factur-X XSD',
    async () => {
      const out = await toBytes(async (pdf) => {
        await page(pdf);
        await pdf.facturX(EN16931, { profile: 'EN 16931' });
      }, A3);
      const file = save(out, 'fx.pdf');
      const py =
        'import sys, facturx\nfrom lxml import etree\nn, x = facturx.get_xml_from_pdf(open(sys.argv[1], "rb").read(), check_xsd=True)\nr = etree.fromstring(x)\nprint(n, facturx.get_flavor(r), facturx.get_level(r, "factur-x"))';
      const res = execFileSync(process.env.FACTURX_PY, ['-c', py, file], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      expect(res.trim()).toBe('factur-x.xml factur-x en16931');
    },
    60000,
  );
});

describe('examples/factur-x.mjs', () => {
  it('writes a tagged PDF/A-3a invoice with factur-x.xml that passes veraPDF 3a and PDF/UA-1', async () => {
    execFileSync(process.execPath, [path.join(ROOT, 'build.mjs')]);
    const out = path.join(path.dirname(save(new Uint8Array(0), 'placeholder.pdf')), 'example-fx.pdf');
    execFileSync(
      process.execPath,
      [
        path.join(ROOT, 'examples/factur-x.mjs'),
        path.join(ROOT, 'tests/fixtures/facturx/en16931.xml'),
        path.join(ROOT, 'public/fonts/Inter-Regular.ttf'),
        out,
      ],
      { stdio: 'ignore' },
    );
    const b = new Uint8Array(fs.readFileSync(out));
    if (HAS.poppler) expect(pdfdetach(b)).toBe('1 embedded files\n1: factur-x.xml\n');
    if (HAS.verapdf) {
      expect(verapdf(b, '3a').failed).toEqual([]);
      expect(verapdf(b, 'ua1').failed).toEqual([]);
    }
  }, 60000);
});
