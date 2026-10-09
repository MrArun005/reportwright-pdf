// Many files at once: extract text and encrypt in worker threads; a broken file fails alone.
//
//   node examples/bulk.mjs [outDir]   writes locked-1.pdf … locked-N.pdf
import fs from 'node:fs';
import path from 'node:path';
import { toBytes, bulk } from '../dist/index.js';

const dir = process.argv[2] ?? '.';
const make = (label) => toBytes(async (pdf) => {
  const p = pdf.addPage(); p.text(`${label}: total due 1,250.00`, { x: 40, y: 40, font: pdf.standardFont('Helvetica'), size: 14 }); await p.end();
});
const files = [await make('Invoice 1'), new Uint8Array([0x25, 0x50]), await make('Invoice 3')]; // the second is not a PDF

const texts = await bulk(files, 'extractText', { workers: 2 });
texts.forEach((r, i) => console.log(i + 1, r.ok ? r.value : `failed: ${r.error.code} ${r.error.message}`));

const locked = await bulk(files, 'encrypt', { workers: 2, encrypt: { userPassword: 'open me', ownerPassword: 'full access' } });
locked.forEach((r, i) => { if (r.ok) fs.writeFileSync(path.join(dir, `locked-${i + 1}.pdf`), r.value); });
console.log(`encrypted ${locked.filter((r) => r.ok).length} of ${files.length}`);
