// @ts-check
/**
 * Filling an existing form: the new values and, for text and choice fields, new appearance streams. The appearances
 * are not drawn here: each filled widget is made again, at its size and with its look (/DA font, size and colour, /Q,
 * /MK border and background, multiline, comb), as a field of a scratch PDF by the writer's own form code (forms/form.js
 * and forms/draw.js), which is then loaded and its widget's /AP /N copied in (a Foreign reference). So a filled field
 * looks exactly like a field this library makes, with the same checks (a character the font lacks throws).
 *
 * The font: the /DA font when it is one of the 14 standard fonts (Helv, TiRo, Cour… or its BaseFont), else Helvetica;
 * the caller's `font` (bytes) instead when given, and always in PDF/A (standard fonts are not embedded).
 * Check boxes and radio buttons keep their appearances: their /V and /AS change.
 */
import { toBytes } from '../index.js';
import { STANDARD_NAMES } from '../fonts/standard.js';
import { PdfString, Ref, Lexer, parseValue, Op } from './lexer.js';
import { Foreign } from './copy.js';
import { internal, loadPdf, rectOf } from './pdf.js';

const ALIAS = /** @type {Record<string, string>} */ ({ Helv: 'Helvetica', HeBo: 'Helvetica-Bold', TiRo: 'Times-Roman', TiBo: 'Times-Bold', Cour: 'Courier', CoBo: 'Courier-Bold', ZaDb: 'ZapfDingbats', Symb: 'Symbol' });

/** a text string as UTF-16BE with its BOM @param {string} s */
export function utf16(s) {
  const b = new Uint8Array(2 + s.length * 2);
  b[0] = 0xfe; b[1] = 0xff;
  for (let i = 0; i < s.length; i++) { b[2 + 2 * i] = s.charCodeAt(i) >> 8; b[3 + 2 * i] = s.charCodeAt(i) & 255; }
  return new PdfString(b, true);
}

/** /DA → { font, size, color } @param {any} da @param {any} budget */
function parseDA(da, budget) {
  const out = { font: '', size: 0, color: /** @type {any} */ (0) };
  if (!(da instanceof PdfString)) return out;
  const lx = new Lexer(da.bytes, budget);
  /** @type {any[]} */
  let args = [];
  for (let k = 0; k < 256; k++) {
    const v = parseValue(lx);
    if (v === undefined) break;
    if (!(v instanceof Op)) { args.push(v); continue; }
    if (v.v === 'Tf' && typeof args[0] === 'string') { out.font = args[0]; out.size = typeof args[1] === 'number' && args[1] >= 0 && args[1] <= 1000 ? args[1] : 0; }
    else if (v.v === 'g' && typeof args[0] === 'number') out.color = Math.min(1, Math.max(0, args[0]));
    else if (v.v === 'rg' && args.length >= 3 && args.every((x) => typeof x === 'number')) out.color = args.slice(0, 3).map((x) => Math.min(1, Math.max(0, x)));
    else if (v.v === 'k' && args.length >= 4 && args.every((x) => typeof x === 'number')) out.color = args.slice(0, 4).map((x) => Math.min(1, Math.max(0, x)));
    args = [];
  }
  return out;
}
/** a /MK colour array → a writer colour, or null @param {any} a @param {(v: any) => any} R */
function mkColor(a, R) {
  const v = R(a);
  if (!Array.isArray(v) || !v.length) return null;
  const n = v.map(R);
  if (!n.every((x) => typeof x === 'number')) return null;
  const c = n.map((x) => Math.min(1, Math.max(0, x)));
  return c.length === 1 ? c[0] : c.length === 3 ? c : c.length === 4 ? c : null;
}

/**
 * The replacements for the filled fields: object number → new value (dictionaries), with new appearances as Foreign
 * references into a scratch document. @param {any} self a loaded document's private side
 * @param {{ pdfa: boolean, warn: (m: string) => void }} o
 * @returns {Promise<Map<number, any>>}
 */
