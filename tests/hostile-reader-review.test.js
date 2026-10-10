// Regressions for the independent security review of the reader (R1–R8). Each describe is one finding; each test
// failed before its fix. Inputs that can exhaust the heap or run for hours are run in a child process
// (reader-hostile-child.mjs) under a time limit and a 512 MB heap, since a fatal OOM cannot be caught in-process.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import { loadPdf } from '../src/index.js';
import { inRegion } from '../src/reader/source.js';
import { onePage, rawPdf } from './reader-tools.js';
import { toBytes, nodeSigner } from '../src/index.js';
import { HAS, INTER, verapdf } from './tools.js';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const CHILD = path.join(import.meta.dirname, 'reader-hostile-child.mjs');
/** run one case in a child: its JSON line, or { killed / crashed } @param {string} name @param {number} [secs] */
function child(name, secs = 20) {
  const r = spawnSync(process.execPath, ['--max-old-space-size=512', CHILD, name], {
    encoding: 'utf8',
    timeout: secs * 1000,
    killSignal: 'SIGKILL',
  });
  const line = r.stdout.trim().split('\n').pop();
  if (r.status !== 0 || !line)
    return { code: r.signal ? `killed:${r.signal}` : `exit:${r.status}`, stderr: r.stderr.slice(-400) };
  return JSON.parse(line);
}

describe('R1: a ToUnicode bfrange cannot copy a long destination 65,536 times (heap exhaustion)', () => {
  it('a destination past 64 code units is skipped: the text comes from the encoding, no OOM', () => {
    const r = child('cmap-long-dst');
    expect(r.code).toBe('OK');
    expect(r.text).toBe('A');
  }, 30_000);
  it('the characters one CMap holds are capped: E_BUDGET, not OOM', () => {
    expect(child('cmap-chars').code).toBe('E_BUDGET');
  }, 30_000);
  it('the characters one extraction holds across fonts are capped: E_BUDGET, not OOM', () => {
    expect(child('cmap-many-fonts').code).toBe('E_BUDGET');
  }, 30_000);
});

describe('R2: a CIDFont /W is a budget step per code, capped in total (timeoutMs honoured)', () => {
  for (const name of ['w-ranges', 'w-arrays', 'page-tree-shared-kids']) {
    it(`${name}: stops in well under the 15 s limit with a typed error`, () => {
      const r = child(name, 15);
      expect(['E_BUDGET', 'E_TIMEOUT']).toContain(r.code);
      expect(r.ms).toBeLessThan(3000);
    }, 30_000);
  }
});

describe('R3: glyphs are budget steps, every stream counts against maxDecoded, form XObjects drawn are capped, extractText has a default time', () => {
  it('an unfiltered 64 KB form drawn 100,000 times stops at maxDecoded', () => {
    const r = child('forms-unfiltered', 15);
    expect(r.code).toBe('E_BUDGET');
    expect(r.message).toMatch(/maxDecoded/);
  }, 30_000);
  it('a form drawn 20,000 times: E_BUDGET (at most 10,000 per extraction)', () => {
    const r = child('forms-many', 15);
    expect(r.code).toBe('E_BUDGET');
    expect(r.message).toMatch(/form XObjects/);
  }, 30_000);
  it('one Tj of a 16 MB string honours timeoutMs 300', () => {
    const r = child('glyphs-one-string', 15);
    expect(r.code).toBe('E_TIMEOUT');
    expect(r.ms).toBeLessThan(1500);
  }, 30_000);
  it('extractText takes its own timeoutMs (30 s by default) and checks its options', async () => {
    const d = await loadPdf(onePage(`BT /F1 1 Tf (${'A'.repeat(999_999)}) Tj ET`)); // under maxTextItems (1 M)
    const t = Date.now();
    expect(() => d.page(0).extractText({ timeoutMs: 5 })).toThrow(expect.objectContaining({ code: 'E_TIMEOUT' }));
    expect(Date.now() - t).toBeLessThan(1500);
    expect(() => d.extractText({ timeoutMs: -1 })).toThrow(TypeError);
    expect(() => d.extractText({ nope: 1 })).toThrow(TypeError);
    expect(d.page(0).extractText({ timeoutMs: Infinity }).length).toBe(999_999);
  }, 30_000);
});

