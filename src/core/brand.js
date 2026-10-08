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
  if (!b || b.kind !== kind) throw new TypeError(`Not a ${what} made by this library`);
  if (b.doc !== doc) throw new TypeError(`That ${what} belongs to another PDF`);
  return b.data;
}
