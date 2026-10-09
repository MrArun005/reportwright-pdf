// @ts-check
/**
 * THE registry of what is dangerous in a file from a stranger: the ONE definition both save() (reader/copy.js: what a
 * rewrite drops or rewrites) and saveIncremental (reader/active.js: what makes an update refuse) use, through the same
 * functions, so detection is exactly as strict as stripping.
 *
 * - Actions: an ALLOWLIST. GoTo; URI only when its bytes are plain 7-bit ASCII (no BOM, no NUL, nothing ≥ 0x80) and
 *   nav/links.js checkUrl accepts it (http, https, mailto, ftp) — and the URI WRITTEN is the normalised string checkUrl
 *   returned, never the source bytes (what was checked is what is written); Named with a page move; ResetForm.
 *   Everything else is dropped: every other type in ACTION_TYPES, and any unknown or missing /S where an action is.
 *   An action is a dictionary under an action key (ACTION_KEYS, and arrays of them; /A but in a structure element,
 *   where it is the attributes: isStructElem), a /Type /Action, or a dictionary whose /S is one of ACTION_TYPES
 *   wherever it is.
 * - Annotations: an ALLOWLIST of subtypes (KEEP_ANNOTS). Every element of an /Annots array, every widget in a form's
 *   /Fields and /Kids, and any dictionary shaped like an annotation is checked.
 * - Keys always dropped: DANGEROUS_KEYS (/AA, /JS, /Names /JavaScript, the AcroForm's /XFA).
 * - File specifications: every name key present (/UF, /F, /DOS, /Mac, /Unix) must pass core/filename.js
 *   checkFileName and agree in extension; the written spec has only /UF (the checked name) and /F (its checked ASCII
 *   form), and ONE embedded stream (/EF /UF, else /F) under both keys. An attachment that is itself a PDF is copied as
 *   data: its own content is not sanitised (opening it is a separate act of the user).
 * - What save() would REWRITE (a URI checkUrl normalises, a name whose directory part or trailing dots are stripped, an
 *   /EF of two streams) is reported as `rewritten`: saveIncremental keeps the original bytes, so it refuses those too.
 */
import { PdfString, PdfStream, Ref, latin1 } from './lexer.js';
import { checkUrl } from '../nav/links.js';
import { checkFileName } from '../core/filename.js';
import { decodeText } from './text.js';

