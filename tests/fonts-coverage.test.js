// Round 2.3 font coverage: Type 1 (eexec, subrs, flex, seac), bare CFF simple fonts, CFF FontMatrix, Type 3, embedded
// CMaps with usecmap, vertical writing, text render modes 4–7; compared with pdf.js, and hostile input against the caps.
import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import { loadPdf, renderPage } from '../src/index.js';
import { type1Font as readType1, MAX_EEXEC, MAX_OPS, MAX_STACK } from '../src/render/type1.js';
import { parseCMap, decodeCodes, MAX_RANGES } from '../src/render/cmap.js';
import { fontPdfs, type1Font } from './font-fixtures.js';
import { rawPdf } from './reader-tools.js';
import { HAS_PDFJS, pdfjsOpen, pdfjsRender, diff } from './pdfjs-render.js';

const tick = () => {};
const quick = (f, ms = 5000) => {
  const t = Date.now();
  f();
  expect(Date.now() - t).toBeLessThan(ms);
};

describe('fonts: drawn as pdf.js draws them', () => {
  const all = fontPdfs();
  for (const [name, bytes] of Object.entries(all))
    it.skipIf(!HAS_PDFJS)(name, async () => {
      const ours = renderPage(await loadPdf(bytes), 0, { scale: 2 });
      const pj = await pdfjsRender(await pdfjsOpen(Buffer.from(bytes)), 0, 2);
      const d = diff(ours, pj, 32);
      expect(d.ink, 'something is drawn').toBeGreaterThan(300);
      expect(d.inkPct).toBeLessThan(3);
    });
});

describe('Type 1 programs', () => {
  const f = type1Font();
  it('PFB segments and hex eexec read as the binary form', () => {
    const clear = f.file.subarray(0, f.len1),
      enc = f.file.subarray(f.len1, f.len1 + f.len2);
    const seg = (t, b) =>
      Buffer.concat([Buffer.from([0x80, t, b.length & 255, (b.length >> 8) & 255, (b.length >> 16) & 255, 0]), b]);
    const pfb = Buffer.concat([seg(1, clear), seg(2, enc), Buffer.from([0x80, 3])]);
    const hex = Buffer.concat([
      clear,
      Buffer.from(
        Buffer.from(enc)
          .toString('hex')
          .replace(/(.{64})/g, '$1\n'),
      ),
    ]);
    const want = readType1(f.file, f.len1, tick).glyph('B');
    expect(want.length).toBeGreaterThan(10);
    expect(readType1(pfb, 0, tick).glyph('B')).toEqual(want);
    expect(readType1(hex, f.len1, tick).glyph('B')).toEqual(want);
  });
  it('seac draws the base and the accent', () => {
    const t = readType1(f.file, f.len1, tick);
    expect(t.glyph('Aacute').length).toBe(t.glyph('A').length + t.glyph('acute').length);
  });
});

