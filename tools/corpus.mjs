// A cross-renderer corpus for @reportwright/pdf: one small PDF per feature, from every group, made with the public API
// only (src/index.js). Writes <out>/<name>.pdf and <out>/manifest.json (what each file should show: text, page count,
// fields, annotations, password), which tools/cross-render.mjs checks in every engine.
//
//   node packages/pdf/tools/corpus.mjs [outDir]
//
// Fixture inputs come from the repo (public/fonts, tests/fixtures), macOS (ColorSync profiles, STIX), sharp (JPEGs),
// harfbuzzjs (shaping) and openssl (a throwaway signing key); none of them is a dependency of the library.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPdf, cmyk, nodeSigner } from '../src/index.js';
import { harfbuzzShaper } from '../examples/harfbuzz-shaper.mjs';
import { png } from '../../../tests/pdf/image-fixtures.js';

const ROOT = path.join(import.meta.dirname, '../../..');
const OUT = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'rw-xrender-corpus'));
fs.mkdirSync(OUT, { recursive: true });
const DATE = new Date('2026-03-01T10:00:00Z');
const font = (f) => fs.readFileSync(path.join(ROOT, 'public/fonts', f));
const INTER = font('Inter-Regular.ttf'), INTER_B = font('Inter-Bold.ttf');
const ARABIC = font('NotoSansArabic-Regular.ttf'), DEVA = font('NotoSansDevanagari-Regular.ttf');
const SC = fs.readFileSync(path.join(ROOT, 'tests/fixtures/fonts/NotoSansSC-Subset.otf'));
/** the first file that exists, or null (macOS, Debian/Ubuntu fonts-stix and Ghostscript's profiles) */
const first = (...f) => { const hit = f.find((x) => fs.existsSync(x)); return hit ? fs.readFileSync(hit) : null; };
const STIX = first('/System/Library/Fonts/Supplemental/STIXGeneral.otf', '/usr/share/fonts/opentype/stix/STIXGeneral-Regular.otf', '/usr/share/fonts/opentype/stix/STIXGeneral.otf');
const CS = '/System/Library/ColorSync/Profiles/', GS = ['/usr/share/color/icc/ghostscript/', '/opt/homebrew/share/ghostscript/iccprofiles/', '/usr/share/ghostscript/iccprofiles/'];
const ICC_RGB = first(CS + 'Display P3.icc', path.join(ROOT, 'public/icc/sRGB-v2-magic.icc'));
const ICC_CMYK = first(CS + 'Generic CMYK Profile.icc', ...GS.map((d) => d + 'default_cmyk.icc'));
const ICC_GRAY = first(CS + 'Generic Gray Gamma 2.2 Profile.icc', ...GS.map((d) => d + 'default_gray.icc'));
// CORPUS_DRY=1 builds every PDF into a discarding sink (checks the builders, writes nothing).
// ponytail: CORPUS_ONLY=a,b,c builds just those (the local smoke test); default all
const ONLY = process.env.CORPUS_ONLY ? new Set(process.env.CORPUS_ONLY.split(',')) : null;
const sharp = (await import('sharp')).default;
const EN16931 = fs.readFileSync(path.join(ROOT, 'tests/fixtures/facturx/en16931.xml'));
const PASSWORD = 'open sesame';

/** 64 × 32 RGB: red left half, blue right half, a green bar across the bottom quarter */
const RAW = Buffer.from(Array.from({ length: 64 * 32 }, (_, i) => { const x = i % 64, y = (i / 64) | 0; return y >= 24 ? [0, 160, 0] : x < 32 ? [220, 0, 0] : [0, 0, 220]; }).flat());
const jpeg = (fn) => fn(sharp(RAW, { raw: { width: 64, height: 32, channels: 3 } })).toBuffer().then((b) => new Uint8Array(b));

/** @type {{ name: string, group: string, feature: string, text: string[], pages?: number, password?: string, fields?: number, annots?: number, signed?: boolean, options?: any, build: (pdf: any) => any }[]} */
const C = [];
const add = (e) => C.push(e);
const A4 = { width: 595.28, height: 841.89 };
const label = (p, f, s) => p.text(s, { x: 40, y: 20, font: f, size: 10, color: 0.35 });

