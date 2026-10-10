// A rich document for the group G standards tests: text, a table, a list, headings, an image, links, a note, form
// fields, layers and attachments, each as the PDF/A level allows.
import fs from 'node:fs';
import path from 'node:path';
import { INTER, ROOT } from './tools.js';
import { png } from './image-fixtures.js';

export const DATE = new Date('2026-01-01');
export const RGB = png({ w: 16, h: 16, type: 2, depth: 8, px: (x, y) => [x * 16, y * 16, 128] });
export const RGBA = png({ w: 16, h: 16, type: 6, depth: 8, px: (x, y) => [x * 16, 64, y * 16, 40 + x * 8] });
export const CSV = new TextEncoder().encode('item,qty\npen,2\n');
/** a Factur-X EN 16931 invoice (passes the Factur-X XSD) */
export const EN16931 = fs.readFileSync(path.join(ROOT, 'tests/fixtures/facturx/en16931.xml'));

/** @param {any} pdf @param {{ part: 1 | 2 | 3 }} o */
export async function rich(pdf, { part }) {
  const f = await pdf.embedFont(INTER);
  const img = await pdf.embedImage(RGB);
  const imgA = part > 1 ? await pdf.embedImage(RGBA) : null;
  const notes = part > 1 ? pdf.layer('Notes') : null;
  const draft = part > 1 ? pdf.layer('Draft marks', { visible: false, locked: true }) : null;
  const p = pdf.addPage({ bleedBox: [10, 10, 575.28, 821.89], trimBox: [20, 20, 555.28, 801.89], cropBox: [0, 0, 595.28, 841.89] });
  const T = (type, fn, o) => p.tag(type, fn, o);
  const t = (s, x, y, o = {}) => p.text(s, { x, y, font: f, size: 11, ...o });
  p.artifact({ type: 'Pagination', subtype: 'Header' }, () => t('Invoice 2026-001 — header', 40, 24, { size: 8, color: 0.4 }));
  T('H1', () => t('Invoice 2026-001', 40, 50, { size: 20 }));
  T('P', () => {
    t('Ünïcødé text and a link to ', 40, 90);
    T('Link', () => { t('example.com', 210, 90, { color: '#0645ad' }); p.link(210, 90, 80, 14, { url: 'https://example.com' }, { alt: 'example.com' }); });
  });
  T('Table', () => {
    T('TR', () => ['Item', 'Qty'].forEach((h, i) => T('TH', () => t(h, 40 + i * 120, 130), { scope: 'Column', id: `col${i}` })));
    for (const [r, row] of [['Pen', '2'], ['Ink', '5']].entries()) T('TR', () => row.forEach((v, i) => T('TD', () => t(v, 40 + i * 120, 150 + r * 18), { headers: [`col${i}`] })));
  });
  T('L', () => ['First', 'Second'].forEach((s, i) => T('LI', () => { T('Lbl', () => t(`${i + 1}.`, 40, 210 + i * 18)); T('LBody', () => t(s, 60, 210 + i * 18)); })), { listNumbering: 'Decimal' });
  T('H2', () => t('Notes', 40, 260, { size: 14 }));
  T('P', () => { t('Checked by the ', 40, 285); T('Span', () => t('QA', 135, 285), { expansion: 'quality assurance' }); t(' team.', 155, 285); }, { lang: 'en-GB' });
  p.image(img, { x: 40, y: 310, width: 48, alt: 'A colour ramp' });
  if (imgA) p.image(imgA, { x: 100, y: 310, width: 48, alt: 'A translucent ramp' });
  if (notes) p.layer(notes, () => T('P', () => t('This line is in the Notes layer.', 40, 380)));
  if (draft) p.layer(draft, () => p.rect(300, 380, 100, 20, { fill: '#c00000' }));
  if (part > 1) p.fill(p.path().rect(420, 380, 100, 20), { fill: '#2050a0', opacity: 0.5 });
  p.note(500, 50, { contents: 'A reviewer note' });
  pdf.form.textField('name', { page: p, x: 40, y: 420, width: 200, height: 22, font: f, value: 'Ada Lovelace', tooltip: 'Full name' });
  pdf.form.checkbox('paid', { page: p, x: 260, y: 424, width: 14, height: 14, checked: true, tooltip: 'Paid' });
  if (part === 3) await pdf.attach(CSV, { name: 'lines.csv', mimeType: 'text/csv', relationship: 'Data', description: 'The invoice lines' });
  pdf.outline({ title: 'Invoice', page: 1 });
}
