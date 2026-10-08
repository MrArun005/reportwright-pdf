// Types of @reportwright/pdf. Coordinates: PDF points, origin at the page's top-left corner, y growing downwards.

/**
 * A gray level 0–1; '#rgb', '#rrggbb', 'rgb(255, 0, 0)', 'rgb(100% 0% 0%)' or [r, g, b] (0–1); cmyk(c, m, y, k) or
 * [c, m, y, k] (0–1); a spot colour or one of its tints; an ICC colour.
 */
export type Color = string | number | readonly [number, number, number] | readonly [number, number, number, number] | SpotColor | IccColor;

/** A CMYK colour, each component 0–1. */
export function cmyk(c: number, m: number, y: number, k: number): readonly [number, number, number, number];

/** A spot colour (Separation) made by pdf.spotColor: as a colour it is full tint. */
export interface SpotColor {
  readonly type: 'spot';
  /** the name as given (written as a PDF name with #xx escapes, so it round-trips exactly) */
  readonly name: string;
  /** the colour at a tint 0–1 */
  tint(t: number): IccColor;
}
/** A colour in a spot or ICC colour space (an opaque handle). */
export interface IccColor { readonly type: 'color' }
/** An ICC-based colour space made by pdf.iccColorSpace. */
export interface IccColorSpace {
  readonly type: 'iccColorSpace';
  /** 1 (gray), 3 (RGB) or 4 (CMYK), from the profile */
  readonly components: 1 | 3 | 4;
  /** a colour in this space: as many components as the profile has, each 0–1 */
  color(...components: number[]): IccColor;
}
/** An image made by pdf.embedImage (an opaque handle). width and height are pixels, upright (after EXIF orientation). */
export interface Image {
  readonly type: 'image';
  readonly width: number;
  readonly height: number;
}
export interface ImageOptions {
  /** top-left corner (default 0, 0) */
  x?: number;
  y?: number;
  /** the box; only one: the other keeps the aspect ratio; neither: one point per pixel */
  width?: number;
  height?: number;
  /** 'fill' (default: stretch), 'contain' (all of it, centred), 'cover' (fill the box, centred, cut to it) */
  fit?: 'fill' | 'contain' | 'cover';
  /** 0–1 */
  opacity?: number;
  /** tagged PDFs: the image is a Figure with this alternate text; without it, an artifact */
  alt?: string;
}

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
  /**
   * PDF/A-2b: an output intent (sRGB, or outputIntent: your RGB or CMYK ICC output/monitor profile) and XMP
   * identification. Fonts must be embedded; device colour must match the intent (CMYK needs a CMYK intent, RGB an RGB one).
   */
  pdfa?: boolean | { outputIntent?: Uint8Array | ArrayBuffer };
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
  /** the width text is drawn at, in points: kerned (unless kerning: false), shaped when the font has a shaper, with the spacing options */
  widthOfText(text: string, size: number, o?: MeasureOptions): number;
  /** the distance between baselines at size: ascent − descent + line gap (hhea); 1.2 × size for the standard fonts */
  lineHeight(size: number): number;
}

export interface MeasureOptions {
  /** pair kerning from GPOS or the kern table (default true; standard fonts are not kerned) */
  kerning?: boolean;
  /** points added after every glyph (Tc) */
  characterSpacing?: number;
  /** points added at every space (Tw for standard fonts; TJ adjustments for embedded ones) */
  wordSpacing?: number;
  /** horizontal scaling in percent (Tz, default 100) */
  horizontalScaling?: number;
  /** 'rtl': the run is drawn right to left (glyphs reversed, or the shaper told). No bidi algorithm: pass runs of one direction */
  direction?: 'ltr' | 'rtl';
}

/** a glyph from a shaper, in font units, in visual order (HarfBuzz's glyph infos and positions) */
export interface ShapedGlyph {
  /** glyph ID */
  g: number;
  /** cluster: the UTF-16 index in the text of the glyph's first character */
  cl: number;
  /** x advance */
  ax: number;
  /** x and y offsets */
  dx?: number;
  dy?: number;
}
/** shapes one run (one font, one direction); see examples/harfbuzz-shaper.mjs */
export type Shaper = (text: string, font: Font, o: { direction: 'ltr' | 'rtl'; kerning: boolean }) => ShapedGlyph[];

