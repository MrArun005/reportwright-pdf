// Benchmark: @reportwright/pdf (dist) against pdf-lib and PDFKit when they are in node_modules (nothing is installed).
// Cases: a 1-page invoice, a 1,000-page text document and a 50-page document of wrapped, justified paragraphs (standard
// fonts only; pdf-lib has no justified wrap, so its run wraps with widthOfTextAtSize and sets Tw around each line), and 1,000 vector shapes on one page
// (circles filled and stroked, rounded rectangles, curved SVG paths), a page of 20 photos (the same 800 × 600 JPEG)
// and 100 different 32 × 32 PNG icons with alpha (both made with sharp when it is in node_modules), and navigation: 500 link
// annotations (20 pages × 25, each to another page) + 200 outline entries in two levels (pdf-lib has no link or outline API:
// its run builds the same annotation and outline dictionaries with its low-level context, written as plainly as we could). Measures output size, warm time (median of
// a 200-field form, filled (4 pages × 40 text fields, 5 check boxes and 5 combo boxes, Helvetica 10; pdf-lib through its form API,
// whose save() makes the appearance streams as ours does). Measures output size, warm time (median of
// 10 runs in one process, after a warm-up) and cold time (median of 10 new `node` processes: start, import, build, write).
//   node packages/pdf/bench/compare.mjs            (build dist first: node packages/pdf/build.mjs)
//   CASES=photos-20,icons-100 node packages/pdf/bench/compare.mjs   (a subset)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../../../package.json'));
const has = (m) => { try { require.resolve(m); return true; } catch { return false; } };

const ROWS = Array.from({ length: 20 }, (_, i) => [`Item ${i + 1} — consulting services`, String(1 + (i % 5)), (120 + i * 7.5).toFixed(2)]);
/** shape i of the vector case: kind (0 circle, 1 rounded rect, 2 SVG curve), x, y (top-left space), colour 0–1 */
const SHAPE = (i) => [i % 3, 20 + (i % 25) * 22, 20 + Math.floor(i / 25) * 20, (i % 7) / 7];
const CURVE = (x, y) => `M${x} ${y + 8} C${x + 5} ${y - 4} ${x + 10} ${y + 16} ${x + 16} ${y + 4} Q${x + 18} ${y + 14} ${x + 8} ${y + 14} Z`;
/** the image fixtures, made once by the parent process and read by every child (BENCH_FIXTURES: their folder) */
async function fixtures() {
  if (!process.env.BENCH_FIXTURES) {
    if (!has('sharp')) return null;
    const sharp = require('sharp'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-bench-'));
    const W = 800, H = 600, photo = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { // a smooth scene with some texture, like a photo
      const i = (y * W + x) * 3, n = (Math.sin(x * 0.3) * Math.cos(y * 0.21) + Math.sin((x + y) * 0.05)) * 20;
      photo[i] = 120 + 100 * Math.sin(x / 130) + n; photo[i + 1] = 110 + 80 * Math.cos(y / 90) + n; photo[i + 2] = 140 + 60 * Math.sin((x - y) / 200) - n;
    }
    fs.writeFileSync(path.join(dir, 'photo.jpg'), await sharp(photo, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 85 }).toBuffer());
    for (let k = 0; k < 100; k++) { // a disc with a soft edge, in a different colour each
      const px = Buffer.alloc(32 * 32 * 4);
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
        const i = (y * 32 + x) * 4, d = Math.hypot(x - 15.5, y - 15.5);
        px[i] = (k * 37) & 255; px[i + 1] = (k * 91) & 255; px[i + 2] = 255 - ((k * 53) & 255); px[i + 3] = Math.max(0, Math.min(255, (14 - d) * 128));
      }
      fs.writeFileSync(path.join(dir, `icon${k}.png`), await sharp(px, { raw: { width: 32, height: 32, channels: 4 } }).png().toBuffer());
    }
    process.env.BENCH_FIXTURES = dir;
  }
  const dir = process.env.BENCH_FIXTURES;
  return { photo: fs.readFileSync(path.join(dir, 'photo.jpg')), icons: Array.from({ length: 100 }, (_, k) => fs.readFileSync(path.join(dir, `icon${k}.png`))) };
}
const FIX = await fixtures();
const WORDS = 'the quick brown fox jumps over a lazy dog while five boxing wizards jump quickly and vexing daft zebras pack my box with liquor jugs'.split(' ');
/** paragraph k of page p of the wrapped case: about 70 words, deterministic */
const PARA = (p, k) => Array.from({ length: 60 + ((p * 7 + k * 3) % 20) }, (_, i) => WORDS[(p * 31 + k * 17 + i * 7) % WORDS.length]).join(' ');
/** the wrapped case's greedy lines for pdf-lib (which has no justified wrap): widthOfTextAtSize of each word and space */
function wrapFor(font, text, size, width) {
  const lines = [], sp = font.widthOfTextAtSize(' ', size);
  let line = [], w = 0;
  for (const word of text.split(' ')) {
    const ww = font.widthOfTextAtSize(word, size);
    if (line.length && w + sp + ww > width) { lines.push([line.join(' '), w, line.length - 1]); line = []; w = 0; }
    w += (line.length ? sp : 0) + ww; line.push(word);
  }
  lines.push([line.join(' '), w, 0]);
  return lines;
}
/** the navigation case: link k of page i (to another page, at a y) and outline entry j (10 a page, every 5th a parent) */
const NAV_LINK = (i, k) => ({ page: ((i + k + 1) % 20) + 1, top: 40 + (k % 10) * 60 });
const NAV_ENTRY = (j) => ({ title: `Section ${Math.floor(j / 5) + 1}${j % 5 ? `.${j % 5}` : ''}`, page: Math.floor(j / 10) + 1, level: j % 5 ? 1 : 0 });
/** the form case: field k of page i (4 pages × 50): 40 text fields, 5 check boxes, 5 combo boxes, all filled */
const FORM_FIELD = (i, k) => ({ name: `p${i}f${k}`, kind: k < 40 ? 'text' : k < 45 ? 'check' : 'combo', x: 50 + (k % 2) * 250, y: 40 + Math.floor(k / 2) * 30, value: `Value ${i}-${k}` });
const FORM_OPTIONS = ['Alpha', 'Bravo', 'Charlie', 'Delta'];
const LINE = (p, r) => `Page ${p}, line ${r}: the quick brown fox jumps over the lazy dog ${p * 50 + r}`;

