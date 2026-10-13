# Security model

In short:

- **No active content can be written.** There is no API for JavaScript, Launch, SubmitForm, ImportData, GoToR or any
  other action, no `/AA`, no form scripts; URLs are limited to http, https and mailto (widen per link with
  `allowSchemes`, never to `javascript:`, `data:`, `file:` or `vbscript:`). Every caller string is written escaped.
- **Active content is stripped on read.** `save()` and `mergePdfs()` drop JavaScript, launch and submit actions, `/AA`,
  XFA, RichMedia and every annotation or action outside an allowlist, and report it in `stripped`
  (`keepActiveContent: true` opts out). `saveIncremental()` cannot strip (the old bytes stay), so it scans the whole
  file and refuses (`E_ACTIVE`) instead.
- **Every input is budgeted.** Decoded bytes, parse steps, objects, nesting, reference chains, text items and time
  have caps (`budget`, `timeoutMs`, `signal`); exceeding one is a `PdfReadError` (`E_BUDGET`, `E_TIMEOUT`…), never
  a hang or an out-of-memory crash. Images, attachments and Factur-X XML have their own size caps.
- **Platform crypto only**, no RC4 written, signed documents' DocMDP/FieldMDP permissions enforced on update.

The details, and what the library refuses and why:

| Refused | Why |
|---|---|
| RC4 encryption (40- and 128-bit, V1–V3 / R2–R3) | broken: a biased key stream and brute-forceable 40-bit keys; it only looks like protection |
| Encryption in PDF/A | ISO 19005 forbids it: an archive must open anywhere, forever |
| Turning off the accessibility permission in PDF/UA | ISO 14289 needs assistive technology to read the content (forced on, with a warning) |
| An empty owner password | it would give everyone full access; leave it out for a random one |
| Passwords over 1024 characters; control, bidi, private-use or unassigned characters (AES-256); non-Latin-1 (AES-128) | bounded input, and SASLprep, so every reader derives the same key |
| A signer's CMS that is not one DER SignedData, is larger than `reserve`, or (with `timestamp`) carries no token | garbage must not land in `/Contents`; a dropped timestamp would downgrade B-T to B-B silently |
| A second signature in one document as it is created | it needs an incremental update: `saveIncremental({ sign })` |
| A Factur-X XML with a DOCTYPE, ENTITY or other markup declaration, over 10 MB, or not UTF-8 | the XML is data: nothing may expand (billion laughs, external entities); it is never given to an XML parser |
| Caller text inserted into XMP unescaped | title, author, subject and keywords are escaped (`& < > " '`; characters XML cannot carry dropped); schema prefixes and names are checked as XML names |
| An attachment over `maxBytes`, or with a spoofed name | the size is checked before any copy; names go through the same checker as `page.attachFile` |

Crypto comes from the platform only (WebCrypto, node:crypto in Node); no AES or SHA is hand-written. The key
derivations of the standard security handler (ISO 32000-2 Algorithm 2.B; ISO 32000-1 Algorithms 2, 3, 5) are written
here, as the spec composes them, and checked against vectors from qpdf. Passwords and keys never appear in an error.
JavaScript, launch and submit actions cannot be written at all (see Forms and Links).

**Reading files from strangers.** The reader treats every byte as hostile:

| Bound | Default (`budget` option) |
|---|---|
| Decoded stream bytes, the whole document / one stream (every filter and predictor counts as it produces, so a zip bomb stops at the cap: a 302-byte stream that inflates to 10 GB stops at 128 MB) | `maxDecoded` 512 MB / `maxStream` 128 MB |
| Parsing steps (tokens, xref rows, tree nodes, operators); time | `maxSteps` 200 M; `timeoutMs`, `signal` |
| Cross-reference entries and scanned objects held; one page's text pieces | `maxObjects` 5 M; `maxTextItems` 1 M (and 16 M characters a page, ActualText included) |
| Nesting of arrays and dictionaries (an explicit stack, never recursion) | 256 |
| A chain of indirect references | 32 |