// ---------- text ----------
add({ name: 'text-standard14', group: 'text', feature: 'all 14 standard fonts, WinAnsi', text: ['Helvetica-Bold sample', 'Courier sample', 'Times-Italic sample', 'Price 12.50 € – “quoted”'], build: (pdf) => {
  const p = pdf.addPage(A4);
  const names = ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique', 'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic', 'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'];
  names.forEach((n, i) => p.text(`${n} sample`, { x: 40, y: 40 + i * 24, font: pdf.standardFont(n), size: 16 }));
  p.text('αβγδ', { x: 40, y: 340, font: pdf.standardFont('Symbol'), size: 16 });
  p.text('✓✔✈', { x: 40, y: 370, font: pdf.standardFont('ZapfDingbats'), size: 16 });
  p.text('Price 12.50 € – “quoted”', { x: 40, y: 400, font: pdf.standardFont('Helvetica'), size: 16 });
} });
add({ name: 'text-truetype', group: 'text', feature: 'embedded TrueType (Inter), subset, Unicode', text: ['Ünïcødé TrueType text', 'Łódź Ελληνικά Кириллица'], build: async (pdf) => {
  const f = await pdf.embedFont(INTER), b = await pdf.embedFont(INTER_B);
  const p = pdf.addPage(A4);
  p.text('Ünïcødé TrueType text', { x: 40, y: 40, font: b, size: 24 });
  p.text('Łódź Ελληνικά Кириллица', { x: 40, y: 80, font: f, size: 20 });
  p.text('Superscript x2 and rise', { x: 40, y: 120, font: f, size: 14 });
  p.text('2', { x: 136, y: 116, font: f, size: 9, rise: 4 });
  p.text('Outlined text', { x: 40, y: 160, font: b, size: 32, renderMode: 'stroke', strokeColor: '#c00000', strokeWidth: 0.8 });
} });
add({ name: 'text-cff', group: 'text', feature: `OpenType/CFF fonts (${STIX ? 'STIX Latin + ' : ''}CID-keyed Noto Sans SC)`, text: [...(STIX ? ['CFF outlines in STIX General'] : []), '中文 我们好 ABC'], build: async (pdf) => {
  const sc = await pdf.embedFont(SC);
  const p = pdf.addPage(A4);
  if (STIX) {
    const s = await pdf.embedFont(STIX);
    p.text('CFF outlines in STIX General', { x: 40, y: 40, font: s, size: 24 });
    p.text('∑ ∫ √ ≤ ≥ ∞', { x: 40, y: 80, font: s, size: 24 });
  }
  p.text('中文 我们好 ABC', { x: 40, y: 120, font: sc, size: 24 });
} });
add({ name: 'text-kerning', group: 'text', feature: 'GPOS kerning on vs off', text: ['AVATAR WAVE Type To', 'AVATAR WAVE Type To'], build: async (pdf) => {
  const f = await pdf.embedFont(INTER);
  const p = pdf.addPage(A4);
  p.text('AVATAR WAVE Type To', { x: 40, y: 40, font: f, size: 36 });
  p.text('AVATAR WAVE Type To', { x: 40, y: 90, font: f, size: 36, kerning: false, color: '#c00000' });
  p.text('Spaced', { x: 40, y: 150, font: f, size: 24, characterSpacing: 4, horizontalScaling: 120 });
} });
add({ name: 'text-shaping', group: 'text', feature: 'HarfBuzz shaping: Arabic (RTL) and Devanagari (conjuncts, matras)', text: ['किताब हिन्दी'], build: async (pdf) => {
  const ar = await pdf.embedFont(ARABIC, { shaper: harfbuzzShaper(ARABIC) });
  const hi = await pdf.embedFont(DEVA, { shaper: harfbuzzShaper(DEVA) });
  const p = pdf.addPage(A4);
  p.text('مرحبا بالعالم', { x: 40, y: 40, font: ar, size: 28, direction: 'rtl' });
  p.text('किताब हिन्दी', { x: 40, y: 100, font: hi, size: 28 });
  p.text('क्षत्रिय श्री', { x: 40, y: 150, font: hi, size: 28 });
} , arabic: 'مرحبا بالعالم' });
const LOREM = 'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump!';
add({ name: 'text-textbox', group: 'text', feature: 'textBox: left, center, right, justify, maxLines ellipsis', text: ['The quick brown fox jumps over the lazy dog.', 'Pack my box with five dozen liquor jugs.'], build: async (pdf) => {
  const f = await pdf.embedFont(INTER), h = pdf.standardFont('Helvetica');
  const p = pdf.addPage(A4);
  ['left', 'center', 'right', 'justify'].forEach((align, i) => {
    p.rect(40, 40 + i * 110, 240, 100, { stroke: 0.7, fill: undefined, width: 0.5 });
    p.textBox(LOREM, { x: 40, y: 40 + i * 110, width: 240, font: f, size: 11, align });
    p.textBox(LOREM, { x: 310, y: 40 + i * 110, width: 240, font: h, size: 11, align });
  });
  p.textBox(LOREM + ' ' + LOREM, { x: 40, y: 500, width: 240, font: f, size: 11, maxLines: 2 });
} });
add({ name: 'text-fallback', group: 'text', feature: 'font fallback: Latin + Devanagari + CJK in one line', text: ['Mixed', 'हिन्दी', '中文'], build: async (pdf) => {
  const f = await pdf.embedFont(INTER), hi = await pdf.embedFont(DEVA, { shaper: harfbuzzShaper(DEVA) }), sc = await pdf.embedFont(SC);
  const p = pdf.addPage(A4);
  p.text('Mixed हिन्दी and 中文 runs', { x: 40, y: 40, font: f, size: 24, fallback: [hi, sc] });
  p.textBox('A wrapped paragraph with हिन्दी words and 中文 characters falling back, justified across the box width.', { x: 40, y: 90, width: 300, font: f, fallback: [hi, sc], size: 14, align: 'justify' });
} });

