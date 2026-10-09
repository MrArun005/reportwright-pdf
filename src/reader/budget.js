// @ts-check
/**
 * The budget every parse of a stranger's file runs under, and the one typed error it throws. A document gets one
 * budget at loadPdf: decoded bytes in all (maxDecoded, default 512 MB) and per stream (maxStream, 128 MB), steps
 * (tokens, xref rows, tree nodes, operators: maxSteps, 200 M), and time (timeoutMs, signal). Every loop over input
 * calls tick(); every decoder calls take() as it produces bytes, so a zip bomb stops at the cap, not at the end.
 */

/** @typedef {'E_MALFORMED' | 'E_BUDGET' | 'E_DEPTH' | 'E_CYCLE' | 'E_TIMEOUT' | 'E_ABORTED' | 'E_PASSWORD' | 'E_ENCRYPTED' | 'E_UNSUPPORTED' | 'E_ACTIVE'} Code */

export class PdfReadError extends Error {
  /** @param {Code} code @param {string} message */
  constructor(code, message) { super(message); this.name = 'PdfReadError'; this.code = code; }
}
/** @param {Code} code @param {string} msg @returns {never} */
export const fail = (code, msg) => { throw new PdfReadError(code, msg); };

export const DEFAULTS = { maxDecoded: 512 << 20, maxStream: 128 << 20, maxSteps: 200_000_000, maxDepth: 256, maxObjects: 10_000_000 };

/**
 * @param {{ maxDecoded?: number, maxStream?: number, maxSteps?: number, timeoutMs?: number, signal?: AbortSignal }} [o]
 */
export function createBudget(o = {}) {
  const pos = (/** @type {any} */ v, /** @type {number} */ d, /** @type {string} */ k) => {
    if (v == null) return d;
    if (typeof v !== 'number' || !(v > 0)) throw new TypeError(`loadPdf: budget.${k} is a number above 0`);
    return v;
  };
  const maxDecoded = pos(o.maxDecoded, DEFAULTS.maxDecoded, 'maxDecoded'), maxStream = pos(o.maxStream, DEFAULTS.maxStream, 'maxStream');
  const maxSteps = pos(o.maxSteps, DEFAULTS.maxSteps, 'maxSteps');
  const ms = o.timeoutMs == null ? 0 : pos(o.timeoutMs, 0, 'timeoutMs');
  const signal = o.signal;
  const b = {
    maxStream, maxDecoded,
    decoded: 0, steps: 0,
    deadline: ms ? Date.now() + ms : 0,
    /** a step of work; every 4096, the clock and the signal @param {number} [n] */
    tick(n = 1) {
      b.steps += n;
      if (b.steps > maxSteps) fail('E_BUDGET', `The PDF needs more than ${maxSteps.toLocaleString('en')} parsing steps (budget.maxSteps)`);
      if ((b.steps & 4095) < n || n > 4095) b.check();
    },
    check() {
      if (signal?.aborted) fail('E_ABORTED', `Reading the PDF was aborted${signal.reason?.message ? `: ${signal.reason.message}` : ''}`);
      if (b.deadline && Date.now() > b.deadline) fail('E_TIMEOUT', `Reading the PDF took longer than ${ms} ms (timeoutMs)`);
    },
    /** n more decoded bytes for a stream that has made `sofar` so far @param {number} n @param {number} sofar */
    take(n, sofar) {
      if (sofar + n > maxStream) fail('E_BUDGET', `A stream decodes past ${maxStream.toLocaleString('en')} bytes (budget.maxStream): corrupt, or a decompression bomb`);
      b.decoded += n;
      if (b.decoded > maxDecoded) fail('E_BUDGET', `The PDF's streams decode past ${maxDecoded.toLocaleString('en')} bytes in all (budget.maxDecoded): corrupt, or a decompression bomb`);
      b.tick(1 + (n >> 16));
    },
  };
  return b;
}
/** @typedef {ReturnType<typeof createBudget>} Budget */
