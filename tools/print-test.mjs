// A print test sheet for @reportwright/pdf: an A4 page and a US Letter page, each with CMYK and RGB colour bars, a
// 10-step grey ramp, a spot colour, 0.25 / 0.5 / 1 pt hairlines, 4–12 pt text in a standard and an embedded font,
// registration targets, crop and bleed marks around a TrimBox and BleedBox, an image, a gradient, a transparency
// sample and a 100 mm scale bar; then a page that says what to check (test-pack/PRINT-CHECKLIST.md has the detail).
// Public API only. Writes <outDir>/print-test.pdf and a manifest.json that tools/cross-render.mjs reads.
//
//   node packages/pdf/tools/print-test.mjs [outDir]      (PRINT_DRY=1: build in memory, write nothing)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPdf, cmyk } from '../src/index.js';
import { png } from '../../../tests/pdf/image-fixtures.js';

const ROOT = path.join(import.meta.dirname, '../../..');
const OUT = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'rw-print-test'));
const DRY = !!process.env.PRINT_DRY;
if (!DRY) fs.mkdirSync(OUT, { recursive: true });
const MM = 72 / 25.4;
const SLUG = 36;          // paper margin outside the trim, where the marks go (12.7 mm)
const BLEED = 3 * MM;     // 3 mm bleed

const pdf = createPdf(DRY ? { write() {} } : fs.createWriteStream(path.join(OUT, 'print-test.pdf')), { title: 'Print test sheet', author: '@reportwright/pdf', creationDate: new Date('2026-03-01T10:00:00Z') });
const inter = await pdf.embedFont(fs.readFileSync(path.join(ROOT, 'public/fonts/Inter-Regular.ttf')));
const helv = pdf.standardFont('Helvetica'), helvB = pdf.standardFont('Helvetica-Bold'), times = pdf.standardFont('Times-Roman');
const spot = pdf.spotColor('PANTONE 185 C', cmyk(0, 0.91, 0.76, 0));
const photo = await pdf.embedImage(png({ w: 64, h: 64, type: 2, depth: 8, px: (x, y) => [x * 4, y * 4, 255 - ((x + y) * 2)] }));
const REG = cmyk(1, 1, 1, 1); // registration colour: all four inks