// ---------- graphics ----------
add({ name: 'gfx-paths', group: 'graphics', feature: 'paths: lines, curves, rounded rects, dashes, caps, joins, even-odd', text: ['Paths'], build: (pdf) => {
  const p = pdf.addPage(A4);
  label(p, pdf.standardFont('Helvetica'), 'Paths');
  p.fillAndStroke(p.path().moveTo(40, 60).lineTo(140, 60).bezierCurveTo(160, 60, 160, 100, 140, 100).quadraticCurveTo(90, 140, 40, 100).closePath(), { fill: '#cfe2f3', stroke: '#1f4e79', width: 3, join: 'round' });
  p.fill(p.path().roundedRect(200, 60, 160, 60, [16, 16, 0, 0]), { fill: '#e2efda' });
  ['butt', 'round', 'square'].forEach((cap, i) => p.stroke(p.path().moveTo(40, 180 + i * 20).lineTo(240, 180 + i * 20), { width: 10, cap, stroke: 0.2 }));
  p.stroke(p.path().moveTo(300, 180).lineTo(500, 180), { width: 2, dash: [8, 4, 2, 4], stroke: '#c00000' });
  const star = p.path(); for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + i * 4 * Math.PI / 5; i ? star.lineTo(140 + 60 * Math.cos(a), 330 + 60 * Math.sin(a)) : star.moveTo(140 + 60 * Math.cos(a), 330 + 60 * Math.sin(a)); } star.closePath();
  p.fill(star, { fill: '#ffc000', rule: 'evenodd' });
  p.fill(p.path().ellipse(360, 330, 80, 40, Math.PI / 8, 0, 2 * Math.PI), { fill: '#7030a0' });
} });
add({ name: 'gfx-clip', group: 'graphics', feature: 'clip paths and text clipping, transforms', text: ['Clip'], build: (pdf) => {
  const p = pdf.addPage(A4), h = pdf.standardFont('Helvetica-Bold');
  label(p, pdf.standardFont('Helvetica'), 'Clip');
  p.save(); p.clip(p.path().arc(150, 150, 80, 0, 2 * Math.PI));
  for (let i = 0; i < 16; i++) p.rect(70 + i * 10, 70, 10, 160, { fill: i % 2 ? '#1f4e79' : '#ffc000' });
  p.restore();
  p.save(); p.text('CLIPPED', { x: 260, y: 100, font: h, size: 56, renderMode: 'clip' });
  p.shade(p.linearGradient(260, 0, 520, 0, [[0, '#c00000'], [1, '#0070c0']])); p.restore();
  p.save(); p.translate(150, 360).rotate(Math.PI / 6).scale(1.5).skew(0.2);
  p.rect(-40, -20, 80, 40, { fill: '#00b050' }); p.restore();
} });
add({ name: 'gfx-gradients', group: 'graphics', feature: 'linear and radial gradients, multi-stop, hard stop, extend', text: ['Gradients'], build: (pdf) => {
  const p = pdf.addPage(A4);
  label(p, pdf.standardFont('Helvetica'), 'Gradients');
  p.fill(p.path().rect(40, 50, 500, 60), { fill: p.linearGradient(40, 0, 540, 0, [[0, '#1f4e79'], [0.5, '#5b9bd5'], [0.5, '#ffc000'], [1, '#ffffff']]) });
  p.fill(p.path().rect(40, 130, 200, 200), { fill: p.radialGradient(140, 230, 0, 140, 230, 100, [[0, '#ffffff'], [1, '#c00000']]) });
  p.fill(p.path().rect(280, 130, 200, 200), { fill: p.radialGradient(330, 180, 10, 380, 230, 120, [[0, '#ffff00'], [1, '#008000']], { extend: [true, true] }) });
  p.fill(p.path().rect(40, 360, 500, 40), { fill: p.linearGradient(40, 0, 540, 0, [[0, cmyk(1, 0, 0, 0)], [1, cmyk(0, 1, 0, 0)]]) });
  p.fill(p.path().rect(40, 420, 500, 40), { fill: p.linearGradient(40, 0, 540, 0, [[0, 0], [1, 1]]) });
} });
add({ name: 'gfx-opacity', group: 'graphics', feature: 'fill/stroke opacity, rect/line opacity, image opacity', text: ['Opacity'], build: async (pdf) => {
  const p = pdf.addPage(A4);
  label(p, pdf.standardFont('Helvetica'), 'Opacity');
  p.rect(40, 50, 200, 200, { fill: '#0070c0' });
  p.fill(p.path().arc(200, 200, 80, 0, 2 * Math.PI), { fill: '#c00000', opacity: 0.5 });
  p.rect(260, 50, 200, 100, { fill: '#00b050', fillOpacity: 0.3, stroke: '#000000', strokeOpacity: 0.6, width: 6 });
  p.line(40, 300, 500, 300, { color: '#7030a0', width: 12, opacity: 0.4 });
  const img = await pdf.embedImage(png({ w: 16, h: 16, type: 2, depth: 8, px: (x, y) => [x * 16, y * 16, 128] }));
  p.image(img, { x: 260, y: 160, width: 100, opacity: 0.5 });
} });
const BLENDS = ['Normal', 'Multiply', 'Screen', 'Overlay', 'Darken', 'Lighten', 'ColorDodge', 'ColorBurn', 'HardLight', 'SoftLight', 'Difference', 'Exclusion', 'Hue', 'Saturation', 'Color', 'Luminosity'];
add({ name: 'gfx-blend', group: 'graphics', feature: 'all 16 blend modes over a gradient', text: ['Multiply', 'Luminosity'], build: (pdf) => {
  const p = pdf.addPage(A4), h = pdf.standardFont('Helvetica');
  BLENDS.forEach((m, i) => {
    const x = 40 + (i % 4) * 130, y = 40 + ((i / 4) | 0) * 130;
    p.fill(p.path().rect(x, y, 110, 90), { fill: p.linearGradient(x, 0, x + 110, 0, [[0, '#ffc000'], [1, '#0070c0']]) });
    p.fill(p.path().arc(x + 55, y + 45, 35, 0, 2 * Math.PI), { fill: '#c00000', blendMode: m });
    p.text(m, { x, y: y + 95, font: h, size: 10 });
  });
} });
add({ name: 'gfx-patterns', group: 'graphics', feature: 'tiling patterns, nested, as fill and stroke', text: ['Patterns'], build: (pdf) => {
  const p = pdf.addPage(A4);
  label(p, pdf.standardFont('Helvetica'), 'Patterns');
  const dots = p.tilingPattern({ width: 10, height: 10, spacing: 4 }, (c) => c.fill(c.path().arc(5, 5, 4, 0, 2 * Math.PI), { fill: '#c00000' }));
  const checks = p.tilingPattern({ width: 20, height: 20 }, (c) => { c.fill(c.path().rect(0, 0, 10, 10), { fill: '#1f4e79' }); c.fill(c.path().rect(10, 10, 10, 10), { fill: c.linearGradient(10, 0, 20, 0, [[0, '#ffc000'], [1, '#00b050']]) }); });
  p.fill(p.path().rect(40, 50, 220, 160), { fill: dots });
  p.fill(p.path().arc(400, 130, 80, 0, 2 * Math.PI), { fill: checks });
  p.stroke(p.path().rect(40, 260, 480, 80), { stroke: checks, width: 16 });
} });
add({ name: 'gfx-svg-arcs', group: 'graphics', feature: 'SVG path data: arcs (large/sweep flags), relative commands, smooth curves', text: ['SVG'], build: (pdf) => {
  const p = pdf.addPage(A4);
  label(p, pdf.standardFont('Helvetica'), 'SVG');
  p.svgPath('M40 100 h 80 a 20 20 0 0 1 0 40 h -80 z', { fill: '#e2efda', stroke: 0, dash: [4, 2] });
  [[0, 0], [0, 1], [1, 0], [1, 1]].forEach(([l, s], i) => p.svgPath(`M${200 + i * 90} 120 a 40 25 -30 ${l} ${s} 50 -25`, { stroke: ['#c00000', '#00b050', '#0070c0', '#7030a0'][i], width: 3 }));
  p.svgPath('M40 250 C 80 180, 140 180, 180 250 S 280 320, 320 250 Q 360 200 400 250 T 480 250', { stroke: '#1f4e79', width: 3 });
  p.svgPath('M40 400 l 30 -60 l 30 60 z m 80 0 l 30 -60 l 30 60 z', { fill: '#ffc000', stroke: '#000', width: 1 });
} });

