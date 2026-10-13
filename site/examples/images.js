// JPEG and PNG images. A PNG's alpha channel becomes a soft mask. The images are drawn on a canvas here so the
// example needs no files; in real code pass the bytes of any .png or .jpg.
import { toBytes } from '@reportwright/pdf';

async function canvasImage(type, transparent) {
  const c = document.createElement('canvas'); c.width = c.height = 240;
  const g = c.getContext('2d');
  if (!transparent) { const grad = g.createLinearGradient(0, 0, 240, 240); grad.addColorStop(0, '#1f4e79'); grad.addColorStop(1, '#f2c14e'); g.fillStyle = grad; g.fillRect(0, 0, 240, 240); }
  g.fillStyle = transparent ? '#c8321a' : '#ffffff';
  g.beginPath(); g.arc(120, 120, 80, 0, Math.PI * 2); g.fill();
  const blob = await new Promise((resolve) => c.toBlob(resolve, type, 0.9));
  return new Uint8Array(await blob.arrayBuffer());
}
const jpeg = await canvasImage('image/jpeg', false), png = await canvasImage('image/png', true);

const bytes = await toBytes(async (pdf) => {
  const font = pdf.standardFont('Helvetica');
  const photo = await pdf.embedImage(jpeg), logo = await pdf.embedImage(png);
  const page = pdf.addPage();
  page.image(photo, { x: 56, y: 56, width: 200 });
  page.text('JPEG, ' + jpeg.length + ' bytes', { x: 56, y: 266, font });
  page.fill(page.path().rect(300, 56, 200, 200), { fill: '#e6e6e6' });   // shows the PNG's transparency
  page.image(logo, { x: 300, y: 56, width: 200 });
  page.text('PNG with alpha (soft mask)', { x: 300, y: 266, font });
  await page.end();
}, { title: 'Images' });

show(bytes, 'images.pdf');
