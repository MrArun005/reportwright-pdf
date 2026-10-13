// Runs each example as an ES module against the library build copied into lib/ (the same dist/index.js that is
// published to npm). Examples import '@reportwright/pdf' and call show(bytes, name) and log(...).
const EXAMPLES = [
  ['text', 'Text and standard fonts'],
  ['custom-font', 'Custom font embedding'],
  ['images', 'Images (JPEG, PNG + alpha)'],
  ['tables', 'Tables and layout'],
  ['vector', 'Vector graphics'],
  ['links', 'Links and bookmarks'],
  ['forms', 'Forms: create, fill, flatten'],
  ['encrypt', 'Encryption (AES-256)', 'Writing encrypted files runs in the browser. Reading them back with a password needs Node (WebCrypto has no synchronous AES), so this example only writes.'],
  ['sign', 'Signing (PAdES)', 'Runs in the browser through WebCrypto + cmsSigner, with a public test key. nodeSigner (node:crypto) is Node only. The browser holds the file until the digest (no incremental SHA in WebCrypto).'],
  ['pdfa', 'PDF/A-2b'],
  ['tagged', 'Tagged PDF/UA-1 + PDF/A-2a'],
  ['indic', 'Indic / complex scripts', 'Loads harfbuzzjs (WebAssembly) from jsDelivr; harfbuzzjs is an optional peer, not a dependency.'],
  ['read', 'Read, merge, split, extractText'],
  ['facturx', 'Factur-X invoice'],
  ['render', 'Render a PDF to PNG', 'Makes a PDF, then draws page 1 with the experimental renderer (pure JS) and shows the PNG. Standard fonts use @reportwright/pdf-std-fonts.'],
];
const SPEC = "'@reportwright/pdf'";
const CDN_LIB = 'https://cdn.jsdelivr.net/npm/@reportwright/pdf@1.1.0/dist/index.js';
const CDN_FONTS = 'https://cdn.jsdelivr.net/gh/MrArun005/reportwright-pdf@main/public/fonts/';
const LIB = new URL('lib/index.js', location.href).href;
const FONTS = new URL('fonts/', location.href).href;
const $ = (id) => document.getElementById(id);
const code = $('code'), hl = $('hl'), logEl = $('log');
let current, original = '', outputs = [], urls = [];

