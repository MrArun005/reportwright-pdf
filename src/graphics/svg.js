// @ts-check
/**
 * SVG path data (the `d` attribute) into a Path: M m L l H h V v C c S s Q q T t A a Z z, implicit repeated commands
 * (after M they are L), numbers as SVG writes them ("1.5.5", "-1e3", ".5-.5") and packed arc flags ("a1 1 0 01 5 5").
 * Arcs become cubic Béziers (SVG 1.1 F.6.5: endpoint to centre, radii scaled up when too small).
 *
 * Untrusted input: one pass over the string, no regular expressions, no recursion; at most MAX_SVG characters and the
 * path's segment limit. Malformed data throws a SyntaxError naming the position (nothing is drawn).
 */
import { coord } from './path.js';

export const MAX_SVG = 10 * 1024 * 1024;
/** arguments per command (lower case) */
const ARGS = /** @type {Record<string, number>} */ ({ m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 });

/** @param {string} d @param {import('./path.js').Path} path */
export function parseSvgPath(d, path) {
  if (typeof d !== 'string') throw new TypeError('svgPath: the path data is a string');
  if (d.length > MAX_SVG) throw new RangeError(`svgPath: the path data is ${d.length} characters; at most ${MAX_SVG} (10 MB)`);
  const n = d.length;
  let i = 0, cmd = '', started = false, x = 0, y = 0, sx = 0, sy = 0;
  /** the last command's second control point (for S) and quadratic control point (for T), and that command */
  let cx = 0, cy = 0, qx = 0, qy = 0, last = '';
  const fail = (/** @type {string} */ what) => { throw new SyntaxError(`svgPath: ${what} at character ${i} of the path data`); };
  const space = () => { for (let c; i < n && ((c = d.charCodeAt(i)) === 32 || c === 9 || c === 10 || c === 13 || c === 12);) i++; };
  /** between arguments: white space with at most one comma */
  const sep = () => { space(); if (d[i] === ',') { i++; space(); } };
  const digits = () => { const s = i; for (let c; i < n && (c = d.charCodeAt(i)) >= 48 && c <= 57;) i++; return i - s; };
  const number = () => {
    sep();
    const s = i;
    if (d[i] === '+' || d[i] === '-') i++;
    let k = digits();
    if (d[i] === '.') { i++; k += digits(); }
    if (!k) { i = s; fail('a number was expected'); }
    if (d[i] === 'e' || d[i] === 'E') {
      const e = i++;
      if (d[i] === '+' || d[i] === '-') i++;
      if (!digits()) { i = e; fail('an exponent was expected'); }
    }
    return Number(d.slice(s, i));
  };
  const flag = () => { sep(); const c = d[i]; if (c !== '0' && c !== '1') fail('an arc flag (0 or 1) was expected'); i++; return c === '1'; };

  for (;;) {
    space();
    if (i >= n) break;
    const ch = d[i], lower = ch.toLowerCase();
    if (lower in ARGS) { cmd = ch; i++; }
    else if (!cmd) fail('the path data must start with M or m');
    else if (cmd === 'z' || cmd === 'Z') fail('a command was expected');
    // else: the previous command repeats (after M/m it is L/l)
    if (!started && cmd !== 'M' && cmd !== 'm') fail('the path data must start with M or m');
    const c = cmd.toLowerCase(), rel = cmd === c, ox = rel ? x : 0, oy = rel ? y : 0;
    if (c === 'z') {
      path.closePath(); x = sx; y = sy; last = 'z';
      continue;
    }
    if (c === 'm') {
      x = ox + number(); y = oy + number();
      path.moveTo(x, y); sx = x; sy = y; started = true;
      cmd = rel ? 'l' : 'L'; last = 'm';
      continue;
    }
    if (c === 'l') { x = ox + number(); y = oy + number(); path.lineTo(x, y); }
    else if (c === 'h') { x = ox + number(); path.lineTo(x, y); }
    else if (c === 'v') { y = (rel ? y : 0) + number(); path.lineTo(x, y); }
    else if (c === 'c' || c === 's') {
      let x1, y1;
      if (c === 'c') { x1 = ox + number(); y1 = oy + number(); }
      else if (last === 'c' || last === 's') { x1 = 2 * x - cx; y1 = 2 * y - cy; }
      else { x1 = x; y1 = y; }
      cx = ox + number(); cy = oy + number();
      x = ox + number(); y = oy + number();
      path.bezierCurveTo(x1, y1, cx, cy, x, y);
    } else if (c === 'q' || c === 't') {
      if (c === 'q') { qx = ox + number(); qy = oy + number(); }
      else if (last === 'q' || last === 't') { qx = 2 * x - qx; qy = 2 * y - qy; }
      else { qx = x; qy = y; }
      x = ox + number(); y = oy + number();
      path.quadraticCurveTo(qx, qy, x, y);
    } else { // a
      let rx = Math.abs(number()), ry = Math.abs(number());
      const rot = number(), large = flag(), sweep = flag(), x0 = x, y0 = y;
      coord(rx, 'svgPath arc radius'); coord(ry, 'svgPath arc radius'); coord(rot, 'svgPath arc rotation');
      x = ox + number(); y = oy + number();
      arc(path, x0, y0, rx, ry, (rot * Math.PI) / 180, large, sweep, x, y);
    }
    last = c;
  }
}

/**
 * SVG's elliptical arc from (x0, y0) to (x, y), as Béziers on the path (SVG 1.1 F.6.5, F.6.6).
 * @param {import('./path.js').Path} path @param {number} x0 @param {number} y0 @param {number} rx @param {number} ry
 * @param {number} phi @param {boolean} large @param {boolean} sweep @param {number} x @param {number} y
 */
function arc(path, x0, y0, rx, ry, phi, large, sweep, x, y) {
  if (x0 === x && y0 === y) return;
  if (!rx || !ry) { path.lineTo(x, y); return; }
  const cp = Math.cos(phi), sp = Math.sin(phi), dx = (x0 - x) / 2, dy = (y0 - y) / 2;
  const x1 = cp * dx + sp * dy, y1 = -sp * dx + cp * dy;
  const L = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (L > 1) { rx *= Math.sqrt(L); ry *= Math.sqrt(L); }
  const a = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const k = (large !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, (rx * rx * ry * ry - a) / a));
  const ccx = (k * rx * y1) / ry, ccy = (-k * ry * x1) / rx;
  const cx = cp * ccx - sp * ccy + (x0 + x) / 2, cy = sp * ccx + cp * ccy + (y0 + y) / 2;
  const ux = (x1 - ccx) / rx, uy = (y1 - ccy) / ry, vx = (-x1 - ccx) / rx, vy = (-y1 - ccy) / ry;
  const t1 = Math.atan2(uy, ux);
  let dt = Math.atan2(vy, vx) - t1;
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  path.arcSegment(cx, cy, rx, ry, phi, t1, dt, false);
}
