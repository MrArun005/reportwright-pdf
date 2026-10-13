// @ts-check
/**
 * Type 1 fonts (PDF /FontFile; Adobe Type 1 Font Format): the cleartext part's FontMatrix and Encoding, the eexec
 * part decrypted, its Subrs and CharStrings found, and each charstring run (on first use) into an outline: path ops
 * (0 moveTo, 1 lineTo, 2 curveTo, 3 close) in character space. Flex and hint replacement (othersubrs 0–3) and seac
 * accents (by StandardEncoding code, one level) are followed. PFB segments and hex eexec are read too.
 *
 * HOSTILE: the eexec part is at most MAX_EEXEC bytes; at most MAX_GLYPHS charstrings and MAX_SUBRS subrs, each at
 * most 65,535 bytes; a glyph runs at most MAX_OPS operators (subroutines included), with an operand stack of at most
 * MAX_STACK, subroutines nested at most MAX_DEPTH deep (an explicit stack, no recursion) and seac one level only.
 */
import { STANDARD_ENCODING } from '../fonts/names.js';
import { Tokens } from './ps-tokens.js';

export const MAX_EEXEC = 16 * 1024 * 1024,
  MAX_GLYPHS = 65536,
  MAX_SUBRS = 65536,
  MAX_OPS = 100_000,
  MAX_STACK = 48,
  MAX_DEPTH = 10;

const bad = (/** @type {string} */ m) => new TypeError(`Type 1 font: ${m}`);

/** eexec / charstring decryption (r: 55665 eexec, 4330 charstrings); n leading bytes dropped @param {Uint8Array} b @param {number} r @param {number} n */
function decrypt(b, r, n) {
  const out = new Uint8Array(Math.max(0, b.length - n));
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (i >= n) out[i - n] = c ^ (r >> 8);
    r = ((c + r) * 52845 + 22719) & 0xffff;
  }
  return out;
}

