// @ts-check
/** Page methods: straight lines and rectangles. `this` is a Page (page.js); coordinates top-left, y down. */
import { num } from '../core/serialize.js';
import { colorOp } from './color.js';
import { gstate } from './draw.js';

/**
 * @this {import('../page.js').Page}
 * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
 * @param {{ color?: any, width?: number, dash?: number[], opacity?: number, blendMode?: string }} [o] opacity and blendMode: an ExtGState inside q/Q, as page.stroke
 */
export function line(x1, y1, x2, y2, o = {}) {
  const c = this.content, H = this.height;
  const gs = gstate(this, o);
  c.draw(); c.et();
  if (gs) { c.q(); c.s += gs; }
  c.stroke(colorOp(o.color ?? 0, true, this.doc)); c.lineWidth(o.width ?? 1); c.dash(o.dash);
  c.s += `${num(x1)} ${num(H - y1)} m ${num(x2)} ${num(H - y2)} l S\n`;
  if (gs) c.Q();
  return this;
}

/**
 * @this {import('../page.js').Page}
 * @param {number} x @param {number} y @param {number} w @param {number} h
 * @param {{ fill?: any, stroke?: any, width?: number, dash?: number[], opacity?: number, fillOpacity?: number, strokeOpacity?: number, blendMode?: string }} [o]
 *   neither fill nor stroke: filled black. opacity, fillOpacity, strokeOpacity, blendMode: an ExtGState inside q/Q, as page.fill
 */
export function rect(x, y, w, h, o = {}) {
  const c = this.content;
  const fill = o.fill ?? (o.stroke == null ? 0 : null), stroke = o.stroke ?? null;
  const gs = gstate(this, o); // checked before anything is written
  c.draw(); c.et();
  if (gs) { c.q(); c.s += gs; }
  if (fill != null) c.fill(colorOp(fill, false, this.doc));
  if (stroke != null) { c.stroke(colorOp(stroke, true, this.doc)); c.lineWidth(o.width ?? 1); c.dash(o.dash); }
  c.s += `${num(x)} ${num(this.height - y - h)} ${num(w)} ${num(h)} re ${fill != null && stroke != null ? 'B' : fill != null ? 'f' : 'S'}\n`;
  if (gs) c.Q();
  return this;
}
