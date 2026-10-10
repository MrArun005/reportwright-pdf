// Helpers for the reader tests: raw PDFs written by hand (objects as text, a correct classic xref unless told not
// to), the hand-made decompression bomb, and the seed PDFs (ours, pdf-lib's, any in the repo, macOS's own when present).
import fs from 'node:fs';
import zlib from 'node:zlib';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { toBytes } from '../src/index.js';
import { INTER } from './tools.js';

export const enc = (s) => Buffer.from(s, 'latin1');
/**
 * A PDF of objects given as text (or [text, streamBytes]); object k+1 is objs[k]. trailer: extra trailer entries.
 * xref: false writes no table (startxref points nowhere), or a function (offsets) → the xref text.
 */
export function rawPdf(objs, { trailer = '', root = 1, xref, prefix = '' } = {}) {
  const parts = [enc(`%PDF-1.7\n%\xe2\xe3\xcf\xd3\n${prefix}`)];
  let pos = parts[0].length;
  const offs = [];
  objs.forEach((o, k) => {
    offs.push(pos);
    const [text, data] = Array.isArray(o) ? o : [o, null];
    const b = data
      ? Buffer.concat([enc(`${k + 1} 0 obj\n${text}\nstream\n`), Buffer.from(data), enc('\nendstream\nendobj\n')])
      : enc(`${k + 1} 0 obj\n${text}\nendobj\n`);
    parts.push(b);
    pos += b.length;
  });
  const x = pos;
  let t =
    typeof xref === 'function'
      ? xref(offs)
      : `xref\n0 ${objs.length + 1}\n0000000000 65535 f\r\n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n\r\n`).join('')}`;
  if (xref === false) t = '';
  parts.push(
    enc(
      `${t}trailer\n<< /Size ${objs.length + 1} /Root ${root} 0 R ${trailer} >>\nstartxref\n${xref === false ? 999999 : x}\n%%EOF\n`,
    ),
  );
  return new Uint8Array(Buffer.concat(parts));
}
/** catalog + pages + one page with this content stream (raw bytes, with this dictionary) */
export const onePage = (content, dict = '<< >>', extra = []) =>
  rawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    [dict.replace(/>>$/, `/Length ${content.length} >>`), content],
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...extra,
  ]);

/**
 * A Flate stream that inflates to `gb` GB, four Flate layers deep: the innermost is written by hand (a fixed-Huffman
 * block of "repeat the last byte 258 times" codes, 13 bits each), the outer three by zlib. Returns the bytes of the
 * outermost layer and the number of layers.
 */
export function flateBomb(gb = 10) {
  const bits = [];
  const put = (v, n) => {
    for (let i = 0; i < n; i++) bits.push((v >> i) & 1);
  };
  const code = (c, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((c >> i) & 1);
  }; // Huffman codes go MSB first
  put(0, 1);
  put(1, 2); // not final, fixed Huffman
  code(0b00110000, 8); // literal 0
  for (let k = 0; k < 24; k++) {
    code(0b11000101, 8);
    code(0, 5);
  } // length 258 (code 285), distance 1
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => {
    bytes[i >> 3] |= b << (i & 7);
  });
  const unit = bytes.subarray(2, 15); // bit 11 on is periodic: 8 units = 104 bits = 13 bytes
  if (!bytes.subarray(15, 28).every((x, i) => x === unit[i])) throw new Error('flateBomb: the period is wrong');
  const reps = Math.ceil((gb * 2 ** 30) / 258 / 8);
  const l2 = Buffer.alloc(2 + 2 + reps * 13);
  l2[0] = 0x78;
  l2[1] = 0x01;
  l2[2] = bytes[0];
  l2[3] = bytes[1];
  for (let i = 0; i < reps; i++) l2.set(unit, 4 + i * 13);
  let z = l2,
    layers = 1;
  while (z.length > 1024 && layers < 6) {
    z = zlib.deflateSync(z, { level: 9 });
    layers++;
  }
  return { data: new Uint8Array(z), layers };
}

/** the seed PDFs for the fuzz test and the round trips: ours (plain, forms, encrypted, tagged, PDF/A, attachments, layers), pdf-lib's, the repo's, macOS's */
export async function seeds() {
  const D = new Date('2026-01-01');
  const ours = [];
  ours.push(
    await toBytes(
      async (pdf) => {
        const f = pdf.standardFont('Helvetica');
        for (let i = 0; i < 3; i++) {
          const p = pdf.addPage({ width: 300, height: 300 });
          p.text(`Seed page ${i + 1}`, { x: 20, y: 20, font: f });
          p.rect(20, 60, 100, 40, { fill: '#c00' });
          if (i === 0) p.link(20, 60, 100, 40, { page: 3 });
        }
        pdf.outline({ title: 'Start', page: 1 });
      },
      { title: 'Plain', creationDate: D },
    ),
  );
  ours.push(
    await toBytes(
      async (pdf) => {
        const f = pdf.standardFont('Helvetica');
        const p = pdf.addPage({ width: 300, height: 300 });
        pdf.form.textField('name', { page: p, x: 20, y: 20, width: 150, height: 20, font: f, value: 'v' });
        pdf.form.checkbox('ok', { page: p, x: 20, y: 60, width: 12, height: 12, checked: true });
        pdf.form.comboBox('c', {
          page: p,
          x: 20,
          y: 90,
          width: 100,
          height: 20,
          font: f,
          options: ['a', 'b'],
          value: 'a',
        });
      },
      { title: 'Form', creationDate: D },
    ),
  );
  ours.push(
    await toBytes(
      async (pdf) => {
        const p = pdf.addPage({ width: 300, height: 300 });
        p.text('Encrypted', { x: 20, y: 20, font: pdf.standardFont('Helvetica') });
      },
      { encrypt: { userPassword: '', ownerPassword: 'o', algorithm: 'aes-128' }, creationDate: D },
    ),
  );
  ours.push(
    await toBytes(
      async (pdf) => {
        const f = await pdf.embedFont(INTER);
        const p = pdf.addPage({ width: 300, height: 300 });
        p.tag('H1', () => p.text('Tagged PDF/A', { x: 20, y: 20, font: f, size: 16 }));
        await pdf.attach(new TextEncoder().encode('a,b\n1,2\n'), {
          name: 'data.csv',
          mimeType: 'text/csv',
          relationship: 'Data',
        });
      },
      { title: 'A3', tagged: { lang: 'en' }, pdfa: { part: 3, conformance: 'a' }, creationDate: D },
    ),
  );
  ours.push(
    await toBytes(
      async (pdf) => {
        const l = pdf.layer('Notes');
        const p = pdf.addPage({ width: 300, height: 300 });
        p.layer(l, () => p.text('In a layer', { x: 20, y: 20, font: pdf.standardFont('Courier') }));
      },
      { title: 'Layers', compress: false, creationDate: D },
    ),
  );
  const pl = [];
  {
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.TimesRoman);
    for (let i = 0; i < 2; i++)
      d.addPage([300, 300]).drawText(`pdf-lib page ${i + 1}`, { x: 20, y: 250, font: f, size: 14 });
    const form = d.getForm();
    const tf = form.createTextField('who');
    tf.setText('x');
    tf.addToPage(d.getPage(0), { x: 20, y: 100, width: 120, height: 20 });
    pl.push(await d.save());
    pl.push(await d.save({ useObjectStreams: false }));
  }
  const found = [];
  for (const f of [
    '/System/Library/ProductDocuments/ProductGuides/ENERGY STAR.pdf',
    '/Library/Documentation/License.lpdf/Contents/Resources/English.lproj/License.pdf',
  ]) {
    try {
      const b = fs.readFileSync(f);
      if (b.length < 4 << 20) found.push(new Uint8Array(b));
    } catch {
      /* not on this machine */
    }
  }
  return { ours, pdfLib: pl, system: found, all: [...ours, ...pl, ...found] };
}

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
export const PY = process.env.PIKEPDF_PY;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-read-'));
let tn = 0;
/** qpdf (through pikepdf): the file as QDF text (every stream uncompressed), or null without PIKEPDF_PY */
export function qdf(bytes) {
  if (!PY) return null;
  const f = path.join(TMP, `q${++tn}.pdf`),
    o = `${f}.qdf`;
  fs.writeFileSync(f, bytes);
  execFileSync(
    PY,
    [
      '-I',
      '-c',
      'import sys,pikepdf\np=pikepdf.open(sys.argv[1])\np.save(sys.argv[2], qdf=True, object_stream_mode=pikepdf.ObjectStreamMode.disable, stream_decode_level=pikepdf.StreamDecodeLevel.generalized)',
      f,
      o,
    ],
    { stdio: 'pipe' },
  );
  return fs.readFileSync(o).toString('latin1');
}
/** qpdf --check (through pikepdf): its problems ([] when none), or null without PIKEPDF_PY */
export function qpdfCheck(bytes, password = '') {
  if (!PY) return null;
  const f = path.join(TMP, `c${++tn}.pdf`);
  fs.writeFileSync(f, bytes);
  const out = execFileSync(
    PY,
    [
      '-I',
      '-c',
      'import sys,pikepdf\np=pikepdf.open(sys.argv[1], password=sys.argv[2])\nfor x in p.check_pdf_syntax(): print(x)\nfor o in p.objects:\n  if isinstance(o, pikepdf.Stream): o.read_bytes()\nprint("OK")',
      f,
      password,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return out
    .trim()
    .split('\n')
    .filter((l) => l !== 'OK');
}
