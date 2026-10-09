// @ts-check
/**
 * Handles the library made. Fonts, pages, gradients and patterns are branded here when they are created, with the
 * document they belong to and (for paints) their private data; wherever a handle comes back from the caller (a fill,
 * a font, a link's page) it is looked up here, never trusted for its own properties. A forged or copied object, or one
 * from another document, throws, so no caller-made string is ever written into the PDF as raw syntax.
 */
/** @type {WeakMap<object, { kind: string, doc: any, data: any }>} */
const brands = new WeakMap();

/** @template {object} T @param {T} obj @param {string} kind @param {any} doc @param {any} [data] @returns {T} */
export function brand(obj, kind, doc, data) { brands.set(obj, { kind, doc, data }); return obj; }

/** the kind of a branded handle, or undefined @param {any} v */
export const kindOf = (v) => (v !== null && typeof v === 'object' ? brands.get(v)?.kind : undefined);

/**
 * The private data of a handle of this kind and document, or a TypeError.
 * @param {any} v @param {string} kind @param {any} doc @param {string} what as said in errors ("gradient or pattern")
 */
export function unbrand(v, kind, doc, what) {
  const b = v !== null && typeof v === 'object' ? brands.get(v) : undefined;
  if (!b || b.kind !== kind) throw new TypeError(`Not ${/^[aeiou]/i.test(what) ? 'an' : 'a'} ${what} made by this library`);
  if (b.doc !== doc) throw new TypeError(`That ${what} belongs to another PDF`);
  return b.data;
}

const MAX_SNAPSHOT = 16_000_000; // values copied by one snapshot (more than any option's own cap)

/**
 * A caller's argument read once (security: validate-then-write consistency). Plain objects and arrays are copied, each
 * own enumerable property read exactly once, so a getter (or a Proxy) cannot give the check one value and the writer
 * another, and an inherited property (Object.create({ allowTypes })) is not an option. Handles this library made, class
 * instances (pages, paths, signals, keys), typed arrays and functions are kept as they are; a Date becomes a copy of its
 * time. Every public entry point passes its arguments through here (page.js install, index.js, the form's methods).
 * @template T @param {T} v @returns {T}
 */
export function snapshot(v) {
  let count = 0;
  /** @type {Map<object, any> | null} shared and cyclic parts stay shared and cyclic */
  let seen = null;
  /** @param {any} x @returns {any} */
  const copy = (x) => {
    if (x === null || typeof x !== 'object' || brands.has(x)) return x;
    const arr = Array.isArray(x);
    if (!arr && !plain(x)) {
      if (x instanceof Date) { try { return new Date(Date.prototype.getTime.call(x)); } catch { return x; } }
      return x;
    }
    seen ??= new Map();
    const hit = seen.get(x);
    if (hit) return hit;
    if (arr) {
      const n = x.length;
      if ((count += n) > MAX_SNAPSHOT) throw new RangeError(`An argument has more than ${MAX_SNAPSHOT} values`);
      const out = new Array(n);
      seen.set(x, out);
      for (let i = 0; i < n; i++) out[i] = copy(x[i]);
      return out;
    }
    const keys = Object.keys(x);
    if ((count += keys.length) > MAX_SNAPSHOT) throw new RangeError(`An argument has more than ${MAX_SNAPSHOT} values`);
    /** @type {Record<string, any>} */
    const out = {};
    seen.set(x, out);
    for (const k of keys) {
      const val = copy(x[k]);
      if (k === '__proto__') Object.defineProperty(out, k, { value: val, enumerable: true, writable: true, configurable: true });
      else out[k] = val;
    }
    return out;
  };
  return copy(v);
}

/** an object literal (or one made with Object.create from such objects or null), not a class instance @param {object} x */
function plain(x) {
  for (let p = Object.getPrototypeOf(x); p !== null && p !== Object.prototype; p = Object.getPrototypeOf(p)) if (Object.hasOwn(p, 'constructor')) return false;
  return true;
}

/** an API object whose methods take their arguments through snapshot() @template {Record<string, any>} T @param {T} api @returns {T} */
export function guarded(api) {
  for (const [k, f] of Object.entries(api)) if (typeof f === 'function') /** @type {any} */ (api)[k] = (/** @type {any[]} */ ...a) => f.apply(api, a.map(snapshot));
  return api;
}
