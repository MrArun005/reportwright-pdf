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
  MAX_SPACES = 256,
  MAX_USE = 4;

/** @typedef {{ n: number, lo: number, hi: number }} Space */
/** @typedef {{ spaces: Space[], chars: Map<number, number>, ranges: number[], wmode: number }} CMap */

/** Identity-H / Identity-V: two-byte codes, CID = code */
export const identity = (/** @type {number} */ wmode) =>
  /** @type {CMap} */ ({ spaces: [{ n: 2, lo: 0, hi: 0xffff }], chars: new Map(), ranges: [0, 0xffff, 0], wmode });

const hexOf = (/** @type {string} */ s) => {
  const h = s.replace(/[^0-9a-fA-F]/g, '');
  return { n: Math.max(1, Math.min(4, Math.ceil(h.length / 2))), v: h ? parseInt(h.slice(0, 8), 16) : 0 };
};

/**
 * @param {Uint8Array} bytes the CMap program @param {CMap | null} parent @param {(n: number) => void} tick
 * @param {{ count: number }} [used] ranges and mappings so far (with the parents)
 * @returns {CMap}
 */
export function parseCMap(bytes, parent, tick, used = { count: 0 }) {
  tick(1 + (bytes.length >> 4)); // reading it, before it is read
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  /** @type {CMap} */
  const m = {
    spaces: parent ? [...parent.spaces] : [],
    chars: new Map(parent?.chars ?? []),
    ranges: parent ? [...parent.ranges] : [],
    wmode: parent?.wmode ?? 0,
  };
  const wm = /\/WMode\s+(\d+)\s+def/.exec(text);
  if (wm) m.wmode = Number(wm[1]) === 1 ? 1 : 0;
  const more = () => {
    if (++used.count > MAX_RANGES) throw new TypeError(`CMap: more than ${MAX_RANGES} ranges and mappings`);
  };
  const block = (/** @type {string} */ name, /** @type {(body: string) => void} */ f) => {
    const re = new RegExp(`begin${name}([\\s\\S]*?)end${name}`, 'g');
    let b;
    while ((b = re.exec(text))) f(b[1]);
  };
  block('codespacerange', (body) => {
    for (const r of body.matchAll(/<([^>]*)>\s*<([^>]*)>/g)) {
      more();
      const a = hexOf(r[1]),
        b = hexOf(r[2]);
      if (m.spaces.length >= MAX_SPACES) throw new TypeError(`CMap: more than ${MAX_SPACES} code space ranges`);
      m.spaces.push({ n: a.n, lo: a.v, hi: b.v });
    }
  });
  block('cidrange', (body) => {
    for (const r of body.matchAll(/<([^>]*)>\s*<([^>]*)>\s*(\d+)/g)) {
      more();
      const lo = hexOf(r[1]).v,
        hi = hexOf(r[2]).v;
      if (hi >= lo) m.ranges.push(lo, hi, Number(r[3]));
    }
  });
  block('cidchar', (body) => {
    for (const r of body.matchAll(/<([^>]*)>\s*(\d+)/g)) (more(), m.chars.set(hexOf(r[1]).v, Number(r[2])));
  });
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
