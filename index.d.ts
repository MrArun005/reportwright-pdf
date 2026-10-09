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
  /** Info /Keywords and XMP pdf:Keywords */
  keywords?: string;
  /** default: now. The same input and creationDate give the same bytes. Kept to the second, in UTC. */
  creationDate?: Date;
  /** Flate-compress content, fonts, object streams (default true). */
  compress?: boolean;
  /**
   * The zlib level (0–9) the object streams (the small objects, packed together) are compressed at: default 6. 9 makes
   * them a little smaller and slower; the same input and level give the same bytes.
   */
  objectStreamLevel?: number;
  /**
   * PDF/A: an output intent (sRGB, or outputIntent: your RGB or CMYK ICC output/monitor profile) and XMP
   * identification. Fonts must be embedded; device colour must match the intent (CMYK needs a CMYK intent, RGB an RGB one).
   * true is PDF/A-2b. part 1 (only 'b'): PDF 1.4, no transparency, layers or attachments, a classic xref.
   * 'u': every character drawn must map to Unicode (a missing glyph throws). 'a': 'u' plus tagged (required).
   * part 3: embedded files (pdf.attach, pdf.facturX).
   */
  pdfa?: boolean | { part?: 1 | 2 | 3; conformance?: 'a' | 'b' | 'u'; outputIntent?: Uint8Array | ArrayBuffer };
  /** PDF/UA-1: a structure tree from page.tag(). Needs title; fonts must be embedded. */
  tagged?: boolean | { lang?: string };
  /**
   * false: no XMP metadata stream, the Info dictionary only (about 1 KB smaller: a one-page invoice). Default true.
   * Refused with pdfa or tagged: PDF/A and PDF/UA require the XMP.
   */
  metadata?: boolean;
  /** stop the export: pending and later calls reject with signal.reason */
  signal?: AbortSignal;
  /** stop the export after this many milliseconds (a TimeoutError, code 'ETIMEDOUT') */
  timeoutMs?: number;
  /** the file identifier, 32 hex digits (default: a hash of the file's bytes) */
  id?: string;
  /** forms: flatten draws every field's appearance into its page and writes no AcroForm (a filled form as a plain PDF) */
  form?: { flatten?: boolean };
  /**
   * Password protection: AES-256 (V5/R6, the default) or AES-128 (V4/R4, for old readers). RC4 is refused (broken).
   * Not with PDF/A (it forbids encryption). With encryption the bytes differ on every run (random IVs and salts), and
   * the file ID is random unless `id` is given.
   */
  encrypt?: EncryptOptions;
  /** make the PDF signable with pdf.sign: every byte is hashed as it streams (true: SHA-256) */
  sign?: boolean | { hash?: HashName };
}

export type HashName = 'SHA-256' | 'SHA-384' | 'SHA-512';
export interface Permissions {
  print?: boolean; printHighQuality?: boolean; modify?: boolean; copy?: boolean; annotate?: boolean;
  fillForms?: boolean;
  /** text extraction for accessibility; forced on in a tagged (PDF/UA) PDF */
  accessibility?: boolean;
  assemble?: boolean;
}
export interface EncryptOptions {
  /** '' (default): opens without a prompt, the permissions apply. At most 1024 characters; the PDF keeps 127 UTF-8 bytes (SASLprep) for AES-256, 32 Latin-1 characters for AES-128 */
  userPassword?: string;
  /** full access; omitted: a random one (nobody can lift the permissions). Not '' */
  ownerPassword?: string;
  algorithm?: 'aes-256' | 'aes-128';
  /** every permission is granted unless set false here */
  permissions?: Permissions;
  /** default true; false leaves the XMP metadata readable */
  encryptMetadata?: boolean;
}

