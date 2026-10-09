// @ts-check
/**
 * Interactive forms (AcroForm): pdf.form.textField / checkbox / radioGroup / comboBox / listBox / button / signature,
 * and pdf.form.group(name) for a hierarchy (address.city). Each field's widget is placed on a page; a field with one
 * widget is one dictionary (field and widget merged), a radio group a field with a widget per button. Every widget has
 * an appearance stream for every state it can show (form/draw.js): NeedAppearances is false, so viewers draw ours.
 * The AcroForm (fields, /DR = the shared Resources, which hold every font a /DA names) is written at pdf.end().
 * createPdf's `form: { flatten: true }` draws each appearance into the page instead and writes no AcroForm.
 *
 * SECURITY: no JavaScript of any kind. No /AA, no /JS, no format, keystroke, validate or calculate script, no
 * SubmitForm or ImportData: every field takes a fixed list of options and any other key throws (script-like keys with
 * a message saying why). A push button's action is ResetForm (all fields, or named ones) or a named page action; that
 * is all. Calculation order (/CO) does not apply: it orders calculate scripts, and there are none.
 * Every string (values, options, tooltips, names) is a hex text string; on-states and export names go through
 * pdfName; numbers through num(); handles (pages, fonts, images, fields) are looked up in the brand table.
 * Bounds: MAX_FIELDS fields and groups a document, MAX_BUTTONS buttons a radio group, MAX_OPTIONS options a choice
 * field (MAX_OPTION_CHARS characters in all), values of MAX_VALUE characters, partial names of MAX_NAME characters
 * (no '.', no control, format, bidi or separator characters), MAX_DEPTH levels of groups. Full names are unique.
 */
import { num, text, pdfName } from '../core/serialize.js';
import { brand, unbrand, kindOf } from '../core/brand.js';
import { appearance } from '../annotations/annot.js';
import { colorArray } from '../nav/links.js';
import { colorOp, device } from '../graphics/color.js';
import { fontsOf } from '../text/text.js';
import { MARKS, textValue, listRows, drawMark, frame, roundFrame, buttonFace } from './draw.js';

export const MAX_FIELDS = 10_000, MAX_BUTTONS = 1_000, MAX_OPTIONS = 10_000, MAX_OPTION_CHARS = 1_000_000,
  MAX_VALUE = 100_000, MAX_NAME = 256, MAX_DEPTH = 32, MAX_TOOLTIP = 4096, MAX_COMB = 1_000;
const NAMED = ['NextPage', 'PrevPage', 'FirstPage', 'LastPage'];
/** keys that ask for scripts or actions: refused with the reason */
const ACTIVE = /^(aa|additionalactions|actions?|js|javascript|script|format|keystroke|validate|calculate|calculation|calculationorder|co|onclick|onblur|onfocus|onchange|submit|submitform|importdata|launch|uri|url|gotor|gotoe|hide|rendition|sound|movie)$/i;
/** Ff bits (PDF 1.7 tables 221, 226, 228, 230) */
const FF = { readOnly: 1, required: 2, multiline: 1 << 12, password: 1 << 13, noToggleToOff: 1 << 14, radio: 1 << 15, pushButton: 1 << 16,
  combo: 1 << 17, edit: 1 << 18, multiSelect: 1 << 21, doNotSpellCheck: 1 << 22, doNotScroll: 1 << 23, comb: 1 << 24, radiosInUnison: 1 << 25 };
const BOX = ['page', 'x', 'y', 'width', 'height'];
const LOOK = ['border', 'background', 'tooltip', 'readOnly', 'required'];
const TEXT = ['font', 'fallback', 'size', 'textColor', 'align'];
const BAD_CHAR = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

/** ASCII (a /DA string) as a hex string @param {string} s */
const hexAscii = (s) => { let h = '<'; for (let i = 0; i < s.length; i++) h += (s.charCodeAt(i) & 255).toString(16).padStart(2, '0'); return `${h}>`; };

/** only these option keys; script-like ones say why @param {any} o @param {string[]} allowed @param {string} who */
function keys(o, allowed, who) {
  if (o == null || typeof o !== 'object') throw new TypeError(`${who}: options are an object`);
  for (const k of Object.keys(o)) {
    if (allowed.includes(k)) continue;
    if (ACTIVE.test(k)) throw new TypeError(`${who}: ${k}: form fields never carry JavaScript, additional actions (/AA), format, keystroke, validate or calculate scripts, SubmitForm or ImportData (a PDF writer must not carry active content); a push button's action is { reset } or { named }`);
    throw new TypeError(`${who}: unknown option ${JSON.stringify(k.slice(0, 40))} (${allowed.join(', ')})`);
  }
}
/** @param {any} v @param {string} what @param {string} who */
function bool(v, what, who) { if (v != null && typeof v !== 'boolean') throw new TypeError(`${who}: ${what} is true or false`); return !!v; }

