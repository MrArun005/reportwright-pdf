# Print checklist: @reportwright/pdf

> **Who runs this.** The owner has no printer. Until someone with one runs this list, the cloud stand-in is the
> `linux` job of `.github/workflows/pdf-crossrender.yml`: the print test sheet is sent down the paths a printer
> driver or print server uses (Ghostscript `ps2write` PostScript, `pxlcolor` PCL XL, `ljet4` PCL 5, CUPS's
> `cupsfilter` to PostScript, and a `pdfwrite` re-distil), and each output is rendered back and diffed against a
> direct render (`report-linux-print-A4.md`, `report-linux-print-Letter.md` in the `reports-linux` artifact). That
> proves the file survives those conversions; it does not prove what ink does on paper. An outside tester with a
> printer runs the list below.

## Get the file

`node packages/pdf/tools/print-test.mjs <outDir>` writes `print-test.pdf` (or download the `print-test` artifact of
the workflow). Page 1 is A4, page 2 is US Letter, page 3 says what to check.

## Printer settings

| Setting | Use | Why |
|---|---|---|
| Scale | **Actual size / 100%** — never "Fit", "Shrink oversized pages" or "Fit to printable area" | the scale bar and mark positions only mean something at 100% |
| Paper | A4 for page 1, US Letter for page 2 (print each on its own paper, or "Choose paper source by PDF page size") | the page is the paper; on the other size it is shifted or clipped |
| Orientation | Auto / portrait | |
| Colour | Colour, not "grayscale" or "black ink only" | the bars test the colour path |
| Quality | Normal or best; turn off "toner save" / "draft" | draft hides hairlines and small text |
| Driver | note PostScript, PCL or the vendor driver | different paths, different results |
| Viewer | note it (Acrobat, Preview, Chrome, Edge…) and its version | the viewer rasterises or converts before the driver |

## What to check

| # | Item | Expected | What to look for |
|---|---|---|---|
| 1 | Scale bar | measures 100 mm ±1 mm; ticks every 10 mm | a 97 mm bar means "Fit" was on |
| 2 | Crop marks | thin lines in each corner, 12.7 mm (½ in) in from the paper edges, ending a little before the trim | marks missing on one side = the printer's unprintable margin clipped them (acceptable) — the content area must never be clipped |
| 3 | Bleed marks | short dashed marks 3 mm outside the trim corners; a pale cyan band runs from the bleed edge into the trim | the band should run past the crop marks (that is the bleed) |
| 4 | Registration targets | four circle-and-cross targets in the margins, black (all four inks) | coloured fringes around them = colour plates misaligned (a printer issue, not the file) |
| 5 | CMYK solids | C, M, Y, K, C+M (blue), M+Y (red), C+Y (green), rich black: eight distinct flat patches | a missing or muddy patch; the rich black darker than the plain K |
| 6 | CMYK 50% / 25% | each tint visibly lighter than its solid, flat, no banding | banding or dot patterns that are coarse |
| 7 | RGB bars | red, green, blue, cyan, magenta, yellow, black, mid grey | RGB green and blue are out of the printer's gamut: duller than on screen is normal |
| 8 | Grey ramp | two rows of 10 steps (K only, DeviceGray); every step distinguishable; 0% paper white, 100% solid | two neighbouring steps that print the same; a colour cast in the gray row (it may be printed with CMY) |
| 9 | Spot colour | PANTONE 185 C prints as a red (its CMYK alternate), the 75/50/25% tints lighter in order | on a press with a 185 C plate it is the real ink; on an office printer it is the alternate |
| 10 | Hairlines | 0.25, 0.5 and 1 pt lines, horizontal and vertical, all visible and unbroken | 0.25 pt vanishing = the driver drops hairlines (try "Fine lines" / thin-line setting) |
| 11 | Small text | Helvetica (standard) and Inter (embedded) from 4 to 12 pt; 6 pt and up readable; 4–5 pt clean letters | blobs or substituted fonts (Inter looks like Helvetica = font not used) |
| 12 | Times line | "The quick brown fox…" in Times at 8 pt | |
| 13 | Image | a smooth gradient square (red to blue to green), no white box | blockiness = downsampling; a box = a transparency/mask problem |
| 14 | Gradient | smooth cyan to white | visible steps (banding) |
| 15 | Transparency | the cyan disc at 50% shows the yellow square through it (green where they overlap); the magenta disc multiplies (darker where it overlaps) | a hard-edged white box around a disc = the driver flattened transparency badly |
| 16 | Page 3 | the checklist text, single A4 page | |

Write the printer model, driver, connection (PostScript/PCL/vendor), viewer and settings on page 3 and keep the
printout with this list. Report any row that fails with a photo or scan of that area.
