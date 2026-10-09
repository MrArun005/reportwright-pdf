// @ts-check
/**
 * The document: pages written as they end (a few compressing at once, written in order), then at the end the
 * feature finishers, the fonts, the shared Resources, the page tree, metadata, Info, catalog and cross-reference.
 * From ReportWright's createPdfStream (src/exporters/pdfstream.js).
 *
 * `doc` is the extension API every feature module works through (ARCHITECTURE.md): reserve/write objects, register
 * resources, add catalog entries, run code at the end.
 */
import { createObjects } from './core/objects.js';
import { deflate } from './core/deflate.js';
import { latin1, num, text, pdfDate, pdfName } from './core/serialize.js';
import { xmpPacket, PRODUCER } from './standards/xmp.js';

const LEAF = 64; // pages per node of the page tree
const IN_FLIGHT = 8; // pages compressing at once

/**
 * @typedef {{ doc: Doc, ref: number, key: string, standard: boolean, name: string, ascent: number, descent: number,
 *   missing: Set<string>, widthOf(text: string, size: number): number, encode(text: string): string, write(): Promise<void> }} Font
 *   A font as pages use it: name is its resource name; encode gives a literal string's escaped body (and records the
 *   glyphs for the subset); write() writes its objects (at the end).
 * @typedef {ReturnType<typeof createDoc>} Doc
 */

/**
 * @param {{ write(b: Uint8Array): Promise<void> }} out
 * @param {{ compress: boolean, pdfa: boolean, pdfaLevel?: import('./standards/level.js').Level | null, tagged: boolean, signal?: AbortSignal, encrypt?: import('./core/objects.js').Encryptor | null,
 *   hash?: { update(b: Uint8Array): void, digest(): Promise<Uint8Array> } | null,
 *   info: { title?: string, author?: string, subject?: string, keywords?: string, creationDate: Date }, id?: string }} o
 */