describe('R6: names from the file never reach Object.prototype through a constant table', () => {
  const font = (f, s) =>
    rawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      [`<< /Length ${s.length} >>`, s],
      f,
    ]);
  it('/BaseFont /__proto__ and /Encoding /constructor: the standard encoding and widths, not a TypeError', async () => {
    const d = await loadPdf(
      font(
        '<< /Type /Font /Subtype /Type1 /BaseFont /__proto__ /Encoding /constructor >>',
        'BT /F1 12 Tf 10 10 Td (AB) Tj ET',
      ),
    );
    expect(d.page(0).extractText()).toBe('AB');
  });
  it('/Differences glyph names toString and valueOf: no Unicode (U+FFFD), not a function', async () => {
    const d = await loadPdf(
      font(
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Differences [65 /toString /valueOf] >> >>',
        'BT /F1 12 Tf 10 10 Td (ABC) Tj ET',
      ),
    );
    expect(d.page(0).extractText()).toBe('\ufffd\ufffdC');
  });
  it('a field /FT /constructor is unknown; a /DA font /constructor fills in Helvetica', async () => {
    const form = (ft, da) =>
      rawPdf([
        '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] >> >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Annots [4 0 R] >>',
        `<< /Type /Annot /Subtype /Widget /FT /${ft} /T (f) /Rect [10 10 110 30] /P 3 0 R /DA (/${da} 12 Tf 0 g) >>`,
      ]);
    expect((await loadPdf(form('constructor', 'Helv'))).fields[0].type).toBe('unknown');
    const d = await loadPdf(form('Tx', 'constructor'));
    d.fill({ f: 'hello' });
    const r = await d.save();
    expect((await loadPdf(r.bytes)).fields[0].value).toBe('hello');
  });
});

describe('R8: the whole-file check finds whether a byte-scan hit is in stream data without scanning every stream', () => {
  it('80,000 streams each hiding an unreadable object: linear, not quadratic', () => {
    const r = child('regions', 60);
    expect(r.code).toBe('OK');
    expect(r.ms).toBeLessThan(5000);
  }, 90_000);
});

