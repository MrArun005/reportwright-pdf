// @ts-check
/**
 * PDF/A-2b: the sRGB output intent (DestOutputProfile) in the catalog. The XMP identification is in xmp.js; fonts
 * must be embedded (standardFont throws), annotations print (/F 4), and no .notdef is drawn (embed.js).
 * The profile: sRGB-v2-magic.icc from Compact-ICC-Profiles by Clinton Ingram, CC0 (see THIRD-PARTY-NOTICES.md).
 */
import { parseIcc } from './icc.js';
import { ascii } from '../core/serialize.js';

const SRGB = 'AAAC4GxjbXMCEAAAbW50clJHQiBYWVogB+IAAwAUAAkADgAdYWNzcE1TRlQAAAAAc2F3c2N0cmwAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1oYW5kk7I0qQ6wIoqY/Zqvo2eJmwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJZGVzYwAAAPAAAABfY3BydAAAAQwAAAAMd3RwdAAAARgAAAAUclhZWgAAASwAAAAUZ1hZWgAAAUAAAAAUYlhZWgAAAVQAAAAUclRSQwAAAWgAAAF4Z1RSQwAAAWgAAAF4YlRSQwAAAWgAAAF4ZGVzYwAAAAAAAAAFc1JHQgAAAAAAAAAAAAAAAHRleHQAAAAAQ0MwAFhZWiAAAAAAAADzVAABAAAAARbJWFlaIAAAAAAAAG+gAAA48gAAA49YWVogAAAAAAAAYpYAALeJAAAY2lhZWiAAAAAAAAAkoAAAD4UAALbEY3VydgAAAAAAAAC2AAAAHAA4AFQAcACMAKgAxADhAQABIgFGAW0BlQHBAfACIAJVAosCxAMBAz8DggPGBA4EWQSnBPkFTAWkBf4GXAa+ByEHigf0CGMI1QlJCcMKPwq/C0ILyQxUDOENdA4JDqIPQA/gEIURLRHaEooTPhP2FLIVcRY2Fv0XyhiZGW4aRhsiHAMc5x3QHr0friCkIZ4inCOfJKUlsSbAJ9Uo7SoKKyssUS18Lqov3jEWMlIzlDTZNiQ3czjGOiA7fDzfPkU/sEEhQpZEEEWPRxJIm0ooS7tNUU7uUI9SNVPgVZBXRVkAWr5chF5MYBth72PHZaZniWlxa19tUW9KcUZzSnVRd155cXuIfaZ/yIHwhB6GUIiJisWNCY9RkZ+T85ZLmKubDp14n+eiW6TWp1ap26xnrvexj7Qqtsy5dLwhvtXBjcRMxxDJ2syrz3/SXNU92CTbEt4E4P7j/OcB6gztHPA081D2c/mb/Mr//w==';

/** @param {string} b64 */
const unbase64 = (b64) => { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };

/**
 * The output intent: the bundled sRGB profile, or the caller's (pdfa: { outputIntent: bytes }): an RGB or CMYK
 * profile of class Output (prtr) or Monitor (mntr), as ISO 19005-2 6.2.3 asks. doc.outputIntent ('RGB' | 'CMYK')
 * tells the colour and image modules which device colours PDF/A allows (graphics/color.js checkDevice).
 * @param {import('../document.js').Doc} doc @param {any} [opt] the pdfa option
 */
export function addOutputIntent(doc, opt) {
  const custom = opt && typeof opt === 'object' && opt.outputIntent != null ? parseIcc(opt.outputIntent, 'pdfa.outputIntent') : null;
  if (custom && custom.n === 1) throw new TypeError('pdfa.outputIntent: an RGB or CMYK profile (not gray)');
  if (custom && custom.cls !== 'prtr' && custom.cls !== 'mntr') throw new TypeError(`pdfa.outputIntent: an output (prtr) or monitor (mntr) profile, not ${JSON.stringify(custom.cls)}`);
  /** @type {any} */ (doc).outputIntent = custom?.n === 4 ? 'CMYK' : 'RGB';
  doc.onFinish(async () => {
    const icc = doc.reserve(), intent = doc.reserve();
    await doc.writeStream(icc, `<< /N ${custom ? custom.n : 3} >>`, custom ? custom.bytes : unbase64(SRGB));
    const id = custom ? `${ascii('Custom')} /Info ${ascii(`Custom ${custom.space} profile`)}` : '<73524742> /Info <735247422049454336313936362d322e31>';
    await doc.write(intent, `<< /Type /OutputIntent /S /GTS_PDFA1 /OutputConditionIdentifier ${id} /DestOutputProfile ${icc} 0 R >>`);
    doc.catalog('OutputIntents', `[${intent} 0 R]`);
  });
}
