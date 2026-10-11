// @reportwright/pdf phase 1: pages, standard-font text, lines, rectangles, colours, links, outline, metadata,
// compression, determinism. Checked with poppler (pdftotext, pdfinfo, pdftohtml) and pdf-lib as an independent parser.
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFDict, PDFArray } from 'pdf-lib';
import { unzlibSync } from 'fflate';
import { createPdf, toBytes, STANDARD_NAMES } from '../src/index.js';
import { HAS, pdftotext, pdfinfo, run, save, latin } from './tools.js';

const DATE = new Date('2026-01-02T03:04:05.678Z');
/** the content stream of page i, inflated */
async function content(bytes, i = 0) {
  const doc = await PDFDocument.load(bytes);
  const c = doc.getPage(i).node.Contents();
  const raw = c.getContents();
  return Buffer.from(c.dict.get(PDFName.of('Filter')) ? unzlibSync(raw) : raw).toString('latin1');
}

describe('pages', () => {
  it('writes pages of any size; an empty document gets one A4 page', async () => {
    const out = await toBytes(
      (pdf) => {
        pdf.addPage();
        pdf.addPage({ width: 300, height: 400 });
        pdf.addPage({ width: 842, height: 595 });
      },
      { creationDate: DATE },
    );
    const doc = await PDFDocument.load(out);
    expect(doc.getPages().map((p) => [p.getWidth(), p.getHeight()])).toEqual([
      [595.28, 841.89],
      [300, 400],
      [842, 595],
    ]);
    const empty = await PDFDocument.load(await toBytes(() => {}, { creationDate: DATE }));
    expect(empty.getPageCount()).toBe(1);
    if (HAS.poppler) expect(pdfinfo(out)).toMatch(/Pages:\s+3/);
  });

  it('a page tree deeper than one level (200 pages, 64 a leaf) keeps page order', async () => {
    const out = await toBytes(
      async (pdf) => {
        const f = pdf.standardFont('Helvetica');
        for (let i = 1; i <= 200; i++) {
          const p = pdf.addPage({ width: 200, height: 100 });
          p.text(`Page ${i}`, { x: 10, y: 10, font: f });
          await p.end();
        }
      },
      { creationDate: DATE },
    );
    expect((await PDFDocument.load(out)).getPageCount()).toBe(200);
    if (HAS.poppler) {
      expect(run('pdftotext', ['-f', '137', '-l', '137', save(out), '-'])).toMatch('Page 137');
      expect(run('pdftotext', ['-f', '200', '-l', '200', save(out), '-'])).toMatch('Page 200');
    }
  });

  it('refuses bad sizes, drawing on an ended page, and use after end', async () => {
    const pdf = createPdf({ write() {} });
    expect(() => pdf.addPage({ width: 0 })).toThrow(/width and height/);
    expect(() => pdf.addPage({ height: 1e6 })).toThrow(/width and height/);
    const p = pdf.addPage();
    await p.end();
    expect(() => p.text('x', { font: pdf.standardFont('Helvetica') })).toThrow(/has ended/);
    expect(() => p.rect(0, 0, 1, 1)).toThrow(/has ended/);
    await p.end(); // twice is fine
    await pdf.end();
    expect(() => pdf.addPage()).toThrow();
  });

  it('pages not ended are ended by pdf.end(), in order', async () => {
    const out = await toBytes(
      (pdf) => {
        const f = pdf.standardFont('Courier');
        const a = pdf.addPage(),
          b = pdf.addPage();
        b.text('second', { x: 10, y: 10, font: f });
        a.text('first', { x: 10, y: 10, font: f });
      },
      { creationDate: DATE },
    );
    if (HAS.poppler) expect(pdftotext(out).replace(/\s+/g, ' ').trim()).toBe('first second');
  });
});

