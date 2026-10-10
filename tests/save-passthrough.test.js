// save() copies an unchanged page's content stream as stored: the compressed bytes go out as they are (never decoded,
// never parsed), and the text read back is the same.
import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { loadPdf } from '../src/index.js';
import { onePage, enc } from './reader-tools.js';

describe('save: unchanged content passes through', () => {
  it('a compressed content stream is written byte for byte; the text is the same', async () => {
    const z = new Uint8Array(deflateSync(enc(`BT /F1 12 Tf 10 10 Td (${'A'.repeat(20000)}) Tj ET`)));
    const src = onePage(z, '<< /Filter /FlateDecode >>');
    const out = (await (await loadPdf(src)).save()).bytes;
    expect(Buffer.from(out).indexOf(Buffer.from(z))).toBeGreaterThan(0);
    expect((await loadPdf(out)).extractText()).toBe((await loadPdf(src)).extractText());
  });
});
