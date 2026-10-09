# Third-party notices

@reportwright/pdf is MIT licensed (see LICENSE). It bundles or derives from the following work.

| Component | Version | License | Used for |
|---|---|---|---|
| [fflate](https://github.com/101arrowz/fflate) by Arjun Barrett | 0.8.3 | MIT | Flate (zlib) compression and decompression, bundled into `dist/fflate.js` |
| Adobe Font Metrics (AFM) for the 14 standard PDF fonts, via [@pdf-lib/standard-fonts](https://github.com/Hopding/standard-fonts) | 1.0.0 | MIT (the package); the AFM files are © Adobe, distributed with permission to use, copy and distribute | widths and metrics of Helvetica, Times, Courier, Symbol and ZapfDingbats (`src/fonts/standard-metrics.js`, generated) |
| `sRGB-v2-magic.icc` from [Compact-ICC-Profiles](https://github.com/saucecontrol/Compact-ICC-Profiles) by Clinton Ingram | — | CC0 1.0 (public domain) | the sRGB output intent of PDF/A files |

## fflate (MIT)

> MIT License
>
> Copyright (c) 2026 Arjun Barrett
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
> documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
> rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
> persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
> Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
> WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
> COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
> OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Adobe Font Metrics

The AFM files carry this notice: "Copyright (c) 1985, 1987, 1989, 1990, 1997 Adobe Systems Incorporated. All Rights
Reserved. This file and the 14 PostScript(R) AFM files it accompanies may be used, copied, and distributed for any
purpose and without charge, with or without modification, provided that all copyright notices are retained; that the
AFM files are not distributed without this file; that all modifications to this file or any of the AFM files are
prominently noted in the modified file(s); and that this paragraph is not modified. Adobe Systems has no
responsibility or obligation to support the use of the AFM files." Only the widths and font-wide metrics are used, in
a generated JavaScript form.
