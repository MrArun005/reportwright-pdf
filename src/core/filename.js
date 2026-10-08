// @ts-check
/**
 * The one checker for file names written into a PDF (attachments now; the embedded-files name tree keys and PDF/A-3
 * attachments of the standards group must use it too). A viewer shows the name and may save the file under it, so a
 * name is checked the way an operating system and a viewer will read it, and refused (not cleaned) when it could
 * display or save as something it is not:
 *
 * - control and format characters (Unicode Cc, Cf: C0/C1 controls, bidi controls such as U+202E that make
 *   "invoice‮fdp.exe" display as "invoiceexe.pdf", zero-width characters, U+FEFF, soft hyphens), line and
 *   paragraph separators, lone surrogates, Windows-invalid characters < > : " | ? * (a colon opens NTFS streams:
 *   "report.pdf:evil.exe") and dot look-alikes (any character other than "." whose NFKC form has a dot, and the
 *   ideographic, Syriac and other full stops) throw;
 * - the directory part is dropped; the name is NFC-normalised; trailing dots and spaces (which Windows strips) are
 *   trimmed; a leading dot (a hidden file, or a name that is only an extension), an empty name and more than 255 UTF-8
 *   bytes throw; Windows device names (CON, PRN, AUX, NUL, COM1–9, LPT1–9, with any extension) throw;
 * - the type is an ALLOWLIST of passive formats (PASSIVE; zip only with allowArchives). Any other extension, and a
 *   name without one, needs allowTypes: ['ext', …] — by which the caller accepts the risk of that type. Inner parts
 *   that look like extensions must be allowed too ("invoice.pdf.scr", "report.docx.js" throw);
 * - a MIME type of application/pdf, image/* or text/* must agree with the extension.
 *
 * Both forms written are checked with the same rules: the name (/UF, a text string) and its ASCII form (/F: each
 * non-ASCII character becomes '_'), returned as a hex string.
 */
const MAX_IN = 4096, MAX_BYTES = 255;
const BAD = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}<>:"|?*]/u;
const DOTS = /[։۔܁܂።᙮᠃᠉․⸳⸼。ꓸ꘎︒﹒．｡··‧]/;
const DEVICE = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i;
/** passive formats allowed without allowTypes */
export const PASSIVE = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'tif', 'tiff', 'txt', 'csv', 'tsv', 'json', 'xml', 'md', 'rtf', 'odt', 'ods', 'odp', 'docx', 'xlsx', 'pptx', 'ics', 'vcf', 'eml', 'msg'];
const IMAGE = ['png', 'jpg', 'jpeg', 'jpe', 'jfif', 'gif', 'webp', 'tif', 'tiff', 'bmp', 'svg', 'heic', 'heif', 'avif', 'ico', 'jp2', 'jpx'];
const TEXT = ['txt', 'text', 'log', 'csv', 'tsv', 'md', 'markdown', 'html', 'htm', 'xml', 'css', 'ics', 'vcf', 'rtf'];
/** @type {Record<string, string[]>} specific types: their extensions */
const SPECIFIC = {
  'application/pdf': ['pdf'], 'text/csv': ['csv'], 'text/plain': ['txt', 'text', 'log'], 'text/html': ['html', 'htm'], 'text/xml': ['xml'],
  'text/markdown': ['md', 'markdown'], 'text/css': ['css'], 'text/tab-separated-values': ['tsv'], 'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg', 'jpe', 'jfif'], 'image/gif': ['gif'], 'image/webp': ['webp'], 'image/tiff': ['tif', 'tiff'], 'image/svg+xml': ['svg'],
};
const UTF8 = new TextEncoder();

/**
 * @param {any} raw @param {{ mimeType?: string | null, allowTypes?: string[], allowArchives?: boolean }} o @param {string} who
 * @returns {{ name: string, ascii: string }} ascii: /F's hex string
 */
