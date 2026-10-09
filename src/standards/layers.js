// @ts-check
/**
 * Optional content (layers). pdf.layer(name, { visible, printable, locked }) → a branded handle (an OCG, written at
 * once); page.layer(layer, fn): what fn draws is in that layer (/OC /MCn BDC … EMC, the OCG a Properties resource).
 * At the end, the catalog's /OCProperties: /OCGs, and the default configuration /D with /Name, /Order (every layer),
 * /ON, /OFF and /Locked. A print-only (visible false, printable true) or screen-only (visible true, printable false)
 * layer gets /Usage and the /D /AS auto-states for the View and Print events.
 *
 * PDF/A-1 forbids optional content (refused). PDF/A-2 and 3 forbid /AS in a configuration (ISO 19005-2 6.9), so there a
 * layer prints exactly when it shows: visible and printable must agree (refused otherwise).
 * SECURITY: names are hex text strings; the handle is looked up in the brand table (never its own properties); at
 * most MAX_LAYERS layers and MAX_NEST nested page.layer calls; save()/restore() must balance inside fn.
 */
import { text } from '../core/serialize.js';
import { brand, unbrand } from '../core/brand.js';
import { refuseInA1 } from './level.js';
import { state } from '../graphics/draw.js';

export const MAX_LAYERS = 10_000;
const MAX_NEST = 32;

/** @param {import('../document.js').Doc} doc */
export function createLayers(doc) {
  /** @type {{ ref: number, visible: boolean, printable: boolean, locked: boolean }[]} */
  const all = [];
  doc.onFinish(async () => {
    if (!all.length) return;
    const refs = (/** @type {typeof all} */ a) => a.map((l) => `${l.ref} 0 R`).join(' ');
    const off = all.filter((l) => !l.visible), locked = all.filter((l) => l.locked);
    const view = all.filter((l) => l.visible !== l.printable);
    const as = view.length ? ` /AS [<< /Event /View /OCGs [${refs(view)}] /Category [/View] >> << /Event /Print /OCGs [${refs(view)}] /Category [/Print] >>]` : '';
    doc.catalog('OCProperties', `<< /OCGs [${refs(all)}] /D << /Name ${text('Default')} /Order [${refs(all)}] /ON [${refs(all.filter((l) => l.visible))}] /OFF [${refs(off)}]${locked.length ? ` /Locked [${refs(locked)}]` : ''}${as} >> >>`);
  });

  /** @param {any} name @param {{ visible?: boolean, printable?: boolean, locked?: boolean }} [o] */
  return function layer(name, o = {}) {
    const who = 'pdf.layer';
    refuseInA1(doc, who, 'forbids optional content (layers)');
    if (typeof name !== 'string' || !name.trim() || name.length > 1024) throw new TypeError(`${who}: name is a non-empty string of at most 1,024 characters`);
    if (o == null || typeof o !== 'object') throw new TypeError(`${who}: options are { visible, printable, locked }`);
    for (const k of ['visible', 'printable', 'locked']) if (/** @type {any} */ (o)[k] != null && typeof (/** @type {any} */ (o)[k]) !== 'boolean') throw new TypeError(`${who}: ${k} is true or false`);
    const visible = o.visible ?? true, printable = o.printable ?? visible, locked = o.locked ?? false;
    if (doc.pdfa && visible !== printable) throw new TypeError(`${who}: PDF/A forbids the auto-states (/AS) that make a layer print-only or screen-only (ISO 19005-2 6.9): visible and printable must agree`);
    if (all.length >= MAX_LAYERS) throw new RangeError(`${who}: at most ${MAX_LAYERS} layers`);
    const ref = doc.reserve();
    const usage = visible !== printable ? ` /Usage << /View << /ViewState /${visible ? 'ON' : 'OFF'} >> /Print << /PrintState /${printable ? 'ON' : 'OFF'} >> >>` : '';
    const dict = `<< /Type /OCG /Name ${text(name)}${usage} >>`;
    doc.serial(async () => { await doc.write(ref, dict); }).catch(() => {}); // a failure fails the document (doc.serial)
    all.push({ ref, visible, printable, locked });
    const res = doc.resource('Properties', `${ref} 0 R`);
    return brand(Object.freeze({ type: 'layer', name }), 'layer', doc, { res });
  };
}

/** @type {WeakMap<object, number>} page → page.layer nesting depth */
const depth = new WeakMap();

/**
 * page.layer(layer, fn): what fn draws (synchronously) belongs to the layer. @this {any} @template T @param {any} layer
 * @param {() => T} fn @returns {T}
 */
export function pageLayer(layer, fn) {
  const { res } = unbrand(layer, 'layer', this.doc, 'layer (pdf.layer)');
  if (typeof fn !== 'function') throw new TypeError('page.layer: fn is a function that draws');
  const d = depth.get(this) ?? 0;
  if (d >= MAX_NEST) throw new RangeError(`page.layer: at most ${MAX_NEST} nested layers`);
  const c = this.content, saves = state(this).stack.length;
  c.closeMarked(); c.et();
  c.s += `/OC /${res} BDC\n`;
  depth.set(this, d + 1);
  try {
    const r = fn();
    if (r && typeof (/** @type {any} */ (r)).then === 'function') throw new TypeError('page.layer: fn must draw synchronously (no async function)');
    if (state(this).stack.length !== saves) throw new TypeError('page.layer: save() and restore() must balance inside fn (marked content and the graphics state nest)');
    return r;
  } finally {
    depth.set(this, d);
    c.closeMarked(); c.et();
    c.s += 'EMC\n';
  }
}
