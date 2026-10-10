// The engine-facing extension API (pdf.core and the exports a caller writing its own content needs): what index.d.ts
// declares exists, and each piece does what it says.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createPdf } from '../src/index.js';

const DTS = fs.readFileSync(path.join(import.meta.dirname, '../index.d.ts'), 'utf8');
/** the members of an interface in index.d.ts: name → 'method' | 'property' */
function members(name) {
  const m = DTS.match(new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`));
  if (!m) throw new Error(`no interface ${name}`);
  const body = m[1].replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Map();
  for (const l of body.split('\n')) {
    const x = l.match(/^ {2}(?:readonly )?(?:get )?([A-Za-z]\w*)(?:<[^>]*>)?(\??)(\(|:)/);
    if (x) out.set(x[1], x[3] === '(' ? 'method' : 'property');
  }
  return out;
}

describe('A0: pdf.core is typed as it is', () => {
  it('every PdfCore member declared in index.d.ts exists on pdf.core, methods as functions', async () => {
    const pdf = createPdf({ write() {} });
    const decl = members('PdfCore');
    expect(decl.size).toBeGreaterThan(20);
    for (const [k, kind] of decl) {
      expect(k in pdf.core, k).toBe(true);
      if (kind === 'method') expect(typeof pdf.core[k], k).toBe('function');
    }
    expect(DTS).toMatch(/readonly core: PdfCore;/);
    await pdf.end();
  });
  it('the engine-facing members are declared', () => {
    const decl = members('PdfCore');
    for (const k of [
      'reserve',
      'write',
      'writeBig',
      'writeStream',
      'object',
      'resource',
      'resourcesRef',
      'catalog',
      'pageRef',
      'onFinish',
      'info',
      'xmp',
      'warn',
      'serial',
      'tags',
    ])
      expect(decl.has(k), k).toBe(true);
  });
});
