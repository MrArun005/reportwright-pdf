// @ts-check
/**
 * page.attachFile(bytes, options): a FileAttachment annotation (an icon on the page) carrying an embedded file: its
 * file specification (/F and /UF names, /Desc) and its embedded-file stream (/Subtype the MIME type, /Params with
 * /Size, /CheckSum (MD5) and dates). The bytes are copied at the call (the checksum is of what is written).
 *
 * PDF/A-2 allows only PDF/A files as attachments, which this library cannot verify, so attachments are refused when
 * pdfa is set (PDF/A-3, which allows any file, is for the standards group). File names go through core/filename.js
 * (spoofing and look-alike characters, device names, an allowlist of passive types, MIME/extension agreement); at most 256 MB.
 */
import { num, text, pdfName } from '../core/serialize.js';
import { checkFileName } from '../core/filename.js';
import { md5 } from '../core/md5.js';
import { shared, addAnnot, dateOf, FLAGS } from './annot.js';

export const FILE_ICONS = ['PushPin', 'Paperclip', 'Graph', 'Tag'];
const MAX_FILE = 256 << 20;

/**
 * @this {any} @param {Uint8Array | ArrayBuffer} bytes
 * @param {import('./annot.js').AnnotOptions & { x?: number, y?: number, name: string, mimeType?: string, allowTypes?: string[], allowArchives?: boolean, description?: string, created?: Date, icon?: string }} o
 */
export function attachFile(bytes, o = /** @type {any} */ ({})) {
  const who = 'page.attachFile', page = this, doc = this.doc;
  if (doc.pdfa) throw new TypeError(`${who}: PDF/A-2 does not allow attachments that are not themselves PDF/A files (which this library cannot check); attach files without pdfa`);
  const data = bytes instanceof ArrayBuffer ? new Uint8Array(bytes.slice(0)) : ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) : null;
  if (!data) throw new TypeError(`${who}: the file is a Uint8Array, Buffer or ArrayBuffer`);
  if (data.length > MAX_FILE) throw new RangeError(`${who}: an attachment is at most ${MAX_FILE >> 20} MB`);
  const mime = o.mimeType;
  if (mime != null && !(typeof mime === 'string' && mime.length <= 127 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mime))) throw new TypeError(`${who}: mimeType is type/subtype, like application/pdf`);
  const { name, ascii: fName } = checkFileName(o?.name, { mimeType: mime, allowTypes: o.allowTypes, allowArchives: o.allowArchives === true }, who); // core/filename.js
  if (o.description != null && (typeof o.description !== 'string' || o.description.length > 65536)) throw new TypeError(`${who}: description is a string`);
  const icon = o.icon ?? 'PushPin';
  if (!FILE_ICONS.includes(icon)) throw new TypeError(`${who}: icon is one of ${FILE_ICONS.join(', ')}`);
  const dates = `${o.created != null ? ` /CreationDate ${dateOf(o.created, who)}` : ''}${o.modified != null ? ` /ModDate ${dateOf(o.modified, who)}` : ''}`;
  const x = o.x ?? 0, y = o.y ?? 0;
  num(x); num(y);
  const common = shared(doc, o, who, { flags: FLAGS.print | FLAGS.noZoom | FLAGS.noRotate, contents: o.description ?? name, color: o.color ?? 0.25 });
  const ef = doc.reserve(), fs = doc.reserve(), sum = md5(data);
  const ext = mime ? ` /Subtype ${pdfName(mime)}` : ''; // application/pdf → /application#2Fpdf
  page.onWrite(async () => {
    await doc.writeStream(ef, `<< /Type /EmbeddedFile${ext} /Params << /Size ${data.length} /CheckSum <${sum}>${dates} >> >>`, data);
    await doc.write(fs, `<< /Type /Filespec /F ${fName} /UF ${text(name)}${o.description != null ? ` /Desc ${text(o.description)}` : ''} /EF << /F ${ef} 0 R /UF ${ef} 0 R >> >>`);
  });
  const color = o.color ?? 0.25;
  return addAnnot(this, 'FileAttachment', [x, y, 14, 20], ` /FS ${fs} 0 R /Name /${icon}`, common, (ap) => {
    // a paperclip, drawn for every icon name (viewers that redraw icons use /Name)
    ap.stroke(ap.path().moveTo(9.5, 6).lineTo(9.5, 15).bezierCurveTo(9.5, 17.5, 4.5, 17.5, 4.5, 15).lineTo(4.5, 4).bezierCurveTo(4.5, 0.8, 11.5, 0.8, 11.5, 4).lineTo(11.5, 15.5).bezierCurveTo(11.5, 20, 2.5, 20, 2.5, 15.5).lineTo(2.5, 6), { stroke: color, width: 1.2, cap: 'round' });
  });
}