// A tiny highlighter: comments, strings, keywords, numbers. Enough to read; the textarea stays the editor.
const TOKEN = /(\/\/[^\n]*)|('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|\b(import|from|const|let|await|async|for|of|if|return|new|function|export)\b|\b(\d+(?:\.\d+)?)\b/g;
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
function paint() {
  let out = '', last = 0;
  for (const m of code.value.matchAll(TOKEN)) {
    out += esc(code.value.slice(last, m.index));
    const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'k' : 'n';
    out += `<span class="tk-${cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  hl.innerHTML = out + esc(code.value.slice(last)) + '\n';
}
code.addEventListener('input', paint);
code.addEventListener('scroll', () => { hl.parentElement.scrollTop = code.scrollTop; hl.parentElement.scrollLeft = code.scrollLeft; });
code.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); }
  else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); document.execCommand('insertText', false, '  '); }
});

// The preview is drawn by the library's own renderer (renderToCanvas), from the same build the examples run against.
// The standard 14 fonts have no outlines in a PDF: the optional @reportwright/pdf-std-fonts files are fetched once.
const STD = { Helvetica: 'LiberationSans-Regular', 'Helvetica-Bold': 'LiberationSans-Bold', 'Helvetica-Oblique': 'LiberationSans-Italic', 'Helvetica-BoldOblique': 'LiberationSans-BoldItalic',
  'Times-Roman': 'LiberationSerif-Regular', 'Times-Bold': 'LiberationSerif-Bold', 'Times-Italic': 'LiberationSerif-Italic', 'Times-BoldItalic': 'LiberationSerif-BoldItalic',
  Courier: 'LiberationMono-Regular', 'Courier-Bold': 'LiberationMono-Bold', 'Courier-Oblique': 'LiberationMono-Italic', 'Courier-BoldOblique': 'LiberationMono-BoldItalic',
  Symbol: 'LiberationSerif-Regular', ZapfDingbats: 'NotoSansSymbols2-Regular' };
let stdFonts;
const loadStdFonts = () => (stdFonts ??= (async () => {
  const files = [...new Set(Object.values(STD))];
  const got = Object.fromEntries(await Promise.all(files.map(async (f) => [f, new Uint8Array(await (await fetch(`${FONTS}std/${f}.ttf`)).arrayBuffer())])));
  return Object.fromEntries(Object.entries(STD).map(([n, f]) => [n, got[f]]));
})());
async function renderPdf(bytes) {
  const box = $('viewer'); box.textContent = '';
  try {
    const [lib, fonts] = await Promise.all([import(LIB), loadStdFonts()]);
    const doc = await lib.loadPdf(bytes.slice());
    const scale = Math.min(4, Math.max(1, (box.clientWidth - 24) / 595 * devicePixelRatio));
    for (let n = 0; n < Math.min(doc.pageCount, 20); n++) {
      const c = document.createElement('canvas'); c.style.width = '100%';
      box.append(c); lib.renderToCanvas(doc, n, c.getContext('2d'), { scale, fonts });
      await new Promise((r) => setTimeout(r)); // let the page paint before the next
    }
    if (doc.pageCount > 20) box.append(Object.assign(document.createElement('p'), { textContent: `First 20 of ${doc.pageCount} pages shown; download for the rest.` }));
  } catch (e) {
    box.append(Object.assign(document.createElement('p'), { textContent: `Preview unavailable (${e.message}); the file is fine, use Download.` }));
  }
}

function setOutput(i) {
  const o = outputs[i];
  if (o.png) { const box = $('viewer'); box.textContent = ''; const im = new Image(); im.src = o.url; im.alt = o.name; im.style.width = '100%'; box.append(im); }
  else renderPdf(o.bytes);
  const a = $('download'); a.href = o.url; a.download = o.name; a.removeAttribute('aria-disabled');
  [...$('outs').children].forEach((b, j) => b.setAttribute('aria-pressed', String(i === j)));
}
window.show = (bytes, name = 'output.pdf') => {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('show() takes the PDF bytes (a Uint8Array)');
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  urls.push(url); outputs.push({ name, url, bytes });
  const b = document.createElement('button'); b.type = 'button'; b.textContent = `${name} · ${(bytes.length / 1024).toFixed(1)} KB`;
  const i = outputs.length - 1; b.onclick = () => setOutput(i); $('outs').append(b);
  setOutput(i);
};
window.showImage = (bytes, name = 'page.png') => { // PNG bytes
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  urls.push(url); outputs.push({ name, url, bytes, png: true });
  const b = document.createElement('button'); b.type = 'button'; b.textContent = `${name} · ${(bytes.length / 1024).toFixed(1)} KB`;
  const i = outputs.length - 1; b.onclick = () => setOutput(i); $('outs').append(b);
  setOutput(i);
};
window.log = (...a) => { logEl.textContent += a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n'; };

let queue = Promise.resolve();
const run = () => (queue = queue.then(runOnce));
async function runOnce() {
  urls.forEach((u) => URL.revokeObjectURL(u)); urls = []; outputs = [];
  $('outs').textContent = ''; logEl.textContent = ''; logEl.classList.remove('err');
  $('viewer').textContent = ''; $('download').setAttribute('aria-disabled', 'true'); $('download').removeAttribute('href');
  $('run').disabled = true; $('status').textContent = 'Running…';
  const src = code.value.replaceAll(SPEC, JSON.stringify(LIB)).replaceAll(CDN_FONTS, FONTS);
  const mod = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  const t0 = performance.now();
  try {
    await import(mod);
    $('status').textContent = `Done in ${Math.round(performance.now() - t0)} ms`;
    window.__result = { ok: true, outputs: outputs.map((o) => ({ name: o.name, size: o.bytes.length, head: String.fromCharCode(...o.bytes.slice(0, 5)), png: !!o.png })) };
  } catch (e) {
    logEl.classList.add('err'); logEl.textContent += `${e.name}: ${e.message}`;
    $('status').textContent = 'Error';
    window.__result = { ok: false, error: `${e.name}: ${e.message}` };
  } finally { URL.revokeObjectURL(mod); $('run').disabled = false; }
}

// JSFiddle: one HTML panel holding the page, a show/log shim and the example as a module, against npm 1.1.0.
function fiddleHtml(title, src) {
  return `<p style="font:14px system-ui">${title}: <a id="dl" download="output.pdf">download</a></p>
<pre id="log" style="white-space:pre-wrap"></pre>
<iframe id="out" style="width:100%;height:80vh;border:1px solid #ccc"></iframe>
<script>
window.log = (...a) => { document.getElementById('log').textContent += a.join(' ') + '\\n'; };
window.showImage = (bytes, name = 'page.png') => {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  document.getElementById('out').srcdoc = '<img style="width:100%" src="' + url + '">'; const a = document.getElementById('dl'); a.href = url; a.download = name; a.textContent = name;
};
window.show = (bytes, name = 'output.pdf') => {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  document.getElementById('out').src = url; const a = document.getElementById('dl'); a.href = url; a.download = name; a.textContent = name;
};
<\/script>
<script type="module">
${src.replaceAll(SPEC, `'${CDN_LIB}'`).replaceAll('</script', '<\\/script')}
<\/script>`;
}
$('fiddle').addEventListener('submit', () => {
  const f = $('fiddle');
  f.elements.title.value = `@reportwright/pdf: ${current[1]}`;
  f.elements.html.value = fiddleHtml(current[1], code.value);
});

async function select(id, autorun = true) {
  current = EXAMPLES.find((e) => e[0] === id) ?? EXAMPLES[0];
  [...$('list').children].forEach((b) => b.setAttribute('aria-selected', String(b.dataset.id === current[0])));
  $('title').textContent = current[1];
  $('note').textContent = current[2] ?? 'Runs in your browser against the real library build.';
  original = await (await fetch(`examples/${current[0]}.js`)).text();
  code.value = original; code.scrollTop = 0; paint();
  if (location.hash.slice(1) !== current[0]) history.replaceState(null, '', '#' + current[0]);
  if (autorun) run();
}
for (const [id, title] of EXAMPLES) {
  const b = document.createElement('button');
  b.type = 'button'; b.role = 'tab'; b.dataset.id = id;
  b.textContent = title;
  b.onclick = () => select(id);
  $('list').append(b);
}
$('run').onclick = run;
$('reset').onclick = () => { code.value = original; paint(); };
select(location.hash.slice(1));
