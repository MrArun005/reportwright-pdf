// @ts-check
/**
 * The axial shading span in the kernel (kernel-gradients.wat). Returns false, having written nothing, unless every
 * argument is one the kernel takes exactly: the caller then runs its JS loop, which gives the same indices.
 */

/**
 * Writes the table indices of m pixels of an axial row (t at the first pixel, dt per pixel) into idx, which must lie
 * in the kernel's memory. @param {any} k the kernel (its exports and memory) or null
 * @param {Int32Array} idx @param {number} m @param {number} t @param {number} dt @param {boolean} e0 @param {boolean} e1
 * @param {number} n @param {number} out @returns {boolean}
 */
export function axialSpan(k, idx, m, t, dt, e0, e1, n, out) {
  if (!k || typeof k.axial !== 'function') return false;
  if (!(idx instanceof Int32Array) || idx.buffer !== k.memory.buffer) return false;
  if (!Number.isInteger(m) || m < 0 || m > idx.length) return false;
  if (!Number.isFinite(t) || !Number.isFinite(dt) || !Number.isFinite(n) || !Number.isInteger(out)) return false;
  if (idx.byteOffset + m * 4 > idx.buffer.byteLength) return false;
  if (m === 0) return true;
  k.axial(idx.byteOffset, m, t, dt, e0 ? 1 : 0, e1 ? 1 : 0, n, out);
  return true;
}
