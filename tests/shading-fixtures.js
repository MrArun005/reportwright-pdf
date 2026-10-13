// PDFs for the shading and pattern tests: hand-built pages (every ShadingType 1–7, function Types 0/2/3/4, tiling
// patterns coloured and uncoloured as fill, stroke and text fill) and a report-style chart written with our library.
import { toBytes } from '../src/index.js';
import { rawPdf } from './reader-tools.js';
import { INTER } from './tools.js';

const D = new Date('2026-01-01');

/** a 300 × 220 page: content, its /Resources (text), and objects from 5 on */
const page = (content, resources, objs = []) =>
  rawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 220] /Contents 4 0 R /Resources ${resources} >>`,
    [`<< /Length ${content.length} >>`, Buffer.from(content, 'latin1')],
    ...objs,
  ]);
/** a stream object [dict, bytes] */
const stream = (dict, bytes) => [`<< ${dict} /Length ${bytes.length} >>`, Buffer.from(bytes)];

/** big-endian bit packing: [value, bits] pairs; align() pads to a byte */
function bits() {
  const out = [];
  let acc = 0,
    n = 0;
  const w = {
    put(v, b) {
      for (let i = b - 1; i >= 0; i--) {
        acc = (acc << 1) | ((v >>> i) & 1);
        if (++n === 8) (out.push(acc), (acc = 0), (n = 0));
      }
      return w;
    },
    align() {
      if (n) w.put(0, 8 - n);
      return w;
    },
    bytes: () => (w.align(), Uint8Array.from(out)),
  };
  return w;
}
const c8 = (v) => Math.round(v * 255);
const xy = (x, y) => [
  [Math.round((x / 300) * 65535), 16],
  [Math.round((y / 220) * 65535), 16],
];

export async function shadingPdfs() {
  const out = {};
  const exp = (c0, c1) => `<< /FunctionType 2 /Domain [0 1] /C0 [${c0}] /C1 [${c1}] /N 1 >>`;

  // axial: a stitching of two exponentials, extended; and a sampled (Type 0) function, not extended
  out['sh-axial'] = page(
    'q 20 20 260 80 re W n /A sh Q q 20 120 260 80 re W n /B sh Q',
    '<< /Shading << /A 5 0 R /B 6 0 R >> >>',
    [
      `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [60 0 240 0] /Extend [true true] /Function << /FunctionType 3 /Domain [0 1] /Bounds [0.4] /Encode [0 1 0 1] /Functions [${exp('1 0 0', '1 1 0')} ${exp('0 0.6 0', '0 0 1')}] >> >>`,
      `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [40 120 260 200] /Function 7 0 R >>`,
      stream(
        '/FunctionType 0 /Domain [0 1] /Range [0 1 0 1 0 1] /Size [4] /BitsPerSample 8',
        [255, 255, 255, 0, 128, 255, 255, 64, 0, 0, 0, 0],
      ),
    ],
  );
  // radial: concentric from a point, two offset circles extended, and a cone (one circle outside the other)
  out['sh-radial'] = page(
    'q 0 0 100 220 re W n /A sh Q q 100 0 100 220 re W n /B sh Q q 200 0 100 220 re W n /C sh Q',
    '<< /Shading << /A 5 0 R /B 6 0 R /C 7 0 R >> >>',
    [
      `<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [50 110 0 50 110 45] /Function ${exp('1 1 1', '0 0 0.5')} >>`,
      `<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [140 120 5 160 100 40] /Extend [true true] /Function ${exp('1 0.8 0', '0.6 0 0.6')} >>`,
      `<< /ShadingType 3 /ColorSpace /DeviceGray /Coords [230 60 10 260 160 30] /Extend [true false] /Function ${exp('0.1', '0.9')} >>`,
    ],
  );
  // function-based (Type 1) through a PostScript calculator (Type 4), with a Domain and a Matrix
  const ps = '{ 2 copy mul 3 1 roll dup 0.5 gt { pop 1 } { 2 mul } ifelse exch }';
  out['sh-function'] = page('q 20 20 260 180 re W n /A sh Q', '<< /Shading << /A 5 0 R >> >>', [
    `<< /ShadingType 1 /ColorSpace /DeviceRGB /Domain [0 1 0 1] /Matrix [260 0 0 180 20 20] /Function 6 0 R >>`,
    stream('/FunctionType 4 /Domain [0 1 0 1] /Range [0 1 0 1 0 1]', Buffer.from(ps)),
  ]);
  // free-form triangle mesh (Type 4): flags 0, 1 and 2, RGB at the vertices
  {
    const w = bits();
    const v = (f, x, y, r, g, b) => {
      w.put(f, 8);
      for (const [a, n] of xy(x, y)) w.put(a, n);
      w.put(c8(r), 8).put(c8(g), 8).put(c8(b), 8).align();
    };
    v(0, 20, 20, 1, 0, 0);
    v(0, 150, 200, 0, 1, 0);
    v(0, 280, 20, 0, 0, 1);
    v(1, 280, 200, 1, 1, 0); // shares the last edge (150,200)–(280,20)
    v(2, 20, 200, 0, 1, 1); // shares (150,200)…: the edge from the first of the last three to the last
    out['mesh-4'] = page('/M sh', '<< /Shading << /M 5 0 R >> >>', [
      stream(
        '/ShadingType 4 /ColorSpace /DeviceRGB /BitsPerCoordinate 16 /BitsPerComponent 8 /BitsPerFlag 8 /Decode [0 300 0 220 0 1 0 1 0 1]',
        w.bytes(),
      ),
    ]);
  }
  // lattice mesh (Type 5) with a Function: one t per vertex
  {
    const w = bits();
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 5; c++) {
        for (const [a, n] of xy(20 + c * 65 + (r % 2) * 10, 20 + r * 60)) w.put(a, n);
        w.put(c8((((r * 5 + c) * 37) % 100) / 100), 8);
      }
    out['mesh-5'] = page('/M sh', '<< /Shading << /M 5 0 R >> >>', [
      stream(
        `/ShadingType 5 /ColorSpace /DeviceRGB /BitsPerCoordinate 16 /BitsPerComponent 8 /VerticesPerRow 5 /Decode [0 300 0 220 0 1] /Function ${exp('0 0.2 0.8', '1 0.9 0.1')}`,
        w.bytes(),
      ),
    ]);
  }
  // Coons (Type 6) and tensor-product (Type 7) patches: one new patch, then one sharing its right edge (flag 2)
  for (const type of [6, 7]) {
    const w = bits();
    const pt = (x, y) => xy(x, y).forEach(([a, n]) => w.put(a, n));
    const col = (r, g, b) => w.put(c8(r), 8).put(c8(g), 8).put(c8(b), 8);
    w.put(0, 8);
    // p00 p01 p02 p03 p13 p23 p33 p32 p31 p30 p20 p10 (u across, v up), bulging edges
    [
      [20, 20],
      [10, 80],
      [30, 140],
      [20, 200],
      [60, 215],
      [100, 185],
      [140, 200],
      [150, 140],
      [130, 80],
      [140, 20],
      [100, 5],
      [60, 35],
    ].forEach(([x, y]) => pt(x, y));
    if (type === 7)
      [
        [60, 90],
        [60, 140],
        [100, 140],
        [100, 80],
      ].forEach(([x, y]) => pt(x, y)); // p11 p12 p22 p21
    col(1, 0, 0);
    col(0, 1, 0);
    col(0, 0, 1);
    col(1, 1, 0);
    w.put(2, 8); // the next patch's p00..p03 = this one's p33 p32 p31 p30
    [
      [200, 210],
      [240, 190],
      [280, 200],
      [270, 140],
      [290, 80],
      [280, 20],
      [240, 30],
      [200, 10],
    ].forEach(([x, y]) => pt(x, y));
    if (type === 7)
      [
        [180, 150],
        [230, 150],
        [230, 80],
        [180, 80],
      ].forEach(([x, y]) => pt(x, y));
    col(1, 0, 1);
    col(0, 1, 1);
    out[`patch-${type}`] = page('/P sh', '<< /Shading << /P 5 0 R >> >>', [
      stream(
        `/ShadingType ${type} /ColorSpace /DeviceRGB /BitsPerCoordinate 16 /BitsPerComponent 8 /BitsPerFlag 8 /Decode [0 300 0 220 0 1 0 1 0 1]`,
        w.bytes(),
      ),
    ]);
  }
  // shading patterns as fill, stroke and text fill (pattern matrix; Background ignored by pdf.js: none here)
  out['pattern-shading'] = page(
    '/Pattern cs /P0 scn 20 20 120 180 re f /Pattern CS /P1 SCN 12 w 170 40 m 280 180 l S BT /F1 48 Tf /P0 scn 150 100 Td (Ab) Tj ET',
    '<< /Pattern << /P0 5 0 R /P1 6 0 R >> /Font << /F1 7 0 R >> >>',
    [
      `<< /PatternType 2 /Matrix [1 0 0 1 20 20] /Shading << /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 200 180] /Extend [true true] /Function ${exp('0 0.3 1', '1 0.2 0.2')} >> >>`,
      `<< /PatternType 2 /Shading << /ShadingType 3 /ColorSpace /DeviceRGB /Coords [225 110 0 225 110 90] /Extend [true true] /Function ${exp('1 1 0', '0 0.5 0')} >> >>`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ],
  );
  // tiling: coloured (a checker, rotated by the pattern matrix) and uncoloured (a dot in the scn colour) as fill,
  // stroke and text fill
  const checker = '1 0 0 rg 0 0 10 10 re f 0 0 1 rg 10 10 10 10 re f';
  const dot = '5 0 m 5 2.76 2.76 5 0 5 c -2.76 5 -5 2.76 -5 0 c -5 -2.76 -2.76 -5 0 -5 c 2.76 -5 5 -2.76 5 0 c f';
  out['tiling'] = page(
    '/Pattern cs /T scn 10 10 130 200 re f [/Pattern /DeviceRGB] cs 0 0.6 0 /U scn 150 110 140 100 re f [/Pattern /DeviceRGB] CS 0.8 0 0.8 /U SCN 10 w 160 20 m 280 90 l S BT /F1 60 Tf [/Pattern /DeviceRGB] cs 1 0.5 0 /U scn 160 30 Td (W) Tj ET',
    '<< /Pattern << /T 5 0 R /U 6 0 R >> /Font << /F1 7 0 R >> >>',
    [
      stream(
        '/PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 20 20] /XStep 20 /YStep 20 /Matrix [0.866 0.5 -0.5 0.866 0 0] /Resources << >>',
        Buffer.from(checker),
      ),
      stream(
        '/PatternType 1 /PaintType 2 /TilingType 1 /BBox [-6 -6 6 6] /XStep 8 /YStep 8 /Matrix [1 0 0 1 3 3] /Resources << >>',
        Buffer.from(dot.replace(/5/g, '3').replace(/2\.76/g, '1.66')),
      ),
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ],
  );
  // a report-style chart from our library: gradient bars, a tiling-filled bar, axis and labels
  out['chart'] = await toBytes(
    async (pdf) => {
      const font = await pdf.embedFont(INTER);
      const p = pdf.addPage({ width: 300, height: 220 });
      p.text('Revenue by quarter', { x: 16, y: 14, font, size: 12 });
      const vals = [62, 95, 78, 130, 110];
      vals.forEach((v, i) => {
        const x = 40 + i * 48,
          y = 190 - v;
        const g = p.linearGradient(x, y, x, 190, [
          [0, '#4F46E5'],
          [1, '#A5B4FC'],
        ]);
        p.fill(p.path().rect(x, y, 30, v), { fill: g });
        p.text(`Q${i + 1}`, { x: x + 6, y: 196, font, size: 9 });
      });
      const hatch = p.tilingPattern({ width: 6, height: 6 }, (c) =>
        c.stroke(c.path().moveTo(0, 6).lineTo(6, 0), { stroke: '#F59E0B', width: 1.2 }),
      );
      p.fill(p.path().rect(270, 120, 20, 70), { fill: hatch });
      p.stroke(p.path().moveTo(32, 190).lineTo(292, 190), { stroke: '#111827', width: 1 });
      p.fill(p.path().circle ? p.path().circle(255, 40, 14) : p.path().rect(241, 26, 28, 28), {
        fill: p.radialGradient(250, 35, 2, 255, 40, 14, [
          [0, '#FFFFFF'],
          [1, '#10B981'],
        ]),
      });
    },
    { creationDate: D },
  );
  return out;
}
