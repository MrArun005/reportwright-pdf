// @ts-check
/**
 * The object layer: object numbers, writing objects to the sink as they come, object streams for small objects, and a
 * cross-reference stream at the end. Copied from ReportWright's streaming writer (src/exporters/pdfstream.js).
 *
 * Where each object is (kind 1: at byte loc; 2: in object stream loc at index idx; 3: waiting for its object stream) is
 * kept in blocks of XB numbers, 7 bytes an object; a block the numbers have gone two past is deflated (a few KB), and
 * what is placed in it later is kept apart in `late`. So a file of millions of objects holds a few MB for its xref.
 *
 * classic (PDF/A-1, which is PDF 1.4): no object streams and a classic cross-reference table and trailer instead of
 * the xref stream, and the header says %PDF-1.4. Rows are made from the same blocks, 65,536 at a time.
 */
import { latin1 } from './serialize.js';
import { deflate } from './deflate.js';
import { builtin, fflate, fflateNow } from './lazy.js';
import { raced } from './sink.js';

const CHUNK = 64 * 1024; // bytes gathered before a write to the sink
const OBJSTM = 100; // small objects per object stream
const XBITS = 14, XB = 1 << XBITS; // cross-reference entries per block
/** the signature dictionary's /ByteRange placeholder (security/sign.js writes it, finish() fills it): fixed width */
export const BYTERANGE = `/ByteRange [0 ${'0'.repeat(10)} ${'0'.repeat(10)} ${'0'.repeat(10)}]`;