describe('text with the standard 14 fonts', () => {
  it('each of the 14 fonts draws and is named, not embedded', async () => {
    const out = await toBytes(
      (pdf) => {
        const p = pdf.addPage();
        STANDARD_NAMES.forEach((n, i) =>
          p.text(n === 'Symbol' ? 'abg' : n === 'ZapfDingbats' ? '✓✔' : `${n} quick fox`, {
            x: 20,
            y: 20 + i * 20,
            font: pdf.standardFont(n),
            size: 10,
          }),
        );
      },
      { creationDate: DATE },
    );
    expect(STANDARD_NAMES).toHaveLength(14);
    if (!HAS.poppler) return;
    const fonts = run('pdffonts', [save(out)]);
    for (const n of STANDARD_NAMES) expect(fonts).toMatch(new RegExp(`^${n}\\s+Type 1\\s+\\S+\\s+no`, 'm'));
    const txt = pdftotext(out);
    expect(txt).toMatch('Helvetica-BoldOblique quick fox');
    expect(txt).toMatch('Times-Roman quick fox');
  });

  it('WinAnsi text extracts exactly (accents, €, curly quotes, dashes) and parentheses are escaped', async () => {
    const s = 'Café “déjà vu” — 5 € (net) \\ 100%';
    const out = await toBytes((pdf) => pdf.addPage().text(s, { x: 72, y: 72, font: pdf.standardFont('Times-Roman') }), {
      creationDate: DATE,
    });
    if (HAS.poppler) expect(pdftotext(out).trim()).toBe(s);
  });

  it('characters outside WinAnsi are dropped and reported', async () => {
    let r;
    const out = await toBytes(
      async (pdf) => {
        pdf.addPage().text('A→B ₹', { x: 10, y: 10, font: pdf.standardFont('Helvetica') });
        const end = pdf.end;
        pdf.end = async () => (r = await end()); // keep the result
      },
      { creationDate: DATE },
    );
    expect(r.warnings.join()).toMatch(/Helvetica has no glyph for "→", "₹"/);
    if (HAS.poppler) expect(pdftotext(out).trim()).toBe('AB');
  });

  it('widthOf uses the AFM widths; y is the top of the line box', async () => {
    const pdf = createPdf({ write() {} });
    const h = pdf.standardFont('Helvetica');
    expect(h.widthOf('Hello', 10)).toBeCloseTo((722 + 556 + 222 + 222 + 556) / 100, 6);
    expect(h.ascent).toBeCloseTo(0.718);
    const p = pdf.addPage({ width: 200, height: 100 });
    p.text('A', { x: 10, y: 20, font: h, size: 10 });
    expect(p.content.s).toMatch(/\/F1 10 Tf\n10 72\.82 Td \(A\) Tj/); // 100 - 20 - 7.18
    await pdf.end();
  });

  it('a font from another PDF and a missing font are refused; bad numbers throw before drawing', () => {
    const a = createPdf({ write() {} }),
      b = createPdf({ write() {} });
    const p = b.addPage();
    expect(() => p.text('x', { font: a.standardFont('Helvetica') })).toThrow(/another PDF/);
    expect(() => p.text('x', /** @type {any} */ ({}))).toThrow(/font is required/);
    expect(() => p.text('x', { font: b.standardFont('Helvetica'), x: NaN })).toThrow(/Not a usable number/);
    expect(() => b.standardFont(/** @type {any} */ ('Arial'))).toThrow(/Not a standard font/);
  });
});

describe('lines, rectangles, colours', () => {
  it('draws with the right operators in PDF space (y flipped), state set once', async () => {
    const out = await toBytes(
      (pdf) => {
        const p = pdf.addPage({ width: 200, height: 100 });
        p.line(10, 10, 190, 10, { color: '#ff0000', width: 2, dash: [3, 1] });
        p.line(10, 20, 190, 20, { color: '#f00', width: 2, dash: [3, 1] });
        p.rect(10, 30, 50, 20, { fill: [0, 0.5, 1] });
        p.rect(70, 30, 50, 20, { stroke: 0.5 });
        p.rect(130, 30, 50, 20, { fill: '#00ff00', stroke: '#000' });
        p.rect(0, 0, 5, 5);
      },
      { creationDate: DATE },
    );
    const c = await content(out);
    expect(c).toContain('1 0 0 RG\n2 w\n[3 1] 0 d\n10 90 m 190 90 l S\n10 80 m 190 80 l S\n'); // the second line: no state again
    expect(c).toContain('0 0.5 1 rg\n10 50 50 20 re f\n');
    expect(c).toContain('0.5 G\n1 w\n[] 0 d\n70 50 50 20 re S\n');
    expect(c).toContain('0 1 0 rg\n0 0 0 RG\n130 50 50 20 re B\n');
    expect(c).toContain('0 g\n0 95 5 5 re f\n');
  });

  it('refuses colours it cannot read', () => {
    const p = createPdf({ write() {} }).addPage();
    expect(() => p.rect(0, 0, 1, 1, { fill: 'red' })).toThrow(/Not a colour/);
    expect(() => p.rect(0, 0, 1, 1, { fill: [1, 2, 3] })).toThrow(/Not a colour/);
    expect(() => p.line(0, 0, 1, 1, { color: 2 })).toThrow(/gray level/);
  });

  it('renders as drawn (pdftoppm: a red box where it was put, top-left origin)', async () => {
    if (!HAS.poppler) return;
    const out = await toBytes(
      (pdf) => pdf.addPage({ width: 100, height: 100 }).rect(10, 10, 30, 20, { fill: '#ff0000' }),
      { creationDate: DATE },
    );
    const ppm = Buffer.from(
      run('pdftoppm', ['-r', '72', '-x', '0', '-y', '0', '-W', '100', '-H', '100', save(out)]),
      'latin1',
    );
    // P6 header "P6\n100 100\n255\n" then RGB rows: the pixel at (20, 15) is red, (60, 60) white
    const at = (x, y) => {
      const o = ppm.length - 100 * 100 * 3 + (y * 100 + x) * 3;
      return [ppm[o], ppm[o + 1], ppm[o + 2]];
    };
    expect(at(20, 15)[0]).toBeGreaterThan(240);
    expect(at(20, 15)[1]).toBeLessThan(10); // red (the renderer's colour management may shift it a little)
    expect(Math.min(...at(60, 60))).toBeGreaterThan(240); // white
  });
});

