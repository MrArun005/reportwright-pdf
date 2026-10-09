"""One (library, job) measured in this process: one warm-up, then RUNS timed runs; prints JSON to stdout.

  python tasks.py <lib> <job> <fixtures dir> <out dir> <runs>     (runs 0: one untimed run, for the cold measurement)
Every library runs with its documented defaults. A job a library cannot do is not listed in JOBS (reported n/a).
"""
import json, os, sys, time, statistics, io

FIX = OUT = ""  # set in __main__
LINE = lambda p, r: f"Page {p}, line {r}: the quick brown fox jumps over the lazy dog {p * 50 + r}"
ROWS = [(f"Item {i + 1} - consulting services", str(1 + i % 5), f"{120 + i * 7.5:.2f}") for i in range(20)]
fx = lambda name: os.path.join(FIX, name)
out = lambda name: os.path.join(OUT, name)
MERGE = lambda: [fx(f"m{k}.pdf") for k in range(100)]
PW_USER, PW_OWNER = "user", "owner"


# ---------- ReportLab ----------
def rl_report():
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A4
    c = canvas.Canvas(out("report.pdf"), pagesize=A4)
    c.setTitle("Bench")
    for p in range(1, 1001):
        c.setFont("Times-Roman", 10)
        for r in range(50):
            c.drawString(50, A4[1] - 40 - r * 15 - 10, LINE(p, r))
        c.showPage()
    c.save()

def rl_invoice():
    from reportlab.pdfgen import canvas
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.lib.pagesizes import A4
    pdfmetrics.registerFont(TTFont("Body", fx("font.ttf")))
    c = canvas.Canvas(out("invoice.pdf"), pagesize=A4)
    H = A4[1]
    c.drawImage(fx("logo.png"), 450, H - 90, 96, 48, mask="auto")
    c.setFont("Body", 20); c.drawString(50, H - 70, "INVOICE #2026-0042")
    c.setFont("Body", 10)
    for k, row in enumerate(ROWS):
        for i, v in enumerate(row):
            c.drawString(55 + (0, 330, 420)[i], H - 150 - k * 18, v)
    c.drawString(420, H - 150 - 20 * 18 - 10, "Total 3,825.00")
    c.showPage(); c.save()


# ---------- PyMuPDF (MuPDF, the C reference) ----------
def mu_report():
    import fitz
    d = fitz.open()
    for p in range(1, 1001):
        pg = d.new_page(width=595.28, height=841.89)
        pg.insert_text((50, 50), "\n".join(LINE(p, r) for r in range(50)), fontname="tiro", fontsize=10, lineheight=1.5)
    d.set_metadata({"title": "Bench"})
    d.save(out("report.pdf"))

def mu_invoice():
    import fitz
    d = fitz.open(); pg = d.new_page(width=595.28, height=841.89)
    pg.insert_font(fontname="body", fontfile=fx("font.ttf"))
    pg.insert_image(fitz.Rect(450, 42, 546, 90), filename=fx("logo.png"))
    pg.insert_text((50, 70), "INVOICE #2026-0042", fontname="body", fontsize=20)
    for k, row in enumerate(ROWS):
        for i, v in enumerate(row):
            pg.insert_text((55 + (0, 330, 420)[i], 150 + k * 18), v, fontname="body", fontsize=10)
    pg.insert_text((420, 150 + 20 * 18 + 10), "Total 3,825.00", fontname="body", fontsize=10)
    d.subset_fonts()  # ponytail: subsetting matches ReportLab and ours, which subset by default
    d.save(out("invoice.pdf"), garbage=3, deflate=True)

def mu_extract(name):
    import fitz
    with fitz.open(fx(name)) as d:
        t = "\f".join(p.get_text() for p in d)
    open(out("text.txt"), "w", encoding="utf-8").write(t)

def mu_merge():
    import fitz
    d = fitz.open()
    for f in MERGE():
        with fitz.open(f) as s: d.insert_pdf(s)
    d.save(out("merged.pdf"), garbage=3, deflate=True)

def mu_split():
    import fitz
    with fitz.open(fx("big.pdf")) as s:
        for i in range(s.page_count):
            d = fitz.open(); d.insert_pdf(s, from_page=i, to_page=i); d.save(out(f"p{i + 1}.pdf"), garbage=3, deflate=True); d.close()

