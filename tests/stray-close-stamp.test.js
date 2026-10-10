import { describe, it, expect } from 'vitest';
import { loadPdf } from '../src/index.js';
import { openSaves, countSaves } from '../src/reader/save.js';
import { createBudget } from '../src/reader/budget.js';
import { HAS, run, save } from './tools.js';

// a stray ] (or >>) at the top of a page's content must not stop the count of the q's it leaves open: otherwise a
// hostile page shrinks (or hides) a stamp drawn on it by leaving its own transform in force
const mk = (content) => {
  const e = (t) => new TextEncoder().encode(t),
    c = e(content);
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>',
    null,
  ];
  const ch = [e('%PDF-1.7\n')];
  let off = ch[0].length;
  const x = [];
  objs.forEach((o, k) => {
    x.push(off);
    const b = o
      ? e(`${k + 1} 0 obj\n${o}\nendobj\n`)
      : new Uint8Array([
          ...e(`${k + 1} 0 obj\n<< /Length ${c.length} >>\nstream\n`),
          ...c,
          ...e('\nendstream\nendobj\n'),
        ]);
    ch.push(b);
    off += b.length;
  });
  ch.push(
    e(
      `xref\n0 5\n0000000000 65535 f \n${x.map((v) => String(v).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${off}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(ch);
};
describe('stamp over a stray ] or >>', () => {
  for (const stray of [']', '>>'])
    it(`${stray} q 0.01 0 0 0.01 0 0 cm: the stamp is drawn outside the page's transform`, async () => {
      const b = Buffer.from(`${stray} q 0.01 0 0 0.01 0 0 cm`);
      expect(openSaves(b, createBudget())).toBe(1);
      expect(countSaves(b, createBudget())).toBe(1);
      const doc = await loadPdf(mk(`${stray} q 0.01 0 0 0.01 0 0 cm 0 0 100 100 re f`));
      doc.page(0).draw((p, { fonts }) => p.text('WATERMARK', { x: 100, y: 100, font: fonts.f, size: 30 }), {
        fonts: { f: 'Helvetica' },
      });
      const bytes = (await doc.save({ compress: false })).bytes,
        text = Buffer.from(bytes).toString('latin1');
      // the content, in order: the wrapper's q, the page's content, then Q for the wrapper and Q for the page's open q
      expect(text).toContain(`stream\n${stray} q 0.01 0 0 0.01 0 0 cm 0 0 100 100 re f\nendstream`);
      expect(text).toMatch(/stream\nQ\nQ\nq 1 0 0 1 0 0 cm \/RWx1 Do Q\n/);
      if (HAS.poppler) {
        // drawn full size where it was put (x 100 from the left), not shrunk to 1% at the origin
        const m = /xMin="([\d.]+)"[^>]*>WATERMARK</.exec(run('pdftotext', ['-bbox', save(bytes), '-']));
        expect(m).not.toBeNull();
        expect(Number(m[1])).toBeCloseTo(100, 0);
      }
    });
});
