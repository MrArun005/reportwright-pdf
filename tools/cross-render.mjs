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
const PAGE = Number(opt('--page') ?? 1); // the page rendered and diffed (1-based)
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
// Per-engine facts the checks need (set on the engine objects below):
//   noise:       warnings this build prints for every file whatever its content (kept in the notes, never a ⚠️)
//   actualText:  false when the engine's text extraction ignores /ActualText (complex-script text then comes out as
//                glyph-by-glyph Unicode: an engine limitation, not a property of the file)
//   textCheck:   false when the output path turns fonts into Type 3 or outlines (PostScript, PCL), so extracted text
//                says nothing about the PDF; that path is checked by its pixels only
//   derivedFrom: the engine whose output this one re-renders (a print path); diffed against that engine only and kept
//                out of the majority vote, so one renderer is not counted several times
//   noIcc:       set when the build has no colour management (CMYK converted naively): kept out of the majority vote
const ACTUALTEXT_SCRIPTS = /[\u0590-\u08ff\u0900-\u0dff\u0e00-\u0eff\u1000-\u109f\u1780-\u17ff]/;
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
    const r = sh('pdftoppm', ['-r', '72', '-cropbox', '-f', String(PAGE), '-l', String(PAGE), '-singlefile', '-png', ...pw, file, png.replace(/\.png$/, '')]);
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
  // Ubuntu 24.04's mupdf-tools (1.23) is built without lcms2 and extracts the glyphs, not the /ActualText
  noise: [/ICC support is not available/], actualText: false, noIccWhen: /ICC support is not available/,
  available: () => has('mutool', ['-v']), version: () => (sh('mutool', ['-v']).err || sh('mutool', ['-v']).out).trim().split('\n')[0],
  run(file, e, png) {
    const pw = e.password ? ['-p', e.password] : [];
    const info = sh('mutool', ['info', ...pw, file]);
    if (info.code !== 0) return { error: lines(info.err, /./).pop() };
    const t = sh('mutool', ['draw', '-q', '-F', 'txt', '-o', '-', ...pw, file]);
    const r = sh('mutool', ['draw', '-q', '-r', '72', '-o', png, ...pw, file, String(PAGE)]);
    return { pages: +(/Pages:\s+(\d+)/.exec(info.out)?.[1] ?? NaN), text: t.out, warnings: uniq(lines(info.err + t.err + r.err, /warning|error/i)), png: r.code === 0 ? png : null };
  },
};
const GS = process.platform === 'win32' ? 'gswin64c' : 'gs';
const gsArgs = (e) => ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', ...(e.password ? [`-sPDFPassword=${e.password}`] : [])];
const gsWarn = (s) => uniq(lines(s, /\*\*\*\*|error|warning/i));
// Ghostscript 10.02 (Ubuntu 24.04) prints this at exit for every file: a gs bug, not about the file
const GS_NOISE = [/finalizing subclassing device while child refcount > 1/];
const gsRender = (src, e, png, strict = true) => sh(GS, [...gsArgs(e), ...(strict ? ['-dPDFSTOPONERROR'] : []), '-dUseCropBox', '-sDEVICE=png16m', '-r72', `-dFirstPage=${PAGE}`, `-dLastPage=${PAGE}`, '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4', `-sOutputFile=${png}`, src]);
/** pages of a PDF by qpdf, else pdfinfo (gs's own count failed on its pdfwrite output) */
const npages = (src, e = {}) => {
  const q = sh('qpdf', ['--show-npages', ...(e.password ? [`--password=${e.password}`] : []), src]);
  if (!q.missing && (q.code === 0 || q.code === 3)) return Number(q.out.trim());
  const i = sh('pdfinfo', [...(e.password ? ['-upw', e.password] : []), src]);
  return Number(/Pages:\s+(\d+)/.exec(i.out)?.[1] ?? NaN);
};
const gsPages = (src, e) => {
  const r = sh(GS, ['-q', '-dNODISPLAY', '-dNOSAFER', ...(e.password ? [`-sPDFPassword=${e.password}`] : []), '-c', `(${src.replace(/[\\()]/g, '\\$&')}) (r) file runpdfbegin pdfpagecount = quit`]);
  return +r.out.trim().split('\n').pop();
};
E.gs = {
  noise: GS_NOISE, actualText: false, // txtwrite emits the glyphs and the /ActualText both
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
  noise: GS_NOISE, actualText: false, derivedFrom: 'gs', textCheck: ext === '.pdf',
  available: () => has(GS), version: () => `Ghostscript ${sh(GS, ['--version']).out.trim()} ${device}`,
  run(file, e, png) {
    const mid = png.replace(/\.png$/, ext);
    const w = sh(GS, [...gsArgs(e), `-sDEVICE=${device}`, '-o', mid, file]);
    if (w.code !== 0 || !fs.existsSync(mid)) return { error: gsWarn(w.out + w.err).join(' / ') || `${device} exit ${w.code}` };
    const r = gsRender(mid, {}, png, false);
    const t = sh(GS, [...gsArgs({}), '-sDEVICE=txtwrite', '-o', '-', mid]);
    const size = fs.statSync(mid).size;
    const pages = ext === '.pdf' ? npages(mid) : undefined; // before the file is removed
    if (!process.env.KEEP_PNGS) fs.rmSync(mid);
    return { pages, text: t.out, warnings: gsWarn(w.out + w.err + r.out + r.err), png: r.code === 0 ? png : null, note: `${ext.slice(1)} ${Math.round(size / 1024)} KB` };
  },
});
E['gs-pdfwrite'] = gsVia('pdfwrite', '.pdf');
E['gs-ps2write'] = gsVia('ps2write', '.ps');
/** a PCL printer stream (PCL XL or PCL 5): its header is checked, and it is rendered back with GhostPCL (gpcl6) when on PATH */
const GPCL = process.platform === 'win32' ? 'gpcl6win64' : 'gpcl6';
const gsPcl = (device, ext, magic) => ({
  noise: GS_NOISE, derivedFrom: 'gs', textCheck: false,
  available: () => has(GS), version: () => `Ghostscript ${sh(GS, ['--version']).out.trim()} ${device}${has(GPCL) ? ` → ${GPCL}` : ' (no gpcl6: header check only)'}`,
  run(file, e, png) {
    const mid = png.replace(/\.png$/, ext);
    const w = sh(GS, [...gsArgs(e), `-sDEVICE=${device}`, '-o', mid, file]);
    if (w.code !== 0 || !fs.existsSync(mid)) return { error: gsWarn(w.out + w.err).join(' / ') || `${device} exit ${w.code}` };
    const head = fs.readFileSync(mid).subarray(0, 4096).toString('latin1'), size = fs.statSync(mid).size;
    const res = { text: null, warnings: gsWarn(w.out + w.err), note: `${ext.slice(1)} ${Math.round(size / 1024)} KB` };
    if (!magic.test(head)) return { error: `${device} output does not start like ${ext.slice(1)}` };
    if (has(GPCL)) {
      const r = sh(GPCL, ['-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=png16m', '-r72', `-dFirstPage=${PAGE}`, `-dLastPage=${PAGE}`, '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4', `-sOutputFile=${png}`, mid]);
      if (r.code === 0 && fs.existsSync(png)) res.png = png; else res.warnings.push(`${GPCL}: ${(r.err || r.out).trim().split('\n').pop()}`);
    }
    if (!process.env.KEEP_PNGS) fs.rmSync(mid);
    return res;
  },
});
E['gs-pxlcolor'] = gsPcl('pxlcolor', '.pxl', /\) HP-PCL XL/);
E['gs-ljet4'] = gsPcl('ljet4', '.pcl', /^(\x1bE|\x1b%-12345X)/);
/** CUPS's own filter chain to PostScript (what a Linux or macOS print queue does), rendered back with Ghostscript */
/** CUPS's own filter chain to PostScript (what a Linux or macOS print queue does), rendered back with Ghostscript.
 * cups-filters 2 (Ubuntu 24.04) fails `cupsfilter -m application/postscript` without a printer ("universal stopped
 * with status 255"), so the calls are tried in order: with a generic PostScript PPD, without one, then the pdftops
 * filter run directly with the CUPS filter arguments (job user title copies options file), as a queue runs it. */
