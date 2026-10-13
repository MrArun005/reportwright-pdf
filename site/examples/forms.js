// Forms: create a fillable PDF, fill it after loading, and flatten it into plain page content.
import { toBytes, loadPdf } from '@reportwright/pdf';

const form = await toBytes(async (pdf) => {
  const font = pdf.standardFont('Helvetica'), page = pdf.addPage();
  page.text('Leave request', { x: 40, y: 40, font: pdf.standardFont('Helvetica-Bold'), size: 18 });
  pdf.form.textField('name', { page, x: 40, y: 80, width: 240, height: 22, font, tooltip: 'Full name', required: true });
  pdf.form.comboBox('type', { page, x: 40, y: 115, width: 160, height: 22, font, options: ['Annual', 'Sick', 'Unpaid'], value: 'Annual', tooltip: 'Leave type' });
  pdf.form.checkbox('approved', { page, x: 40, y: 150, width: 14, height: 14, tooltip: 'Approved by manager' });
  page.text('Approved', { x: 60, y: 151, font, size: 11 });
  await page.end();
});
show(form, 'form.pdf');

const doc = await loadPdf(form);
log('fields:', doc.fields.map((f) => f.name + ' (' + f.type + ')').join(', '));
doc.fill({ name: 'Aanya Sharma', type: 'Sick', approved: true });          // appearances redrawn
show((await doc.save()).bytes, 'filled.pdf');

const flat = (await loadPdf(form)).fill({ name: 'Aanya Sharma', type: 'Sick', approved: true }).flatten();
const flattened = (await flat.save()).bytes;                               // no AcroForm left
log('flattened text:', (await loadPdf(flattened)).page(0).extractText().replace(/\s+/g, ' '));
show(flattened, 'flattened.pdf');