describe('an earlier cross-reference section is checked like the latest: each entry must match an object read', () => {
  /** rev 1: object 4 is at a place no scan reads (in a stream's data, after a letter) and is a JavaScript
   * action; rev 2's section moves object 4 to a clean object, so the merged table looks clean */
  function twoRevisions() {
    const parts = [];
    let pos = 0;
    const add = (s) => {
      const b = Buffer.from(s, 'latin1');
      parts.push(b);
      pos += b.length;
      return pos - b.length;
    };
    add('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
    const o1 = add('1 0 obj\n<< /Type /Catalog /Pages 2 0 R /OpenAction 4 0 R >>\nendobj\n');
    const o2 = add('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
    const o3 = add('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>\nendobj\n');
    const hidden = '\nx4 0 obj << /S /JavaScript /JS (app.alert(1)) >> endobj\n'; // "x4": no scan takes it for an object
    const o5 = add(`5 0 obj\n<< /Length ${hidden.length} >>\nstream\n`);
    const o4 = add(hidden) + 2;
    add('\nendstream\nendobj\n');
    const row = (o) => `${String(o).padStart(10, '0')} 00000 n\r\n`;
    const x1 = add(
      `xref\n0 6\n0000000000 65535 f\r\n${row(o1)}${row(o2)}${row(o3)}${row(o4)}${row(o5)}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n`,
    );
    add(`${x1}\n%%EOF\n`);
    const n4 = add('4 0 obj\n<< /S /GoTo /D [3 0 R /Fit] >>\nendobj\n');
    const x2 = add(`xref\n4 1\n${row(n4)}trailer\n<< /Size 6 /Root 1 0 R /Prev ${x1} >>\nstartxref\n`);
    add(`${x2}\n%%EOF\n`);
    return new Uint8Array(Buffer.concat(parts));
  }
  it('saveIncremental refuses (fail closed) when an earlier section points at an object the check never read', async () => {
    const d = await loadPdf(twoRevisions());
    await expect(d.saveIncremental()).rejects.toMatchObject({
      code: 'E_ACTIVE',
      message: expect.stringMatching(/earlier cross-reference section|could not be checked/),
    });
  });
});

describe("R7: a structure element's /A (attributes) is not an action", () => {
  it.skipIf(!HAS.verapdf)(
    'a tagged table rewritten by save() keeps /Scope and /ColSpan, and passes PDF/UA-1',
    async () => {
      const out = await toBytes(
        async (pdf) => {
          const f = await pdf.embedFont(INTER),
            p = pdf.addPage(),
            T = (t, fn, o) => p.tag(t, fn, o),
            t = (s, x, y) => p.text(s, { x, y, font: f, size: 11 });
          T('H1', () => t('Sales', 40, 50));
          T('Table', () => {
            T('THead', () =>
              T('TR', () =>
                ['Region', 'Q1', 'Q2'].forEach((h, i) =>
                  T('TH', () => t(h, 40 + i * 120, 145), { scope: 'Column', id: `h${i}` }),
                ),
              ),
            );
            T('TBody', () =>
              T('TR', () => {
                T('TH', () => t('South', 40, 185), { scope: 'Row', id: 'r1' });
                T('TD', () => t('2,581', 160, 185), { headers: ['h1', 'h2', 'r1'], colSpan: 2 });
              }),
            );
          });
          await p.end();
        },
        { title: 'Sales', tagged: { lang: 'en-GB' }, creationDate: new Date('2026-01-01') },
      );
      const r = await (await loadPdf(out)).save();
      expect(r.stripped ?? []).toEqual([]);
      // every object's text, object streams and all (pdf-lib parses them)
      const doc = await PDFDocument.load(r.bytes);
      const text = doc.context
        .enumerateIndirectObjects()
        .map(([, o]) => String(o))
        .join('\n');
      expect(text).toMatch(/\/Scope \/Column/);
      expect(text).toMatch(/\/Scope \/Row/);
      expect(text).toMatch(/\/ColSpan 2/);
      expect(verapdf(r.bytes, 'ua1').failed).toEqual([]);
    },
    60_000,
  );
  // position, not shape: /A is attributes only for elements the /StructTreeRoot walk reaches, and only when it holds
  // attribute dictionaries (an /O, no /S, /JS or /Type /Action)
  const tagged = (elem, extra = []) =>
    rawPdf([
      '<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 5 0 R /MarkInfo << /Marked true >> >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /X 7 0 R >>',
      ['<< >>', Buffer.from('')],
      '<< /Type /StructTreeRoot /K [6 0 R] >>',
      elem,
      ...extra,
    ]);
  const after = async (b) => {
    const r = await (await loadPdf(b)).save();
    const doc = await PDFDocument.load(r.bytes);
    return {
      stripped: r.stripped.map((x) => x.what),
      text: doc.context
        .enumerateIndirectObjects()
        .map(([, o]) => String(o))
        .join('\n'),
    };
  };
  const refusedInc = async (b) => {
    const d = await loadPdf(b);
    d.setInfo({ title: 'x' });
    await expect(d.saveIncremental()).rejects.toMatchObject({ code: 'E_ACTIVE' });
  };
  it('a dictionary shaped as a structure element (/S /Sect, /P) outside the tree: its /A is an action place', async () => {
    const b = tagged('<< /Type /StructElem /S /P /P 5 0 R /K [] >>', [
      '<< /S /Sect /P 6 0 R /A << /S /Nonstandard /F (calc.exe) >> >>',
    ]);
    const r = await after(b);
    expect(r.text).not.toMatch(/Nonstandard|calc\.exe/);
    expect(r.stripped.join()).toMatch(/Nonstandard action/);
    await refusedInc(b);
  });
  it('a real structure element whose /A is an action dictionary (/S /JavaScript, or any /S): judged as an action', async () => {
    for (const a of [
      '<< /S /JavaScript /JS (app.alert\\(1\\)) >>',
      '<< /S /Nonstandard /F (calc.exe) >>',
      '[<< /O /Layout /Placement /Block >> << /S /Nonstandard >>]',
    ]) {
      const b = tagged(`<< /Type /StructElem /S /P /P 5 0 R /K [] /A ${a} >>`, ['<< >>']);
      const r = await after(b);
      expect(r.text, a).not.toMatch(/JavaScript|Nonstandard|calc\.exe/);
      await refusedInc(b);
    }
  });
  it('a structure element whose /S is no standard type nor in the /RoleMap is not one', async () => {
    const b = tagged('<< /Type /StructElem /S /Bogus /P 5 0 R /K [] /A << /O /Layout >> >>', ['<< >>']);
    expect((await after(b)).stripped.join()).toMatch(/untyped action/);
  });
  it('an annotation shaped like a structure element (/S, /P) still has its /A checked', async () => {
    const b = rawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Annots [4 0 R] >>',
      '<< /Type /Annot /Subtype /Link /S /Table /P 3 0 R /Rect [0 0 10 10] /A << /S /JavaScript /JS (app.alert(1)) >> >>',
    ]);
    const r = await (await loadPdf(b)).save();
    expect(Buffer.from(r.bytes).toString('latin1')).not.toMatch(/JavaScript/);
    await expect((await loadPdf(b)).saveIncremental()).rejects.toMatchObject({ code: 'E_ACTIVE' });
  });
});

