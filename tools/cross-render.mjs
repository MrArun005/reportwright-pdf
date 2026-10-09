// Cross-renderer check for @reportwright/pdf: every engine opens every PDF of the corpus (tools/corpus.mjs) and we
// record whether it opened cleanly, the page count, the extracted text against the expected text, form fields and
// annotations, signatures, and page 1 rendered at 72 dpi, diffed pairwise between engines.
//
//   node packages/pdf/tools/cross-render.mjs <corpusDir> <outDir> [--engines poppler,mupdf,...] [--label linux]
//   node packages/pdf/tools/cross-render.mjs --merge <report.md> <resultsDir>...      (one report from every OS)
//
// Engines come from PATH and env, and a missing one is skipped with a note:
//   poppler (pdfinfo, pdftotext, pdftoppm, pdfsig), qpdf, mupdf (mutool), gs (Ghostscript; also gs-pdfwrite and
//   gs-ps2write: the file re-distilled and sent down a PostScript print path, rendered back), pdfium (PDFIUM_PY: a
//   Python with pypdfium2 and pillow), pdfjs (PDFJS_DIR: a folder whose node_modules has pdfjs-dist and @napi-rs/canvas),
//   quartz (macOS: sips renders, PDFKit through osascript reads), chrome / msedge (PLAYWRIGHT_DIR: a folder whose
//   node_modules has playwright; the browser's own PDF viewer, screenshot only).
// PNG decoding uses sharp, from XR_MODULES (a folder whose node_modules has it) or the repo.
// Writes <outDir>/report-<label>.md, results-<label>.json, png/ (kept only for flagged pairs, unless KEEP_PNGS=1),
// shots/ (browser screenshots).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i < 0 ? null : args.splice(i, 2)[1]; };
const req = (name) => {
  for (const d of [process.env.XR_MODULES, path.join(import.meta.dirname, '../../..')].filter(Boolean)) {
    try { return createRequire(path.join(path.resolve(d), 'x.js'))(name); } catch {}
  }
  return null;
};
const MARK = { ok: '✅', warn: '⚠️', fail: '❌', skip: '—' };

if (args[0] === '--merge') { merge(args[1], args.slice(2)); process.exit(0); }

const [corpusDir, outDir] = args.map((a) => path.resolve(a));
const LABEL = opt('--label') ?? { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform] ?? process.platform;
const WANT = opt('--engines')?.split(',');
if (!corpusDir || !outDir) { console.error('usage: cross-render.mjs <corpusDir> <outDir> [--engines a,b] [--label x]'); process.exit(2); }
const manifest = JSON.parse(fs.readFileSync(path.join(corpusDir, 'manifest.json'), 'utf8'));
const PNG = path.join(outDir, 'png'), SHOTS = path.join(outDir, 'shots');
fs.mkdirSync(PNG, { recursive: true });
const sharp = req('sharp');
const THRESH = Number(process.env.XR_FLAG_PCT ?? 2); // % of differing pixels that flags a pair

/** run a command: { code, out, err, timedOut } */
function sh(cmd, a, o = {}) {
  const r = spawnSync(cmd, a, { encoding: o.encoding ?? 'utf8', maxBuffer: 256 << 20, timeout: o.timeout ?? 120000, ...o });
  return { code: r.status, out: r.stdout ?? '', err: String(r.stderr ?? '') + (r.error ? String(r.error.message) : ''), timedOut: r.error?.code === 'ETIMEDOUT', missing: r.error?.code === 'ENOENT' };
}
const has = (cmd, a = ['--version']) => !sh(cmd, a, { timeout: 20000 }).missing;
const lines = (s, re) => s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && re.test(l));
const uniq = (a) => [...new Set(a)].slice(0, 6);

