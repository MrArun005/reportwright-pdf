// @ts-check
/**
 * Name trees and number trees (PDF 1.7 §7.9.6, §7.9.7), written balanced: leaves of LEAF sorted entries, then nodes of
 * LEAF kids with /Limits, up to one root (no /Limits). Small trees are one root with the entries. And the catalog's
 * /Names dictionary, shared by every module that adds a name tree (Dests here; EmbeddedFiles for group G).
 */
import { pdfName } from '../core/serialize.js';

const LEAF = 64;

/**
 * Write a tree of entries already sorted by key (each key and value is PDF text: a hex string or a number for the key,
 * any object for the value); its root's object number. @param {import('../document.js').Doc} doc
 * @param {'Names' | 'Nums'} kind @param {[string, string][]} entries
 */
export async function writeTree(doc, kind, entries) {
  /** @type {{ ref: number, first: string, last: string, body: string }[]} */
  let level = [];
  for (let i = 0; i < entries.length; i += LEAF) {
    const part = entries.slice(i, i + LEAF);
    level.push({ ref: doc.reserve(), first: part[0][0], last: part[part.length - 1][0], body: `/${kind} [${part.map(([k, v]) => `${k} ${v}`).join(' ')}]` });
  }
  while (level.length > 1) {
    const up = [];
    for (let i = 0; i < level.length; i += LEAF) {
      const kids = level.slice(i, i + LEAF);
      up.push({ ref: doc.reserve(), first: kids[0].first, last: kids[kids.length - 1].last, body: `/Kids [${kids.map((k) => `${k.ref} 0 R`).join(' ')}]` });
    }
    for (const n of level) await doc.write(n.ref, `<< ${n.body} /Limits [${n.first} ${n.last}] >>`);
    level = up;
  }
  const root = level[0] ?? { ref: doc.reserve(), body: `/${kind} []` };
  await doc.write(root.ref, `<< ${root.body} >>`);
  return root.ref;
}

/** @type {WeakMap<object, Map<string, number>>} each document's /Names entries */
const names = new WeakMap();
/** Add a tree to the catalog's /Names dictionary ('Dests', 'EmbeddedFiles'…). @param {any} doc @param {string} key @param {number} ref */
export function setNames(doc, key, ref) {
  let m = names.get(doc);
  if (!m) names.set(doc, m = new Map());
  m.set(key, ref);
  doc.catalog('Names', `<< ${[...m].map(([k, r]) => `${pdfName(k)} ${r} 0 R`).join(' ')} >>`);
}