/** fill, stroke, fill + stroke, invisible; the same adding the glyphs to the clip (until the enclosing restore()); clip only */
export type RenderMode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 'fill' | 'stroke' | 'fillStroke' | 'invisible' | 'fillClip' | 'strokeClip' | 'fillStrokeClip' | 'clip';

export interface TextOptions extends MeasureOptions {
  x?: number;
  y?: number;
  font: Font;
  size?: number;
  color?: Color;
  /** characters the font lacks are drawn in the first of these that has them (at most 16) */
  fallback?: Font[];
  /** points the baseline is raised (Ts; negative lowers it), for super- and subscripts */
  rise?: number;
  renderMode?: RenderMode;
  /** the outline's colour and width in the stroking modes (default: color, 1) */
  strokeColor?: Color;
  strokeWidth?: number;
  /** radians, clockwise, about (x, y) */
  rotate?: number;
}

export interface TextBoxOptions extends TextOptions {
  width: number;
  /** lines that do not fit are not drawn; they come back as overflow */
  height?: number;
  align?: 'left' | 'right' | 'center' | 'justify';
  /** points between baselines (default font.lineHeight(size)) */
  lineHeight?: number;
  /** at most this many lines; the last ends with an ellipsis when text is left (ellipsis: false to not) */
  maxLines?: number;
  ellipsis?: boolean;
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

/**
 * A path, built as with the Canvas 2D API, in top-left, y-down points (angles in radians turn clockwise on the page).
 * Made by page.path(); not tied to a page. At most 1,000,000 segments; every number must be finite and under 1e9.
 */
export interface Path {
  readonly segments: number;
  moveTo(x: number, y: number): this;
  /** with no current point, a moveTo */
  lineTo(x: number, y: number): this;
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): this;
  /** written as the equivalent cubic */
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): this;
  arc(x: number, y: number, r: number, start: number, end: number, counterclockwise?: boolean): this;
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): this;
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, start: number, end: number, counterclockwise?: boolean): this;
  rect(x: number, y: number, w: number, h: number): this;
  /** radii: one radius, or [all] | [tl+br, tr+bl] | [tl, tr+bl, br] | [tl, tr, br, bl]; scaled down when they do not fit */
  roundedRect(x: number, y: number, w: number, h: number, radii?: number | number[]): this;
  closePath(): this;
  /** append SVG path data (M L H V C S Q T A Z, absolute and relative); at most 10 MB; malformed data throws a SyntaxError */
  svg(d: string): this;
}

/** A gradient or tiling pattern made by a page of this document (an opaque handle: copies and forgeries are refused). */
export interface Gradient { readonly type: 'gradient' }
export interface TilingPattern { readonly type: 'tiling' }
/** A colour, or a gradient / pattern as a paint. */
export type Paint = Color | Gradient | TilingPattern;
/** [[offset 0–1, colour], …] or [{ offset, color }, …]; 1–256 stops, sorted and clamped; one colour space (gray and RGB mix) */
export type ColorStops = ([number, Color] | { offset: number; color: Color })[];

export type BlendMode =
  | 'Normal' | 'Multiply' | 'Screen' | 'Overlay' | 'Darken' | 'Lighten' | 'ColorDodge' | 'ColorBurn'
  | 'HardLight' | 'SoftLight' | 'Difference' | 'Exclusion' | 'Hue' | 'Saturation' | 'Color' | 'Luminosity'
  | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'color-dodge' | 'color-burn' | 'hard-light'
  | 'soft-light' | 'difference' | 'exclusion' | 'hue' | 'saturation' | 'color' | 'luminosity';

export interface DrawOptions {
  /** fill paint (default black when filling); `color` sets whichever of fill / stroke the call paints */
  fill?: Paint;
  stroke?: Paint;
  color?: Paint;
  /** fill rule (default nonzero) */
  rule?: 'nonzero' | 'evenodd';
  /** stroke width (default 1) */
  width?: number;
  /** dash lengths (at most 100, not all 0) and phase */
  dash?: number[];
  dashPhase?: number;
  cap?: 'butt' | 'round' | 'square';
  join?: 'miter' | 'round' | 'bevel';
  /** ≥ 1 (default 10) */
  miterLimit?: number;
  /** 0–1, for fill and stroke; multiplied by fillOpacity / strokeOpacity */
  opacity?: number;
  fillOpacity?: number;
  strokeOpacity?: number;
  blendMode?: BlendMode;
}

