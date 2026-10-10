// Sinks (Node Writable with back-pressure, WritableStream, plain), abort and timeout, flat memory, and the built bundle.
import { describe, it, expect } from 'vitest';
import { Writable, PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { createPdf, toBytes } from '../src/index.js';
import { HAS, ROOT, pdftotext, DIR, INTER } from './tools.js';

const DATE = new Date('2026-01-01');
/** n pages of text */
const pages =
  (n, lines = 40) =>
  async (pdf) => {
    const f = pdf.standardFont('Courier');
    for (let i = 1; i <= n; i++) {
      const p = pdf.addPage();
      for (let r = 0; r < lines; r++)
        p.text(`page ${i} line ${r} ${'x'.repeat(r % 30)}`, { x: 20, y: 20 + r * 18, font: f, size: 9 });
      await p.end();
    }
  };

describe('sinks', () => {
  it('a slow Node Writable: back-pressure is honoured (writes wait for drain), the stream is ended, bytes are the same', async () => {
    const chunks = [];
    let inFlight = 0,
      maxInFlight = 0;
    const sink = new Writable({
      highWaterMark: 1024,
      write(c, _e, cb) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        chunks.push(c);
        setTimeout(() => {
          inFlight--;
          cb();
        }, 1);
      },
    });
    let finished = false;
    sink.on('finish', () => {
      finished = true;
    });
    const pdf = createPdf(sink, { creationDate: DATE });
    await pages(60)(pdf);
    await pdf.end();
    expect(finished).toBe(true);
    expect(maxInFlight).toBe(1); // never a second write while one was pending past the high-water mark
    const viaBytes = await toBytes(pages(60), { creationDate: DATE });
    expect(Buffer.compare(Buffer.concat(chunks), viaBytes)).toBe(0);
  });

  it('a WritableStream: waits for its writer, closes it; the result reads', async () => {
    const chunks = [];
    let closed = false;
    const ws = new WritableStream(
      {
        async write(c) {
          await new Promise((r) => setTimeout(r, 0));
          chunks.push(c);
        },
        close() {
          closed = true;
        },
      },
      { highWaterMark: 1 },
    );
    const pdf = createPdf(ws, { creationDate: DATE });
    await pages(10)(pdf);
    const r = await pdf.end();
    expect(closed).toBe(true);
    const bytes = Buffer.concat(chunks);
    expect(r.bytes).toBe(bytes.length);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(10);
  });

  it('a plain { write } sink whose write returns a promise is awaited; close() is called', async () => {
    let pending = 0,
      max = 0,
      closed = false;
    const sink = {
      async write() {
        pending++;
        max = Math.max(max, pending);
        await new Promise((r) => setTimeout(r, 1));
        pending--;
      },
      close() {
        closed = true;
      },
    };
    const pdf = createPdf(sink, { creationDate: DATE });
    await pages(30)(pdf);
    await pdf.end();
    expect(max).toBe(1);
    expect(closed).toBe(true);
  });

  it('writes to a file through fs.createWriteStream and pdftotext reads it', async () => {
    const file = path.join(DIR, 'stream.pdf');
    const pdf = createPdf(fs.createWriteStream(file), { creationDate: DATE });
    await pages(3)(pdf);
    await pdf.end();
    if (HAS.poppler) expect(pdftotext(fs.readFileSync(file))).toMatch('page 3 line 39');
  });
});

