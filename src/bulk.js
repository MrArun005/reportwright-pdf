// @ts-check
/**
 * bulk(inputs, task, { workers, ... }): one named task over many files, in parallel worker threads (Node), each file
 * apart: a file that fails gives its own { ok: false, error } and the rest go on. Tasks are NAMES (TASKS below), never
 * functions, so nothing but bytes and plain options crosses to a worker. Each worker has a heap cap (memoryMb,
 * resourceLimits): a file that blows it kills that worker only; its item fails with E_WORKER and a new worker takes
 * the next. Workers are kept warm between calls (IDLE_MS), small files go several at a time (DEPTH, BATCH_BYTES), and
 * inputs are copied, not transferred (the caller's buffers stay usable; copying is ~0.1 ms a MB). signal: an abort ends
 * the call's workers. Without node:worker_threads (browsers, Deno without Node compat) the same tasks run one at a time here.
 */
import { loadPdf } from './reader/pdf.js';

/** @type {Record<string, (input: any, o: any) => Promise<any>>} */
const TASKS = {
  /** bytes → the text of every page ('\f' between pages) */
  extractText: async (input, o) => (await loadPdf(bytesOf(input), load(o))).extractText(),
  /** [bytes, bytes, …] → one file */
  merge: async (input, o) => {
    if (!Array.isArray(input) || !input.length) throw new TypeError('bulk merge: each input is an array of files');
    const docs = []; for (const b of input) docs.push(await loadPdf(bytesOf(b), load(o)));
    return (await docs[0].fork().merge(docs.slice(1)).save(o.save)).bytes;
  },
  /** bytes → one file per page */
  split: async (input, o) => {
    const d = await loadPdf(bytesOf(input), load(o));
    const out = []; for (let i = 0; i < d.pageCount; i++) out.push((await d.fork().reorder([i]).save(o.save)).bytes);
    return out;
  },
  /** bytes → the file encrypted with o.encrypt (save()'s encrypt option) */
  encrypt: async (input, o) => {
    if (o.encrypt == null || typeof o.encrypt !== 'object') throw new TypeError('bulk encrypt: options.encrypt is save()\'s encrypt option');
    return (await (await loadPdf(bytesOf(input), load(o))).save({ ...o.save, encrypt: o.encrypt })).bytes;
  },
};
export const BULK_TASKS = Object.freeze(Object.keys(TASKS));

const load = (/** @type {any} */ o) => ({ ...(o.password != null && { password: o.password }), ...(o.budget && { budget: o.budget }), ...(o.timeoutMs && { timeoutMs: o.timeoutMs }) });
/** @param {any} b */
function bytesOf(b) {
  if (b instanceof Uint8Array) return b;
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  throw new TypeError('bulk: an input is a Uint8Array or an ArrayBuffer');
}
/** an error as plain data (what crosses back from a worker) @param {any} e */
const errorOf = (e) => ({ name: String(e?.name ?? 'Error'), code: e?.code == null ? undefined : String(e.code), message: String(e?.message ?? e) });
/** @param {string} task @param {any} input @param {any} o */
async function runOne(task, input, o) {
  try { return { ok: true, value: await TASKS[task](input, o) }; } catch (e) { return { ok: false, error: errorOf(e) }; }
}

// a worker is sent items while it has fewer than DEPTH, or fewer than BATCH_BYTES of input, on its way (at least one):
// small files do not wait a round trip each, big ones stay spread over the workers
const DEPTH = 8, BATCH_BYTES = 256 * 1024;
// a cap on workers (a typo of 1e6 must not start a million threads)
const MAX_WORKERS = 64;
// workers kept between calls (warm: their code compiled), by heap cap; unref'd, so they never hold the process open,
// and ended after IDLE_MS unused. ponytail: a fixed idle time
const IDLE_MS = 2000;
/** @type {Map<number, { worker: any, timer: any, gone: () => void }[]>} */
const idle = new Map();
/** @param {any} input */
const sizeOf = (input) => (Array.isArray(input) ? input.reduce((n, b) => n + (b?.byteLength || 0), 0) : input?.byteLength || 0);