// ---------- engines: each run(file, entry, png) → { error?, warnings, pages, text, fields?, annots?, sig?, png?, note? } ----------
const E = {};
E.qpdf = {
  available: () => has('qpdf'), version: () => sh('qpdf', ['--version']).out.split('\n')[0],
  run(file, e) {
    const pw = e.password ? [`--password=${e.password}`] : [];
    const c = sh('qpdf', ['--check', ...pw, file]);
    if (c.code === 2) return { error: lines(c.out + c.err, /./).slice(-3).join(' / ') };
    const j = sh('qpdf', ['--json', '--json-key=acroform', '--json-key=pages', ...pw, file]);
    let fields, pages;
    try { const d = JSON.parse(j.out); fields = new Set((d.acroform?.fields ?? []).map((f) => f.fullname)).size; pages = d.pages?.length; } catch {}
    return { warnings: c.code === 3 ? uniq(lines(c.out + c.err, /WARNING|warning/)) : [], pages, fields, text: null };
  },
};
E.poppler = {
  available: () => has('pdftoppm', ['-v']), version: () => sh('pdftoppm', ['-v']).err.split('\n')[0],
  run(file, e, png) {
    const pw = e.password ? ['-upw', e.password] : [];
    const info = sh('pdfinfo', [...pw, file]);
    if (info.code !== 0) return { error: info.err.trim().split('\n').pop() };
    const t = sh('pdftotext', [...pw, file, '-']);
    const r = sh('pdftoppm', ['-r', '72', '-f', '1', '-l', '1', '-singlefile', '-png', ...pw, file, png.replace(/\.png$/, '')]);
    const res = { pages: +(/Pages:\s+(\d+)/.exec(info.out)?.[1] ?? NaN), text: t.out, warnings: uniq(lines(info.err + t.err + r.err, /error|warning/i)), png: r.code === 0 ? png : null };
    if (e.signed) {
      const s = sh('pdfsig', [...pw, file]);
      res.sig = `${/Signature is Valid/.test(s.out) ? 'signature valid' : (/Signature Validation: (.*)/.exec(s.out)?.[1] ?? 'no signature found')}; certificate: ${/Certificate Validation: (.*)/.exec(s.out)?.[1] ?? '?'}`;
      res.sigOk = /Signature is Valid/.test(s.out);
    }
    return res;
  },
};
E.mupdf = {
  available: () => has('mutool', ['-v']), version: () => (sh('mutool', ['-v']).err || sh('mutool', ['-v']).out).trim().split('\n')[0],
  run(file, e, png) {
    const pw = e.password ? ['-p', e.password] : [];
    const info = sh('mutool', ['info', ...pw, file]);
    if (info.code !== 0) return { error: lines(info.err, /./).pop() };
    const t = sh('mutool', ['draw', '-q', '-F', 'txt', '-o', '-', ...pw, file]);
    const r = sh('mutool', ['draw', '-q', '-r', '72', '-o', png, ...pw, file, '1']);
    return { pages: +(/Pages:\s+(\d+)/.exec(info.out)?.[1] ?? NaN), text: t.out, warnings: uniq(lines(info.err + t.err + r.err, /warning|error/i)), png: r.code === 0 ? png : null };
  },
};
const GS = process.platform === 'win32' ? 'gswin64c' : 'gs';
const gsArgs = (e) => ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', ...(e.password ? [`-sPDFPassword=${e.password}`] : [])];
const gsWarn = (s) => uniq(lines(s, /\*\*\*\*|error|warning/i));
const gsRender = (src, e, png, strict = true) => sh(GS, [...gsArgs(e), ...(strict ? ['-dPDFSTOPONERROR'] : []), '-sDEVICE=png16m', '-r72', '-dFirstPage=1', '-dLastPage=1', '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4', `-sOutputFile=${png}`, src]);
const gsPages = (src, e) => {
  const r = sh(GS, ['-q', '-dNODISPLAY', '-dNOSAFER', ...(e.password ? [`-sPDFPassword=${e.password}`] : []), '-c', `(${src.replace(/[\\()]/g, '\\$&')}) (r) file runpdfbegin pdfpagecount = quit`]);
  return +r.out.trim().split('\n').pop();
};
E.gs = {
  available: () => has(GS), version: () => `Ghostscript ${sh(GS, ['--version']).out.trim()}`,
  run(file, e, png) {
    const r = gsRender(file, e, png);
    if (r.code !== 0) return { error: gsWarn(r.out + r.err).join(' / ') || `exit ${r.code}` };
    const t = sh(GS, [...gsArgs(e), '-sDEVICE=txtwrite', '-o', '-', file]);
    return { pages: gsPages(file, e), text: t.out, warnings: gsWarn(r.out + r.err + t.err), png };
  },
};
/** re-distil (pdfwrite) or print to PostScript (ps2write), then render the result: what a print driver or RIP sees */
const gsVia = (device, ext) => ({
  available: () => has(GS), version: () => `Ghostscript ${sh(GS, ['--version']).out.trim()} ${device}`,
  run(file, e, png) {
    const mid = png.replace(/\.png$/, ext);
    const w = sh(GS, [...gsArgs(e), `-sDEVICE=${device}`, '-o', mid, file]);
    if (w.code !== 0 || !fs.existsSync(mid)) return { error: gsWarn(w.out + w.err).join(' / ') || `${device} exit ${w.code}` };
    const r = gsRender(mid, {}, png, false);
    const t = sh(GS, [...gsArgs({}), '-sDEVICE=txtwrite', '-o', '-', mid]);
    const size = fs.statSync(mid).size;
    if (!process.env.KEEP_PNGS) fs.rmSync(mid);
    return { pages: ext === '.pdf' ? gsPages(mid, {}) : undefined, text: t.out, warnings: gsWarn(w.out + w.err + r.out + r.err), png: r.code === 0 ? png : null, note: `${ext.slice(1)} ${Math.round(size / 1024)} KB` };
  },
});
E['gs-pdfwrite'] = gsVia('pdfwrite', '.pdf');
E['gs-ps2write'] = gsVia('ps2write', '.ps');

