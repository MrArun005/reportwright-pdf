// Builds dist/index.js (the "." entry: createPdf and the reader), dist/write.js (the "./write" entry: the writer only)
// and dist/fflate.js (fflate, MIT): the package has no runtime dependencies. fflate is its own file, loaded by the
// entries on first use (import('./fflate.js')), so importing the library does not build its tables; a bundler that
// also bundles fflate for something else (the ReportWright engine: @reportwright/pdf/fflate) keeps one copy of it.
// Every file is minified with its sourcemap (no sourcesContent: the .map points at src/ and is small). keepNames keeps
// function and class .name, so error and stack output reads the same as the unminified build.
// node packages/pdf/build.mjs (also run by scripts/build-packages.mjs)
import { build } from 'esbuild';
import path from 'node:path';
const here = import.meta.dirname;
const common = {
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  minify: true,
  keepNames: true,
  sourcemap: true,
  sourcesContent: false,
  charset: 'utf8',
  legalComments: 'inline',
  logLevel: 'warning',
  mainFields: ['module', 'main'],
};
await build({
  ...common,
  stdin: { contents: "export * from 'fflate';", resolveDir: here, sourcefile: 'fflate.js' },
  outfile: path.join(here, 'dist/fflate.js'),
});
const fflateApart = {
  name: 'fflate-apart',
  setup(b) {
    b.onResolve({ filter: /^fflate$/ }, () => ({ path: './fflate.js', external: true }));
  },
};
await build({
  ...common,
  entryPoints: [path.join(here, 'src/index.js')],
  outfile: path.join(here, 'dist/index.js'),
  plugins: [fflateApart],
});
await build({
  ...common,
  entryPoints: [path.join(here, 'src/write.js')],
  outfile: path.join(here, 'dist/write.js'),
  plugins: [fflateApart],
});
