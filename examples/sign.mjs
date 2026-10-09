// PAdES B-B signature while the PDF streams out, then a second signature appended with saveIncremental.
//
//   openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=Example Signer"
//   node examples/sign.mjs key.pem cert.pem [out.pdf]
// For a real signature use a certificate from a CA your readers trust, and a timestamp (RFC 3161) for PAdES B-T.
import fs from 'node:fs';
import { createPdf, loadPdf, nodeSigner } from '../dist/index.js';

const [keyFile, certFile, out = 'signed.pdf'] = process.argv.slice(2);
if (!certFile) { console.error('node examples/sign.mjs key.pem cert.pem [out.pdf]'); process.exit(2); }
const signer = nodeSigner({ key: fs.readFileSync(keyFile, 'utf8'), certs: fs.readFileSync(certFile, 'utf8') });

const chunks = [];
const pdf = createPdf({ write: (b) => { chunks.push(Buffer.from(b)); } }, { title: 'Offer letter', sign: true });
const font = pdf.standardFont('Helvetica');
const page = pdf.addPage();
page.text('Offer letter', { x: 40, y: 40, font, size: 18 });
const hr = pdf.form.signature('hr', { page, x: 40, y: 700, width: 200, height: 40, tooltip: 'HR signature' });
pdf.form.signature('candidate', { page, x: 300, y: 700, width: 200, height: 40, tooltip: 'Candidate signature' });
await pdf.sign(hr, { signer, reason: 'Issued', location: 'Bengaluru', name: 'HR', certify: 2 });   // DocMDP P=2: signing allowed later
await page.end();
await pdf.end();                                                 // the signer runs here, on the streamed bytes' digest

// Countersign: appends an update, so the first signature stays valid.
const doc = await loadPdf(Buffer.concat(chunks));
const { bytes } = await doc.saveIncremental({ sign: { field: 'candidate', signer, reason: 'Accepted' } });
fs.writeFileSync(out, bytes);
const signatures = (await loadPdf(bytes)).signatures;
console.log(`wrote ${out}:`, signatures.map((s) => `${s.field} (revision ${s.revision}, covers the whole file: ${s.coversWholeFile})`).join('; '));