const PDFIUM_SRC = String.raw`
import sys, json
import pypdfium2 as pdfium, pypdfium2.raw as R
path, pw, png = sys.argv[1], sys.argv[2] or None, sys.argv[3]
try:
    pdf = pdfium.PdfDocument(path, password=pw)
except Exception as e:
    print(json.dumps({"error": str(e)})); sys.exit(0)
out = {"formType": R.FPDF_GetFormType(pdf.raw)}
try: pdf.init_forms()
except Exception as e: out["formsError"] = str(e)
out["pages"] = len(pdf)
txt, annots, widgets = [], 0, 0
for i in range(len(pdf)):
    p = pdf[i]
    txt.append(p.get_textpage().get_text_range())
    n = R.FPDFPage_GetAnnotCount(p.raw); annots += n
    for j in range(n):
        a = R.FPDFPage_GetAnnot(p.raw, j)
        if R.FPDFAnnot_GetSubtype(a) == R.FPDF_ANNOT_WIDGET: widgets += 1
        R.FPDFPage_CloseAnnot(a)
    if i == 0:
        p.render(scale=1, may_draw_forms=True).to_pil().save(png)
out.update(text="\n".join(txt), annots=annots, widgets=widgets)
print(json.dumps(out))
`;
E.pdfium = {
  available: () => !!process.env.PDFIUM_PY && !sh(process.env.PDFIUM_PY, ['-c', 'import pypdfium2']).code,
  version: () => sh(process.env.PDFIUM_PY, ['-c', 'import pypdfium2.version as v; print("pypdfium2", v.PYPDFIUM_INFO, "PDFium", v.PDFIUM_INFO)']).out.trim(),
  run(file, e, png) {
    const r = sh(process.env.PDFIUM_PY, ['-I', '-c', PDFIUM_SRC, file, e.password ?? '', png]);
    let d; try { d = JSON.parse(r.out.trim().split('\n').pop()); } catch { return { error: (r.err || r.out).trim().split('\n').pop() }; }
    if (d.error) return { error: d.error };
    const FORM = ['none', 'AcroForm', 'XFA full', 'XFA foreground'];
    return { pages: d.pages, text: d.text, annots: d.annots, widgets: d.widgets, warnings: d.formsError ? [d.formsError] : [], png: fs.existsSync(png) ? png : null, note: d.formType ? `form type ${FORM[d.formType] ?? d.formType}, ${d.widgets} widgets` : undefined };
  },
};