export interface Page {
  /** 0-based */
  readonly index: number;
  /** 1-based */
  readonly number: number;
  readonly width: number;
  readonly height: number;
  /** One line of text; y is the top of the line box (baseline at y + font.ascent * size). */
  text(text: string, o: TextOptions): this;
  /**
   * Paragraphs (split at \n) wrapped by word into width (a word longer than a line is broken), aligned, from (x, y)
   * down. Returns the height used, the lines drawn and the text that did not fit (''). At most 10,000,000 characters.
   */
  textBox(text: string, o: TextBoxOptions): { height: number; lines: number; overflow: string };
  line(x1: number, y1: number, x2: number, y2: number, o?: { color?: Color; width?: number; dash?: number[] }): this;
  /** fill, stroke or both; neither: filled black */
  rect(x: number, y: number, w: number, h: number, o?: { fill?: Color; stroke?: Color; width?: number; dash?: number[] }): this;
  /** draw an image (pdf.embedImage) in a box; the same image drawn again is not written again */
  image(image: Image, o?: ImageOptions): this;
  /**
   * a link over a box: to a URL (http, https, mailto; allowSchemes widens, never to javascript:, vbscript:, data: or
   * file:), a page with a fit (it may not exist yet), a named destination, or NextPage/PrevPage/FirstPage/LastPage.
   * No other action (JavaScript, Launch, GoToR, SubmitForm…) can be written.
   */
  link(x: number, y: number, w: number, h: number, target: LinkTarget, o?: LinkOptions): this;
  /** a sticky note (Text annotation) at (x, y), 20 × 20; replyTo another note makes it a reply (/IRT) */
  note(x: number, y: number, o?: AnnotationOptions & { icon?: NoteIcon; open?: boolean; replyTo?: Annotation }): Annotation;
  /** text markup over one or more rectangles (the text's boxes); QuadPoints are computed from them */
  highlight(rects: Rect | Rect[], o?: AnnotationOptions): Annotation;
  underline(rects: Rect | Rect[], o?: AnnotationOptions): Annotation;
  strikeOut(rects: Rect | Rect[], o?: AnnotationOptions): Annotation;
  squiggly(rects: Rect | Rect[], o?: AnnotationOptions): Annotation;
  /** a FreeText annotation: text wrapped in a box, drawn with the package's text; contents default to the text */
  freeText(text: string, o: AnnotationOptions & Rect & { font: Font; size?: number; textColor?: Color; align?: 'left' | 'center' | 'right'; border?: { width?: number; color?: Color } | false; background?: Color; padding?: number }): Annotation;
  /** a shape annotation; color is the line, interior the fill (Square, Circle, Polygon; Line/PolyLine closed endings) */
  markup(type: 'Square' | 'Circle', box: Rect, o?: ShapeOptions): Annotation;
  markup(type: 'Line', line: { x1: number; y1: number; x2: number; y2: number }, o?: ShapeOptions & { lineEndings?: [LineEnding, LineEnding] }): Annotation;
  markup(type: 'Polygon', points: Point[], o?: ShapeOptions): Annotation;
  markup(type: 'PolyLine', points: Point[], o?: ShapeOptions & { lineEndings?: [LineEnding, LineEnding] }): Annotation;
  markup(type: 'Ink', strokes: Point[][], o?: ShapeOptions): Annotation;
  /** a rubber stamp: a standard name with its label drawn in font, or draw(ap) your own appearance (ap: a page of the box's size) */
  stamp(o: AnnotationOptions & Rect & ({ name?: StampName; font: Font } | { name?: StampName; draw: (ap: Page) => void })): Annotation;
  /**
   * a FileAttachment annotation embedding a file (not in PDF/A-2). name is checked (core/filename.js): passive types
   * only unless allowTypes lists the extension (you accept that type's risk); zip with allowArchives.
   */
  attachFile(bytes: Uint8Array | ArrayBuffer, o: AnnotationOptions & { x?: number; y?: number; name: string; mimeType?: string; description?: string; created?: Date; icon?: 'PushPin' | 'Paperclip' | 'Graph' | 'Tag'; allowTypes?: string[]; allowArchives?: boolean }): Annotation;
  /** a new, empty path */
  path(): Path;
  fill(path: Path, o?: DrawOptions): this;
  stroke(path: Path, o?: DrawOptions): this;
  fillAndStroke(path: Path, o?: DrawOptions): this;
  /** SVG path data, drawn as rect(): fill, stroke or both; neither: filled black */
  svgPath(d: string, o?: DrawOptions): this;
  /** intersect the clip with the path until the enclosing restore(); an empty path clips everything */
  clip(path: Path, rule?: 'nonzero' | 'evenodd'): this;
  /** paint a gradient over the current clip */
  shade(gradient: Gradient): this;
  /** save the graphics state (transform, clip, styles); at most 1000 deep (27 in PDF/A). Unrestored saves are closed at the page end with a warning */
  save(): this;
  /** throws without a matching save() */
  restore(): this;
  /** multiply the current transform (as canvas transform()) */
  transform(a: number, b: number, c: number, d: number, e: number, f: number): this;
  translate(x: number, y: number): this;
  /** radians, clockwise on the page */
  rotate(angle: number): this;
  scale(sx: number, sy?: number): this;
  /** radians, as CSS skew(ax, ay) */
  skew(ax: number, ay?: number): this;
  /** a gradient from (x0, y0) to (x1, y1), in the space current when it is painted; extend: past the ends (default true) */
  linearGradient(x0: number, y0: number, x1: number, y1: number, stops: ColorStops, o?: { extend?: boolean | [boolean, boolean] }): Gradient;
  radialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number, stops: ColorStops, o?: { extend?: boolean | [boolean, boolean] }): Gradient;
  /** draw(cell) draws one cell (shapes, gradients, patterns; not text or links), repeated every width + spacing */
  tilingPattern(o: { width: number; height: number; spacing?: number | [number, number] }, draw: (cell: Page) => void): TilingPattern;
  /** tagged PDFs: what fn draws is a Figure with this alt text (required); graphics outside a tag are artifacts. Otherwise fn just runs */
  figure<T>(o: { alt: string }, fn: () => T): T;
  /** tagged PDFs: what fn draws (synchronously) becomes a structure element of that type; otherwise fn just runs */
  tag<T>(type: string, fn: () => T, o?: TagOptions): T;
  /** compress and write the page; nothing more can be drawn on it */
  end(): Promise<void>;
}

