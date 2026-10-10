// Group H reading: loadPdf on PDFs from every earlier group (plain, forms, AES-128 and AES-256 encrypted, signed,
// tagged PDF/A-3a with an attachment, PDF/A-1b, layers, page boxes and rotation), pdf-lib's (with and without object
// streams), legacy RC4 files (made by qpdf through pikepdf when PIKEPDF_PY is set), a hand-made hybrid file and
// incremental updates, and macOS's own PDFs when present (read at run time, never committed). Checked against poppler
// (pdfinfo pages, sizes and rotation, pdftotext words, pdfdetach names) and pdf-lib (form field names).
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import { toBytes, loadPdf, nodeSigner } from '../src/index.js';
import { HAS, INTER, run, save, DIR } from './tools.js';
import { seeds, rawPdf, enc, PY } from './reader-tools.js';

const D = new Date('2026-01-01');
const words = (s) => s.replace(/\s+/g, ' ').trim();
let S;
beforeAll(async () => {
  S = await seeds();
});

describe('reading every kind of input', () => {
  it("our seeds and pdf-lib's: pages, sizes, rotation, text and form fields match poppler and pdf-lib", async () => {
    for (const b of [...S.ours, ...S.pdfLib]) {
      const d = await loadPdf(b);
      const pl = d.encrypted ? null : await PDFDocument.load(b); // pdf-lib cannot decrypt
      if (pl) expect(d.pageCount).toBe(pl.getPageCount());
      if (pl)
        expect(d.fields.map((f) => f.name).sort()).toEqual(
          pl
            .getForm()
            .getFields()
            .map((f) => f.getName())
            .sort(),
        );
      if (!HAS.poppler) continue;
      const info = run('pdfinfo', ['-l', '999', save(b)]);
      expect(Number(/Pages:\s+(\d+)/.exec(info)[1])).toBe(d.pageCount);
      for (let i = 0; i < d.pageCount; i++) {
        const [, w, h] = new RegExp(`Page\\s+${i + 1} size:\\s+([\\d.]+) x ([\\d.]+)`).exec(info);
        expect(d.page(i).width).toBeCloseTo(Number(w), 1);
        expect(d.page(i).height).toBeCloseTo(Number(h), 1);
        const text = words(run('pdftotext', ['-f', String(i + 1), '-l', String(i + 1), save(b), '-']));
        for (const w2 of words(d.page(i).extractText()).split(' ').filter(Boolean)) expect(text).toContain(w2);
      }
    }
  });
  it('text extraction: content order, lines, TJ spacing, WinAnsi, embedded TrueType through ToUnicode', async () => {
    const b = await toBytes(
      async (pdf) => {
        const f = await pdf.embedFont(INTER),
          h = pdf.standardFont('Helvetica');
        const p = pdf.addPage();
        p.text('Héllo wörld — 42 €', { x: 40, y: 40, font: f, size: 14 });
        p.text('Second line', { x: 40, y: 70, font: h });
        p.textBox('Justified words spread over a line', { x: 40, y: 100, width: 400, font: h, align: 'justify' });
      },
      { creationDate: D },
    );
    expect((await loadPdf(b)).page(0).extractText().split('\n')).toEqual([
      'Héllo wörld — 42 €',
      'Second line',
      'Justified words spread over a line',
    ]);
    expect((await loadPdf(S.pdfLib[0])).page(0).extractText()).toBe('pdf-lib page 1');
  });
  it('info, XMP and the PDF/A level; attachments by name (checked by filename.js) and bytes, as pdfdetach lists them', async () => {
    const d = await loadPdf(S.ours[3]);
    expect(d.info.title).toBe('A3');
    expect(d.pdfa).toEqual({ part: 3, conformance: 'a' });
    expect(d.xmp).toContain('pdfaid:part');
    expect(d.attachments.map((a) => [a.name, a.mimeType, new TextDecoder().decode(a.bytes())])).toEqual([
      ['data.csv', 'text/csv', 'a,b\n1,2\n'],
    ]);
    if (HAS.poppler) expect(run('pdfdetach', ['-list', save(S.ours[3])])).toContain('data.csv');
  });
  it('an attachment named to spoof gets no safe name (filename.js refuses it); its bytes are still readable', async () => {
    const b = rawPdf([
      '<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(x) 3 0 R] >> >> >>',
      '<< /Type /Pages /Kids [] /Count 0 >>',
      '<< /Type /Filespec /F (invoice.pdf.exe) /EF << /F 4 0 R >> >>',
      ['<< /Type /EmbeddedFile >>', enc('MZ')],
    ]);
    const [a] = (await loadPdf(b)).attachments;
    expect(a.rawName).toBe('invoice.pdf.exe');
    expect(a.name).toBeNull();
    expect(a.refused).toMatch(/exe|type|extension/i);
  });
  it('outlines, links, boxes and rotation, layers', async () => {
    const b = await toBytes(
      async (pdf) => {
        const f = pdf.standardFont('Helvetica');
        for (let i = 0; i < 3; i++) {
          const p = pdf.addPage({ width: 300, height: 400, rotate: i * 90, cropBox: [10, 10, 280, 380] });
          p.text(`P${i + 1}`, { x: 20, y: 20, font: f });
          if (!i) p.link(20, 20, 50, 20, { page: 3 });
        }
        pdf.outline([
          { title: 'One', page: 1 },
          { title: 'Two', page: 2, level: 1 },
          { title: 'Three', page: 3 },
        ]);
      },
      { creationDate: D },
    );
    const d = await loadPdf(b);
    expect(d.outlines.map((o) => [o.title, o.page, o.children.map((c) => [c.title, c.page])])).toEqual([
      ['One', 0, [['Two', 1]]],
      ['Three', 2, []],
    ]);
    expect([0, 1, 2].map((i) => d.page(i).rotation)).toEqual([0, 90, 180]);
    expect(d.page(0).cropBox).toEqual([10, 10, 290, 390]); // top-left [10 10 280 380] on a 300 × 400 page
    expect(d.page(0).annotations()[0].page).toBe(2);
  });
  it('AES-128 and AES-256 with the user and the owner password; a wrong one is E_PASSWORD', async () => {
    for (const algorithm of ['aes-128', 'aes-256']) {
      const b = await toBytes(
        async (pdf) => {
          pdf.addPage().text(`Secret ${algorithm}`, { x: 20, y: 20, font: pdf.standardFont('Helvetica') });
        },
        {
          encrypt: { userPassword: 'ü-user', ownerPassword: 'owner', algorithm, permissions: { print: false } },
          creationDate: D,
        },
      );
      await expect(loadPdf(b)).rejects.toMatchObject({ code: 'E_PASSWORD' });
      await expect(loadPdf(b, { password: 'nope' })).rejects.toMatchObject({ code: 'E_PASSWORD' });
      const u = await loadPdf(b, { password: algorithm === 'aes-128' ? 'ü-user' : 'ü-user' });
      expect(u.encryption).toMatchObject({ algorithm, owner: false });
      expect(u.encryption.permissions.print).toBe(false);
      expect(u.page(0).extractText()).toBe(`Secret ${algorithm}`);
      expect((await loadPdf(b, { password: 'owner' })).encryption.owner).toBe(true);
    }
  });
  (PY ? it : it.skip)(
    'legacy RC4 (40 and 128 bit) and AES files made by qpdf: read; an incremental update of RC4 is refused',
    async () => {
      const plain = save(S.ours[0]);
      for (const [bits, extra] of [
        ['40', []],
        ['128', ['--use-aes=n']],
        ['128', ['--use-aes=y']],
        ['256', []],
      ]) {
        const out = path.join(DIR, `qpdf-${bits}-${extra.join('')}.pdf`);
        execFileSync(PY, [
          '-I',
          '-c',
          `import sys,pikepdf\np=pikepdf.open(sys.argv[1])\nR={'40':2,'128':3 if '${extra.join('')}'.endswith('n') else 4,'256':6}['${bits}']\np.save(sys.argv[2], encryption=pikepdf.Encryption(user='u', owner='o', R=R, aes=${extra.join('').endsWith('n') || bits === '40' ? 'False' : 'True'}, metadata=R >= 4))`,
          plain,
          out,
        ]);
        const d = await loadPdf(new Uint8Array(fs.readFileSync(out)), { password: 'u' });
        expect(d.page(0).extractText()).toContain('Seed page 1');
        if (d.encryption.algorithm === 'rc4') await expect(d.saveIncremental()).rejects.toThrow(/RC4/);
      }
    },
  );
  (HAS.poppler ? it : it.skip)('signatures: listed with their ByteRange coverage', async () => {
    const dir = fs.mkdtempSync(path.join(DIR, 'sig-'));
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        path.join(dir, 'k.pem'),
        '-out',
        path.join(dir, 'c.pem'),
        '-days',
        '30',
        '-subj',
        '/CN=Reader',
      ],
      { stdio: 'ignore' },
    );
    const signer = nodeSigner({
      key: fs.readFileSync(path.join(dir, 'k.pem')),
      certs: fs.readFileSync(path.join(dir, 'c.pem'), 'utf8'),
    });
    const b = await toBytes(
      async (pdf) => {
        const p = pdf.addPage();
        await pdf.sign({ name: 'sig', page: p, x: 20, y: 20, width: 100, height: 30 }, { signer, reason: 'Read me' });
      },
      { sign: true, creationDate: D },
    );
    const [s] = (await loadPdf(b)).signatures;
    expect(s).toMatchObject({
      field: 'sig',
      subFilter: 'ETSI.CAdES.detached',
      reason: 'Read me',
      wellFormed: true,
      coversWholeFile: true,
      revision: 0,
      bytesAfter: 0,
    });
    expect(s.signedBytes().length).toBe(b.length - (s.byteRange[2] - s.byteRange[1]));
  });
  it("incremental updates: the latest version of an object wins; a hybrid file's xref stream supplies its compressed objects", async () => {
    const d = await loadPdf(S.ours[0]);
    d.setInfo({ title: 'Second' });
    const u = await d.saveIncremental();
    expect((await loadPdf(u.bytes)).info.title).toBe('Second');
    expect((await loadPdf(u.bytes.subarray(0, S.ours[0].length))).info.title).toBe('Plain');
    // hybrid: the classic table lists 1–4; its /XRefStm says object 5 is in object stream 4
    const objstm = enc('5 0 << /Type /Annot /Subtype /Text /Rect [0 0 1 1] /Contents (hidden) >>');
    const parts = [
      '<< /Type /Catalog /Pages 2 0 R /X 5 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>',
      ['<< /Type /ObjStm /N 1 /First 4 >>', objstm],
    ];
    let head = enc('%PDF-1.5\n'),
      pos = head.length;
    const offs = [],
      chunks = [head];
    parts.forEach((p, k) => {
      offs.push(pos);
      const [t, data] = Array.isArray(p) ? p : [p, null];
      const c = data
        ? Buffer.concat([
            enc(`${k + 1} 0 obj\n${t.replace('>>', `/Length ${data.length} >>`)}\nstream\n`),
            data,
            enc('\nendstream\nendobj\n'),
          ])
        : enc(`${k + 1} 0 obj\n${t}\nendobj\n`);
      chunks.push(c);
      pos += c.length;
    });
    const xs = pos,
      row = Buffer.from([2, 0, 0, 0, 4, 0, 0]);
    const xstm = Buffer.concat([
      enc(`6 0 obj\n<< /Type /XRef /Size 7 /Index [5 1] /W [1 4 2] /Length 7 >>\nstream\n`),
      row,
      enc('\nendstream\nendobj\n'),
    ]);
    chunks.push(xstm);
    pos += xstm.length;
    chunks.push(
      enc(
        `xref\n0 5\n0000000000 65535 f\r\n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n\r\n`).join('')}trailer\n<< /Size 7 /Root 1 0 R /XRefStm ${xs} >>\nstartxref\n${pos}\n%%EOF\n`,
      ),
    );
    const h = await loadPdf(new Uint8Array(Buffer.concat(chunks)));
    expect(h.recovered).toBe(false);
    const { internal } = await import('../src/reader/pdf.js');
    expect(internal(h, 't').r.src.get(5).get('Subtype')).toBe('Text');
  });
  it('a PDF/A-1b file (a classic xref table) and a file with no compression', async () => {
    const b = await toBytes(
      async (pdf) => {
        const f = await pdf.embedFont(INTER);
        pdf.addPage().text('PDF/A-1b', { x: 20, y: 20, font: f });
      },
      { title: 'A1', pdfa: { part: 1 }, creationDate: D },
    );
    const d = await loadPdf(b);
    expect([d.version, d.pdfa, d.page(0).extractText()]).toEqual(['1.4', { part: 1, conformance: 'b' }, 'PDF/A-1b']);
    expect((await loadPdf(S.ours[4])).page(0).extractText()).toBe('In a layer');
  });
  it("macOS's own PDFs, when present: they load and their text matches pdftotext", async () => {
    for (const b of S.system) {
      const d = await loadPdf(b);
      expect(d.pageCount).toBeGreaterThan(0);
      if (HAS.poppler) {
        const text = words(run('pdftotext', ['-l', '1', save(b), '-']));
        const ours = words(d.page(0).extractText())
          .split(' ')
          .filter((w) => w.length > 3)
          .slice(0, 50);
        const hits = ours.filter((w) => text.includes(w)).length;
        expect(hits / Math.max(1, ours.length)).toBeGreaterThan(0.8);
      }
    }
  });
});