let pdfjs = null;
E.pdfjs = {
  async available() {
    if (!process.env.PDFJS_DIR) return false;
    try { pdfjs = await import(pathToFileURL(path.join(process.env.PDFJS_DIR, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href); return true; } catch (err) { E.pdfjs.why = err.message; return false; }
  },
  version: () => `pdf.js ${pdfjs.version}`,
  async run(file, e, png) {
    const base = path.join(process.env.PDFJS_DIR, 'node_modules/pdfjs-dist/');
    const warnings = [];
    const log = console.log, warn = console.warn;
    console.log = console.warn = (...m) => warnings.push(m.join(' '));
    try {
      const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), password: e.password, standardFontDataUrl: path.join(base, 'standard_fonts/'), cMapUrl: path.join(base, 'cmaps/'), cMapPacked: true, verbosity: 1, isEvalSupported: false }).promise;
      let text = '', annots = 0;
      for (let i = 1; i <= doc.numPages; i++) {
        const p = await doc.getPage(i);
        text += (await p.getTextContent()).items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join('') + '\n';
        annots += (await p.getAnnotations()).length;
      }
      const fo = await doc.getFieldObjects();
      const fields = fo ? Object.keys(fo).length : 0;
      const values = {};
      for (const [k, v] of Object.entries(fo ?? {})) values[k] = v.find((w) => w.value != null && w.value !== 'Off')?.value ?? v[0]?.value;
      let out = null;
      try {
        const page = await doc.getPage(1);
        const viewport = page.getViewport({ scale: 1 });
        const w = Math.ceil(viewport.width), h = Math.ceil(viewport.height);
        const { canvas, context } = doc.canvasFactory ? doc.canvasFactory.create(w, h) : (() => { const c = req('@napi-rs/canvas') ?? createRequire(path.join(process.env.PDFJS_DIR, 'x.js'))('@napi-rs/canvas'); const cv = c.createCanvas(w, h); return { canvas: cv, context: cv.getContext('2d') }; })();
        await page.render({ canvasContext: context, canvas, viewport }).promise;
        fs.writeFileSync(png, await canvas.encode?.('png') ?? canvas.toBuffer('image/png'));
        out = png;
      } catch (err) { warnings.push(`render: ${err.message}`); }
      await doc.destroy();
      return { pages: doc.numPages, text, annots, fields, values, warnings: uniq(warnings.filter((w) => /warn|error/i.test(w))), png: out };
    } catch (err) {
      return { error: `${err.name}: ${err.message}` };
    } finally { console.log = log; console.warn = warn; }
  },
};

const JXA = `ObjC.import('PDFKit');
function run(argv) {
  const d = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (!d || d.isNil()) return JSON.stringify({ error: 'PDFKit could not open the file' });
  if (d.isLocked && !d.unlockWithPassword(argv[1] || '')) return JSON.stringify({ error: 'locked (password refused)' });
  const s = d.string;
  return JSON.stringify({ pages: d.pageCount, text: s && !s.isNil() ? s.js : '' });
}`;
E.quartz = {
  available: () => process.platform === 'darwin' && has('sips', ['--help']),
  version: () => `macOS ${sh('sw_vers', ['-productVersion']).out.trim()} (CoreGraphics via sips, PDFKit via osascript)`,
  run(file, e, png) {
    const k = sh('osascript', ['-l', 'JavaScript', '-e', JXA, file, e.password ?? '']);
    let d; try { d = JSON.parse(k.out.trim()); } catch { return { error: k.err.trim() || 'osascript failed' }; }
    if (d.error) return { error: d.error };
    // sips has no password option: an encrypted file with a user password cannot be rendered by it
    const r = e.password ? { code: 1, err: '' } : sh('sips', ['-s', 'format', 'png', file, '--out', png]);
    return { pages: d.pages, text: d.text, warnings: uniq(lines(r.err, /error|warning/i)), png: r.code === 0 && fs.existsSync(png) ? png : null, note: e.password ? 'sips cannot take a password: not rendered' : undefined };
  },
};

