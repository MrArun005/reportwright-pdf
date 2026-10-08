// @ts-check
/**
 * The one checker for file names written into a PDF (attachments now; the embedded-files name tree keys and PDF/A-3
 * attachments of the standards group must use it too). A viewer shows the name and may save the file under it (and
 * may pick a handler by /Subtype), so a name is checked the way an operating system and a viewer will read it, and
 * refused (never cleaned) when it could display or save as something it is not. Every check runs on the FINAL name
 * written (after the directory part is dropped, NFC and trimming), on its ASCII /F form, and the result is checked
 * again (an invariant). Tests: tests/pdf/hostile-attachments.test.js, by the test titles below.
 *
 * | attack | rule | test |
 * |---|---|---|
 * | bidi override ("invoice\u202Efdp.exe") | Cf characters refused | "bidi, zero-width, format and C1 characters…" |
 * | zero-width, soft hyphen, BOM | Cf refused | same |
 * | C0/C1 controls, line separators, lone surrogates | Cc, Zl, Zp, Cs refused | same |
 * | Windows-invalid characters, NTFS streams ("x.pdf:evil.exe") | < > : " | ? * refused | "NTFS streams, Windows-invalid characters…" |
 * | Windows device names (CON.txt, COM1) | refused, any extension | "trailing dots and spaces are trimmed…" |
 * | trailing dot/space (Windows strips: "x.exe.") | trimmed, then checked | same |
 * | hidden file, name that is only an extension (".bashrc") | leading dot refused | "NTFS streams, Windows-invalid characters…" |
 * | dot look-alikes ("invoice\uFF0Eexe") | any non-"." character whose NFKC has a dot, and listed full stops, refused | same |
 * | slash look-alikes posing as a path ("docs\uFF0Fx.pdf") | refused before the directory is dropped | "slash look-alikes, Unicode spaces and padding" |
 * | Unicode spaces, padding that hides the extension | only U+0020, never 3 in a row | same |
 * | double extension ("invoice.pdf.scr") | inner parts that read as extensions must be allowed | "only passive types are allowed by default…" |
 * | non-passive type (.exe, .docm, .scpt…) | allowlist PASSIVE; allowTypes to accept a type's risk | same |
 * | MIME type contradicting the name ("invoice.pdf", x-msdownload) | the MIME must be one of the extension's types | "a MIME type must agree with the extension…" |
 * | ASCII /F form reading differently | /F checked with the same rules | "a valid Unicode name round-trips…" |
 * | length (a 1 MB name, 256 UTF-8 bytes) | ≤ 255 UTF-8 bytes; > 4,096 characters refused before any work | "NTFS streams…", "a MIME type must agree…" |
 * | anything accepted that should not be | 2,000 random hostile names: accepted ones are safe and re-check clean | "random hostile names…" |
 */