/** a partial field name, checked @param {any} name @param {string} who */
function partial(name, who) {
  if (typeof name !== 'string' || !name) throw new TypeError(`${who}: a field name is a non-empty string`);
  if (name.length > MAX_NAME) throw new RangeError(`${who}: a field name is at most ${MAX_NAME} characters`);
  if (name.includes('.')) throw new TypeError(`${who}: a field name cannot contain '.' (it separates the levels of a full name: use pdf.form.group('a').textField('b', …) for "a.b")`);
  if (BAD_CHAR.test(name)) throw new TypeError(`${who}: a field name cannot contain control, format, bidi or separator characters (they hide or reorder what a reader shows)`);
  return name;
}
/** a string option (value, tooltip, label), checked @param {any} v @param {string} what @param {number} max @param {string} who */
function str(v, what, max, who) {
  if (typeof v !== 'string') throw new TypeError(`${who}: ${what} is a string`);
  if (v.length > max) throw new RangeError(`${who}: ${what} is at most ${max} characters`);
  return v;
}
/** every character of s in one of the fonts (else a clear error) @param {{ impl: any }[]} fonts @param {string} s @param {string} what @param {string} who */
function glyphs(fonts, s, what, who) {
  for (const ch of s) {
    const cp = /** @type {number} */ (ch.codePointAt(0));
    if (cp === 10 || cp === 13) continue;
    if (!fonts.some((f) => f.impl.has(cp))) throw new TypeError(`${who}: the font has no glyph for ${JSON.stringify(ch)} (U+${cp.toString(16).toUpperCase().padStart(4, '0')}) in the ${what}; use a font that has it, or add one as fallback`);
  }
}

/**
 * The document's form: pdf.form. @param {any} doc @param {{ flatten?: boolean } | undefined} opt
 */
