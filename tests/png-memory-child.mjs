// Run by hostile-review-oct.test.js (F1) in its own process (--expose-gc --max-old-space-size=1024): embeds a W × H
// all-zero 8-bit RGBA PNG (a few hundred KB of file) and prints, as JSON, the decoded size, the peak RSS growth while
// embedding (process.memoryUsage().rss sampled every 5 ms, and the process's maxRSS) and the time taken.
import zlib from 'node:zlib';
import { createPdf } from '../src/index.js';
import { SIG, ihdr, chunk } from './image-fixtures.js';

const [w, h, interlace] = process.argv.slice(2).map(Number);
const opt = process.argv[5] ? { maxDecodedBytes: Number(process.argv[5]) } : undefined;
// the IDAT is deflated a row block at a time: the fixture never holds the decoded image
const rawBytes = interlace ? null : h * (1 + w * 4);
const z = await new Promise((ok) => {
  const d = zlib.createDeflate({ level: 9 }),
    out = [];
  d.on('data', (c) => out.push(c));
  d.on('end', () => ok(Buffer.concat(out)));
  const block = Buffer.alloc(64 * (1 + w * 4));
  let left = rawBytes ?? 0;
  if (interlace) {
    // Adam7: every pass's rows, filter 0, all zero
    for (const [x0, y0, dx, dy] of [
      [0, 0, 8, 8],
      [4, 0, 8, 8],
      [0, 4, 4, 8],
      [2, 0, 4, 4],
      [0, 2, 2, 4],
      [1, 0, 2, 2],
      [0, 1, 1, 2],
    ]) {
      const pw = Math.ceil((w - x0) / dx),
        ph = Math.ceil((h - y0) / dy);
      if (pw && ph) left += ph * (1 + pw * 4);
    }
  }
  const total = left;
  const pump = () => {
    while (left > 0) {
      const n = Math.min(left, block.length);
      left -= n;
      if (!d.write(block.subarray(0, n))) return d.once('drain', pump);
    }
    d.end();
  };
  pump();
  void total;
});
const file = Buffer.concat([SIG, ihdr(w, h, 8, 6, interlace), chunk('IDAT', z), chunk('IEND', Buffer.alloc(0))]);
global.gc();
await new Promise((r) => setImmediate(r));
global.gc();
const base = process.memoryUsage().rss,
  maxBefore = process.resourceUsage().maxRSS * 1024;
let peak = base;
let peakAB = 0;
const timer = setInterval(() => {
  const m = process.memoryUsage();
  peak = Math.max(peak, m.rss);
  peakAB = Math.max(peakAB, m.arrayBuffers);
}, 5);
const t = performance.now();
let error = null;
try {
  const pdf = createPdf({ write() {} });
  await pdf.embedImage(file, opt);
} catch (e) {
  error = String(e.message);
}
const ms = performance.now() - t;
clearInterval(timer);
const sampled = Math.max(peak, process.memoryUsage().rss),
  maxAfter = process.resourceUsage().maxRSS * 1024;
if (process.env.DEBUG_MEM)
  console.error({
    base: base / 2 ** 20,
    maxBefore: maxBefore / 2 ** 20,
    sampled: sampled / 2 ** 20,
    peakAB: peakAB / 2 ** 20,
    maxAfter: maxAfter / 2 ** 20,
  });
peak = Math.max(sampled, maxAfter);
console.log(JSON.stringify({ file: file.length, decoded: w * h * 4, growthMB: (peak - base) / 2 ** 20, ms, error }));