/** the actions kept */
export const KEEP_ACTIONS = new Set(['GoTo', 'URI', 'Named', 'ResetForm']);
export const NAMED_ACTIONS = new Set(['NextPage', 'PrevPage', 'FirstPage', 'LastPage']);
/** every action type of ISO 32000-2 §12.6.4 (and ECMAScript): a dictionary with one of these as /S is an action wherever it is */
export const ACTION_TYPES = new Set(['GoTo', 'GoToR', 'GoToE', 'GoToDp', 'Launch', 'Thread', 'URI', 'Sound', 'Movie', 'Hide', 'Named', 'SubmitForm', 'ResetForm', 'ImportData', 'SetOCGState', 'Rendition', 'Trans', 'GoTo3DView', 'JavaScript', 'RichMediaExecute', 'ECMAScript']);
/** the annotation subtypes kept */
export const KEEP_ANNOTS = new Set(['Link', 'Text', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine', 'Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Stamp', 'Caret', 'Ink', 'Popup', 'FileAttachment', 'Widget']);
/** keys whose value is an action, or an array of them (/Next only inside an action: an outline item's /Next is its sibling) */
export const ACTION_KEYS = new Set(['A', 'OpenAction', 'Next', 'PA']);
/** keys always dropped, and why */
export const DANGEROUS_KEYS = new Map([['AA', 'additional actions (/AA)'], ['JS', 'JavaScript (/JS)'], ['JavaScript', 'document JavaScript (/Names /JavaScript)'], ['XFA', 'XFA form (scripts)']]);
const NAME_KEYS = ['UF', 'F', 'DOS', 'Mac', 'Unix'];

/** @typedef {(v: any) => any} Resolve */

/** a dictionary that is an action wherever it is: /Type /Action, or an /S among ACTION_TYPES @param {any} d @param {Resolve} R */
export const isAction = (d, R) => d instanceof Map && (R(d.get('Type')) === 'Action' || ACTION_TYPES.has(R(d.get('S'))));
/** a dictionary shaped like an annotation (one reached by position is checked whatever its shape) @param {any} d @param {Resolve} R */
export const isAnnot = (d, R) => d instanceof Map && (R(d.get('Type')) === 'Annot' || (typeof R(d.get('Subtype')) === 'string' && d.has('Rect') && !d.has('BBox')));
/**
 * a structure element, whose /A is its attributes (layout, table /Scope, /ColSpan), not an action: a /S that is no
 * action type, a /P, and nothing of an annotation, a field, an outline item or a link (/Subtype, /Rect, /FT, /Parent,
 * /Title, /Dest), so a dictionary shaped as both is checked as an action place @param {any} d @param {Resolve} R
 */
export const isStructElem = (d, R) => {
  if (!(d instanceof Map) || !d.has('P')) return false;
  const ty = R(d.get('Type')), s = R(d.get('S'));
  return (ty == null || ty === 'StructElem') && typeof s === 'string' && !ACTION_TYPES.has(s) && !['Subtype', 'Rect', 'FT', 'Parent', 'Title', 'Dest'].some((k) => d.has(k));
};
/** a file specification dictionary @param {any} d @param {Resolve} R */
export const isFilespec = (d, R) => d instanceof Map && (R(d.get('Type')) === 'Filespec' || d.has('EF'));

/**
 * An action: { why } to drop it, or { value } to write (a URI action's URI replaced by the normalised string checkUrl
 * returned; rewritten says why when that differs from the file's, which saveIncremental, unable to rewrite, refuses).
 * An array (a destination as an /OpenAction) or null passes. @param {any} d @param {Resolve} R
 * @returns {{ why: string } | { value: any, rewritten?: string }}
 */
export function cleanAction(d, R) {
  if (d == null || Array.isArray(d)) return { value: d };
  if (!(d instanceof Map)) return { why: 'an action that is not a dictionary' };
  const s = R(d.get('S'));
  if (typeof s !== 'string' || !KEEP_ACTIONS.has(s)) return { why: `${typeof s === 'string' ? s.slice(0, 40) : 'untyped'} action` };
  if (s === 'Named' && !NAMED_ACTIONS.has(R(d.get('N')))) return { why: 'Named action other than a page move' };
  if (s === 'URI') {
    const u = R(d.get('URI'));
    if (!(u instanceof PdfString) || u.bytes.some((b) => b === 0 || b >= 0x80)) return { why: 'URI action whose URI is not plain ASCII' };
    let href;
    try { href = checkUrl(latin1(u.bytes), ['ftp'], 'URI'); } catch { return { why: 'URI action with an unsafe or malformed URI' }; }
    const v = new Map(d);
    v.set('URI', new PdfString(Uint8Array.from(href, (c) => c.charCodeAt(0)), true)); // what was checked is what is written
    return href === latin1(u.bytes) ? { value: v } : { value: v, rewritten: 'URI action whose URI save() would rewrite (normalised)' };
  }
  return { value: d };
}
/** @param {any} d @param {Resolve} R */
export const refuseAction = (d, R) => { const r = cleanAction(d, R); return 'why' in r ? r.why : ''; };

/**
 * A file specification (a dictionary or a string): { why } to drop it, or { value } with only the checked names and
 * one embedded stream; rewritten says why when a checked name differs from the file's (a directory part, trailing dots
 * or spaces stripped) or /EF holds two streams (one is dropped). @param {any} fs @param {Resolve} R
 * @returns {{ why: string } | { value: any, rewritten?: string }}
 */
export function cleanFile(fs, R) {
  fs = R(fs);
  if (fs instanceof PdfString) {
    let c;
    try { c = checkFileName(decodeText(fs), {}, 'attachment'); } catch { return { why: 'file specification with a refused file name' }; }
    const value = new PdfString(unhex(c.ascii), true);
    return c.name === decodeText(fs) ? { value } : { value, rewritten: REWRITTEN_NAME };
  }
  if (!(fs instanceof Map)) return { value: fs };
  const ef = R(fs.get('EF'));
  let stm = null, stmRef = null;
  if (ef instanceof Map) { stmRef = ef.get('UF') ?? ef.get('F'); stm = R(stmRef); }
  const sub = stm instanceof PdfStream ? R(stm.dict.get('Subtype')) : null;
  const mimeType = typeof sub === 'string' ? sub : null;
  /** @type {{ name: string, ascii: string }[]} */
  const checked = [];
  let rewritten = '';
  for (const k of NAME_KEYS) {
    if (!fs.has(k)) continue;
    const raw = decodeText(R(fs.get(k)));
    try { checked.push(checkFileName(raw, { mimeType }, 'attachment')); } catch { return { why: `file specification with a refused file name (/${k})` }; }
    if (checked[checked.length - 1].name !== raw) rewritten = REWRITTEN_NAME;
  }
  if (ef instanceof Map && ef.has('F') && ef.has('UF') && !sameObject(ef.get('F'), ef.get('UF'), R)) rewritten ||= 'file specification whose /EF holds two streams (save() keeps one)';
  if (!checked.length) return ef instanceof Map ? { why: 'embedded file without a name' } : { value: fs };
  const ext = (/** @type {string} */ n) => (/\.([^.]*)$/.exec(n)?.[1] ?? '').toLowerCase();
  if (checked.some((c) => ext(c.name) !== ext(checked[0].name))) return { why: 'file specification whose names disagree' };
  const v = new Map(fs);
  for (const k of NAME_KEYS) v.delete(k);
  const best = checked[0]; // /UF when present (NAME_KEYS order)
  v.set('UF', new PdfString(utf16be(best.name), true));
  v.set('F', new PdfString(unhex(best.ascii), true));
  if (ef instanceof Map) v.set('EF', new Map([['F', stmRef], ['UF', stmRef]])); // one stream: the checked one
  return rewritten ? { value: v, rewritten } : { value: v };
}
const REWRITTEN_NAME = 'file specification whose name save() would rewrite (a directory part, trailing dots or spaces)';
/** two values are one object: the same reference, or the same value @param {any} a @param {any} b @param {Resolve} R */
const sameObject = (a, b, R) => (a instanceof Ref && b instanceof Ref ? a.n === b.n : R(a) === R(b));
/** @param {any} fs @param {Resolve} R */
export const refuseFile = (fs, R) => { const r = cleanFile(fs, R); return 'why' in r ? r.why : ''; };

/** an annotation (any dictionary in an annotation's position): '' to keep, else why it is dropped @param {any} d @param {Resolve} R */
export function refuseAnnot(d, R) {
  if (!(d instanceof Map)) return 'an annotation that is not a dictionary';
  const st = R(d.get('Subtype'));
  if (typeof st !== 'string' || !KEEP_ANNOTS.has(st)) return `${typeof st === 'string' ? st.slice(0, 40) : 'untyped'} annotation`;
  if (st === 'FileAttachment') { const w = refuseFile(R(d.get('FS')), R); if (w) return `file attachment: ${w}`; }
  return '';
}

/**
 * Any dictionary met while copying or checking: { why } to drop it, or { value } to write instead (rewritten when an
 * action's URI or a file specification's names are normalised: then `rewritten` says why, for the incremental check).
 * The ONE entry point for a dictionary's own verdict.
 * @param {Map<string, any>} d @param {Resolve} R @returns {{ why: string } | { value: Map<string, any>, rewritten?: string }}
 */
export function judge(d, R) {
  if (isAction(d, R)) return cleanAction(d, R);
  if (isAnnot(d, R)) { const w = refuseAnnot(d, R); if (w) return { why: w }; }
  if (isFilespec(d, R)) return cleanFile(d, R);
  return { value: d };
}

/** @param {string} h "<hex>" */
function unhex(h) { const s = h.replace(/[<>]/g, ''); const b = new Uint8Array(s.length >> 1); for (let i = 0; i < b.length; i++) b[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return b; }
/** @param {string} s */
function utf16be(s) { const b = new Uint8Array(2 + 2 * s.length); b[0] = 0xfe; b[1] = 0xff; for (let i = 0; i < s.length; i++) { b[2 + 2 * i] = s.charCodeAt(i) >> 8; b[3 + 2 * i] = s.charCodeAt(i) & 255; } return b; }