// ---------- colour ----------
add({ name: 'colour-cmyk', group: 'colour', feature: 'DeviceCMYK fills, text and strokes', text: ['CMYK cyan', 'Rich black'], build: (pdf) => {
  const p = pdf.addPage(A4), h = pdf.standardFont('Helvetica-Bold');
  [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1], [0.6, 0.4, 0.4, 1]].forEach((c, i) => p.rect(40 + i * 100, 50, 90, 90, { fill: cmyk(...c) }));
  p.text('CMYK cyan', { x: 40, y: 160, font: h, size: 20, color: cmyk(1, 0, 0, 0) });
  p.text('Rich black', { x: 40, y: 190, font: h, size: 20, color: [0.6, 0.4, 0.4, 1] });
  p.line(40, 230, 500, 230, { color: cmyk(0, 0.5, 1, 0), width: 4 });
} });
add({ name: 'colour-spot', group: 'colour', feature: 'Separation (spot) colours with CMYK and RGB alternates, tints, spot gradient', text: ['PANTONE 185 C'], build: (pdf) => {
  const p = pdf.addPage(A4), h = pdf.standardFont('Helvetica');
  const red = pdf.spotColor('PANTONE 185 C', cmyk(0, 0.91, 0.76, 0)), gold = pdf.spotColor('Gold Foil', '#c9a227');
  [1, 0.75, 0.5, 0.25, 0.1].forEach((t, i) => p.rect(40 + i * 100, 50, 90, 60, { fill: red.tint(t) }));
  p.rect(40, 130, 200, 60, { fill: gold });
  p.fill(p.path().rect(40, 210, 490, 40), { fill: p.linearGradient(40, 0, 530, 0, [[0, red.tint(0)], [1, red]]) });
  p.text('PANTONE 185 C', { x: 40, y: 270, font: h, size: 20, color: red });
} });
add({ name: 'colour-icc', group: 'colour', feature: 'ICCBased colour: an RGB, a CMYK and a gray profile (macOS ColorSync or Ghostscript)', text: ['ICC red'], build: async (pdf) => {
  const p = pdf.addPage(A4), h = pdf.standardFont('Helvetica');
  const rgb = await pdf.iccColorSpace(ICC_RGB);
  p.rect(40, 50, 120, 80, { fill: rgb.color(1, 0, 0) });
  if (ICC_CMYK) p.rect(180, 50, 120, 80, { fill: (await pdf.iccColorSpace(ICC_CMYK)).color(0, 1, 1, 0) });
  if (ICC_GRAY) p.rect(320, 50, 120, 80, { fill: (await pdf.iccColorSpace(ICC_GRAY)).color(0.5) });
  p.text('ICC red', { x: 40, y: 150, font: h, size: 16, color: rgb.color(1, 0, 0) });
} });

// ---------- images ----------
const PNGS = [
  ['gray 1-bit', { type: 0, depth: 1, px: (x, y) => [(x + y) % 2] }],
  ['gray 4-bit', { type: 0, depth: 4, px: (x) => [x] }],
  ['gray 16-bit', { type: 0, depth: 16, px: (x) => [x * 4096] }],
  ['RGB 8-bit', { type: 2, depth: 8, px: (x, y) => [x * 16, y * 16, 128] }],
  ['RGB 16-bit', { type: 2, depth: 16, px: (x, y) => [x * 4096, y * 4096, 32768] }],
  ['palette 2-bit', { type: 3, depth: 2, px: (x) => [x % 4], palette: [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]] }],
  ['palette + tRNS', { type: 3, depth: 8, px: (x, y) => [(x + y) % 3], palette: [[255, 0, 0], [0, 128, 0], [0, 0, 255]], trns: [255, 128, 0] }],
  ['gray + alpha', { type: 4, depth: 8, px: (x, y) => [x * 16, y * 16] }],
  ['RGBA 8-bit', { type: 6, depth: 8, px: (x, y) => [x * 16, 64, y * 16, 40 + x * 12] }],
  ['RGBA 16-bit', { type: 6, depth: 16, px: (x, y) => [x * 4096, 16384, y * 4096, 8192 + x * 3000] }],
  ['RGB colour key', { type: 2, depth: 8, px: (x, y) => ((x + y) % 4 ? [0, 112, 192] : [255, 255, 255]), trns: [0, 255, 0, 255, 0, 255] }],
  ['Adam7 RGB', { type: 2, depth: 8, interlace: 1, px: (x, y) => [255 - x * 16, y * 16, 64] }],
];
add({ name: 'images-png', group: 'images', feature: `PNG: ${PNGS.map(([n]) => n).join(', ')}`, text: ['RGBA 8-bit', 'Adam7 RGB'], build: async (pdf) => {
  const p = pdf.addPage(A4), h = pdf.standardFont('Helvetica');
  // a checkerboard behind, so transparency shows
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
    const x = 40 + i * 130, y = 40 + j * 150;
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) if ((a + b) % 2) p.rect(x + a * 25, y + b * 25, 25, 25, { fill: 0.8 });
  }
  for (const [k, [n, o]] of PNGS.entries()) {
    const x = 40 + (k % 4) * 130, y = 40 + ((k / 4) | 0) * 150;
    p.image(await pdf.embedImage(png({ w: 16, h: 16, ...o })), { x, y, width: 100 });
    p.text(n, { x, y: y + 106, font: h, size: 10 });
  }
} });
add({ name: 'images-jpeg', group: 'images', feature: 'JPEG: baseline RGB, progressive, gray, CMYK (Adobe inverted), EXIF orientation 6', text: ['baseline', 'progressive', 'CMYK', 'EXIF 6'], build: async (pdf) => {
  const p = pdf.addPage(A4), h = pdf.standardFont('Helvetica');
  const items = [
    ['baseline', await jpeg((s) => s.jpeg({ quality: 92 }))],
    ['progressive', await jpeg((s) => s.jpeg({ quality: 92, progressive: true }))],
    ['gray', await jpeg((s) => s.toColourspace('b-w').jpeg())],
    ['CMYK', await jpeg((s) => s.toColourspace('cmyk').jpeg({ quality: 92 }))],
    ['EXIF 6', await jpeg((s) => s.jpeg().withMetadata({ orientation: 6 }))],
  ];
  for (const [k, [n, b]] of items.entries()) {
    const x = 40 + (k % 3) * 170, y = 40 + ((k / 3) | 0) * 180;
    p.image(await pdf.embedImage(b), { x, y, width: k === 4 ? 70 : 140 });
    p.text(n, { x, y: y + 150, font: h, size: 11 });
  }
  const one = await pdf.embedImage(items[0][1]);
  p.image(one, { x: 40, y: 420, width: 120, height: 120, fit: 'contain' });
  p.image(one, { x: 200, y: 420, width: 120, height: 120, fit: 'cover' });
} });