/** what pdf.sign hands the signer: the digest of the signed byte ranges */
export interface SignRequest {
  digest: Uint8Array;
  hash: HashName;
  subFilter: 'ETSI.CAdES.detached' | 'adbe.pkcs7.detached';
  /** the signing time (also /M) */
  date: Date;
  /** RFC 3161: the signer adds its TimeStampToken as an unsigned attribute (nodeSigner and cmsSigner do) */
  timestamp?: (signatureValue: Uint8Array) => Promise<Uint8Array> | Uint8Array;
  signal?: AbortSignal;
}
/** gives a DER CMS SignedData (detached) for the request */
export type Signer = (r: SignRequest) => Promise<Uint8Array> | Uint8Array;
export interface SignOptions {
  signer: Signer;
  reason?: string; location?: string; contactInfo?: string; name?: string;
  /** default: the creation date */
  date?: Date;
  /** a certification (DocMDP) signature: 1 no changes, 2 form filling and signing, 3 also annotations */
  certify?: 1 | 2 | 3;
  /** RFC 3161 TimeStampToken for the signature value (PAdES B-T). No network call is made by the library */
  timestamp?: (signatureValue: Uint8Array) => Promise<Uint8Array> | Uint8Array;
  /** default 'ETSI.CAdES.detached' (PAdES) */
  subFilter?: 'ETSI.CAdES.detached' | 'adbe.pkcs7.detached';
  /** bytes reserved for the CMS, 1024–1048576 (default 16384) */
  reserve?: number;
}
/** a signer with node:crypto: RSA (PKCS#1 v1.5, or PSS with pss: true) or ECDSA P-256 / P-384; certs: the PEM chain, the signer's first */
export function nodeSigner(o: { key: unknown; certs: string | Uint8Array | (string | Uint8Array)[]; pss?: boolean }): Signer;
/** a signer around a raw signature function (an HSM, a cloud KMS): sign(signedAttributes, hash) gives the signature value */
export function cmsSigner(o: { certs: string | Uint8Array | (string | Uint8Array)[]; keyAlgorithm: 'rsa' | 'rsa-pss' | 'ecdsa'; sign(bytes: Uint8Array, hash: HashName): Promise<Uint8Array> | Uint8Array }): Signer;

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
  /** /ActualText: the text this element stands for (replaces its content for extraction) */
  actualText?: string;
  /** /E: an abbreviation's expansion */
  expansion?: string;
  /** /ID (1–64 of A–Z a–z 0–9 _ . : -), unique; in the IDTree; TD/TH headers name these */
  id?: string;
  /** TD/TH: the ids of the TH cells that head it (/Headers) */
  headers?: string[];
  rowSpan?: number;
  colSpan?: number;
  /** L: /ListNumbering */
  listNumbering?: 'None' | 'Disc' | 'Circle' | 'Square' | 'Decimal' | 'UpperRoman' | 'LowerRoman' | 'UpperAlpha' | 'LowerAlpha';
}

/** A layer (an optional content group) from pdf.layer */
export interface Layer { readonly type: 'layer'; readonly name: string }
export interface LayerOptions {
  /** shown when the document opens (default true) */
  visible?: boolean;
  /** printed (default: visible). Differing from visible makes a print-only or screen-only layer (not in PDF/A) */
  printable?: boolean;
  /** the viewer does not let it be turned on or off */
  locked?: boolean;
}
export interface ArtifactOptions {
  type?: 'Pagination' | 'Layout' | 'Page';
  /** for Pagination */
  subtype?: 'Header' | 'Footer' | 'Watermark';
}
/** [x, y, width, height], top-left, inside the page (the MediaBox) */
export type Box = [number, number, number, number];
export interface PageOptions {
  width?: number;
  height?: number;
  cropBox?: Box;
  bleedBox?: Box;
  /** inside the bleedBox when both are given */
  trimBox?: Box;
  /** inside the bleedBox when both are given */
  artBox?: Box;
  /** clockwise, as viewers show the page; drawing coordinates stay those of the unrotated page */
  rotate?: 0 | 90 | 180 | 270;
  /** the size of the default unit in 1/72 inch (PDF 1.6; not in PDF/A-1) */
  userUnit?: number;
}
export type AFRelationship = 'Source' | 'Data' | 'Alternative' | 'Supplement' | 'Unspecified';
export interface AttachOptions {
  /** the file name, checked (spoofing, look-alikes, device names, an allowlist of passive types) */
  name: string;
  /** required in PDF/A-3; must agree with the extension */
  mimeType?: string;
  description?: string;
  /** /AFRelationship (default Unspecified in PDF/A-3) */
  relationship?: AFRelationship;
  created?: Date;
  /** default: the document's creationDate */
  modified?: Date;
  /** refuse a larger file (default and at most 256 MB) */
  maxBytes?: number;
  allowTypes?: string[];
  allowArchives?: boolean;
}
export type FacturXProfile = 'MINIMUM' | 'BASIC WL' | 'BASIC' | 'EN 16931' | 'EXTENDED' | 'XRECHNUNG';

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
  line(x1: number, y1: number, x2: number, y2: number, o?: { color?: Color; width?: number; dash?: number[]; opacity?: number; blendMode?: string }): this;
  /** fill, stroke or both; neither: filled black */
  rect(x: number, y: number, w: number, h: number, o?: { fill?: Color; stroke?: Color; width?: number; dash?: number[]; opacity?: number; fillOpacity?: number; strokeOpacity?: number; blendMode?: string }): this;
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
  /** what fn draws is a typed artifact (/Artifact << /Type /Pagination /Subtype /Header >>); tagged PDFs, outside any tag */
  artifact<T>(o: ArtifactOptions, fn: () => T): T;
  /** what fn draws (synchronously) belongs to the layer; save()/restore() must balance inside fn */
  layer<T>(layer: Layer, fn: () => T): T;
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

