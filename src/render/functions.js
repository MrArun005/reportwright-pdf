// @ts-check
/**
 * PDF functions (ISO 32000-1 §7.10) for shadings: Type 0 (sampled, multilinear), 2 (exponential), 3 (stitching),
 * 4 (PostScript calculator). compile(obj) → (inputs) → outputs, or null for a function that cannot be read.
 *
 * HOSTILE: a sampled table holds at most MAX_SAMPLES values, checked before its data is read; functions nest at most
 * MAX_DEPTH deep and never contain themselves; a calculator program is at most MAX_PS_TOKENS tokens, its stack at most
 * 100 deep (the PDF limit), and it has no loops, so one evaluation does at most its token count of operations; every
 * evaluation is a budget step (tick).
 */
import { PdfStream } from '../reader/lexer.js';

export const MAX_SAMPLES = 1_000_000,
  /** functions one top-level function may hold in all (a stitching of stitchings cannot multiply past it) */
  MAX_NODES = 1024,
  MAX_DEPTH = 8,
  MAX_PS_TOKENS = 65_536,
  MAX_PS_STACK = 100;

const bad = (/** @type {string} */ m) => new TypeError(`function: ${m}`);
const nums = (/** @type {any} */ a, /** @type {(v: any) => any} */ R) =>
  Array.isArray(a) ? a.map((v) => R(v)).filter((v) => typeof v === 'number') : null;

/**
 * @param {any} obj @param {{ R: (v: any) => any, data: (s: PdfStream) => Uint8Array, tick: (n: number) => void }} ctx
 * @returns {((x: number[]) => number[]) | null}
 */