Every count and length is bounded by the bytes actually there (xref rows, `/N`, `/Length`, strings, `/Count` is never
trusted); loops are cut where they can occur (`/Prev`, page tree `/Kids`, outline `/Next`, AcroForm `/Kids`, an object
stream inside an object stream, form XObjects drawing themselves); recovery is one bounded pass.

**Active content is never carried over** unless `keepActiveContent: true`. One registry (`src/reader/policy.js`) says
what is allowed, and both save paths use it:

| Kept | Dropped (and reported in `stripped`) |
|---|---|
| Actions: GoTo, URI (plain-ASCII bytes accepted by the writer's URL check — http, https, mailto, ftp — and written as normalised), Named page moves, ResetForm | every other action (JavaScript, Launch, SubmitForm, ImportData, GoToR, GoToE, Hide, Movie, Sound, Rendition, RichMediaExecute, SetOCGState, Trans, GoTo3DView, Thread, unknown), wherever it is: `/A`, `/OpenAction`, `/Next` arrays, `/PA`, through references, or any dictionary whose `/S` is an action type |
| Annotations: Link, Text, FreeText, Line, Square, Circle, Polygon, PolyLine, Highlight, Underline, Squiggly, StrikeOut, Stamp, Caret, Ink, Popup, FileAttachment, Widget | RichMedia, Screen, Movie, Sound, 3D and anything else; every `/Annots` element and form widget is checked by position |
| File specifications whose every name key passes the writer's file-name check and agrees in extension (written back as the checked `/UF` and `/F`, with one embedded stream) | any other (`/F` "evil.exe" behind a clean `/UF`, `/DOS`, a spoofed double extension) |
| — | `/AA`, `/JS`, `/Names /JavaScript`, the AcroForm's `/XFA` |

An attachment that is itself a PDF is copied as data: its own content is not sanitised (opening it is a separate act).

**An incremental update cannot strip anything**: the original bytes stay, and a reader that rebuilds the
cross-reference, shows an earlier revision or follows `/Prev` finds them again. So `saveIncremental` checks the WHOLE
file first — every object in the bytes (the parser's own lexer plus a byte scan, every duplicate, every object stream,
every cross-reference entry) against the same registry — and refuses (`E_ACTIVE`, naming what it found) if there is
any active content, or if anything cannot be read (fail closed), unless `keepActiveContent: true`. **For files from
strangers, `save()` is the safe path** (it rewrites the file without the active content; this invalidates existing
signatures).

**This is why `saveIncremental` is slower by design.** Appending a few objects could be done without reading the
original, but then active content hidden in it (a shadow attack: an earlier revision, an unreferenced object, a
duplicate, an object stream the latest cross-reference does not point at) would ride along under your new signature.
So it reads and scans the whole file first, every time: a large file costs a full parse before a byte is appended.
Safer, slower, on purpose.

**Signed documents (signature policy).** `saveIncremental` reads every signature's permissions and takes the
strictest: DocMDP from the catalog `/Perms` and from each signature's `/Reference` in every revision (no `/P` means
P=2), FieldMDP from each `/Reference` and each signed field's `/Lock`, and ReadOnly from any ancestor field. Anything it
cannot read or does not know refuses the update (`E_SIGNED`, fail closed).

| The document | Allowed | Refused |
|---|---|---|
| certified P=1 | nothing | every update, including a new signature |
| certified P=2 or P=3 | fills (opt-in, below) and new signatures | rotation, Info/XMP changes |
| signed, no DocMDP | fills (opt-in) and new signatures | rotation, Info/XMP changes unless `allowChangesAfterSigning: true` |
| a locked (FieldMDP) or ReadOnly field | — | filling it |

Filling a form **after it was signed** needs `allowFillAfterSigning: true`. Viewers show such a document as "changed
after signing", and refilling widgets that existed before signing is how "shadow attacks" (Mainka et al., USENIX
Security 2021) make a signed document look different while its signature still verifies. As a second guard the filled
widgets may cover at most 40% of a page in all, and a widget with an opaque background may not lie over the page's text.