/** how a destination fits its page; coordinates top-left. Without fit: XYZ when left, top or zoom is given, else Fit */
export interface Fit {
  fit?: 'XYZ' | 'Fit' | 'FitH' | 'FitV' | 'FitR' | 'FitB' | 'FitBH' | 'FitBV';
  left?: number;
  top?: number;
  /** FitR */
  right?: number;
  bottom?: number;
  /** XYZ: a factor, 1 = 100% (0 or none: keep) */
  zoom?: number;
}
export type LinkTarget = { url: string } | ({ page: number | Page } & Fit) | { dest: string } | { named: 'NextPage' | 'PrevPage' | 'FirstPage' | 'LastPage' };
export interface LinkOptions {
  /** what screen readers say (default: the URL or "Page n") */
  alt?: string;
  /** URL schemes allowed besides http, https and mailto (never javascript, vbscript, data, file) */
  allowSchemes?: string[];
  highlight?: 'none' | 'invert' | 'outline' | 'push';
  border?: { width?: number; style?: 'solid' | 'dashed' | 'beveled' | 'inset' | 'underline'; dash?: number[]; color?: Color };
  quadPoints?: Rect | Rect[];
}
export interface Rect { x: number; y: number; width: number; height: number }
export type Point = [number, number] | { x: number; y: number };
/** an annotation made by a page method (an opaque handle: a note's replyTo takes one) */
export interface Annotation { readonly type: 'annotation'; readonly subtype: string }
export interface AnnotationOptions {
  /** gray, RGB or CMYK (no spot or ICC colours) */
  color?: Color;
  /** the annotation's text; required in tagged PDFs (it is the alternate description) */
  contents?: string;
  /** /T */
  author?: string;
  modified?: Date;
  /** default: print (notes and attachments: also noZoom, noRotate). PDF/A: always printed and visible */
  flags?: Partial<Record<'invisible' | 'hidden' | 'print' | 'noZoom' | 'noRotate' | 'noView' | 'readOnly' | 'locked' | 'toggleNoView' | 'lockedContents', boolean>>;
}
export interface ShapeOptions extends AnnotationOptions { interior?: Color; lineWidth?: number; dash?: number[] }
export type NoteIcon = 'Comment' | 'Key' | 'Note' | 'Help' | 'NewParagraph' | 'Paragraph' | 'Insert';
export type LineEnding = 'None' | 'Square' | 'Circle' | 'Diamond' | 'OpenArrow' | 'ClosedArrow' | 'Butt' | 'ROpenArrow' | 'RClosedArrow' | 'Slash';
export type StampName = 'Approved' | 'Experimental' | 'NotApproved' | 'AsIs' | 'Expired' | 'NotForPublicRelease' | 'Confidential' | 'Final' | 'Sold' | 'Departmental' | 'ForComment' | 'TopSecret' | 'Draft' | 'ForPublicRelease';