const PS_PPDS = ['/usr/share/ppd/cupsfilters/Generic-PostScript_Printer-Postscript.ppd', '/usr/share/cups/model/Generic-PostScript_Printer-Postscript.ppd', '/usr/share/ppd/cupsfilters/textonly.ppd', '/usr/share/cups/model/postscript.ppd.gz', '/usr/share/ppd/cups-included/postscript.ppd', '/System/Library/Frameworks/ApplicationServices.framework/Versions/A/Frameworks/PrintCore.framework/Versions/A/Resources/Generic.ppd'];
const FILTERS = ['/usr/lib/cups/filter', '/usr/libexec/cups/filter'];
function cupsCalls(file) {
  const ppd = PS_PPDS.find((p) => fs.existsSync(p));
  const calls = [];
  if (ppd) calls.push([`cupsfilter -p ${path.basename(ppd)}`, 'cupsfilter', ['-p', ppd, '-i', 'application/pdf', '-m', 'printer/test', file]]);
  calls.push(['cupsfilter -i application/pdf -m application/postscript', 'cupsfilter', ['-i', 'application/pdf', '-m', 'application/postscript', file]]);
  for (const d of FILTERS) for (const f of ['pdftops', 'universal']) {
    const exe = path.join(d, f);
    if (fs.existsSync(exe)) calls.push([`${exe} (CUPS filter, run directly)`, exe, ['1', 'xr', 'cross-render', '1', '', file], { env: { ...process.env, CONTENT_TYPE: 'application/pdf', FINAL_CONTENT_TYPE: 'application/postscript', ...(ppd ? { PPD: ppd } : {}) } }]);
  }
  return calls;
}
E['cups-ps'] = {
  noise: GS_NOISE, textCheck: false, derivedFrom: 'gs',
  available: () => has('cupsfilter', ['-h']) || FILTERS.some((d) => fs.existsSync(path.join(d, 'pdftops'))),
  version: () => 'CUPS → application/postscript (cupsfilter, else the pdftops filter)',
  run(file, e, png) {
    if (e.password) return { error: 'CUPS filters take no password', skip: true };
    const mid = png.replace(/\.png$/, '.ps');
    const tried = [];
    for (const [name, cmd, a, o] of cupsCalls(file)) {
      const c = sh(cmd, a, { encoding: 'buffer', ...o });
      if (c.code === 0 && c.out.subarray(0, 4).toString('latin1') === '%!PS') {
        fs.writeFileSync(mid, c.out);
        const r = gsRender(mid, {}, png, false);
        if (!process.env.KEEP_PNGS) fs.rmSync(mid);
        return { text: null, warnings: gsWarn(r.out + r.err), png: r.code === 0 ? png : null, note: `via ${name}, ps ${Math.round(c.out.length / 1024)} KB` };
      }
      tried.push(`${name}: ${c.code !== 0 ? `exit ${c.code} ${c.err.trim().split('\n').pop()}` : 'not PostScript'}`.slice(0, 200));
    }
    return { error: `no CUPS call produced PostScript (${tried.join(' | ')})` };
  },
};

