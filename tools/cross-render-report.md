> **Status: local smoke only — the full matrix comes from CI.** The laptop could not take a full run (storage and
> heat), so this file holds the local smoke test: 3 corpus files (`CORPUS_ONLY=text-standard14,forms-all,encrypt-aes256`)
> through 1 engine (poppler), plus a dry build of all 37 corpus PDFs and the print sheet in memory (every builder runs
> without an error or a warning). The real cross-engine report is the `cross-render-report` artifact of
> `.github/workflows/pdf-crossrender.yml` (also in the run's summary): PDFium, pdf.js, MuPDF, Ghostscript (+ pdfwrite,
> ps2write, PCL XL, PCL 5, CUPS), poppler, qpdf and veraPDF on Linux; Chrome, Edge and Acrobat Reader on Windows; Apple
> Quartz on macOS. Replace this file with that artifact after the first run. Real problems found: none yet — the
> engines that could find them have not run.

# Cross-renderer report: @reportwright/pdf

Generated 2026-10-09T01:41:25.425Z by packages/pdf/tools/cross-render.mjs. ✅ opened cleanly, page count and expected text right; ⚠️ opened with a warning, missing text, a field/annotation count off or a page that renders differently from most engines; ❌ did not open, wrong page count or an invalid signature; — not run. A pixel pair is flagged above 2% of the rendered page's pixels differing (72 dpi, blurred 1 px, channel difference > 48).

## Engines

| Run | Engine | Version |
|---|---|---|
| local-smoke (Darwin 27.0.0 arm64) | poppler | pdftoppm version 26.04.0 |

## Summary

| Engine | ✅ | ⚠️ | ❌ |
|---|---|---|---|
| poppler | 3 | 0 | 0 |

## Matrix: local-smoke

| File | poppler |
|---|---|
| text-standard14.pdf | ✅ |
| forms-all.pdf | ✅ |
| encrypt-aes256.pdf | ✅ |

## Notes per file

## Flagged pixel differences

None above the threshold.