// ---------- nav ----------
add({ name: 'nav-outline', group: 'nav', feature: 'outlines (nested, styled), named destinations, links of every target, page labels, viewer prefs', pages: 6, text: ['Chapter 1', 'Appendix A'], build: (pdf) => {
  const h = pdf.standardFont('Helvetica');
  const titles = ['Cover', 'Contents', 'Chapter 1', 'Chapter 2', 'Chapter 3', 'Appendix A'];
  const pages = titles.map((t) => { const p = pdf.addPage(A4); p.text(t, { x: 40, y: 40, font: h, size: 28 }); return p; });
  pdf.destination('appendix', 6, { top: 0 });
  const c = pages[1];
  c.text('Go to the appendix', { x: 40, y: 100, font: h, size: 14, color: '#0645ad' }); c.link(40, 100, 140, 16, { dest: 'appendix' }, { border: { width: 1, color: '#0645ad' } });
  c.text('Chapter 2 (FitH)', { x: 40, y: 130, font: h, size: 14 }); c.link(40, 130, 140, 16, { page: 4, fit: 'FitH', top: 0 });
  c.text('https://example.com', { x: 40, y: 160, font: h, size: 14 }); c.link(40, 160, 140, 16, { url: 'https://example.com/report' }, { border: { width: 1, style: 'dashed', dash: [3, 2], color: '#0645ad' } });
  c.text('Next page', { x: 40, y: 190, font: h, size: 14 }); c.link(40, 190, 140, 16, { named: 'NextPage' }, { highlight: 'push' });
  pdf.outline([{ title: 'Cover', page: 1 }, { title: 'Chapters', page: 3, bold: true, color: '#1f4e79' }, { title: 'Chapter 1', page: 3, level: 1 }, { title: 'Chapter 2', page: 4, level: 1, italic: true }, { title: 'Chapter 3', page: 5, level: 1 }, { title: 'Appendix', dest: 'appendix', open: false }]);
  pdf.pageLabels([{ start: 0, style: 'r' }, { start: 2, style: 'D' }, { start: 5, style: 'A', prefix: 'Appendix ' }]);
  pdf.viewer({ pageMode: 'UseOutlines', displayDocTitle: true, pageLayout: 'OneColumn' });
}, options: { title: 'Navigation sample' } });

// ---------- annotations ----------
add({ name: 'annots-all', group: 'annotations', feature: 'note, reply, highlight, underline, strikeOut, squiggly, freeText, Square, Circle, Line, Polygon, PolyLine, Ink, stamps, attachFile, link', annots: 18, text: ['Highlighted text here', 'Struck text'], build: async (pdf) => {
  const p = pdf.addPage(A4), h = pdf.standardFont('Helvetica'), f = await pdf.embedFont(INTER);
  p.text('Highlighted text here', { x: 40, y: 60, font: h, size: 14 }); p.highlight({ x: 38, y: 58, width: 150, height: 18 }, { contents: 'Key result', color: '#ffff00' });
  p.text('Underlined text', { x: 40, y: 90, font: h, size: 14 }); p.underline({ x: 38, y: 88, width: 110, height: 18 }, { color: '#0070c0' });
  p.text('Struck text', { x: 40, y: 120, font: h, size: 14 }); p.strikeOut({ x: 38, y: 118, width: 80, height: 18 }, { color: '#c00000' });
  p.text('Squiggly text', { x: 40, y: 150, font: h, size: 14 }); p.squiggly({ x: 38, y: 148, width: 95, height: 18 }, { color: '#00b050' });
  const n = p.note(500, 60, { contents: 'Check this figure', author: 'Ada', icon: 'Comment' });
  p.note(530, 60, { contents: 'Done', author: 'Bo', replyTo: n, icon: 'Key' });
  p.freeText('Sign here please', { x: 300, y: 100, width: 140, height: 36, font: f, size: 12, background: '#fff8c4', border: { width: 1 } });
  p.markup('Square', { x: 40, y: 200, width: 100, height: 60 }, { color: '#c00000', interior: '#ffe0e0', lineWidth: 2 });
  p.markup('Circle', { x: 160, y: 200, width: 100, height: 60 }, { color: '#0070c0', dash: [4, 2] });
  p.markup('Line', { x1: 280, y1: 200, x2: 440, y2: 260 }, { lineEndings: ['Circle', 'ClosedArrow'], color: '#7030a0', lineWidth: 2 });
  p.markup('Polygon', [[40, 300], [120, 280], [140, 360], [60, 380]], { color: '#00b050', interior: '#e2efda' });
  p.markup('PolyLine', [[180, 300], [220, 360], [260, 300], [300, 360]], { color: '#ffc000', lineWidth: 3 });
  p.markup('Ink', [[[340, 300], [360, 340], [380, 300], [400, 340]], [[340, 360], [420, 360]]], { color: '#000000', lineWidth: 2 });
  p.stamp({ x: 40, y: 420, width: 160, height: 44, name: 'Approved', font: f });
  p.stamp({ x: 220, y: 420, width: 160, height: 44, name: 'Draft', font: f });
  p.stamp({ x: 400, y: 420, width: 140, height: 44, draw: (ap) => ap.rect(0, 0, 140, 44, { fill: '#e2efda', stroke: '#00b050', width: 2 }) });
  p.attachFile(new TextEncoder().encode('item,qty\npen,2\n'), { x: 560, y: 120, name: 'figures.csv', mimeType: 'text/csv', description: 'The data' });
  p.text('Link to example.com', { x: 40, y: 500, font: h, size: 14, color: '#0645ad' }); p.link(40, 500, 140, 16, { url: 'https://example.com' });
} });

