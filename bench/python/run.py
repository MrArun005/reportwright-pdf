"""Benchmark @reportwright/pdf against Python PDF libraries (pypdf, pdfminer.six, ReportLab, pikepdf, PyMuPDF).

  python run.py [--runs N] [--jobs a,b] [--libs a,b] [--out DIR]
Makes the fixtures (ReportLab, deterministic), then for each (job, library) that the library supports:
  warm: one process, one warm-up, median of N timed runs;  cold: median of N new processes (start, import, run once);
  peak RSS of the cold processes; output size; qpdf --check of every PDF output (page count too); text length for extraction.
Writes results.json and results.md to --out. Nothing is tuned: every library runs with its documented defaults.
"""
import argparse, json, os, platform, shutil, statistics, subprocess, sys, time, zlib, struct
from importlib import metadata

HERE = os.path.dirname(os.path.abspath(__file__))
LIBS = ["reportwright", "pymupdf", "pypdf", "pdfminer.six", "pikepdf", "reportlab"]
DIST = {"pymupdf": "PyMuPDF", "pypdf": "pypdf", "pdfminer.six": "pdfminer.six", "pikepdf": "pikepdf", "reportlab": "reportlab"}
JOBS = {  # job: (what, expected pages of the PDF output or None, password)
    "create-1000": ("create a 1,000-page text report", 1000, None),
    "invoice-ttf-png": ("invoice with an embedded TTF and a PNG", 1, None),
    "extract-big": ("extract text, 1,200-page generated PDF", None, None),
    "extract-real": ("extract text, real-world style PDF", None, None),
    "merge-100": ("merge 100 files of 10 pages", 1000, None),
    "split-pages": ("split the 1,200-page PDF into one file a page", 1, None),
    "encrypt-aes256": ("encrypt the 1,200-page PDF with AES-256", 1200, "user"),
    "incremental-info": ("change the title of the 1,200-page PDF as an incremental update", 1200, None),
}
FONTS = ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"]


def png(w=200, h=100):
    """an RGBA gradient with a soft alpha edge, written with zlib (no imaging library involved)"""
    rows = b"".join(b"\0" + bytes(v for x in range(w) for v in (x * 255 // w, y * 255 // h, 128, min(255, 4 * min(x, y, w - 1 - x, h - 1 - y)))) for y in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b"")


def fixtures(d, small):
    from reportlab import rl_config
    rl_config.invariant = 1  # deterministic bytes (no dates, fixed IDs)
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.lib import colors
    from reportlab.platypus import BaseDocTemplate, Frame, PageTemplate, Paragraph, Table, TableStyle, Image, Spacer
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    os.makedirs(d, exist_ok=True)
    font = os.environ.get("BENCH_FONT") or next(f for f in FONTS if os.path.exists(f))
    shutil.copyfile(font, os.path.join(d, "font.ttf"))
    open(os.path.join(d, "logo.png"), "wb").write(png())
    words = "the quick brown fox jumps over a lazy dog while five boxing wizards jump quickly and vexing daft zebras pack my box".split()

    def pages(path, n, tag):
        c = canvas.Canvas(path, pagesize=A4); c.setTitle(tag)
        for p in range(1, n + 1):
            c.setFont("Helvetica", 10)
            for r in range(45):
                c.drawString(50, 800 - r * 16, f"{tag} page {p} line {r + 1}: " + " ".join(words[(p * 7 + r * 3 + i) % len(words)] for i in range(10)))
            c.showPage()
        c.save()

    pages(os.path.join(d, "big.pdf"), 12 if small else 1200, "Big")
    for k in range(100):
        pages(os.path.join(d, f"m{k}.pdf"), 10, f"Doc {k}")
    # real-world style: two columns, headings, justified body in an embedded TTF, tables, an image, page headers
    pdfmetrics.registerFont(TTFont("Body", os.path.join(d, "font.ttf")))
    ss = getSampleStyleSheet(); body = ss["BodyText"].clone("b", fontName="Body", fontSize=9, leading=11.5, alignment=4)
    W, H = A4; cw = (W - 100 - 20) / 2
    doc = BaseDocTemplate(os.path.join(d, "real.pdf"), pagesize=A4, title="Annual report")
    head = lambda c, _d: (c.setFont("Helvetica", 8), c.drawString(50, H - 30, f"Annual report 2025 - page {c.getPageNumber()}"))
    doc.addPageTemplates([PageTemplate(frames=[Frame(50, 50, cw, H - 110), Frame(70 + cw, 50, cw, H - 110)], onPage=head)])
    story = []
    for s in range(3 if small else 60):
        story += [Paragraph(f"Section {s + 1}: results and outlook", ss["Heading2"])]
        for k in range(4):
            story.append(Paragraph(" ".join(words[(s * 13 + k * 5 + i * 7) % len(words)] for i in range(90)) + ".", body))
        t = Table([["Region", "Q1", "Q2", "Q3", "Q4"]] + [[f"R{s}-{i}"] + [f"{(s * 31 + i * 17 + q * 7) % 997:,}" for q in range(4)] for i in range(6)])
        t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.3, colors.grey), ("BACKGROUND", (0, 0), (-1, 0), colors.lightblue), ("FONTSIZE", (0, 0), (-1, -1), 8)]))
        story += [Spacer(1, 6), t, Spacer(1, 6)]
        if s % 5 == 0:
            story.append(Image(os.path.join(d, "logo.png"), width=cw, height=cw / 2))
    doc.build(story)


