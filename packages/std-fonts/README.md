# @reportwright/pdf-std-fonts

Optional outlines for the 14 standard PDF fonts, so `@reportwright/pdf`'s experimental renderer draws text in
Helvetica, Times, Courier, Symbol and ZapfDingbats (the PDF names them but holds no outlines for them).

```js
import { loadPdf, renderPage } from '@reportwright/pdf';
import { stdFonts } from '@reportwright/pdf-std-fonts';
const page = renderPage(await loadPdf(bytes), 0, { scale: 2, fonts: stdFonts });
```

| standard font | drawn with | licence |
|---|---|---|
| Helvetica (4 styles) | Liberation Sans 2.1.5 (metric-compatible) | SIL OFL 1.1, `fonts/OFL-Liberation.txt` |
| Times (4 styles) | Liberation Serif 2.1.5 (metric-compatible) | SIL OFL 1.1 |
| Courier (4 styles) | Liberation Mono 2.1.5 (metric-compatible) | SIL OFL 1.1 |
| Symbol | Liberation Serif (its Greek and common maths; not every Symbol glyph) | SIL OFL 1.1 |
| ZapfDingbats | Noto Sans Symbols 2 (the Dingbats block) | SIL OFL 1.1, `fonts/OFL-NotoSansSymbols2.txt` |

The fonts are unmodified (Liberation from Debian's fonts-liberation 2.1.5-3, Noto Sans Symbols 2 from google/fonts)
and remain under the SIL Open Font License 1.1; this package's code is MIT. Without this package the renderer
still works: pass any TrueType/OpenType font as `fonts: { default: bytes }`, or standard-font text is not drawn.
