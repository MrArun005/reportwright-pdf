// A source file with an XMP packet and a huge Info title: save() must write the cut title, not copy the source's own
// Info dictionary (which still holds the uncut value) next to its XMP. Gate P16 caught the warning without the cut.
import { describe, it, expect } from 'vitest';
import { loadPdf } from '../src/index.js';

/** a minimal PDF with /Info /Title of n characters and a catalog /Metadata stream @param {number} n */
function source(n) {
  const xmp =
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></x:xmpmeta><?xpacket end="w"?>';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R /Metadata 4 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
    `<< /Type /Metadata /Subtype /XML /Length ${xmp.length} >>\nstream\n${xmp}\nendstream`,
    `<< /Title (${'A'.repeat(n)}) >>`,
  ];
  let out = '%PDF-1.7\n';
  const offs = objs.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** save() into memory @param {any} d */
async function saved(d) {
  const res = await d.save();
  return { bytes: Buffer.from(res.bytes), res };
}

describe('a huge source title next to an XMP packet', () => {
  it('is written cut to 65,536 characters, as its warning says', async () => {
    const d = await loadPdf(source(200_000));
    expect(d.info.title.length).toBe(200_000);
    const { bytes, res } = await saved(d);
    expect(res.warnings.some((w) => /title .* was cut/.test(w))).toBe(true);
    const back = await loadPdf(new Uint8Array(bytes));
    expect(back.info.title.length).toBe(65_536);
    expect(/A{65537}/.test(back.xmp ?? '')).toBe(false); // nor does the XMP carry the uncut title
  });

  it('a normal title next to an XMP packet still keeps the source Info as is', async () => {
    const d = await loadPdf(source(10));
    const { bytes, res } = await saved(d);
    expect(res.warnings.some((w) => /was cut/.test(w))).toBe(false);
    expect((await loadPdf(new Uint8Array(bytes))).info.title).toBe('A'.repeat(10));
  });
});
