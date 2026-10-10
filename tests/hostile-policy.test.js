// Group H security: the ONE registry (reader/policy.js) drives both paths. For every entry — each action type outside
// the allowlist, an unknown one, a Named action that is not a page move, each dangerous key, each annotation subtype
// outside the allowlist, URIs that are not plain ASCII (UTF-16 and UTF-8 BOMs, a NUL, a byte ≥ 0x80) or not safe,
// file specifications with a refused name under any key, an /Annots element of any shape, an action under an unusual
// key — save() drops it (qpdf QDF, our own audit and pdf-lib find none of it) AND saveIncremental refuses the file.
// The raw scan finds objects as a repairing viewer does: \0 and \f between the numbers, a comment after "obj", an
// earlier duplicate of an object, an object stream nothing refers to. Clean files (ours, pdf-lib's) still update.
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib';
import { loadPdf } from '../src/index.js';
import { internal } from '../src/reader/pdf.js';
import { findActive } from '../src/reader/active.js';
import { ACTION_TYPES, KEEP_ACTIONS, DANGEROUS_KEYS } from '../src/reader/policy.js';
import { rawPdf, enc, qdf, PY, seeds } from './reader-tools.js';

const hex = (b) => `<${Buffer.from(b).toString('hex')}>`;
/** a one-page file: catalog extra, page extra, annotations (text), more objects (from 6) */
const doc = ({ cat = '', page = '', annots = [], extra = [] } = {}) =>
  rawPdf([
    `<< /Type /Catalog /Pages 2 0 R ${cat} >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R ${page} ${annots.length ? `/Annots [${annots.join(' ')}]` : ''} >>`,
    ['<< /Length 0 >>', new Uint8Array(0)],
    '<< /Type /Annot /Subtype /Text /Rect [0 0 1 1] >>',
    ...extra,
  ]);
const link = (a) => `<< /Type /Annot /Subtype /Link /Rect [0 0 9 9] /A ${a} >>`;
const ef = (name, more = '') => `<< /Type /Filespec ${name} /EF << /F 6 0 R ${more} >> >>`;
const csv = ['<< /Type /EmbeddedFile /Subtype /text#2Fcsv >>', enc('a,b\n')];

const CASES = {};
for (const t of ACTION_TYPES)
  if (!KEEP_ACTIONS.has(t)) CASES[`action ${t}`] = () => doc({ annots: [link(`<< /S /${t} /F (x.exe) /JS (x) >>`)] });
CASES['an unknown action type'] = () => doc({ annots: [link('<< /S /DoSomething >>')] });
CASES['a Named action that is not a page move'] = () => doc({ annots: [link('<< /S /Named /N /Print >>')] });
for (const [k] of DANGEROUS_KEYS)
  CASES[`key /${k}`] = () =>
    doc(
      k === 'AA'
        ? { page: '/AA << /O << /S /GoTo /D [3 0 R /Fit] >> >>' }
        : k === 'JS'
          ? { cat: '/Foo << /JS (x) >>' }
          : k === 'JavaScript'
            ? { cat: '/Names << /JavaScript << /Names [(a) << /S /JavaScript /JS (x) >>] >> >>' }
            : { cat: '/AcroForm << /Fields [] /XFA (x) >>' },
    );
for (const st of ['RichMedia', 'Screen', 'Movie', 'Sound', '3D', 'Unknownish'])
  CASES[`annotation ${st}`] = () => doc({ annots: [`<< /Type /Annot /Subtype /${st} /Rect [0 0 9 9] >>`] });
CASES['an /Annots element without /Rect carrying /S /Launch'] = () =>
  doc({ annots: ['<< /S /Launch /F (calc.exe) >>'] });
CASES['an /Annots element with a /BBox'] = () =>
  doc({ annots: ['<< /Subtype /RichMedia /BBox [0 0 1 1] /Rect [0 0 1 1] >>'] });
