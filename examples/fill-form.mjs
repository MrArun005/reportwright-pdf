// Forms: create a fillable PDF, fill it after loading, and flatten it into a plain PDF.
//
//   node examples/fill-form.mjs [outDir]   writes form.pdf, filled.pdf, flattened.pdf
import fs from 'node:fs';
import path from 'node:path';
import { toBytes, loadPdf } from '../dist/index.js';

const dir = process.argv[2] ?? '.';
// 1. Create: every field gets its appearance streams, so every viewer shows the same thing.
const form = await toBytes(async (pdf) => {
  const font = pdf.standardFont('Helvetica');
  const page = pdf.addPage();
  page.text('Leave request', { x: 40, y: 40, font: pdf.standardFont('Helvetica-Bold'), size: 18 });
  const f = pdf.form;
  f.textField('name', { page, x: 40, y: 80, width: 240, height: 22, font, tooltip: 'Full name', required: true });
  f.comboBox('type', { page, x: 40, y: 115, width: 160, height: 22, font, options: ['Annual', 'Sick', 'Unpaid'], value: 'Annual', tooltip: 'Leave type' });
  f.checkbox('approved', { page, x: 40, y: 150, width: 14, height: 14, tooltip: 'Approved by manager' });
  page.text('Approved', { x: 60, y: 151, font, size: 11 });
  await page.end();
});
fs.writeFileSync(path.join(dir, 'form.pdf'), form);

// 2. Fill: values by full field name; the appearances are drawn again by the writer.
const doc = await loadPdf(form);
console.log('fields:', doc.fields.map((x) => `${x.name} (${x.type})`).join(', '));
doc.fill({ name: 'Aanya Sharma', type: 'Sick', approved: true });
fs.writeFileSync(path.join(dir, 'filled.pdf'), (await doc.save()).bytes);

// 3. Flatten: the fields become page content; no AcroForm is left.
const flat = (await loadPdf(form)).fill({ name: 'Aanya Sharma', type: 'Sick', approved: true }).flatten();
const flattened = (await flat.save()).bytes;
fs.writeFileSync(path.join(dir, 'flattened.pdf'), flattened);
console.log('flattened text:', (await loadPdf(flattened)).page(0).extractText().replace(/\s+/g, ' '));