let pw = null;
const browser = (channel) => ({
  async available() {
    if (!process.env.PLAYWRIGHT_DIR) return false;
    try { pw ??= createRequire(path.join(path.resolve(process.env.PLAYWRIGHT_DIR), 'x.js'))('playwright'); this.b = await pw.chromium.launch({ channel, headless: false }); return true; } catch (err) { this.why = err.message.split('\n')[0]; return false; }
  },
  version() { return `${channel} ${this.b.version()} (built-in PDF viewer, screenshot only)`; },
  shotsOnly: true,
  async run(file, e) {
    fs.mkdirSync(SHOTS, { recursive: true });
    const ctx = await this.b.newContext({ viewport: { width: 1280, height: 1000 }, acceptDownloads: false });
    const page = await ctx.newPage();
    const shot = path.join(SHOTS, `${e.name}.${channel}.png`);
    try {
      let download = false;
      page.on('download', () => { download = true; });
      await page.goto(pathToFileURL(file).href, { waitUntil: 'load', timeout: 30000 }).catch((err) => { if (!/Download is starting|net::ERR_ABORTED/.test(err.message)) throw err; download = true; });
      await page.waitForTimeout(4000);
      await page.screenshot({ path: shot });
      if (download) return { error: 'the browser downloaded the file instead of showing it' };
      const st = await sharp(shot).stats();
      const blank = st.channels.every((c) => c.stdev < 2);
      return { warnings: blank ? ['screenshot is blank'] : [], text: null, shot, note: e.password ? 'expect the viewer’s password prompt in the screenshot' : 'opened in the viewer' };
    } catch (err) { return { error: err.message.split('\n')[0] }; } finally { await ctx.close(); }
  },
});
E.chrome = browser('chrome');
E.msedge = browser('msedge');

