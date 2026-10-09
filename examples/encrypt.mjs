// AES-256 password protection with permissions, then reading it back with the password.
//
//   node examples/encrypt.mjs [out.pdf]
import fs from 'node:fs';
import { toBytes, loadPdf } from '../dist/index.js';

const out = process.argv[2] ?? 'encrypted.pdf';
const bytes = await toBytes(async (pdf) => {
  const page = pdf.addPage();
  page.text('Salary statement: confidential', { x: 40, y: 40, font: pdf.standardFont('Helvetica'), size: 14 });
  await page.end();
}, {
  title: 'Salary statement',
  encrypt: {
    userPassword: 'open me',                 // asked when the file opens ('' opens without a prompt)
    ownerPassword: 'full access',            // lifts the permissions; left out: random
    algorithm: 'aes-256',                    // or 'aes-128' for very old readers
    permissions: { print: true, copy: false, modify: false },   // each defaults to true
  },
});
fs.writeFileSync(out, bytes);
const doc = await loadPdf(bytes, { password: 'open me' });
console.log(`wrote ${out}: ${doc.encryption.algorithm}, copy allowed: ${doc.encryption.permissions.copy}; text: ${doc.extractText().trim()}`);