const MAX_IN = 4096, MAX_BYTES = 255;
const BAD = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}<>:"|?*]/u;
const SPACES = /[^\S ]| {3}/; // white space other than U+0020 (\s has every Zs space), or 3 spaces in a row
const SLASHES = /[\u2215\u2044\u29F8\uFF0F\u29F5\uFF3C\u2216\u2571\u2572\u27CB\u27CD\u3033\u3035]/;
const DOTS = /[։۔܁܂።᙮᠃᠉․⸳⸼。ꓸ꘎︒﹒．｡··‧]/;
const DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;
/** passive formats allowed without allowTypes */
export const PASSIVE = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'tif', 'tiff', 'txt', 'csv', 'tsv', 'json', 'xml', 'md', 'rtf', 'odt', 'ods', 'odp', 'docx', 'xlsx', 'pptx', 'ics', 'vcf', 'eml', 'msg'];
/** @type {Record<string, string[]>} each allowed extension's MIME types */
const MIMES = {
  pdf: ['application/pdf'], png: ['image/png'], jpg: ['image/jpeg', 'image/pjpeg'], jpeg: ['image/jpeg', 'image/pjpeg'], gif: ['image/gif'],
  webp: ['image/webp'], tif: ['image/tiff'], tiff: ['image/tiff'], txt: ['text/plain'], csv: ['text/csv'], tsv: ['text/tab-separated-values'],
  json: ['application/json'], xml: ['application/xml', 'text/xml'], md: ['text/markdown', 'text/x-markdown'], rtf: ['application/rtf', 'text/rtf'],
  odt: ['application/vnd.oasis.opendocument.text'], ods: ['application/vnd.oasis.opendocument.spreadsheet'], odp: ['application/vnd.oasis.opendocument.presentation'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'], ics: ['text/calendar'], vcf: ['text/vcard', 'text/x-vcard'],
  eml: ['message/rfc822'], msg: ['application/vnd.ms-outlook'], zip: ['application/zip', 'application/x-zip-compressed'],
};
const UTF8 = new TextEncoder();

/**
 * @param {any} raw @param {{ mimeType?: string | null, allowTypes?: string[], allowArchives?: boolean }} o @param {string} who
 * @param {boolean} [again] the invariant's second pass
 * @returns {{ name: string, ascii: string }} ascii: /F's hex string
 */
export function checkFileName(raw, o, who, again = false) {
  if (typeof raw !== 'string') throw new TypeError(`${who}: name (the file name) is a string`);
  if (raw.length > MAX_IN) throw new RangeError(`${who}: a file name is at most ${MAX_BYTES} bytes (UTF-8)`);
  const allow = new Set(PASSIVE), risky = new Set();
  if (o.allowArchives) allow.add('zip');
  if (o.allowTypes != null) {
    if (!Array.isArray(o.allowTypes) || o.allowTypes.length > 64) throw new TypeError(`${who}: allowTypes is an array of extensions`);
    for (const t of o.allowTypes) {
      if (typeof t !== 'string' || !/^[a-z0-9]{1,16}$/i.test(t)) throw new TypeError(`${who}: allowTypes: ${JSON.stringify(t)} is not an extension (letters and digits, no dot)`);
      // a type the caller takes the risk of: its MIME check is off; a passive type keeps its check (allowTypes: ['pdf'] must not
      // let invoice.pdf claim application/x-msdownload)
      allow.add(t.toLowerCase()); if (!PASSIVE.includes(t.toLowerCase()) && t.toLowerCase() !== 'zip') risky.add(t.toLowerCase());
    }
  }
  chars(raw, who); // on the input too: a slash look-alike must not survive as a fake path, nor anything hide in the dropped directory
  const name = (raw.split(/[/\\]/).pop() ?? '').normalize('NFC').replace(/[. ]+$/, '');
  check(name, allow, risky, o, who);
  let ascii = '', hex = '<';
  for (const ch of name) { const c = ch.codePointAt(0) ?? 0x5f, b = c >= 0x20 && c < 0x7f ? c : 0x5f; ascii += String.fromCharCode(b); hex += b.toString(16).padStart(2, '0'); }
  check(ascii, allow, risky, o, `${who} (its ASCII form ${JSON.stringify(ascii)})`); // the /F fallback must not read differently
  if (!again && checkFileName(name, o, who, true).name !== name) throw new Error(`${who}: internal: the checked name is not stable`); // invariant
  return { name, ascii: `${hex}>` };
}

/** the characters: control/format/bidi/Windows-invalid, spaces, dot and slash look-alikes @param {string} name @param {string} who */
function chars(name, who) {
  const u = (/** @type {string} */ c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;
  const bad = BAD.exec(name);
  if (bad) throw new TypeError(`${who}: the file name has a control, format, bidi or Windows-invalid character (${u(bad[0])}), which can make it display or save as another name`);
  const sp = SPACES.exec(name);
  if (sp) throw new TypeError(`${who}: the file name has ${sp[0] === '   ' ? '3 spaces in a row (padding that can push the real extension out of view)' : `a space other than U+0020 (${u(sp[0])})`}`);
  for (const ch of name) {
    if (ch === '.' || ch === '/' || ch === '\\') continue;
    const k = ch.normalize('NFKC');
    if (SLASHES.test(ch) || k.includes('/') || k.includes('\\')) throw new TypeError(`${who}: the file name has a character that looks like a slash (${u(ch)})`);
    if (DOTS.test(ch) || k.includes('.')) throw new TypeError(`${who}: the file name has a character that looks like a dot (${u(ch)})`);
  }
}

/** one form of the name, as written @param {string} name @param {Set<string>} allow @param {Set<string>} risky @param {any} o @param {string} who */
function check(name, allow, risky, o, who) {
  chars(name, who);
  if (/[/\\]/.test(name)) throw new TypeError(`${who}: internal: a separator in the final name`);
  if (!name) throw new TypeError(`${who}: the file name is empty (after its directory and trailing dots and spaces are dropped)`);
  if (UTF8.encode(name).length > MAX_BYTES) throw new RangeError(`${who}: a file name is at most ${MAX_BYTES} bytes (UTF-8)`);
  if (name.startsWith('.')) throw new TypeError(`${who}: ${JSON.stringify(name)} starts with a dot (a hidden file or only an extension)`);
  const parts = name.split('.');
  if (DEVICE.test(parts[0].replace(/ +$/, ''))) throw new TypeError(`${who}: ${JSON.stringify(parts[0])} is a Windows device name, not a file name`);
  const ext = parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
  if (!allow.has(ext)) throw new TypeError(`${who}: ${ext ? `.${ext}` : 'a name without an extension'} is not an allowed type (${PASSIVE.join(', ')}; zip with allowArchives); pass allowTypes: ['${ext || 'ext'}'] to accept the risk of that type`);
  for (const inner of parts.slice(1, -1)) { // "invoice.pdf.scr": an inner part that reads as an extension must be allowed too
    if (/^[a-z][a-z0-9-]{0,15}$/i.test(inner) && !/^\d+$/.test(inner) && !allow.has(inner.toLowerCase())) throw new TypeError(`${who}: ${JSON.stringify(name)} has an inner extension .${inner} that is not allowed (a double extension)`);
  }
  const mime = o.mimeType?.toLowerCase();
  if (mime && !risky.has(ext) && !(MIMES[ext] ?? []).includes(mime)) throw new TypeError(`${who}: the MIME type ${mime} does not match the extension .${ext} of ${JSON.stringify(name)} (${(MIMES[ext] ?? []).join(' or ') || 'no MIME type'}; a type in allowTypes takes any, at your risk)`);
}
