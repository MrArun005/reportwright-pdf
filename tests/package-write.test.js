// The ./write subpath, from the packed tarball: installed the way a user installs it, imported by its export name.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('@reportwright/pdf/write from the packed tarball', () => {
  it('imports the writer, and does not export the reader or bulk', { timeout: 180000 }, () => {
    execFileSync(process.execPath, [path.join(root, 'build.mjs')], { stdio: 'pipe' });
    // a temp folder inside the repo (not the system tmp), deleted afterwards
    const dir = fs.mkdtempSync(path.join(root, '.pack-test-'));
    try {
      const packDir = path.join(dir, 'pack');
      const app = path.join(dir, 'app');
      fs.mkdirSync(packDir);
      fs.mkdirSync(app);
      fs.writeFileSync(path.join(app, 'package.json'), '{"name":"app","version":"1.0.0","type":"module"}');
      const tgz = execFileSync('npm', ['pack', '--pack-destination', packDir, '--silent'], {
        cwd: root,
        encoding: 'utf8',
      }).trim();
      execFileSync('npm', ['install', '--no-audit', '--no-fund', '--silent', path.join(packDir, tgz)], {
        cwd: app,
        stdio: 'pipe',
      });
      const probe = `
        const write = await import('@reportwright/pdf/write');
        const all = await import('@reportwright/pdf');
        console.log(JSON.stringify({
          createPdf: typeof write.createPdf,
          loadPdf: 'loadPdf' in write, mergePdfs: 'mergePdfs' in write, bulk: 'bulk' in write,
          rootHasLoadPdf: 'loadPdf' in all,
        }));`;
      fs.writeFileSync(path.join(app, 'probe.mjs'), probe);
      const out = JSON.parse(execFileSync(process.execPath, ['probe.mjs'], { cwd: app, encoding: 'utf8' }).trim());
      expect(out).toEqual({
        createPdf: 'function',
        loadPdf: false,
        mergePdfs: false,
        bulk: false,
        rootHasLoadPdf: true,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
