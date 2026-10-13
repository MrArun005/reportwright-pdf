// PDFs for the renderer tests: ours (text, a table, vector graphics, images, a form) and pdf-lib's (third-party
// writers: its standard-font text and its own vector drawing, images and form widgets).
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { toBytes, cmyk } from '../src/index.js';
import fs from 'node:fs';
import path from 'node:path';
import { INTER, ROOT } from './tools.js';

const SC = fs.readFileSync(path.join(ROOT, 'tests/fixtures/fonts/NotoSansSC-Subset.otf'));
import { png } from './image-fixtures.js';

const D = new Date('2026-01-01');
const small = { width: 300, height: 220 };

export async function ours() {
  const text = await toBytes(
    async (pdf) => {
      const f = await pdf.embedFont(INTER);
      const p = pdf.addPage(small);
      p.text('Hello, rendering 123', { x: 16, y: 20, font: f, size: 22 });
      p.text('Small text: the quick brown fox jumps', { x: 16, y: 60, font: f, size: 10, color: '#1f4e79' });
      p.textBox('A justified paragraph wraps over a few lines in a box, drawn by the writer.', {
        x: 16,
        y: 90,
        width: 260,
        font: f,
        size: 12,
        align: 'justify',
      });
    },
    { creationDate: D },
  );
  const table = await toBytes(
    async (pdf) => {
      const f = await pdf.embedFont(INTER);
      const p = pdf.addPage(small);
      const rows = [
        ['Region', 'Q1', 'Q2'],
        ['North', '1,204', '1,390'],
        ['South', '980', '1,122'],
        ['West', '1,510', '1,488'],
      ];
      p.fill(p.path().rect(16, 16, 268, 22), { fill: '#1f4e79' });
      rows.forEach((r, i) => {
        r.forEach((c, k) => p.text(c, { x: 22 + k * 90, y: 21 + i * 22, font: f, size: 11, color: i ? 0 : '#ffffff' }));
        p.stroke(
          p
            .path()
            .moveTo(16, 38 + i * 22)
            .lineTo(284, 38 + i * 22),
          { stroke: 0.6, width: 0.5 },
        );
      });
      p.stroke(p.path().rect(16, 16, 268, 88), { stroke: 0, width: 1 });
    },
    { creationDate: D },
  );
  const vector = await toBytes(
    async (pdf) => {
      const p = pdf.addPage(small);
      p.fill(p.path().arc(60, 60, 40, 0, 2 * Math.PI), { fill: '#d62728' });
      p.fill(p.path().rect(110, 20, 80, 80).rect(130, 40, 40, 40), { fill: cmyk(0.8, 0.1, 0, 0.1), rule: 'evenodd' });
      p.stroke(p.path().moveTo(210, 20).lineTo(280, 60).lineTo(210, 100), {
        stroke: '#2ca02c',
        width: 10,
        join: 'miter',
      });
      p.stroke(p.path().moveTo(20, 130).lineTo(120, 130), { stroke: 0, width: 8, cap: 'round' });
      p.stroke(p.path().moveTo(20, 155).lineTo(120, 155), { stroke: 0, width: 8, cap: 'square' });
      p.stroke(p.path().moveTo(20, 180).bezierCurveTo(60, 140, 100, 220, 140, 180), {
        stroke: '#9467bd',
        width: 3,
        dash: [8, 4],
      });
      p.stroke(p.path().moveTo(160, 130).lineTo(200, 200).lineTo(240, 130), {
        stroke: '#8c564b',
        width: 8,
        join: 'round',
      });
      p.stroke(p.path().moveTo(250, 130).lineTo(270, 200).lineTo(290, 130), {
        stroke: '#17becf',
        width: 8,
        join: 'bevel',
      });
      p.fill(p.path().rect(150, 205, 140, 10), { fill: '#ff7f0e', opacity: 0.5 });
    },
    { creationDate: D },
  );
  const images = await toBytes(
    async (pdf) => {
      const rgbImg = await pdf.embedImage(
        png({ w: 16, h: 16, type: 2, depth: 8, px: (x, y) => [x * 16, y * 16, 128] }),
      );
      const rgba = await pdf.embedImage(
        png({
          w: 32,
          h: 32,
          type: 6,
          depth: 8,
          px: (x, y) => [31, 78, 121, (x - 16) ** 2 + (y - 16) ** 2 < 225 ? 255 : 0],
        }),
      );
      const gray = await pdf.embedImage(png({ w: 8, h: 8, type: 0, depth: 8, px: (x, y) => [((x + y) & 1) * 255] }));
      const p = pdf.addPage(small);
      p.image(rgbImg, { x: 16, y: 16, width: 120, height: 120 });
      p.image(rgba, { x: 150, y: 16, width: 64, height: 64 });
      p.image(gray, { x: 150, y: 100, width: 100, height: 100 });
    },
    { creationDate: D },
  );
  const form = await toBytes(
    async (pdf) => {
      const f = await pdf.embedFont(INTER);
      const p = pdf.addPage(small);
      pdf.form.textField('name', {
        page: p,
        x: 16,
        y: 20,
        width: 200,
        height: 22,
        font: f,
        size: 12,
        value: 'Ada Lovelace',
      });
      pdf.form.checkbox('agree', { page: p, x: 16, y: 60, width: 16, height: 16, checked: true });
      pdf.form.checkbox('cross', { page: p, x: 40, y: 60, width: 16, height: 16, checked: true, style: 'cross' });
    },
    { creationDate: D },
  );
  const cff = await toBytes(
    async (pdf) => {
      const sc = await pdf.embedFont(SC);
      const p = pdf.addPage({ ...small, rotate: 90 });
      p.text('中文 CFF text 123', { x: 16, y: 20, font: sc, size: 20 });
      p.save();
      p.clip(p.path().arc(150, 140, 50, 0, 2 * Math.PI));
      p.fill(p.path().rect(90, 80, 120, 120), { fill: cmyk(0, 0.7, 0.9, 0) });
      p.stroke(p.path().moveTo(90, 80).lineTo(210, 200), { stroke: 0, width: 6 });
      p.restore();
    },
    { creationDate: D },
  );
  return { text, table, vector, images, form, cff };
}

