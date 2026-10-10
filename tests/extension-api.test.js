// The engine-facing extension API (pdf.core and the exports a caller writing its own content needs): what index.d.ts
// declares exists, and each piece does what it says.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { createPdf, toBytes, loadPdf, nodeSigner } from '../src/index.js';
import { HAS, run, save, latin, DIR } from './tools.js';
import { png, sharp, pixels, near } from './image-fixtures.js';
import { PDFName } from 'pdf-lib';
import { load, annots, get } from './nav-tools.js';

const DATE = new Date('2026-01-02T03:04:05Z');

const DTS = fs.readFileSync(path.join(import.meta.dirname, '../index.d.ts'), 'utf8');
/** the members of an interface in index.d.ts: name → 'method' | 'property' */
function members(name) {
  const m = DTS.match(new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`));
  if (!m) throw new Error(`no interface ${name}`);
  const body = m[1].replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Map();
  for (const l of body.split('\n')) {
    const x = l.match(/^ {2}(?:readonly )?(?:get )?([A-Za-z]\w*)(?:<[^>]*>)?(\??)(\(|:)/);
    if (x) out.set(x[1], x[3] === '(' ? 'method' : 'property');
  }
  return out;
}

describe('A0: pdf.core is typed as it is', () => {
  it('every PdfCore member declared in index.d.ts exists on pdf.core, methods as functions', async () => {
    const pdf = createPdf({ write() {} });
    const decl = members('PdfCore');
    expect(decl.size).toBeGreaterThan(20);
    for (const [k, kind] of decl) {
      expect(k in pdf.core, k).toBe(true);
      if (kind === 'method') expect(typeof pdf.core[k], k).toBe('function');
    }
    expect(DTS).toMatch(/readonly core: PdfCore;/);
    await pdf.end();
  });
  it('the engine-facing members are declared', () => {
    const decl = members('PdfCore');
    for (const k of [
      'reserve',
      'write',
      'writeBig',
      'writeStream',
      'object',
      'resource',
      'resourcesRef',
      'catalog',
      'pageRef',
      'onFinish',
      'info',
      'xmp',
      'warn',
      'serial',
      'tags',
    ])
      expect(decl.has(k), k).toBe(true);
  });
});

const ppm = (bytes) => {
  const f = save(bytes);
  run('pdftoppm', ['-r', '72', '-singlefile', f, f]);
  return fs.readFileSync(`${f}.ppm`);
};
/** a 40 × 20 RGBA PNG: red left, blue right, the bottom rows half transparent */
const RGBA = png({
  w: 40,
  h: 20,
  type: 6,
  depth: 8,
  px: (x, y) => (x < 20 ? [220, 0, 0] : [0, 0, 220]).concat(y >= 15 ? 128 : 255),
});

describe('A1: an embedded image drawn from a caller-written content stream', () => {
  for (const [what, bytes] of [
    ['an RGBA PNG', async () => RGBA],
    [
      'an EXIF-rotated JPEG',
      async () =>
        sharp &&
        new Uint8Array(
          await sharp(Buffer.from(RGBA))
            .flatten({ background: '#fff' })
            .jpeg()
            .withMetadata({ orientation: 6 })
            .toBuffer(),
        ),
    ],
  ])
    it(`core.imageResource gives the name, ref, alpha and orientation: raw Do renders as page.image (${what})`, async () => {
      const src = await bytes();
      if (!src) return;
      const box = { x: 30, y: 40, width: 120, height: 90 };
      const byPage = await toBytes(
        async (pdf) => {
          const img = await pdf.embedImage(src);
          pdf.addPage({ width: 200, height: 200 }).image(img, box);
        },
        { creationDate: DATE },
      );
      let r;
      const raw = await toBytes(
        async (pdf) => {
          const img = await pdf.embedImage(src);
          r = pdf.core.imageResource(img);
          const p = pdf.addPage({ width: 200, height: 200 });
          if (r.alpha) p.entries.set('Group', '<< /Type /Group /S /Transparency /CS /DeviceRGB >>');
          p.content.op(
            `q ${box.width} 0 0 ${box.height} ${box.x} ${200 - box.y - box.height} cm ${r.orientation.join(' ')} cm /${r.name} Do Q`,
          );
        },
        { creationDate: DATE },
      );
      expect(r.name).toMatch(/^X\d+$/);
      expect(Number.isInteger(r.ref)).toBe(true);
      expect(r.alpha).toBe(what.includes('PNG'));
      if (what.includes('JPEG')) expect(r.orientation).not.toEqual([1, 0, 0, 1, 0, 0]);
      if (!HAS.poppler) return;
      const want = ppm(byPage);
      expect(want.some((b) => b < 100)).toBe(true); // something was drawn
      expect(ppm(raw).equals(want)).toBe(true);
      if (HAS.qpdf) expect(run('qpdf', ['--check', save(raw)])).toMatch(/No syntax or stream encoding errors/);
    });
  it('refuses anything but an image of this document', async () => {
    const pdf = createPdf({ write() {} });
    expect(() => pdf.core.imageResource({ type: 'image', width: 1, height: 1 })).toThrow(
      /Not an image \(pdf.embedImage\) made by this library/,
    );
    await pdf.end();
  });
});

describe('A2: encryption covers every string written through core, literal or hex', () => {
  const SECRETS = [
    'SecretTitle',
    'secret.example',
    'xx-SECRETLANG',
    'SecretActual',
    'SecretBig',
    'SecretLong',
    'SecretHexSpace',
  ];
  /** an encrypted file whose strings come in through core.write as literals (and one spaced hex string) */
  const build = (algorithm) =>
    toBytes(
      async (pdf) => {
        const { core } = pdf;
        core.info = '<< /Title (SecretTitle \\(one\\) \\101\\\n) /Producer (x) >>';
        core.catalog('Lang', '(xx-SECRETLANG)');
        const p = pdf.addPage({ width: 200, height: 200 });
        p.annotate(
          () =>
            '<< /Type /Annot /Subtype /Link /Rect [0 0 50 50] /Border [0 0 0] /A << /S /URI /URI (https://secret.example/a\\)b) >> >>',
        );
        // direct objects: a stream's dictionary, a long dictionary, a big object, nested arrays and dictionaries
        const r = [core.reserve(), core.reserve(), core.reserve()];
        r.forEach((n, i) => core.catalog(`RwTest${i}`, `${n} 0 R`)); // reachable: qpdf keeps them
        await core.write(
          r[0],
          '<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /ActualText (SecretActual) >>',
          new Uint8Array(0),
        );
        await core.write(r[1], `<< /K [(SecretLong) [<< /T (nested) >>]] /Pad <${'00'.repeat(2100)}> >>`);
        await core.writeBig(r[2], '[', ['(SecretBig)', ' <53 65 63 72 65 74 48 65 78 53 70 61 63 65>'], ']');
      },
      { creationDate: DATE, encrypt: { userPassword: 'pw', ownerPassword: 'owner', algorithm } },
    );
  for (const algorithm of ['aes-256', 'aes-128'])
    it(`${algorithm}: no plaintext in the file; qpdf decrypts each string to its text`, async () => {
      const out = await build(algorithm);
      const raw = latin(out);
      for (const s of SECRETS) expect(raw.includes(s), s).toBe(false);
      const doc = await loadPdf(out, { password: 'pw' });
      expect(doc.info.title).toBe('SecretTitle (one) A');
      expect(doc.page(0).annotations()[0].uri).toBe('https://secret.example/a)b');
      if (!HAS.qpdf) return;
      const f = save(out);
      expect(run('qpdf', ['--password=pw', '--show-encryption', f])).toMatch(
        algorithm === 'aes-256' ? /AESv3/ : /AESv2/,
      );
      expect(run('qpdf', ['--password=pw', '--check', f])).toMatch(/No syntax or stream encoding errors/);
      const plain = f + '.plain.pdf';
      run('qpdf', ['--password=pw', '--decrypt', '--qdf', '--object-streams=disable', f, plain]);
      const dec = fs.readFileSync(plain, 'latin1');
      for (const s of [
        'SecretTitle (one) A',
        'https://secret.example/a)b',
        'xx-SECRETLANG',
        'SecretActual',
        'SecretLong',
        'nested',
        'SecretBig',
        'SecretHexSpace',
      ])
        expect(dec.includes(s) || dec.includes(s.replace(/[()]/g, '\\$&')), s).toBe(true);
    });
  it('a malformed string or a comment in an encrypted object throws rather than leaving text in the clear', async () => {
    for (const bad of ['<< /T (unclosed >>', '<< /T <4g> >>', '<< /T 1 % (comment) \n >>'])
      await expect(
        toBytes(async (pdf) => pdf.core.write(pdf.core.reserve(), bad, new Uint8Array(0)), {
          encrypt: { userPassword: 'pw' },
        }),
      ).rejects.toThrow(/cannot be encrypted/);
  });
});

describe('A4: form fields with a caller-supplied appearance and /DA', () => {
  const TEXT_AP = 'q 0.9 g 0 0 160 20 re f Q BT /Fh 12 Tf 0 g 3 5 Td (Ada Lovelace) Tj ET';
  const ON = 'q 0 g 2 2 12 12 re f Q',
    OFF = 'q 0 G 1 w 1.5 1.5 13 13 re S Q';
  const COMBO_AP = 'BT /Fh 10 Tf 0 g 3 5 Td (Blue) Tj ET';
  /** a page with a text field, a multiline field, a checkbox and a combo, all with our appearances and font */
  const build = (o = {}) =>
    toBytes(
      async (pdf) => {
        const { core } = pdf;
        // the caller's own font, registered in the shared Resources (the AcroForm's /DR) under its own name
        const fref = await core.object(
          '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
        );
        expect(core.resource('Font', `${fref} 0 R`, 'Fh')).toBe('Fh');
        const page = pdf.addPage({ width: 300, height: 300 });
        const F = pdf.form;
        const box = (y, h = 20) => ({ page, x: 20, y, width: 160, height: h });
        const name = F.textField('name', {
          ...box(20),
          value: 'Ada Lovelace',
          tooltip: 'Your name',
          required: true,
          da: '/Fh 12 Tf 0 g',
          appearance: { normal: TEXT_AP },
          ...o.text,
        });
        const notes = F.textField('notes', {
          ...box(60, 60),
          value: 'line one\nline two',
          multiline: true,
          readOnly: true,
          tooltip: 'Notes',
          da: '/Fh 10 Tf 0 g',
          appearance: { normal: 'BT /Fh 10 Tf 0 g 3 45 Td (line one) Tj 0 -12 Td (line two) Tj ET' },
        });
        const agree = F.checkbox('agree', {
          ...box(140, 16),
          width: 16,
          checked: true,
          tooltip: 'I agree',
          appearance: { on: ON, off: OFF },
        });
        const colour = F.comboBox('colour', {
          ...box(180),
          options: ['Red', 'Blue'],
          value: 'Blue',
          tooltip: 'Colour',
          da: '/Fh 10 Tf 0 g',
          appearance: { normal: COMBO_AP },
        });
        o.after?.(pdf, { name, notes, agree, colour, page });
        o.refs?.push(name.widgetRef, notes.widgetRef, agree.widgetRef, colour.widgetRef);
      },
      { creationDate: DATE, compress: false, ...o.options },
    );

  it('writes the supplied appearance streams and /DA exactly; widgetRef is the widget', async () => {
    const refs = [];
    const out = await build({ refs });
    const raw = latin(out);
    for (const ops of [TEXT_AP, ON, OFF, COMBO_AP]) expect(raw).toContain(`stream\n${ops}\nendstream`);
    const doc = await load(out);
    const form = doc.getForm();
    expect(form.getTextField('name').getText()).toBe('Ada Lovelace');
    expect(form.getTextField('name').isRequired()).toBe(true);
    expect(form.getTextField('notes').isMultiline()).toBe(true);
    expect(form.getTextField('notes').isReadOnly()).toBe(true);
    expect(form.getCheckBox('agree').isChecked()).toBe(true);
    expect(form.getDropdown('colour').getSelected()).toEqual(['Blue']);
    const ws = annots(doc, 0);
    expect(ws.map((w) => get(w, 'TU'))).toEqual(['Your name', 'Notes', 'I agree', 'Colour']);
    expect(ws.map((w) => get(w, 'DA'))).toEqual(['/Fh 12 Tf 0 g', '/Fh 10 Tf 0 g', null, '/Fh 10 Tf 0 g']);
    const annotRefs = doc
      .getPage(0)
      .node.Annots()
      .asArray()
      .map((r) => r.objectNumber);
    expect(refs).toEqual(annotRefs);
    expect(
      doc.catalog
        .lookup(PDFName.of('AcroForm'))
        .lookup(PDFName.of('DR'))
        .lookup(PDFName.of('Font'))
        .has(PDFName.of('Fh')),
    ).toBe(true);
    if (!HAS.poppler) return;
    expect(run('qpdf', ['--check', save(out)])).toMatch(/No syntax or stream encoding errors/);
    const px = pixels(out);
    expect(near(px(25, 25), [230, 230, 230], 3)).toBe(true); // the text field's gray background, from our appearance
    expect(px(28, 148).every((v) => v < 60)).toBe(true); // the ticked box's square
  });

  it('pdf-lib and loadPdf fill the fields and read them back', async () => {
    const doc = await load(await build());
    const form = doc.getForm();
    form.getTextField('name').setText('Grace Hopper');
    form.getCheckBox('agree').uncheck();
    const again = await loadPdf(await doc.save());
    const v = Object.fromEntries(again.fields.map((f) => [f.name, f.value]));
    expect(v.name).toBe('Grace Hopper');
    expect(v.agree).toBe('Off');
    const ours = await loadPdf(await build());
    const filled = await loadPdf((await ours.fill({ name: 'Alan Turing', colour: 'Red' }).save()).bytes);
    const w = Object.fromEntries(filled.fields.map((f) => [f.name, f.value]));
    expect([w.name, w.colour]).toEqual(['Alan Turing', 'Red']);
  });

  it('structParent links a widget into a caller-made structure tree; the built-in tagger links it with an OBJR', async () => {
    const out = await build({ text: { structParent: 7 } });
    const ws = annots(await load(out), 0);
    expect(get(ws[0], 'StructParent')).toBe(7);
    const refs = [];
    const tagged = await build({ refs, options: { tagged: true, title: 'Form' } });
    const raw = latin(tagged);
    for (const r of refs) expect(raw).toMatch(new RegExp(`/Type /OBJR /Obj ${r} 0 R`));
    await expect(build({ text: { structParent: 1 }, options: { tagged: true, title: 'Form' } })).rejects.toThrow(
      /structParent/,
    );
  });

  it('checks what it writes: the /DA, the appearance and its resources', async () => {
    const bad = [
      [{ da: '/Fh 12 Tf 0 g\n/OpenAction' }, /da/],
      [{ da: '0 g' }, /da/],
      [{ appearance: { normal: 'BT ET', resources: '<< /Font << >> >> /OpenAction' } }, /resources/],
      [{ appearance: { normal: 'Ω' } }, /appearance/],
      [{ appearance: { normal: 'BT ET', js: 'x' } }, /appearance/],
      [{ appearance: { normal: 'BT ET' }, da: undefined, font: undefined }, /font/],
      [{ structParent: -1 }, /structParent/],
    ];
    for (const [text, why] of bad) await expect(build({ text }), JSON.stringify(text)).rejects.toThrow(why);
  });
});

describe('A6: signing a document whose pages were written through core', () => {
  const PDFSIG =
    HAS.poppler &&
    (() => {
      try {
        execFileSync('which', ['pdfsig'], { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    })();
  const keyDir = fs.mkdtempSync(path.join(DIR, 'a6-'));
  const ossl = (...a) => execFileSync('openssl', a, { stdio: 'pipe', cwd: keyDir });
  let KEY;
  beforeAll(() => {
    ossl(
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'k.key',
      '-out',
      'k.crt',
      '-days',
      '30',
      '-subj',
      '/CN=A6 Signer',
    );
    KEY = {
      key: fs.readFileSync(path.join(keyDir, 'k.key')),
      certs: fs.readFileSync(path.join(keyDir, 'k.crt'), 'utf8'),
    };
  });
  /** pages as the engine writes them (its own compressed content stream, fonts and resources through core), then signed */
  const engineLike = (signer, field = { name: 'Signature1' }) =>
    toBytes(
      async (pdf) => {
        const { core } = pdf;
        const fref = await core.object(
          '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
        );
        const F = core.resource('Font', `${fref} 0 R`, 'F1');
        for (const label of ['Page one', 'Page two']) {
          const page = pdf.addPage({ width: 300, height: 200 });
          const z = deflateSync(Buffer.from(`BT /${F} 14 Tf 20 150 Td (${label}) Tj ET`));
          page.content = { s: ' ', end: () => '' };
          const ended = page.end();
          page.z = Promise.resolve(new Uint8Array(z));
          await ended;
        }
        await pdf.sign(field, { signer, reason: 'Approved', name: 'A6 Signer' });
      },
      { creationDate: DATE, sign: true },
    );
  const check = async (out) => {
    const raw = latin(out);
    const m = raw.match(/\/ByteRange \[0 (\d+) (\d+) (\d+)\s*\]/);
    expect(m).not.toBe(null);
    const [a, b, c] = m.slice(1).map(Number);
    expect(b + c).toBe(out.length); // the ranges reach the end of the file
    expect(raw[a]).toBe('<');
    expect(raw[b - 1]).toBe('>');
    expect(raw.slice(a + 1, b - 1)).toMatch(/^[0-9a-f]+$/);
    const doc = await loadPdf(out);
    expect(doc.signatures.length).toBe(1);
    expect(doc.signatures[0].coversWholeFile).toBe(true);
    expect(doc.fields.map((f) => [f.name, f.type])).toEqual([['Signature1', 'signature']]);
    expect(doc.extractText()).toMatch(/Page one[\s\S]*Page two/);
    const pl = await load(out);
    expect(pl.catalog.lookup(PDFName.of('AcroForm')).get(PDFName.of('SigFlags')).asNumber()).toBe(3);
    if (PDFSIG) expect(run('pdfsig', [save(out)])).toMatch(/Signature Validation: Signature is Valid/);
    if (HAS.qpdf) expect(run('qpdf', ['--check', save(out)])).toMatch(/No syntax or stream encoding errors/);
  };
  it('pdf.sign({ name }) adds an invisible signature field (no page, zero /Rect) and signs; pdfsig validates', async () => {
    const out = await engineLike(nodeSigner(KEY));
    await check(out);
    expect(latin(out)).not.toMatch(/\/Annots/); // on no page
  });
  it('an invisible signature field on an open page goes in its /Annots with a zero /Rect', async () => {
    const out = await toBytes(
      async (pdf) => {
        const page = pdf.addPage({ width: 300, height: 200 });
        page.text('Page one', { x: 20, y: 20, font: pdf.standardFont('Helvetica') });
        await pdf.sign({ name: 'Signature1', page }, { signer: nodeSigner(KEY) });
      },
      { creationDate: DATE, sign: true },
    );
    const w = annots(await load(out), 0);
    expect(w.length).toBe(1);
    expect(get(w[0], 'Rect')).toEqual([0, 0, 0, 0]);
    expect(get(w[0], 'F')).toBe(132);
    if (PDFSIG) expect(run('pdfsig', [save(out)])).toMatch(/Signature is Valid/);
  });
  it('a PKCS#12 file signs through cmsSigner (examples/p12-signer.mjs, node-forge)', async () => {
    ossl(
      'pkcs12',
      '-export',
      '-inkey',
      'k.key',
      '-in',
      'k.crt',
      '-out',
      'k.p12',
      '-passout',
      'pass:p12 secret',
      '-certpbe',
      'PBE-SHA1-3DES',
      '-keypbe',
      'PBE-SHA1-3DES',
      '-macalg',
      'sha1',
    );
    const { p12Signer } = await import('../examples/p12-signer.mjs');
    const out = await engineLike(p12Signer(fs.readFileSync(path.join(keyDir, 'k.p12')), 'p12 secret'));
    await check(out);
    expect(() => p12Signer(fs.readFileSync(path.join(keyDir, 'k.p12')), 'wrong')).toThrow();
  });
});