/** A form field made by pdf.form (an opaque handle: reset lists and signature locks take it). name is its full name. */
export interface Field {
  readonly type: 'field';
  readonly kind: 'text' | 'checkbox' | 'radio' | 'combo' | 'list' | 'button' | 'signature';
  readonly name: string;
}
/** Where a widget goes: a page of this PDF and a box (top-left space). */
export interface WidgetBox { page: Page; x?: number; y?: number; width: number; height: number }
export interface FieldOptions extends WidgetBox {
  /** /BS and /MK /BC (default { width: 1, color: 0 }); false: none */
  border?: { width?: number; color?: Color } | false;
  /** /MK /BG: a gray level, '#rrggbb', [r, g, b] or [c, m, y, k] */
  background?: Color;
  /** /TU: shown on hover, and the field's accessible name (required in tagged PDFs) */
  tooltip?: string;
  readOnly?: boolean;
  required?: boolean;
}
export interface FieldTextOptions {
  font: Font;
  /** fonts tried, in order, for characters the font lacks (a character none has throws) */
  fallback?: Font[];
  /** 0 (default): auto, the largest up to 12 that fits */
  size?: number;
  /** a device colour (written in /DA) */
  textColor?: Color;
  /** /Q */
  align?: 'left' | 'center' | 'right';
}
export type CheckStyle = 'check' | 'cross' | 'circle' | 'square' | 'diamond' | 'star';
export interface TextFieldOptions extends FieldOptions, FieldTextOptions {
  /** at most 100,000 characters (and maxLen); line breaks only when multiline */
  value?: string;
  defaultValue?: string;
  multiline?: boolean;
  /** takes no value: readers must never store a password in the file */
  password?: boolean;
  /** maxLen cells of equal width (needs maxLen ≤ 1000; not multiline or password) */
  comb?: boolean;
  maxLen?: number;
  doNotSpellCheck?: boolean;
  doNotScroll?: boolean;
}
export interface CheckboxOptions extends FieldOptions {
  checked?: boolean;
  /** the export value (the on state's name), default 'Yes'; not 'Off' */
  value?: string;
  style?: CheckStyle;
  /** the mark's colour */
  color?: Color;
}
export interface RadioGroupOptions extends Omit<FieldOptions, keyof WidgetBox> {
  /** 1–1000 buttons, each with its own export value (the same one only with radiosInUnison) */
  buttons: (WidgetBox & { value: string })[];
  /** the selected button's value (none: all off) */
  value?: string;
  /** default true: clicking the selected button does not turn it off */
  noToggleToOff?: boolean;
  radiosInUnison?: boolean;
  /** default 'circle' */
  style?: CheckStyle;
  color?: Color;
}
/** an option: one string (export value and display text), or [export value, display text] */
export type ChoiceOption = string | readonly [string, string];
export interface ChoiceOptions extends FieldOptions, FieldTextOptions {
  /** at most 10,000, in the order given (the Sort flag is never set); export values unique */
  options: ChoiceOption[];
}
export interface ComboBoxOptions extends ChoiceOptions {
  /** an export value; with editable, any text */
  value?: string;
  editable?: boolean;
  doNotSpellCheck?: boolean;
}
export interface ListBoxOptions extends ChoiceOptions {
  /** export values (several with multiSelect; /I gets their indexes) */
  value?: string | string[];
  multiSelect?: boolean;
}
/** A push button's action: ResetForm (all fields; or the fields named, or all but them with exclude) or a named page action. Nothing else. Not in PDF/A. */
export type ButtonAction = { reset: true } | { reset: (string | Field)[]; exclude?: boolean } | { named: 'NextPage' | 'PrevPage' | 'FirstPage' | 'LastPage' };
export interface ButtonOptions extends FieldOptions, Partial<FieldTextOptions> {
  /** needs font */
  label?: string;
  /** an image (pdf.embedImage), fitted in the button (above the label when there is one) */
  icon?: Image;
  action?: ButtonAction;
  /** the face when pressed (/D; not in PDF/A, whose appearances have /N only) */
  pressedBackground?: Color;
}
export interface SignatureOptions extends FieldOptions {
  /** /Lock: the fields signing locks */
  lock?: { action?: 'All' } | { action: 'Include' | 'Exclude'; fields: (string | Field)[] };
}
/** pdf.form, or a group of it: fields named here get this group's full name before theirs ("address.city"). */
export interface FormScope {
  /** a group: a parent field whose children are named "name.child". At most 32 levels. */
  group(name: string): FormScope;
  textField(name: string, o: TextFieldOptions): Field;
  checkbox(name: string, o: CheckboxOptions): Field;
  radioGroup(name: string, o: RadioGroupOptions): Field;
  comboBox(name: string, o: ComboBoxOptions): Field;
  listBox(name: string, o: ListBoxOptions): Field;
  button(name: string, o: ButtonOptions): Field;
  /** an empty signature field (a widget with a frame), for signing later */
  signature(name: string, o: SignatureOptions): Field;
}

