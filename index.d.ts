// Types of @reportwright/pdf. Coordinates: PDF points, origin at the page's top-left corner, y growing downwards.

/** '#rgb', '#rrggbb', [r, g, b] with each 0–1, or a gray level 0–1. */
export type Color = string | [number, number, number] | number;

/** Where the bytes go: a Node Writable, a WHATWG WritableStream, or anything with write(bytes) (a returned promise is awaited). */
export type Sink =
  | NodeJS.WritableStream
  | WritableStream<Uint8Array>
  | { write(bytes: Uint8Array): unknown; close?(): unknown };

export interface PdfOptions {
  title?: string;
  author?: string;
  subject?: string;
  /** default: now. The same input and creationDate give the same bytes. Kept to the second, in UTC. */
  creationDate?: Date;
  /** Flate-compress content, fonts, object streams (default true). */
  compress?: boolean;
  /** PDF/A-2b: sRGB output intent and XMP identification. Fonts must be embedded. */
  pdfa?: boolean;
  /** PDF/UA-1: a structure tree from page.tag(). Needs title; fonts must be embedded. */
  tagged?: boolean | { lang?: string };
  /** stop the export: pending and later calls reject with signal.reason */
  signal?: AbortSignal;
  /** stop the export after this many milliseconds (a TimeoutError, code 'ETIMEDOUT') */
  timeoutMs?: number;
  /** the file identifier, 32 hex digits (default: a hash of the file's bytes) */
  id?: string;
}

export type StandardFontName =
  | 'Helvetica' | 'Helvetica-Bold' | 'Helvetica-Oblique' | 'Helvetica-BoldOblique'
  | 'Times-Roman' | 'Times-Bold' | 'Times-Italic' | 'Times-BoldItalic'
  | 'Courier' | 'Courier-Bold' | 'Courier-Oblique' | 'Courier-BoldOblique'
  | 'Symbol' | 'ZapfDingbats';

export interface Font {
  /** PostScript name */
  readonly key: string;
  readonly standard: boolean;
  /** ascender above the baseline, as a fraction of the font size */
  readonly ascent: number;
  /** descender (negative), as a fraction of the font size */
  readonly descent: number;
  /** advance width of text at size, in points (no kerning) */
  widthOf(text: string, size: number): number;
}

/** A subsetter that keeps glyph IDs (e.g. HarfBuzz with HB_SUBSET_FLAGS_RETAIN_GIDS). */
export type Subsetter = (font: Uint8Array, codePoints: Iterable<number>, opt: { glyphs: Iterable<number> }) => Uint8Array | Promise<Uint8Array>;

export interface TagOptions {
  /** alternate description (Figure, Formula…) */
  alt?: string;
  /** language of this element (BCP 47) */
  lang?: string;
  /** a TH's scope */
  scope?: 'Row' | 'Column' | 'Both';
}

export interface Page {
  /** 0-based */
  readonly index: number;
  /** 1-based */
  readonly number: number;
  readonly width: number;
  readonly height: number;
  /** One line of text; y is the top of the line box (baseline at y + font.ascent * size). */
  text(text: string, o: { x?: number; y?: number; font: Font; size?: number; color?: Color }): this;
  line(x1: number, y1: number, x2: number, y2: number, o?: { color?: Color; width?: number; dash?: number[] }): this;
  /** fill, stroke or both; neither: filled black */
  rect(x: number, y: number, w: number, h: number, o?: { fill?: Color; stroke?: Color; width?: number; dash?: number[] }): this;
  /** a link over a box: to a URL, or to a page (1-based number or page object; it may not exist yet), at top (default: fit) */
  link(x: number, y: number, w: number, h: number, target: { url: string } | { page: number | Page; top?: number }, o?: { alt?: string }): this;
  /** tagged PDFs: what fn draws (synchronously) becomes a structure element of that type; otherwise fn just runs */
  tag<T>(type: string, fn: () => T, o?: TagOptions): T;
  /** compress and write the page; nothing more can be drawn on it */
  end(): Promise<void>;
}

export interface OutlineEntry {
  title: string;
  /** 1-based page number or page object */
  page: number | Page;
  /** y on the page (default: fit the page) */
  top?: number;
  /** nesting, 0 = top level */
  level?: number;
}

export interface Pdf {
  standardFont(name: StandardFontName): Font;
  embedFont(bytes: Uint8Array | ArrayBuffer, o?: { subset?: boolean | Subsetter }): Promise<Font>;
  /** default A4 (595.28 × 841.89) */
  addPage(o?: { width?: number; height?: number }): Page;
  outline(entry: OutlineEntry | OutlineEntry[]): void;
  /** end open pages, write the rest, end the sink */
  end(): Promise<{ pages: number; bytes: number; warnings: string[] }>;
  /** the extension API (ARCHITECTURE.md); not covered by semver in 0.x */
  readonly core: unknown;
}

export function createPdf(sink: Sink, options?: PdfOptions): Pdf;
/** Build a PDF in memory. */
export function toBytes(build: (pdf: Pdf) => unknown, options?: PdfOptions): Promise<Uint8Array>;
export const STANDARD_NAMES: StandardFontName[];
