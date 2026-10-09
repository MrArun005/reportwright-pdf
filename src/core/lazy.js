// @ts-check
/**
 * What importing the library would otherwise load at once, loaded on first use instead: Node's built-ins (zlib,
 * crypto) and fflate (its Huffman tables take milliseconds to build). Importing the library loads neither.
 */
/** @type {Map<string, any>} */
const builtins = new Map();
/** A Node built-in (node:zlib, node:crypto), or undefined outside Node. @param {string} name @returns {any} */
export function builtin(name) {
  if (!builtins.has(name)) builtins.set(name, /** @type {any} */ (globalThis).process?.getBuiltinModule?.(name));
  return builtins.get(name);
}

/** @type {typeof import('fflate') | null} */
let F = null;
/** fflate, loaded once: await it before a synchronous use (fflateNow). */
export async function fflate() { return (F ??= await import('fflate')); }
/** fflate when it is loaded already, else null. */
export const fflateNow = () => F;