export function createDoc(out, o) {
  const level = o.pdfaLevel ?? (o.pdfa ? { part: 2, conformance: 'b', unicode: false } : null);
  const objs = createObjects(out, { compress: o.compress, signal: o.signal, encrypt: o.encrypt, hash: o.hash, classic: level?.part === 1 });
  /** @type {Map<string, Map<string, string>>} kind → value → name */
  const resources = new Map();
  /** @type {Map<string, string>} */
  const catalog = new Map();
  /** @type {(() => Promise<void> | void)[]} */
  const finishers = [];
  /** @type {Font[]} */
  const fonts = [];
  /** @type {Set<string>} */
  const warnings = new Set();
  /** @type {number[]} */
  const pageRefs = [], heights = [], leaves = [];
  /** @type {Set<any>} pages not ended */
  const open = new Set();
  /** @type {any[]} ended pages, their streams compressing */
  const inFlight = [];
  /** @type {{ ref: number, make: (ref: number, final: boolean) => string | undefined }[]} annotations waiting for a page */
  const deferred = [];
  const resRef = objs.reserve();
  let finished = false;
  /** @type {Promise<any>} */
  let chain = Promise.resolve();
  /** @type {any} */
  let failed = null;

  /** the oldest ended page: its content stream, the objects of its writers, its annotations, its dictionary */
  async function writeNext() {
    const p = inFlight.shift();
    const z = await p.z; p.z = null;
    // a page from another file with nothing drawn by this writer has no content stream of ours (p.own gets 0)
    const contents = p.own && !p.content.s ? 0 : objs.reserve();
    if (contents) await objs.write(contents, o.compress ? '<< /Filter /FlateDecode >>' : '<< >>', z);
    for (const fn of p.writers) await fn(p);
    const annots = [];
    for (const a of p.annots) {
      const d = a.make(a.ref, false);
      if (d === undefined) deferred.push(a); else await objs.write(a.ref, d);
      annots.push(`${a.ref} 0 R`);
    }
    let extra = '';
    for (const [k, v] of p.entries) extra += ` ${pdfName(k)} ${v}`;
    // a page from another file (reader/save.js): its own dictionary, given this content stream and these annotations
    if (p.own) await objs.write(p.ref, await p.own(leaves[Math.floor(p.index / LEAF)], contents, annots));
    else await objs.write(p.ref, `<< /Type /Page /Parent ${leaves[Math.floor(p.index / LEAF)]} 0 R /MediaBox [0 0 ${num(p.width)} ${num(p.height)}] /Resources ${resRef} 0 R /Contents ${contents} 0 R${annots.length ? ` /Annots [${annots.join(' ')}]` : ''}${extra} >>`);
    p.annots = []; p.writers = []; p.entries = new Map(); p.content = null; // nothing of the page stays
  }

  /** @param {{ ref: number, kids: number[], count: number, parent?: number }[]} nodes */
  async function writeNodes(nodes) {
    for (const n of nodes) await objs.write(n.ref, `<< /Type /Pages${n.parent ? ` /Parent ${n.parent} 0 R` : ''} /Kids [${n.kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${n.count} >>`);
  }

  const doc = {
    compress: o.compress,
    pdfa: o.pdfa,
    /** @type {import('./standards/level.js').Level | null} the PDF/A part and conformance (standards/level.js) */
    pdfaLevel: level,
    tagged: o.tagged,
    /** @type {import('./standards/xmp.js').Extension[]} more XMP schemas (with their PDF/A descriptions), read when the metadata is written */
    xmpExtensions: [],
    signal: o.signal,
    /** @type {Uint8Array | null} the XMP packet to write instead of the one made from the info (reader/save.js keeps a file's own) */
    xmp: null,
    /** @type {string | null} the Info dictionary to write instead (reader/save.js) */
    info: null,
    /** made to be signed: every byte is hashed (security/sign.js) */
    signing: !!o.hash,
    /** the AcroForm's /SigFlags (set by pdf.sign) */
    sigFlags: 0,
    /** @type {import('./core/objects.js').LastObject | null} the signature dictionary, written last (security/sign.js) */
    last: null,
    /** @type {any} the structure tree (tags/tags.js createTagger), when tagged */
    tags: null,
    /** the shared Resources dictionary's object number (a form XObject that draws with page resources uses it) */
    resourcesRef: resRef,
    /** a new object number */
    reserve: () => objs.reserve(),
    /**
     * Write object n (a dictionary or any value; with a stream, its bytes already filtered). Small objects go into object
     * streams. @param {number} n @param {string} dict @param {Uint8Array} [stream]
     */
    write: (n, dict, stream) => objs.write(n, dict, stream),
    /** Write object n as a stream of raw bytes, Flate-compressed unless compress is off. @param {number} n @param {string} dict @param {Uint8Array} raw */
    async writeStream(n, dict, raw) {
      if (!o.compress) return objs.write(n, dict, raw);
      return objs.write(n, dict.replace(/>>\s*$/, '/Filter /FlateDecode >>'), await deflate(raw));
    },
    /** @param {number} n @param {string} head @param {Iterable<string>} parts @param {string} tail */
    writeBig: (n, head, parts, tail) => objs.writeBig(n, head, parts, tail),
    /** reserve and write @param {string} dict @param {Uint8Array} [stream] */
    async object(dict, stream) { const n = objs.reserve(); await objs.write(n, dict, stream); return n; },
    /**
     * A name in the shared Resources dictionary (every page's) for a value ("12 0 R" or an inline dictionary); the same
     * value gets the same name. @param {'Font'|'XObject'|'ExtGState'|'Pattern'|'Shading'|'ColorSpace'|'Properties'} kind
     * @param {string} value @param {string} [name] @returns {string}
     */
    resource(kind, value, name) {
      let m = resources.get(kind);
      if (!m) resources.set(kind, m = new Map());
      let r = m.get(value);
      if (!r) m.set(value, r = pdfName(name || `${kind === 'ExtGState' ? 'GS' : kind === 'Properties' ? 'MC' : kind[0]}${m.size + 1}`).slice(1)); // sanitised: content streams write it as /name
      return r;
    },
    /** Set a catalog entry (key without the slash). Read when the catalog is written, after every finisher. @param {string} key @param {string} value */
    catalog(key, value) { catalog.set(key, value); },
    /** Run fn at the end, after the last page is written and before the fonts and the catalog. In order of registration. @param {() => Promise<void> | void} fn */
    onFinish(fn) { if (finished) throw new Error('The PDF has ended'); finishers.push(fn); },
    /** A font, written after every finisher (so a finisher may still draw with it). @param {Font} f */
    addFont(f) { fonts.push(f); },
    /** page i's object number (0-based), reserved if it is not yet @param {number} i */
    pageRef: (i) => (pageRefs[i] ??= objs.reserve()),
    /** page i's height, once it exists @param {number} i @returns {number | undefined} */
    pageHeight: (i) => heights[i],
    get pageCount() { return heights.length; },
    /** @param {string} msg */
    warn(msg) { if (warnings.size < 1000) warnings.add(msg); },
    /**
     * Run fn after everything queued before it, one at a time; after a failure, everything later fails with that error.
     * @template T @param {() => Promise<T>} fn @returns {Promise<T>}
     */
    serial(fn) {
      const p = chain.then(() => { if (failed) throw failed; return fn(); });
      chain = p.catch((e) => { failed ??= e; });
      return p;
    },
    get failed() { return failed; },
    /** a new page's index @param {any} page */
    newPage(page) {
      if (finished) throw new Error('The PDF has ended');
      const i = heights.length;
      heights.push(page.height);
      if (i % LEAF === 0) leaves.push(objs.reserve());
      return i;
    },
    /** @param {any} page */
    opened(page) { open.add(page); },
    /** an ended page: its stream compresses now, it is written in turn @param {any} page */
    queuePage(page) {
      open.delete(page);
      const s = latin1(page.content.end());
      page.z = o.compress ? deflate(s) : Promise.resolve(s);
      page.z.catch(() => {});
      inFlight.push(page);
      return doc.serial(async () => { while (inFlight.length > IN_FLIGHT) await writeNext(); });
    },
    /** @param {() => any} blank a function that adds a blank page @returns {Promise<{ pages: number, bytes: number, warnings: string[] }>} */
    async finish(blank) {
      if (finished) throw new Error('The PDF has ended');
      for (const p of [...open].sort((a, b) => a.index - b.index)) p.end();
      if (!heights.length) blank().end(); // a PDF has at least one page
      return doc.serial(async () => {
        while (inFlight.length) await writeNext();
        for (const a of deferred) await objs.write(a.ref, /** @type {string} */ (a.make(a.ref, true)));
        for (let i = 0; i < finishers.length; i++) await finishers[i]();
        finished = true;
        for (const f of fonts) {
          await f.write();
          if (f.missing.size) warnings.add(`${f.key} has no glyph for ${[...f.missing].map((c) => JSON.stringify(c)).join(', ')}${f.missing.size >= 100 ? '…' : ''}`);
        }
        let res = '<< /ProcSet [/PDF /Text /ImageB /ImageC /ImageI]';
        for (const [kind, m] of resources) res += ` ${pdfName(kind)} << ${[...m].map(([v, n]) => `/${n} ${v}`).join(' ')} >>`;
        await objs.write(resRef, res + ' >>');

        // the page tree: leaves of LEAF pages, then nodes of LEAF nodes up to one root
        const pages = heights.length;
        /** @type {any[]} */
        let level = leaves.map((ref, k) => ({ ref, kids: pageRefs.slice(k * LEAF, Math.min(pages, (k + 1) * LEAF)), count: Math.min(LEAF, pages - k * LEAF) }));
        while (level.length > 1) {
          const up = [];
          for (let k = 0; k < level.length; k += LEAF) {
            const kids = level.slice(k, k + LEAF);
            up.push({ ref: objs.reserve(), kids: kids.map((x) => x.ref), count: kids.reduce((s, x) => s + x.count, 0), below: kids });
          }
          for (const node of up) for (const kid of node.below) kid.parent = node.ref;
          await writeNodes(level);
          level = up;
        }
        await writeNodes(level);

        const I = o.info, when = I.creationDate;
        const xmp = doc.xmp ?? new TextEncoder().encode(xmpPacket({ title: I.title, author: I.author, subject: I.subject, keywords: I.keywords, stamp: when.toISOString().replace(/\.\d+Z$/, 'Z'), pdfa: doc.pdfaLevel, ua: o.tagged, extensions: doc.xmpExtensions }));
        const meta = objs.reserve();
        await objs.write(meta, '<< /Type /Metadata /Subtype /XML >>', xmp);
        const info = objs.reserve();
        if (doc.info != null) await objs.write(info, doc.info);
        else await objs.write(info, `<< /Producer ${text(PRODUCER)} /Creator ${text(PRODUCER)}${I.title != null ? ` /Title ${text(I.title)}` : ''}${I.author != null ? ` /Author ${text(I.author)}` : ''}${I.subject != null ? ` /Subject ${text(I.subject)}` : ''}${I.keywords != null ? ` /Keywords ${text(I.keywords)}` : ''} /CreationDate ${pdfDate(when)} /ModDate ${pdfDate(when)} >>`);
        const root = objs.reserve();
        let cat = `<< /Type /Catalog /Pages ${level[0].ref} 0 R /Metadata ${meta} 0 R`;
        for (const [k, v] of catalog) cat += ` ${pdfName(k)} ${v}`;
        await objs.write(root, cat + ' >>');
        const r = await objs.finish({ root, info, id: o.id, last: doc.last });
        return { pages, bytes: r.bytes, warnings: [...warnings] };
      });
    },
  };
  return doc;
}
