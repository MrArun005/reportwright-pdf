// @ts-check
/**
 * pdf.attach(bytes, options): an embedded file at the document level, in the catalog's /Names /EmbeddedFiles name tree
 * (a balanced tree, keys sorted as bytes; nav/trees.js), with its file specification (/F, /UF, /Desc,
 * /AFRelationship) and embedded-file stream (/Subtype the MIME type, /Params /Size /CheckSum /CreationDate /ModDate).
 * The bytes are written at the call (through doc.serial), so nothing is held but each file's name key and number.
 *
 * PDF/A: refused in PDF/A-1 (no embedded files) and PDF/A-2 (only PDF/A files, which this library cannot check);
 * in PDF/A-3 each file needs its MIME type and is listed in the catalog's /AF (ISO 19005-3 6.8).
 * SECURITY: names through core/filename.js checkFileName (spoofing, look-alikes, device names, passive types, MIME
 * agreement); the size is checked before the bytes are copied; at most MAX_FILES files; every string is hex.
 */
import { text, pdfName } from '../core/serialize.js';
import { checkFileName } from '../core/filename.js';
import { md5 } from '../core/md5.js';
import { dateOf } from '../annotations/annot.js';
import { writeTree, setNames } from '../nav/trees.js';

export const RELATIONSHIPS = ['Source', 'Data', 'Alternative', 'Supplement', 'Unspecified'];
export const MAX_FILE = 256 << 20, MAX_FILES = 10_000;
const MIME = /^[a-z0-9!#$&^_.+-]{1,63}\/[a-z0-9!#$&^_.+-]{1,63}$/i;

/**
 * @typedef {{ name: string, mimeType?: string, description?: string, relationship?: string, created?: Date, modified?: Date,
 *   maxBytes?: number, allowTypes?: string[], allowArchives?: boolean }} AttachOptions
 * @param {import('../document.js').Doc} doc @param {Date} when the document's date (an embedded file's default dates)
 */
export function createFiles(doc, when) {
  /** @type {Map<string, number>} name tree key (the name as a hex text string) → file specification */
  const tree = new Map();
  /** @type {number[]} file specifications for the catalog's /AF (PDF/A-3) */
  const af = [];
  doc.onFinish(async () => {
    if (!tree.size) return;
    const sorted = [...tree].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)); // same-case hex: as the bytes sort
    setNames(doc, 'EmbeddedFiles', await writeTree(doc, 'Names', sorted.map(([k, r]) => [k, `${r} 0 R`])));
    if (af.length) doc.catalog('AF', `[${af.map((r) => `${r} 0 R`).join(' ')}]`);
  });

  /** @param {any} bytes @param {AttachOptions} o @param {string} [who] @returns {Promise<void>} */
  return async function attach(bytes, o, who = 'pdf.attach') {
    if (o == null || typeof o !== 'object') throw new TypeError(`${who}: options with the file's name: { name: 'data.csv' }`);
    const L = doc.pdfaLevel;
    if (L && L.part !== 3) throw new TypeError(`${who}: PDF/A-${L.part} ${L.part === 1 ? 'forbids embedded files' : 'allows only PDF/A files as attachments, which this library cannot check'}; use PDF/A-3 (pdfa: { part: 3 })`);
    const max = o.maxBytes ?? MAX_FILE;
    if (typeof max !== 'number' || !(max > 0 && max <= MAX_FILE)) throw new RangeError(`${who}: maxBytes is 1 to ${MAX_FILE} bytes`);
    const len = bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes) ? bytes.byteLength : -1;
    if (len < 0) throw new TypeError(`${who}: the file is a Uint8Array, Buffer or ArrayBuffer`);
    if (len > max) throw new RangeError(`${who}: the file is ${len} bytes, over maxBytes (${max})`); // before any copy
    if (tree.size >= MAX_FILES) throw new RangeError(`${who}: at most ${MAX_FILES} embedded files`);
    const mime = o.mimeType;
    if (mime != null && !(typeof mime === 'string' && MIME.test(mime))) throw new TypeError(`${who}: mimeType is type/subtype, like text/csv`);
    if (L && mime == null) throw new TypeError(`${who}: PDF/A-3 needs each embedded file's mimeType (ISO 19005-3 6.8)`);
    const { name, ascii: F } = checkFileName(o.name, { mimeType: mime, allowTypes: o.allowTypes, allowArchives: o.allowArchives === true }, who); // core/filename.js
    if (o.description != null && (typeof o.description !== 'string' || o.description.length > 65536)) throw new TypeError(`${who}: description is a string of at most 65,536 characters`);
    const rel = o.relationship ?? (L ? 'Unspecified' : null);
    if (rel != null && !RELATIONSHIPS.includes(rel)) throw new TypeError(`${who}: relationship is one of ${RELATIONSHIPS.join(', ')}`);
    const dates = ` /CreationDate ${dateOf(o.created ?? when, who)} /ModDate ${dateOf(o.modified ?? when, who)}`;
    const key = text(name);
    if (tree.has(key)) throw new TypeError(`${who}: a file named ${JSON.stringify(name)} is already attached`);
    const data = new Uint8Array(len); // a copy: the checksum is of what is written
    data.set(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, len));
    const ef = doc.reserve(), fs = doc.reserve();
    tree.set(key, fs);
    if (L) af.push(fs);
    const sub = mime ? ` /Subtype ${pdfName(mime)}` : '';
    const head = `<< /Type /EmbeddedFile${sub} /Params << /Size ${len} /CheckSum <${md5(data)}>${dates} >> >>`;
    const spec = `<< /Type /Filespec /F ${F} /UF ${text(name)}${o.description != null ? ` /Desc ${text(o.description)}` : ''}${rel ? ` /AFRelationship /${rel}` : ''} /EF << /F ${ef} 0 R /UF ${ef} 0 R >> >>`;
    await doc.serial(async () => { await doc.writeStream(ef, head, data); await doc.write(fs, spec); });
  };
}
