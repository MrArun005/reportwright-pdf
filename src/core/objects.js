// @ts-check
/**
 * The object layer: object numbers, writing objects to the sink as they come, object streams for small objects, and a
 * cross-reference stream at the end. Copied from ReportWright's streaming writer (src/exporters/pdfstream.js).
 *
 * Where each object is (kind 1: at byte loc; 2: in object stream loc at index idx; 3: waiting for its object stream) is
 * kept in blocks of XB numbers, 7 bytes an object; a block the numbers have gone two past is deflated (a few KB), and
 * what is placed in it later is kept apart in `late`. So a file of millions of objects holds a few MB for its xref.
 */
import { latin1 } from './serialize.js';
import { deflate, deflateSync, inflateSync, Zlib } from './deflate.js';
import { raced } from './sink.js';

const CHUNK = 64 * 1024; // bytes gathered before a write to the sink
const OBJSTM = 100; // small objects per object stream
const XBITS = 14, XB = 1 << XBITS; // cross-reference entries per block

/**
 * @typedef {{ id?: string, dict?: (n: number, dict: string) => string, stream?: (n: number, bytes: Uint8Array, dict: string) => Uint8Array | Promise<Uint8Array>, trailer?: string }} Encryptor
 *   The encryption hook (security/). id: the file ID it derived its key with (32 hex digits). dict: a direct object's
 *   text with its hex strings encrypted (strings inside object streams are not: the object stream is, as a stream).
 *   stream: a stream's bytes, after any filter (dict says what it is: a /Type /Metadata stream may be left alone).
 *   trailer: entries for the trailer (" /Encrypt 12 0 R"). The xref stream is never encrypted.
 * @param {{ write(b: Uint8Array): Promise<void> }} out
 * @param {{ compress: boolean, signal?: AbortSignal, encrypt?: Encryptor | null }} o
 */