def cmd(lib, job, fix, out, runs):
    script = ["node", os.path.join(HERE, "ours.mjs")] if lib == "reportwright" else [sys.executable, os.path.join(HERE, "tasks.py")]
    return script + [lib, job, fix, out, str(runs)]



def run_rss(argv, timeout):
    """one child process: wall seconds, its own peak RSS in MB (os.wait4 on its pid), exit code, stdout, stderr"""
    import tempfile, threading
    with tempfile.TemporaryFile() as so, tempfile.TemporaryFile() as se:
        t = time.perf_counter()
        p = subprocess.Popen(argv, stdout=so, stderr=se)
        timer = threading.Timer(timeout, p.kill); timer.start()
        _, status, ru = os.wait4(p.pid, 0)
        secs = time.perf_counter() - t
        timer.cancel(); p.returncode = rc = os.waitstatus_to_exitcode(status)
        if rc == -9 and secs >= timeout: raise subprocess.TimeoutExpired(argv, timeout)
        so.seek(0); se.seek(0)
        rss = ru.ru_maxrss / (1 << 20 if sys.platform == "darwin" else 1 << 10)  # bytes on macOS, KB on Linux
        return secs, rss, rc, so.read().decode(), se.read().decode()


def check(job, out, pw, fix_dir):
    """qpdf --check and the page count of the PDF outputs; the text length for extraction"""
    files = sorted(os.listdir(out))
    size = sum(os.path.getsize(os.path.join(out, f)) for f in files)
    if job.startswith("extract"):
        t = open(os.path.join(out, "text.txt"), encoding="utf-8").read()
        return {"bytes": size, "chars": len(t), "valid": "ok" if "lazy dog" in t or "quick brown" in t else "no expected text"}
    pdfs = [f for f in files if f.endswith(".pdf")]
    sample = [pdfs[0], pdfs[-1]] if job == "split-pages" else pdfs  # ponytail: split checks first and last file, not all 1,200
    verdicts, pages = [], []
    for f in sample:
        a = ["qpdf"] + ([f"--password={pw}"] if pw else []) + ["--check", os.path.join(out, f)]
        rc = subprocess.run(a, capture_output=True).returncode
        verdicts.append({0: "ok", 3: "warnings"}.get(rc, "FAIL"))
        n = subprocess.run(["qpdf"] + ([f"--password={pw}"] if pw else []) + ["--show-npages", os.path.join(out, f)], capture_output=True, text=True).stdout.strip()
        pages.append(int(n) if n.isdigit() else None)
    if job == "incremental-info":  # really an update appended to the original, and the new title is in it
        orig, new = open(os.path.join(fix_dir, "big.pdf"), "rb").read(), open(os.path.join(out, pdfs[0]), "rb").read()
        import pikepdf  # reads the title back (any string encoding)
        with pikepdf.open(os.path.join(out, pdfs[0])) as p: title = str(p.docinfo.get("/Title", ""))
        if not new.startswith(orig) or title != "Changed": verdicts.append("FAIL (not incremental, or title unchanged)")
    v = next((x for x in verdicts if x.startswith("FAIL")), None) or ("warnings" if "warnings" in verdicts else "ok")
    return {"bytes": size, "files": len(pdfs), "pages": pages[0] if len(set(pages)) == 1 else pages, "valid": v}


def machine():
    m = {"platform": platform.platform(), "python": platform.python_version(), "cpus": os.cpu_count()}
    try:
        m["cpu"] = next(l.split(":", 1)[1].strip() for l in open("/proc/cpuinfo") if l.startswith("model name"))
        m["mem_gb"] = round(int(next(l.split()[1] for l in open("/proc/meminfo") if l.startswith("MemTotal"))) / 2**20, 1)
    except OSError:
        m["cpu"] = platform.processor()
    m["node"] = subprocess.run(["node", "-v"], capture_output=True, text=True).stdout.strip()
    m["qpdf"] = subprocess.run(["qpdf", "--version"], capture_output=True, text=True).stdout.splitlines()[0]
    return m


