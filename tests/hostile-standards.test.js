// Hostile input for group G (standards): XMP injection through the document's metadata, Factur-X XML with a DOCTYPE,
// entities (billion laughs, external) or hiding tricks, oversized attachments, a huge layer count, spoofed attachment
// names, and hostile tag, box and extension-schema options. Each is refused or escaped, in under a second.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { toBytes, createPdf } from '../src/index.js';
import { xmpPacket } from '../src/standards/xmp.js';
import { readInvoice } from '../src/standards/facturx.js';
import { HAS, INTER, verapdf, latin, save } from './tools.js';
import { EN16931 } from './standards-fixture.js';

const fast = async (fn) => {
  const t = performance.now();
  await fn();
  const ms = performance.now() - t;
  expect(ms).toBeLessThan(1000);
  return ms;
};
const A3 = { title: 'Invoice', pdfa: { part: 3, conformance: 'b' }, creationDate: new Date('2026-01-01') };
const xmpOf = (b) => /<\?xpacket begin[\s\S]*?<\?xpacket end="w"\?>/.exec(latin(b))?.[0] ?? '';
const hasXmllint = (() => {
  try {
    execFileSync('which', ['xmllint'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const xml = (s) =>
  Buffer.from(
    EN16931.toString('utf8').replace(
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<?xml version="1.0" encoding="UTF-8"?>${s}`,
    ),
  );

describe('XMP injection', () => {
  const evil = '</rdf:li><evil/></rdf:Alt></dc:title><x:xmpmeta>&amp;\' " ]]> <?xpacket end="w"?>\u0001\u0008\ud800';
  it('title, author, subject and keywords are escaped: the packet stays well-formed, no element is injected; veraPDF 2b still passes', async () => {
    await fast(async () => {
      const out = await toBytes(
        async (pdf) => {
          const f = await pdf.embedFont(INTER);
          pdf.addPage().text('x', { x: 10, y: 10, font: f });
        },
        {
          title: evil,
          author: evil,
          subject: evil,
          keywords: evil,
          pdfa: true,
          creationDate: new Date('2026-01-01'),
          compress: false,
        },
      );
      const x = xmpOf(out);
      expect(x).not.toContain('<evil/>');
      expect(x).not.toMatch(/<x:xmpmeta>&/);
      expect(x.match(/<\?xpacket end="w"\?>/g)).toHaveLength(1);
      expect(x).toContain(
        '&lt;/rdf:li&gt;&lt;evil/&gt;&lt;/rdf:Alt&gt;&lt;/dc:title&gt;&lt;x:xmpmeta&gt;&amp;amp;&apos; &quot; ]]&gt; &lt;?xpacket end=&quot;w&quot;?&gt;',
      );
      expect(x).not.toMatch(/[\u0001\u0008]/);
      if (hasXmllint) execFileSync('xmllint', ['--noout', save(new TextEncoder().encode(x), 'xmp.xml')]); // throws when not well-formed
      globalThis.__hostileXmp = out;
    });
    if (HAS.verapdf) expect(verapdf(globalThis.__hostileXmp, '2b').failed).toEqual([]);
  }, 60000);

  it('extension schemas: prefixes and property names must be XML names, namespaces URIs without markup', () => {
    const base = { stamp: '2026-01-01T00:00:00Z', pdfa: { part: 3, conformance: 'b' } };
    const ext = (o) => () =>
      xmpPacket({
        ...base,
        extensions: [
          {
            schema: 'S',
            ns: 'urn:x:y#',
            prefix: 'fx',
            props: [{ name: 'A', type: 'Text', category: 'external', description: 'd', value: 'v' }],
            ...o,
          },
        ],
      });
    expect(ext({ prefix: 'fx"><evil' })).toThrow(/prefix .* is not an XML name/);
    expect(ext({ ns: 'urn:x"><evil/>' })).toThrow(/namespace .* is not a URI/);
    expect(ext({ props: [{ name: 'a><b', type: 'Text', category: 'external', description: 'd' }] })).toThrow(
      /property name/,
    );
    expect(ext({ props: [{ name: 'a', type: 'Bag', category: 'external', description: 'd' }] })).toThrow(
      /Text or Integer/,
    );
    expect(
      ext({
        props: Array.from({ length: 65 }, (_, i) => ({
          name: `p${i}`,
          type: 'Text',
          category: 'external',
          description: 'd',
        })),
      }),
    ).toThrow(/at most 64/);
    const ok = ext({
      schema: '<evil/>',
      props: [
        {
          name: 'A',
          type: 'Text',
          category: 'external',
          description: '</pdfaProperty:description><evil/>',
          value: '<evil/>',
        },
      ],
    })();
    expect(ok).not.toContain('<evil/>');
  });
});

describe('Factur-X XML is data', () => {
  const laughs =
    '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]>';
  const cases = {
    'billion laughs': laughs,
    'external entity (XXE)': '<!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>',
    'a bare DOCTYPE': '<!DOCTYPE rsm:CrossIndustryInvoice SYSTEM "http://example.com/cii.dtd">',
    'lower case doctype': '<!doctype x>',
    'a DOCTYPE after a comment': '<!-- a comment --><!DOCTYPE x [<!ENTITY a "b">]>',
    'an ENTITY alone': '<!ENTITY a "b">',
    'an ATTLIST': '<!ATTLIST a b CDATA "c">',
    'a parameter entity': '<!DOCTYPE x [<!ENTITY % p SYSTEM "http://example.com/p.dtd"> %p;]>',
  };
  for (const [what, s] of Object.entries(cases)) {
    it(`refuses ${what}`, async () => {
      const pdf = createPdf({ write() {} }, A3);
      await fast(() =>
        expect(pdf.facturX(xml(s), { profile: 'EN 16931' })).rejects.toThrow(/markup declaration .* refused/),
      );
    });
  }

  it('a DOCTYPE inside a comment or CDATA is text, not refused; an entity reference is never expanded', () => {
    expect(readInvoice(xml('<!-- <!DOCTYPE x> -->')).root).toBe('CrossIndustryInvoice');
    expect(readInvoice(Buffer.from('<a><![CDATA[<!DOCTYPE x>]]></a>')).root).toBe('a');
    const r = readInvoice(
      Buffer.from(
        EN16931.toString('utf8').replace(
          '<ram:ID>urn:cen.eu:en16931:2017</ram:ID>',
          '<ram:ID>&lol;urn:cen.eu:en16931:2017</ram:ID>',
        ),
      ),
    );
    expect(r.guideline).toBe('&lol;urn:cen.eu:en16931:2017'); // left as it is: no match for any profile
  });

  it('size cap (10 MB) before decoding; a 10 MB scan of hostile shapes is linear', async () => {
    const pdf = createPdf({ write() {} }, A3);
    await fast(() =>
      expect(pdf.facturX(new Uint8Array((10 << 20) + 1), { profile: 'EN 16931' })).rejects.toThrow(/over 10 MB/),
    );
    for (const body of [
      '<'.repeat(10 << (20 - 1)),
      '<!--'.repeat((10 << 20) / 4 - 1),
      `<a${' '.repeat((10 << 20) - 10)}>`,
      `<GuidelineSpecifiedDocumentContextParameter>${' '.repeat((10 << 20) - 100)}`,
    ]) {
      const ms = await fast(() => {
        try {
          readInvoice(Buffer.from(body));
        } catch {
          /* refused is fine */
        }
      });
      expect(ms).toBeLessThan(1000);
    }
  }, 30000);

  it('UTF-16, invalid UTF-8 and lone bytes are refused', async () => {
    const pdf = createPdf({ write() {} }, A3);
    const u16 = Buffer.from(`﻿${EN16931.toString('utf8')}`, 'utf16le');
    await expect(pdf.facturX(u16, { profile: 'EN 16931' })).rejects.toThrow(/not UTF-8/);
    await expect(pdf.facturX(new Uint8Array([0xc0, 0x80]), { profile: 'EN 16931' })).rejects.toThrow(/not UTF-8/);
  });
});

describe('attachments', () => {
  it('a 100 MB file is refused by maxBytes before it is copied', async () => {
    const big = new Uint8Array(100 << 20);
    const pdf = createPdf({ write() {} });
    await fast(() =>
      expect(pdf.attach(big, { name: 'big.csv', maxBytes: 10 << 20 })).rejects.toThrow(
        /104857600 bytes, over maxBytes \(10485760\)/,
      ),
    );
    await expect(pdf.attach(big, { name: 'big.csv', maxBytes: 1e12 })).rejects.toThrow(/maxBytes is 1 to/);
    await expect(pdf.attach(big, { name: 'big.csv', maxBytes: NaN })).rejects.toThrow(/maxBytes is 1 to/);
  });

  it('spoofed names are refused (bidi, zero-width, NTFS streams, device names, double extensions, dot and slash look-alikes, padding, executables)', async () => {
    const pdf = createPdf({ write() {} });
    const names = [
      'invoice‮fdp.exe',
      'invoice.pdf​.exe',
      'report.pdf:evil.exe',
      'CON.txt',
      'invoice.pdf.scr',
      'invoice．exe',
      'docs／x.pdf',
      'invoice.pdf' + ' '.repeat(40) + '.exe',
      'run.exe',
      'macro.docm',
      '.bashrc',
      'x'.repeat(300) + '.txt',
      'a\u0000.txt',
      'a\nb.txt',
    ];
    for (const n of names) await fast(() => expect(pdf.attach(new Uint8Array(1), { name: n }), n).rejects.toThrow());
    await expect(
      pdf.attach(new Uint8Array(1), { name: 'a.pdf', mimeType: 'application/x-msdownload' }),
    ).rejects.toThrow(/does not match/);
    await expect(pdf.attach(new Uint8Array(1), { name: 'a.txt', mimeType: 'text/plain"/JS' })).rejects.toThrow(
      /mimeType is type\/subtype/,
    );
    await expect(pdf.attach(new Uint8Array(1), { name: 'a.txt', description: 'x'.repeat(70000) })).rejects.toThrow(
      /description/,
    );
    expect((await pdf.end()).pages).toBe(1); // none was attached
  });

  it('at most 10,000 files', async () => {
    const pdf = createPdf({ write() {} });
    await fast(async () => {
      for (let i = 0; i < 10000; i++) await pdf.attach(new Uint8Array(0), { name: `f${i}.txt` });
    });
    await expect(pdf.attach(new Uint8Array(0), { name: 'one-more.txt' })).rejects.toThrow(
      /at most 10000 embedded files/,
    );
  }, 30000);
});

describe('layers, tags and boxes', () => {
  it('a huge layer count is capped at 10,000 (in < 1 s); names stay hex strings', async () => {
    const pdf = createPdf({ write() {} });
    await fast(() => {
      for (let i = 0; i < 10000; i++) pdf.layer(`L${i} /OpenAction << /S /JavaScript >>`);
    });
    expect(() => pdf.layer('one more')).toThrow(/at most 10000 layers/);
    await fast(() => pdf.end());
  });

  it('hostile tag options: huge header lists, id floods, injected names and spans are refused or bounded', async () => {
    const pdf = createPdf({ write() {} }, { title: 't', tagged: true }),
      p = pdf.addPage();
    p.tag('Table', () =>
      p.tag('TR', () => {
        expect(() => p.tag('TD', () => {}, { headers: Array.from({ length: 65 }, (_, i) => `h${i}`) })).toThrow(/1–64/);
        expect(() => p.tag('TD', () => {}, { headers: ['a> /JS (x)'] })).toThrow(/an id is/);
        expect(() => p.tag('TD', () => {}, { rowSpan: 1e12 })).toThrow(/whole number/);
      }),
    );
    expect(() => p.tag('P', () => {}, { alt: 'x'.repeat(70000) })).toThrow(/alt is a string of at most/);
    expect(() => p.tag('P', () => {}, { expansion: {} })).toThrow(/expansion is a string/);
    await fast(() => {
      for (let i = 0; i < 100000; i++) p.tag('Span', () => {}, { id: `i${i}` });
    });
    expect(() => p.tag('Span', () => {}, { id: 'over' })).toThrow(/at most 100000 ids/);
  }, 30000);

  it('hostile boxes: NaN, Infinity, huge, strings and objects are refused', () => {
    const pdf = createPdf({ write() {} });
    for (const b of [
      [NaN, 0, 1, 1],
      [0, 0, Infinity, 1],
      [0, 0, 1e12, 1],
      ['0', 0, 1, 1],
      { 0: 0, 1: 0, 2: 1, 3: 1, length: 4 },
      [0, 0, 1, 1, 1],
    ])
      expect(() => pdf.addPage({ cropBox: b }), JSON.stringify(b)).toThrow();
    expect(() => pdf.addPage({ rotate: '90' })).toThrow(/rotate/);
    expect(() => pdf.addPage({ userUnit: Infinity })).toThrow(/userUnit/);
    expect(pdf.core.pageCount).toBe(0);
  });
});