export async function pdfLib() {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([300, 220]);
  page.drawText('pdf-lib Helvetica text', { x: 16, y: 180, size: 18, font: helv });
  page.drawRectangle({
    x: 16,
    y: 100,
    width: 120,
    height: 60,
    color: rgb(0.2, 0.5, 0.8),
    borderColor: rgb(0, 0, 0),
    borderWidth: 2,
  });
  page.drawEllipse({ x: 210, y: 130, xScale: 60, yScale: 30, color: rgb(0.9, 0.6, 0.1) });
  page.drawLine({ start: { x: 16, y: 80 }, end: { x: 284, y: 20 }, thickness: 3, color: rgb(0.8, 0.1, 0.1) });
  page.drawSvgPath('M 0 0 L 40 0 L 20 -30 Z', { x: 230, y: 70, color: rgb(0.1, 0.6, 0.3) });
  const vec = await doc.save({ useObjectStreams: false });

  const d2 = await PDFDocument.create();
  const p2 = d2.addPage([300, 220]);
  const img = await d2.embedPng(
    png({ w: 24, h: 24, type: 6, depth: 8, px: (x, y) => [x * 10, 200, y * 10, x < 12 ? 255 : 128] }),
  );
  p2.drawImage(img, { x: 20, y: 20, width: 160, height: 160 });
  const form = d2.getForm();
  const tf = form.createTextField('who');
  tf.setText('pdf-lib field');
  tf.addToPage(p2, { x: 190, y: 150, width: 100, height: 24, font: await d2.embedFont(StandardFonts.Helvetica) });
  const cb = form.createCheckBox('ok');
  cb.addToPage(p2, { x: 200, y: 100, width: 20, height: 20 });
  cb.check();
  const imgForm = await d2.save();
  return { 'pdflib-vector': vec, 'pdflib-image-form': imgForm };
}
