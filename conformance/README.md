# veraPDF conformance reports

Machine-readable veraPDF reports (`--format json`) for the standards files of the cross-render corpus, so they can be
read without installing veraPDF. Each `<file>.<flavour>.json` is the report for that file validated as that flavour.

- veraPDF 1.30.0 (core and validation model 1.30.2), run 2026-10-09, on `@reportwright/pdf` 0.1.0-beta.1.
- The PDFs are not committed; make them again with:

```sh
CORPUS_ONLY=pdfa-1b,pdfa-2b,pdfa-3b-facturx,pdfua-tagged,pdfa-2u,pdfa-3u,pdfa-2a,pdfa-3a node packages/pdf/tools/corpus.mjs out/
verapdf --flavour 2a --format json out/pdfa-2a.pdf      # one per file and flavour, as in the table
```

| File | Flavour | Result | Rules passed | Failed rules |
|---|---|---|---|---|
| pdfa-1b.pdf | PDF/A-1b | compliant | 129 | 0 |
| pdfa-2b.pdf | PDF/A-2b | compliant | 144 | 0 |
| pdfa-2u.pdf | PDF/A-2u | compliant | 146 | 0 |
| pdfa-2a.pdf | PDF/A-2a | compliant | 153 | 0 |
| pdfa-2a.pdf | PDF/UA-1 | compliant | 106 | 0 |
| pdfa-3b-facturx.pdf (Factur-X EN 16931 + a CSV attachment) | PDF/A-3b | compliant | 146 | 0 |
| pdfa-3u.pdf | PDF/A-3u | compliant | 148 | 0 |
| pdfa-3a.pdf | PDF/A-3a | compliant | 155 | 0 |
| pdfa-3a.pdf | PDF/UA-1 | compliant | 106 | 0 |
| pdfua-tagged.pdf | PDF/UA-1 | compliant | 106 | 0 |

The test suite runs veraPDF on these levels and more (shaped Arabic and Devanagari text, forms, signatures) when it is
installed: `tests/pdf/standards*.test.js`, `tests/pdf/text-shaping.test.js`.