/** each library: (kase) => Promise<Uint8Array> */
const LIBS = {
  async reportwright(kase) {
    const { toBytes } = await import(pathToFileURL(path.join(here, '../dist/index.js')).href);
    return toBytes(async (pdf) => {
      if (kase === 'photos-20') {
        const p = pdf.addPage(), img = await pdf.embedImage(FIX.photo);
        for (let i = 0; i < 20; i++) p.image(img, { x: 30 + (i % 4) * 135, y: 30 + Math.floor(i / 4) * 160, width: 128, height: 96 });
        return;
      }
      if (kase === 'icons-100') {
        const p = pdf.addPage();
        for (let i = 0; i < 100; i++) p.image(await pdf.embedImage(FIX.icons[i]), { x: 30 + (i % 10) * 50, y: 30 + Math.floor(i / 10) * 50, width: 32, height: 32 });
        return;
      }
      if (kase === 'nav-500') {
        const reg = pdf.standardFont('Helvetica');
        for (let i = 0; i < 20; i++) {
          const p = pdf.addPage();
          for (let k = 0; k < 25; k++) { p.text(`Go to page ${((i + k) % 20) + 1}`, { x: 50, y: 40 + k * 30, font: reg, size: 10 }); p.link(50, 40 + k * 30, 120, 14, NAV_LINK(i, k)); }
          await p.end();
        }
        pdf.outline(Array.from({ length: 200 }, (_, j) => NAV_ENTRY(j)));
        return;
      }
      if (kase === 'form-200') {
        const reg = pdf.standardFont('Helvetica');
        for (let i = 0; i < 4; i++) {
          const p = pdf.addPage();
          for (let k = 0; k < 50; k++) {
            const f = FORM_FIELD(i, k), box = { page: p, x: f.x, y: f.y, width: f.kind === 'check' ? 14 : 200, height: f.kind === 'check' ? 14 : 20 };
            if (f.kind === 'text') pdf.form.textField(f.name, { ...box, font: reg, size: 10, value: f.value });
            else if (f.kind === 'check') pdf.form.checkbox(f.name, { ...box, checked: k % 2 === 0 });
            else pdf.form.comboBox(f.name, { ...box, font: reg, size: 10, options: FORM_OPTIONS, value: FORM_OPTIONS[k % 4] });
          }
          await p.end();
        }
        return;
      }
      if (kase === 'shapes-1000') {
        const p = pdf.addPage();
        for (let i = 0; i < 1000; i++) {
          const [k, x, y, c] = SHAPE(i);
          if (k === 0) p.fillAndStroke(p.path().arc(x + 8, y + 8, 8, 0, 2 * Math.PI), { fill: [c, 0.4, 1 - c], stroke: 0, width: 0.5 });
          else if (k === 1) p.fill(p.path().roundedRect(x, y, 18, 14, 3), { fill: [1 - c, c, 0.5] });
          else p.svgPath(CURVE(x, y), { fill: [0.2, c, 0.8] });
        }
        return;
      }
      const reg = pdf.standardFont(kase === 'invoice' ? 'Helvetica' : 'Times-Roman');
      if (kase === 'wrapped-50') {
        for (let i = 1; i <= 50; i++) {
          const p = pdf.addPage();
          let y = 50;
          for (let k = 0; k < 6; k++) y += p.textBox(PARA(i, k), { x: 50, y, width: 495, font: reg, size: 10, lineHeight: 13, align: 'justify' }).height + 10;
          await p.end();
        }
        return;
      }
      if (kase === 'invoice') {
        const bold = pdf.standardFont('Helvetica-Bold');
        const p = pdf.addPage();
        p.text('INVOICE #2026-0042', { x: 50, y: 50, font: bold, size: 20 });
        p.text('Acme Ltd · 1 Main Street · Springfield', { x: 50, y: 80, font: reg, size: 10, color: 0.4 });
        p.rect(50, 110, 495, 20, { fill: '#1f4e79' });
        ['Description', 'Qty', 'Amount'].forEach((h, i) => p.text(h, { x: 55 + [0, 330, 420][i], y: 114, font: bold, size: 10, color: '#ffffff' }));
        ROWS.forEach((r, k) => { r.forEach((v, i) => p.text(v, { x: 55 + [0, 330, 420][i], y: 136 + k * 18, font: reg, size: 10 })); p.line(50, 151 + k * 18, 545, 151 + k * 18, { color: 0.85, width: 0.5 }); });
        p.text('Total 3,825.00', { x: 420, y: 136 + 20 * 18 + 10, font: bold, size: 12 });
        await p.end();
      } else {
        for (let i = 1; i <= 1000; i++) { const p = pdf.addPage(); for (let r = 0; r < 50; r++) p.text(LINE(i, r), { x: 50, y: 40 + r * 15, font: reg, size: 10 }); await p.end(); }
      }
    }, { title: 'Bench', creationDate: new Date(0) });
  },
  async 'pdf-lib'(kase) {
    const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
    const doc = await PDFDocument.create();
    doc.setTitle('Bench');
    if (kase === 'photos-20') {
      const p = doc.addPage([595.28, 841.89]), img = await doc.embedJpg(FIX.photo);
      for (let i = 0; i < 20; i++) p.drawImage(img, { x: 30 + (i % 4) * 135, y: 841.89 - 30 - Math.floor(i / 4) * 160 - 96, width: 128, height: 96 });
      return doc.save();
    }
    if (kase === 'icons-100') {
      const p = doc.addPage([595.28, 841.89]);
      for (let i = 0; i < 100; i++) p.drawImage(await doc.embedPng(FIX.icons[i]), { x: 30 + (i % 10) * 50, y: 841.89 - 30 - Math.floor(i / 10) * 50 - 32, width: 32, height: 32 });
      return doc.save();
    }
    if (kase === 'nav-500') { // no link/outline API: the same dictionaries through pdf-lib's context
      const { PDFName, PDFString, PDFNumber, PDFNull } = require('pdf-lib');
      const reg = await doc.embedFont(StandardFonts.Helvetica), H = 841.89, ctx = doc.context;
      const pages = Array.from({ length: 20 }, () => doc.addPage([595.28, H]));
      pages.forEach((p, i) => {
        const refs = [];
        for (let k = 0; k < 25; k++) {
          const { page: to, top } = NAV_LINK(i, k), y = 40 + k * 30;
          p.drawText(`Go to page ${to}`, { x: 50, y: H - y - 7.18, font: reg, size: 10 });
          refs.push(ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', F: 4, Rect: [50, H - y - 14, 170, H - y], Border: [0, 0, 0], Dest: [pages[to - 1].ref, 'XYZ', PDFNull, H - top, PDFNull] })));
        }
        p.node.set(PDFName.of('Annots'), ctx.obj(refs));
      });
      const root = ctx.nextRef(), items = Array.from({ length: 200 }, (_, j) => ({ e: NAV_ENTRY(j), ref: ctx.nextRef(), kids: [] }));
      const top = [];
      for (const it of items) (it.e.level ? top[top.length - 1].kids : top).push(it);
      const link = (list, parent) => list.forEach((it, i) => {
        const d = ctx.obj({ Title: PDFString.of(it.e.title), Parent: parent, Dest: [pages[it.e.page - 1].ref, 'Fit'] });
        if (i) d.set(PDFName.of('Prev'), list[i - 1].ref);
        if (i < list.length - 1) d.set(PDFName.of('Next'), list[i + 1].ref);
        if (it.kids.length) { d.set(PDFName.of('First'), it.kids[0].ref); d.set(PDFName.of('Last'), it.kids[it.kids.length - 1].ref); d.set(PDFName.of('Count'), PDFNumber.of(it.kids.length)); link(it.kids, it.ref); }
        ctx.assign(it.ref, d);
      });
      link(top, root);
      ctx.assign(root, ctx.obj({ Type: 'Outlines', First: top[0].ref, Last: top[top.length - 1].ref, Count: PDFNumber.of(200) }));
      doc.catalog.set(PDFName.of('Outlines'), root);
      return doc.save();
    }
    if (kase === 'form-200') { // its form API: fields with widgets, appearances made by save() (Helvetica, size 10)
      const reg = await doc.embedFont(StandardFonts.Helvetica), form = doc.getForm(), H = 841.89;
      for (let i = 0; i < 4; i++) {
        const p = doc.addPage([595.28, H]);
        for (let k = 0; k < 50; k++) {
          const f = FORM_FIELD(i, k), w = f.kind === 'check' ? 14 : 200, h = f.kind === 'check' ? 14 : 20, box = { x: f.x, y: H - f.y - h, width: w, height: h, font: reg, borderWidth: 1, borderColor: rgb(0, 0, 0) };
          if (f.kind === 'text') { const t = form.createTextField(f.name); t.setText(f.value); t.addToPage(p, box); t.setFontSize(10); }
          else if (f.kind === 'check') { const c = form.createCheckBox(f.name); c.addToPage(p, box); if (k % 2 === 0) c.check(); }
          else { const d = form.createDropdown(f.name); d.addOptions(FORM_OPTIONS); d.select(FORM_OPTIONS[k % 4]); d.addToPage(p, box); d.setFontSize(10); }
        }
      }
      return doc.save();
    }
    if (kase === 'shapes-1000') {
      const p = doc.addPage([595.28, 841.89]), H = 841.89;
      for (let i = 0; i < 1000; i++) {
        const [k, x, y, c] = SHAPE(i);
        if (k === 0) p.drawCircle({ x: x + 8, y: H - y - 8, size: 8, color: rgb(c, 0.4, 1 - c), borderColor: rgb(0, 0, 0), borderWidth: 0.5 });
        else if (k === 1) p.drawSvgPath(`M3 0 H15 A3 3 0 0 1 18 3 V11 A3 3 0 0 1 15 14 H3 A3 3 0 0 1 0 11 V3 A3 3 0 0 1 3 0 Z`, { x, y: H - y, color: rgb(1 - c, c, 0.5) }); // no rounded rect in pdf-lib
        else p.drawSvgPath(CURVE(0, 0), { x, y: H - y, color: rgb(0.2, c, 0.8) });
      }
      return doc.save();
    }
    const reg = await doc.embedFont(kase === 'invoice' ? StandardFonts.Helvetica : StandardFonts.TimesRoman);
    if (kase === 'wrapped-50') { // pdf-lib has no justified text box: the wrapper above, and Tw set around each justified line
      const { setWordSpacing } = require('pdf-lib');
      for (let i = 1; i <= 50; i++) {
        const p = doc.addPage([595.28, 841.89]);
        let y = 50;
        for (let k = 0; k < 6; k++) {
          const lines = wrapFor(reg, PARA(i, k), 10, 495);
          lines.forEach(([t, w, gaps], n) => {
            const last = n === lines.length - 1;
            if (!last && gaps) p.pushOperators(setWordSpacing((495 - w) / gaps));
            p.drawText(t, { x: 50, y: 841.89 - y - n * 13 - 6.83, font: reg, size: 10 });
            if (!last && gaps) p.pushOperators(setWordSpacing(0));
          });
          y += lines.length * 13 + 10;
        }
      }
      return doc.save();
    }
    if (kase === 'invoice') {
      const bold = await doc.embedFont(StandardFonts.HelveticaBold);
      const p = doc.addPage([595.28, 841.89]), H = 841.89;
      p.drawText('INVOICE #2026-0042', { x: 50, y: H - 50 - 20 * 0.718, font: bold, size: 20 });
      p.drawText('Acme Ltd · 1 Main Street · Springfield', { x: 50, y: H - 80 - 7.18, font: reg, size: 10, color: rgb(0.4, 0.4, 0.4) });
      p.drawRectangle({ x: 50, y: H - 130, width: 495, height: 20, color: rgb(0.12, 0.31, 0.47) });
      ['Description', 'Qty', 'Amount'].forEach((h, i) => p.drawText(h, { x: 55 + [0, 330, 420][i], y: H - 114 - 7.18, font: bold, size: 10, color: rgb(1, 1, 1) }));
      ROWS.forEach((r, k) => { r.forEach((v, i) => p.drawText(v, { x: 55 + [0, 330, 420][i], y: H - 136 - k * 18 - 7.18, font: reg, size: 10 })); p.drawLine({ start: { x: 50, y: H - 151 - k * 18 }, end: { x: 545, y: H - 151 - k * 18 }, thickness: 0.5, color: rgb(0.85, 0.85, 0.85) }); });
      p.drawText('Total 3,825.00', { x: 420, y: H - 136 - 370 - 8.6, font: bold, size: 12 });
    } else {
      for (let i = 1; i <= 1000; i++) { const p = doc.addPage([595.28, 841.89]); for (let r = 0; r < 50; r++) p.drawText(LINE(i, r), { x: 50, y: 841.89 - 40 - r * 15 - 6.83, font: reg, size: 10 }); }
    }
    return doc.save();
  },
  async pdfkit(kase) {
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ size: 'A4', autoFirstPage: false, compress: true, info: { Title: 'Bench' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    const done = new Promise((r) => doc.on('end', r));
    if (kase === 'photos-20') {
      doc.addPage();
      for (let i = 0; i < 20; i++) doc.image(FIX.photo, 30 + (i % 4) * 135, 30 + Math.floor(i / 4) * 160, { width: 128, height: 96 });
    } else if (kase === 'icons-100') {
      doc.addPage();
      for (let i = 0; i < 100; i++) doc.image(FIX.icons[i], 30 + (i % 10) * 50, 30 + Math.floor(i / 10) * 50, { width: 32, height: 32 });
    } else if (kase === 'shapes-1000') {
      doc.addPage();
      for (let i = 0; i < 1000; i++) {
        const [k, x, y, c] = SHAPE(i);
        const hex = (r, g, b) => [r, g, b];
        if (k === 0) doc.circle(x + 8, y + 8, 8).lineWidth(0.5).fillAndStroke(hex(c * 255, 102, (1 - c) * 255), 'black');
        else if (k === 1) doc.roundedRect(x, y, 18, 14, 3).fill(hex((1 - c) * 255, c * 255, 128));
        else doc.path(CURVE(x, y)).fill(hex(51, c * 255, 204));
      }
    } else if (kase === 'invoice') {
      doc.addPage();
      doc.font('Helvetica-Bold').fontSize(20).text('INVOICE #2026-0042', 50, 50, { lineBreak: false });
      doc.font('Helvetica').fontSize(10).fillColor('#666').text('Acme Ltd · 1 Main Street · Springfield', 50, 80, { lineBreak: false });
      doc.rect(50, 110, 495, 20).fill('#1f4e79');
      doc.font('Helvetica-Bold').fillColor('#fff');
      ['Description', 'Qty', 'Amount'].forEach((h, i) => doc.text(h, 55 + [0, 330, 420][i], 114, { lineBreak: false }));
      doc.font('Helvetica').fillColor('#000');
      ROWS.forEach((r, k) => { r.forEach((v, i) => doc.text(v, 55 + [0, 330, 420][i], 136 + k * 18, { lineBreak: false })); doc.moveTo(50, 151 + k * 18).lineTo(545, 151 + k * 18).lineWidth(0.5).stroke('#d9d9d9'); });
      doc.font('Helvetica-Bold').fontSize(12).text('Total 3,825.00', 420, 506, { lineBreak: false });
    } else if (kase === 'wrapped-50') {
      doc.font('Times-Roman').fontSize(10);
      for (let i = 1; i <= 50; i++) { doc.addPage(); let y = 50; for (let k = 0; k < 6; k++) { doc.text(PARA(i, k), 50, y, { width: 495, align: 'justify', lineGap: 1.5 }); y = doc.y + 10; } }
    } else {
      doc.font('Times-Roman').fontSize(10);
      for (let i = 1; i <= 1000; i++) { doc.addPage(); for (let r = 0; r < 50; r++) doc.text(LINE(i, r), 50, 40 + r * 15, { lineBreak: false }); }
    }
    doc.end();
    await done;
    return Buffer.concat(chunks);
  },
};

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

// child mode: build one case once and exit (the cold measurement)
if (process.argv[2] === '--once') {
  const out = await LIBS[process.argv[3]](process.argv[4]);
  if (process.env.BENCH_SAVE) fs.writeFileSync(process.env.BENCH_SAVE, out); // to check the output: BENCH_SAVE=x.pdf node compare.mjs --once lib case
  process.stdout.write(String(out.length));
  process.exit(0);
}

const libs = Object.keys(LIBS).filter((l) => l === 'reportwright' || has(l));
const missing = Object.keys(LIBS).filter((l) => !libs.includes(l));
const rows = [];
const CASES = (process.env.CASES || 'invoice,text-1000,shapes-1000,photos-20,icons-100,wrapped-50,nav-500,form-200').split(',').filter((k) => FIX || !['photos-20', 'icons-100'].includes(k));
for (const kase of CASES) {
  for (const lib of libs) {
    if (lib === 'pdfkit' && kase === 'form-200') { console.error('form-200 pdfkit: not written'); continue; }
    if (lib === 'pdfkit' && kase === 'nav-500') { console.error('nav-500 pdfkit: not written (its link API is URL/named-only)'); continue; }
    let size = 0;
    await LIBS[lib](kase); // warm-up
    const warm = [];
    for (let i = 0; i < 10; i++) { const t = performance.now(); size = (await LIBS[lib](kase)).length; warm.push(performance.now() - t); }
    const cold = [];
    for (let i = 0; i < 10; i++) { const t = performance.now(); execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--once', lib, kase]); cold.push(performance.now() - t); }
    rows.push({ case: kase, library: lib, bytes: size, warmMs: +median(warm).toFixed(1), coldMs: +median(cold).toFixed(0) });
    console.error(`${kase} ${lib}: ${size} bytes, warm ${median(warm).toFixed(1)} ms, cold ${median(cold).toFixed(0)} ms`);
  }
}
console.table(rows);
if (missing.length) console.log(`not in node_modules (not measured): ${missing.join(', ')}`);
console.log(`node ${process.version}, ${process.platform} ${process.arch}`);