describe('R4: saveIncremental refuses what save() would rewrite, not only what it would drop', () => {
  const doc = (annot, extra = []) =>
    rawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Annots [4 0 R] >>',
      annot,
      ...extra,
    ]);
  const csv = ['<< /Type /EmbeddedFile /Subtype /text#2Fcsv >>', Buffer.from('a,b\n')];
  const refused = async (b) => {
    const d = await loadPdf(b);
    d.setInfo({ title: 'x' });
    return d.saveIncremental();
  };
  it('a URI that checkUrl normalises (a space): refused', async () => {
    await expect(
      refused(doc('<< /Type /Annot /Subtype /Link /Rect [0 0 9 9] /A << /S /URI /URI (https://example.com/a b) >> >>')),
    ).rejects.toMatchObject({ code: 'E_ACTIVE', message: expect.stringMatching(/rewrit/) });
  });
  it('a file name with a directory part and trailing dots: refused', async () => {
    await expect(
      refused(
        doc(
          '<< /Type /Annot /Subtype /FileAttachment /Rect [0 0 9 9] /FS << /Type /Filespec /F (..\\\\x\\\\data.csv..) /UF (..\\\\x\\\\data.csv..) /EF << /F 5 0 R >> >> >>',
          [csv],
        ),
      ),
    ).rejects.toMatchObject({ code: 'E_ACTIVE', message: expect.stringMatching(/rewrit/) });
  });
  it('/EF with different /F and /UF streams (save() keeps one): refused', async () => {
    await expect(
      refused(
        doc(
          '<< /Type /Annot /Subtype /FileAttachment /Rect [0 0 9 9] /FS << /Type /Filespec /F (data.csv) /UF (data.csv) /EF << /F 5 0 R /UF 6 0 R >> >> >>',
          [csv, csv],
        ),
      ),
    ).rejects.toMatchObject({ code: 'E_ACTIVE' });
  });
  it('a URI and a file name save() writes unchanged still update', async () => {
    const r = await refused(
      doc(
        '<< /Type /Annot /Subtype /FileAttachment /Rect [0 0 9 9] /A << /S /URI /URI (https://example.com/) >> /FS << /Type /Filespec /F (data.csv) /UF (data.csv) /EF << /F 5 0 R >> >> >>',
        [csv],
      ),
    );
    expect(r.activeContent).toEqual([]);
  });
});

describe('the whole-file check reads objects as a repairing viewer does, and checks every candidate entry', () => {
  /** a clean one-page file with this text as the data of a stream nothing refers to */
  const inStream = (text) =>
    rawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
      ['<< >>', Buffer.from(text, 'latin1')],
    ]);
  const update = async (b) => {
    const d = await loadPdf(b);
    d.setInfo({ title: 'x' });
    return d.saveIncremental();
  };
  const js = '<< /S /JavaScript /JS (app.alert\\(1\\)) >>';
  const hidden = {
    'a comment between the generation and "obj"': `\n9 0 %note\nobj ${js} endobj\n`,
    'a comment between the number and the generation': `\n9 %note\n0 obj ${js} endobj\n`,
    'a seven-digit generation': `\n9 0000000 obj ${js} endobj\n`,
    'object number 0': `\n0 0 obj ${js} endobj\n`,
    'the number right after a {': `\n{9 0 obj ${js} endobj\n`,
    'an object stream whose first member is broken: the second is still read': `\n9 0 obj << /Type /ObjStm /N 2 /First 10 >> stream\n10 99 11 0\n${js}\nendstream endobj\n`,
    'an object stream member past /N': `\n9 0 obj << /Type /ObjStm /N 1 /First 10 >> stream\n10 0 11 2\n1 ${js}\nendstream endobj\n`,
  };
  for (const [name, text] of Object.entries(hidden)) {
    it(`in stream data, ${name}: found, refused`, async () => {
      await expect(update(inStream(text))).rejects.toMatchObject({ code: 'E_ACTIVE' });
    });
  }
  it('two subsections listing object 4: the row a first-wins reader takes is checked too', async () => {
    const b = Buffer.from(inStream(`\nx4 0 obj ${js} endobj\n`)).toString('latin1');
    const hiddenAt = b.indexOf('x4 0 obj') + 1,
      x = b.lastIndexOf('\nxref\n') + 1;
    const t = b.slice(x).replace('xref\n0 5\n', `xref\n4 1\n${String(hiddenAt).padStart(10, '0')} 00000 n\r\n0 5\n`);
    await expect(update(new Uint8Array(Buffer.from(b.slice(0, x) + t, 'latin1')))).rejects.toMatchObject({
      code: 'E_ACTIVE',
      message: expect.stringMatching(/where it is not/),
    });
  });
  it('an object stream entry whose index holds another object: refused (readers by index and by number disagree)', async () => {
    const parts = [];
    let pos = 0;
    const add = (s) => {
      const u = Buffer.from(s, 'latin1');
      parts.push(u);
      pos += u.length;
      return pos - u.length;
    };
    add('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
    const offs = [0];
    offs.push(add('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'));
    offs.push(add('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'));
    offs.push(add('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /X 10 0 R /Y 11 0 R >>\nendobj\n'));
    const body = '10 0 11 6\n(ten) (eleven)';
    offs.push(
      add(`4 0 obj\n<< /Type /ObjStm /N 2 /First 10 /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n`),
    );
    const xat = pos;
    const row = (t, a, b) =>
      Buffer.from([t, (a >>> 24) & 255, (a >>> 16) & 255, (a >>> 8) & 255, a & 255, b >> 8, b & 255]);
    const data = Buffer.concat([
      row(0, 0, 65535),
      ...[1, 2, 3, 4].map((n) => row(1, offs[n], 0)),
      row(1, xat, 0),
      row(2, 4, 1),
      row(2, 4, 0),
    ]); // 10 → index 1 (holds 11), 11 → index 0
    add(`5 0 obj\n<< /Type /XRef /Size 6 /Index [0 6 10 2] /W [1 4 2] /Root 1 0 R /Length ${data.length} >>\nstream\n`);
    parts.push(data);
    pos += data.length;
    add(`\nendstream\nendobj\nstartxref\n${xat}\n%%EOF\n`);
    await expect(update(new Uint8Array(Buffer.concat(parts)))).rejects.toMatchObject({
      code: 'E_ACTIVE',
      message: expect.stringMatching(/at index/),
    });
  });
});

