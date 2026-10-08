// @ts-check
/**
 * MD5 of bytes, as 32 hex digits (RFC 1321). For an embedded file's /CheckSum, which PDF defines as MD5; not for
 * security. Plain JS so it runs in browsers too (no node:crypto).
 */
const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0);

/** @param {Uint8Array} bytes @returns {string} */
export function md5(bytes) {
  const n = bytes.length, total = ((n + 8) >>> 6) + 1 << 6; // padded length: a multiple of 64
  const tail = new Uint8Array(total - (n & ~63));
  tail.set(bytes.subarray(n & ~63));
  tail[n & 63] = 0x80;
  const dv = new DataView(tail.buffer);
  dv.setUint32(tail.length - 8, n * 8 >>> 0, true);
  dv.setUint32(tail.length - 4, Math.floor(n / 2 ** 29), true);
  let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
  const M = new Int32Array(16);
  const block = (/** @type {Uint8Array} */ src, /** @type {number} */ at) => {
    for (let j = 0; j < 16; j++) { const p = at + j * 4; M[j] = src[p] | src[p + 1] << 8 | src[p + 2] << 16 | src[p + 3] << 24; }
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (b | ~d); g = (7 * i) & 15; }
      const t = (a + f + K[i] + M[g]) | 0;
      a = d; d = c; c = b; b = (b + (t << S[i] | t >>> (32 - S[i]))) | 0;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  };
  for (let at = 0; at + 64 <= (n & ~63); at += 64) block(bytes, at);
  for (let at = 0; at < tail.length; at += 64) block(tail, at);
  let h = '';
  for (const w of [a0, b0, c0, d0]) for (let k = 0; k < 4; k++) h += ((w >>> (8 * k)) & 255).toString(16).padStart(2, '0');
  return h;
}