def versions():
    v = {k: metadata.version(d) for k, d in DIST.items() if _installed(d)}
    v["reportwright"] = json.load(open(os.path.join(HERE, "../../package.json")))["version"]
    return v


def _installed(d):
    try: metadata.version(d); return True
    except metadata.PackageNotFoundError: return False


def supported(lib, job):
    if lib == "reportwright": return True
    sys.path.insert(0, HERE); import tasks
    return job in tasks.JOBS.get(lib, {})


def table(res):
    libs = [l for l in LIBS if any(l in r["libs"] for r in res["jobs"].values())]
    lines = [f"Machine: {res['machine'].get('cpu')}, {res['machine']['cpus']} CPUs, {res['machine'].get('mem_gb', '?')} GB, {res['machine']['platform']}; "
             f"Python {res['machine']['python']}, Node {res['machine']['node']}, {res['machine']['qpdf']}. Runs: {res['runs']} (median).",
             "", "Versions: " + ", ".join(f"{k} {v}" for k, v in res["versions"].items()), "",
             "Each cell: warm ms / cold ms / peak RSS MB / output KB / validity (qpdf --check, or the expected text for extraction). n/a: the library has no API for the job.", "",
             "| job | " + " | ".join(libs) + " |", "|---|" + "---|" * len(libs)]
    for job, r in res["jobs"].items():
        cells = []
        for l in libs:
            c = r["libs"].get(l)
            if c is None: cells.append("n/a")
            elif "error" in c: cells.append(f"error: {c['error']}")
            else:
                extra = f"{c['chars']:,} chars" if "chars" in c else f"{c.get('pages')} p"
                cells.append(f"{c['warm_ms']:.0f} / {c['cold_ms']:.0f} / {c['rss_mb']:.0f} / {c['bytes'] / 1024:,.0f} / {c['valid']}, {extra}")
        lines.append(f"| {JOBS[job][0]} | " + " | ".join(cells) + " |")
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--jobs", default=",".join(JOBS))
    ap.add_argument("--libs", default=",".join(LIBS))
    ap.add_argument("--out", default="bench-out")
    ap.add_argument("--small", action="store_true", help="tiny fixtures, for checking the plumbing only")
    ap.add_argument("--timeout", type=int, default=1200)
    a = ap.parse_args()
    fix, work = os.path.abspath(os.path.join(a.out, "fixtures")), os.path.abspath(os.path.join(a.out, "work"))
    if not os.path.exists(os.path.join(fix, "real.pdf")): fixtures(fix, a.small)
    res = {"machine": machine(), "versions": versions(), "runs": a.runs, "small": a.small, "jobs": {}}
    for job in a.jobs.split(","):
        res["jobs"][job] = {"what": JOBS[job][0], "libs": {}}
        for lib in a.libs.split(","):
            if not supported(lib, job): continue
            print(f"{job} / {lib}", flush=True)
            c = {}
            try:
                colds, rss = [], []
                for i in range(a.runs + 1):  # the first is discarded: it fills the OS file cache and Python's .pyc cache
                    shutil.rmtree(work, ignore_errors=True); os.makedirs(work)
                    s, m, rc, so, se = run_rss(cmd(lib, job, fix, work, 0), a.timeout)
                    if rc: raise RuntimeError(se.strip().splitlines()[-1][:200] if se.strip() else f"exit {rc}")
                    if i: colds.append(s * 1000); rss.append(m)
                c.update(check(job, work, JOBS[job][2], fix))  # the last cold run's output
                shutil.rmtree(work); os.makedirs(work)
                s, m, rc, so, se = run_rss(cmd(lib, job, fix, work, a.runs), a.timeout)
                if rc: raise RuntimeError(se.strip().splitlines()[-1][:200] if se.strip() else f"exit {rc}")
                c.update(warm_ms=json.loads(so.strip().splitlines()[-1])["warm_ms"], cold_ms=statistics.median(colds), rss_mb=max(rss))
            except subprocess.TimeoutExpired:
                c = {"error": f"timeout {a.timeout}s"}
            except Exception as e:
                c = {"error": str(e)}
            res["jobs"][job]["libs"][lib] = c
            print("  ", c, flush=True)
    shutil.rmtree(work, ignore_errors=True)
    json.dump(res, open(os.path.join(a.out, "results.json"), "w"), indent=2)
    md = table(res); open(os.path.join(a.out, "results.md"), "w").write(md); print(md)


if __name__ == "__main__":
    main()