export async function fillReplacements(self, o) {
  const fills = self.edits.fills;
  /** @type {Map<number, any>} */
  const rep = new Map();
  if (!fills.size) return rep;
  const src = self.r.src, R = src.resolve;
  const fields = new Map(self.fields().map((/** @type {any} */ f) => [f.name, f]));
  const af = R(self.r.root.get('AcroForm'));
  const dr = af instanceof Map ? R(af.get('DR')) : null, drFonts = dr instanceof Map ? R(dr.get('Font')) : null;
  /** the object to change: a copy of object n's dictionary (once) @param {number} n */
  const edit = (n) => {
    let d = rep.get(n);
    if (!d) { const v = R(new Ref(n, 0)); if (!(v instanceof Map)) return null; d = new Map(v); rep.set(n, d); }
    return d;
  };
  /** @type {{ key: string, f: any, w: any, value: any }[]} widgets whose appearance is made again */
  const jobs = [];
  for (const [name, value] of fills) {
    const f = fields.get(name);
    if (!f) continue;
    if (f.ref < 0) { o.warn(`fill: the field ${JSON.stringify(name)} is a direct object and cannot be changed`); continue; }
    const fd = edit(f.ref);
    if (!fd) continue;
    if (f.type === 'text' || f.type === 'combo') { fd.set('V', utf16(value)); for (const w of f.widgets) jobs.push({ key: name, f, w, value }); }
    else if (f.type === 'list') { const vs = Array.isArray(value) ? value : [value]; fd.set('V', vs.length === 1 ? utf16(vs[0]) : vs.map(utf16)); fd.delete('I'); for (const w of f.widgets) jobs.push({ key: name, f, w, value: vs }); }
    else if (f.type === 'checkbox' || f.type === 'radio') {
      let on = null;
      for (const w of f.widgets) {
        const wd = w.ref >= 0 ? edit(w.ref) : null;
        const state = w.states.find((/** @type {string} */ s) => s !== 'Off') ?? 'Yes';
        const sel = f.type === 'checkbox' ? value === true : value != null && (state === value || f.exports?.[f.widgets.indexOf(w)] === value);
        if (sel) on = state;
        if (wd) wd.set('AS', sel ? state : 'Off');
        else if (w.ref < 0) o.warn(`fill: a widget of ${JSON.stringify(name)} is a direct object and keeps its state`);
      }
      const v = on ?? 'Off';
      if (f.widgets.length === 1 && f.widgets[0].ref === f.ref) rep.get(f.ref)?.set('V', v);
      else fd.set('V', v);
    }
  }
  if (!jobs.length) return rep;

  // the scratch document: one page per widget, the field made again by the writer
  const font = self.edits.fillFont;
  if (o.pdfa && !font) throw new TypeError('fill: this document is PDF/A, whose fonts must be embedded: pass fill(values, { font: <TrueType/OpenType bytes> }) for the new appearances');
  /** @type {{ job: any, name: string }[]} */
  const made = [];
  const bytes = await toBytes(async (/** @type {any} */ pdf) => {
    const emb = font ? await pdf.embedFont(font) : null;
    /** @type {Map<string, any>} */
    const std = new Map();
    let k = 0;
    for (const job of jobs) {
      const wd = job.w.ref >= 0 ? R(new Ref(job.w.ref, 0)) : null;
      const rect = job.w.rect;
      if (!(wd instanceof Map) || !rect) continue;
      const W = rect[2] - rect[0], H = rect[3] - rect[1];
      if (!(W > 0 && H > 0 && W <= 14400 && H <= 14400)) continue;
      const da = parseDA(R(wd.get('DA') ?? job.f.inh.DA ?? (af instanceof Map ? af.get('DA') : null)), src.budget);
      let fontObj = emb;
      if (!fontObj) {
        const fd = drFonts instanceof Map ? R(drFonts.get(da.font)) : null;
        const base = fd instanceof Map ? String(R(fd.get('BaseFont')) ?? '').replace(/^[A-Z]{6}\+/, '') : '';
        let name = STANDARD_NAMES.includes(base) ? base : ALIAS[da.font] ?? (STANDARD_NAMES.includes(da.font) ? da.font : 'Helvetica');
        if (name === 'Symbol' || name === 'ZapfDingbats') name = 'Helvetica';
        if (!std.has(name)) std.set(name, pdf.standardFont(name));
        fontObj = std.get(name);
      }
      const mk = R(wd.get('MK')), bs = R(wd.get('BS'));
      const bc = mk instanceof Map ? mkColor(mk.get('BC'), R) : null, bg = mk instanceof Map ? mkColor(mk.get('BG'), R) : null;
      const bw = bs instanceof Map && typeof R(bs.get('W')) === 'number' ? Math.min(100, Math.max(0, R(bs.get('W')))) : 1;
      const q = R(wd.get('Q') ?? job.f.inh.Q);
      const ff = job.f.flags | 0;
      const look = { font: fontObj, size: da.size, textColor: da.color, align: ['left', 'center', 'right'][q === 1 || q === 2 ? q : 0], border: bc != null && bw > 0 ? { width: bw, color: bc } : false, background: bg ?? undefined };
      const page = pdf.addPage({ width: W, height: H });
      const name = `f${k++}`;
      const box = { page, x: 0, y: 0, width: W, height: H };
      try {
        if (job.f.type === 'text') {
          const maxLen = R(job.f.inh.MaxLen);
          const comb = !!(ff & (1 << 24)) && Number.isInteger(maxLen) && maxLen >= 1 && maxLen <= 1000;
          pdf.form.textField(name, { ...box, ...look, value: job.value, multiline: !!(ff & (1 << 12)), ...(comb ? { comb: true, maxLen } : {}) });
        } else {
          const opts = job.f.options ?? [];
          const exps = job.f.exports ?? opts;
          const list = opts.map((/** @type {string} */ t, /** @type {number} */ i) => [exps[i] ?? t, t]);
          const vals = Array.isArray(job.value) ? job.value : [job.value];
          for (const v of vals) if (!list.some((/** @type {any[]} */ p) => p[0] === v)) list.push([v, v]); // an editable combo's own text
          if (job.f.type === 'combo') pdf.form.comboBox(name, { ...box, ...look, options: list, value: vals[0], editable: true });
          else pdf.form.listBox(name, { ...box, ...look, options: list, value: vals.length > 1 ? vals : vals[0], multiSelect: vals.length > 1 });
        }
      } catch (e) { throw new TypeError(`fill: ${JSON.stringify(job.key)}: ${/** @type {Error} */ (e).message.replace(/^form\.\w+: /, '')}`); }
      made.push({ job, name });
    }
  }, { creationDate: new Date(0), compress: true });
  const scratch = await loadPdf(bytes);
  const sIn = internal(scratch, 'fill');
  const sFields = new Map(sIn.fields().map((/** @type {any} */ f) => [f.name, f]));
  for (const { job, name } of made) {
    const sf = sFields.get(name);
    const sw = sf ? sIn.r.src.resolve(new Ref(sf.widgets[0].ref, 0)) : null;
    const ap = sw instanceof Map ? sIn.r.src.resolve(sw.get('AP')) : null;
    const N = ap instanceof Map ? ap.get('N') : null;
    if (!(N instanceof Ref)) continue;
    const wd = edit(job.w.ref);
    if (!wd) continue;
    wd.set('AP', new Map([['N', new Foreign(sIn, N)]]));
    wd.delete('AS');
  }
  void rectOf;
  return rep;
}