describe('links and outline', () => {
  it('URL links and internal links (forward, to a page object, with top) are annotations with the right targets', async () => {
    const out = await toBytes(
      async (pdf) => {
        const f = pdf.standardFont('Helvetica');
        const p1 = pdf.addPage();
        p1.text('Go', { x: 72, y: 72, font: f });
        p1.link(72, 72, 100, 14, { url: 'https://example.com/a b?q=ü' });
        p1.link(72, 100, 100, 14, { page: 3, top: 100 }); // page 3 does not exist yet
        await p1.end();
        const p2 = pdf.addPage({ width: 300, height: 500 });
        p2.link(0, 0, 10, 10, { page: p1 });
        await p2.end();
        pdf.addPage({ width: 400, height: 600 });
      },
      { creationDate: DATE },
    );
    const doc = await PDFDocument.load(out);
    const annots = (i) =>
      doc
        .getPage(i)
        .node.Annots()
        .asArray()
        .map((r) => doc.context.lookup(r, PDFDict));
    const [url, fwd] = annots(0);
    const uri = url.lookup(PDFName.of('A'), PDFDict).get(PDFName.of('URI'));
    expect(Buffer.from(uri.asBytes()).toString()).toBe('https://example.com/a%20b?q=%C3%BC');
    const dest = fwd.lookup(PDFName.of('Dest'), PDFArray);
    expect(dest.get(0)).toBe(doc.getPage(2).ref);
    expect(dest.get(1).toString()).toBe('/XYZ');
    expect(dest.get(3).asNumber()).toBe(500); // 600 - 100
    expect(
      fwd
        .lookup(PDFName.of('Rect'), PDFArray)
        .asArray()
        .map((n) => n.asNumber()),
    ).toEqual([72, 727.89, 172, 741.89]);
    expect(annots(1)[0].lookup(PDFName.of('Dest'), PDFArray).get(0)).toBe(doc.getPage(0).ref);
    if (HAS.poppler) expect(pdfinfo(out, '-url')).toMatch('https://example.com/a%20b?q=%C3%BC');
  });

  it('a link to a page that never comes is written without a destination, with a warning', async () => {
    let r;
    await toBytes(
      async (pdf) => {
        pdf.addPage().link(0, 0, 10, 10, { page: 9 });
        const end = pdf.end;
        pdf.end = async () => (r = await end());
      },
      { creationDate: DATE },
    );
    expect(r.warnings.join()).toMatch(/link points to page 9, but the PDF has 1 pages/);
  });

  it('outline entries nest by level and point at their pages', async () => {
    const out = await toBytes(
      (pdf) => {
        for (let i = 0; i < 3; i++) pdf.addPage();
        pdf.outline([
          { title: 'Chapter 1', page: 1 },
          { title: 'Section 1.1 “quoted”', page: 2, top: 50, level: 1 },
          { title: 'Chapter 2', page: 3 },
        ]);
        pdf.outline({ title: 'Nowhere', page: 7 });
      },
      { creationDate: DATE },
    );
    if (!HAS.poppler) return;
    const x = run('pdftohtml', ['-xml', '-stdout', '-i', '-q', save(out)]);
    expect(x.replace(/\s+/g, '')).toContain(
      '<outline><itempage="1">Chapter1</item><outline><itempage="2">Section1.1“quoted”</item></outline><itempage="3">Chapter2</item></outline>',
    );
    expect(() => createPdf({ write() {} }).outline(/** @type {any} */ ({ page: 1 }))).toThrow(/title, page/);
  });
});

