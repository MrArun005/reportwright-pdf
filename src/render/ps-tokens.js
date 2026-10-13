// @ts-check
/**
 * A linear tokenizer for the PostScript-like text of font programs and CMaps (no regular expressions: each byte is
 * looked at a bounded number of times). Tokens: name (/x), num, hex (<…>), str ((…), skipped), punct ([ ] { }),
 * word (anything else, << and >> included). % comments are skipped. The caller may move `pos` (past binary data).
 */
const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;

/** @typedef {{ k: 'name' | 'num' | 'hex' | 'str' | 'punct' | 'word', v: string, s: number, e: number }} Token */

export class Tokens {
  /** @param {Uint8Array} b @param {number} [p] @param {number} [end] */
  constructor(b, p = 0, end = b.length) {
    this.b = b;
    this.pos = p;
    this.end = Math.min(end, b.length);
  }
  /** @returns {Token | null} */
  next() {
    const b = this.b,
      e = this.end;
    let p = this.pos;
    for (;;) {
      while (p < e && WS[b[p]]) p++;
      if (p < e && b[p] === 37) {
        while (p < e && b[p] !== 10 && b[p] !== 13) p++;
        continue;
      }
      break;
    }
    if (p >= e) return ((this.pos = p), null);
    const s = p,
      c = b[p];
    /** @type {Token['k']} */
    let k;
    if (c === 47) {
      p++;
      while (p < e && !WS[b[p]] && !DELIM[b[p]]) p++;
      k = 'name';
    } else if (c === 60 && b[p + 1] !== 60) {
      p++;
      while (p < e && b[p] !== 62) p++;
      p++;
      k = 'hex';
    } else if (c === 40) {
      // a string: nested parentheses, backslash escapes
      let depth = 0;
      for (; p < e; p++) {
        if (b[p] === 92) p++;
        else if (b[p] === 40) depth++;
        else if (b[p] === 41 && --depth === 0) {
          p++;
          break;
        }
      }
      k = 'str';
    } else if (c === 91 || c === 93 || c === 123 || c === 125) {
      p++;
      k = 'punct';
    } else if ((c === 60 && b[p + 1] === 60) || (c === 62 && b[p + 1] === 62)) {
      p += 2;
      k = 'word';
    } else {
      p++;
      while (p < e && !WS[b[p]] && !DELIM[b[p]]) p++;
      k = 'word';
    }
    this.pos = Math.min(p, e);
    let v = '';
    const n = Math.min(this.pos, s + 128); // a token's text: at most 128 characters
    for (let i = s; i < n; i++) v += String.fromCharCode(b[i]);
    if (k === 'word' && isNum(v)) k = 'num';
    return { k, v, s, e: this.pos };
  }
}

/** [+-] digits [. digits] (at least one digit) @param {string} v */
function isNum(v) {
  let i = v[0] === '+' || v[0] === '-' ? 1 : 0,
    digits = 0,
    dot = false;
  for (; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c >= 48 && c <= 57) digits++;
    else if (c === 46 && !dot) dot = true;
    else return false;
  }
  return digits > 0;
}
/** a hex token's value and byte count (at most 4 bytes) @param {string} v the token text, <…> */
export function hexToken(v) {
  let h = '';
  for (let i = 1; i < v.length && h.length < 8; i++) {
    const c = v.charCodeAt(i);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)) h += v[i];
  }
  return { n: Math.max(1, Math.ceil(h.length / 2)), v: h ? parseInt(h, 16) : 0 };
}
