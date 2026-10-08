// Builds dist/index.js: src/ bundled with the parts of fflate it uses (so the package has no runtime dependencies).
// node packages/pdf/build.mjs (also run by scripts/build-packages.mjs)
import { build } from 'esbuild';
import path from 'node:path';
const here = import.meta.dirname;
await build({
  entryPoints: [path.join(here, 'src/index.js')], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
  minify: false, sourcemap: false, charset: 'utf8', legalComments: 'inline', outfile: path.join(here, 'dist/index.js'), logLevel: 'warning', mainFields: ['module', 'main'],
});
