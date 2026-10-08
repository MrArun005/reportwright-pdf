// @ts-check
/**
 * The one checker for file names written into a PDF (attachments now; the embedded-files name tree and PDF/A-3
 * attachments of the standards group must use it too). A viewer shows the name and may save the file under it, so a
 * name that displays as something it is not is refused, not cleaned:
 *
 * - control and format characters (Unicode Cc, Cf: C0/C1 controls, bidi controls such as U+202E that make
 *   "invoice‮fdp.exe" display as "invoiceexe.pdf", zero-width characters, U+FEFF, soft hyphens), line and
 *   paragraph separators and lone surrogates throw;
 * - the directory part is dropped; the name is NFC-normalised; trailing dots and spaces (which Windows strips) are
 *   trimmed, and an empty or longer than 255-character name throws;
 * - Windows device names (CON, PRN, AUX, NUL, COM1–9, LPT1–9, with any extension) throw;
 * - executable extensions throw unless allowExecutable; a double extension ending in one ("invoice.pdf.exe") always
 *   throws;
 * - a MIME type of application/pdf, image/* or text/* must agree with the extension.
 *
 * Returns the name (for /UF, a text string) and its ASCII form for /F (each non-ASCII character becomes '_'), as a
 * hex string.
 */
const MAX_IN = 4096, MAX_NAME = 255;
const BAD = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;
const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export const EXECUTABLE = ['exe', 'com', 'bat', 'cmd', 'scr', 'pif', 'msi', 'msp', 'dll', 'cpl', 'jar', 'js', 'jse', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1', 'psm1', 'hta', 'lnk', 'app', 'command', 'sh', 'reg', 'iso', 'img'];
const IMAGE = ['png', 'jpg', 'jpeg', 'jpe', 'jfif', 'gif', 'webp', 'tif', 'tiff', 'bmp', 'svg', 'heic', 'heif', 'avif', 'ico', 'jp2', 'jpx'];
const TEXT = ['txt', 'text', 'log', 'csv', 'tsv', 'md', 'markdown', 'html', 'htm', 'xml', 'css', 'ics', 'vcf', 'rtf'];
/** @type {Record<string, string[]>} specific types: their extensions */
const SPECIFIC = {
  'application/pdf': ['pdf'], 'text/csv': ['csv'], 'text/plain': ['txt', 'text', 'log'], 'text/html': ['html', 'htm'], 'text/xml': ['xml'],
  'text/markdown': ['md', 'markdown'], 'text/css': ['css'], 'text/tab-separated-values': ['tsv'], 'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg', 'jpe', 'jfif'], 'image/gif': ['gif'], 'image/webp': ['webp'], 'image/tiff': ['tif', 'tiff'], 'image/svg+xml': ['svg'],
};

/**
 * @param {any} raw @param {{ mimeType?: string | null, allowExecutable?: boolean }} o @param {string} who
 * @returns {{ name: string, ascii: string }} ascii: /F's hex string
 */
export function checkFileName(raw, o, who) {
  if (typeof raw !== 'string') throw new TypeError(`${who}: name (the file name) is a string`);
  if (raw.length > MAX_IN) throw new RangeError(`${who}: a file name is at most ${MAX_NAME} characters`);
  const bad = BAD.exec(raw);
  if (bad) throw new TypeError(`${who}: the file name has a control, format or bidi character (U+${(bad[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}), which can make it display as another name`);
  const name = (raw.split(/[/\\]/).pop() ?? '').normalize('NFC').replace(/[. ]+$/, '');
  if (!name || name.length > MAX_NAME) throw new TypeError(`${who}: the file name is 1–${MAX_NAME} characters (after its directory and trailing dots and spaces are dropped)`);
  const parts = name.split('.');
  if (DEVICE.test(parts[0].replace(/ +$/, ''))) throw new TypeError(`${who}: ${JSON.stringify(parts[0])} is a Windows device name, not a file name`);
  const ext = parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
  if (EXECUTABLE.includes(ext)) {
    if (parts.length > 2) throw new TypeError(`${who}: ${JSON.stringify(name)} hides an executable behind a double extension (refused)`);
    if (!o.allowExecutable) throw new TypeError(`${who}: .${ext} files are executable; pass allowExecutable: true to attach one`);
  }
  const mime = o.mimeType?.toLowerCase();
  if (mime) {
    const want = SPECIFIC[mime] ?? (mime.startsWith('image/') ? IMAGE : mime.startsWith('text/') ? TEXT : null);
    if (want && !want.includes(ext)) throw new TypeError(`${who}: the MIME type ${mime} does not match the extension ${ext ? `.${ext}` : '(none)'} of ${JSON.stringify(name)}`);
  }
  let ascii = '<';
  for (const ch of name) { const c = ch.codePointAt(0) ?? 0x5f; ascii += (c >= 0x20 && c < 0x7f ? c : 0x5f).toString(16).padStart(2, '0'); }
  return { name, ascii: `${ascii}>` };
}