describe('fonts: hostile input stops at the caps', () => {
  const encrypt = (b, r, lead = 4) => {
    const src = Uint8Array.from([...new Array(lead).fill(0), ...b]);
    const out = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i++) {
      const c = src[i] ^ (r >> 8);
      out[i] = c;
      r = ((c + r) * 52845 + 22719) & 0xffff;
    }
    return Buffer.from(out);
  };
  /** a Type 1 font whose glyph X is the given charstring bytes, and Subrs */
  const font = (glyph, subrs = []) => {
    const parts = [Buffer.from('/Private 8 dict dup begin /lenIV 4 def\n')];
    parts.push(Buffer.from(`/Subrs ${subrs.length} array\n`));
    subrs.forEach((s, i) => {
      const e = encrypt(s, 4330);
      parts.push(Buffer.from(`dup ${i} ${e.length} RD `), e, Buffer.from(' NP\n'));
    });
    const e = encrypt(glyph, 4330);
    parts.push(Buffer.from(`/CharStrings 1 dict dup begin\n/X ${e.length} RD `), e, Buffer.from(' ND\nend\n'));
    const clear = Buffer.from('%!PS-AdobeFont-1.0: H\n/FontMatrix [0.001 0 0 0.001 0 0] def\ncurrentfile eexec\n');
    return Buffer.concat([clear, encrypt(Buffer.concat(parts), 55665)]);
  };
  it('an eexec part over its cap is refused before it is decrypted', () => {
    const big = Buffer.concat([Buffer.from('currentfile eexec\n'), Buffer.alloc(MAX_EEXEC + 1, 0x80)]);
    expect(() => readType1(big, 0, tick)).toThrow(/eexec/);
  });
  it('a charstring over the operator cap, or the stack cap, stops', () => {
    // a subr of 60,000 bare rlinetos, called three times: more operators than the cap
    const sub = Buffer.concat([Buffer.alloc(60000, 5), Buffer.from([11])]);
    const call3 = Buffer.from([139, 10, 139, 10, 139, 10]);
    quick(() => expect(() => readType1(font(call3, [sub]), 0, tick).glyph('X')).toThrow(/operators/));
    const deep = Buffer.alloc(MAX_STACK + 1, 139);
    expect(() => readType1(font(Buffer.concat([deep, Buffer.from([5])])), 0, tick).glyph('X')).toThrow(/stack/);
  });
  it('a subr calling itself stops at the depth cap', () => {
    const self = Buffer.from([139, 10]); // 0 callsubr
    quick(() => expect(() => readType1(font(Buffer.from([139, 10]), [self]), 0, tick).glyph('X')).toThrow(/deep/));
  });
  it('a seac of seacs is not followed', () => {
    const seac = Buffer.from([139, 139, 139, 139 + 65, 139 + 65, 12, 6]); // seac of A, A (StandardEncoding 65 = A)
    expect(() => readType1(font(seac), 0, tick).glyph('X')).not.toThrow();
  });
  it('CMaps: mappings over the cap, and usecmap loops, stop', async () => {
    const lots = `1 begincodespacerange <00> <FF> endcodespacerange ${MAX_RANGES + 1} begincidchar ${'<41> 1 '.repeat(MAX_RANGES + 1)}endcidchar`;
    quick(() => expect(() => parseCMap(Buffer.from(lots), null, tick)).toThrow(/more than/));
    // a CMap whose /UseCMap is itself: drawn with its own mappings, the loop cut at the depth cap
    const body = '1 begincodespacerange <00> <FF> endcodespacerange 1 begincidrange <00> <FF> 0 endcidrange';
    const self = (n) => [`<< /Type /CMap /UseCMap ${n} 0 R /Length ${body.length} >>`, body];
    const pdf = rawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources << /Font << /F 5 0 R >> >> >>',
      ['<< /Length 30 >>', 'BT /F 20 Tf 10 10 Td (AB) Tj ET'],
      '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding 6 0 R /DescendantFonts [7 0 R] >>',
      self(6),
      '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /CIDSystemInfo << /Registry (A) /Ordering (I) /Supplement 0 >> >>',
    ]);
    const d = await loadPdf(pdf);
    quick(() => renderPage(d, 0));
  });
  it('a CMap with usecmap: the parent’s code spaces and mappings, the child’s first', () => {
    const base = parseCMap(
      Buffer.from(
        '1 begincodespacerange <0000> <00FF> endcodespacerange 1 begincidrange <0000> <00FF> 100 endcidrange',
      ),
      null,
      tick,
    );
    const top = parseCMap(
      Buffer.from(
        '1 begincodespacerange <41> <5A> endcodespacerange 1 begincidrange <41> <5A> 1 endcidrange 1 begincidchar <42> 7 endcidchar',
      ),
      base,
      tick,
    );
    expect(decodeCodes(top, Buffer.from([0x41, 0x42, 0x00, 0x05, 0x5b]))).toEqual([
      [1, false],
      [7, false],
      [105, false],
      [0, false], // 0x5B: in no code space: one byte, CID 0
    ]);
  });
  it('Type 3 fonts showing each other in a loop end', async () => {
    const proc = (f) => {
      const s = `100 0 d0 BT /${f} 50 Tf 0 0 Td (a) Tj ET 0 0 50 50 re f`;
      return [`<< /Length ${s.length} >>`, s];
    };
    const t3 = (proc, other) =>
      `<< /Type /Font /Subtype /Type3 /FontBBox [0 0 100 100] /FontMatrix [0.01 0 0 0.01 0 0] /CharProcs << /a ${proc} 0 R >> /Encoding << /Differences [97 /a] >> /FirstChar 97 /LastChar 97 /Widths [100] /Resources << /Font << /${other} ${other === 'A' ? 5 : 6} 0 R >> >> >>`;
    const content = 'BT /A 20 Tf 10 10 Td (aaaaaaaaaa) Tj ET';
    const pdf = rawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R /Resources << /Font << /A 5 0 R >> >> >>',
      [`<< /Length ${content.length} >>`, content],
      t3(7, 'B'),
      t3(8, 'A'),
      proc('B'),
      proc('A'),
    ]);
    const d = await loadPdf(pdf);
    quick(() => renderPage(d, 0, { scale: 1 }));
  });
  it('text clip outlines are bounded', async () => {
    const s = `BT /F1 600 Tf 7 Tr ${'(OOOOOOOOOO) Tj '.repeat(2000)}ET`;
    const t = type1Font();
    const z = zlib.deflateSync(Buffer.from(s));
    const pdf = rawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      [`<< /Filter /FlateDecode /Length ${z.length} >>`, z],
      '<< /Type /Font /Subtype /Type1 /BaseFont /TestOne /FirstChar 79 /LastChar 79 /Widths [1] /FontDescriptor 6 0 R >>',
      '<< /Type /FontDescriptor /FontName /TestOne /Flags 32 /FontFile 7 0 R >>',
      [`<< /Length1 ${t.len1} /Length ${t.file.length} >>`, t.file],
    ]);
    const d = await loadPdf(pdf, { budget: { maxSteps: 5_000_000 } });
    const t0 = Date.now();
    expect(() => renderPage(d, 0)).toThrow(/steps|points/);
    expect(Date.now() - t0).toBeLessThan(15000);
  });
});