// ---------- forms ----------
const formBody = async (pdf) => {
  const f = await pdf.embedFont(INTER, { subset: false });
  const page = pdf.addPage(A4), fm = pdf.form, h = pdf.standardFont('Helvetica');
  page.text('Form fields', { x: 40, y: 15, font: h, size: 12 });
  fm.textField('name', { page, x: 40, y: 40, width: 200, height: 22, font: f, value: 'Ada Lovelace', tooltip: 'Full name', required: true });
  const address = fm.group('address');
  address.textField('city', { page, x: 40, y: 80, width: 200, height: 22, font: f, value: 'Paris', tooltip: 'City' });
  fm.textField('pin', { page, x: 40, y: 120, width: 80, height: 22, font: f, comb: true, maxLen: 4, value: '1234', tooltip: 'PIN' });
  fm.textField('notes', { page, x: 260, y: 40, width: 220, height: 60, font: f, multiline: true, value: 'Line one\nLine two', tooltip: 'Notes' });
  fm.textField('secret', { page, x: 260, y: 120, width: 120, height: 22, font: f, password: true, tooltip: 'Password' });
  fm.checkbox('agree', { page, x: 40, y: 160, width: 14, height: 14, checked: true, value: 'Agreed', style: 'check', tooltip: 'I agree' });
  fm.checkbox('star', { page, x: 70, y: 160, width: 14, height: 14, checked: true, style: 'star', tooltip: 'Star' });
  fm.radioGroup('size', { value: 'M', tooltip: 'Size', buttons: ['S', 'M', 'L'].map((v, i) => ({ page, x: 40 + i * 30, y: 190, width: 14, height: 14, value: v })) });
  fm.comboBox('country', { page, x: 40, y: 220, width: 150, height: 22, font: f, options: [['FR', 'France'], ['DE', 'Germany']], value: 'DE', tooltip: 'Country' });
  fm.listBox('langs', { page, x: 40, y: 250, width: 150, height: 60, font: f, options: ['English', 'French', 'German'], value: ['French'], multiSelect: true, tooltip: 'Languages' });
  fm.button('clear', { page, x: 40, y: 320, width: 80, height: 24, font: f, label: 'Clear', action: { reset: true }, tooltip: 'Clear the form' });
  fm.signature('sig', { page, x: 40, y: 360, width: 200, height: 40, tooltip: 'Sign here' });
};
add({ name: 'forms-all', group: 'forms', feature: 'text, multiline, comb, password, checkbox, radio, combo, list (multi), push button, signature, group', fields: 12, text: ['Form fields'], formValues: { name: 'Ada Lovelace', 'address.city': 'Paris', pin: '1234', country: 'DE' }, build: formBody });
add({ name: 'forms-flattened', group: 'forms', feature: 'the same form flattened into page content', options: { form: { flatten: true } }, fields: 0, text: ['Form fields', 'Ada Lovelace', 'Paris', 'Germany'], build: formBody }); // the comb PIN is one glyph a cell: extractors space or reorder it

// ---------- encryption ----------
const secretBody = async (pdf) => { const p = pdf.addPage(A4); p.text('Encrypted content is readable with the password', { x: 40, y: 40, font: await pdf.embedFont(INTER), size: 16 }); pdf.outline({ title: 'Secret bookmark', page: 1 }); };
add({ name: 'encrypt-aes128', group: 'encryption', feature: `AES-128 (V4/R4), user password "${PASSWORD}", print+fill only`, password: PASSWORD, text: ['Encrypted content is readable with the password'], options: { encrypt: { userPassword: PASSWORD, ownerPassword: 'owner-128', algorithm: 'aes-128', permissions: { modify: false, copy: false, assemble: false } } }, build: secretBody });
add({ name: 'encrypt-aes256', group: 'encryption', feature: `AES-256 (V5/R6), user password "${PASSWORD}"`, password: PASSWORD, text: ['Encrypted content is readable with the password'], options: { encrypt: { userPassword: PASSWORD, ownerPassword: 'owner-256', permissions: { copy: false, printHighQuality: false } } }, build: secretBody });
add({ name: 'encrypt-aes256-nouser', group: 'encryption', feature: 'AES-256, empty user password (opens without a prompt; permissions apply)', text: ['Encrypted content is readable with the password'], options: { encrypt: { ownerPassword: 'owner-256', permissions: { modify: false } } }, build: secretBody });