const PDFIUM_SRC = String.raw`
import sys, json
import pypdfium2 as pdfium, pypdfium2.raw as R
path, pw, png, page = sys.argv[1], sys.argv[2] or None, sys.argv[3], int(sys.argv[4]) - 1
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
    if i == page:
        p.render(scale=1, may_draw_forms=True).to_pil().save(png)
out.update(text="\n".join(txt), annots=annots, widgets=widgets)
print(json.dumps(out))
`;
E.pdfium = {
  available: () => !!process.env.PDFIUM_PY && !sh(process.env.PDFIUM_PY, ['-c', 'import pypdfium2']).code,
  version: () => sh(process.env.PDFIUM_PY, ['-c', 'import pypdfium2.version as v; print("pypdfium2", v.PYPDFIUM_INFO, "PDFium", v.PDFIUM_INFO)']).out.trim(),
  run(file, e, png) {
    const r = sh(process.env.PDFIUM_PY, ['-I', '-c', PDFIUM_SRC, file, e.password ?? '', png, String(PAGE)]);
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
    let task = null; // pdf.js 6: the loading task is destroyed, not the document
    console.log = console.warn = (...m) => warnings.push(m.join(' '));
    try {
      task = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), password: e.password, standardFontDataUrl: path.join(base, 'standard_fonts/'), cMapUrl: path.join(base, 'cmaps/'), cMapPacked: true, verbosity: 1, isEvalSupported: false });
      const doc = await task.promise;
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
        const page = await doc.getPage(PAGE);
        const viewport = page.getViewport({ scale: 1 });
        const w = Math.ceil(viewport.width), h = Math.ceil(viewport.height);
        const { canvas, context } = doc.canvasFactory ? doc.canvasFactory.create(w, h) : (() => { const c = req('@napi-rs/canvas') ?? createRequire(path.join(process.env.PDFJS_DIR, 'x.js'))('@napi-rs/canvas'); const cv = c.createCanvas(w, h); return { canvas: cv, context: cv.getContext('2d') }; })();
        await page.render({ canvasContext: context, canvas, viewport }).promise;
        fs.writeFileSync(png, await canvas.encode?.('png') ?? canvas.toBuffer('image/png'));
        out = png;
      } catch (err) { warnings.push(`render: ${err.message}`); }
      return { pages: Number(doc.numPages), text, annots, fields, values, warnings: uniq(warnings.filter((w) => /warn|error/i.test(w))), png: out };
    } catch (err) {
      return { error: `${err.name}: ${err.message}` };
    } finally { console.log = log; console.warn = warn; await task?.destroy?.(); }
  },
};

