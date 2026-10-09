# Acrobat checklist: @reportwright/pdf

> **Who runs this.** The owner has no Acrobat. The cloud stand-in is the `windows` job of
> `.github/workflows/pdf-crossrender.yml`: it installs the free Acrobat Reader with Chocolatey (marked experimental:
> allowed to fail), opens each signed, encrypted and form file, and screenshots the whole screen
> (`reports-windows` artifact, `acrobat/*.png`, listed in `acrobat-windows.md`); the same job opens every corpus file
> in the real Chrome and Edge PDF viewers. Screenshots show whether Reader opened the file, prompted for a password or
> complained; they cannot fill fields, read panels or save. An outside tester with Acrobat Reader runs the list below.

## Get the files

`node packages/pdf/tools/corpus.mjs <outDir>` writes them (or download the `corpus` artifact of the workflow). The
password of the encrypted files is **`open sesame`**. `signer.crt` is the throwaway self-signed certificate of the
signed files.

| File | What it exercises |
|---|---|
| `forms-all.pdf` | every field type: text, multiline, comb, password, checkbox, radio, combo, list, button, signature, a group |
| `forms-flattened.pdf` | the same form flattened into the page |
| `encrypt-aes128.pdf` | AES-128, user password, copy/modify/assemble off |
| `encrypt-aes256.pdf` | AES-256, user password, copy and high-quality print off |
| `encrypt-aes256-nouser.pdf` | AES-256 with no user password: opens without a prompt, modify off |
| `sign-pades.pdf` | a PAdES B-B signature, RSA-2048, self-signed |
| `sign-certify-encrypted.pdf` | a certifying (DocMDP 2) signature on an AES-256 file |
| `pdfa-3b-facturx.pdf` | PDF/A-3b with a Factur-X invoice and a CSV attached |
| `annots-all.pdf` | every annotation type, plus a file attachment annotation |
| `layers.pdf` | optional content: visible, hidden, locked, print-only, screen-only |
| `nav-outline.pdf` | bookmarks, named destinations, links, page labels (i, ii, 1–3, Appendix A) |
| `pdfua-tagged.pdf` | PDF/UA-1: headings, table with headers, list, figure, link |
| `pdfa-1b.pdf`, `pdfa-2b.pdf` | PDF/A levels |
| `text-*.pdf`, `gfx-*.pdf`, `colour-*.pdf`, `images-*.pdf`, `page-*.pdf` | rendering: compare with the other viewers' output |

## Adobe Acrobat Reader (free)

Note the Reader version (Help > About) and the OS. For each row: pass, fail (with a screenshot), or n/a.

| # | Check | Files | Expected |
|---|---|---|---|
| 1 | Opens without an error and without "repair" | all | no dialog; closing asks **no** "save changes?" (a save prompt on an untouched file means Reader repaired it) |
| 2 | Fields show their values | `forms-all.pdf` | name "Ada Lovelace", city "Paris", PIN 1 2 3 4 in cells, notes on two lines, both checkboxes on, radio M, combo "Germany", list "French" selected |
| 3 | Fields fill and save | `forms-all.pdf` | type into name, change the radio, tick/untick, pick from combo and list; File > Save As; reopen: values kept, appearances right |
| 4 | Clear button | `forms-all.pdf` | resets the fields (the only action the library writes) |
| 5 | Flattened form | `forms-flattened.pdf` | looks like row 2 but nothing is editable; no form bar |
| 6 | Password prompt | `encrypt-aes128.pdf`, `encrypt-aes256.pdf`, `sign-certify-encrypted.pdf` | asks for a password; `open sesame` opens it; a wrong one is refused |
| 7 | No prompt | `encrypt-aes256-nouser.pdf` | opens directly; title bar may say "(SECURED)" |
| 8 | Permissions | encrypted files: File > Properties > Security | Security method "Password Security"; encryption level 128-bit AES / 256-bit AES; "Not Allowed" for what was turned off (aes128: changing the document, content copying, page extraction/assembly; aes256: content copying, high-quality printing → "Low resolution"; nouser: changing the document) |
| 9 | Signature panel | `sign-pades.pdf` | blue/yellow bar: signed; Signature panel shows the signature by "Throwaway Test Signer", **document not modified since signed**, signer's identity **unknown** / not trusted (self-signed: expected); reason "Approved", location "Paris" |
| 10 | Trusting the signer (optional) | `sign-pades.pdf` | Signature properties > Show Signer's Certificate > Trust > add `signer.crt`; re-validate: "valid" |
| 11 | Certified + encrypted | `sign-certify-encrypted.pdf` | after the password: "Certified by Throwaway Test Signer", form filling and signing allowed, identity unknown |
| 12 | Attachments panel | `pdfa-3b-facturx.pdf`, `annots-all.pdf` | paperclip panel lists `factur-x.xml` and `lines.csv` (with descriptions); `annots-all.pdf` has `figures.csv` as a pin on the page; saving them gives the right bytes |
| 13 | PDF/A banner | `pdfa-1b.pdf`, `pdfa-2b.pdf`, `pdfa-3b-facturx.pdf` | "This file claims compliance with the PDF/A standard and has been opened read-only" |
| 14 | Layers panel | `layers.pdf` | five layers; "Hidden layer" and "Print only" off; the hidden text not shown; "Locked layer" cannot be toggled; File > Print preview shows "Print-only text" and not "Screen-only text" |
| 15 | Bookmarks | `nav-outline.pdf` | Cover, Chapters (bold, blue) with Chapter 1–3 (2 in italics), Appendix (closed); each goes to its page |
| 16 | Page labels | `nav-outline.pdf` | the page box shows i, ii, 1, 2, 3, Appendix A (and "(1 of 6)") |
| 17 | Links | `nav-outline.pdf` page ii | appendix link, Chapter 2, example.com (asks to allow the site), Next page |
| 18 | Annotations | `annots-all.pdf` | Comments panel lists 18 items incl. a reply from Bo to Ada; each draws as on the other viewers |
| 19 | Accessibility check | `pdfua-tagged.pdf` | Reader has no full checker; if "Accessibility" > "Read Out Loud" is there, it reads the heading, table and list in order. Tags panel is Pro only |
| 20 | Rendering | `text-*`, `gfx-*`, `colour-*`, `images-*`, `page-*` | the same as the other engines' renders in the workflow's report (shaped Arabic and Devanagari, blend modes, patterns, CMYK JPEG colours, rotated pages) |

## Acrobat Pro (optional, later)

| # | Check | Files | Expected |
|---|---|---|---|
| P1 | Preflight > PDF/A compliance > "Verify compliance with PDF/A-1b / 2b / 3b" | `pdfa-1b.pdf`, `pdfa-2b.pdf`, `pdfa-3b-facturx.pdf` | no problems found (veraPDF passes them in the workflow) |
| P2 | Preflight > PDF/UA > "Verify compliance with PDF/UA-1" | `pdfua-tagged.pdf` | no problems found |
| P3 | Accessibility > Full Check | `pdfua-tagged.pdf` | passes, except the manual checks (logical reading order, colour contrast), which need a human |
| P4 | Tags panel | `pdfua-tagged.pdf` | H1, P, Table (THead/TBody, TH with scope, TD), L/LI/Lbl/LBody, Figure with alt text, Link |
| P5 | Preflight > "Report PDF syntax issues" | any | none |
| P6 | Output preview / Separations | `colour-spot.pdf`, `colour-cmyk.pdf`, `print-test.pdf` | the PANTONE 185 C plate listed separately from CMYK; the K-only grey ramp only on the black plate |