describe('stopping', () => {
  it('an AbortSignal stops the export: the waiting write and later calls reject with its reason', async () => {
    const ctl = new AbortController();
    const never = { write: () => new Promise(() => {}) }; // a sink that never takes the bytes
    const pdf = createPdf(never, { signal: ctl.signal });
    const work = pages(400)(pdf);
    setTimeout(() => ctl.abort(new Error('stop!')), 20);
    await expect(work).rejects.toThrow('stop!');
    expect(() => pdf.addPage()).toThrow('stop!');
    await expect(pdf.end()).rejects.toThrow('stop!');
    // aborted between calls: the next one rejects
    const c2 = new AbortController(),
      p2 = createPdf({ write() {} }, { signal: c2.signal });
    await pages(2)(p2);
    c2.abort(new Error('later'));
    await expect(p2.end()).rejects.toThrow('later');
  });

  it('an already-aborted signal is refused at once', () => {
    expect(() => createPdf({ write() {} }, { signal: AbortSignal.abort(new Error('early')) })).toThrow('early');
  });

  it('timeoutMs ends a stuck export with a TimeoutError (code ETIMEDOUT); a WritableStream is aborted', async () => {
    let aborted = null;
    const ws = new WritableStream(
      {
        write: () => new Promise((r) => setTimeout(r, 100)),
        abort(e) {
          aborted = e;
        },
      },
      { highWaterMark: 1 },
    );
    const pdf = createPdf(ws, { timeoutMs: 50 });
    const err = await pages(400)(pdf)
      .then(() => pdf.end())
      .catch((e) => e);
    expect(err.name).toBe('TimeoutError');
    expect(err.code).toBe('ETIMEDOUT');
    // the stream aborts once its write in flight (100 ms) is done (WHATWG streams): wait for it, not a fixed 150 ms
    for (let t = Date.now(); aborted === null && Date.now() - t < 5000;) await new Promise((r) => setTimeout(r, 10));
    expect(aborted).toBe(err);
  });

  it('a sink that fails: the error reaches the caller and later calls fail with it', async () => {
    const sink = new PassThrough();
    sink.resume();
    const pdf = createPdf(sink);
    setTimeout(() => sink.destroy(new Error('disk full')), 5);
    const err = await pages(400)(pdf)
      .then(() => pdf.end())
      .catch((e) => e);
    expect(err?.message).toBe('disk full');
    expect(() => pdf.addPage()).toThrow('disk full');
  });
});

describe('memory and the built package', () => {
  it('memory stays flat: 20,000 pages of text hold about what 1,000 do', () => {
    const out = execFileSync(
      process.execPath,
      ['--expose-gc', path.join(import.meta.dirname, 'memory-child.mjs'), '20000'],
      { encoding: 'utf8', timeout: 120000 },
    );
    const r = JSON.parse(out);
    // marks[0] is the baseline (the library loaded, 0 pages): the bounds are on what the pages add, so they do not move
    // when the library's own code grows (the old absolute bound failed ~1 run in 6 once the loaded code reached ~6 MB)
    const base = r.marks[0],
      first = r.marks[1],
      last = r.marks[r.marks.length - 1];
    console.log(
      'memory (MB, after GC):',
      r.marks
        .map(
          (m) =>
            `${m.pages} pages: heap ${m.heapMB.toFixed(1)}, buffers ${m.buffersMB.toFixed(1)}, rss ${m.rssMB.toFixed(0)}`,
        )
        .join(' | '),
      `| file ${(r.bytes / 2 ** 20).toFixed(1)} MB`,
    );
    expect(r.pages).toBe(20000);
    expect(base.pages).toBe(0);
    expect(first.pages).toBe(1000);
    expect(last.heapMB - first.heapMB).toBeLessThan(4); // 20 times the pages, almost no more heap
    expect(last.buffersMB - first.buffersMB).toBeLessThan(4);
    const held = last.heapMB + last.buffersMB - base.heapMB - base.buffersMB;
    expect(held).toBeLessThan(r.bytes / 2 ** 20 / 4); // what the document holds is far less than the file it wrote (~2 of 14 MB)
  }, 120000);

  it('dist/index.js imports nothing but dist/fflate.js (fflate bundled, on first use), which imports nothing; it writes a valid PDF', async () => {
    execFileSync(process.execPath, [path.join(ROOT, 'build.mjs')]);
    const dist = fs.readFileSync(path.join(ROOT, 'dist/index.js'), 'utf8');
    const ff = fs.readFileSync(path.join(ROOT, 'dist/fflate.js'), 'utf8');
    expect(dist).not.toMatch(/^\s*import\s|\bfrom\s+['"]|require\(/m);
    expect([...dist.matchAll(/\bimport\s*\(\s*"([^"]*)"\s*\)/g)].map((m) => m[1])).toEqual(['./fflate.js']); // JSDoc's import('…') use single quotes
    expect(ff).not.toMatch(/^\s*import\s|\bfrom\s+['"]|require\(|\bimport\s*\(/m);
    expect(ff).toMatch(/export\s*\{[^}]*\bzlibSync\b/);
    const { toBytes: tb } = await import('../dist/index.js');
    const out = await tb(
      async (pdf) => {
        const f = await pdf.embedFont(INTER);
        pdf.addPage().text('From dist ✓', { x: 10, y: 10, font: f });
      },
      { creationDate: DATE },
    );
    if (HAS.poppler) expect(pdftotext(out).trim()).toBe('From dist ✓');
  }, 30000);
});
