// Canvas-style vector paths: curves, gradients, clipping, transforms, SVG path data, opacity.
import { toBytes } from '@reportwright/pdf';

const bytes = await toBytes(async (pdf) => {
  const page = pdf.addPage();
  const p = page.path()
    .moveTo(40, 40).lineTo(140, 40)
    .bezierCurveTo(160, 40, 160, 80, 140, 80).quadraticCurveTo(90, 120, 40, 80)
    .closePath();
  page.fillAndStroke(p, { fill: '#cfe2f3', stroke: '#1f4e79', width: 2, join: 'round' });

  page.fill(page.path().roundedRect(40, 140, 200, 60, [12, 12, 0, 0]),
    { fill: page.linearGradient(40, 0, 240, 0, [[0, '#1f4e79'], [0.6, '#5b9bd5'], [1, '#ffffff']]) });

  page.save();                                   // transform, clip and styles until restore()
  page.translate(380, 120).rotate(Math.PI / 6);
  page.clip(page.path().arc(0, 0, 70, 0, 2 * Math.PI));
  page.shade(page.radialGradient(0, 0, 0, 0, 0, 70, [[0, '#fff'], [1, '#c00']]));
  page.restore();

  page.svgPath('M40 260 h 160 a 20 20 0 0 1 0 40 h -160 z', { fill: '#e2efda', stroke: 0, dash: [4, 2] });
  for (let i = 0; i < 5; i++)
    page.fill(page.path().rect(260 + i * 40, 250 + i * 8, 80, 60), { fill: '#c8321a', opacity: 0.25, blendMode: 'Multiply' });
  await page.end();
}, { title: 'Vector graphics' });

show(bytes, 'vector.pdf');
