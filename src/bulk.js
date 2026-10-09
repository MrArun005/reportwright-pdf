// @ts-check
/**
 * bulk(inputs, task, { workers, ... }): one named task over many files, in parallel worker threads (Node), each file
 * apart: a file that fails gives its own { ok: false, error } and the rest go on. Tasks are NAMES (TASKS below), never
 * functions, so nothing but bytes and plain options crosses to a worker. Each worker has a heap cap (memoryMb,
 * resourceLimits): a file that blows it kills that worker only; its item fails with E_WORKER and a new worker takes
 * the next. Without node:worker_threads (browsers, Deno without Node compat) the same tasks run one at a time here.
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

/**
 * @param {Iterable<any>} inputs @param {string} task one of BULK_TASKS
 * @param {{ workers?: number, memoryMb?: number, password?: string, budget?: object, timeoutMs?: number, encrypt?: object, save?: object, onResult?: (i: number, r: any) => void }} [o]
 * @returns {Promise<({ ok: true, value: any } | { ok: false, error: { name: string, code?: string, message: string } })[]>} in input order
 */
export async function bulk(inputs, task, o = {}) {
  if (!Object.hasOwn(TASKS, task)) throw new TypeError(`bulk: task is one of ${BULK_TASKS.join(', ')}`);
  if (o == null || typeof o !== 'object') throw new TypeError('bulk: options are { workers, memoryMb, password, budget, timeoutMs, encrypt, save }');
  const list = [...inputs];
  const { workers: w0, memoryMb = 512, onResult, ...taskOpts } = o;
  const node = /** @type {any} */ (globalThis).process?.getBuiltinModule;
  const wt = node?.('node:worker_threads'), os = node?.('node:os');
  const auto = os ? Math.max(1, (os.availableParallelism?.() ?? os.cpus().length) - 1) : 1;
  const n = Math.min(list.length, w0 == null ? auto : w0);
  if (!Number.isInteger(n) || n < 0) throw new TypeError('bulk: workers is a positive integer');
  if (!Number.isFinite(memoryMb) || memoryMb < 16) throw new TypeError('bulk: memoryMb is at least 16');
  /** @type {any[]} */
  const results = new Array(list.length);
  const done = (/** @type {number} */ i, /** @type {any} */ r) => { results[i] = r; onResult?.(i, r); };
  if (!wt || n <= 1) { // ponytail: sequential here (browsers; or one worker's worth of work), no heap cap
    for (let i = 0; i < list.length; i++) done(i, await runOne(task, list[i], taskOpts));
    return results;
  }
  let next = 0;
  const url = import.meta.url;
  const spawn = () => new wt.Worker(`import(${JSON.stringify(url)}).then((m) => m.__bulkWorker())`, { eval: true, resourceLimits: { maxOldGenerationSizeMb: memoryMb } });
  /** one worker: an item at a time; a worker that dies fails its item and is replaced */
  const lane = async () => {
    let worker = spawn();
    try {
      while (next < list.length) {
        const i = next++;
        const r = await new Promise((resolve) => {
          const off = () => { worker.off('message', ok); worker.off('error', bad); worker.off('exit', gone); };
          const ok = (/** @type {any} */ m) => { off(); resolve(m); };
          const bad = (/** @type {any} */ e) => { off(); resolve({ ok: false, error: { ...errorOf(e), code: 'E_WORKER' }, dead: true }); };
          const gone = (/** @type {number} */ c) => { off(); resolve({ ok: false, error: { name: 'Error', code: 'E_WORKER', message: `the worker stopped (exit ${c}), out of memory (memoryMb) or crashed` }, dead: true }); };
          worker.on('message', ok); worker.once('error', bad); worker.once('exit', gone);
          worker.postMessage({ task, input: list[i], o: taskOpts });
        });
        if (r.dead) { worker.terminate(); worker = spawn(); delete r.dead; }
        done(i, r);
      }
    } finally { await worker.terminate(); }
  };
  await Promise.all(Array.from({ length: n }, lane));
  return results;
}

/** a worker's loop (internal: started by bulk's workers) */
export function __bulkWorker() {
  const { parentPort } = /** @type {any} */ (globalThis).process.getBuiltinModule('node:worker_threads');
  parentPort.on('message', async (/** @type {any} */ m) => {
    const r = await runOne(m.task, m.input, m.o);
    const v = r.ok ? r.value : null;
    const transfer = v instanceof Uint8Array ? [v.buffer] : Array.isArray(v) ? v.filter((x) => x instanceof Uint8Array).map((x) => x.buffer) : [];
    try { parentPort.postMessage(r, [...new Set(transfer)].filter((b) => b instanceof ArrayBuffer)); } catch { parentPort.postMessage(r); }
  });
}
