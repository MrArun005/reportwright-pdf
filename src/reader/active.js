// @ts-check
/**
 * Finding active content anywhere in a file's BYTES, for saveIncremental, which cannot remove bytes: an update only
 * adds a newer version of an object, and a reader that rebuilds the cross-reference by scanning, shows an earlier
 * revision or follows /Prev reaches the original again. Every object is checked — read as a repairing viewer finds
 * them (reader/source.js everyObject: the parser's own lexer over the whole file, a byte scan for any it missed,
 * every version, every object stream, every cross-reference entry) — with the copy rules THEMSELVES (reader/copy.js
 * audit → reader/policy.js, the one registry): anything save() would drop or rewrite is reported. So detection is
 * exactly as strict as stripping. Anything unreadable throws (the caller refuses: fail closed).
 */
import { createCopier } from './copy.js';

/**
 * What active content the file holds: { what, count }[] (empty when none). @param {any} self a loaded document's private side
 * @param {(n: number, v: any) => void} [each] also given every object read (every version: the signature policy reads them)
 */
export function findActive(self, each) {
  /** @type {Map<string, number>} */
  const found = new Map();
  const audit = createCopier({
    reserve: () => { throw new Error('internal: an audit copies nothing'); }, write: async () => {},
    keepActive: false, compress: false, dedupe: false, keepSignatures: true, resolveDests: false, reportRewrites: true,
    report: (w) => found.set(w, (found.get(w) ?? 0) + 1),
    page: (owner, n) => (owner === self ? n : undefined), keepStruct: () => true,
  });
  // ponytail: every object is audited; the mayBeActive byte prefilter measured no gain here (the parse dominates), so it is not trusted to skip audits
  for (const { n, v } of self.r.src.everyObject()) { each?.(n, v); audit.audit(self, v, n); }
  return [...found].map(([what, count]) => ({ what, count }));
}
