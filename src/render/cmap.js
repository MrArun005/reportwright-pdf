// @ts-check
/**
 * Embedded CMaps (PDF 32000-1 §9.7.5; Adobe tech note 5014): code space ranges, cidchar / cidrange mappings, WMode,
 * and a parent by usecmap (an embedded stream's /UseCMap, or Identity-H / Identity-V by name). Predefined CJK CMaps
 * by name are not bundled (keeping the core small): a Type 0 font naming one draws nothing unless its name is
 * Identity-H / Identity-V.
 *
 * HOSTILE: at most MAX_RANGES mappings and MAX_SPACES code space ranges in a CMap and its parents together, parents
 * at most MAX_USE deep (a loop stops there), codes at most 4 bytes; ranges are looked up by binary search (sorted
 * once), so a code costs O(log n) whatever the CMap.
 */
export const MAX_RANGES = 200_000,
  /** a CMap program's bytes at most */
  MAX_CMAP_BYTES = 16 * 1024 * 1024,
  MAX_SPACES = 256,
  MAX_USE = 4;

import { Tokens, hexToken } from './ps-tokens.js';

/** @typedef {{ n: number, lo: number, hi: number }} Space */
/** @typedef {{ spaces: Space[], chars: Map<number, number>, ranges: number[], wmode: number }} CMap */

/** Identity-H / Identity-V: two-byte codes, CID = code */
export const identity = (/** @type {number} */ wmode) =>
  /** @type {CMap} */ ({ spaces: [{ n: 2, lo: 0, hi: 0xffff }], chars: new Map(), ranges: [0, 0xffff, 0], wmode });

/**
 * @param {Uint8Array} bytes the CMap program @param {CMap | null} parent @param {(n: number) => void} tick
 * @param {{ count: number }} [used] ranges and mappings so far (with the parents)
 * @returns {CMap}
 */
export function parseCMap(bytes, parent, tick, used = { count: 0 }) {
  if (bytes.length > MAX_CMAP_BYTES) throw new TypeError(`CMap: over ${MAX_CMAP_BYTES} bytes`);
  // reading it, and copying what its parent holds, before either is done
  tick(1 + (bytes.length >> 4) + (parent ? parent.chars.size + parent.ranges.length / 3 + parent.spaces.length : 0));
  /** @type {CMap} */
  const m = {
    spaces: parent ? [...parent.spaces] : [],
    chars: new Map(parent?.chars ?? []),
    ranges: parent ? [...parent.ranges] : [],
    wmode: parent?.wmode ?? 0,
  };
  const more = () => {
    if (++used.count > MAX_RANGES) throw new TypeError(`CMap: more than ${MAX_RANGES} ranges and mappings`);
  };
  // one pass over the tokens: inside a begin…end block, its operands in groups
  const tk = new Tokens(bytes);
  /** @type {string} */
  let block = '';
  /** @type {import('./ps-tokens.js').Token[]} */
  let ops = [];
  let lastName = '';
  for (let t = tk.next(); t; t = tk.next()) {
    if (t.k === 'word') {
      if (t.v === 'begincodespacerange' || t.v === 'begincidrange' || t.v === 'begincidchar')
        ((block = t.v.slice(5)), (ops = []));
      else if (t.v.startsWith('end')) ((block = ''), (ops = []));
      continue;
    }
    if (t.k === 'name') {
      lastName = t.v;
      continue;
    }
    if (t.k === 'num' && lastName === '/WMode' && !block) {
      m.wmode = t.v === '1' ? 1 : 0;
      lastName = '';
      continue;
    }
    if (!block || (t.k !== 'hex' && t.k !== 'num')) continue;
    ops.push(t);
    if (block === 'codespacerange' && ops.length === 2) {
      if (ops[0].k === 'hex' && ops[1].k === 'hex') {
        more();
        if (m.spaces.length >= MAX_SPACES) throw new TypeError(`CMap: more than ${MAX_SPACES} code space ranges`);
        const a = hexToken(ops[0].v),
          b = hexToken(ops[1].v);
        m.spaces.push({ n: a.n, lo: a.v, hi: b.v });
      }
      ops = [];
    } else if (block === 'cidrange' && ops.length === 3) {
      if (ops[0].k === 'hex' && ops[1].k === 'hex' && ops[2].k === 'num') {
        more();
        const lo = hexToken(ops[0].v).v,
          hi = hexToken(ops[1].v).v;
        if (hi >= lo) m.ranges.push(lo, hi, Number(ops[2].v));
      }
      ops = [];
    } else if (block === 'cidchar' && ops.length === 2) {
      if (ops[0].k === 'hex' && ops[1].k === 'num') (more(), m.chars.set(hexToken(ops[0].v).v, Number(ops[1].v)));
      ops = [];
    }
  }
  tick(1 + used.count);
  // ranges sorted by start (a later one first among equal starts: a child's over its parent's), for binary search
  const idx = Array.from({ length: m.ranges.length / 3 }, (_, k) => k);
  idx.sort((x, y) => m.ranges[3 * x] - m.ranges[3 * y] || y - x);
  m.ranges = idx.flatMap((k) => [m.ranges[3 * k], m.ranges[3 * k + 1], m.ranges[3 * k + 2]]);
  return m;
}
/** the CID of a code from the sorted ranges (the last range starting at or before it, if it holds it) @param {number[]} R @param {number} code */
function rangeCid(R, code) {
  let lo = 0,
    hi = R.length / 3 - 1,
    best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (R[3 * mid] <= code) ((best = mid), (lo = mid + 1));
    else hi = mid - 1;
  }
  // ranges starting at or before the code, nearest first (a few: overlapping ranges are rare)
  for (let k = best, n = 0; k >= 0 && n < 16; k--, n++) if (code <= R[3 * k + 1]) return R[3 * k + 2] + code - R[3 * k];
  return 0;
}

/** a CMap's codes in bytes → [cid, a one-byte code 32 (word spacing)] @param {CMap} m @param {Uint8Array} b */
export function decodeCodes(m, b) {
  /** @type {[number, boolean][]} */
  const out = [];
  for (let i = 0; i < b.length;) {
    let code = 0,
      n = 0,
      hit = false;
    for (n = 1; n <= 4 && i + n <= b.length; n++) {
      code = code * 256 + b[i + n - 1];
      for (const s of m.spaces)
        if (s.n === n && code >= s.lo && code <= s.hi) {
          hit = true;
          break;
        }
      if (hit) break;
    }
    if (!hit) ((n = 1), (code = b[i])); // no code space holds it: one byte, CID 0
    const cid = hit ? (m.chars.get(code) ?? rangeCid(m.ranges, code)) : 0;
    out.push([cid, n === 1 && code === 32]);
    i += n;
  }
  return out;
}
