// The reader's CONTROL INVENTORY: one hostile file per control the security fixes added, each checked on BOTH
// paths: save() must strip (or rewrite) it, so neither our own whole-file audit nor pdf-lib finds it in the output,
// and saveIncremental (which cannot remove bytes) must refuse. The resource cases (a CMap OOM, a /W CPU loop) are
// run in a child process with a 512 MB heap and must end in a typed error. A control that regresses fails here.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import { loadPdf, toBytes, nodeSigner } from '../src/index.js';
import { internal } from '../src/reader/pdf.js';
import { findActive } from '../src/reader/active.js';
import { rawPdf } from './reader-tools.js';

const JS = '<< /S /JavaScript /JS (app.alert\\(1\\)) >>';
const BAD = /JavaScript|\/JS\b|Launch|calc\.exe|XFA|RichMedia|Nonstandard|evil/;
/** a one-page file: catalog extras, page extras, more objects from 4 */
const doc = ({ cat = '', page = '', extra = [] } = {}) => rawPdf([`<< /Type /Catalog /Pages 2 0 R ${cat} >>`, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] ${page} >>`, ...extra]);
/** a clean file with raw text inserted before its xref table (the table and startxref shifted) */
const withRaw = (raw) => {
  const s = Buffer.from(doc()).toString('latin1'), x = s.lastIndexOf('\nxref\n') + 1;
  return new Uint8Array(Buffer.from(s.slice(0, x) + raw + s.slice(x).replace(/startxref\n\d+/, `startxref\n${x + raw.length}`), 'latin1'));
};
const inStream = (text) => doc({ extra: [['<< >>', Buffer.from(text, 'latin1')]] });

/** two revisions with xref streams: rev 1's object stream holds a JavaScript action the catalog opens; rev 2's catalog no longer does */
function earlierObjStm() {
  const parts = []; let pos = 0;
  const add = (s) => { const u = typeof s === 'string' ? Buffer.from(s, 'latin1') : s; parts.push(u); pos += u.length; return pos - u.length; };
  const row = (t, a, b) => Buffer.from([t, a >>> 24 & 255, a >>> 16 & 255, a >>> 8 & 255, a & 255, b >> 8, b & 255]);
  add('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
  const o = [0, add('1 0 obj\n<< /Type /Catalog /Pages 2 0 R /OpenAction 10 0 R >>\nendobj\n'), add('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'), add('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>\nendobj\n')];
  const body = `10 0 ${JS}`;
  o.push(add(`4 0 obj\n<< /Type /ObjStm /N 1 /First 5 /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n`));
  const x1 = pos;
  const d1 = Buffer.concat([row(0, 0, 65535), ...[1, 2, 3, 4].map((n) => row(1, o[n], 0)), row(1, x1, 0), row(2, 4, 0)]);
  add(`5 0 obj\n<< /Type /XRef /Size 11 /Index [0 6 10 1] /W [1 4 2] /Root 1 0 R /Length ${d1.length} >>\nstream\n`); add(d1); add(`\nendstream\nendobj\nstartxref\n${x1}\n%%EOF\n`);
  const c2 = add('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  const x2 = pos;
  const d2 = Buffer.concat([row(1, c2, 0), row(1, x2, 0)]);
  add(`6 0 obj\n<< /Type /XRef /Size 11 /Index [1 1 6 1] /W [1 4 2] /Root 1 0 R /Prev ${x1} /Length ${d2.length} >>\nstream\n`); add(d2); add(`\nendstream\nendobj\nstartxref\n${x2}\n%%EOF\n`);
  return new Uint8Array(Buffer.concat(parts));
}

const csv = ['<< /Type /EmbeddedFile /Subtype /text#2Fcsv >>', Buffer.from('a,b\n')];
const attach = (name) => doc({ page: '/Annots [4 0 R]', extra: [`<< /Type /Annot /Subtype /FileAttachment /Rect [0 0 9 9] /FS << /Type /Filespec /F ${name} /UF ${name} /EF << /F 5 0 R >> >> >>`, csv] });

/** name → [bytes, what save() must show instead of the original (default: nothing BAD in the output)] */
const ACTIVE = {
  'an indirect Launch action': () => doc({ cat: '/OpenAction 4 0 R', extra: ['<< /S /Launch /F (calc.exe) >>'] }),
  'a /Next array holding JavaScript': () => doc({ cat: `/OpenAction << /S /GoTo /D [3 0 R /Fit] /Next [${JS}] >>` }),
  'Names /JavaScript': () => doc({ cat: `/Names << /JavaScript << /Names [(a) ${JS}] >> >>` }),
  'an XFA form': () => doc({ cat: '/AcroForm << /Fields [] /XFA (x) >>' }),
  'a RichMedia annotation': () => doc({ page: '/Annots [<< /Type /Annot /Subtype /RichMedia /Rect [0 0 9 9] >>]' }),
  'an earlier duplicate of the catalog with JavaScript': () => {
    const ins = `1 0 obj << /Type /Catalog /Pages 2 0 R /OpenAction ${JS} >> endobj\n`, s = Buffer.from(doc()).toString('latin1');
    const shift = (v) => String(Number(v) + ins.length).padStart(10, '0');
    return new Uint8Array(Buffer.from(s.replace('%\xe2\xe3\xcf\xd3\n', `%\xe2\xe3\xcf\xd3\n${ins}`).replace(/(\d{10}) 00000 n/g, (m, v) => `${shift(v)} 00000 n`).replace(/startxref\n(\d+)/, (m, v) => `startxref\n${Number(v) + ins.length}`), 'latin1'));
  },
  'JavaScript in an object nothing refers to': () => withRaw(`9 0 obj ${JS} endobj\n`),
  'JavaScript in an earlier revision\'s object stream': earlierObjStm,
  'JavaScript in stream data (a repair scan finds it)': () => inStream(`\n9 0 obj ${JS} endobj\n`),
  '"n g obj" with \\0 and \\f between the tokens': () => withRaw(`9\x000\x0cobj ${JS} endobj\n`),
  '"n g obj" with a comment between the tokens, in stream data': () => inStream(`\n9 0 %c\nobj ${JS} endobj\n`),
  'an object without endobj': () => withRaw(`9 0 obj ${JS}\n10 0 obj << /A 1 >>\n`),
  'an unreadable object whose number a comment puts before an earlier hit (in a string)': () => doc({ extra: [`(${['9 0 %c', '%5 0 obj<</Length 2>>stream', `%7 0 obj ${'['.repeat(300)}`, '%endstream', 'obj << /Type /ObjStm /N -1 /First 0 /Length 1 >> stream', 'x', 'endstream'].join('\n')})`] }),
  'a structure-element-shaped dictionary (forged /P) with an action under /A': () => doc({ page: '/X 4 0 R', extra: ['<< /S /Sect /P 3 0 R /A << /S /Nonstandard /F (calc.exe) >> >>'] }),
};
/** save() rewrites these (the output, read back, holds the rewritten value); saveIncremental must refuse */
const uri = async (b) => (await loadPdf(b)).page(0).annotations().find((x) => x.uri)?.uri;
const file = async (b) => (await loadPdf(b)).attachments[0]?.rawName;
const REWRITTEN = {
  'a URI that needs normalising': [() => doc({ page: '/Annots [<< /Type /Annot /Subtype /Link /Rect [0 0 9 9] /A << /S /URI /URI (https://example.com/a b) >> >>]' }), uri, 'https://example.com/a%20b'],
  'a file name with a directory part': [() => attach('(..\\\\x\\\\data.csv)'), file, 'data.csv'],
  'a file name with trailing dots': [() => attach('(data.csv..)'), file, 'data.csv'],
};

async function saved(bytes) {
  const r = await (await loadPdf(bytes)).save();
  const pl = await PDFDocument.load(r.bytes);
  return { r, text: pl.context.enumerateIndirectObjects().map(([, v]) => String(v)).join('\n'), audit: findActive(internal(await loadPdf(r.bytes), 't')) };
}
async function incremental(bytes) {
  const d = await loadPdf(bytes);
  d.setInfo({ title: 'x' });
  return d.saveIncremental();
}

describe('reader controls: save() strips, saveIncremental refuses', () => {
  for (const [name, make] of Object.entries(ACTIVE)) {
    it(`${name}: save() strips`, async () => {
      const { text, audit } = await saved(make());
      expect(audit).toEqual([]);
      expect(text).not.toMatch(BAD);
    });
    it(`${name}: saveIncremental refuses`, async () => {
      await expect(incremental(make())).rejects.toMatchObject({ code: 'E_ACTIVE' });
    });
  }
  for (const [name, [make, read, want]] of Object.entries(REWRITTEN)) {
    it(`${name}: save() rewrites`, async () => {
      expect(await read(make())).not.toBe(want);
      const { r, audit } = await saved(make());
      expect(audit).toEqual([]);
      expect(await read(r.bytes)).toBe(want);
    });
    it(`${name}: saveIncremental refuses`, async () => {
      await expect(incremental(make())).rejects.toMatchObject({ code: 'E_ACTIVE' });
    });
  }
});

describe('reader controls: resources end in a typed error (child process, 512 MB heap)', () => {
  const child = (name) => {
    const r = spawnSync(process.execPath, ['--max-old-space-size=512', path.join(import.meta.dirname, 'reader-hostile-child.mjs'), name], { encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' });
    const line = r.stdout.trim().split('\n').pop();
    return r.status === 0 && line ? JSON.parse(line) : { code: r.signal ? `killed:${r.signal}` : `exit:${r.status}` };
  };
  it('a ToUnicode CMap bfrange that would copy a 20 KB destination 65,536 times: no OOM', () => expect(child('cmap-long-dst').code).toBe('OK'), 30_000);
  it('a /W that repeats 0 65535 500: a typed error within its timeoutMs', () => expect(['E_BUDGET', 'E_TIMEOUT']).toContain(child('w-ranges').code), 30_000);
});

describe('reader controls: a certified (DocMDP P 1) document', () => {
  let b;
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '30', '-subj', '/CN=C'], { stdio: 'ignore' });
    const signer = nodeSigner({ key: fs.readFileSync(path.join(dir, 'k.pem')), certs: fs.readFileSync(path.join(dir, 'c.pem'), 'utf8') });
    b = await toBytes(async (pdf) => {
      const f = pdf.standardFont('Helvetica'), p = pdf.addPage();
      pdf.form.textField('name', { page: p, x: 40, y: 100, width: 200, height: 20, font: f });
      await pdf.sign({ name: 's', page: p, x: 40, y: 200, width: 200, height: 40 }, { signer, certify: 1 });
    }, { sign: true, creationDate: new Date('2026-01-01') });
  });
  it('save() drops the signature value (a rewrite is not the signed bytes)', async () => {
    const d = await loadPdf(b);
    d.fill({ name: 'x' });
    const r = await d.save();
    expect(r.stripped.map((x) => x.what).join()).toMatch(/signature value/);
  });
  it('saveIncremental refuses a fill', async () => {
    const d = await loadPdf(b);
    d.fill({ name: 'x' });
    await expect(d.saveIncremental()).rejects.toMatchObject({ code: 'E_SIGNED' });
  });
});

describe('reader controls: the signature policy of saveIncremental (fail closed, strictest source, fills opted into)', () => {
  const sig = (more = '') => `<< /Type /Sig /ByteRange [0 1 2 3] /Contents <00> ${more} >>`;
  /** a hand-made signed form: 4 'name' (or 'group.name' under 9), 5 'other', 6 the signed signature field */
  const form = ({ sigV = sig(), lock = '', ff = '', parent = false, rects = [] } = {}) => rawPdf([
    `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [${parent ? '9 0 R' : '4 0 R'} 5 0 R 6 0 R ${rects.map((_, i) => `${10 + i} 0 R`).join(' ')}] >> >>`, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [4 0 R 5 0 R 6 0 R ${rects.map((_, i) => `${10 + i} 0 R`).join(' ')}] >>`,
    `<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /Rect [40 600 240 620] /P 3 0 R /DA (/Helv 12 Tf 0 g) ${parent ? '/Parent 9 0 R' : ff} >>`,
    '<< /Type /Annot /Subtype /Widget /FT /Tx /T (other) /Rect [40 560 240 580] /P 3 0 R /DA (/Helv 12 Tf 0 g) >>',
    `<< /Type /Annot /Subtype /Widget /FT /Sig /T (sig) /Rect [300 600 450 640] /P 3 0 R /V 8 0 R ${lock} >>`, '<< >>', sigV,
    `<< /T (group) /Kids [4 0 R] ${ff} >>`, ...rects.map((r, i) => `<< /Type /Annot /Subtype /Widget /FT /Tx /T (o${i}) /Rect [${r}] /P 3 0 R /DA (/Helv 12 Tf 0 g) >>`)]);
  const FILL = { allowFillAfterSigning: true };
  const cases = {
    'P=1 in a signature\'s /Reference only': [form({ sigV: sig('/Reference [<< /TransformMethod /DocMDP /TransformParams << /P 1 >> >>]') }), (d) => d.fill({ other: 'x' }), FILL],
    'DocMDP without /P is P=2: rotation refused': [form({ sigV: sig('/Reference [<< /TransformMethod /DocMDP /TransformParams << >> >>]') }), (d) => d.page(0).rotate(90), { allowChangesAfterSigning: true }],
    'a garbled /Reference (fail closed)': [form({ sigV: sig('/Reference [<< /TransformMethod /Bogus >>]') }), (d) => d.fill({ other: 'x' }), FILL],
    'a lock from the field /Lock only': [form({ lock: '/Lock << /Action /Include /Fields [(name)] >>' }), (d) => d.fill({ name: 'x' }), FILL],
    'an /Exclude lock': [form({ lock: '/Lock << /Action /Exclude /Fields [(other)] >>' }), (d) => d.fill({ name: 'x' }), FILL],
    'a ReadOnly inherited from a parent': [form({ parent: true, ff: '/Ff 1' }), (d) => d.fill({ 'group.name': 'x' }), FILL],
    'a fill without allowFillAfterSigning': [form(), (d) => d.fill({ other: 'x' }), {}],
    '10 small overlay widgets over 40% of the page in sum': [form({ rects: Array.from({ length: 10 }, (_, i) => `0 ${i * 70} 612 ${i * 70 + 35}`) }), (d) => d.fill(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`o${i}`, 'x']))), FILL],
  };
  for (const [name, [b, edit, o]] of Object.entries(cases)) {
    it(`${name}: saveIncremental refuses (E_SIGNED)`, async () => {
      const d = await loadPdf(b);
      edit(d);
      await expect(d.saveIncremental(o)).rejects.toMatchObject({ code: 'E_SIGNED' });
    });
  }
  it('a legitimate fill of a small field, opted into, passes', async () => {
    const d = await loadPdf(form());
    d.fill({ other: 'x' });
    await d.saveIncremental(FILL);
  });
});