// ---------- signatures ----------
const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-xr-key-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'k.key', '-out', 'k.crt', '-days', '30', '-subj', '/CN=Throwaway Test Signer'], { cwd: keyDir, stdio: 'ignore' });
const KEY = { key: fs.readFileSync(path.join(keyDir, 'k.key')), certs: fs.readFileSync(path.join(keyDir, 'k.crt'), 'utf8') };
fs.copyFileSync(path.join(keyDir, 'k.crt'), path.join(OUT, 'signer.crt'));
fs.rmSync(keyDir, { recursive: true });
const signedBody = (so = {}) => async (pdf) => {
  const p = pdf.addPage(A4);
  p.text('Signed document', { x: 40, y: 40, font: await pdf.embedFont(INTER), size: 20 });
  const field = pdf.form.signature('approval', { page: p, x: 40, y: 100, width: 200, height: 40, tooltip: 'Approval' });
  await pdf.sign(field, { signer: nodeSigner(KEY), reason: 'Approved', location: 'Paris', name: 'Throwaway Test Signer', ...so });
};
add({ name: 'sign-pades', group: 'signatures', feature: 'PAdES B-B (ETSI.CAdES.detached), RSA-2048 SHA-256, self-signed', signed: true, fields: 1, text: ['Signed document'], options: { sign: true }, build: signedBody() });
add({ name: 'sign-certify-encrypted', group: 'signatures', feature: 'certifying (DocMDP 2) signature on an AES-256 file', signed: true, fields: 1, password: PASSWORD, text: ['Signed document'], options: { sign: true, encrypt: { userPassword: PASSWORD, ownerPassword: 'owner' } }, build: signedBody({ certify: 2 }) });

// ---------- standards ----------
const stdBody = (part) => async (pdf) => {
  const f = await pdf.embedFont(INTER);
  const p = pdf.addPage(A4);
  p.text(`PDF/A-${part} sample`, { x: 40, y: 40, font: f, size: 24 });
  p.textBox(LOREM, { x: 40, y: 90, width: 400, font: f, size: 12 });
  p.image(await pdf.embedImage(png({ w: 16, h: 16, type: 2, depth: 8, px: (x, y) => [x * 16, y * 16, 128] })), { x: 40, y: 160, width: 80 });
  p.fill(p.path().rect(140, 160, 200, 80), { fill: p.linearGradient(140, 0, 340, 0, [[0, '#1f4e79'], [1, '#ffffff']]) });
  if (part > 1) p.rect(200, 200, 100, 60, { fill: '#c00000', opacity: 0.5 });
  pdf.outline({ title: `PDF/A-${part}`, page: 1 });
};
add({ name: 'pdfa-1b', group: 'standards', feature: 'PDF/A-1b (PDF 1.4, classic xref)', text: ['PDF/A-1 sample', 'The quick brown fox'], options: { title: 'PDF/A-1b', pdfa: { part: 1, conformance: 'b' } }, build: stdBody(1) });
add({ name: 'pdfa-2b', group: 'standards', feature: 'PDF/A-2b with transparency', text: ['PDF/A-2 sample'], options: { title: 'PDF/A-2b', pdfa: { part: 2, conformance: 'b' } }, build: stdBody(2) });
add({ name: 'pdfa-3b-facturx', group: 'standards', feature: 'PDF/A-3b + Factur-X EN 16931 + a CSV attachment', text: ['PDF/A-3 sample'], attachments: 2, options: { title: 'Invoice', pdfa: { part: 3, conformance: 'b' } }, build: async (pdf) => {
  await stdBody(3)(pdf);
  await pdf.facturX(EN16931, { profile: 'EN 16931' });
  await pdf.attach(new TextEncoder().encode('item,qty\npen,2\n'), { name: 'lines.csv', mimeType: 'text/csv', relationship: 'Data', description: 'Invoice lines' });
} });
const uaBody = async (pdf) => {
  const font = await pdf.embedFont(INTER), b = await pdf.embedFont(INTER_B);
  const page = pdf.addPage(A4);
  const t = (s, x, y, o = {}) => page.text(s, { x, y, font, size: 12, ...o });
  page.artifact({ type: 'Pagination', subtype: 'Header' }, () => t('Quarterly report header', 40, 15, { size: 8, color: 0.4 }));
  page.tag('H1', () => t('Quarterly sales', 40, 40, { size: 22, font: b }));
  page.tag('P', () => t('Sales grew in every region this quarter.', 40, 80));
  page.tag('Table', () => {
    page.tag('THead', () => page.tag('TR', () => ['Region', 'Q1', 'Q2'].forEach((s, i) => page.tag('TH', () => t(s, 40 + i * 120, 120, { font: b }), { scope: 'Column', id: `h${i}` }))));
    page.tag('TBody', () => [['North', '1,204', '1,350'], ['South', '980', '1,105']].forEach((row, r) => page.tag('TR', () => row.forEach((v, i) => page.tag('TD', () => t(v, 40 + i * 120, 140 + r * 20), { headers: [`h${i}`] })))));
  });
  page.tag('L', () => ['First item', 'Second item'].forEach((s, i) => page.tag('LI', () => { page.tag('Lbl', () => t(`${i + 1}.`, 40, 200 + i * 18)); page.tag('LBody', () => t(s, 60, 200 + i * 18)); })), { listNumbering: 'Decimal' });
  page.figure({ alt: 'A blue bar chart' }, () => page.fill(page.path().rect(40, 250, 120, 30), { fill: '#5b9bd5' }));
  page.tag('P', () => { t('See ', 40, 300); page.tag('Link', () => { t('example.com', 66, 300, { color: '#0645ad' }); page.link(66, 300, 80, 14, { url: 'https://example.com' }, { alt: 'example.com' }); }); });
};
const UA_TEXT = ['Quarterly sales', 'Region', 'North', '1,204', 'First item'];
add({ name: 'pdfua-tagged', group: 'standards', feature: 'PDF/UA-1 tagged: headings, paragraph, table with headers, list, figure, link, artifact header', text: UA_TEXT, options: { title: 'Quarterly sales', tagged: { lang: 'en-GB' } }, build: uaBody });
// the other levels the tests make: u (every glyph maps to Unicode), a (u, tagged; with PDF/UA-1 too)
for (const part of [2, 3]) {
  add({ name: `pdfa-${part}u`, group: 'standards', feature: `PDF/A-${part}u`, text: [`PDF/A-${part} sample`], options: { title: `PDF/A-${part}u`, pdfa: { part, conformance: 'u' } }, build: stdBody(part) });
  add({ name: `pdfa-${part}a`, group: 'standards', feature: `PDF/A-${part}a and PDF/UA-1, tagged`, text: UA_TEXT, options: { title: 'Quarterly sales', pdfa: { part, conformance: 'a' }, tagged: { lang: 'en-GB' } }, build: uaBody });
}
add({ name: 'layers', group: 'standards', feature: 'optional content: visible, hidden, locked, print-only, screen-only, nested', text: ['Always visible'], hiddenText: ['Hidden layer text', 'Print-only text'], build: (pdf) => {
  const p = pdf.addPage(A4), h = pdf.standardFont('Helvetica');
  const on = pdf.layer('Visible layer'), off = pdf.layer('Hidden layer', { visible: false }), locked = pdf.layer('Locked layer', { locked: true });
  const printOnly = pdf.layer('Print only', { visible: false, printable: true }), screenOnly = pdf.layer('Screen only', { visible: true, printable: false });
  p.text('Always visible', { x: 40, y: 40, font: h, size: 16 });
  p.layer(on, () => { p.text('Visible layer text', { x: 40, y: 80, font: h, size: 16 }); p.layer(locked, () => p.rect(300, 80, 100, 20, { fill: '#00b050' })); });
  p.layer(off, () => { p.text('Hidden layer text', { x: 40, y: 120, font: h, size: 16 }); p.rect(300, 120, 100, 20, { fill: '#c00000' }); });
  p.layer(printOnly, () => p.text('Print-only text', { x: 40, y: 160, font: h, size: 16 }));
  p.layer(screenOnly, () => p.text('Screen-only text', { x: 40, y: 200, font: h, size: 16 }));
} });
add({ name: 'page-boxes', group: 'standards', feature: 'MediaBox/CropBox/BleedBox/TrimBox/ArtBox + userUnit', pages: 2, text: ['Boxes', 'Trim'], build: (pdf) => {
  const h = pdf.standardFont('Helvetica');
  const p = pdf.addPage({ ...A4, cropBox: [10, 10, 575.28, 821.89], bleedBox: [20, 20, 555.28, 801.89], trimBox: [29, 29, 537.28, 783.89], artBox: [60, 60, 475.28, 721.89] });
  p.rect(0, 0, 595.28, 841.89, { fill: '#ffe0e0' });
  p.rect(20, 20, 555.28, 801.89, { fill: '#e0f0ff' });
  p.rect(29, 29, 537.28, 783.89, { fill: '#ffffff', stroke: '#000', width: 0.5 });
  p.text('Boxes: red = outside crop, blue = bleed, white = Trim', { x: 60, y: 60, font: h, size: 14 });
  const q = pdf.addPage({ width: 300, height: 200, userUnit: 2 });
  q.text('userUnit 2: shows as 600 x 400 pt', { x: 20, y: 20, font: h, size: 12 });
} });
add({ name: 'page-rotation', group: 'standards', feature: 'pages rotated 0, 90, 180, 270 (drawn in the unrotated space)', pages: 4, text: ['Rotate 0', 'Rotate 90', 'Rotate 180', 'Rotate 270'], build: (pdf) => {
  const h = pdf.standardFont('Helvetica-Bold');
  for (const r of [0, 90, 180, 270]) {
    const p = pdf.addPage({ width: 400, height: 300, rotate: r });
    p.text(`Rotate ${r}`, { x: 20, y: 20, font: h, size: 28 });
    p.rect(20, 80, 60, 40, { fill: '#c00000' });
    p.line(0, 0, 400, 300, { color: 0.6 });
  }
} });

