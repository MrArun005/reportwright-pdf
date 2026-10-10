// @reportwright/pdf group A (graphics): the operators each feature writes, checked exactly, and pdf-lib (an independent
// parser) reading every file. Pixels: graphics-render.test.js; hostile input: hostile-graphics.test.js.
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFDict } from 'pdf-lib';
import { toBytes } from '../src/index.js';
import { Path } from '../src/graphics/path.js';
import { BLEND_MODES } from '../src/graphics/draw.js';
import { latin } from './tools.js';

const DATE = new Date('2026-01-01');
const H = 100;

/** build a 100 × 100 page with draw(page), uncompressed; → { text (whole file), ops (page 1 content), doc (pdf-lib), res } */
async function make(draw, o = {}) {
  const r = {};
  const out = await toBytes(async (pdf) => { const p = pdf.addPage({ width: 100, height: H }); r.ret = await draw(p, pdf); r.end = pdf.end; }, { compress: false, creationDate: DATE, ...o });
  const doc = await PDFDocument.load(out); // pdf-lib must parse every file
  const ops = Buffer.from(doc.getPage(0).node.Contents().getContents()).toString('latin1');
  return { text: latin(out), ops, doc, out, ...r };
}
/** the path operators of a Path for a 100-high page */
const ops = (p) => p.pdf(H).trim();

describe('paths', () => {
  it('moveTo, lineTo, bezierCurveTo, quadraticCurveTo (as a cubic) and closePath, y flipped from the top-left origin', () => {
    const p = new Path().moveTo(10, 10).lineTo(20, 10).bezierCurveTo(30, 10, 40, 20, 40, 30).quadraticCurveTo(40, 60, 10, 60).closePath();
    expect(ops(p)).toBe('10 90 m 20 90 l 30 90 40 80 40 70 c 40 50 30 40 10 40 c h');
    expect(p.segments).toBe(5);
  });
  it('lineTo or a curve with no current point starts the path there (as canvas); a lone move draws nothing', () => {
    expect(ops(new Path().lineTo(5, 5).lineTo(6, 6))).toBe('5 95 m 6 94 l');
    expect(ops(new Path().moveTo(1, 1).moveTo(2, 2))).toBe('');
  });
  it('arc: a full circle is four quarter Béziers, clockwise on the page; ccw turns the other way', () => {
    const full = ops(new Path().arc(50, 50, 10, 0, 2 * Math.PI));
    expect(full).toBe('60 50 m 60 44.477 55.523 40 50 40 c 44.477 40 40 44.477 40 50 c 40 55.523 44.477 60 50 60 c 55.523 60 60 55.523 60 50 c');
    expect(ops(new Path().arc(50, 50, 10, 0, Math.PI / 2, true)).match(/ c/g)).toHaveLength(3); // 270° the other way
    expect(ops(new Path().arc(0, 0, 10, 0, 1e6))).toMatch(/^10 100 m( [\d. -]+ c){4}$/); // huge angles: at most a full turn
  });
  it('arc from an existing point draws a line to its start; ellipse with rotation', () => {
    expect(ops(new Path().moveTo(0, 0).arc(50, 50, 10, 0, Math.PI / 2))).toBe('0 100 m 60 50 l 60 44.477 55.523 40 50 40 c');
    const e = ops(new Path().ellipse(50, 50, 20, 10, Math.PI / 2, 0, 2 * Math.PI));
    expect(e.startsWith('50 30 m')).toBe(true); // the 20-radius axis now points down the page
  });
  it('arcTo rounds a corner; collinear points or radius 0 give a line', () => {
    expect(ops(new Path().moveTo(0, 0).arcTo(50, 0, 50, 50, 10))).toBe('0 100 m 40 100 l 45.523 100 50 95.523 50 90 c');
    expect(ops(new Path().moveTo(0, 0).arcTo(50, 0, 100, 0, 10))).toBe('0 100 m 50 100 l');
    expect(ops(new Path().moveTo(0, 0).arcTo(50, 0, 50, 50, 0))).toBe('0 100 m 50 100 l');
  });
  it('rect and roundedRect with per-corner radii (canvas forms), scaled down when too big', () => {
    expect(ops(new Path().rect(10, 10, 20, 30))).toBe('10 90 m 30 90 l 30 60 l 10 60 l h');
    const r = ops(new Path().roundedRect(0, 0, 40, 20, [0, 5, 0, 5]));
    expect(r).toBe('0 100 m 35 100 l 37.761 100 40 97.761 40 95 c 40 80 l 5 80 l 2.239 80 0 82.239 0 85 c 0 100 l h');
    const big = new Path().roundedRect(0, 0, 20, 20, 50); // radii 10 each
    expect(ops(big).startsWith('10 100 m 10 100 l')).toBe(true);
    expect(() => new Path().roundedRect(0, 0, 1, 1, [1, 2, 3, 4, 5])).toThrow(/1–4/);
    expect(() => new Path().roundedRect(0, 0, 1, 1, -1)).toThrow(/negative/);
  });
});

