// @ts-check
/**
 * A page. Drawing methods come from the feature modules (installed below: one line per module); each is a function
 * whose `this` is the page and which appends operators to page.content (content/content.js).
 *
 * Extension points (ARCHITECTURE.md): page.content (operators, marked content), page.annotate(make) (annotations),
 * page.onWrite(fn) (objects written with the page), page.entries (page dictionary entries), doc.resource(...).
 */
import { Content } from './content/content.js';
import { brand } from './core/brand.js';
import { text } from './text/text.js';
import { line, rect } from './graphics/shapes.js';
import { link } from './nav/links.js';
import { path, fill, stroke, fillAndStroke, svgPath, clip, shade, save, restore, transform, translate, rotate, scale, skew, figure } from './graphics/draw.js';
import { linearGradient, radialGradient, tilingPattern } from './graphics/paint.js';
import { image } from './images/image.js';

export class Page {
  /**
   * @param {import('./document.js').Doc} doc @param {number} index 0-based @param {number} width @param {number} height
   */
  constructor(doc, index, width, height) {
    this.doc = doc;
    this.index = index;
    this.number = index + 1;
    this.width = width;
    this.height = height;
    /** this page's object number (reserved: links and outlines may point at it before it is written) */
    this.ref = doc.pageRef(index);
    this.content = new Content();
    /** @type {Map<string, string>} more page dictionary entries, key without the slash → value ("Rotate" → "90") */
    this.entries = new Map();
    /** @type {{ ref: number, make: (ref: number, final: boolean) => string | undefined }[]} */
    this.annots = [];
    /** @type {((page: Page) => Promise<void> | void)[]} */
    this.writers = [];
    this.ended = false;
    doc.tags?.attach(this);
    brand(this, 'page', doc, index); // its index as created: links and outlines read it from here, not from page.index
  }
  /**
   * Add an annotation: make(ref, final) gives its dictionary when the page is written; undefined there means "not yet"
   * (asked again at the end, with final true). @param {(ref: number, final: boolean) => string | undefined} make @returns {number} its object number
   */
  annotate(make) {
    this.#open();
    const ref = this.doc.reserve();
    this.annots.push({ ref, make });
    return ref;
  }
  /** Run fn when the page is written, before its dictionary (write objects the page refers to, set entries). @param {(page: Page) => Promise<void> | void} fn */
  onWrite(fn) { this.#open(); this.writers.push(fn); }
  /**
   * The structure element of what fn draws (tagged PDFs; otherwise fn just runs).
   * @template T @param {string} type @param {() => T} fn @param {import('./tags/tags.js').TagOptions} [o] @returns {T}
   */
  tag(type, fn, o) { this.#open(); return this.doc.tags ? this.doc.tags.tag(this, type, fn, o) : fn(); }
  /** The page is done: compressed and written (in order, a few pages compressing at once). */
  end() {
    if (this.ended) return Promise.resolve();
    this.ended = true;
    return this.doc.queuePage(this);
  }
  #open() { if (this.ended) throw new Error(`Page ${this.number} has ended: nothing more can be drawn on it`); }
}

/**
 * Add drawing methods to every page (a feature module's one line here). Each runs with `this` the page, after a check
 * that the page has not ended. @param {Record<string, (this: Page, ...a: any[]) => any>} methods
 */
export function install(methods) {
  for (const [name, f] of Object.entries(methods)) {
    /** @type {any} */ (Page.prototype)[name] = function (/** @type {any[]} */ ...a) {
      if (this.ended) throw new Error(`Page ${this.number} has ended: nothing more can be drawn on it`);
      return f.apply(this, a);
    };
  }
}

install({ text, line, rect, link });
install({ path, fill, stroke, fillAndStroke, svgPath, clip, shade, save, restore, transform, translate, rotate, scale, skew, figure, linearGradient, radialGradient, tilingPattern });
install({ image });
