// The 14 standard PDF fonts' outlines for renderPage({ fonts: stdFonts }). Node reads the files here; in a browser,
// fetch each of FILES (relative to this package) and pass the same { name: bytes } map.
import fs from 'node:fs';

/** standard font name → file in ./fonts */
export const FILES = {
  Helvetica: 'LiberationSans-Regular.ttf',
  'Helvetica-Bold': 'LiberationSans-Bold.ttf',
  'Helvetica-Oblique': 'LiberationSans-Italic.ttf',
  'Helvetica-BoldOblique': 'LiberationSans-BoldItalic.ttf',
  'Times-Roman': 'LiberationSerif-Regular.ttf',
  'Times-Bold': 'LiberationSerif-Bold.ttf',
  'Times-Italic': 'LiberationSerif-Italic.ttf',
  'Times-BoldItalic': 'LiberationSerif-BoldItalic.ttf',
  Courier: 'LiberationMono-Regular.ttf',
  'Courier-Bold': 'LiberationMono-Bold.ttf',
  'Courier-Oblique': 'LiberationMono-Italic.ttf',
  'Courier-BoldOblique': 'LiberationMono-BoldItalic.ttf',
  // ponytail: Symbol is Greek and maths; Liberation Serif has the Greek and the common operators, not all of Symbol
  Symbol: 'LiberationSerif-Regular.ttf',
  ZapfDingbats: 'NotoSansSymbols2-Regular.ttf',
};

/** @type {Record<string, Uint8Array>} each file read once, shared by the names that use it */
export const stdFonts = {};
const read = new Map();
for (const [name, file] of Object.entries(FILES)) {
  if (!read.has(file)) read.set(file, new Uint8Array(fs.readFileSync(new URL(`./fonts/${file}`, import.meta.url))));
  stdFonts[name] = read.get(file);
}