describe('painting', () => {
  it('fill (nonzero, evenodd), stroke and fill-and-stroke', async () => {
    const { ops: o } = await make((p) => {
      const sq = p.path().rect(0, 0, 10, 10);
      p.fill(sq, { color: '#ff0000' });
      p.fill(sq, { fill: 0.5, rule: 'evenodd' });
      p.stroke(sq, { color: [0, 0, 1] });
      p.fillAndStroke(sq, { fill: 1, stroke: 0 });
      p.fillAndStroke(sq, { fill: 1, stroke: 0, rule: 'evenodd' });
    });
    expect(o).toContain('1 0 0 rg\nq 1 0 0 1 0 100 cm 0 0 m 10 0 l 10 -10 l 0 -10 l h f Q\n');
    expect(o).toContain('0.5 g\nq 1 0 0 1 0 100 cm 0 0 m 10 0 l 10 -10 l 0 -10 l h f* Q\n');
    expect(o).toContain('0 0 1 RG\nq 1 0 0 1 0 100 cm 0 0 m 10 0 l 10 -10 l 0 -10 l h S Q\n');
    expect(o).toMatch(/1 g\n0 G\nq 1 0 0 1 0 100 cm 0 0 m .* h B Q\n/);
    expect(o).toMatch(/ h B\* Q\n/);
    await expect(make((p) => p.fill(p.path().rect(0, 0, 1, 1), { rule: 'odd' }))).rejects.toThrow(/nonzero.*evenodd/);
    await expect(make((p) => p.fill('M0 0'))).rejects.toThrow(/Not a path/);
  });
  it('stroke styles: width, dash and phase, cap, join, miter limit; set only when they change, back to defaults after', async () => {
    const { ops: o } = await make((p) => {
      const l = p.path().moveTo(0, 0).lineTo(50, 50);
      p.stroke(l, { width: 2, dash: [3, 1], dashPhase: 2, cap: 'round', join: 'bevel', miterLimit: 4 });
      p.stroke(l, { width: 2, dash: [3, 1], dashPhase: 2, cap: 'round', join: 'bevel', miterLimit: 4 });
      p.stroke(l, { cap: 'square', join: 'round' });
      p.stroke(l);
    });
    expect(o).toContain('2 w\n[3 1] 2 d\n1 J\n2 j\n4 M\n0 100 m 50 50 l S\n0 100 m 50 50 l S\n1 w\n[] 0 d\n2 J\n1 j\n10 M\n0 100 m 50 50 l S\n0 J\n0 j\n0 100 m 50 50 l S\n');
  });
  it('clip with nonzero and evenodd, scoped by save/restore; an empty path clips everything', async () => {
    const { ops: o } = await make((p) => {
      p.save(); p.clip(p.path().rect(0, 0, 50, 50)); p.fill(p.path().rect(0, 0, 100, 100)); p.restore();
      p.save(); p.clip(p.path().rect(0, 0, 50, 50), 'evenodd'); p.restore();
      p.save(); p.clip(p.path()); p.restore();
    });
    expect(o).toContain('q\n0 100 m 50 100 l 50 50 l 0 50 l h W n\nq 1 0 0 1 0 100 cm 0 0 m 100 0 l 100 -100 l 0 -100 l h f Q\nQ\n');
    expect(o).toContain('h W* n\nQ\n');
    expect(o).toContain('q\n0 0 0 0 re W n\nQ\n');
  });
  it('page.svgPath draws as rect() does: fill, stroke, both; neither fills black', async () => {
    const { ops: o } = await make((p) => {
      p.svgPath('M0 0 L10 0 L10 10 Z');
      p.svgPath('M0 0 H10', { stroke: '#00ff00', width: 3 });
      p.svgPath('M0 0 V10 H10 z', { fill: 1, stroke: 0 });
    });
    expect(o.startsWith('q 1 0 0 1 0 100 cm 0 0 m 10 0 l 10 -10 l h f Q\n')).toBe(true);
    expect(o).toContain('0 1 0 RG\n3 w\n0 100 m 10 100 l S\n');
    expect(o).toMatch(/q 1 0 0 1 0 100 cm 0 0 m 0 -10 l 10 -10 l h B Q\n/);
  });
});