export interface Pdf {
  standardFont(name: StandardFontName): Font;
  /** a TrueType or OpenType/CFF font; subset by default; shaper: text goes through it (complex scripts);
   * textMapping: 'carrier' (default: Firefox, pdf.js, search) or 'actualText' (a shaped cluster's text only in its ActualText: MuPDF, AI pipelines) */
  embedFont(bytes: Uint8Array | ArrayBuffer, o?: { subset?: boolean | Subsetter; shaper?: Shaper; textMapping?: 'carrier' | 'actualText' }): Promise<Font>;
  /** a JPEG or PNG, written now as an image XObject. colorSpace: an ICC colour space with the image's component count */
  embedImage(bytes: Uint8Array | ArrayBuffer, o?: { colorSpace?: IccColorSpace; /** the decoded size a PNG with alpha or interlacing may have; default 64 MB */ maxDecodedBytes?: number; /** zlib level for a re-compressed PNG (alpha, interlacing): 'default' = 6, or 3 above 2 megapixels; 'fast' = 1; or 1–9 */ compression?: 'default' | 'fast' | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 }): Promise<Image>;
  /** a spot colour: its name and the device colour (gray, RGB, CMYK) shown for it at full tint. One definition per name */
  spotColor(name: string, alternate: number | string | readonly number[]): SpotColor;
  /** an ICC-based colour space from a gray, RGB or CMYK profile (its header is checked) */
  iccColorSpace(profile: Uint8Array | ArrayBuffer): Promise<IccColorSpace>;
  /** default A4 (595.28 × 841.89) */
  addPage(o?: PageOptions): Page;
  /** a document-level embedded file (the EmbeddedFiles name tree); PDF/A-3 only among the PDF/A levels */
  attach(bytes: Uint8Array | ArrayBuffer, o: AttachOptions): Promise<void>;
  /** a Factur-X / ZUGFeRD / XRechnung invoice: the CII XML as factur-x.xml (xrechnung.xml) with the fx XMP schema. PDF/A-3 */
  facturX(xml: Uint8Array | ArrayBuffer, o: { profile: FacturXProfile; version?: '1.0' }): Promise<void>;
  /** a layer (optional content group); draw into it with page.layer. Not in PDF/A-1 */
  layer(name: string, o?: LayerOptions): Layer;
  /** bookmarks; at most 100,000 entries */
  outline(entry: OutlineEntry | OutlineEntry[]): void;
  /** a named destination (unique, at most 1024 UTF-8 bytes, 100,000 a document) for links, outline entries */
  destination(name: string, page: number | Page, fit?: Fit | Fit['fit']): void;
  /** page labels (a later call replaces them) */
  pageLabels(ranges: PageLabelRange[]): void;
  /** viewer preferences, page mode and layout, and the open action (later calls add to and override earlier ones) */
  viewer(o: ViewerOptions): void;
  /**
   * Interactive form fields. Names: no '.', control, format or bidi characters, at most 256 characters; full names
   * unique; at most 10,000 fields. No JavaScript, additional actions or submit actions can be written.
   */
  readonly form: FormScope;
  /**
   * Sign the document (PAdES B-B, B-T with a timestamp) as it is written: needs createPdf's `sign` option. field: a
   * signature field, or { name, page, x, y, width, height } to make one. The signer runs at end(); one signature a document.
   */
  sign(field: Field | ({ name: string } & SignatureOptions), o: SignOptions): Promise<void>;
  /** end open pages, write the rest, end the sink */
  end(): Promise<{ pages: number; bytes: number; warnings: string[] }>;
  /** the extension API (ARCHITECTURE.md); not covered by semver in 0.x */
  readonly core: unknown;
}

