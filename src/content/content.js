// @ts-check
/**
 * A page's content stream as text (chars 0–255). The graphics state is tracked, so a colour, line width, dash or font
 * already set is not set again; q/Q save and restore it. Consecutive text lines share one text object, each placed
 * relative to the last (in hundredths: table rows repeat the same moves, which compress to little).
 *
 * Marked content (tags/): before anything is painted, draw() asks the page's marker which marked-content sequence it
 * belongs to (a structure element, or an artifact) and closes/opens sequences when that changes.
 *
 * Extension modules add operators with op(): it ends any text object and opens the right marked content first.
 */
import { num, pdfName } from '../core/serialize.js';

/** @typedef {{ current(): any, open(owner: any): string }} Marker */

export class Content {
  constructor() {
    this.s = '';
    this.bt = false; this.tx = 0; this.ty = 0;
    this.st = { fill: '0 g', stroke: '0 G', lw: 1, dash: '[] 0', font: '', size: 0, Tc: 0, Tw: 0, Tz: 100, Ts: 0, Tr: 0 };
    /** @type {any[]} */ this.saved = [];
    /** @type {Marker | null} */ this.marker = null;
    /** the open marked-content sequence's owner (null: none) */
    this.mc = null;
  }
  /** before painting: the right marked-content sequence is open */
  draw() {
    const m = this.marker;
    if (!m) return;
    const want = m.current();
    if (want === this.mc) return;
    this.closeMarked();
    this.et();
    this.s += m.open(want);
    this.mc = want;
  }
  closeMarked() { if (this.mc !== null) { this.et(); this.s += 'EMC\n'; this.mc = null; } }
  /** end the open text object, if any */
  et() { if (this.bt) { this.s += 'ET\n'; this.bt = false; } }
  /** operators outside a text object (paths, XObjects…), in the right marked content @param {string} ops */
  op(ops) { this.draw(); this.et(); this.s += ops.endsWith('\n') ? ops : ops + '\n'; }
  q() { this.draw(); this.et(); this.s += 'q\n'; this.saved.push({ ...this.st }); }
  Q() { this.et(); this.s += 'Q\n'; this.st = this.saved.pop() || this.st; }
  /** @param {string} c a fill colour's operator ("1 0 0 rg", "0.5 g") */
  fill(c) { if (c !== this.st.fill) { this.s += `${c}\n`; this.st.fill = c; } }
  /** @param {string} c a stroke colour's operator ("1 0 0 RG", "0.5 G") */
  stroke(c) { if (c !== this.st.stroke) { this.s += `${c}\n`; this.st.stroke = c; } }
  /** @param {number} w */
  lineWidth(w) { if (w !== this.st.lw) { this.s += `${num(w)} w\n`; this.st.lw = w; } }
  /** @param {number[] | null | undefined} dash */
  dash(dash) { const d = `[${(dash || []).map(num).join(' ')}] 0`; if (d !== this.st.dash) { this.s += `${d} d\n`; this.st.dash = d; } }
  /**
   * A line of text at (x, y), PDF space (from the bottom), the baseline's start.
   * @param {string} font resource name @param {number} size @param {number} x @param {number} y
   * @param {string} body a literal string's escaped body
   */
  text(font, size, x, y, body) { this.run(font, size, x, y, `(${body}) Tj\n`); }
  /**
   * A run of text at (x, y) (PDF space, the baseline's start): the text state (Tc Tw Tz Ts Tr, set only when it
   * changes; unset ones are their defaults), Tf, the move, then ops (a run's Tj/TJ operators, text/runs.js).
   * @param {string} font resource name @param {number} size @param {number} x @param {number} y @param {string} ops
   * @param {{ Tc?: number, Tw?: number, Tz?: number, Ts?: number, Tr?: number }} [state]
   */
  run(font, size, x, y, ops, state = {}) {
    this.draw();
    if (!this.bt) { this.s += 'BT\n'; this.bt = true; this.tx = 0; this.ty = 0; }
    const st = this.st, { Tc = 0, Tw = 0, Tz = 100, Ts = 0, Tr = 0 } = state;
    if (Tc !== st.Tc) { this.s += `${num(Tc)} Tc\n`; st.Tc = Tc; }
    if (Tw !== st.Tw) { this.s += `${num(Tw)} Tw\n`; st.Tw = Tw; }
    if (Tz !== st.Tz) { this.s += `${num(Tz)} Tz\n`; st.Tz = Tz; }
    if (Ts !== st.Ts) { this.s += `${num(Ts)} Ts\n`; st.Ts = Ts; }
    if (Tr !== st.Tr) { this.s += `${num(Tr)} Tr\n`; st.Tr = Tr; }
    if (font !== this.st.font || size !== this.st.size) { this.s += `${pdfName(font)} ${num(size)} Tf\n`; this.st.font = font; this.st.size = size; }
    const X = Math.round(Number(num(x)) * 100), Y = Math.round(Number(num(y)) * 100); // num: finite or it throws
    this.s += `${(X - this.tx) / 100} ${(Y - this.ty) / 100} Td ${ops}`;
    this.tx = X; this.ty = Y;
  }
  /** the stream's text, every sequence and object closed */
  end() { this.closeMarked(); this.et(); while (this.saved.length) this.Q(); return this.s; }
}
