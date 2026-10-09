// @ts-check
/**
 * Finding active content anywhere in a file's BYTES, for saveIncremental, which cannot remove bytes: an update only
 * adds a newer version of an object, and a reader that rebuilds the cross-reference by scanning, shows an earlier
 * revision or follows /Prev reaches the original again. So the whole file is checked (every "n g obj" in the bytes,
 * every version, objects nothing refers to, every object in every object stream) with the rules save() copies by
 * (reader/copy.js): the action allowlist wherever an action can be (/A, /OpenAction, /Next and its arrays, /PA, a
 * /Type /Action, and any dictionary whose /S is a known action type outside the allowlist), the annotation allowlist,
 * /AA, /JS, /Names /JavaScript and XFA. Nothing recurses. Any error while checking is thrown (fail closed).
 */
import { PdfStream } from './lexer.js';
import { refuseAction, refuseAnnot, isAnnot, ACTION_KEYS, KEEP_ACTIONS } from './copy.js';

/** every action type of ISO 32000-2 §12.6.4 (a dictionary with one of these as /S is an action, wherever it is) */
const ACTION_TYPES = new Set(['GoTo', 'GoToR', 'GoToE', 'GoToDp', 'Launch', 'Thread', 'URI', 'Sound', 'Movie', 'Hide', 'Named', 'SubmitForm', 'ResetForm', 'ImportData', 'SetOCGState', 'Rendition', 'Trans', 'GoTo3DView', 'JavaScript', 'RichMediaExecute', 'ECMAScript']);

/**
 * What active content the file's bytes hold: { what, count }[] (empty when none). @param {import('./source.js').Source} src
 */
export function findActive(src) {
  const R = src.resolve;
  /** @type {Map<string, number>} */
  const found = new Map();
  const hit = (/** @type {string} */ w) => found.set(w, (found.get(w) ?? 0) + 1);
  for (const { v } of src.everyObject()) {
    const stack = [v instanceof PdfStream ? v.dict : v];
    while (stack.length) {
      const x = stack.pop();
      src.budget.tick();
      if (Array.isArray(x)) { for (const y of x) if (y instanceof Map || Array.isArray(y)) stack.push(y); continue; }
      if (!(x instanceof Map)) continue;
      for (const k of ['AA', 'JS', 'JavaScript', 'XFA']) if (x.has(k)) hit({ AA: 'additional actions (/AA)', JS: 'JavaScript (/JS)', JavaScript: 'document JavaScript (/Names /JavaScript)', XFA: 'XFA form (scripts)' }[k] ?? k);
      const s = x.get('S');
      if (x.get('Type') === 'Action' || (typeof s === 'string' && ACTION_TYPES.has(s) && !KEEP_ACTIONS.has(s))) { const why = refuseAction(x, R); if (why) hit(why); }
      else if (typeof s === 'string' && s === 'URI') { const why = refuseAction(x, R); if (why) hit(why); }
      if (isAnnot(x, R)) { const why = refuseAnnot(x, R); if (why) hit(why); }
      for (const k of ACTION_KEYS) {
        if (!x.has(k) || (k === 'Next' && !x.has('S'))) continue; // an outline item's /Next is its sibling
        const a = R(x.get(k));
        for (const y of Array.isArray(a) ? a.slice(0, 1000).map(R) : [a]) { const why = refuseAction(y, R); if (why) hit(why); }
      }
      const an = R(x.get('Annots'));
      if (Array.isArray(an)) for (const y of an.slice(0, 100_000)) { const a = R(y); if (a instanceof Map) { const why = refuseAnnot(a, R); if (why) hit(why); } }
      for (const y of x.values()) if (y instanceof Map || Array.isArray(y)) stack.push(y);
    }
  }
  return [...found].map(([what, count]) => ({ what, count }));
}