// ---------- streaming / scale ----------
add({ name: 'multipage-50', group: 'core', feature: '50 pages, shared font and image, compression and object streams', pages: 50, text: ['Page 1 of 50', 'Page 50 of 50'], build: async (pdf) => {
  const f = await pdf.embedFont(INTER), img = await pdf.embedImage(png({ w: 8, h: 8, type: 2, depth: 8, px: (x) => [x * 32, 0, 255 - x * 32] }));
  for (let i = 1; i <= 50; i++) { const p = pdf.addPage(A4); p.text(`Page ${i} of 50`, { x: 40, y: 40, font: f, size: 18 }); p.image(img, { x: 40, y: 80, width: 40 }); await p.end(); }
} });
add({ name: 'uncompressed', group: 'core', feature: 'compress: false (plain content streams, classic objects)', text: ['Uncompressed'], options: { compress: false }, build: (pdf) => { const p = pdf.addPage(A4); p.text('Uncompressed', { x: 40, y: 40, font: pdf.standardFont('Helvetica'), size: 20 }); p.rect(40, 80, 100, 50, { fill: '#0070c0' }); } });

// ---------- write ----------
const manifest = [];
for (const e of C) {
  if (ONLY && !ONLY.has(e.name)) continue;
  const file = path.join(OUT, `${e.name}.pdf`);
  const pdf = createPdf(process.env.CORPUS_DRY ? { write() {} } : fs.createWriteStream(file), { creationDate: DATE, title: e.feature.slice(0, 60), ...e.options });
  await e.build(pdf);
  const r = await pdf.end();
  const { build, options, ...rest } = e;
  manifest.push({ ...rest, file: `${e.name}.pdf`, pages: e.pages ?? r.pages, warnings: r.warnings });
  console.log(`${e.name}.pdf  ${r.pages}p  ${r.bytes} B${r.warnings.length ? `  warnings: ${r.warnings.join(' | ')}` : ''}`);
}
if (!process.env.CORPUS_DRY) fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`${manifest.length} PDFs in ${OUT}`);