def mu_encrypt():
    import fitz
    with fitz.open(fx("big.pdf")) as d:
        d.save(out("enc.pdf"), encryption=fitz.PDF_ENCRYPT_AES_256, user_pw=PW_USER, owner_pw=PW_OWNER)

def mu_incremental():
    import fitz, shutil
    shutil.copyfile(fx("big.pdf"), out("inc.pdf"))  # incremental saves append to the file in place
    with fitz.open(out("inc.pdf")) as d:
        d.set_metadata({**d.metadata, "title": "Changed"})
        d.saveIncr()


# ---------- pypdf ----------
def pp_extract(name):
    from pypdf import PdfReader
    t = "\f".join(p.extract_text() for p in PdfReader(fx(name)).pages)
    open(out("text.txt"), "w", encoding="utf-8").write(t)

def pp_merge():
    from pypdf import PdfWriter
    w = PdfWriter()
    for f in MERGE(): w.append(f)
    w.write(out("merged.pdf"))

def pp_split():
    from pypdf import PdfReader, PdfWriter
    r = PdfReader(fx("big.pdf"))
    for i, p in enumerate(r.pages):
        w = PdfWriter(); w.add_page(p); w.write(out(f"p{i + 1}.pdf"))

def pp_encrypt():
    from pypdf import PdfWriter
    w = PdfWriter(clone_from=fx("big.pdf"))
    w.encrypt(PW_USER, PW_OWNER, algorithm="AES-256")
    w.write(out("enc.pdf"))

def pp_incremental():
    from pypdf import PdfWriter
    w = PdfWriter(fx("big.pdf"), incremental=True)
    w.add_metadata({"/Title": "Changed"})
    w.write(out("inc.pdf"))


# ---------- pdfminer.six ----------
def pm_extract(name):
    from pdfminer.high_level import extract_text
    open(out("text.txt"), "w", encoding="utf-8").write(extract_text(fx(name)))


# ---------- pikepdf (qpdf) ----------
def pk_merge():
    import pikepdf
    d = pikepdf.new(); srcs = []
    for f in MERGE():
        s = pikepdf.open(f); srcs.append(s); d.pages.extend(s.pages)
    d.save(out("merged.pdf"))
    for s in srcs: s.close()

def pk_split():
    import pikepdf
    with pikepdf.open(fx("big.pdf")) as s:
        for i, p in enumerate(s.pages):
            d = pikepdf.new(); d.pages.append(p); d.save(out(f"p{i + 1}.pdf"))

def pk_encrypt():
    import pikepdf
    with pikepdf.open(fx("big.pdf")) as d:
        d.save(out("enc.pdf"), encryption=pikepdf.Encryption(user=PW_USER, owner=PW_OWNER, R=6))


JOBS = {
    "reportlab": {"create-1000": rl_report, "invoice-ttf-png": rl_invoice},
    "pymupdf": {"create-1000": mu_report, "invoice-ttf-png": mu_invoice, "extract-big": lambda: mu_extract("big.pdf"),
                "extract-real": lambda: mu_extract("real.pdf"), "merge-100": mu_merge, "split-pages": mu_split,
                "encrypt-aes256": mu_encrypt, "incremental-info": mu_incremental},
    "pypdf": {"extract-big": lambda: pp_extract("big.pdf"), "extract-real": lambda: pp_extract("real.pdf"), "merge-100": pp_merge,
              "split-pages": pp_split, "encrypt-aes256": pp_encrypt, "incremental-info": pp_incremental},
    "pdfminer.six": {"extract-big": lambda: pm_extract("big.pdf"), "extract-real": lambda: pm_extract("real.pdf")},
    "pikepdf": {"merge-100": pk_merge, "split-pages": pk_split, "encrypt-aes256": pk_encrypt},
}

if __name__ == "__main__":
    lib, job, FIX, OUT, runs = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])
    fn = JOBS[lib][job]
    fn()  # warm-up (or the only run, for a cold measurement)
    times = []
    for _ in range(runs):
        t = time.perf_counter(); fn(); times.append((time.perf_counter() - t) * 1000)
    print(json.dumps({"warm_ms": statistics.median(times) if times else None}))