export function checkFileName(raw, o, who) {
  if (typeof raw !== 'string') throw new TypeError(`${who}: name (the file name) is a string`);
  if (raw.length > MAX_IN) throw new RangeError(`${who}: a file name is at most ${MAX_BYTES} bytes (UTF-8)`);
  const allow = new Set(PASSIVE);
  if (o.allowArchives) allow.add('zip');
  if (o.allowTypes != null) {
    if (!Array.isArray(o.allowTypes) || o.allowTypes.length > 64) throw new TypeError(`${who}: allowTypes is an array of extensions`);
    for (const t of o.allowTypes) {
      if (typeof t !== 'string' || !/^[a-z0-9]{1,16}$/i.test(t)) throw new TypeError(`${who}: allowTypes: ${JSON.stringify(t)} is not an extension (letters and digits, no dot)`);
      allow.add(t.toLowerCase());
    }
  }
  const bad = BAD.exec(raw);
  if (bad) throw new TypeError(`${who}: the file name has a control, format, bidi or Windows-invalid character (U+${(bad[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}), which can make it display or save as another name`);
  const name = (raw.split(/[/\\]/).pop() ?? '').normalize('NFC').replace(/[. ]+$/, '');
  check(name, allow, o, who);
  let ascii = '', hex = '<';
  for (const ch of name) { const c = ch.codePointAt(0) ?? 0x5f, b = c >= 0x20 && c < 0x7f ? c : 0x5f; ascii += String.fromCharCode(b); hex += b.toString(16).padStart(2, '0'); }
  check(ascii, allow, o, `${who} (its ASCII form ${JSON.stringify(ascii)})`); // the /F fallback must not read differently
  return { name, ascii: `${hex}>` };
}

/** one form of the name @param {string} name @param {Set<string>} allow @param {any} o @param {string} who */
function check(name, allow, o, who) {
  if (!name) throw new TypeError(`${who}: the file name is empty (after its directory and trailing dots and spaces are dropped)`);
  if (UTF8.encode(name).length > MAX_BYTES) throw new RangeError(`${who}: a file name is at most ${MAX_BYTES} bytes (UTF-8)`);
  for (const ch of name) if (ch !== '.' && (DOTS.test(ch) || ch.normalize('NFKC').includes('.'))) throw new TypeError(`${who}: the file name has a character that looks like a dot (U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')})`);
  if (name.startsWith('.')) throw new TypeError(`${who}: ${JSON.stringify(name)} starts with a dot (a hidden file or only an extension)`);
  const parts = name.split('.');
  if (DEVICE.test(parts[0].replace(/ +$/, ''))) throw new TypeError(`${who}: ${JSON.stringify(parts[0])} is a Windows device name, not a file name`);
  const ext = parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
  if (!allow.has(ext)) throw new TypeError(`${who}: ${ext ? `.${ext}` : 'a name without an extension'} is not an allowed type (${PASSIVE.join(', ')}; zip with allowArchives); pass allowTypes: ['${ext || 'ext'}'] to accept the risk of that type`);
  for (const inner of parts.slice(1, -1)) { // "invoice.pdf.scr": an inner part that reads as an extension must be allowed too
    if (/^[a-z][a-z0-9-]{0,15}$/i.test(inner) && !/^\d+$/.test(inner) && !allow.has(inner.toLowerCase())) throw new TypeError(`${who}: ${JSON.stringify(name)} has an inner extension .${inner} that is not allowed (a double extension)`);
  }
  const mime = o.mimeType?.toLowerCase();
  if (mime) {
    const want = SPECIFIC[mime] ?? (mime.startsWith('image/') ? IMAGE : mime.startsWith('text/') ? TEXT : null);
    if (want && !want.includes(ext)) throw new TypeError(`${who}: the MIME type ${mime} does not match the extension ${ext ? `.${ext}` : '(none)'} of ${JSON.stringify(name)}`);
  }
}