export function createForm(doc, opt = {}) {
  if (opt == null || typeof opt !== 'object') throw new TypeError('createPdf: form is { flatten }');
  for (const k of Object.keys(opt)) if (k !== 'flatten') throw new TypeError(`createPdf: form: unknown option ${JSON.stringify(k)} (flatten)`);
  const flat = bool(opt.flatten, 'form.flatten', 'createPdf');
  /** @type {Map<string, any>} full name → its record */
  const names = new Map();
  /** @type {number[]} */
  const top = [];
  /** @type {{ ref: number, name: string, parent: any, kids: number[] }[]} */
  const groups = [];
  /** @type {(() => Promise<void>)[]} objects written at the end (radio parents, locks) */
  const later = [];
  /** @type {{ who: string, list: string[] }[]} names a reset or lock refers to, checked at the end */
  const refs = [];
  let count = 0, started = false;

  const start = () => {
    if (started) return;
    started = true;
    doc.onFinish(async () => {
      for (const r of refs) for (const n of r.list) if (!names.has(n)) throw new TypeError(`${r.who}: ${JSON.stringify(n.slice(0, 80))} is not a field of this form`);
      if (flat) return;
      for (const g of groups) await doc.write(g.ref, `<< /T ${text(g.name)}${g.parent ? ` /Parent ${g.parent.ref} 0 R` : ''} /Kids [${g.kids.map((k) => `${k} 0 R`).join(' ')}] >>`);
      for (const w of later) await w();
      const af = await doc.object(`<< /Fields [${top.map((k) => `${k} 0 R`).join(' ')}] /NeedAppearances false /DR ${doc.resourcesRef} 0 R >>`);
      doc.catalog('AcroForm', `${af} 0 R`);
    });
  };

  /** a full name in a scope, checked and unique (not yet taken) @param {any} sc @param {any} name @param {string} who */
  const fullName = (sc, name, who) => {
    const full = sc.prefix ? `${sc.prefix}.${partial(name, who)}` : partial(name, who);
    if (names.has(full)) throw new TypeError(`${who}: a field or group named ${JSON.stringify(full.slice(0, 200))} already exists (full names are unique)`);
    if (count >= MAX_FIELDS) throw new RangeError(`${who}: at most ${MAX_FIELDS} fields and groups a document`);
    return full;
  };
  /** take the name: counted, linked to its parent @param {any} sc @param {string} full @param {number} ref @param {any} rec */
  const commit = (sc, full, ref, rec) => {
    start();
    count++;
    names.set(full, rec);
    if (ref) (sc.group ? sc.group.kids : top).push(ref);
  };
  /** the widget's page and box @param {any} o @param {string} who */
  const placeOf = (o, who) => {
    unbrand(o.page, 'page', doc, 'page'); // a forged or another PDF's page is refused; the handle is the page itself
    const x = o.x ?? 0, y = o.y ?? 0, w = o.width, h = o.height;
    for (const v of [x, y, w, h]) if (typeof v !== 'number') throw new TypeError(`${who}: x, y, width and height are numbers`);
    for (const v of [x, y, w, h]) num(v);
    if (!(w > 0 && h > 0)) throw new RangeError(`${who}: width and height are above 0`);
    return { page: o.page, x, y, w, h };
  };
  /** border, background: the frame, /MK and /BS @param {any} o @param {string} who @param {{ border?: number, background?: any }} [d] */
  const lookOf = (o, who, d = {}) => {
    const b = o.border === false ? null : o.border ?? (d.border != null ? { width: d.border } : null);
    if (b != null && typeof b !== 'object') throw new TypeError(`${who}: border is { width, color } or false`);
    const bw = b ? b.width ?? 1 : 0, bc = b?.color ?? 0;
    num(bw);
    if (!(bw >= 0 && bw <= 100)) throw new RangeError(`${who}: border width is 0–100`);
    const bg = o.background ?? d.background ?? null;
    const mk = `${bw > 0 ? ` /BC ${colorArray(bc, doc, who)}` : ''}${bg != null ? ` /BG ${colorArray(bg, doc, who)}` : ''}`;
    return { f: { bw, bc, bg }, mk, bs: ` /BS << /W ${num(bw)} /S /S >>` };
  };
  /** tooltip (/TU: the accessible name; required when tagged) @param {any} o @param {string} who */
  const tipOf = (o, who) => {
    if (o.tooltip == null) { if (doc.tagged) throw new TypeError(`${who}: a tagged PDF (PDF/UA) needs a tooltip for every field (its accessible name, /TU)`); return ''; }
    if (doc.tagged && !String(o.tooltip).trim()) throw new TypeError(`${who}: the tooltip is the field's accessible name: not empty`);
    return str(o.tooltip, 'tooltip', MAX_TOOLTIP, who);
  };
  /** the text look (fonts, size, colour) and /DA @param {any} page @param {any} o @param {string} who */
  const textOf = (page, o, who) => {
    const fonts = fontsOf(page, o, who);
    const font = fonts[0].font; // branded and frozen: its name is the one the library gave it
    const size = o.size ?? 0;
    num(size);
    if (!(size === 0 || (size >= 1 && size <= 1000))) throw new RangeError(`${who}: size is 0 (auto) or 1–1000`);
    const color = o.textColor ?? 0;
    if (!device(color)) throw new TypeError(`${who}: textColor is a gray level, '#rrggbb', [r, g, b] or [c, m, y, k]`);
    const da = hexAscii(`${pdfName(font.name)} ${num(size)} Tf ${colorOp(color, false, doc)}`);
    return { t: { fonts, impl: fonts[0].impl, ascent: font.ascent, descent: font.descent, size, color }, da };
  };
  /** 0 left, 1 centre, 2 right @param {any} a @param {string} who */
  const qOf = (a, who) => { const q = ['left', 'center', 'right'].indexOf(a ?? 'left'); if (q < 0) throw new TypeError(`${who}: align is left, center or right`); return q; };
  /** the shared flags @param {any} o @param {string} who */
  const ffOf = (o, who) => (bool(o.readOnly, 'readOnly', who) ? FF.readOnly : 0) | (bool(o.required, 'required', who) ? FF.required : 0);
  /** names a reset or lock refers to: full names or field handles @param {any} list @param {string} who */
  const nameList = (list, who) => {
    if (!Array.isArray(list) || !list.length || list.length > MAX_FIELDS) throw new TypeError(`${who}: fields is a non-empty array of field names or fields`);
    const out = list.map((f) => {
      if (kindOf(f) === 'field') return unbrand(f, 'field', doc, 'field').full;
      if (typeof f !== 'string' || !f || f.length > MAX_NAME * MAX_DEPTH) throw new TypeError(`${who}: a field is a full name ("address.city") or a field this form made`);
      for (const p of f.split('.')) partial(p, who);
      return f;
    });
    refs.push({ who, list: out });
    return `[${out.map(text).join(' ')}]`;
  };

  /**
   * Place a widget: tagged, inside a Form element with the tooltip as Alt and an OBJR; flattened, the appearance is
   * drawn into the page (a Figure when tagged) and nothing is annotated. @param {{ page: any, x: number, y: number, w: number, h: number }} P
   * @param {(key: number) => string} dict the annotation's dictionary, given its /StructParent (-1: none)
   * @param {number} shown the appearance flattening draws @param {string} tip @param {string} alt
   */
  const place = (P, dict, shown, tip, alt) => {
    const { page } = P;
    if (flat) {
      const name = doc.resource('XObject', `${shown} 0 R`);
      const draw = () => page.content.op(`q 1 0 0 1 ${num(P.x)} ${num(page.height - P.y - P.h)} cm /${name} Do Q`);
      if (doc.tagged) page.tag('Figure', draw, { alt: alt ? `${tip}: ${alt}` : tip }); else draw();
      return 0;
    }
    let key = -1;
    const add = () => {
      const ref = page.annotate(() => dict(key));
      if (doc.tags) key = doc.tags.link(page, ref, 'Form');
      return ref;
    };
    return doc.tagged ? page.tag('Form', add, { alt: tip }) : add();
  };
  /** the widget part of a dictionary @param {any} P @param {string} more */
  const widget = (P, more) => `/Type /Annot /Subtype /Widget /Rect [${num(P.x)} ${num(P.page.height - P.y - P.h)} ${num(P.x + P.w)} ${num(P.page.height - P.y)}] /P ${P.page.ref} 0 R /F 4${more}`;
  const sp = (/** @type {number} */ key) => (key >= 0 ? ` /StructParent ${key}` : '');
  const handle = (/** @type {string} */ kind, /** @type {string} */ full, /** @type {any} */ data) =>
    brand(Object.freeze({ type: 'field', kind, name: full }), 'field', doc, { kind, full, ...data });

  /** a scope: the root form or a group @param {any} group @param {string} prefix @param {number} depth */
  const scope = (group, prefix, depth) => {
    const sc = { group, prefix };
    const parent = group ? ` /Parent ${group.ref} 0 R` : '';
    return Object.freeze({
      /** @param {string} name */
      group(name) {
        const who = 'form.group';
        if (depth >= MAX_DEPTH) throw new RangeError(`${who}: at most ${MAX_DEPTH} levels of groups`);
        const full = fullName(sc, name, who);
        if (flat) { commit(sc, full, 0, { kind: 'group' }); return scope(null, full, depth + 1); }
        const g = { ref: doc.reserve(), name, parent: group, kids: [] };
        groups.push(g);
        commit(sc, full, g.ref, { kind: 'group' });
        return scope(g, full, depth + 1);
      },

      /** @param {string} name @param {any} o */
      textField(name, o) {
        const who = 'form.textField';
        keys(o, [...BOX, ...LOOK, ...TEXT, 'value', 'defaultValue', 'multiline', 'password', 'comb', 'maxLen', 'doNotSpellCheck', 'doNotScroll'], who);
        const full = fullName(sc, name, who), P = placeOf(o, who), L = lookOf(o, who, { border: 1 }), tip = tipOf(o, who);
        const { t, da } = textOf(P.page, o, who), q = qOf(o.align, who);
        const multiline = bool(o.multiline, 'multiline', who), password = bool(o.password, 'password', who), comb = bool(o.comb, 'comb', who);
        let ff = ffOf(o, who) | (multiline ? FF.multiline : 0) | (password ? FF.password : 0) | (comb ? FF.comb : 0)
          | (bool(o.doNotSpellCheck, 'doNotSpellCheck', who) ? FF.doNotSpellCheck : 0) | (bool(o.doNotScroll, 'doNotScroll', who) ? FF.doNotScroll : 0);
        const maxLen = o.maxLen;
        if (maxLen != null && !(Number.isInteger(maxLen) && maxLen >= 1 && maxLen <= MAX_VALUE)) throw new RangeError(`${who}: maxLen is a whole number 1–${MAX_VALUE}`);
        if (comb && (maxLen == null || maxLen > MAX_COMB || multiline || password)) throw new TypeError(`${who}: comb needs maxLen (1–${MAX_COMB}) and is not multiline or password`);
        if (password && (o.value != null || o.defaultValue != null)) throw new TypeError(`${who}: a password field takes no value (readers must never store a password in the file)`);
        const check = (/** @type {any} */ v, /** @type {string} */ what) => {
          if (v == null) return null;
          str(v, what, MAX_VALUE, who);
          if (maxLen != null && [...v].length > maxLen) throw new RangeError(`${who}: the ${what} is longer than maxLen (${maxLen})`);
          if (!multiline && /[\r\n]/.test(v)) throw new TypeError(`${who}: the ${what} has a line break: set multiline`);
          glyphs(t.fonts, v, what, who);
          return v;
        };
        const value = check(o.value, 'value'), dv = check(o.defaultValue, 'defaultValue');
        const ap = appearance(P.page, P.w, P.h, (a) => textValue(a, P.w, P.h, L.f, t, value ?? '', { q, multiline, comb: comb ? maxLen : 0 }));
        commit(sc, full, 0, { kind: 'text' });
        const ref = place(P, (k) => `<< ${widget(P, `${parent} /FT /Tx /T ${text(name)}${tip ? ` /TU ${text(tip)}` : ''} /Ff ${ff}${value != null ? ` /V ${text(value)}` : ''}${dv != null ? ` /DV ${text(dv)}` : ''} /DA ${da} /Q ${q}${maxLen != null ? ` /MaxLen ${maxLen}` : ''}${L.mk ? ` /MK <<${L.mk} >>` : ''}${L.bs} /AP << /N ${ap} 0 R >>`)}${sp(k)} >>`, ap, tip, value ?? '');
        if (ref) (sc.group ? sc.group.kids : top).push(ref);
        return handle('text', full, { ref });
      },

      /** @param {string} name @param {any} o */
      checkbox(name, o) {
        const who = 'form.checkbox';
        keys(o, [...BOX, ...LOOK, 'checked', 'value', 'style', 'color'], who);
        const full = fullName(sc, name, who), P = placeOf(o, who), L = lookOf(o, who, { border: 1 }), tip = tipOf(o, who);
        const on = onName(o.value ?? 'Yes', who), style = markOf(o.style ?? 'check', who), color = o.color ?? 0;
        colorArray(color, doc, who);
        const checked = bool(o.checked, 'checked', who), ff = ffOf(o, who);
        const draw = (/** @type {boolean} */ mark) => appearance(P.page, P.w, P.h, (a) => { frame(a, P.w, P.h, L.f); if (mark) drawMark(a, P.w, P.h, style, color); });
        const yes = !flat || checked ? draw(true) : 0, off = !flat || !checked ? draw(false) : 0;
        commit(sc, full, 0, { kind: 'checkbox' });
        const st = checked ? on : '/Off';
        const ref = place(P, (k) => `<< ${widget(P, `${parent} /FT /Btn /T ${text(name)}${tip ? ` /TU ${text(tip)}` : ''} /Ff ${ff} /V ${st} /AS ${st} /MK << /CA ${text(MARKS[style])}${L.mk} >>${L.bs} /AP << /N << ${on} ${yes} 0 R /Off ${off} 0 R >> >>`)}${sp(k)} >>`, checked ? yes : off, tip, checked ? 'checked' : 'not checked');
        if (ref) (sc.group ? sc.group.kids : top).push(ref);
        return handle('checkbox', full, { ref });
      },

      /** @param {string} name @param {any} o */
      radioGroup(name, o) {
        const who = 'form.radioGroup';
        keys(o, ['buttons', 'value', 'noToggleToOff', 'radiosInUnison', 'style', 'color', ...LOOK], who);
        const full = fullName(sc, name, who), tip = tipOf(o, who), L = lookOf(o, who, { border: 1 });
        const style = markOf(o.style ?? 'circle', who), color = o.color ?? 0;
        colorArray(color, doc, who);
        const unison = bool(o.radiosInUnison, 'radiosInUnison', who);
        const ff = ffOf(o, who) | FF.radio | (o.noToggleToOff === false ? 0 : FF.noToggleToOff) | (unison ? FF.radiosInUnison : 0);
        bool(o.noToggleToOff, 'noToggleToOff', who);
        const list = o.buttons;
        if (!Array.isArray(list) || !list.length || list.length > MAX_BUTTONS) throw new TypeError(`${who}: buttons is an array of 1–${MAX_BUTTONS} { page, x, y, width, height, value }`);
        /** @type {Map<string, string>} written on-state → the value given */
        const seen = new Map();
        const items = list.map((b) => {
          keys(b, [...BOX, 'value'], who);
          const P = placeOf(b, who), on = onName(b.value, who), v = String(b.value);
          if (seen.has(on) && (!unison || seen.get(on) !== v)) throw new TypeError(`${who}: two buttons have the export value ${JSON.stringify(v.slice(0, 80))}${unison ? ' written alike' : ' (each button has its own, unless radiosInUnison)'}`);
          seen.set(on, v);
          return { P, on, v };
        });
        let sel = '/Off';
        if (o.value != null) {
          const hit = items.find((it) => it.v === o.value);
          if (!hit) throw new TypeError(`${who}: value ${JSON.stringify(String(o.value).slice(0, 80))} is not one of the buttons' values`);
          sel = hit.on;
        }
        const g = flat ? null : { ref: doc.reserve() };
        const kids = items.map(({ P, on }) => {
          const shown = on === sel;
          const draw = (/** @type {boolean} */ mark) => appearance(P.page, P.w, P.h, (a) => { roundFrame(a, P.w, P.h, L.f); if (mark) drawMark(a, P.w, P.h, style, color); });
          const yes = !flat || shown ? draw(true) : 0, off = !flat || !shown ? draw(false) : 0;
          return { P, on, yes, off, shown };
        });
        commit(sc, full, g ? g.ref : 0, { kind: 'radio' });
        const refsOut = kids.map(({ P, on, yes, off, shown }) => place(P, (k) => `<< ${widget(P, ` /Parent ${g?.ref} 0 R /AS ${shown ? on : '/Off'} /MK << /CA ${text(MARKS[style])}${L.mk} >>${L.bs} /AP << /N << ${on} ${yes} 0 R /Off ${off} 0 R >> >>`)}${sp(k)} >>`, shown ? yes : off, tip, shown ? 'selected' : 'not selected'));
        if (g) later.push(() => doc.write(g.ref, `<< /FT /Btn /T ${text(name)}${tip ? ` /TU ${text(tip)}` : ''} /Ff ${ff} /V ${sel}${parent} /Kids [${refsOut.map((r) => `${r} 0 R`).join(' ')}] >>`));
        return handle('radio', full, { ref: g?.ref ?? 0 });
      },

      /** @param {string} name @param {any} o */
      comboBox(name, o) { return choice(name, o, true); },
      /** @param {string} name @param {any} o */
      listBox(name, o) { return choice(name, o, false); },

      /** @param {string} name @param {any} o */
      button(name, o) {
        const who = 'form.button';
        keys(o, [...BOX, ...LOOK, ...TEXT, 'label', 'icon', 'action', 'pressedBackground'], who);
        const full = fullName(sc, name, who), P = placeOf(o, who), tip = tipOf(o, who);
        const L = lookOf(o, who, { border: 1, background: doc.outputIntent === 'CMYK' ? [0, 0, 0, 0.25] : 0.75 });
        const label = o.label != null ? str(o.label, 'label', MAX_TOOLTIP, who) : '';
        const T = label ? textOf(P.page, o, who) : null;
        if (T) glyphs(T.t.fonts, label, 'label', who);
        const icon = o.icon != null ? (unbrand(o.icon, 'image', doc, 'image (pdf.embedImage)'), o.icon) : null;
        if (!label && !icon) throw new TypeError(`${who}: a button needs a label or an icon`);
        const pressed = o.pressedBackground ?? (doc.outputIntent === 'CMYK' ? [0, 0, 0, 0.5] : 0.5);
        colorArray(pressed, doc, who);
        let action = '';
        if (o.action != null) {
          const a = o.action;
          keys(a, ['reset', 'exclude', 'named'], `${who}: action`);
          if (doc.pdfa) throw new TypeError(`${who}: PDF/A-2 allows no action on a widget (ISO 19005-2 6.4.1: no /A or /AA; and 6.5.1 forbids ResetForm); leave the action out`);
          if (a.named != null) {
            if (a.reset != null || a.exclude != null || !NAMED.includes(a.named)) throw new TypeError(`${who}: action is { named: ${NAMED.join(' | ')} } or { reset }`);
            action = ` /A << /Type /Action /S /Named /N /${a.named} >>`;
          } else if (a.reset === true) action = ' /A << /Type /Action /S /ResetForm >>';
          else if (a.reset != null) action = ` /A << /Type /Action /S /ResetForm /Fields ${nameList(a.reset, `${who}: action.reset`)}${bool(a.exclude, 'exclude', who) ? ' /Flags 1' : ''} >>`;
          else throw new TypeError(`${who}: action is { reset: true }, { reset: [names], exclude? } or { named }; nothing else (no JavaScript, SubmitForm, ImportData, URI or Launch)`);
        }
        const face = (/** @type {any} */ bg) => appearance(P.page, P.w, P.h, (a) => buttonFace(a, P.w, P.h, L.f, bg, T?.t ?? null, label, icon));
        const n = face(L.f.bg), d = flat || doc.pdfa ? 0 : face(pressed); // PDF/A-2: an appearance dictionary has /N only
        const mkI = icon && !flat ? ` /I ${appearance(P.page, 100, 100, (a) => a.image(icon, { width: 100, height: 100, fit: 'contain' }))} 0 R /TP ${label ? 2 : 1}` : '';
        commit(sc, full, 0, { kind: 'button' });
        const ref = place(P, (k) => `<< ${widget(P, `${parent} /FT /Btn /T ${text(name)}${tip ? ` /TU ${text(tip)}` : ''} /Ff ${ffOf(o, who) | FF.pushButton}${T ? ` /DA ${T.da}` : ''} /MK <<${label ? ` /CA ${text(label)}` : ''}${mkI}${L.mk} >>${L.bs}${action} ${doc.pdfa ? `/AS /Push /AP << /N << /Push ${n} 0 R >> >>` : `/AP << /N ${n} 0 R /D ${d} 0 R >>`}`)}${sp(k)} >>`, n, tip, label);
        if (ref) (sc.group ? sc.group.kids : top).push(ref);
        return handle('button', full, { ref });
      },

      /** @param {string} name @param {any} o */
      signature(name, o) {
        const who = 'form.signature';
        keys(o, [...BOX, ...LOOK, 'lock'], who);
        const full = fullName(sc, name, who), P = placeOf(o, who), L = lookOf(o, who, { border: 1 }), tip = tipOf(o, who);
        let lock = '';
        if (o.lock != null) {
          const k = o.lock;
          keys(k, ['action', 'fields'], `${who}: lock`);
          const act = k.action ?? 'All';
          if (!['All', 'Include', 'Exclude'].includes(act)) throw new TypeError(`${who}: lock.action is All, Include or Exclude`);
          if ((act === 'All') !== (k.fields == null)) throw new TypeError(`${who}: lock.fields is given for Include and Exclude (only)`);
          lock = `<< /Type /SigFieldLock /Action /${act}${k.fields != null ? ` /Fields ${nameList(k.fields, `${who}: lock.fields`)}` : ''} >>`;
        }
        const ap = appearance(P.page, P.w, P.h, (a) => frame(a, P.w, P.h, L.f));
        const lockRef = lock && !flat ? doc.reserve() : 0;
        if (lockRef) later.push(() => doc.write(lockRef, lock));
        commit(sc, full, 0, { kind: 'signature' });
        const ref = place(P, (k) => `<< ${widget(P, `${parent} /FT /Sig /T ${text(name)}${tip ? ` /TU ${text(tip)}` : ''} /Ff ${ffOf(o, who)}${lockRef ? ` /Lock ${lockRef} 0 R` : ''}${L.mk ? ` /MK <<${L.mk} >>` : ''}${L.bs} /AP << /N ${ap} 0 R >>`)}${sp(k)} >>`, ap, tip, '');
        if (ref) (sc.group ? sc.group.kids : top).push(ref);
        return handle('signature', full, { ref, page: P.page, rect: [P.x, P.y, P.w, P.h] });
      },
    });

    /** a combo box (combo) or list box @param {string} name @param {any} o @param {boolean} combo */
    function choice(name, o, combo) {
      const who = combo ? 'form.comboBox' : 'form.listBox';
      keys(o, [...BOX, ...LOOK, ...TEXT, 'options', 'value', combo ? 'editable' : 'multiSelect', ...(combo ? ['doNotSpellCheck'] : [])], who);
      const full = fullName(sc, name, who);
      const list = o.options;
      if (!Array.isArray(list) || list.length > MAX_OPTIONS) throw new RangeError(`${who}: options is an array of at most ${MAX_OPTIONS} options`);
      const P = placeOf(o, who), L = lookOf(o, who, { border: 1 }), tip = tipOf(o, who);
      const { t, da } = textOf(P.page, o, who), q = qOf(o.align, who);
      let chars = 0;
      /** @type {Map<string, number>} export value → index */
      const index = new Map();
      const opts = list.map((it, i) => {
        const pair = Array.isArray(it) ? it : [it, it];
        if (pair.length !== 2) throw new TypeError(`${who}: an option is a string or [export, display]`);
        const [ex, dp] = pair.map((v) => str(v, 'an option', MAX_TOOLTIP, who));
        if ((chars += ex.length + dp.length) > MAX_OPTION_CHARS) throw new RangeError(`${who}: the options have more than ${MAX_OPTION_CHARS} characters in all`);
        if (index.has(ex)) throw new TypeError(`${who}: two options have the export value ${JSON.stringify(ex.slice(0, 80))}`);
        index.set(ex, i);
        return { ex, dp };
      });
      const editable = combo && bool(o.editable, 'editable', who), multi = !combo && bool(o.multiSelect, 'multiSelect', who);
      const values = o.value == null ? [] : Array.isArray(o.value) ? o.value : [o.value];
      if (values.length > 1 && !multi) throw new TypeError(`${who}: one value (several only with multiSelect)`);
      if (values.length > MAX_OPTIONS) throw new RangeError(`${who}: at most ${MAX_OPTIONS} values`);
      for (const v of values) str(v, 'value', MAX_VALUE, who);
      const sel = values.map((v) => index.get(v) ?? -1);
      if (sel.some((i) => i < 0) && !editable) throw new TypeError(`${who}: value ${JSON.stringify(String(values[sel.indexOf(-1)]).slice(0, 80))} is not one of the options' export values${combo ? ' (an editable combo box takes any value)' : ''}`);
      if (new Set(values).size !== values.length) throw new TypeError(`${who}: a value is selected twice`);
      const ff = ffOf(o, who) | (combo ? FF.combo : 0) | (editable ? FF.edit : 0) | (multi ? FF.multiSelect : 0) | (combo && bool(o.doNotSpellCheck, 'doNotSpellCheck', who) ? FF.doNotSpellCheck : 0);
      const shown = values.length ? (sel[0] >= 0 ? opts[sel[0]].dp : values[0]) : '';
      let draw, ti = 0;
      if (combo) {
        glyphs(t.fonts, shown, 'value', who);
        draw = (/** @type {any} */ a) => textValue(a, P.w, P.h, L.f, t, shown, { q });
      } else {
        for (const it of opts) glyphs(t.fonts, it.dp, 'options', who);
        const lh = t.impl.lineHeight * (t.size || 12), rows = Math.max(1, Math.floor((P.h - 2 * L.f.bw) / lh));
        const first = sel.length ? Math.min(...sel) : 0;
        if (first >= rows) ti = first; // the first selected row is shown
        const hl = doc.outputIntent === 'CMYK' ? [0.3, 0.13, 0, 0.14] : [0.6, 0.75, 0.86];
        draw = (/** @type {any} */ a) => listRows(a, P.w, P.h, L.f, t, opts.map((x) => x.dp), new Set(sel), ti, q, hl);
      }
      const ap = appearance(P.page, P.w, P.h, draw);
      commit(sc, full, 0, { kind: combo ? 'combo' : 'list' });
      const optArr = `[${opts.map((x) => (x.ex === x.dp ? text(x.ex) : `[${text(x.ex)} ${text(x.dp)}]`)).join(' ')}]`;
      const V = values.length === 0 ? '' : multi ? ` /V [${values.map(text).join(' ')}] /I [${[...sel].sort((a, b) => a - b).join(' ')}]` : ` /V ${text(values[0])}${sel[0] >= 0 && !combo ? ` /I [${sel[0]}]` : ''}`;
      const ref = place(P, (k) => `<< ${widget(P, `${parent} /FT /Ch /T ${text(name)}${tip ? ` /TU ${text(tip)}` : ''} /Ff ${ff} /Opt ${optArr}${V}${ti ? ` /TI ${ti}` : ''} /DA ${da} /Q ${q}${L.mk ? ` /MK <<${L.mk} >>` : ''}${L.bs} /AP << /N ${ap} 0 R >>`)}${sp(k)} >>`, ap, tip, combo ? shown : values.map((v, i) => (sel[i] >= 0 ? opts[sel[i]].dp : v)).join(', '));
      if (ref) (sc.group ? sc.group.kids : top).push(ref);
      return handle(combo ? 'combo' : 'list', full, { ref });
    }
  };

  /** an on-state name (export value) through the name writer; "Off" is the off state @param {any} v @param {string} who */
  function onName(v, who) {
    if (typeof v !== 'string' || !v || v.length > MAX_NAME) throw new TypeError(`${who}: an export value is a non-empty string of at most ${MAX_NAME} characters`);
    if (BAD_CHAR.test(v)) throw new TypeError(`${who}: an export value cannot contain control, format, bidi or separator characters`);
    const n = pdfName(v);
    if (n === '/Off') throw new TypeError(`${who}: "Off" is the off state, not an export value`);
    return n;
  }
  /** @param {any} s @param {string} who @returns {keyof typeof MARKS} */
  function markOf(s, who) {
    if (!Object.hasOwn(MARKS, s)) throw new TypeError(`${who}: style is one of ${Object.keys(MARKS).join(', ')}`);
    return s;
  }

  return scope(null, '', 0);
}