export function compile(obj, ctx, depth = 0, open = new Set(), count = { n: 0 }) {
  const { R } = ctx;
  obj = R(obj);
  if (++count.n > MAX_NODES) throw bad(`more than ${MAX_NODES} functions in one`);
  if (Array.isArray(obj)) {
    // one 1-in-1-out function per output
    const fs = obj.slice(0, 32).map((f) => compile(f, ctx, depth + 1, open, count));
    if (!fs.length || fs.some((f) => !f)) return null;
    return (x) => fs.map((f) => /** @type {any} */ (f)(x)[0]);
  }
  if (depth > MAX_DEPTH) throw bad(`functions nest more than ${MAX_DEPTH} deep`);
  if (open.has(obj)) throw bad('a function contains itself');
  const d = obj instanceof PdfStream ? obj.dict : obj;
  if (!(d instanceof Map)) return null;
  const type = R(d.get('FunctionType'));
  const domain = nums(d.get('Domain'), R) ?? [0, 1];
  const range = nums(d.get('Range'), R);
  const m = domain.length >> 1;
  if (m < 1 || m > 8) return null;
  const clip = (/** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi) =>
    v < lo ? lo : v > hi ? hi : v;
  /** @param {(x: number[]) => number[]} f */
  const wrap = (f) => (/** @type {number[]} */ x) => {
    ctx.tick(1);
    const xi = [];
    for (let i = 0; i < m; i++) xi.push(clip(x[i] ?? 0, domain[2 * i], domain[2 * i + 1]));
    const y = f(xi);
    if (range)
      for (let j = 0; j < y.length && 2 * j + 1 < range.length; j++) y[j] = clip(y[j], range[2 * j], range[2 * j + 1]);
    return y;
  };
  open.add(obj);
  try {
    if (type === 2) {
      const c0 = nums(d.get('C0'), R) ?? [0],
        c1 = nums(d.get('C1'), R) ?? [1],
        n = R(d.get('N'));
      if (typeof n !== 'number' || c0.length !== c1.length) return null;
      return wrap((x) => {
        const p = Math.pow(x[0], n);
        return c0.map((a, i) => a + p * (c1[i] - a));
      });
    }
    if (type === 3) {
      const subs = R(d.get('Functions')),
        bounds = nums(d.get('Bounds'), R) ?? [],
        enc = nums(d.get('Encode'), R) ?? [];
      if (!Array.isArray(subs) || subs.length !== bounds.length + 1 || subs.length > 256) return null;
      const fs = subs.map((f) => compile(f, ctx, depth + 1, open, count));
      if (fs.some((f) => !f)) return null;
      return wrap((x) => {
        const t = x[0];
        let k = 0;
        while (k < bounds.length && t >= bounds[k]) k++;
        const lo = k === 0 ? domain[0] : bounds[k - 1],
          hi = k === bounds.length ? domain[1] : bounds[k];
        const e0 = enc[2 * k] ?? 0,
          e1 = enc[2 * k + 1] ?? 1;
        const u = hi === lo ? e0 : e0 + ((t - lo) * (e1 - e0)) / (hi - lo);
        return /** @type {any} */ (fs[k])([u]);
      });
    }
    if (type === 0 && obj instanceof PdfStream) {
      const size = nums(d.get('Size'), R),
        bps = R(d.get('BitsPerSample'));
      if (!range || !size || size.length !== m || ![1, 2, 4, 8, 12, 16, 24, 32].includes(bps)) return null;
      const n = range.length >> 1;
      let count = n;
      for (const s of size) {
        if (!Number.isInteger(s) || s < 1) return null;
        count *= s;
        if (count > MAX_SAMPLES)
          throw bad(`a sampled function of more than ${MAX_SAMPLES.toLocaleString('en')} samples`);
      }
      const enc = nums(d.get('Encode'), R) ?? size.flatMap((s) => [0, s - 1]);
      const dec = nums(d.get('Decode'), R) ?? range;
      ctx.tick(1 + (count >> 4)); // reading the table, before it is read
      const data = ctx.data(obj);
      const max = 2 ** bps - 1;
      const table = new Float64Array(count);
      for (let i = 0; i < count; i++) {
        let v = 0;
        const bit = i * bps;
        if (bps >= 8) for (let b = 0; b < bps; b += 8) v = v * 256 + (data[(bit + b) >> 3] ?? 0);
        else v = ((data[bit >> 3] ?? 0) >> (8 - bps - (bit & 7))) & max;
        const j = i % n;
        table[i] = dec[2 * j] + (v * (dec[2 * j + 1] - dec[2 * j])) / max;
      }
      const strides = [n];
      for (let i = 1; i < m; i++) strides.push(strides[i - 1] * size[i - 1]);
      return wrap((x) => {
        // multilinear interpolation over the 2^m corners around x
        const e = [],
          f = [];
        for (let i = 0; i < m; i++) {
          const v =
            (x[i] - domain[2 * i]) * ((enc[2 * i + 1] - enc[2 * i]) / (domain[2 * i + 1] - domain[2 * i] || 1)) +
            enc[2 * i];
          const c = clip(v, 0, size[i] - 1);
          e.push(Math.min(size[i] - 2, Math.floor(c)) < 0 ? 0 : Math.min(size[i] - 2, Math.floor(c)));
          f.push(size[i] === 1 ? 0 : c - e[i]);
        }
        const out = new Array(n).fill(0);
        for (let corner = 0; corner < 1 << Math.min(m, 8); corner++) {
          let w = 1,
            idx = 0;
          for (let i = 0; i < m; i++) {
            const hi = (corner >> i) & 1;
            w *= hi ? f[i] : 1 - f[i];
            idx += (e[i] + (hi && size[i] > 1 ? 1 : 0)) * strides[i];
          }
          if (w) for (let j = 0; j < n; j++) out[j] += w * table[idx + j];
        }
        for (let j = 0; j < n; j++) out[j] = clip(out[j], range[2 * j], range[2 * j + 1]);
        return out;
      });
    }
    if (type === 4 && obj instanceof PdfStream) {
      if (!range) return null;
      const prog = parsePs(ctx.data(obj));
      const n = range.length >> 1;
      return wrap((x) => {
        const st = x.slice();
        execPs(prog, st);
        ctx.tick(prog.size >> 4);
        const out = st.slice(-n).map((v) => (typeof v === 'boolean' ? +v : v));
        while (out.length < n) out.unshift(0);
        return out;
      });
    }
    return null;
  } finally {
    open.delete(obj);
  }
}

/** a calculator program → nested arrays of numbers, operator names and { if, else } blocks @param {Uint8Array} b */
function parsePs(b) {
  const s = new TextDecoder('latin1').decode(b);
  const toks = s.match(/[{}]|[^\s{}()<>[\]/%]+/g) ?? [];
  if (toks.length > MAX_PS_TOKENS) throw bad(`a calculator program of more than ${MAX_PS_TOKENS} tokens`);
  let i = 0;
  const block = (/** @type {number} */ d) => {
    if (d > 100) throw bad('calculator blocks nest too deep');
    /** @type {any[]} */ const out = [];
    while (i < toks.length) {
      const t = toks[i++];
      if (t === '{') out.push(block(d + 1));
      else if (t === '}') return out;
      else if (t === 'if' || t === 'ifelse') {
        const els = t === 'ifelse' ? out.pop() : null,
          then = out.pop();
        if (!Array.isArray(then) || (t === 'ifelse' && !Array.isArray(els))) throw bad(`${t} without its blocks`);
        out.push({ then, else: els }); // { a } { b } ifelse: a when true, b when false
      } else {
        const v = Number(t);
        out.push(Number.isFinite(v) && /^[+-]?(\d|\.\d)/.test(t) ? v : t);
      }
    }
    return out;
  };
  const top = block(0);
  const prog = Array.isArray(top[0]) && top.length === 1 ? top[0] : top;
  return Object.assign(prog, { size: toks.length });
}

/** @param {any[]} p @param {any[]} st */
function execPs(p, st) {
  const pop = () => {
    if (!st.length) throw bad('calculator stack underflow');
    return st.pop();
  };
  const push = (/** @type {any} */ v) => {
    if (st.length >= MAX_PS_STACK) throw bad(`calculator stack deeper than ${MAX_PS_STACK}`);
    st.push(v);
  };
  for (const t of p) {
    if (typeof t === 'number') push(t);
    else if (typeof t === 'object') {
      const c = pop();
      if (c) execPs(t.then, st);
      else if (t.else) execPs(t.else, st);
    } else {
      let a, b;
      switch (t) {
        case 'true':
          push(true);
          break;
        case 'false':
          push(false);
          break;
        case 'abs':
          push(Math.abs(pop()));
          break;
        case 'neg':
          push(-pop());
          break;
        case 'ceiling':
          push(Math.ceil(pop()));
          break;
        case 'floor':
          push(Math.floor(pop()));
          break;
        case 'round':
          push(Math.round(pop()));
          break;
        case 'truncate':
          push(Math.trunc(pop()));
          break;
        case 'cvi':
          push(Math.trunc(pop()));
          break;
        case 'cvr':
          break;
        case 'sqrt':
          push(Math.sqrt(pop()));
          break;
        case 'sin':
          push(Math.sin((pop() * Math.PI) / 180));
          break;
        case 'cos':
          push(Math.cos((pop() * Math.PI) / 180));
          break;
        case 'ln':
          push(Math.log(pop()));
          break;
        case 'log':
          push(Math.log10(pop()));
          break;
        case 'exp':
          b = pop();
          a = pop();
          push(Math.pow(a, b));
          break;
        case 'atan': {
          b = pop();
          a = pop();
          let r = (Math.atan2(a, b) * 180) / Math.PI;
          if (r < 0) r += 360;
          push(r);
          break;
        }
        case 'add':
          b = pop();
          a = pop();
          push(a + b);
          break;
        case 'sub':
          b = pop();
          a = pop();
          push(a - b);
          break;
        case 'mul':
          b = pop();
          a = pop();
          push(a * b);
          break;
        case 'div':
          b = pop();
          a = pop();
          push(b === 0 ? 0 : a / b);
          break;
        case 'idiv':
          b = pop();
          a = pop();
          push(b === 0 ? 0 : Math.trunc(a / b));
          break;
        case 'mod':
          b = pop();
          a = pop();
          push(b === 0 ? 0 : a % b);
          break;
        case 'eq':
          b = pop();
          a = pop();
          push(a === b);
          break;
        case 'ne':
          b = pop();
          a = pop();
          push(a !== b);
          break;
        case 'gt':
          b = pop();
          a = pop();
          push(a > b);
          break;
        case 'ge':
          b = pop();
          a = pop();
          push(a >= b);
          break;
        case 'lt':
          b = pop();
          a = pop();
          push(a < b);
          break;
        case 'le':
          b = pop();
          a = pop();
          push(a <= b);
          break;
        case 'and':
          b = pop();
          a = pop();
          push(typeof a === 'boolean' ? a && b : a & b);
          break;
        case 'or':
          b = pop();
          a = pop();
          push(typeof a === 'boolean' ? a || b : a | b);
          break;
        case 'xor':
          b = pop();
          a = pop();
          push(typeof a === 'boolean' ? a !== b : a ^ b);
          break;
        case 'not':
          a = pop();
          push(typeof a === 'boolean' ? !a : ~a);
          break;
        case 'bitshift':
          b = pop();
          a = pop();
          push(b >= 0 ? a << b : a >> -b);
          break;
        case 'dup':
          a = pop();
          push(a);
          push(a);
          break;
        case 'pop':
          pop();
          break;
        case 'exch':
          b = pop();
          a = pop();
          push(b);
          push(a);
          break;
        case 'copy': {
          const n = pop();
          if (!(n >= 0 && n <= st.length)) throw bad('copy out of range');
          for (const v of st.slice(st.length - n)) push(v);
          break;
        }
        case 'index': {
          const n = pop();
          if (!(n >= 0 && n < st.length)) throw bad('index out of range');
          push(st[st.length - 1 - n]);
          break;
        }
        case 'roll': {
          const j = pop(),
            n = pop();
          if (!(n >= 0 && n <= st.length) || !Number.isInteger(j)) throw bad('roll out of range');
          if (n) {
            const part = st.splice(st.length - n, n);
            const k = ((j % n) + n) % n;
            st.push(...part.slice(n - k), ...part.slice(0, n - k));
          }
          break;
        }
        default:
          throw bad(`unknown calculator operator ${String(t).slice(0, 20)}`);
      }
    }
  }
}