/**
 * @typedef {{ id?: string, ref?: number, dict?: (n: number, dict: string) => string | Promise<string>, stream?: (n: number, bytes: Uint8Array, dict: string) => Uint8Array | Promise<Uint8Array>, trailer?: string }} Encryptor
 *   The encryption hook (security/encrypt.js). id: the file ID it derived its key with (32 hex digits). ref: the
 *   Encrypt dictionary's number (written directly, never encrypted, never in an object stream). dict: a direct object's
 *   text with its hex strings encrypted (strings inside object streams are not: the object stream is, as a stream).
 *   stream: a stream's bytes, after any filter (dict says what it is: a /Type /Metadata stream may be left alone).
 *   trailer: entries for the trailer (" /Encrypt 12 0 R"). The xref stream is never encrypted.
 * @typedef {{ n: number, size: number, head: string, after: string, sign: (digest: Uint8Array) => Promise<Uint8Array> }} LastObject
 *   The signature dictionary (security/sign.js), written as the file's last object: head ends at "/Contents " and holds
 *   BYTERANGE (a placeholder replaced by the real, fixed-width /ByteRange), then size bytes of hex, then after.
 *   sign gets the digest (o.hash) of every byte but /Contents' value and gives the CMS.
 * @param {{ write(b: Uint8Array): Promise<void> }} out
 * @param {{ compress: boolean, signal?: AbortSignal, encrypt?: Encryptor | null, hash?: { update(b: Uint8Array): void, digest(): Promise<Uint8Array> } | null, classic?: boolean }} o
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
  // a closed block, deflated in memory (never written): node:zlib, else fflate once it is loaded, else left open
  const pack = (/** @type {Uint8Array} */ raw) => {
    const Z = builtin('node:zlib');
    if (Z) return new Uint8Array(Z.deflateSync(raw, { level: 1 }));
    return fflateNow()?.deflateSync(raw, { level: 1 }) ?? null;
  };
  /** @param {Uint8Array} z @returns {Uint8Array} a fresh copy at offset 0 (the views below need aligned offsets) */
  const unpack = (z) => { const Z = builtin('node:zlib'); return Z ? new Uint8Array(Z.inflateSync(z)) : /** @type {any} */ (fflateNow()).inflateSync(z); };
  if (!builtin('node:zlib')) fflate().catch(() => {}); // outside Node, closed blocks pack once fflate is in
  const block = (/** @type {number} */ size) => ({ kind: new Uint8Array(size), loc: new Uint32Array(size), idx: new Uint16Array(size) });
  const reserve = () => {
    const n = nextNum++;
    if (n && n < XB && n >= /** @type {any} */ (blocks[0]).kind.length) { // block 0 starts small and doubles: most files (a split's every page) have a few objects
      const b0 = /** @type {any} */ (blocks[0]), b = block(b0.kind.length * 2);
      b.kind.set(b0.kind); b.loc.set(b0.loc); b.idx.set(b0.idx);
      blocks[0] = b;
    }
    if (!(n & (XB - 1))) {
      blocks.push(block(n ? XB : 64));
      const old = blocks.length - 3, b = blocks[old];
      if (old > 0 && !(b instanceof Uint8Array)) { // block 0 (the file's first objects) stays open
        const raw = new Uint8Array(XB * 7);
        raw.set(b.kind); raw.set(new Uint8Array(b.loc.buffer), XB); raw.set(new Uint8Array(b.idx.buffer), XB * 5);
        const z = pack(raw);
        if (z) { // else (fflate not loaded yet, outside Node) the block stays open: memory only, the file is the same
          for (let j = 0; j < XB; j++) if (b.kind[j] !== 1 && b.kind[j] !== 2) late.set(old * XB + j, b.kind[j] * 2 ** 48);
          packed += (blocks[old] = z).length;
        }
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
    if (z instanceof Uint8Array && reading[0] !== bi) { const raw = unpack(z); reading = [bi, { kind: raw.subarray(0, XB), loc: new Uint32Array(raw.buffer, raw.byteOffset + XB, XB), idx: new Uint16Array(raw.buffer, raw.byteOffset + XB * 5, XB) }]; }
    const b = z instanceof Uint8Array ? reading[1] : z;
    return [b.kind[j], b.loc[j], b.idx[j]];
  };
  reserve(); // object 0: free

  // the file's bytes go out CHUNK at a time; a 128-bit FNV-1a of them is the default file ID (same input, same bytes)
  /** @type {Uint8Array[]} */
  let parts = [];
  let size = 0;
  let hasher = o.hash || null; // the signature's digest of every byte (null once the digest is taken)
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
    if (!o.encrypt?.id) hash(all); // the default file ID only: an encrypted file's ID is the encryptor's
    hasher?.update(all);
    await raced(out.write(all), o.signal);
  };
  /** @param {string | Uint8Array} x */
  const put = (x) => {
    // a caller's bytes (a JPEG, a profile, a PNG's IDAT) are copied if held past this call: the caller may reuse them
    // before the flush; a string's bytes are ours, and a put that fills the chunk is copied out by flush() right now
    const u8 = typeof x === 'string' ? latin1(x) : size + x.length >= CHUNK ? x : x.slice();
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
    // encrypted first (it may await), then placed and put with nothing in between
    if (stream && E?.stream) { const x = E.stream(n, stream, dict); stream = x instanceof Uint8Array ? x : await x; }
    if (E?.dict) { const x = E.dict(n, dict); dict = typeof x === 'string' ? x : await x; }
    place(n, 1, pos);
    if (!stream) { await put(`${n} 0 obj\n${dict}\nendobj\n`); return; }
    await put(`${n} 0 obj\n${dict.replace(/>>\s*$/, `/Length ${stream.length} >>`)}\nstream\n`);
    await put(stream);
    await put('\nendstream\nendobj\n');
  };
  put(`%PDF-${o.classic ? '1.4' : '1.7'}\n%\xe2\xe3\xcf\xd3\n`);

  return {
    get pos() { return pos; },
    /** bytes held for the cross-reference */
    get xrefBytes() { return blocks.reduce((t, b) => t + (b instanceof Uint8Array ? 0 : b.kind.length * 7), packed + late.size * 40); },
    /** a new object number, to write later with write() */
    reserve,
    /**
     * Write object n now: a dictionary (or any value) and, for a stream, its bytes (already filtered; /Length is added).
     * Small objects go into object streams (compressed together).
     * @param {number} n @param {string} dict @param {Uint8Array} [stream]
     */
    write(n, dict, stream) {
      if (stream || o.classic || dict.length > 4096 || n === o.encrypt?.ref) return writeDirect(n, dict, stream);
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
     * and the trailer. last: the signature dictionary, written last (its digest covers everything after it too).
     * @param {{ root: number, info: number, id?: string, last?: LastObject | null }} t
     */
    async finish(t) {
      const L = t.last;
      for (let n = 1; n < nextNum; n++) if (!where(n)[0] && n !== L?.n) await this.write(n, 'null');
      await writeBatch();
      await flush();
      const id = o.encrypt?.id || t.id || [...h].map((x) => x.toString(16).padStart(8, '0')).join(''); // with a signature: the bytes before it
      const xn = o.classic ? 0 : reserve(), count = nextNum;
      /** @type {{ head: string, rest: string } | null} */
      let sig = null;
      if (L) { // its text is known but for /Contents' value, whose length is fixed: so the xref's offset is known
        place(L.n, 1, pos);
        const after = o.encrypt?.dict ? await o.encrypt.dict(L.n, L.after) : L.after; // its strings encrypted; /Contents never
        sig = { head: `${L.n} 0 obj\n${L.head}`, rest: `${after}\nendobj\n` };
      }
      const xref = sig ? pos + sig.head.length + 2 * L.size + 2 + sig.rest.length : pos;
      const trailer = `/Root ${t.root} 0 R /Info ${t.info} 0 R /ID [<${id}> <${id}>]${o.encrypt?.trailer || ''}`;
      /** @type {Uint8Array[]} the cross-reference section and the trailer */
      const xparts = [];
      if (o.classic) { // "xref", 20-byte rows, "trailer"
        xparts.push(latin1(`xref\n0 ${count}\n`));
        for (let from = 0; from < count; from += 65536) {
          let rows = '';
          for (let n = from; n < Math.min(count, from + 65536); n++) {
            if (n === 0) { rows += '0000000000 65535 f\r\n'; continue; }
            const [k, l] = where(n);
            if (k !== 1) throw new Error(`internal: object ${n} is not written directly in a classic xref`);
            rows += `${String(l).padStart(10, '0')} 00000 n\r\n`;
          }
          xparts.push(latin1(rows));
        }
        xparts.push(latin1(`trailer\n<< /Size ${count} ${trailer} >>\nstartxref\n${xref}\n%%EOF\n`));
      } else {
        place(xn, 1, xref);
        // each row filtered by PNG's Up predictor (offsets that change little compress to almost nothing), then deflated
        // in one go: fflate's streaming Zlib (0.8.3) lets matches in its first 32 KB reach back into the zeros before the
        // stream ("invalid distance too far back"), so it is not used. ponytail: 8 bytes an object held at the end only.
        const rows = new Uint8Array(count * 8), prev = new Uint8Array(7), row = new Uint8Array(7);
        for (let n = 0; n < count; n++) {
          row.fill(0);
          if (n === 0) { row[5] = 0xff; row[6] = 0xff; }
          else {
            const [k, l, i] = where(n);
            row[0] = k; row[1] = l >>> 24 & 255; row[2] = l >>> 16 & 255; row[3] = l >>> 8 & 255; row[4] = l & 255;
            if (k === 2) { row[5] = i >> 8; row[6] = i & 255; }
          }
          const at = n * 8;
          rows[at] = 2; // Up
          for (let b = 0; b < 7; b++) { rows[at + 1 + b] = (row[b] - prev[b]) & 255; prev[b] = row[b]; }
        }
        const zb = (await fflate()).zlibSync(rows, { level: 6 });
        xparts.push(latin1(`${xn} 0 obj\n<< /Type /XRef /Size ${count} /W [1 4 2] /DecodeParms << /Columns 7 /Predictor 12 >> ${trailer} /Filter /FlateDecode /Length ${zb.length} >>\nstream\n`), zb, latin1(`\nendstream\nendobj\nstartxref\n${xref}\n%%EOF\n`));
      }
      if (sig && L) {
        const H = hasher;
        if (!H) throw new Error('internal: a signature without its digest');
        hasher = null;
        // ByteRange: [0, the '<' of /Contents) and (its '>', the end]. The digest of those bytes: everything flushed so
        // far (hashed as it went out), this object's head, and the tail (the rest of it, the xref, the trailer), held here.
        const a = pos + sig.head.length, b = a + 2 * L.size + 2;
        const tail = [latin1(sig.rest), ...xparts];
        let c = 0; for (const x of tail) c += x.length;
        const range = `/ByteRange [0 ${a} ${b} ${c}]`;
        const head = sig.head.replace(BYTERANGE, range.padEnd(BYTERANGE.length));
        if (head.length !== sig.head.length) throw new Error('internal: the /ByteRange does not fit its placeholder');
        H.update(latin1(head));
        for (const x of tail) H.update(x);
        const cms = await L.sign(await H.digest());
        if (cms.length > L.size) throw new RangeError(`sign: the signature (CMS, ${cms.length} bytes) is larger than the space reserved for it (${L.size} bytes): pass a larger reserve`);
        let hx = ''; for (const x of cms) hx += x.toString(16).padStart(2, '0');
        await put(`${head}<${hx.padEnd(2 * L.size, '0')}>`);
        for (const x of tail) await put(x);
        await flush();
        return { bytes: pos, objects: count };
      }
      for (const x of xparts) await put(x);
      await flush();
      return { bytes: pos, objects: count };
    },
  };
}