// ---------- checks ----------
const norm = (s) => (s ?? '').normalize('NFKC').replace(/[­​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
const squash = (s) => norm(s).replace(/ /g, '');
const rev = (s) => [...s].reverse().join('');
function textCheck(text, want) {
  if (text == null) return { status: 'skip', missing: [] };
  const t = norm(text), q = squash(text), missing = [], loose = [];
  for (const w of want) {
    if (t.includes(norm(w))) continue;
    if (q.includes(squash(w)) || q.includes(squash(rev(w)))) loose.push(w); else missing.push(w);
  }
  return { status: missing.length ? 'fail' : loose.length ? 'loose' : 'ok', missing, loose };
}

/** pixels of a PNG flattened on white, resized to w × h, lightly blurred (anti-aliasing and 1-px shifts are noise) */
async function raster(file, w, h) {
  return sharp(file).flatten({ background: '#ffffff' }).removeAlpha().resize(w, h, { fit: 'fill' }).blur(1).raw().toBuffer();
}
async function diff(a, b, w, h, out) {
  const [x, y] = await Promise.all([raster(a, w, h), raster(b, w, h)]);
  const mask = out ? Buffer.alloc(w * h * 3, 255) : null;
  let n = 0;
  for (let i = 0, p = 0; i < x.length; i += 3, p++) {
    const d = Math.max(Math.abs(x[i] - y[i]), Math.abs(x[i + 1] - y[i + 1]), Math.abs(x[i + 2] - y[i + 2]));
    if (d > 48) { n++; if (mask) { mask[i] = 255; mask[i + 1] = 0; mask[i + 2] = 0; } } else if (mask) { const g = 200 + (x[i] >> 3); mask[i] = mask[i + 1] = mask[i + 2] = g; }
  }
  if (mask && n) await sharp(mask, { raw: { width: w, height: h, channels: 3 } }).png().toFile(out);
  return (100 * n) / (w * h);
}

// ---------- run ----------
const engines = [], skipped = [];
for (const [name, eng] of Object.entries(E)) {
  if (WANT && !WANT.includes(name)) continue;
  if (await eng.available()) { eng.name = name; eng.ver = eng.version(); engines.push(eng); } else skipped.push(`${name}${eng.why ? ` (${eng.why})` : ''}`);
}
if (!sharp) console.warn('sharp not found (XR_MODULES): no pixel diffs');
console.log(`engines: ${engines.map((e) => e.name).join(', ')}${skipped.length ? `; skipped: ${skipped.join(', ')}` : ''}`);

const results = [];
const flagged = [];
for (const e of manifest) {
  const file = path.join(corpusDir, e.file);
  const dir = path.join(PNG, e.name);
  fs.mkdirSync(dir, { recursive: true });
  const row = { file: e.file, feature: e.feature, cells: {} };
  for (const eng of engines) {
    const png = path.join(dir, `${eng.name}.png`);
    let r;
    try { r = await eng.run(file, e, png); } catch (err) { r = { error: `harness: ${err.message}` }; }
    const notes = [];
    let status = 'ok';
    const bad = (s, m) => { if (s === 'fail' || status === 'ok') status = s === 'fail' ? 'fail' : 'warn'; notes.push(m); };
    if (r.error) { status = 'fail'; notes.push(`did not open: ${r.error}`); }
    else {
      if (r.pages != null && r.pages !== e.pages) bad('fail', `${r.pages} pages, expected ${e.pages}`);
      for (const w of r.warnings ?? []) bad('warn', `warning: ${w.slice(0, 160)}`);
      const tc = textCheck(r.text, e.text);
      if (tc.status === 'fail') bad('warn', `text missing: ${tc.missing.map((m) => `“${m}”`).join(', ')}`);
      if (tc.status === 'loose') notes.push(`text matches only ignoring spaces or order: ${tc.loose.map((m) => `“${m}”`).join(', ')}`);
      if (e.fields != null && r.fields != null && r.fields !== e.fields) bad('warn', `${r.fields} fields, expected ${e.fields}`);
      if (e.annots != null && r.annots != null && r.annots !== e.annots) bad('warn', `${r.annots} annotations, expected ${e.annots}`);
      if (e.formValues && r.values) for (const [k, v] of Object.entries(e.formValues)) if (String(r.values[k]) !== v) bad('warn', `field ${k} = ${JSON.stringify(r.values[k])}, expected ${JSON.stringify(v)}`);
      if (r.sig) { notes.push(r.sig); if (!r.sigOk) bad('fail', 'signature not valid'); }
      if (r.note) notes.push(r.note);
      if (!r.png && !eng.shotsOnly && !r.note) notes.push('no render');
    }
    row.cells[eng.name] = { status, notes, png: r.png ?? null, shot: r.shot ?? null, fields: r.fields, annots: r.annots, widgets: r.widgets, values: r.values };
    process.stdout.write(`${MARK[status]} `);
  }
  // pairwise pixel diffs of page 1
  const pngs = Object.entries(row.cells).filter(([, c]) => c.png && fs.existsSync(c.png));
  row.diffs = [];
  if (sharp && pngs.length > 1) {
    const m = await sharp(pngs[0][1].png).metadata();
    const keep = new Set();
    for (let i = 0; i < pngs.length; i++) for (let j = i + 1; j < pngs.length; j++) {
      const [a, ca] = pngs[i], [b, cb] = pngs[j];
      const out = path.join(dir, `diff-${a}-${b}.png`);
      const pct = await diff(ca.png, cb.png, m.width, m.height, out);
      row.diffs.push({ a, b, pct: +pct.toFixed(2) });
      if (pct > THRESH) { keep.add(ca.png).add(cb.png).add(out); flagged.push({ file: e.file, a, b, pct: +pct.toFixed(2), images: [ca.png, cb.png, out].map((x) => path.relative(outDir, x)) }); }
      else fs.rmSync(out, { force: true });
    }
    // an engine that differs from more than half of the others is the odd one out
    for (const [n, c] of pngs) {
      const k = row.diffs.filter((d) => (d.a === n || d.b === n) && d.pct > THRESH).length;
      if (k > (pngs.length - 1) / 2) { if (c.status === 'ok') c.status = 'warn'; c.notes.push(`renders differently from ${k} of ${pngs.length - 1} engines`); }
    }
    if (!process.env.KEEP_PNGS) for (const [, c] of pngs) if (!keep.has(c.png)) { fs.rmSync(c.png, { force: true }); c.png = null; }
  }
  if (!process.env.KEEP_PNGS && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
  results.push(row);
  console.log(` ${e.file}`);
}
for (const eng of engines) await eng.b?.close();

const meta = { label: LABEL, os: `${os.type()} ${os.release()} ${os.arch()}`, engines: Object.fromEntries(engines.map((e) => [e.name, e.ver])), skipped, threshold: THRESH, date: new Date().toISOString() };
fs.writeFileSync(path.join(outDir, `results-${LABEL}.json`), JSON.stringify({ meta, results, flagged }, null, 2));
fs.writeFileSync(path.join(outDir, `report-${LABEL}.md`), report([{ meta, results, flagged }]));
console.log(`wrote ${path.join(outDir, `report-${LABEL}.md`)}`);

// ---------- report ----------
function report(runs) {
  const cols = runs.flatMap((r) => Object.keys(r.meta.engines).map((n) => ({ run: r, n, key: runs.length > 1 ? `${n} (${r.meta.label})` : n })));
  const files = [...new Set(runs.flatMap((r) => r.results.map((x) => x.file)))];
  const L = ['# Cross-renderer report: @reportwright/pdf', '', `Generated ${new Date().toISOString()} by packages/pdf/tools/cross-render.mjs. ✅ opened cleanly, page count and expected text right; ⚠️ opened with a warning, missing text, a field/annotation count off or a page that renders differently from most engines; ❌ did not open, wrong page count or an invalid signature; — not run. A pixel pair is flagged above ${runs[0].meta.threshold}% of page-1 pixels differing (72 dpi, blurred 1 px, channel difference > 48).`, '', '## Engines', '', '| Run | Engine | Version |', '|---|---|---|'];
  for (const r of runs) {
    for (const [n, v] of Object.entries(r.meta.engines)) L.push(`| ${r.meta.label} (${r.meta.os}) | ${n} | ${v} |`);
    if (r.meta.skipped.length) L.push(`| ${r.meta.label} | skipped | ${r.meta.skipped.join(', ')} |`);
  }
  L.push('', '## Summary', '', `| Engine | ${MARK.ok} | ${MARK.warn} | ${MARK.fail} |`, '|---|---|---|---|');
  for (const c of cols) {
    const s = c.run.results.map((x) => x.cells[c.n]?.status).filter(Boolean);
    L.push(`| ${c.key} | ${s.filter((x) => x === 'ok').length} | ${s.filter((x) => x === 'warn').length} | ${s.filter((x) => x === 'fail').length} |`);
  }
  L.push('', '## Matrix', '', `| File | ${cols.map((c) => c.key).join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`);
  for (const f of files) L.push(`| ${f} | ${cols.map((c) => MARK[c.run.results.find((x) => x.file === f)?.cells[c.n]?.status ?? 'skip']).join(' | ')} |`);
  L.push('', '## Notes per file', '');
  for (const f of files) {
    const notes = cols.map((c) => [c.key, c.run.results.find((x) => x.file === f)?.cells[c.n]]).filter(([, c]) => c?.notes?.length);
    if (!notes.length) continue;
    L.push(`**${f}** — ${runs[0].results.find((x) => x.file === f)?.feature ?? ''}`, '');
    for (const [k, c] of notes) L.push(`- ${MARK[c.status]} ${k}: ${c.notes.join('; ')}`);
    L.push('');
  }
  const fl = runs.flatMap((r) => r.flagged.map((x) => ({ ...x, label: r.meta.label })));
  L.push('## Flagged pixel differences', '', fl.length ? '| Run | File | Pair | % differing | Images |\n|---|---|---|---|---|' : 'None above the threshold.');
  for (const x of fl) L.push(`| ${x.label} | ${x.file} | ${x.a} vs ${x.b} | ${x.pct} | ${x.images.join('<br>')} |`);
  const shots = runs.flatMap((r) => r.results.flatMap((x) => Object.entries(x.cells).filter(([, c]) => c.shot).map(([n, c]) => `${r.meta.label}/${path.basename(c.shot)}`)));
  if (shots.length) L.push('', `## Browser screenshots`, '', `${shots.length} screenshots in the shots/ artifact.`);
  return L.join('\n') + '\n';
}

function merge(out, dirs) {
  const runs = dirs.flatMap((d) => fs.readdirSync(d, { recursive: true }).filter((f) => /results-.*\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))));
  fs.writeFileSync(out, report(runs));
  console.log(`merged ${runs.length} runs into ${out}`);
}