describe("R5: saveIncremental enforces what the file's signatures permit (DocMDP, FieldMDP, ReadOnly; shadow attacks)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r5-'));
  let signer;
  beforeAll(() => {
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
        '/CN=R5',
      ],
      { stdio: 'ignore' },
    );
    signer = nodeSigner({
      key: fs.readFileSync(path.join(dir, 'k.pem')),
      certs: fs.readFileSync(path.join(dir, 'c.pem'), 'utf8'),
    });
  });
  const pdfsig = (b) => {
    const f = path.join(dir, `s${Math.random().toString(36).slice(2)}.pdf`);
    fs.writeFileSync(f, b);
    try {
      return execFileSync('pdfsig', [f], { encoding: 'utf8' });
    } catch (e) {
      return String(e.stdout);
    }
  };
  /** a form with a text field (and one more), signed: certify 1–3, or none; o: the text field's options */
  const signedForm = (certify, o = {}, more = () => {}) =>
    toBytes(
      async (pdf) => {
        const f = pdf.standardFont('Helvetica'),
          p = pdf.addPage();
        p.text('Contract', { x: 40, y: 40, font: f });
        pdf.form.textField('name', { page: p, x: 40, y: 100, width: 200, height: 20, font: f, ...o });
        pdf.form.textField('other', { page: p, x: 40, y: 140, width: 200, height: 20, font: f });
        pdf.form.signature('later', { page: p, x: 300, y: 300, width: 150, height: 40 });
        more(pdf, p, f);
        await pdf.sign(
          { name: 'first', page: p, x: 40, y: 200, width: 200, height: 40 },
          { signer, ...(certify ? { certify } : {}) },
        );
      },
      { sign: true, creationDate: new Date('2026-01-01') },
    );
  const FILL = { allowFillAfterSigning: true };
  const refuse = async (b, edit, o, re) => {
    const d = await loadPdf(b);
    edit(d);
    await expect(d.saveIncremental(o)).rejects.toMatchObject({
      code: 'E_SIGNED',
      message: expect.stringMatching(re ?? /./),
    });
  };
  /** a hand-made signed form: objects as text; field 4 'name', 5 'other', 6 the signed signature field whose /V is 8 */
  const handSigned = ({
    sigV = '<< /Type /Sig /Filter /Adobe.PPKLite /ByteRange [0 1 2 3] /Contents <00> >>',
    lock = '',
    perms = '',
    nameFf = '',
    parent = false,
  } = {}) =>
    rawPdf([
      `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [${parent ? '9 0 R' : '4 0 R'} 5 0 R 6 0 R] >> ${perms} >>`,
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [4 0 R 5 0 R 6 0 R] >>',
      `<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /Rect [40 600 240 620] /P 3 0 R /DA (/Helv 12 Tf 0 g) ${parent ? '/Parent 9 0 R' : nameFf} >>`,
      '<< /Type /Annot /Subtype /Widget /FT /Tx /T (other) /Rect [40 560 240 580] /P 3 0 R /DA (/Helv 12 Tf 0 g) >>',
      `<< /Type /Annot /Subtype /Widget /FT /Sig /T (sig) /Rect [300 600 450 640] /P 3 0 R /V 8 0 R ${lock} >>`,
      '<< >>',
      sigV,
      `<< /T (group) /Kids [4 0 R] ${nameFf} >>`,
    ]);

  it.skipIf(!HAS.poppler)(
    'a certified P=1 file: every update refused (a fill, a new signature); pdfsig says the original is valid',
    async () => {
      const b = await signedForm(1);
      expect(pdfsig(b)).toMatch(/Signature is Valid/);
      await refuse(b, (d) => d.fill({ name: 'Arun' }), FILL, /P 1/);
      await refuse(b, () => {}, { sign: { field: 'later', signer } }, /P 1/);
    },
    30_000,
  );
  it("P=1 from a signature's /Reference alone (no /Perms): refused", async () => {
    await refuse(
      handSigned({
        sigV: '<< /Type /Sig /ByteRange [0 1 2 3] /Contents <00> /Reference [<< /TransformMethod /DocMDP /TransformParams << /P 1 >> >>] >>',
      }),
      (d) => d.fill({ other: 'x' }),
      FILL,
      /P 1/,
    );
  });
  it('a DocMDP without /P is P=2: a fill passes, rotation is refused', async () => {
    const b = handSigned({
      sigV: '<< /Type /Sig /ByteRange [0 1 2 3] /Contents <00> /Reference [<< /TransformMethod /DocMDP /TransformParams << /V /1.2 >> >>] >>',
    });
    await refuse(b, (d) => d.page(0).rotate(90), { allowChangesAfterSigning: true }, /P 2/);
    const d = await loadPdf(b);
    d.fill({ other: 'x' });
    await d.saveIncremental(FILL);
  });
  it('a garbled policy fails closed: an unknown /TransformMethod, a /P of 7, a /Reference that is not an array, a /Fields of numbers', async () => {
    for (const sigV of [
      '<< /Type /Sig /ByteRange [0 1 2 3] /Contents <00> /Reference [<< /TransformMethod /Bogus >>] >>',
      '<< /Type /Sig /ByteRange [0 1 2 3] /Contents <00> /Reference [<< /TransformMethod /DocMDP /TransformParams << /P 7 >> >>] >>',
      '<< /Type /Sig /ByteRange [0 1 2 3] /Contents <00> /Reference 5 >>',
      '<< /Type /Sig /ByteRange [0 1 2 3] /Contents <00> /Reference [<< /TransformMethod /FieldMDP /TransformParams << /Action /Include /Fields [1 2] >> >>] >>',
    ]) {
      await refuse(handSigned({ sigV }), (d) => d.fill({ other: 'x' }), FILL, /cannot be read/);
    }
  });
  it('a lock from the field /Lock only, an /Exclude lock, a listed parent locking its kid', async () => {
    await refuse(
      handSigned({ lock: '/Lock << /Action /Include /Fields [(name)] >>' }),
      (d) => d.fill({ name: 'x' }),
      FILL,
      /locked/,
    );
    await refuse(
      handSigned({ lock: '/Lock << /Action /Exclude /Fields [(other)] >>' }),
      (d) => d.fill({ name: 'x' }),
      FILL,
      /locked/,
    );
    await refuse(
      handSigned({ parent: true, lock: '/Lock << /Action /Include /Fields [(group)] >>' }),
      (d) => d.fill({ 'group.name': 'x' }),
      FILL,
      /locked/,
    );
    const d = await loadPdf(handSigned({ lock: '/Lock << /Action /Exclude /Fields [(other)] >>' }));
    d.fill({ other: 'x' });
    await d.saveIncremental(FILL);
  });
  it('a ReadOnly flag on a parent applies to its kid (whose own /Ff does not lift it)', async () => {
    await refuse(
      handSigned({ parent: true, nameFf: '/Ff 1' }),
      (d) => d.fill({ 'group.name': 'x' }),
      FILL,
      /read-only/,
    );
  });
  it('a signed document: a fill without allowFillAfterSigning is refused', async () => {
    await refuse(await signedForm(0), (d) => d.fill({ name: 'x' }), undefined, /allowFillAfterSigning/);
  }, 30_000);
  it('with allowFillAfterSigning: 10 small overlay widgets summing past 40% of the page refused; an opaque one over the signed text refused', async () => {
    const b = await signedForm(0, {}, (pdf, p, f) => {
      for (let i = 0; i < 10; i++)
        pdf.form.textField(`o${i}`, { page: p, x: 0, y: 200 + i * 60, width: 595, height: 40, font: f });
    });
    await refuse(
      b,
      (d) => d.fill(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`o${i}`, 'x']))),
      FILL,
      /in sum|cover more than 40%/,
    );
    await refuse(
      await signedForm(0, { x: 0, y: 0, width: 595, height: 200, background: '#ffffff' }),
      (d) => d.fill({ name: 'x' }),
      FILL,
      /opaque background/,
    );
  }, 30_000);
  it.skipIf(!HAS.poppler)(
    'a certified P=2 file: a small field filled and a signature added (new or the empty field) pass; pdfsig: #1 valid and changed after signing; rotation, Info, XMP refused',
    async () => {
      const b = await signedForm(2);
      const d = await loadPdf(b);
      d.fill({ name: 'Arun' });
      const r = await d.saveIncremental({ ...FILL, sign: { field: 'later', signer } });
      const out = pdfsig(r.bytes); // the certification's own bytes still verify, and poppler says the document changed after it
      expect(out).toMatch(/Field Name: first[^#]*Not total document signed[^#]*Signature is Valid/);
      expect(out).toMatch(/Field Name: later[^#]*Total document signed[^#]*Signature is Valid/);
      await (
        await loadPdf(b)
      ).saveIncremental({ sign: { field: { name: 'new', page: 0, x: 300, y: 500, width: 100, height: 30 }, signer } });
      await refuse(b, (x) => x.page(0).rotate(90), undefined, /rotation/);
      await refuse(b, (x) => x.setInfo({ title: 'x' }), { allowChangesAfterSigning: true }, /Info/);
      await refuse(b, (x) => x.setXmp('<x/>'), undefined, /XMP/);
    },
    30_000,
  );
  it.skipIf(!HAS.poppler)(
    "a field locked by a signature's FieldMDP /Lock, signed by us: its fill refused, another field filled (pdfsig valid)",
    async () => {
      const form = rawPdf([
        '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R 5 0 R 6 0 R] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 7 0 R >> >> >> >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [4 0 R 5 0 R 6 0 R] >>',
        '<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /Rect [40 600 240 620] /P 3 0 R /DA (/Helv 12 Tf 0 g) >>',
        '<< /Type /Annot /Subtype /Widget /FT /Tx /T (other) /Rect [40 560 240 580] /P 3 0 R /DA (/Helv 12 Tf 0 g) >>',
        '<< /Type /Annot /Subtype /Widget /FT /Sig /T (sig) /Rect [300 600 450 640] /P 3 0 R /Lock << /Type /SigFieldLock /Action /Include /Fields [(name)] >> >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      ]);
      const s = await (await loadPdf(form)).saveIncremental({ sign: { field: 'sig', signer } });
      expect(pdfsig(s.bytes)).toMatch(/Signature is Valid/);
      await refuse(s.bytes, (d) => d.fill({ name: 'Mallory' }), FILL, /locked/);
      const d = await loadPdf(s.bytes);
      d.fill({ other: 'fine' });
      expect(pdfsig((await d.saveIncremental(FILL)).bytes)).toMatch(
        /Not total document signed[\s\S]*Signature is Valid/,
      );
    },
    30_000,
  );
  it('signed without DocMDP: rotation and Info need allowChangesAfterSigning; a new signature passes', async () => {
    const b = await signedForm(0);
    await refuse(b, (x) => x.page(0).rotate(90), undefined, /allowChangesAfterSigning/);
    await refuse(b, (x) => x.setInfo({ title: 'x' }), undefined, /allowChangesAfterSigning/);
    const e = await loadPdf(b);
    e.page(0).rotate(90);
    e.setInfo({ title: 'x' });
    await e.saveIncremental({ allowChangesAfterSigning: true });
    await (await loadPdf(b)).saveIncremental({ sign: { field: 'later', signer } });
  }, 30_000);
});

describe('control regression: the in-stream test is right whatever order the byte-scan hits come in', () => {
  it('inRegion: boundaries, adjacent and overlapping regions, unsorted input, regions added later, a query going back', () => {
    const regions = [
      [50, 60],
      [10, 20],
      [20, 30],
      [15, 40],
    ];
    const q = inRegion(regions, { tick() {} });
    expect([9, 10, 19, 20, 29, 39, 40, 49, 50, 59, 60].map(q)).toEqual([
      false,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      true,
      true,
      false,
    ]);
    regions.push([70, 80]);
    expect([69, 70, 79, 80].map(q)).toEqual([false, true, true, false]);
    expect([5, 12, 45, 75].map(q)).toEqual([false, true, false, true]); // back again: still right
  });
  it('a hit whose number a comment puts before an earlier hit, unreadable, not in stream data: refused', async () => {
    // inside a string (the tokens see one string): "9 0" then comment lines then "obj": the scan's hit for it comes
    // after hits whose stream region lies past its number; read in 'obj' order, that region made it look in a stream
    const s = [
      '9 0 %c',
      '%5 0 obj<</Length 2>>stream',
      `%7 0 obj ${'['.repeat(300)}`,
      '%endstream',
      'obj << /Type /ObjStm /N -1 /First 0 /Length 1 >> stream',
      'x',
      'endstream',
    ].join('\n');
    const b = rawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>',
      `(${s})`,
    ]);
    const d = await loadPdf(b);
    d.setInfo({ title: 'x' });
    await expect(d.saveIncremental()).rejects.toMatchObject({
      code: 'E_ACTIVE',
      message: expect.stringMatching(/could not be checked/),
    });
  });
});

describe('R5 (final review F1): a signature written directly in a field /V still makes the document signed', async () => {
  const { rawPdf } = await import('./reader-tools.js');
  const { loadPdf } = await import('../src/index.js');
  const SIG = '<< /Type /Sig /Filter /Adobe.PPKLite /ByteRange [0 1 2 3] /Contents <00> >>';
  const mk = (V, perms = '') =>
    rawPdf([
      `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R 5 0 R] /SigFlags 3 >> ${perms} >>`,
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [4 0 R 5 0 R] >>',
      '<< /Type /Annot /Subtype /Widget /FT /Tx /T (other) /Rect [40 560 240 580] /P 3 0 R /DA (/Helv 12 Tf 0 g) >>',
      `<< /Type /Annot /Subtype /Widget /FT /Sig /T (sig) /Rect [300 600 450 640] /P 3 0 R /V ${V} >>`,
    ]);
  const fill = async (b, o) => {
    const d = await loadPdf(b);
    d.fill({ other: 'x' });
    return d.saveIncremental(o);
  };
  it('a direct /V signature: a fill needs allowFillAfterSigning', async () => {
    await expect(fill(mk(SIG))).rejects.toMatchObject({ code: 'E_SIGNED' });
    await expect(fill(mk(SIG), { allowFillAfterSigning: true })).resolves.toBeTruthy();
  });
  it('a direct /V with a DocMDP P 1 reference refuses every update, opt-in or not', async () => {
    const v =
      '<< /Type /Sig /ByteRange [0 1 2 3] /Contents <00> /Reference [<< /TransformMethod /DocMDP /TransformParams << /P 1 >> >>] >>';
    await expect(fill(mk(v), { allowFillAfterSigning: true })).rejects.toMatchObject({ code: 'E_SIGNED' });
  });
});

describe('R5 (final review F1, follow-up): every signature dictionary counts, wherever it is written', async () => {
  const { rawPdf } = await import('./reader-tools.js');
  const { loadPdf } = await import('../src/index.js');
  const SIG = '<< /Type /Sig /Filter /Adobe.PPKLite /ByteRange [0 1 2 3] /Contents <00> >>';
  const fill = async (b, o) => {
    const d = await loadPdf(b);
    d.fill({ other: 'x' });
    return d.saveIncremental(o);
  };
  const base = (sigField, extraCatalog = '') =>
    rawPdf([
      `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R 5 0 R] /SigFlags 3 >> ${extraCatalog} >>`,
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [4 0 R 6 0 R] >>',
      '<< /Type /Annot /Subtype /Widget /FT /Tx /T (other) /Rect [40 560 240 580] /P 3 0 R /DA (/Helv 12 Tf 0 g) >>',
      sigField,
      '<< /Type /Annot /Subtype /Widget /Parent 5 0 R /Rect [300 600 450 640] /P 3 0 R >>',
    ]);
  it('/FT /Sig inherited from a parent field, the signature written directly in the parent /V', async () => {
    await expect(fill(base(`<< /FT /Sig /T (sig) /Kids [6 0 R] /V ${SIG} >>`))).rejects.toMatchObject({
      code: 'E_SIGNED',
    });
  });
  it('a field with no /FT at all holding a direct signature /V', async () => {
    await expect(fill(base(`<< /T (sig) /Kids [6 0 R] /V ${SIG} >>`))).rejects.toMatchObject({ code: 'E_SIGNED' });
  });
  it('a signature dictionary nested somewhere else in the catalog', async () => {
    await expect(fill(base('<< /T (sig) /Kids [6 0 R] >>', `/Extra [ << /Deep ${SIG} >> ]`))).rejects.toMatchObject({
      code: 'E_SIGNED',
    });
  });
  it('a DocMDP P 1 reference inside a nested signature still refuses with the opt-in', async () => {
    const v =
      '<< /Type /Sig /ByteRange [0 1 2 3] /Contents <00> /Reference [<< /TransformMethod /DocMDP /TransformParams << /P 1 >> >>] >>';
    await expect(
      fill(base(`<< /T (sig) /Kids [6 0 R] /V ${v} >>`), { allowFillAfterSigning: true }),
    ).rejects.toMatchObject({ code: 'E_SIGNED' });
  });
  it('an unsigned form still fills without any option', async () => {
    await expect(fill(base('<< /FT /Sig /T (sig) /Kids [6 0 R] >>'))).resolves.toBeTruthy();
  });
});

describe('/ActualText cannot amplify the text an extraction makes', () => {
  it('a 1 MB ActualText used by 10,000 spans is ignored (a warning), the glyphs read: fast, no blow-up', () => {
    const r = child('actualtext-1mb', 20);
    expect(r.code).toBe('OK');
    expect(r.text).toMatch(/^10000 .*ActualText longer than 4096/);
    expect(r.ms).toBeLessThan(5000);
  }, 30_000);
  it('a 4,000-character ActualText used by 10,000 spans stops at the characters a page may make (E_BUDGET)', () => {
    const r = child('actualtext-4k', 20);
    expect(r.code).toBe('E_BUDGET');
    expect(r.message).toMatch(/characters of text/);
    expect(r.ms).toBeLessThan(5000);
  }, 30_000);
  it('10,000 nested spans: the outermost is read once', () => {
    const r = child('actualtext-nested', 20);
    expect(r).toMatchObject({ code: 'OK', text: '4000' });
  }, 30_000);
});

describe('the embedded-cmap fallback (Identity-H, no ToUnicode) has its limits', () => {
  it('150 fonts, each its own 300 KB font program: E_BUDGET after 100 programs, quickly', () => {
    const r = child('cmap-fonts-many', 30);
    expect(r.code).toBe('E_BUDGET');
    expect(r.message).toMatch(/character maps of more than 100 embedded fonts/);
    expect(r.ms).toBeLessThan(10_000);
  }, 40_000);
  it('1,000 fonts sharing one program read it once: the text comes out', () => {
    const r = child('cmap-fonts-shared', 30);
    expect(r).toMatchObject({ code: 'OK' });
    expect(r.text).toMatch(/A/);
    expect(r.ms).toBeLessThan(5_000);
  }, 40_000);
});