describe('transforms and save/restore', () => {
  it('translate, rotate, scale, skew and transform become cm operators in PDF space (F·T·F)', async () => {
    const { ops: o } = await make((p) => {
      p.save(); p.translate(10, 20); p.restore();
      p.save(); p.rotate(Math.PI / 2); p.restore();
      p.save(); p.scale(2, 3); p.restore();
      p.save(); p.skew(Math.PI / 4, 0); p.restore();
      p.save(); p.transform(1, 2, 3, 4, 5, 6); p.restore();
    });
    expect(o).toContain('q\n1 0 0 1 10 -20 cm\nQ\n');
    expect(o).toContain('q\n0 -1 1 0 -100 100 cm\nQ\n');
    expect(o).toContain('q\n2 0 0 3 0 -200 cm\nQ\n');
    expect(o).toContain('q\n1 0 -1 1 100 0 cm\nQ\n');
    expect(o).toContain('q\n1 -2 -3 4 305 -306 cm\nQ\n');
  });
  it('a translated shape lands where the translation says (checked through the matrix and the operators)', async () => {
    const { ops: o } = await make((p) => { p.translate(30, 40); p.fill(p.path().rect(0, 0, 10, 10)); });
    // PDF point (0, 100) (the shape's top-left) through cm [1 0 0 1 30 -40] is (30, 60) = top-left (30, 40)
    expect(o).toContain('1 0 0 1 30 -40 cm\nq 1 0 0 1 0 100 cm 0 0 m 10 0 l 10 -10 l 0 -10 l h f Q\n');
  });
  it('restore without save throws; saves left open are closed at the page end with a warning', async () => {
    await expect(make((p) => p.restore())).rejects.toThrow(/no page\.save\(\)/);
    const r = await make((p) => { p.save(); p.save(); p.translate(1, 1); });
    expect(r.ops.match(/^q$/gm)).toHaveLength(2);
    expect(r.ops.match(/^Q$/gm)).toHaveLength(2);
  });
  it('the unbalanced-save warning reaches pdf.end()', async () => {
    let warnings;
    await toBytes(async (pdf) => {
      const p = pdf.addPage(); p.save(); p.save(); p.restore();
      const end = pdf.end.bind(pdf);
      pdf.end = async () => { const r = await end(); warnings = r.warnings; return r; };
    }, { creationDate: DATE });
    expect(warnings).toEqual(['Page 1: 1 page.save() without a page.restore(); restored at the end of the page']);
  });
  it('PDF/A limits save nesting to 27 (q/Q depth 28 with an internal one)', async () => {
    const f = (n) => toBytes((pdf) => { const p = pdf.addPage(); for (let i = 0; i < n; i++) p.save(); }, { pdfa: true, creationDate: DATE });
    await expect(f(27)).resolves.toBeInstanceOf(Uint8Array);
    await expect(f(28)).rejects.toThrow(/at most 27 nested saves in PDF\/A/);
  });
});

describe('opacity and blend modes', () => {
  it('ExtGState per distinct value, shared by pages; fill and stroke opacity; a transparency group on pages that use it', async () => {
    const out = await toBytes((pdf) => {
      const a = pdf.addPage(), b = pdf.addPage(), c = pdf.addPage();
      const sq = a.path().rect(0, 0, 10, 10);
      a.fill(sq, { opacity: 0.5 }); a.fill(sq, { opacity: 0.5 }); b.fill(sq, { opacity: 0.5 });
      b.fillAndStroke(sq, { fill: 1, stroke: 0, fillOpacity: 0.25, strokeOpacity: 0.75 });
      c.fill(sq, { opacity: 1 });
    }, { compress: false, creationDate: DATE });
    const t = latin(out);
    expect(t).toContain('/ExtGState << /GS1 << /Type /ExtGState /ca 0.5 /CA 0.5 >> /GS2 << /Type /ExtGState /ca 0.25 /CA 0.75 >> >>');
    expect(t.match(/\/GS1 gs/g)).toHaveLength(3);
    expect(t).toContain('q\n/GS1 gs\n1 0 0 1 0 841.89 cm 0 0 m');
    const doc = await PDFDocument.load(out);
    const group = (i) => doc.getPage(i).node.get(PDFName.of('Group'))?.toString() ?? null;
    expect(group(0)).toMatch('/S /Transparency');
    expect(group(0)).toMatch('/CS /DeviceRGB');
    expect(group(1)).toMatch('/S /Transparency');
    expect(group(2)).toBe(null);
  });
  it('all 16 PDF blend modes, by PDF or canvas name; others throw; opacity outside 0–1 throws', async () => {
    const { text } = await make((p) => {
      const sq = p.path().rect(0, 0, 1, 1);
      for (const m of BLEND_MODES) p.fill(sq, { blendMode: m });
      p.fill(sq, { blendMode: 'color-dodge' });
    });
    expect(BLEND_MODES).toHaveLength(16);
    for (const m of BLEND_MODES.slice(1)) expect(text).toContain(`/BM /${m} >>`);
    expect(text).not.toContain('/BM /Normal');
    expect(text.match(/\/BM \/ColorDodge/g)).toHaveLength(1); // deduplicated
    await expect(make((p) => p.fill(p.path().rect(0, 0, 1, 1), { blendMode: 'Plus' }))).rejects.toThrow(/blendMode is one of/);
    await expect(make((p) => p.fill(p.path().rect(0, 0, 1, 1), { opacity: 1.5 }))).rejects.toThrow(/opacity is 0–1/);
  });
});