describe('metadata, compression, determinism', () => {
  it('Info and XMP carry title, author, subject and the date (UTC, to the second)', async () => {
    const out = await toBytes(() => {}, {
      title: 'Ünïcode <title> & co',
      author: 'A. Author',
      subject: 'Subj',
      creationDate: DATE,
    });
    const doc = await PDFDocument.load(out, { updateMetadata: false });
    expect(doc.getTitle()).toBe('Ünïcode <title> & co');
    expect(doc.getAuthor()).toBe('A. Author');
    expect(doc.getSubject()).toBe('Subj');
    expect(doc.getCreationDate()?.toISOString()).toBe('2026-01-02T03:04:05.000Z');
    expect(doc.getProducer()).toBe('@reportwright/pdf');
    const meta = doc.catalog.lookup(PDFName.of('Metadata'));
    const xmp = Buffer.from(/** @type {any} */ (meta).getContents()).toString('utf8');
    expect(xmp).toContain('<rdf:li xml:lang="x-default">Ünïcode &lt;title&gt; &amp; co</rdf:li>');
    expect(xmp).toContain('<xmp:CreateDate>2026-01-02T03:04:05Z</xmp:CreateDate>');
  });

  it('compress: false writes readable streams; true compresses them', async () => {
    const build = (pdf) => {
      const f = pdf.standardFont('Helvetica');
      const p = pdf.addPage();
      for (let i = 0; i < 50; i++) p.text(`row ${i} of the table`, { x: 10, y: 10 + i * 12, font: f });
    };
    const plain = await toBytes(build, { compress: false, creationDate: DATE });
    const packed = await toBytes(build, { creationDate: DATE });
    expect(latin(plain)).toContain('(row 49 of the table) Tj');
    expect(latin(packed)).not.toContain('row 49');
    expect(packed.length).toBeLessThan(plain.length);
    if (HAS.poppler) {
      expect(pdftotext(plain)).toMatch('row 49 of the table');
      expect(pdftotext(packed)).toMatch('row 49 of the table');
    }
  });

  it('the same input and creationDate give the same bytes; another date, other bytes', async () => {
    const build = async (pdf) => {
      const f = pdf.standardFont('Helvetica');
      for (let i = 0; i < 20; i++) {
        const p = pdf.addPage();
        p.text(`Page ${i}`, { x: 10, y: 10, font: f });
        p.link(10, 10, 50, 12, { page: ((i + 1) % 20) + 1 });
        await p.end();
      }
      pdf.outline({ title: 'Start', page: 1 });
    };
    const a = await toBytes(build, { title: 'Same', creationDate: DATE });
    const b = await toBytes(build, { title: 'Same', creationDate: DATE });
    const c = await toBytes(build, { title: 'Same', creationDate: new Date('2026-01-03') });
    expect(Buffer.compare(a, b)).toBe(0);
    expect(Buffer.compare(a, c)).not.toBe(0);
    // the file ID is a hash of the bytes; a given id is used as is
    expect(latin(a)).toMatch(/\/ID \[<([0-9a-f]{32})> <\1>\]/);
    const d = await toBytes(build, { creationDate: DATE, id: 'ab'.repeat(16) });
    expect(latin(d)).toContain(`/ID [<${'ab'.repeat(16)}> <${'ab'.repeat(16)}>]`);
  });

  it('options are checked', () => {
    expect(() => createPdf({ write() {} }, { creationDate: /** @type {any} */ ('2026') })).toThrow(/valid Date/);
    expect(() => createPdf({ write() {} }, { id: 'xyz' })).toThrow(/32 hex/);
    expect(() => createPdf({ write() {} }, { tagged: true })).toThrow(/needs a title/);
    expect(() => createPdf(/** @type {any} */ ({}))).toThrow(/sink/);
  });
});

describe('objectStreamLevel', () => {
  const build = (pdf) => {
    const f = pdf.standardFont('Helvetica');
    for (let i = 0; i < 300; i++)
      pdf.addPage({ width: 200 + (i % 7), height: 300 }).text(`Page ${i}`, { x: 10, y: 10, font: f });
  };
  it('compresses the object streams and the xref stream at that zlib level; unset, as before; anything but 0–9 is refused', async () => {
    const def = await toBytes(build, { creationDate: DATE });
    const l6 = await toBytes(build, { creationDate: DATE, objectStreamLevel: 6 });
    expect(latin(l6)).toBe(latin(def)); // unset is level 6: the xref stream too goes through deflate() (beta.15)
    const l9 = await toBytes(build, { creationDate: DATE, objectStreamLevel: 9 }),
      l1 = await toBytes(build, { creationDate: DATE, objectStreamLevel: 1 });
    expect(l9.length).toBeLessThanOrEqual(def.length);
    expect(l1.length).toBeGreaterThan(l9.length);
    for (const b of [l9, l1]) expect((await PDFDocument.load(b)).getPageCount()).toBe(300);
    for (const bad of [-1, 10, 2.5, '9'])
      expect(() => createPdf({ write() {} }, { objectStreamLevel: bad })).toThrow(/objectStreamLevel/);
  });
});