const JXA = `ObjC.import('PDFKit');
function run(argv) {
  const d = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (!d || d.isNil()) return JSON.stringify({ error: 'PDFKit could not open the file' });
  if (d.isLocked && !d.unlockWithPassword(argv[1] || '')) return JSON.stringify({ error: 'locked (password refused)' });
  const s = d.string;
  return JSON.stringify({ pages: Number(d.pageCount), text: s && !s.isNil() ? s.js : '' });
}`;
E.quartz = {
  actualText: false, // PDFKit's text of the first cloud run lacked the shaped Devanagari that poppler and PDFium read
  available: () => process.platform === 'darwin' && has('sips', ['--help']),
  version: () => `macOS ${sh('sw_vers', ['-productVersion']).out.trim()} (CoreGraphics via sips, PDFKit via osascript)`,
  run(file, e, png) {
    const k = sh('osascript', ['-l', 'JavaScript', '-e', JXA, file, e.password ?? '']);
    let d; try { d = JSON.parse(k.out.trim()); } catch { return { error: k.err.trim() || 'osascript failed' }; }
    if (d.error) return { error: d.error };
    // sips has no password option: an encrypted file with a user password cannot be rendered by it
    const r = e.password || PAGE !== 1 ? { code: 1, err: '' } : sh('sips', ['-s', 'format', 'png', file, '--out', png]);
    return { pages: d.pages, text: d.text, warnings: uniq(lines(r.err, /error|warning/i)), png: r.code === 0 && fs.existsSync(png) ? png : null, note: e.password ? 'sips cannot take a password: not rendered' : PAGE !== 1 ? 'sips renders page 1 only' : undefined };
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

/**
 * pixels of a PNG flattened on white, brought to w × h, lightly blurred (anti-aliasing and 1-px shifts are noise).
 * Engines round the page size differently (595.28 pt → 595 or 596 px): within 2 px the image is padded with white or
 * cut, never stretched (stretching shifts every edge and made gs differ from everyone); beyond that it is resized.
 */
async function raster(file, w, h) {
  const m = await sharp(file).metadata();
  let img = sharp(file).flatten({ background: '#ffffff' }).removeAlpha();
  if (Math.abs(m.width - w) > 2 || Math.abs(m.height - h) > 2) img = img.resize(w, h, { fit: 'fill' });
  else img = sharp(await img.extend({ right: Math.max(0, w - m.width), bottom: Math.max(0, h - m.height), background: '#ffffff' }).png().toBuffer()).extract({ left: 0, top: 0, width: w, height: h });
  return img.blur(1).raw().toBuffer();
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
    if (r.skip) { status = 'skip'; notes.push(r.error); }
    else if (r.error) { status = 'fail'; notes.push(`did not open: ${r.error}`); }
    else {
      if (r.pages != null && Number(r.pages) !== Number(e.pages)) bad('fail', `${r.pages} pages, expected ${e.pages}`);
      for (const w of r.warnings ?? []) {
        if (eng.noIccWhen?.test(w)) eng.noIcc = true;
        if (eng.noise?.some((re) => re.test(w))) notes.push(`known noise of this build (every file): ${w.slice(0, 120)}`);
        else bad('warn', `warning: ${w.slice(0, 160)}`);
      }
      const tc = textCheck(eng.textCheck === false ? null : r.text, e.text);
      // phrases in complex scripts need /ActualText: an engine that ignores it is limited, the file is not wrong
      const limited = eng.actualText === false ? tc.missing.filter((m) => ACTUALTEXT_SCRIPTS.test(m)) : [];
      const missing = tc.missing.filter((m) => !limited.includes(m));
      if (limited.length) notes.push(`engine limitation (no /ActualText in its text extraction): ${limited.map((m) => `“${m}”`).join(', ')} not extracted as written`);
      if (missing.length) bad('warn', `text missing: ${missing.map((m) => `“${m}”`).join(', ')} (got: “${norm(r.text).slice(0, 160)}”)`);
      if (eng.textCheck === false) notes.push('text not checked (this print path turns fonts into Type 3 or outlines)');
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
  // pairwise pixel diffs of the rendered page; a print path is diffed against its source engine only
  const pngs = Object.entries(row.cells).filter(([, c]) => c.png && fs.existsSync(c.png));
  const by = Object.fromEntries(engines.map((x) => [x.name, x]));
  const pairOk = (a, b) => { const A = by[a].derivedFrom, B = by[b].derivedFrom; return !A && !B ? true : A === b || B === a; };
  row.diffs = [];
  if (sharp && pngs.length > 1) {
    const m = await sharp(pngs[0][1].png).metadata();
    const keep = new Set();
    for (let i = 0; i < pngs.length; i++) for (let j = i + 1; j < pngs.length; j++) {
      const [a, ca] = pngs[i], [b, cb] = pngs[j];
      if (!pairOk(a, b)) continue;
      const out = path.join(dir, `diff-${a}-${b}.png`);
      const pct = await diff(ca.png, cb.png, m.width, m.height, out);
      row.diffs.push({ a, b, pct: +pct.toFixed(2) });
      if (pct > THRESH) { keep.add(ca.png).add(cb.png).add(out); flagged.push({ file: e.file, a, b, pct: +pct.toFixed(2), images: [ca.png, cb.png, out].map((x) => path.relative(outDir, x)) }); }
      else fs.rmSync(out, { force: true });
    }
    // Among independent, colour-managed renderers (at least 3), one that differs from more than half of the others is
    // the odd one out. Print paths are judged against their source; a build without colour management only gets a note.
    const voters = pngs.map(([n]) => n).filter((n) => !by[n].derivedFrom && !by[n].noIcc);
    const flaggedWith = (n, among) => row.diffs.filter((d) => d.pct > THRESH && ((d.a === n && among.includes(d.b)) || (d.b === n && among.includes(d.a))));
    for (const [n, c] of pngs) {
      const src = by[n].derivedFrom;
      if (src) { const d = flaggedWith(n, [src])[0]; if (d) { if (c.status === 'ok') c.status = 'warn'; c.notes.push(`the print path changed the rendering: ${d.pct}% differs from ${src}`); } continue; }
      if (voters.length < 3) { const k = flaggedWith(n, pngs.map(([x]) => x).filter((x) => x !== n)); if (k.length) c.notes.push(`differs from ${k.map((d) => (d.a === n ? d.b : d.a)).join(', ')} (too few engines to say which is right)`); continue; }
      const others = voters.filter((x) => x !== n), k = flaggedWith(n, others).length;
      if (k > others.length / 2) {
        if (by[n].noIcc) { c.notes.push(`renders differently from ${k} of ${others.length} engines (this build has no colour management: CMYK and ICC colours differ)`); continue; }
        if (c.status === 'ok') c.status = 'warn'; c.notes.push(`renders differently from ${k} of ${others.length} engines`);
      }
    }
    row.keep = [...keep];
  }
  if (!process.env.KEEP_PNGS) for (const [, c] of pngs) if (!row.keep?.includes(c.png)) { fs.rmSync(c.png, { force: true }); c.png = null; }
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
  const L = ['# Cross-renderer report: @reportwright/pdf', '', `Generated ${new Date().toISOString()} by packages/pdf/tools/cross-render.mjs. ✅ opened cleanly, page count and expected text right; ⚠️ opened with a warning, missing text, a field/annotation count off or a page that renders differently from most engines; ❌ did not open, wrong page count or an invalid signature; — not run. A pixel pair is flagged above ${runs[0].meta.threshold}% of the rendered page's pixels differing (72 dpi, blurred 1 px, channel difference > 48).`, '', '## Engines', '', '| Run | Engine | Version |', '|---|---|---|'];
  for (const r of runs) {
    for (const [n, v] of Object.entries(r.meta.engines)) L.push(`| ${r.meta.label} (${r.meta.os}) | ${n} | ${v} |`);
    if (r.meta.skipped.length) L.push(`| ${r.meta.label} | skipped | ${r.meta.skipped.join(', ')} |`);
  }
  L.push('', '## Summary', '', `| Engine | ${MARK.ok} | ${MARK.warn} | ${MARK.fail} |`, '|---|---|---|---|');
  for (const c of cols) {
    const s = c.run.results.map((x) => x.cells[c.n]?.status).filter(Boolean);
    L.push(`| ${c.key} | ${s.filter((x) => x === 'ok').length} | ${s.filter((x) => x === 'warn').length} | ${s.filter((x) => x === 'fail').length} |`);
  }
  for (const r of runs) {
    const cs = cols.filter((c) => c.run === r);
    L.push('', `## Matrix: ${r.meta.label}`, '', `| File | ${cs.map((c) => c.n).join(' | ')} |`, `|---|${cs.map(() => '---').join('|')}|`);
    for (const x of r.results) L.push(`| ${x.file} | ${cs.map((c) => MARK[x.cells[c.n]?.status ?? 'skip']).join(' | ')} |`);
  }
  L.push('', '## Notes per file', '');
  for (const f of files) {
    const notes = cols.map((c) => [c.key, c.run.results.find((x) => x.file === f)?.cells[c.n]]).filter(([, c]) => c?.notes?.length);
    if (!notes.length) continue;
    L.push(`**${f}** — ${runs.map((r) => r.results.find((x) => x.file === f)?.feature).find(Boolean) ?? ''}`, '');
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