export interface OutlineEntry extends Fit {
  /** at most 4096 characters */
  title: string;
  /** 1-based page number or page object (or dest) */
  page?: number | Page;
  /** a named destination (pdf.destination) instead of page */
  dest?: string;
  /** nesting, 0 = top level, at most 63 */
  level?: number;
  /** default true; closed: its children are hidden until opened */
  open?: boolean;
  /** RGB or gray */
  color?: Color;
  bold?: boolean;
  italic?: boolean;
}
export interface PageLabelRange {
  /** 0-based page index where the range starts */
  start: number;
  /** D decimal, r/R roman, a/A letters; none: the prefix alone */
  style?: 'D' | 'r' | 'R' | 'a' | 'A';
  prefix?: string;
  /** the first number (default 1) */
  first?: number;
}
export interface ViewerOptions {
  hideToolbar?: boolean; hideMenubar?: boolean; hideWindowUI?: boolean; fitWindow?: boolean; centerWindow?: boolean;
  /** cannot be false in tagged PDFs */
  displayDocTitle?: boolean;
  direction?: 'L2R' | 'R2L';
  printScaling?: 'None' | 'AppDefault';
  duplex?: 'Simplex' | 'DuplexFlipShortEdge' | 'DuplexFlipLongEdge';
  pickTrayByPDFSize?: boolean;
  /** 1–5 */
  numCopies?: number;
  pageMode?: 'UseNone' | 'UseOutlines' | 'UseThumbs' | 'FullScreen' | 'UseOC' | 'UseAttachments';
  pageLayout?: 'SinglePage' | 'OneColumn' | 'TwoColumnLeft' | 'TwoColumnRight' | 'TwoPageLeft' | 'TwoPageRight';
  /** the open action: a page destination (the only open action written) */
  openAt?: { page: number | Page } & Fit;
}

export interface Pdf {
  standardFont(name: StandardFontName): Font;
  /** a TrueType or OpenType/CFF font; subset by default; shaper: text goes through it (complex scripts) */
  embedFont(bytes: Uint8Array | ArrayBuffer, o?: { subset?: boolean | Subsetter; shaper?: Shaper }): Promise<Font>;
  /** a JPEG or PNG, written now as an image XObject. colorSpace: an ICC colour space with the image's component count */
  embedImage(bytes: Uint8Array | ArrayBuffer, o?: { colorSpace?: IccColorSpace }): Promise<Image>;
  /** a spot colour: its name and the device colour (gray, RGB, CMYK) shown for it at full tint. One definition per name */
  spotColor(name: string, alternate: number | string | readonly number[]): SpotColor;
  /** an ICC-based colour space from a gray, RGB or CMYK profile (its header is checked) */
  iccColorSpace(profile: Uint8Array | ArrayBuffer): Promise<IccColorSpace>;
  /** default A4 (595.28 × 841.89) */
  addPage(o?: { width?: number; height?: number }): Page;
  /** bookmarks; at most 100,000 entries */
  outline(entry: OutlineEntry | OutlineEntry[]): void;
  /** a named destination (unique, at most 1024 UTF-8 bytes, 100,000 a document) for links, outline entries */
  destination(name: string, page: number | Page, fit?: Fit | Fit['fit']): void;
  /** page labels (a later call replaces them) */
  pageLabels(ranges: PageLabelRange[]): void;
  /** viewer preferences, page mode and layout, and the open action (later calls add to and override earlier ones) */
  viewer(o: ViewerOptions): void;
  /** end open pages, write the rest, end the sink */
  end(): Promise<{ pages: number; bytes: number; warnings: string[] }>;
  /** the extension API (ARCHITECTURE.md); not covered by semver in 0.x */
  readonly core: unknown;
}

export function createPdf(sink: Sink, options?: PdfOptions): Pdf;
/** Build a PDF in memory. */
export function toBytes(build: (pdf: Pdf) => unknown, options?: PdfOptions): Promise<Uint8Array>;
export const STANDARD_NAMES: StandardFontName[];