/** one test page; the paper is the MediaBox, the trim is inset by SLUG */
function sheet(W, H, name) {
  const T = [SLUG, SLUG, W - 2 * SLUG, H - 2 * SLUG];
  const B = [SLUG - BLEED, SLUG - BLEED, T[2] + 2 * BLEED, T[3] + 2 * BLEED];
  const p = pdf.addPage({ width: W, height: H, trimBox: T, bleedBox: B, cropBox: [0, 0, W, H] });
  const x0 = T[0], y0 = T[1], x1 = T[0] + T[2], y1 = T[1] + T[3];
  // the bleed: a pale band from the bleed edge to the trim, so a trimmed sheet shows no white edge
  p.rect(B[0], B[1], B[2], B[3], { fill: cmyk(0.1, 0, 0, 0) });
  p.rect(x0 + 6, y0 + 6, T[2] - 12, T[3] - 12, { fill: 1 });
  // crop marks at the trim corners and bleed marks at the bleed corners, in the slug, in registration colour
  for (const [cx, cy, sx, sy] of [[x0, y0, -1, -1], [x1, y0, 1, -1], [x0, y1, -1, 1], [x1, y1, 1, 1]]) {
    p.line(cx + sx * (BLEED + 2), cy, cx + sx * (SLUG - 4), cy, { color: REG, width: 0.25 });
    p.line(cx, cy + sy * (BLEED + 2), cx, cy + sy * (SLUG - 4), { color: REG, width: 0.25 });
    const bx = cx + sx * BLEED, by = cy + sy * BLEED;
    p.line(bx, by + sy * 4, bx, by + sy * 14, { color: REG, width: 0.25, dash: [2, 1] });
    p.line(bx + sx * 4, by, bx + sx * 14, by, { color: REG, width: 0.25, dash: [2, 1] });
  }
  // registration targets centred in the slug on each side
  for (const [cx, cy] of [[W / 2, SLUG / 2], [W / 2, H - SLUG / 2], [SLUG / 2, H / 2], [W - SLUG / 2, H / 2]]) {
    p.stroke(p.path().arc(cx, cy, 6, 0, 2 * Math.PI), { stroke: REG, width: 0.3 });
    p.stroke(p.path().arc(cx, cy, 3, 0, 2 * Math.PI), { stroke: REG, width: 0.3 });
    p.line(cx - 9, cy, cx + 9, cy, { color: REG, width: 0.3 });
    p.line(cx, cy - 9, cx, cy + 9, { color: REG, width: 0.3 });
  }
  p.text(`${name} — ${W.toFixed(2)} × ${H.toFixed(2)} pt — @reportwright/pdf print test`, { x: SLUG + 30, y: 8, font: helv, size: 6 });

  const L = x0 + 20, top = y0 + 20;
  p.text(`Print test: ${name}`, { x: L, y: top, font: helvB, size: 16 });
  p.text('Print at Actual size / 100% (not Fit, not Shrink). See the last page and PRINT-CHECKLIST.md.', { x: L, y: top + 22, font: helv, size: 9 });
  let y = top + 48;
  // colour bars
  const bar = (label, fills) => {
    p.text(label, { x: L, y, font: helv, size: 8 });
    fills.forEach(([f, t], i) => { p.rect(L + 70 + i * 52, y - 2, 48, 24, { fill: f }); p.text(t, { x: L + 70 + i * 52, y: y + 24, font: helv, size: 5 }); });
    y += 40;
  };
  bar('CMYK solids', [[cmyk(1, 0, 0, 0), 'C 100'], [cmyk(0, 1, 0, 0), 'M 100'], [cmyk(0, 0, 1, 0), 'Y 100'], [cmyk(0, 0, 0, 1), 'K 100'], [cmyk(1, 1, 0, 0), 'C+M'], [cmyk(0, 1, 1, 0), 'M+Y'], [cmyk(1, 0, 1, 0), 'C+Y'], [cmyk(0.6, 0.4, 0.4, 1), 'rich K']]);
  bar('CMYK 50%', [[cmyk(0.5, 0, 0, 0), 'C 50'], [cmyk(0, 0.5, 0, 0), 'M 50'], [cmyk(0, 0, 0.5, 0), 'Y 50'], [cmyk(0, 0, 0, 0.5), 'K 50'], [cmyk(0.25, 0, 0, 0), 'C 25'], [cmyk(0, 0.25, 0, 0), 'M 25'], [cmyk(0, 0, 0.25, 0), 'Y 25'], [cmyk(0, 0, 0, 0.25), 'K 25']]);
  bar('RGB', [['#ff0000', 'R'], ['#00ff00', 'G'], ['#0000ff', 'B'], ['#00ffff', 'C'], ['#ff00ff', 'M'], ['#ffff00', 'Y'], ['#000000', 'black'], ['#808080', '50% grey']]);
  // grey ramp: 10 steps, 0% to 100% K and DeviceGray
  p.text('Grey ramp', { x: L, y, font: helv, size: 8 });
  for (let i = 0; i < 10; i++) {
    p.rect(L + 70 + i * 41.6, y - 2, 41.6, 14, { fill: cmyk(0, 0, 0, i / 9) });
    p.rect(L + 70 + i * 41.6, y + 12, 41.6, 14, { fill: 1 - i / 9 });
    p.text(`${Math.round((100 * i) / 9)}%`, { x: L + 72 + i * 41.6, y: y + 28, font: helv, size: 5 });
  }
  p.text('K', { x: L + 58, y: y, font: helv, size: 6 }); p.text('Gray', { x: L + 52, y: y + 14, font: helv, size: 6 });
  y += 46;
  // spot colour
  p.text('Spot', { x: L, y, font: helv, size: 8 });
  [1, 0.75, 0.5, 0.25].forEach((t, i) => { p.rect(L + 70 + i * 52, y - 2, 48, 24, { fill: spot.tint(t) }); p.text(`${t * 100}%`, { x: L + 70 + i * 52, y: y + 24, font: helv, size: 5 }); });
  p.text('PANTONE 185 C (Separation, CMYK alternate)', { x: L + 290, y: y + 6, font: helv, size: 7 });
  y += 42;
  // hairlines
  p.text('Lines', { x: L, y, font: helv, size: 8 });
  [0.25, 0.5, 1].forEach((w, i) => {
    p.line(L + 70, y + i * 10, L + 300, y + i * 10, { color: 0, width: w });
    p.line(L + 320 + i * 20, y - 2, L + 320 + i * 20, y + 22, { color: 0, width: w });
    p.text(`${w} pt`, { x: L + 390, y: y - 3 + i * 10, font: helv, size: 6 });
  });
  y += 36;
  // small text, standard and embedded
  p.text('Text', { x: L, y, font: helv, size: 8 });
  for (const [k, sz] of [4, 5, 6, 7, 8, 9, 10, 12].entries()) {
    p.text(`${sz} pt Helvetica Hamburgefonstiv 0123`, { x: L + 70, y: y + k * 13, font: helv, size: sz });
    p.text(`${sz} pt Inter Hamburgefonstiv 0123`, { x: L + 270, y: y + k * 13, font: inter, size: sz });
  }
  y += 8 * 13 + 4;
  p.text('Times 8 pt: The quick brown fox jumps over the lazy dog.', { x: L + 70, y, font: times, size: 8 });
  y += 20;
  // image, gradient, transparency
  p.text('Image', { x: L, y, font: helv, size: 8 });
  p.image(photo, { x: L + 70, y: y - 2, width: 80, height: 80 });
  p.fill(p.path().rect(L + 170, y - 2, 140, 80), { fill: p.linearGradient(L + 170, 0, L + 310, 0, [[0, cmyk(1, 0, 0, 0)], [1, cmyk(0, 0, 0, 0)]]) });
  p.text('CMYK gradient', { x: L + 170, y: y + 80, font: helv, size: 5 });
  p.rect(L + 330, y - 2, 60, 60, { fill: cmyk(0, 0, 1, 0) });
  p.fill(p.path().arc(L + 390, y + 40, 32, 0, 2 * Math.PI), { fill: cmyk(1, 0, 0, 0), opacity: 0.5 });
  p.fill(p.path().arc(L + 360, y + 60, 24, 0, 2 * Math.PI), { fill: cmyk(0, 1, 0, 0), blendMode: 'Multiply' });
  p.text('50% opacity, Multiply', { x: L + 330, y: y + 86, font: helv, size: 5 });
  y += 100;
  // 100 mm scale bar
  p.text('Scale', { x: L, y, font: helv, size: 8 });
  p.line(L + 70, y + 6, L + 70 + 100 * MM, y + 6, { color: 0, width: 0.5 });
  for (let i = 0; i <= 10; i++) p.line(L + 70 + i * 10 * MM, y + (i % 5 ? 2 : 0), L + 70 + i * 10 * MM, y + 6, { color: 0, width: 0.5 });
  p.text('100 mm at actual size (ticks every 10 mm)', { x: L + 70, y: y + 10, font: helv, size: 6 });
  return p;
}