CASES['an action under an unusual key'] = () => doc({ cat: '/Whatever << /S /Launch /F (calc.exe) >>' });
CASES['a URI with a UTF-16 BOM'] = () =>
  doc({
    annots: [
      link(
        `<< /S /URI /URI ${hex(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('javascript:alert(1)', 'utf16le').swap16()]))} >>`,
      ),
    ],
  });
CASES['a URI with a UTF-8 BOM'] = () =>
  doc({
    annots: [
      link(
        `<< /S /URI /URI ${hex(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('https://example.com/')]))} >>`,
      ),
    ],
  });
CASES['a URI with a NUL'] = () =>
  doc({ annots: [link(`<< /S /URI /URI ${hex(Buffer.from('https://exa\0mple.com/'))} >>`)] });
CASES['a URI with a byte past 0x7f'] = () =>
  doc({ annots: [link(`<< /S /URI /URI ${hex(Buffer.from([...Buffer.from('https://example.com/'), 0x85]))} >>`)] });
CASES['a URI " JAVASCRIPT:" in odd case after white space'] = () =>
  doc({ annots: [link('<< /S /URI /URI ( JAVASCRIPT:alert\\(1\\)) >>')] });
CASES['a file spec with a clean /UF and /F "evil.exe"'] = () =>
  doc({
    annots: [
      `<< /Type /Annot /Subtype /FileAttachment /Rect [0 0 9 9] /FS ${ef(`/UF ${hex(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('data.csv', 'utf16le').swap16()]))} /F (evil.exe)`)} >>`,
    ],
    extra: [csv],
  });
CASES['a file spec with /DOS "evil.exe"'] = () =>
  doc({ cat: `/Names << /EmbeddedFiles << /Names [(a) ${ef('/F (data.csv) /DOS (evil.exe)')}] >> >>`, extra: [csv] });

/** what an audit of the bytes finds (our registry), and pdf-lib's view of the actions */
async function residue(bytes) {
  const found = findActive(internal(await loadPdf(bytes), 't')).map((x) => x.what);
  const pl = await PDFDocument.load(bytes);
  for (const [, o] of pl.context.enumerateIndirectObjects()) {
    const d = o instanceof PDFDict ? o : o?.dict;
    if (!(d instanceof PDFDict)) continue;
    const s = d.get(PDFName.of('S'));
    if (s && ['/Launch', '/JavaScript', '/SubmitForm', '/ImportData', '/GoToR'].includes(s.toString()))
      found.push(`pdf-lib: ${s}`);
  }
  return found;
}

describe('the registry: save() drops every entry, saveIncremental refuses every entry', () => {
  for (const [name, make] of Object.entries(CASES)) {
    it(name, async () => {
      const bytes = make();
      const r = await (await loadPdf(bytes)).save();
      expect(await residue(r.bytes), JSON.stringify(r.stripped)).toEqual([]);
      if (PY)
        expect(qdf(r.bytes)).not.toMatch(
          /\/JavaScript|\/JS\b|\/Launch|\/XFA|\/RichMedia|\/AA\b|evil\.exe|javascript:|\/Screen|\/Movie|\/Sound|\/3D\b/i,
        );
      const d = await loadPdf(bytes);
      d.setInfo({ title: 'x' });
      await expect(d.saveIncremental()).rejects.toMatchObject({ code: 'E_ACTIVE' });
    });
  }
  it('/EF with different /F and /UF streams: one stream is kept (the checked one) under both keys', async () => {
    const b = doc({
      cat: `/Names << /EmbeddedFiles << /Names [(a) ${ef('/F (data.csv) /UF (data.csv)', '/UF 7 0 R')}] >> >>`,
      extra: [csv, ['<< /Type /EmbeddedFile /Subtype /text#2Fcsv >>', enc('OTHER')]],
    });
    const out = await loadPdf((await (await loadPdf(b)).save()).bytes);
    expect(out.attachments.map((a) => new TextDecoder().decode(a.bytes()))).toEqual(['OTHER']);
    const R = internal(out, 't').r.src.resolve;
    const nm = R(internal(out, 't').r.root.get('Names')),
      tree = R(nm.get('EmbeddedFiles')),
      spec = R(R(tree.get('Names'))[1]),
      e = R(spec.get('EF'));
    expect(e.get('F').n).toBe(e.get('UF').n);
    expect([...spec.keys()].sort()).toEqual(['EF', 'F', 'Type', 'UF']);
  });
  it('a URI is written as checkUrl normalised it, and that round-trips', async () => {
    const b = doc({ annots: [link('<< /S /URI /URI (https://example.com/a b?x=\\(1\\)) >>')] });
    const once = await (await loadPdf(b)).save();
    const u1 = (await loadPdf(once.bytes))
      .page(0)
      .annotations()
      .find((a) => a.uri).uri;
    expect(u1).toBe('https://example.com/a%20b?x=%281%29');
    const twice = await (await loadPdf(once.bytes)).save();
    expect(
      (await loadPdf(twice.bytes))
        .page(0)
        .annotations()
        .find((a) => a.uri).uri,
    ).toBe(u1);
  });
});