export function createPdf(sink: Sink, options?: PdfOptions): Pdf;
/** Build a PDF in memory. */
export function toBytes(build: (pdf: Pdf) => unknown, options?: PdfOptions): Promise<Uint8Array>;
export const STANDARD_NAMES: StandardFontName[];

// ---- reading and modifying (group H) ----

export type PdfReadErrorCode = 'E_MALFORMED' | 'E_BUDGET' | 'E_DEPTH' | 'E_CYCLE' | 'E_TIMEOUT' | 'E_ABORTED' | 'E_PASSWORD' | 'E_ENCRYPTED' | 'E_UNSUPPORTED' | 'E_ACTIVE' | 'E_SIGNED';
/** Every failure caused by the input (malformed, over budget, a loop, a wrong password, active content in an update). */
export class PdfReadError extends Error {
  readonly name: 'PdfReadError';
  readonly code: PdfReadErrorCode;
}
export interface ReadBudget {
  /** decoded stream bytes for the whole document (default 512 MB) */
  maxDecoded?: number;
  /** decoded bytes of one stream (default 128 MB) */
  maxStream?: number;
  /** parsing steps: tokens, xref rows, tree nodes, operators (default 200,000,000) */
  maxSteps?: number;
  /** cross-reference entries and scanned objects held (default 5,000,000) */
  maxObjects?: number;
  /** pieces of text one page's extraction holds (default 1,000,000; a page also stops at 16,000,000 characters) */
  maxTextItems?: number;
}
export interface LoadOptions {
  /** the user or the owner password (RC4, AES-128 and AES-256 files are read; only AES is ever written) */
  password?: string;
  budget?: ReadBudget;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export type Rect4 = [number, number, number, number];
export interface LoadedPage {
  readonly index: number;
  /** the MediaBox's size, in points */
  readonly width: number;
  readonly height: number;
  readonly mediaBox: Rect4; readonly cropBox: Rect4; readonly bleedBox: Rect4; readonly trimBox: Rect4; readonly artBox: Rect4;
  readonly rotation: 0 | 90 | 180 | 270;
  readonly userUnit: number;
  /** the text in content order, grouped in lines (not layout-perfect: no columns or reading order beyond the stream's) */
  /** timeoutMs: 30 000 by default (Infinity: only the document's own limit); E_TIMEOUT or E_BUDGET when exceeded */
  extractText(o?: { timeoutMs?: number }): string;
  annotations(): { subtype: string; rect: Rect4 | null; contents: string | null; uri: string | null; page: number | null }[];
  /**
   * Draw on top of the page at save(), with the writer's page methods (top-left space of the MediaBox), wrapped in
   * q/Q. fonts: a standard font's name or font bytes; images: PNG or JPEG bytes; made once in the new file.
   */
  draw(fn: (page: Page, r: { fonts: Record<string, Font>; images: Record<string, Image>; pdf: Pdf }) => void, o?: { fonts?: Record<string, StandardFontName | Uint8Array>; images?: Record<string, Uint8Array> }): this;
  /** turn by a multiple of 90 degrees, clockwise */
  rotate(deg: number): this;
  removeAnnotations(): this;
}
export interface LoadedField {
  name: string;
  type: 'text' | 'checkbox' | 'radio' | 'pushbutton' | 'combo' | 'list' | 'signature' | 'unknown';
  value: string | string[] | null;
  readOnly: boolean; required: boolean; flags: number;
  options: string[] | null; exports: string[] | null;
  widgets: { ref: number; page: number | null; rect: Rect4 | null; states: string[]; state: string | null }[];
}
export interface LoadedAttachment {
  /** the name as the file says it */
  rawName: string;
  /** the name checked like the writer's (core/filename.js), or null when refused (see refused) */
  name: string | null;
  refused: string | null;
  mimeType: string | null; page: number | null; description: string | null; size: number | null; relationship: string | null;
  /** the file's bytes, decoded under the document's budget (a PDF attachment is data: its own content is not sanitised) */
  bytes(): Uint8Array;
}
export interface LoadedSignature {
  field: string; subFilter: string | null; byteRange: Rect4 | null;
  name: string | null; reason: string | null; location: string | null; date: Date | null;
  wellFormed: boolean;
  /** it covers every byte of the file but its /Contents */
  coversWholeFile: boolean;
  revision: number;
  /** bytes appended after it (an incremental update) */
  bytesAfter: number | null;
  cms: Uint8Array | null;
  signedBytes(): Uint8Array;
}
export interface OutlineItem { title: string; page: number | null; url: string | null; children: OutlineItem[] }
export interface SaveOptions {
  /** re-compress uncompressed streams (default true) */
  compress?: boolean;
  /** keep JavaScript, Launch and other actions outside the allowlist, /AA, XFA, RichMedia… (default false: dropped and reported) */
  keepActiveContent?: boolean;
  /** AES encryption of the new file */
  encrypt?: EncryptOptions | true;
  /** 'keep' (default: when every document declares the same PDF/A level and output intent) or false */
  pdfa?: 'keep' | false;
  /** keep the structure tree (default true; only when every page comes from this document) */
  keepStructure?: boolean;
  creationDate?: Date;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface SaveResult {
  pages: number;
  /** what was removed: active content, signature values */
  stripped: { what: string; count: number }[];
  warnings: string[];
}
export interface IncrementalOptions {
  /** sign: an empty signature field's name, or { name, page, x, y, width, height } (no size: invisible) for a new one */
  sign?: { field: string | { name: string; page?: number; x?: number; y?: number; width?: number; height?: number }; signer: Signer; hash?: HashName } & Omit<SignOptions, 'signer' | 'certify'>;
  /** an update cannot remove bytes: a file with active content is refused (E_ACTIVE) unless this is true */
  keepActiveContent?: boolean;
  /** a signed document: form fills are refused (E_SIGNED) unless this is true; DocMDP and field locks still apply, and the
   *  filled widgets may cover at most 40% of a page in all (refilling existing widgets after signing is the "shadow
   *  attack" class) */
  allowFillAfterSigning?: boolean;
  /** a signed document without DocMDP: rotation and Info/XMP changes are refused (E_SIGNED) unless this is true */
  allowChangesAfterSigning?: boolean;
}
export interface LoadedPdf {
  readonly pageCount: number;
  readonly version: string;
  readonly encrypted: boolean;
  readonly encryption: { algorithm: 'rc4' | 'aes-128' | 'aes-256'; revision: number; owner: boolean; permissions: Record<keyof Permissions, boolean> } | null;
  /** the cross-reference was broken and rebuilt by scanning */
  readonly recovered: boolean;
  readonly warnings: string[];
  readonly info: { title?: string; author?: string; subject?: string; keywords?: string; creator?: string; producer?: string; creationDate?: Date | null; modDate?: Date | null };
  readonly xmp: string | null;
  readonly pdfa: { part: number; conformance: 'a' | 'b' | 'u' } | null;
  readonly outlines: OutlineItem[];
  readonly fields: LoadedField[];
  readonly attachments: LoadedAttachment[];
  readonly signatures: LoadedSignature[];
  page(i: number): LoadedPage;
  /** every page's text, joined by form feeds */
  /** timeoutMs: 30 000 by default (Infinity: only the document's own limit); E_TIMEOUT or E_BUDGET when exceeded */
  extractText(o?: { timeoutMs?: number }): string;
  setInfo(info: { title?: string | null; author?: string | null; subject?: string | null; keywords?: string | null; creator?: string | null }): this;
  setXmp(xml: string): this;
  copyPages(src: LoadedPdf, indexes?: number[], o?: { at?: number }): this;
  merge(others: LoadedPdf[]): this;
  removePages(indexes: number[]): this;
  reorder(order: number[]): this;
  movePage(from: number, to: number): this;
  removeAnnotations(): this;
  /** text, combo and radio: a string; check box: a boolean; list: a string or strings. font: for the new appearances (needed in PDF/A) */
  fill(values: Record<string, string | boolean | string[] | null>, o?: { font?: Uint8Array }): this;
  flatten(): this;
  /** a new file (a full rewrite through the writer) */
  save(o?: SaveOptions): Promise<SaveResult & { bytes: Uint8Array }>;
  saveTo(sink: Sink, o?: SaveOptions): Promise<SaveResult & { size: number }>;
  /** the original bytes and an update after them (existing signatures stay valid) */
  saveIncremental(o?: IncrementalOptions): Promise<{ bytes: Uint8Array; size: number; activeContent: { what: string; count: number }[]; warnings: string[] }>;
  /** an independent plan over the same source */
  fork(): LoadedPdf;
}
export function loadPdf(bytes: Uint8Array | ArrayBuffer, options?: LoadOptions): Promise<LoadedPdf>;
/** every page of each document, in order, in a new file (the first one's catalog, with what the others bring) */
export function mergePdfs(docs: LoadedPdf[], options?: SaveOptions): Promise<SaveResult & { bytes: Uint8Array }>;
/** the tasks bulk() runs, by name (no functions cross to a worker) */
export type BulkTask = 'extractText' | 'merge' | 'split' | 'encrypt';
export const BULK_TASKS: readonly BulkTask[];
/** what each task takes per item, and gives back */
export interface BulkTaskTypes {
  extractText: { input: Uint8Array | ArrayBuffer; value: string };
  merge: { input: (Uint8Array | ArrayBuffer)[]; value: Uint8Array };
  split: { input: Uint8Array | ArrayBuffer; value: Uint8Array[] };
  encrypt: { input: Uint8Array | ArrayBuffer; value: Uint8Array };
}
export type BulkResult<V> = { ok: true; value: V } | { ok: false; error: { name: string; code?: string; message: string } };
export interface BulkOptions {
  /** worker threads; default os.availableParallelism() - 1 (at least 1). 1, or no node:worker_threads (browsers): one at a time, in this thread */
  workers?: number;
  /** each worker's heap cap in MB (resourceLimits.maxOldGenerationSizeMb), default 512: an item past it fails with E_WORKER, alone */
  memoryMb?: number;
  /** loadPdf's options, for every input */
  password?: string;
  budget?: ReadBudget;
  timeoutMs?: number;
  /** the encrypt task's encryption */
  encrypt?: EncryptOptions;
  /** save()'s options for merge, split and encrypt */
  save?: SaveOptions;
  /** each item's result as it finishes (index in inputs) */
  onResult?: (index: number, result: BulkResult<unknown>) => void;
}
/** One named task over many inputs, in parallel worker threads (Node); results in input order, a failing item never stops the rest. */
export function bulk<T extends BulkTask>(inputs: Iterable<BulkTaskTypes[T]['input']>, task: T, options?: BulkOptions): Promise<BulkResult<BulkTaskTypes[T]['value']>[]>;