describe('gradients and patterns', () => {
  it('two stops: an axial shading with a Type 2 function, as a pattern fill whose matrix is the page flip', async () => {
    const { text, ops: o } = await make((p) => p.fill(p.path().rect(0, 0, 100, 100), { fill: p.linearGradient(0, 0, 100, 0, [[0, '#ff0000'], [1, '#0000ff']]) }));
    expect(o).toContain('/Pattern cs /P1 scn\n');
    expect(text).toContain('/P1 << /Type /Pattern /PatternType 2 /Shading << /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 100 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >> /Extend [true true] >> /Matrix [1 0 0 -1 0 100] >>');
  });
  it('more stops: a Type 3 stitching function; stops sorted, clamped and padded; hard stops kept', async () => {
    const { text } = await make((p) => {
      p.fill(p.path().rect(0, 0, 1, 1), { fill: p.radialGradient(50, 50, 0, 50, 50, 40, [{ offset: 0.8, color: 1 }, { offset: -3, color: '#f00' }, { offset: 0.5, color: [0, 1, 0] }, { offset: 0.5, color: '#00f' }], { extend: [false, true] }) });
    });
    expect(text).toContain('/ShadingType 3 /ColorSpace /DeviceRGB /Coords [50 50 0 50 50 40] /Function << /FunctionType 3 /Domain [0 1] /Functions [<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 1 0] /N 1 >> << /FunctionType 2 /Domain [0 1] /C0 [0 0 1] /C1 [1 1 1] /N 1 >> << /FunctionType 2 /Domain [0 1] /C0 [1 1 1] /C1 [1 1 1] /N 1 >>] /Bounds [0.5 0.8] /Encode [0 1 0 1 0 1] >> /Extend [false true]');
  });
  it('a gradient follows the transform (in its pattern matrix) and paints the clip with page.shade (sh)', async () => {
    const { text, ops: o } = await make((p) => {
      const g = p.linearGradient(0, 0, 10, 0, [[0, 0], [1, 1]]);
      p.translate(10, 20);
      p.fill(p.path().rect(0, 0, 10, 10), { stroke: g, fill: g });
      p.stroke(p.path().rect(0, 0, 10, 10), { stroke: g });
      p.shade(g);
    });
    expect(text).toContain('/Matrix [1 0 0 -1 10 80] >>');
    expect(o).toContain('/Pattern CS /P1 SCN\n');
    expect(o).toContain('q 1 0 0 -1 0 100 cm /S1 sh Q\n');
    expect(text).toContain('/Shading << /S1 << /ShadingType 2');
  });
  it('a tiling pattern: one stream per transform, its cell resources, spacing as XStep/YStep; no text in a cell', async () => {
    const { text, ops: o } = await make((p) => {
      const t = p.tilingPattern({ width: 10, height: 6, spacing: [2, 4] }, (c) => {
        c.fill(c.path().rect(0, 0, 5, 3), { fill: '#f00', opacity: 0.5 });
        c.fill(c.path().rect(5, 3, 5, 3), { fill: c.linearGradient(0, 0, 10, 0, [[0, 0], [1, 1]]) });
      });
      p.fill(p.path().rect(0, 0, 50, 50), { fill: t });
      p.fill(p.path().rect(50, 50, 50, 50), { fill: t });
      p.save(); p.scale(2); p.fill(p.path().rect(0, 0, 10, 10), { fill: t }); p.restore();
      expect(() => p.tilingPattern({ width: 1, height: 1 }, (c) => c.text('x', {}))).toThrow(/cannot be used in a tiling pattern's cell/);
    });
    const pats = [...text.matchAll(/\/PatternType 1 [^\n]*\/Matrix \[([^\]]+)\]/g)].map((m) => m[1]);
    expect(pats).toEqual(['1 0 0 1 0 94', '2 0 0 2 0 88']);
    expect(text).toMatch(/\/BBox \[0 0 10 6\] \/XStep 12 \/YStep 10 \/Resources << \/ExtGState << \/GS1 << \/Type \/ExtGState \/ca 0.5 \/CA 0.5 >> >> \/Pattern << \/P1 << \/Type \/Pattern \/PatternType 2 [^\n]*\/Matrix \[1 0 0 -1 0 6\] >> >> >>/);
    expect(o.match(/\/Pattern cs \/P2 scn/g)).toHaveLength(1);
    expect(o).toContain('/Pattern cs /P3 scn');
    expect(text).toMatch(/\/Group << \/Type \/Group \/S \/Transparency/); // the cell is semi-transparent
  });
});