describe('the raw scan finds what a repairing viewer finds (fail closed)', () => {
  /** a clean file with raw text appended before the xref (unreferenced), or an object repeated earlier */
  const withRaw = (raw) => {
    const b = Buffer.from(doc());
    const s = b.toString('latin1'),
      x = s.lastIndexOf('\nxref') + 1;
    const add = enc(raw);
    const out = Buffer.concat([b.subarray(0, x), add, b.subarray(x)]);
    const t = out.toString('latin1');
    return enc(t.replace(/startxref\n\d+/, `startxref\n${x + add.length}`));
  };
  const cases = {
    '\\0 and \\f between the numbers': () => withRaw('9\x000\x0cobj << /S /JavaScript /JS (x) >> endobj\n'),
    'a comment between "obj" and the dictionary': () => withRaw('9 0 obj %note\n<< /JS (x) >> endobj\n'),
    'an earlier duplicate of an object with JavaScript': () => {
      const ins = '1 0 obj << /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (x) >> >> endobj\n';
      const shift = (o) => String(Number(o) + ins.length).padStart(10, '0');
      return enc(
        Buffer.from(doc())
          .toString('latin1')
          .replace('%\xe2\xe3\xcf\xd3\n', `%\xe2\xe3\xcf\xd3\n${ins}`)
          .replace(/(\d{10}) 00000 n/g, (m, o) => `${shift(o)} 00000 n`)
          .replace(/startxref\n(\d+)/, (m, o) => `startxref\n${Number(o) + ins.length}`),
      );
    },
    'an object stream nothing refers to, with JavaScript inside': () =>
      withRaw(
        '9 0 obj << /Type /ObjStm /N 1 /First 5 /Length 35 >>\nstream\n10 0 << /S /JavaScript /JS (x) >>\nendstream endobj\n',
      ),
  };
  for (const [name, make] of Object.entries(cases)) {
    it(name, async () => {
      const bytes = make();
      const d = await loadPdf(bytes);
      expect(d.pageCount).toBe(1);
      d.setInfo({ title: 'x' });
      await expect(d.saveIncremental()).rejects.toMatchObject({ code: 'E_ACTIVE' });
    });
  }
  it('clean files from our writer and pdf-lib update incrementally (no false alarm)', async () => {
    const s = await seeds();
    for (const b of [...s.ours.filter((_, i) => i !== 2), ...s.pdfLib]) {
      // not the encrypted one: no password given
      const d = await loadPdf(b);
      d.setInfo({ title: 'Updated' });
      const r = await d.saveIncremental();
      expect(r.activeContent).toEqual([]);
      expect((await loadPdf(r.bytes)).info.title).toBe('Updated');
    }
  });
});