const isHex = (/** @type {number} */ c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const isSpace = (/** @type {number} */ c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 0;

/** the font file → [cleartext, encrypted binary] @param {Uint8Array} b @param {number} len1 */
function split(b, len1) {
  // PFB: segments 0x80 type len(4, little-endian)
  if (b[0] === 0x80 && b[1] === 1) {
    /** @type {Uint8Array[]} */ const parts = [[], [], []].map(() => new Uint8Array(0));
    const seen = [[], []].map(() => /** @type {Uint8Array[]} */ ([]));
    for (let p = 0; p + 6 <= b.length && b[p] === 0x80 && b[p + 1] !== 3;) {
      const t = b[p + 1],
        n = b[p + 2] | (b[p + 3] << 8) | (b[p + 4] << 16) | (b[p + 5] << 24);
      if (n < 0 || p + 6 + n > b.length) throw bad('a PFB segment runs past the file');
      if (t === 1 || t === 2) seen[t - 1].push(b.subarray(p + 6, p + 6 + n));
      p += 6 + n;
    }
    const join = (/** @type {Uint8Array[]} */ l) => {
      const o = new Uint8Array(l.reduce((s, x) => s + x.length, 0));
      let q = 0;
      for (const x of l) (o.set(x, q), (q += x.length));
      return o;
    };
    ((parts[0] = join(seen[0])), (parts[1] = join(seen[1])));
    return [parts[0], parts[1]];
  }
  // cleartext up to "eexec" (Length1 when it points just past it), then the encrypted part
  let e = -1;
  const lim = Math.min(b.length, len1 > 0 && len1 <= b.length ? len1 + 16 : b.length);
  for (let i = 0; i + 5 <= lim; i++)
    if (b[i] === 101 && b[i + 1] === 101 && b[i + 2] === 120 && b[i + 3] === 101 && b[i + 4] === 99) {
      e = i + 5;
      break;
    }
  if (e < 0) throw bad('no eexec section');
  let p = e;
  while (p < b.length && isSpace(b[p])) p++;
  const clear = b.subarray(0, e),
    rest = b.subarray(p);
  if (rest.length > 2 * MAX_EEXEC) throw bad(`the eexec part is over ${MAX_EEXEC} bytes`); // (hex: two digits a byte)
  // hex eexec: the first four bytes hex digits
  if (rest.length >= 4 && isHex(rest[0]) && isHex(rest[1]) && isHex(rest[2]) && isHex(rest[3])) {
    const o = new Uint8Array(rest.length >> 1);
    let n = 0,
      hi = -1;
    for (const c of rest) {
      if (!isHex(c)) {
        if (isSpace(c)) continue;
        break;
      }
      const v = c <= 57 ? c - 48 : (c | 32) - 87;
      if (hi < 0) hi = v;
      else ((o[n++] = (hi << 4) | v), (hi = -1));
    }
    return [clear, o.subarray(0, n)];
  }
  return [clear, rest];
}

/**
 * @param {Uint8Array} file the /FontFile stream's bytes @param {number} len1 its /Length1
 * @param {(n: number) => void} tick a budget step per unit of work
 * @returns {{ glyph: (name: string) => number[], has: (name: string) => boolean, encoding: (string | undefined)[], fmx: number[] }}
 */
export function type1Font(file, len1, tick) {
  const [clearB, enc] = split(file, len1);
  if (enc.length > MAX_EEXEC) throw bad(`the eexec part is over ${MAX_EEXEC} bytes`);
  tick(1 + (enc.length >> 4) + (clearB.length >> 6)); // decrypting and scanning, before it is done
  // the cleartext, one pass over its tokens: FontMatrix (default 0.001) and the built-in Encoding
  let fmx = [0.001, 0, 0, 0.001, 0, 0];
  /** @type {(string | undefined)[]} */
  let encoding = STANDARD_ENCODING.map((n) => n || undefined);
  {
    const tk = new Tokens(clearB);
    /** @type {import('./ps-tokens.js').Token[]} */
    const last = [];
    const custom = /** @type {(string | undefined)[]} */ ([]);
    let puts = 0,
      std = false;
    for (let t = tk.next(); t; t = tk.next()) {
      if (t.k === 'name' && t.v === '/FontMatrix') {
        const open = tk.next();
        if (open?.k === 'punct' && (open.v === '[' || open.v === '{')) {
          const v = [];
          for (let u = tk.next(); u && u.k === 'num' && v.length < 7; u = tk.next()) v.push(Number(u.v));
          if (v.length === 6 && v.every(Number.isFinite) && v[0] * v[3] - v[1] * v[2] !== 0) fmx = v;
        }
        continue;
      }
      if (t.k === 'word' && t.v === 'StandardEncoding' && last[last.length - 1]?.v === '/Encoding') std = true;
      // dup <code> /<name> put
      if (t.k === 'word' && t.v === 'put' && last.length >= 3) {
        const [d, c, n] = last.slice(-3);
        if (d.v === 'dup' && c.k === 'num' && n.k === 'name' && puts < 256) {
          const code = Number(c.v);
          if (Number.isInteger(code) && code >= 0 && code < 256) ((custom[code] = n.v.slice(1)), puts++);
        }
      }
      last.push(t);
      if (last.length > 3) last.shift();
    }
    if (!std && puts) encoding = custom;
  }
  const priv = decrypt(enc, 55665, 4);
  // the private part, one pass over its tokens: /lenIV, and each "… n RD <n binary bytes>" (RD may be -|): a subr
  // after "dup i", a glyph after "/name" once /CharStrings is seen; the binary bytes are stepped over, never scanned
  let lenIV = 4;
  const subrs = /** @type {Uint8Array[]} */ ([]);
  /** @type {Map<string, Uint8Array>} */
  const glyphs = new Map();
  {
    const tk = new Tokens(priv);
    /** @type {import('./ps-tokens.js').Token[]} */
    const last = [];
    let inGlyphs = false,
      nsub = 0;
    for (let t = tk.next(); t; t = tk.next()) {
      if (t.k === 'name' && t.v === '/CharStrings') inGlyphs = true;
      if (t.k === 'num' && last[last.length - 1]?.v === '/lenIV') lenIV = Number(t.v);
      if (t.k === 'word' && (t.v === 'RD' || t.v === '-|') && last.length >= 2) {
        const n = Number(last[last.length - 1].v),
          key = last[last.length - 2],
          s0 = t.e + 1;
        if (last[last.length - 1].k !== 'num' || !(Number.isInteger(n) && n >= 0 && n <= 65535) || s0 + n > priv.length)
          break;
        if (inGlyphs && key.k === 'name') {
          if (glyphs.size >= MAX_GLYPHS) throw bad(`more than ${MAX_GLYPHS} CharStrings`);
          glyphs.set(key.v.slice(1), priv.subarray(s0, s0 + n));
        } else if (!inGlyphs && key.k === 'num' && last[last.length - 3]?.v === 'dup') {
          const k = Number(key.v);
          if (++nsub > MAX_SUBRS) throw bad(`more than ${MAX_SUBRS} Subrs`);
          if (Number.isInteger(k) && k >= 0 && k < MAX_SUBRS) subrs[k] = priv.subarray(s0, s0 + n);
        }
        tk.pos = s0 + n; // past the binary
        last.length = 0;
        continue;
      }
      last.push(t);
      if (last.length > 3) last.shift();
    }
    if (!inGlyphs) throw bad('no CharStrings');
  }
  if (!(lenIV >= -1 && lenIV <= 64)) throw bad('lenIV out of range');
  const plain = (/** @type {Uint8Array} */ b) => (lenIV < 0 ? b : decrypt(b, 4330, lenIV));
  const subrPlain = new Map();
  const subr = (/** @type {number} */ i) => {
    let p = subrPlain.get(i);
    if (!p && subrs[i]) subrPlain.set(i, (p = plain(subrs[i])));
    return p;
  };

  /** run a charstring into out; seac: allowed one level @param {string} name @param {number} ox @param {number} oy @param {number[]} out @param {boolean} top */
  const draw = (name, ox, oy, out, top) => {
    const cs0 = glyphs.get(name);
    if (!cs0) return;
    const st = /** @type {number[]} */ ([]),
      ps = /** @type {number[]} */ ([]),
      calls = /** @type {[Uint8Array, number][]} */ ([]);
    let b = plain(cs0),
      p = 0,
      x = ox,
      y = oy,
      sbx = 0,
      open = false,
      ops = 0,
      flex = /** @type {number[] | null} */ (null);
    const push = (/** @type {number} */ v) => {
      if (st.length >= MAX_STACK) throw bad('operand stack over the limit');
      st.push(v);
    };
    const moveTo = () => {
      if (flex) return void flex.push(x, y);
      if (open) out.push(3);
      out.push(0, x, y);
      open = true;
    };
    const lineTo = () => out.push(1, x, y);
    const curve = (/** @type {number[]} */ d) => {
      const x1 = x + d[0],
        y1 = y + d[1],
        x2 = x1 + d[2],
        y2 = y1 + d[3];
      ((x = x2 + d[4]), (y = y2 + d[5]));
      out.push(2, x1, y1, x2, y2, x, y);
    };
    for (;;) {
      if (p >= b.length) {
        if (!calls.length) break;
        [b, p] = /** @type {[Uint8Array, number]} */ (calls.pop());
        continue;
      }
      const v = b[p++];
      if (v >= 32) {
        if (v <= 246) push(v - 139);
        else if (v <= 250) push((v - 247) * 256 + (b[p++] ?? 0) + 108);
        else if (v <= 254) push(-(v - 251) * 256 - (b[p++] ?? 0) - 108);
        else (push((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3] | 0), (p += 4));
        continue;
      }
      if (++ops > MAX_OPS) throw bad(`a glyph runs more than ${MAX_OPS} operators`);
      const n = st.length;
      const arg = (/** @type {number} */ i) => st[n - i] ?? 0; // i-th from the top (1 = last)
      switch (v) {
        case 13: // hsbw sbx wx
          ((sbx = st[0] ?? 0), (x = ox + sbx), (y = oy));
          break;
        case 21:
          ((x += st[0] ?? 0), (y += st[1] ?? 0), moveTo());
          break;
        case 22:
          ((x += st[0] ?? 0), moveTo());
          break;
        case 4:
          ((y += st[0] ?? 0), moveTo());
          break;
        case 5:
          ((x += st[0] ?? 0), (y += st[1] ?? 0), lineTo());
          break;
        case 6:
          ((x += st[0] ?? 0), lineTo());
          break;
        case 7:
          ((y += st[0] ?? 0), lineTo());
          break;
        case 8:
          curve([0, 1, 2, 3, 4, 5].map((i) => st[i] ?? 0));
          break;
        case 30: // vhcurveto dy1 dx2 dy2 dx3
          curve([0, st[0] ?? 0, st[1] ?? 0, st[2] ?? 0, st[3] ?? 0, 0]);
          break;
        case 31: // hvcurveto dx1 dx2 dy2 dy3
          curve([st[0] ?? 0, 0, st[1] ?? 0, st[2] ?? 0, 0, st[3] ?? 0]);
          break;
        case 9:
          if (open) (out.push(3), (open = false));
          break;
        case 10: {
          // callsubr: the subr number on top
          const s = subr(st.pop() ?? -1);
          if (calls.length >= MAX_DEPTH) throw bad('subrs nest too deep');
          if (s) (calls.push([b, p]), (b = s), (p = 0));
          continue; // the stack keeps its other operands
        }
        case 11: // return
          if (calls.length) [b, p] = /** @type {[Uint8Array, number]} */ (calls.pop());
          continue;
        case 14: // endchar
          if (open) (out.push(3), (open = false));
          return;
        case 1:
        case 3:
          break;
        case 12: {
          const e = b[p++];
          if (e === 6) {
            // seac asb adx ady bchar achar: the base, then the accent offset by adx - asb
            if (!top) throw bad('seac inside seac');
            const [asb = 0, adx = 0, ady = 0, bc = 0, ac = 0] = st;
            const bn = STANDARD_ENCODING[bc],
              an = STANDARD_ENCODING[ac];
            if (open) (out.push(3), (open = false));
            if (bn) draw(bn, ox, oy, out, false);
            if (an) draw(an, ox + sbx + adx - asb, oy + ady, out, false);
            return;
          }
          if (e === 7) {
            // sbw sbx sby wx wy
            ((sbx = st[0] ?? 0), (x = ox + sbx), (y = oy + (st[1] ?? 0)));
          } else if (e === 12) {
            // div: the two on top
            const d = st.pop() ?? 1,
              q = st.pop() ?? 0;
            push(d ? q / d : 0);
            continue;
          } else if (e === 16) {
            // callothersubr: args… n othersubr#
            const k = st.pop() ?? 0,
              cnt = Math.max(0, Math.min(st.length, st.pop() ?? 0));
            const args = st.splice(st.length - cnt, cnt);
            if (k === 1) flex = [];
            else if (k === 0 && flex) {
              // flex: the reference point, then six points → two curves; the end point is the current point
              const f = flex;
              flex = null;
              if (f.length >= 14) {
                out.push(2, f[2], f[3], f[4], f[5], f[6], f[7], 2, f[8], f[9], f[10], f[11], f[12], f[13]);
                ((x = f[12]), (y = f[13]));
              }
              ps.length = 0;
              ps.push(y - oy, x - ox); // pop pop → x y (setcurrentpoint, which adds the origin back)
            } else if (k === 3)
              ((ps.length = 0), ps.push(3)); // hint replacement: callsubr 3
            else if (k !== 2) ((ps.length = 0), ps.push(...args.reverse()));
            continue;
          } else if (e === 17) {
            // pop: one result from the othersubr
            push(ps.length ? /** @type {number} */ (ps.pop()) : 0);
            continue;
          } else if (e === 33) {
            // setcurrentpoint x y
            ((x = ox + (st[0] ?? 0)), (y = oy + (st[1] ?? 0)));
          }
          // dotsection (0), vstem3 (1), hstem3 (2): nothing to draw
          break;
        }
        default:
          break;
      }
      st.length = 0;
    }
    if (open) out.push(3);
  };
  return {
    glyph: (name) => {
      /** @type {number[]} */ const out = [];
      draw(name, 0, 0, out, true);
      tick(1 + (out.length >> 4));
      return out;
    },
    has: (name) => glyphs.has(name),
    encoding,
    fmx,
  };
}