describe('SVG path data', () => {
  it('absolute and relative commands, H/V, smooth curves (S, T), implicit repeats, packed numbers', () => {
    const p = new Path().svg('m10 10 20 0 v10h-5V40H10zM0,0l1-1.5.5.5e1');
    expect(ops(p)).toBe('10 90 m 30 90 l 30 80 l 25 80 l 25 60 l 10 60 l h 0 100 m 1 101.5 l 1.5 96.5 l');
    const s = new Path().svg('M0 0 C0 10 10 10 10 0 S20 -10 20 0 Q25 10 30 0 T40 0');
    expect(ops(s)).toBe('0 100 m 0 90 10 90 10 100 c 10 110 20 110 20 100 c 23.333 93.333 26.667 93.333 30 100 c 33.333 106.667 36.667 106.667 40 100 c');
  });
  it('arcs: endpoint form to Béziers; too-small radii scale up; packed flags; zero radius is a line', () => {
    expect(ops(new Path().svg('M0 50 A50 50 0 0 1 100 50'))).toBe('0 50 m 0 77.614 22.386 100 50 100 c 77.614 100 100 77.614 100 50 c');
    expect(ops(new Path().svg('M0 50 A1 1 0 0 1 100 50'))).toBe(ops(new Path().svg('M0 50 A50 50 0 0 1 100 50')));
    expect(ops(new Path().svg('M0 50a50 50 0 01100 0'))).toBe(ops(new Path().svg('M0 50 A50 50 0 0 1 100 50')));
    expect(ops(new Path().svg('M0 50 A0 5 0 0 1 100 50'))).toBe('0 50 m 100 50 l');
    expect(ops(new Path().svg('M0 50 A50 50 0 0 0 100 50'))).toMatch(/^0 50 m 0 22.386/); // the other side
  });
  it('malformed data throws a SyntaxError naming where', () => {
    for (const bad of ['L1 1', 'M1', 'M1 1 X', 'M1 1 A1 1 0 2 1 2 2', 'M 1e 2', 'M1 1 Z 3', '1 2']) expect(() => new Path().svg(bad)).toThrow(SyntaxError);
    expect(() => new Path().svg('M1 1 L2')).toThrow(/a number was expected at character 7/);
  });
});

describe('tagged PDFs: figures and artifacts', () => {
  it('graphics are artifacts by default; page.figure makes a Figure with alt text; alt is required when tagged', async () => {
    const out = await toBytes(async (pdf) => {
      const p = pdf.addPage();
      p.fill(p.path().rect(0, 0, 10, 10));
      p.figure({ alt: 'A red square' }, () => p.fill(p.path().rect(20, 20, 10, 10), { fill: '#f00' }));
      expect(() => p.figure({}, () => {})).toThrow(/needs alt text/);
    }, { title: 'T', tagged: { lang: 'en' }, compress: false, creationDate: DATE });
    const t = latin(out);
    expect(t).toContain('/Artifact BMC\nq 1 0 0 1 0 841.89 cm 0 0 m');
    expect(t).toMatch(/EMC\n\/Figure <<\/MCID 0>> BDC\n1 0 0 rg\n/);
    const doc = await PDFDocument.load(out);
    const root = doc.catalog.lookup(PDFName.of('StructTreeRoot'), PDFDict);
    const fig = doc.context.lookup(root.lookup(PDFName.of('K'), PDFDict).lookup(PDFName.of('K')).get(0), PDFDict);
    expect(fig.get(PDFName.of('S')).toString()).toBe('/Figure');
    expect(fig.get(PDFName.of('Alt')).decodeText()).toBe('A red square');
  });
  it('untagged, page.figure just draws', async () => {
    const { ret } = await make((p) => p.figure({}, () => 42));
    expect(ret).toBe(42);
  });
});