export function createObjects(out, o) {
  let pos = 0, nextNum = 0;
  /** @type {({ kind: Uint8Array, loc: Uint32Array, idx: Uint16Array } | Uint8Array)[]} */
  const blocks = [];
  /** @type {Map<number, number>} object → kind · 2^48 + loc · 2^16 + idx, for a block already deflated */
  const late = new Map();
  let packed = 0;
  const place = (/** @type {number} */ n, /** @type {number} */ k, /** @type {number} */ l, i = 0) => {
    const b = blocks[n >>> XBITS];
    if (b instanceof Uint8Array) { late.set(n, k * 2 ** 48 + l * 2 ** 16 + i); return; }
    const j = n & (XB - 1);
    b.kind[j] = k; b.loc[j] = l; b.idx[j] = i;
  };
  const reserve = () => {
    const n = nextNum++;
    if (!(n & (XB - 1))) {
      blocks.push({ kind: new Uint8Array(XB), loc: new Uint32Array(XB), idx: new Uint16Array(XB) });
      const old = blocks.length - 3, b = blocks[old];
      if (old > 0 && !(b instanceof Uint8Array)) { // block 0 (the file's first objects) stays open
        for (let j = 0; j < XB; j++) if (b.kind[j] !== 1 && b.kind[j] !== 2) late.set(old * XB + j, b.kind[j] * 2 ** 48);
        const raw = new Uint8Array(XB * 7);
        raw.set(b.kind); raw.set(new Uint8Array(b.loc.buffer), XB); raw.set(new Uint8Array(b.idx.buffer), XB * 5);
        packed += (blocks[old] = deflateSync(raw, { level: 1 })).length;
      }
    }
    return n;
  };
  /** @type {[number, any]} the block last opened for reading */
  let reading = [-1, null];
  /** @param {number} n @returns {[number, number, number]} kind, loc, idx */
  const where = (n) => {
    const v = late.get(n);
    if (v !== undefined) return [Math.floor(v / 2 ** 48), Math.floor(v / 2 ** 16) % 2 ** 32, v % 2 ** 16];
    const bi = n >>> XBITS, j = n & (XB - 1);
    const z = blocks[bi];
    if (z instanceof Uint8Array && reading[0] !== bi) { const raw = inflateSync(z); reading = [bi, { kind: raw.subarray(0, XB), loc: new Uint32Array(raw.buffer, raw.byteOffset + XB, XB), idx: new Uint16Array(raw.buffer, raw.byteOffset + XB * 5, XB) }]; }
    const b = z instanceof Uint8Array ? reading[1] : z;
    return [b.kind[j], b.loc[j], b.idx[j]];
  };
  reserve(); // object 0: free

  // the file's bytes go out CHUNK at a time; a 128-bit FNV-1a of them is the default file ID (same input, same bytes)
  /** @type {Uint8Array[]} */
  let parts = [];
  let size = 0;
  const h = new Uint32Array([0x811c9dc5, 0x01000193, 0xcbf29ce4, 0x84222325]);
  const hash = (/** @type {Uint8Array} */ u8) => {
    let a = h[0], b = h[1], c = h[2], d = h[3];
    for (let i = 0; i < u8.length; i++) {
      const x = u8[i];
      a = Math.imul(a ^ x, 16777619); b = Math.imul(b ^ x, 16777619) + a; c = Math.imul(c ^ x, 16777619) ^ b; d = Math.imul(d ^ x, 16777619) + c;
    }
    h[0] = a; h[1] = b; h[2] = c; h[3] = d;
  };
  const flush = async () => {
    if (!size) return;
    const all = new Uint8Array(size);
    let at = 0;
    for (const p of parts) { all.set(p, at); at += p.length; }
    parts = []; size = 0;
    hash(all);
    await raced(out.write(all), o.signal);
  };
  /** @param {string | Uint8Array} x */
  const put = (x) => {
    const u8 = typeof x === 'string' ? latin1(x) : x;
    parts.push(u8); size += u8.length; pos += u8.length;
    return size >= CHUNK ? flush() : undefined;
  };

  /** @type {[number, string][]} small objects waiting for their object stream */
  let batch = [];
  const writeBatch = async () => {
    if (!batch.length) return;
    const b = batch; batch = [];
    const sn = reserve();
    let head = '', body = '';
    b.forEach(([n, d], i) => { head += `${n} ${body.length} `; body += `${d}\n`; place(n, 2, sn, i); });
    const raw = latin1(head + body);
    await writeDirect(sn, `<< /Type /ObjStm /N ${b.length} /First ${head.length}${o.compress ? ' /Filter /FlateDecode' : ''} >>`, o.compress ? await deflate(raw) : raw);
  };
  /** @param {number} n @param {string} dict @param {Uint8Array} [stream] */
  const writeDirect = async (n, dict, stream) => {
    const E = o.encrypt;
    place(n, 1, pos);
    if (!stream) { await put(`${n} 0 obj\n${E?.dict ? E.dict(n, dict) : dict}\nendobj\n`); return; }
    if (E?.stream) stream = await E.stream(n, stream, dict);
    if (E?.dict) dict = E.dict(n, dict);
    await put(`${n} 0 obj\n${dict.replace(/>>\s*$/, `/Length ${stream.length} >>`)}\nstream\n`);
    await put(stream);
    await put('\nendstream\nendobj\n');
  };
  put('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');

  return {
    get pos() { return pos; },
    /** bytes held for the cross-reference */
    get xrefBytes() { return blocks.reduce((t, b) => t + (b instanceof Uint8Array ? 0 : XB * 7), packed + late.size * 40); },
    /** a new object number, to write later with write() */
    reserve,
    /**
     * Write object n now: a dictionary (or any value) and, for a stream, its bytes (already filtered; /Length is added).
     * Small objects go into object streams (compressed together).
     * @param {number} n @param {string} dict @param {Uint8Array} [stream]
     */
    write(n, dict, stream) {
      if (stream || dict.length > 4096) return writeDirect(n, dict, stream);
      batch.push([n, dict]);
      place(n, 3, 0);
      return batch.length >= OBJSTM ? writeBatch() : undefined;
    },
    /**
     * Write object n whose text may be long (a parent tree of every page): head, the parts as they come, tail;
     * written out in place, never held whole. @param {number} n @param {string} head @param {Iterable<string>} parts @param {string} tail
     */
    async writeBig(n, head, parts, tail) {
      if (o.encrypt?.dict) { let s = head; for (const x of parts) s += x; return writeDirect(n, s + tail); } // ponytail: encrypted, held whole
      place(n, 1, pos);
      await put(`${n} 0 obj\n${head}`);
      for (const x of parts) await put(x);
      await put(`${tail}\nendobj\n`);
    },
    /**
     * The end: null objects for numbers reserved and never written, the last object stream, the cross-reference stream
     * and the trailer. @param {{ root: number, info: number, id?: string }} t
     */
    async finish(t) {
      for (let n = 1; n < nextNum; n++) if (!where(n)[0]) await this.write(n, 'null');
      await writeBatch();
      const xn = reserve(), count = nextNum, xref = pos;
      place(xn, 1, xref);
      // compressed a block at a time; each row filtered by PNG's Up predictor (offsets that change little compress to almost nothing)
      /** @type {Uint8Array[]} */
      const z = [];
      const zs = new Zlib({ level: 6 }, (d) => { z.push(d); });
      const prev = new Uint8Array(7), row = new Uint8Array(7);
      for (let from = 0; from < count; from += 65536) {
        const to = Math.min(count, from + 65536), rows = new Uint8Array((to - from) * 8);
        for (let n = from; n < to; n++) {
          row.fill(0);
          if (n === 0) { row[5] = 0xff; row[6] = 0xff; }
          else {
            const [k, l, i] = where(n);
            row[0] = k; row[1] = l >>> 24 & 255; row[2] = l >>> 16 & 255; row[3] = l >>> 8 & 255; row[4] = l & 255;
            if (k === 2) { row[5] = i >> 8; row[6] = i & 255; }
          }
          const at = (n - from) * 8;
          rows[at] = 2; // Up
          for (let b = 0; b < 7; b++) { rows[at + 1 + b] = (row[b] - prev[b]) & 255; prev[b] = row[b]; }
        }
        zs.push(rows, to === count);
      }
      let zn = 0; for (const c of z) zn += c.length;
      const zb = new Uint8Array(zn); zn = 0; for (const c of z) { zb.set(c, zn); zn += c.length; }
      await flush();
      const id = o.encrypt?.id || t.id || [...h].map((x) => x.toString(16).padStart(8, '0')).join('');
      await put(`${xn} 0 obj\n<< /Type /XRef /Size ${count} /W [1 4 2] /DecodeParms << /Columns 7 /Predictor 12 >> /Root ${t.root} 0 R /Info ${t.info} 0 R /ID [<${id}> <${id}>]${o.encrypt?.trailer || ''} /Filter /FlateDecode /Length ${zb.length} >>\nstream\n`);
      await put(zb);
      await put(`\nendstream\nendobj\nstartxref\n${xref}\n%%EOF\n`);
      await flush();
      return { bytes: pos, objects: count };
    },
  };
}
