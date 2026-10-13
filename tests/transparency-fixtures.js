// PDFs for the transparency tests, hand-built: the 16 blend modes (alone, with ca, inside a group), transparency
// groups (isolated, non-isolated, knockout, /CS, group alpha), soft masks (Luminosity with /BC and /TR, Alpha,
// /None), a page /Group, and a designer-style page (gradient, drop shadow through a soft mask, multiply overlay,
// semi-transparent shapes).
import { rawPdf } from './reader-tools.js';
import { BLEND_MODES } from '../src/render/blend.js';

/** a 300 × 220 page: content, its /Resources, objects from 5 on, extra page-dict entries */
const page = (content, resources, objs = [], extra = '') =>
  rawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 220] /Contents 4 0 R /Resources ${resources} ${extra} >>`,
    [`<< /Length ${content.length} >>`, Buffer.from(content, 'latin1')],
    ...objs,
  ]);
const form = (dict, body) => [
  `<< /Type /XObject /Subtype /Form ${dict} /Length ${body.length} >>`,
  Buffer.from(body, 'latin1'),
];
/** coloured stripes to blend over */
const BACKDROP =
  '1 0.85 0.2 rg 0 0 300 55 re f 0.2 0.7 0.9 rg 0 55 300 55 re f 0.85 0.2 0.5 rg 0 110 300 55 re f 0.3 0.3 0.3 rg 0 165 300 55 re f ';
const AXIAL = (c0, c1, x0 = 0, x1 = 300) =>
  `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [${x0} 0 ${x1} 0] /Extend [true true] /Function << /FunctionType 2 /Domain [0 1] /C0 [${c0}] /C1 [${c1}] /N 1 >> >>`;

export function transparencyPdfs() {
  const out = {};
  const gsAll = (extra = '') => `<< ${BLEND_MODES.map((m, i) => `/B${i} << /BM /${m} ${extra} >>`).join(' ')} >>`;
  // a 4 × 4 grid of squares, one per mode, each half one colour, half another
  const tiles = BLEND_MODES.map((_, i) => {
    const x = 10 + (i % 4) * 72,
      y = 8 + Math.floor(i / 4) * 52;
    return `/B${i} gs 0.2 0.5 0.9 rg ${x} ${y} 30 44 re f 0.95 0.45 0.1 rg ${x + 30} ${y} 30 44 re f`;
  }).join(' ');
  out['blend-modes'] = page(`${BACKDROP} ${tiles}`, `<< /ExtGState ${gsAll()} >>`);
  out['blend-alpha'] = page(`${BACKDROP} ${tiles}`, `<< /ExtGState ${gsAll('/ca 0.6 /CA 0.6')} >>`);
  // the same tiles inside one transparency group: the group composites Normally onto the stripes, its modes blend
  // with what the group drew before them (a light gray card)
  out['blend-in-group'] = page(`${BACKDROP} /G Do`, '<< /XObject << /G 5 0 R >> >>', [
    form(
      `/BBox [0 0 300 220] /Group << /S /Transparency >> /Resources << /ExtGState ${gsAll()} >>`,
      `0.9 0.9 0.85 rg 5 5 290 210 re f 0.1 0.6 0.3 rg 5 100 290 30 re f ${tiles}`,
    ),
  ]);
  // groups: two overlapping squares at group alpha 0.5 (the overlap is not doubled); isolated, non-isolated,
  // knockout, with /CS; and a group blended Multiply as one object
  const pair = '0.9 0.1 0.1 rg 0 0 50 50 re f 0.1 0.3 0.9 rg 25 25 50 50 re f';
  out.groups = page(
    `${BACKDROP} /A gs q 1 0 0 1 10 20 cm /G1 Do Q q 1 0 0 1 110 20 cm /G2 Do Q q 1 0 0 1 210 20 cm /G3 Do Q /N gs q 1 0 0 1 10 120 cm /G4 Do Q /M gs q 1 0 0 1 110 120 cm /G1 Do Q`,
    '<< /ExtGState << /A << /ca 0.5 >> /N << /ca 1 >> /M << /ca 1 /BM /Multiply >> >> /XObject << /G1 5 0 R /G2 6 0 R /G3 7 0 R /G4 8 0 R >> >>',
    [
      form('/BBox [0 0 80 80] /Group << /S /Transparency /I true >>', pair),
      form('/BBox [0 0 80 80] /Group << /S /Transparency /I false >>', pair),
      form('/BBox [0 0 80 80] /Group << /S /Transparency /K true /I true >>', pair),
      form('/BBox [0 0 80 80] /Group << /S /Transparency /CS /DeviceRGB /I true >>', pair),
    ],
  );
  // soft masks: Luminosity from a gradient (default black backdrop), with /BC white outside a small form, with /TR
  // inverting it; Alpha from semi-transparent squares; then /None
  const lumForm = form(
    '/BBox [0 0 300 220] /Group << /S /Transparency /CS /DeviceRGB >> /Resources << /Shading << /S 9 0 R >> >>',
    'q 0 0 300 220 re W n /S sh Q',
  );
  out['smask-luminosity'] = page(
    `${BACKDROP} q /L gs 0.8 0.1 0.1 rg 10 10 280 60 re f Q q /W gs 0.1 0.5 0.1 rg 10 80 280 60 re f Q q /T gs 0.1 0.1 0.8 rg 10 150 280 60 re f Q`,
    '<< /ExtGState << /L << /SMask << /S /Luminosity /G 5 0 R >> >> /W << /SMask << /S /Luminosity /G 6 0 R /BC [1 1 1] >> >> /T << /SMask << /S /Luminosity /G 5 0 R /TR << /FunctionType 2 /Domain [0 1] /C0 [1] /C1 [0] /N 1 >> >> >> >> >>',
    [
      lumForm,
      form(
        '/BBox [100 80 200 140] /Group << /S /Transparency /CS /DeviceRGB >>',
        '0 g 100 80 100 60 re f 0.5 g 150 80 50 60 re f',
      ),
      '<< >>',
      '<< >>',
      AXIAL('1 1 1', '0 0 0', 20, 280),
    ],
  );
  out['smask-alpha'] = page(
    `${BACKDROP} q /A gs 0.1 0.1 0.1 rg 10 10 280 200 re f Q /Z gs 0.9 0.9 0.9 rg 120 90 60 40 re f`,
    '<< /ExtGState << /A << /SMask << /S /Alpha /G 5 0 R >> >> /Z << /SMask /None >> >> >>',
    [
      form(
        '/BBox [0 0 300 220] /Group << /S /Transparency >> /Resources << /ExtGState << /H << /ca 0.4 >> >> >>',
        '0 g 20 20 120 80 re f /H gs 160 20 120 80 re f 20 120 260 80 re f',
      ),
    ],
  );
  out['page-group'] = page(
    `${BACKDROP} /A gs 0.2 0.6 0.2 rg 40 40 200 140 re f`,
    '<< /ExtGState << /A << /ca 0.5 /BM /Screen >> >> >>',
    [],
    '/Group << /S /Transparency /CS /DeviceRGB /I true >>',
  );
  // a designer's card: gradient background, a soft drop shadow (a black rectangle masked by a blurred-edge gradient
  // form), a white card, a multiply overlay band, and semi-transparent circles
  const circle = (x, y, r) => {
    const k = 0.5523 * r;
    return `${x + r} ${y} m ${x + r} ${y + k} ${x + k} ${y + r} ${x} ${y + r} c ${x - k} ${y + r} ${x - r} ${y + k} ${x - r} ${y} c ${x - r} ${y - k} ${x - k} ${y - r} ${x} ${y - r} c ${x + k} ${y - r} ${x + r} ${y - k} ${x + r} ${y} c f`;
  };
  out.designer = page(
    [
      'q 0 0 300 220 re W n /BG sh Q',
      'q /SH gs 0 g 45 35 200 140 re f Q',
      '1 g 40 45 200 140 re f',
      `q /MU gs 0.95 0.6 0.2 rg 40 120 200 30 re f Q`,
      `q /HA gs 0.2 0.4 0.95 rg ${circle(90, 90, 35)} 0.95 0.2 0.4 rg ${circle(130, 90, 35)} Q`,
      `q /SC gs 0.3 0.8 0.5 rg ${circle(250, 50, 30)} Q`,
    ].join(' '),
    '<< /Shading << /BG 5 0 R >> /ExtGState << /SH << /SMask << /S /Alpha /G 6 0 R >> >> /MU << /BM /Multiply >> /HA << /ca 0.55 >> /SC << /BM /Screen /ca 0.8 >> >> >>',
    [
      AXIAL('0.15 0.2 0.45', '0.55 0.3 0.6'),
      // the shadow's alpha: rectangles inset a step at a time, each at 0.12, so its edge fades over 10 units
      form(
        '/BBox [0 0 300 220] /Group << /S /Transparency >> /Resources << /ExtGState << /E << /ca 0.12 >> >> >>',
        `/E gs 0 g ${Array.from({ length: 8 }, (_, k) => `${35 + k * 1.5} ${25 + k * 1.5} ${220 - k * 3} ${160 - k * 3} re f`).join(' ')}`,
      ),
    ],
  );
  return out;
}