/**
 * @param {Iterable<any>} inputs @param {string} task one of BULK_TASKS
 * @param {{ workers?: number, memoryMb?: number, password?: string, budget?: object, timeoutMs?: number, encrypt?: object, save?: object, signal?: AbortSignal, onResult?: (i: number, r: any) => void }} [o]
 * @returns {Promise<({ ok: true, value: any } | { ok: false, error: { name: string, code?: string, message: string } })[]>} in input order
 */
export async function bulk(inputs, task, o = {}) {
  if (!Object.hasOwn(TASKS, task)) throw new TypeError(`bulk: task is one of ${BULK_TASKS.join(', ')}`);
  if (o == null || typeof o !== 'object') throw new TypeError('bulk: options are { workers, memoryMb, password, budget, timeoutMs, encrypt, save, signal }');
  const list = [...inputs];
  const { workers: w0, memoryMb = 512, itemTimeoutMs = 120000, onResult, signal, ...taskOpts } = o;
  const node = /** @type {any} */ (globalThis).process?.getBuiltinModule;
  const wt = node?.('node:worker_threads'), os = node?.('node:os');
  const auto = os ? Math.max(1, (os.availableParallelism?.() ?? os.cpus().length) - 1) : 1;
  const n = Math.min(list.length, w0 == null ? auto : w0);
  if (!Number.isInteger(n) || n < 0 || (w0 != null && !(Number.isInteger(w0) && w0 >= 1 && w0 <= MAX_WORKERS))) throw new TypeError(`bulk: workers is an integer from 1 to ${MAX_WORKERS}`);
  if (!Number.isFinite(memoryMb) || memoryMb < 16 || memoryMb > 16384) throw new TypeError('bulk: memoryMb is from 16 to 16384');
  if (!Number.isFinite(itemTimeoutMs) || itemTimeoutMs <= 0) throw new TypeError('bulk: itemTimeoutMs is a positive number of ms');
  signal?.throwIfAborted();
  /** @type {any[]} */
  const results = new Array(list.length);
  const done = (/** @type {number} */ i, /** @type {any} */ r) => { results[i] = r; onResult?.(i, r); };
  if (!wt || n <= 1) { // ponytail: sequential here (browsers; or one worker's worth of work), no heap cap
    for (let i = 0; i < list.length; i++) { signal?.throwIfAborted(); done(i, await runOne(task, list[i], taskOpts)); }
    return results;
  }
  const url = import.meta.url;
  const spawn = () => new wt.Worker(`import(${JSON.stringify(url)}).then((m) => m.__bulkWorker())`, { eval: true, resourceLimits: { maxOldGenerationSizeMb: memoryMb } });
  const take = () => { const x = idle.get(memoryMb)?.pop(); if (!x) return spawn(); clearTimeout(x.timer); x.worker.off('exit', x.gone); x.worker.ref(); return x.worker; };
  const give = (/** @type {any} */ worker) => {
    worker.unref();
    const l = idle.get(memoryMb) || []; idle.set(memoryMb, l);
    const drop = () => { const k = l.indexOf(x); if (k >= 0) l.splice(k, 1); };
    const x = { worker, gone: drop, timer: setTimeout(() => { drop(); worker.terminate(); }, IDLE_MS) };
    x.timer.unref?.(); worker.once('exit', drop); l.push(x);
  };
  const queue = list.map((_, i) => i); // items not yet sent; an item a dead worker had not started goes back to the front
  /** @type {Set<() => void>} */
  const stops = new Set(); // each lane's: its worker ended (an abort)
  /** one worker: items sent while it has room (DEPTH, BATCH_BYTES), run there one at a time, in order; a worker that dies fails the item it was on (the oldest sent), and the rest go back for a new worker */
  const lane = () => new Promise((resolve) => {
    /** @type {any} */
    let worker;
    /** @type {number[]} */
    let flight = []; // sent, oldest first
    let bytes = 0, timer = /** @type {any} */ (null);
    // the item the worker is on (the oldest sent) has itemTimeoutMs: past it the worker is ended and the item fails
    // (E_TIMEOUT); the items behind it go to a new worker. Each death fails one item, so respawns are bounded by the items
    const arm = () => { clearTimeout(timer); timer = flight.length ? setTimeout(() => dead({ name: 'Error', code: 'E_TIMEOUT', message: `the item took longer than itemTimeoutMs (${itemTimeoutMs} ms)` }), itemTimeoutMs) : null; };
    const fill = () => {
      while (queue.length && (!flight.length || (flight.length < DEPTH && bytes < BATCH_BYTES))) {
        const i = /** @type {number} */ (queue.shift());
        flight.push(i); bytes += sizeOf(list[i]);
        worker.postMessage({ id: i, task, input: list[i], o: taskOpts });
        if (flight.length === 1) arm();
      }
      if (!flight.length) { off(); stops.delete(stop); give(worker); resolve(undefined); }
    };
    const onMessage = (/** @type {any} */ m) => {
      flight = flight.filter((i) => i !== m.id); bytes -= sizeOf(list[m.id]);
      const { id, ...r } = m;
      done(id, r);
      arm(); // the next one starts now
      fill();
    };
    const dead = (/** @type {any} */ error) => {
      clearTimeout(timer); timer = null;
      off(); worker.terminate();
      const [i, ...rest] = flight;
      flight = []; bytes = 0;
      queue.unshift(...rest);
      if (i !== undefined) done(i, { ok: false, error });
      on(spawn()); fill();
    };
    const onError = (/** @type {any} */ e) => dead({ ...errorOf(e), code: 'E_WORKER' });
    const onExit = (/** @type {number} */ c) => dead({ name: 'Error', code: 'E_WORKER', message: `the worker stopped (exit ${c}), out of memory (memoryMb) or crashed` });
    const on = (/** @type {any} */ w) => { worker = w; w.on('message', onMessage); w.once('error', onError); w.once('exit', onExit); };
    const off = () => { worker.off('message', onMessage); worker.off('error', onError); worker.off('exit', onExit); };
    const stop = () => { clearTimeout(timer); off(); worker.terminate(); resolve(undefined); };
    stops.add(stop);
    on(take()); fill();
  });
  const lanes = Promise.all(Array.from({ length: n }, lane));
  if (!signal) { await lanes; return results; }
  // an abort: every worker of this call ended (not kept), and bulk rejects with the signal's reason
  const onAbort = () => { for (const s of stops) s(); stops.clear(); };
  signal.addEventListener('abort', onAbort, { once: true });
  try { await lanes; } finally { signal.removeEventListener('abort', onAbort); }
  signal.throwIfAborted();
  return results;
}

/** a worker's loop (internal: started by bulk's workers): items one at a time, in the order they came */
export function __bulkWorker() {
  const { parentPort } = /** @type {any} */ (globalThis).process.getBuiltinModule('node:worker_threads');
  let chain = Promise.resolve();
  parentPort.on('message', (/** @type {any} */ m) => {
    chain = chain.then(async () => {
      const r = { id: m.id, ...await runOne(m.task, m.input, m.o) };
      const v = r.ok ? r.value : null;
      const transfer = v instanceof Uint8Array ? [v.buffer] : Array.isArray(v) ? v.filter((x) => x instanceof Uint8Array).map((x) => x.buffer) : [];
      try { parentPort.postMessage(r, [...new Set(transfer)].filter((b) => b instanceof ArrayBuffer)); } catch { parentPort.postMessage(r); }
    });
  });
}
