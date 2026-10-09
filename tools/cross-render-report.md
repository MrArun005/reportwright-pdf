> **Status: placeholder.** The full matrix is the `cross-render-report` artifact of
> `.github/workflows/pdf-crossrender.yml`; replace this file with it. The local part below is a 3-file, poppler-only
> smoke test (the laptop cannot take a full run).
>
> **First cloud run (37871057317), after triage.** Real library issue: `colour-icc.pdf` has a corrupt xref stream on
> Node 22 (qpdf ❌, PDFKit cannot open it; being fixed separately). Engine issue, not the library: PDFium draws the nested
> 20 × 20 tiling pattern of `gfx-patterns.pdf` at a 21 pt pitch (poppler, MuPDF, Ghostscript and pdf.js agree on 20 pt,
> which is the pattern's /XStep and /YStep), so Chrome and Edge show that checkerboard slightly stretched. Everything else
> flagged was the harness: pdf.js `doc.destroy` (pdf.js 6), the gs-pdfwrite page count read after the file was deleted,
> Quartz's page count as a string, per-build warnings counted as ⚠️ (MuPDF without lcms2, gs 10.02's exit message),
> text checked on PostScript output, /ActualText-blind extractors (MuPDF 1.23, Ghostscript txtwrite, PDFKit) on
> Devanagari, poppler and Ghostscript rendering the MediaBox instead of the CropBox (`page-boxes.pdf`), Ghostscript's
> 595-px page stretched to 596 px before diffing, its pdfwrite/ps2write re-renders counted as extra votes, MuPDF's
> naive CMYK (no ICC) in the majority vote, and a comb field's digits expected as one word. `images-png.pdf`'s
> remaining 2–3.5% differences are each engine's upscaling of 16 × 16 images (smoothing vs nearest pixel): the same
> images, not a difference in the file.

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