sheet(595.28, 841.89, 'A4');
sheet(612, 792, 'US Letter');

const c = pdf.addPage({ width: 595.28, height: 841.89 });
c.text('What to check', { x: 50, y: 50, font: helvB, size: 20 });
const checks = [
  'Printer settings: Actual size / 100% (not Fit or Shrink), the paper of each page (A4 then Letter), colour on.',
  'Scale: the 100 mm bar measures 100 mm (±1 mm). Crop marks sit 12.7 mm (0.5 in) in from the paper edges.',
  'Edges: the paper may clip the outer marks on printers with a wide margin; the trim area must not be clipped.',
  'CMYK and RGB bars: every patch prints as a distinct, flat colour; no banding, no missing patch.',
  'Grey ramp: 10 distinguishable steps in both rows; 0% is paper white, 100% solid black; no colour cast.',
  'Spot: PANTONE 185 C prints as a red (its CMYK alternate) and its tints get lighter in order.',
  'Lines: 0.25, 0.5 and 1 pt lines are all visible, unbroken, thinnest to thickest.',
  'Text: 6 pt and up is readable in both fonts; 4–5 pt shows as clean (if tiny) letters, not blobs.',
  'Image: smooth gradient square, no blockiness, no white box around it.',
  'Gradient: smooth cyan to white, no visible steps.',
  'Transparency: the cyan disc shows the yellow square through it (green overlap); the magenta disc multiplies.',
  'Registration targets: the four inks line up (no coloured fringes) on a colour printer.',
];
c.textBox(checks.map((s, i) => `${i + 1}. ${s}`).join('\n'), { x: 50, y: 90, width: 495, font: helv, size: 11, lineHeight: 17 });
c.text('Write the printer model, driver and settings on this page, and keep the printout with the checklist.', { x: 50, y: 700, font: helv, size: 10 });

const r = await pdf.end();
console.log(`print-test.pdf: ${r.pages} pages, ${r.bytes} bytes${r.warnings.length ? `, warnings: ${r.warnings.join(' | ')}` : ''}${DRY ? ' (dry run, not written)' : ''}`);
if (!DRY) fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify([{ name: 'print-test', file: 'print-test.pdf', group: 'print', feature: 'print test sheet: A4 + Letter + checklist page', pages: r.pages, text: ['Print test: A4', 'Print test: US Letter', 'What to check', '6 pt Inter Hamburgefonstiv 0123'] }], null, 2));
