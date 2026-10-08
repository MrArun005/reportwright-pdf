// @ts-check
/**
 * Any sink as { write(bytes): Promise, close(): Promise, abort(e) }: a Node Writable (false from write() waits for
 * 'drain'; 'error' or 'close' ends the wait with an error), a WHATWG WritableStream (its writer's ready), or a plain
 * { write(bytes) } whose result is awaited.
 */

/**
 * p, or signal's reason as soon as it aborts (p goes on, unwatched).
 * @template T @param {Promise<T>} p @param {AbortSignal} [signal] @returns {Promise<T>}
 */
export function raced(p, signal) {
  if (!signal) return p;
  if (signal.aborted) { p.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((ok, fail) => {
    const on = () => fail(signal.reason);
    signal.addEventListener('abort', on, { once: true });
    p.then((v) => { signal.removeEventListener('abort', on); ok(v); }, (e) => { signal.removeEventListener('abort', on); fail(e); });
  });
}

/** @param {any} s a Node stream @param {string[]} ok events that resolve @returns {Promise<void>} */
function nodeWait(s, ok) {
  return new Promise((resolve, fail) => {
    const off = () => { for (const e of ok) s.off?.(e, done); s.off?.('error', onError); s.off?.('close', onClose); };
    const done = () => { off(); resolve(); };
    const onError = (/** @type {any} */ e) => { off(); fail(e); };
    const onClose = () => { off(); fail(Object.assign(new Error('The sink closed before the PDF was written'), { code: 'ERR_STREAM_PREMATURE_CLOSE' })); };
    for (const e of ok) s.once(e, done);
    s.once('error', onError); s.once('close', onClose);
  });
}

/** @param {any} sink */
export function openSink(sink) {
  if (!sink || (typeof sink.write !== 'function' && typeof sink.getWriter !== 'function')) throw new TypeError('createPdf: the sink must be a Node Writable, a WritableStream or an object with write(bytes)');
  if (typeof sink.getWriter === 'function') { // WHATWG WritableStream
    const w = sink.getWriter();
    return {
      async write(/** @type {Uint8Array} */ b) { await w.ready; await w.write(b); },
      close: () => w.close(),
      abort: (/** @type {any} */ e) => { w.abort(e).catch(() => {}); },
    };
  }
  if (typeof sink.once === 'function' && typeof sink.end === 'function') { // Node Writable
    // its error is kept (and reported by the next write or the close) rather than left unhandled; a destroyed or ended
    // stream fails the next write instead of being waited for forever
    /** @type {any} */
    let failed = null;
    const onError = (/** @type {any} */ e) => { failed ??= e; };
    sink.on('error', onError);
    const off = () => sink.off?.('error', onError);
    const dead = () => failed || sink.errored || ((sink.destroyed || sink.writableEnded) && Object.assign(new Error('The sink closed before the PDF was written'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }));
    return {
      write: (/** @type {Uint8Array} */ b) => { const e = dead(); if (e) return Promise.reject(e); return sink.write(b) === false ? nodeWait(sink, ['drain']) : Promise.resolve(); },
      close: () => { const e = dead(); if (e) { off(); return Promise.reject(e); } const p = nodeWait(sink, ['finish']); sink.end(); return p.finally(off); },
      abort: off,
    };
  }
  return {
    write: async (/** @type {Uint8Array} */ b) => { await sink.write(b); },
    close: async () => { await sink.close?.(); },
    abort: () => {},
  };
}
