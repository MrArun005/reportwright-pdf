// @ts-check
/**
 * PDF/A-2b: the sRGB output intent (DestOutputProfile) in the catalog. The XMP identification is in xmp.js; fonts
 * must be embedded (standardFont throws), annotations print (/F 4), and no .notdef is drawn (embed.js).
 * The profile: sRGB-v2-magic.icc from Compact-ICC-Profiles by Clinton Ingram, CC0 (see THIRD-PARTY-NOTICES.md).
 */
const SRGB = 'AAAC4GxjbXMCEAAAbW50clJHQiBYWVogB+IAAwAUAAkADgAdYWNzcE1TRlQAAAAAc2F3c2N0cmwAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1oYW5kk7I0qQ6wIoqY/Zqvo2eJmwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJZGVzYwAAAPAAAABfY3BydAAAAQwAAAAMd3RwdAAAARgAAAAUclhZWgAAASwAAAAUZ1hZWgAAAUAAAAAUYlhZWgAAAVQAAAAUclRSQwAAAWgAAAF4Z1RSQwAAAWgAAAF4YlRSQwAAAWgAAAF4ZGVzYwAAAAAAAAAFc1JHQgAAAAAAAAAAAAAAAHRleHQAAAAAQ0MwAFhZWiAAAAAAAADzVAABAAAAARbJWFlaIAAAAAAAAG+gAAA48gAAA49YWVogAAAAAAAAYpYAALeJAAAY2lhZWiAAAAAAAAAkoAAAD4UAALbEY3VydgAAAAAAAAC2AAAAHAA4AFQAcACMAKgAxADhAQABIgFGAW0BlQHBAfACIAJVAosCxAMBAz8DggPGBA4EWQSnBPkFTAWkBf4GXAa+ByEHigf0CGMI1QlJCcMKPwq/C0ILyQxUDOENdA4JDqIPQA/gEIURLRHaEooTPhP2FLIVcRY2Fv0XyhiZGW4aRhsiHAMc5x3QHr0friCkIZ4inCOfJKUlsSbAJ9Uo7SoKKyssUS18Lqov3jEWMlIzlDTZNiQ3czjGOiA7fDzfPkU/sEEhQpZEEEWPRxJIm0ooS7tNUU7uUI9SNVPgVZBXRVkAWr5chF5MYBth72PHZaZniWlxa19tUW9KcUZzSnVRd155cXuIfaZ/yIHwhB6GUIiJisWNCY9RkZ+T85ZLmKubDp14n+eiW6TWp1ap26xnrvexj7Qqtsy5dLwhvtXBjcRMxxDJ2syrz3/SXNU92CTbEt4E4P7j/OcB6gztHPA081D2c/mb/Mr//w==';

/** @param {string} b64 */
const unbase64 = (b64) => { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };

/** @param {import('../document.js').Doc} doc */
export function addOutputIntent(doc) {
  doc.onFinish(async () => {
    const icc = doc.reserve(), intent = doc.reserve();
    await doc.writeStream(icc, '<< /N 3 >>', unbase64(SRGB));
    await doc.write(intent, '<< /Type /OutputIntent /S /GTS_PDFA1 /OutputConditionIdentifier <73524742> /Info <735247422049454336313936362d322e31> /DestOutputProfile ' + icc + ' 0 R >>');
    doc.catalog('OutputIntents', `[${intent} 0 R]`);
  });
}
