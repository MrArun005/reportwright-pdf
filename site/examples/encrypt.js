// AES-256 encryption with permissions. Open the result with the password "open me".
// Writing encrypted files works in browsers; reading them back (loadPdf with a password) needs Node,
// because WebCrypto has no synchronous AES.
import { toBytes } from '@reportwright/pdf';

const bytes = await toBytes(async (pdf) => {
  const page = pdf.addPage();
  page.text('Salary statement: confidential', { x: 40, y: 40, font: pdf.standardFont('Helvetica'), size: 14 });
  await page.end();
}, {
  title: 'Salary statement',
  encrypt: {
    userPassword: 'open me',                 // asked when the file opens
    ownerPassword: 'full access',            // lifts the permissions
    algorithm: 'aes-256',                    // or 'aes-128' for very old readers
    permissions: { print: true, copy: false, modify: false },
  },
});
log('encrypted:', bytes.length, 'bytes; password: open me');
show(bytes, 'encrypted.pdf');
